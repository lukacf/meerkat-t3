import {
  ChatImageAttachment,
  ChatFileAttachment,
  type EnvironmentId,
  type ThreadPreparedTurn,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import type {
  ComposerFileAttachment,
  ComposerImageAttachment,
  PersistedComposerImageAttachment,
} from "../../composerDraftStore";
import {
  asKnownContextRecord,
  previewAnnotationFromRecord,
  resolveUserMessageContext,
  reviewCommentFromRecord,
  terminalContextDraftFromRecord,
} from "../../lib/composerContextRecords";
import {
  formatInlineContextReference,
  producerIdFromComposerContextId,
  toKindScopedComposerContextId,
} from "../../lib/composerContextReferences";
import { elementContextToPreviewAnnotation } from "../../lib/elementContext";
const isImage = Schema.is(ChatImageAttachment);
const isFile = Schema.is(ChatFileAttachment);

/** Rebuild only into an empty composer. The released server record remains the recovery source. */
export function preparedTurnDraft(input: {
  prepared: ThreadPreparedTurn;
  environmentId: EnvironmentId;
  files: ReadonlyArray<File>;
  imageDataUrls: ReadonlyMap<number, string>;
}) {
  const { prepared, files, environmentId, imageDataUrls } = input;
  const message = prepared.command.message;
  if (files.length !== message.attachments.length)
    throw new Error("The saved attachments are incomplete. Nothing was released.");
  const context = resolveUserMessageContext(message);
  const records = context.records.map((record) => {
    const known = asKnownContextRecord(record);
    if (!known || known.kind === "mention" || known.kind === "skill")
      throw new Error(
        "This saved message contains context that cannot yet be edited. Retry the original message to preserve it.",
      );
    return known;
  });
  const rewritten = new Map<string, string>();
  const terminalContexts = records.flatMap((record) => {
    if (record.kind !== "terminal") return [];
    const draft = terminalContextDraftFromRecord(record, prepared.command.threadId);
    rewritten.set(record.contextId, toKindScopedComposerContextId("terminal", draft.id));
    return [draft];
  });
  const reviewComments = records.flatMap((record) => {
    if (record.kind !== "review-comment") return [];
    const draft = reviewCommentFromRecord(record);
    rewritten.set(record.contextId, toKindScopedComposerContextId("review-comment", draft.id));
    return [draft];
  });
  const screenshotIds = new Map<string, string>();
  const previewAnnotations = records.flatMap((record) => {
    if (record.kind !== "preview-annotation" && record.kind !== "element") return [];
    const draft =
      record.kind === "element"
        ? elementContextToPreviewAnnotation(
            record,
            producerIdFromComposerContextId("element", record.contextId),
            prepared.createdAt,
          )
        : previewAnnotationFromRecord(record);
    rewritten.set(record.contextId, toKindScopedComposerContextId("preview-annotation", draft.id));
    if (record.kind === "preview-annotation" && record.screenshotContextId)
      screenshotIds.set(record.screenshotContextId, draft.id);
    return [draft];
  });
  const images: ComposerImageAttachment[] = [];
  const restoredFiles: ComposerFileAttachment[] = [];
  const persistedImages: PersistedComposerImageAttachment[] = [];
  message.attachments.forEach((attachment, index) => {
    if (!isImage(attachment) && !isFile(attachment))
      throw new Error(
        "This saved attachment cannot yet be edited. Retry the original message to preserve it.",
      );
    const kind = attachment.type === "image" ? "image" : "file";
    const record = records.find(
      (candidate) =>
        (candidate.kind === "image" || candidate.kind === "file") &&
        candidate.attachmentId === attachment.id,
    );
    const id = record
      ? (screenshotIds.get(record.contextId) ??
        producerIdFromComposerContextId(kind, record.contextId))
      : `prepared-${attachment.id}`;
    if (record) rewritten.set(record.contextId, toKindScopedComposerContextId(kind, id));
    const base = {
      id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    };
    const file = files[index]!;
    if (attachment.type === "image") {
      const dataUrl = imageDataUrls.get(index);
      if (!dataUrl) throw new Error("A saved image could not be loaded. Nothing was released.");
      images.push({
        ...base,
        type: "image",
        file,
        previewUrl: dataUrl,
        ...(attachment.source ? { source: attachment.source } : {}),
      });
      persistedImages.push({
        ...base,
        dataUrl,
        ...(attachment.source ? { source: attachment.source } : {}),
      });
    } else {
      restoredFiles.push({
        ...base,
        type: "file",
        file,
        uploadedAttachmentId: attachment.id,
        uploadEnvironmentId: environmentId,
        ...(attachment.source ? { source: attachment.source } : {}),
      });
    }
  });
  const prompt = replaceComposerContextReferences(context.text, (reference) => {
    const contextId = rewritten.get(reference.contextId);
    return contextId
      ? formatInlineContextReference({
          ...reference,
          contextId,
          kind: reference.kind === "element" ? "preview-annotation" : reference.kind,
        })
      : reference.source;
  });
  return {
    prompt,
    images,
    files: restoredFiles,
    persistedImages,
    terminalContexts,
    reviewComments,
    previewAnnotations,
  };
}

export function preparedTurnImagesPersisted(
  expected: ReadonlyArray<PersistedComposerImageAttachment>,
  actual: ReadonlyArray<PersistedComposerImageAttachment>,
): boolean {
  return expected.every((image) =>
    actual.some((saved) => saved.id === image.id && saved.dataUrl === image.dataUrl),
  );
}

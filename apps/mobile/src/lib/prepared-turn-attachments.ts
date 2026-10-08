import {
  ChatFileAttachment,
  ChatImageAttachment,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type EnvironmentId,
  type ThreadPreparedTurn,
} from "@t3tools/contracts";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { appAtomRegistry } from "../state/atom-registry";
import { assetEnvironment } from "../state/assets";
import { environmentSession } from "../state/session";
import { downloadAttachmentForPreview } from "./attachmentDownload";
import {
  persistComposerAttachmentFile,
  removePersistedComposerAttachmentFile,
  type DraftComposerAttachment,
} from "./composerImages";

const isChatImageAttachment = Schema.is(ChatImageAttachment);
const isChatFileAttachment = Schema.is(ChatFileAttachment);

/** Recover original bytes into owned files; signed URLs and preview cache paths never persist. */
export async function loadPreparedTurnAttachments(
  environmentId: EnvironmentId,
  prepared: ThreadPreparedTurn,
  signal: AbortSignal,
): Promise<ReadonlyArray<DraftComposerAttachment>> {
  const attachments: DraftComposerAttachment[] = [];
  const checkAborted = () => {
    if (signal.aborted) throw new Error("Message recovery cancelled.");
  };
  try {
    for (const saved of prepared.command.message.attachments) {
      checkAborted();
      if (!isChatImageAttachment(saved) && !isChatFileAttachment(saved))
        throw new Error("This attachment cannot be edited here. Retry the original message.");
      const connection = appAtomRegistry.get(
        environmentSession.preparedConnectionValueAtom(environmentId),
      );
      if (Option.isNone(connection)) throw new Error("Reconnect to recover the saved attachments.");
      const result = await executeAtomQuery(
        appAtomRegistry,
        assetEnvironment.createUrl({
          environmentId,
          input: { resource: { _tag: "attachment", attachmentId: saved.id, fileName: saved.name } },
        }),
        { refresh: true, reportFailure: false },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      checkAborted();
      const url = resolveAssetUrl(connection.value.httpBaseUrl, result.value.relativeUrl);
      if (!url) throw new Error("The saved attachment is unavailable.");
      const temporary = await downloadAttachmentForPreview({ url, attachment: saved, signal });
      if (!temporary) throw new Error("Message recovery cancelled.");
      let fileUri: string | null = null;
      try {
        fileUri = await persistComposerAttachmentFile(
          temporary.uri,
          saved.name,
          saved.type === "image"
            ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
            : PROVIDER_SEND_TURN_MAX_FILE_BYTES,
        );
        checkAborted();
        const { File } = await import("expo-file-system");
        if (new File(fileUri).size !== saved.sizeBytes)
          throw new Error(`The saved attachment ${saved.name} is incomplete. Retry recovery.`);
        const common = {
          id: saved.id,
          name: saved.name,
          mimeType: saved.mimeType,
          sizeBytes: saved.sizeBytes,
          fileUri,
        };
        attachments.push(
          saved.type === "image"
            ? { ...common, type: "image", previewUri: fileUri, mimeType: saved.mimeType }
            : { ...common, type: "file", ...(saved.source ? { source: saved.source } : {}) },
        );
        fileUri = null;
      } finally {
        temporary.dispose();
        if (fileUri) await removePersistedComposerAttachmentFile(fileUri);
      }
    }
    checkAborted();
    return attachments;
  } catch (error) {
    await Promise.all(
      attachments.map((attachment) =>
        attachment.fileUri
          ? removePersistedComposerAttachmentFile(attachment.fileUri)
          : Promise.resolve(),
      ),
    );
    throw error;
  }
}

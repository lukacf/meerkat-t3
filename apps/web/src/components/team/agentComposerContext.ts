import type { OrchestrationMessageContext, PreviewAnnotationPayload } from "@t3tools/contracts";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import {
  useComposerDraftStore,
  flushComposerDraftPersistence,
  type ComposerThreadDraftState,
  type DraftId,
} from "../../composerDraftStore";
import {
  buildMessageContext,
  terminalContextReference,
  reviewCommentContextId,
  previewAnnotationContextId,
} from "../../lib/composerContextRecords";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import { useAgentConversationDraftStore } from "./agentConversationDraftStore";

export type AgentComposerSnapshot = {
  text: string;
  context?: OrchestrationMessageContext;
};

/** One immutable send snapshot; removing a chip removes its payload from the message. */
export function snapshotAgentComposer(
  draft: Pick<
    ComposerThreadDraftState,
    "prompt" | "terminalContexts" | "reviewComments" | "previewAnnotations"
  > | null,
): AgentComposerSnapshot {
  const text = draft?.prompt.trim() ?? "";
  if (!draft) return { text };
  const referenced = new Set<string>(
    collectComposerContextReferences(text).map((entry) => entry.contextId),
  );
  const context = buildMessageContext(draft);
  const records = context?.records.filter((record) => referenced.has(record.contextId)) ?? [];
  return {
    text,
    ...(records.length ? { context: structuredClone({ version: 1 as const, records }) } : {}),
  };
}

/** Move old plain text once, preserving context already inserted by a workspace panel. */
export function migrateAgentComposerDraft(draftKey: string, draftId: DraftId): void {
  const legacyStore = useAgentConversationDraftStore.getState();
  const legacy = legacyStore.byTarget[draftKey]?.text;
  if (!legacy) return;
  const store = useComposerDraftStore.getState();
  const current = store.getComposerDraft(draftId)?.prompt ?? "";
  if (current !== legacy && !current.startsWith(`${legacy}\n\n`))
    store.setPrompt(draftId, current ? `${legacy}\n\n${current}` : legacy);
  if (flushComposerDraftPersistence()) legacyStore.setText(draftKey, "");
}

/** An acknowledgement cannot erase edits or workspace selections added while it was pending. */
export function clearAcknowledgedAgentComposer(
  draftId: DraftId,
  sent: AgentComposerSnapshot,
): boolean {
  const store = useComposerDraftStore.getState();
  const current = snapshotAgentComposer(store.getComposerDraft(draftId));
  if (
    JSON.stringify(current) !==
    JSON.stringify({ text: sent.text.trim(), ...(sent.context ? { context: sent.context } : {}) })
  )
    return false;
  store.clearComposerContent(draftId);
  return true;
}

/** Keep the delivery intent until matching clears or newer edits have reached durable storage. */
export function clearAcknowledgedAgentComposerDurably(
  draftId: DraftId,
  sent: AgentComposerSnapshot,
): boolean {
  clearAcknowledgedAgentComposer(draftId, sent);
  return flushComposerDraftPersistence();
}

export function createRetainedAgentContext() {
  return {
    terminal: new Map<string, TerminalContextDraft>(),
    review: new Map<string, ReviewCommentContext>(),
    preview: new Map<string, PreviewAnnotationPayload>(),
  };
}

/** Keep payloads out of persisted drafts after chip deletion, while preserving editor undo. */
export function updateAgentComposerPrompt(
  draftId: DraftId,
  text: string,
  retained: ReturnType<typeof createRetainedAgentContext>,
): void {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(draftId);
  const referenced = new Set<string>(
    collectComposerContextReferences(text).map((entry) => entry.contextId),
  );
  for (const context of draft?.terminalContexts ?? []) {
    const id = terminalContextReference(context).contextId;
    if (!referenced.has(id)) {
      retained.terminal.set(id, context);
      store.removeTerminalContext(draftId, context.id);
    }
  }
  for (const comment of draft?.reviewComments ?? []) {
    const id = reviewCommentContextId(comment.id);
    if (!referenced.has(id)) {
      retained.review.set(id, comment);
      store.removeReviewComment(draftId, comment.id);
    }
  }
  for (const annotation of draft?.previewAnnotations ?? []) {
    const id = previewAnnotationContextId(annotation.id);
    if (!referenced.has(id)) {
      retained.preview.set(id, annotation);
      store.removePreviewAnnotation(draftId, annotation.id);
    }
  }
  const options = { appendReference: false };
  for (const id of referenced) {
    const terminal = retained.terminal.get(id);
    if (terminal) {
      store.addTerminalContexts(draftId, [terminal], options);
      retained.terminal.delete(id);
    }
    const review = retained.review.get(id);
    if (review) {
      store.addReviewComment(draftId, review, options);
      retained.review.delete(id);
    }
    const preview = retained.preview.get(id);
    if (preview) {
      store.addPreviewAnnotation(draftId, preview, options);
      retained.preview.delete(id);
    }
  }
  store.setPrompt(draftId, text);
}

import {
  ChatFileAttachment,
  ChatImageAttachment,
  isProviderSendTurnSupportedImageMimeType,
  type OrchestrationRetryPreparedTurnInput,
  type ThreadPreparedTurn,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";

import type { DraftComposerAttachment } from "../lib/composerImages";
import type { ComposerDraft } from "./use-composer-drafts";

const isChatImageAttachment = Schema.is(ChatImageAttachment);
const isChatFileAttachment = Schema.is(ChatFileAttachment);

export function preparedTurnBlocksSend(prepared: ThreadPreparedTurn | null | undefined): boolean {
  return prepared != null && prepared.phase !== "released";
}

export function preparedTurnNeedsSetupAcknowledgement(prepared: ThreadPreparedTurn): boolean {
  return prepared.setup === "not_started" || prepared.setup === "sync_running";
}

export function preparedTurnCanEdit(prepared: ThreadPreparedTurn): boolean {
  return (
    prepared.phase === "released" ||
    prepared.phase === "blocked" ||
    (prepared.phase === "preparing" && Boolean(prepared.reason))
  );
}

export function preparedDraftHasContent(draft: ComposerDraft): boolean {
  return (
    draft.text.length > 0 ||
    draft.attachments.length > 0 ||
    (draft.context?.records.length ?? 0) > 0
  );
}

export function preparedTurnEditBlock(prepared: ThreadPreparedTurn): string | null {
  if (prepared.command.sourceProposedPlan)
    return "This request includes a plan reference. Retry the original message to preserve it.";
  if (prepared.command.message.context?.records.some((record) => "payload" in record))
    return "This request includes context this app cannot edit yet. Retry the original message to preserve it.";
  for (const attachment of prepared.command.message.attachments) {
    if (!isChatImageAttachment(attachment) && !isChatFileAttachment(attachment))
      return "This request includes an attachment this app cannot edit yet. Retry the original message to preserve it.";
    if (attachment.type === "image" && attachment.source)
      return "This image includes capture metadata this app cannot edit yet. Retry the original message to preserve it.";
    if (
      attachment.type === "image" &&
      !isProviderSendTurnSupportedImageMimeType(attachment.mimeType)
    )
      return "This image format cannot be edited here. Retry the original message to preserve it.";
  }
  return null;
}

export function preparedTurnDraft(
  prepared: ThreadPreparedTurn,
  attachments: ReadonlyArray<DraftComposerAttachment>,
): ComposerDraft {
  const block = preparedTurnEditBlock(prepared);
  if (block) throw new Error(block);
  if (
    attachments.length !== prepared.command.message.attachments.length ||
    attachments.some(
      (attachment, index) => attachment.id !== prepared.command.message.attachments[index]?.id,
    )
  )
    throw new Error("The saved attachments are incomplete. Nothing was released.");
  const { command } = prepared;
  const message = command.message;
  const legacy = message.context ? null : upgradeLegacyContextMessage(message.text);
  return {
    text: legacy?.text ?? message.text,
    context: message.context ?? (legacy ? { version: 1, records: legacy.records } : undefined),
    attachments,
    modelSelection: command.modelSelection,
    runtimeMode: command.runtimeMode,
    interactionMode: command.interactionMode,
  };
}

export interface PreparedRecoveryAccess {
  /** Re-read scope, connection, restore review, setup and the immutable recovery identity. */
  readonly current: () => { readonly prepared: ThreadPreparedTurn; readonly setupActive: boolean };
}

export async function retryPreparedMessage(
  access: PreparedRecoveryAccess,
  acknowledgeSetup: boolean,
  retry: (input: OrchestrationRetryPreparedTurnInput) => Promise<void>,
  prepareRetry?: () => Promise<void>,
): Promise<void> {
  const validate = () => {
    const { prepared, setupActive } = access.current();
    if (
      prepared.phase !== "blocked" ||
      !prepared.expectedCwd ||
      (setupActive && prepared.setup !== "async_running")
    )
      throw new Error("The saved checkout is not ready to retry.");
    if (preparedTurnNeedsSetupAcknowledgement(prepared) && !acknowledgeSetup)
      throw new Error("Confirm the interrupted setup before retrying.");
    return {
      threadId: prepared.command.threadId,
      recoveryId: prepared.recoveryId,
      expectedCwd: prepared.expectedCwd,
      ...(acknowledgeSetup ? { continueAfterInterruptedSetup: true } : {}),
    };
  };
  const request = validate();
  if (prepareRetry) {
    await prepareRetry();
    await retry(validate());
  } else await retry(request);
}

/** The released server record retains the original if any local step fails. */
export async function editPreparedMessage(
  input: PreparedRecoveryAccess & {
    readonly ensureUnchangedDraft: () => void;
    readonly loadAttachments: (
      prepared: ThreadPreparedTurn,
    ) => Promise<ReadonlyArray<DraftComposerAttachment>>;
    readonly release: (prepared: ThreadPreparedTurn) => Promise<void>;
    readonly restore: (draft: ComposerDraft, validate: () => void) => Promise<void>;
    readonly cleanup: (attachments: ReadonlyArray<DraftComposerAttachment>) => void;
  },
): Promise<void> {
  const validate = () => {
    const { prepared, setupActive } = input.current();
    if (!preparedTurnCanEdit(prepared) || setupActive)
      throw new Error("Wait for checkout preparation to stop before editing.");
    input.ensureUnchangedDraft();
    return prepared;
  };
  const prepared = validate();
  const block = preparedTurnEditBlock(prepared);
  if (block) throw new Error(block);
  const attachments = await input.loadAttachments(prepared);
  try {
    const draft = preparedTurnDraft(prepared, attachments);
    const latest = validate();
    if (latest.phase !== "released") await input.release(latest);
    validate();
    // restore validates once more after its storage hydration await and immediately
    // before publishing. No async gap may overwrite typing or a different thread.
    await input.restore(draft, () => {
      validate();
    });
  } finally {
    // The store's cleanup retains files referenced by a published draft, including
    // a draft whose disk write failed. Unadopted downloads can be removed.
    input.cleanup(attachments);
  }
}

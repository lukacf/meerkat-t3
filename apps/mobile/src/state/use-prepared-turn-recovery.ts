import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId, ThreadPreparedTurn } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { scopedThreadKey } from "../lib/scopedEntities";
import { loadPreparedTurnAttachments } from "../lib/prepared-turn-attachments";
import { appAtomRegistry } from "./atom-registry";
import { environmentThreadDetails, threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";
import { serverEnvironment } from "./server";
import { threadOutboxManager } from "./thread-outbox";
import { restoreRejectedQueuedMessage } from "./use-thread-outbox-drain";
import {
  recordPendingThreadCreationOutcome,
  pendingThreadCreationOutcomesAtom,
  retireReleasedPreparedCreationOutcome,
} from "./pending-thread-creation";
import {
  dispatchingQueuedMessageIdAtom,
  preparedRecoveryHoldsAtom,
  setPreparedRecoveryHold,
} from "./use-thread-outbox";
import {
  composerContextImportsAtom,
  getComposerDraftSnapshot,
  restoreComposerDraftSnapshot,
  sameComposerDraftState,
  scheduleUnusedComposerAttachmentCleanup,
  useComposerDraft,
  waitForComposerDraftsLoaded,
} from "./use-composer-drafts";
import {
  editPreparedMessage,
  preparedDraftHasContent,
  retryPreparedMessage,
} from "./prepared-turn-recovery";

export function usePreparedTurnRecovery(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly prepared: ThreadPreparedTurn | null;
  readonly connected: boolean;
  readonly setupActive: boolean;
}) {
  const key = scopedThreadKey(input.environmentId, input.threadId);
  const latest = useRef(input);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const [errorState, setError] = useState<{
    readonly key: string;
    readonly recoveryId: ThreadPreparedTurn["recoveryId"];
    readonly message: string;
  } | null>(null);
  const error =
    errorState?.key === key && errorState.recoveryId === input.prepared?.recoveryId
      ? errorState.message
      : null;
  const [action, setAction] = useState<"retry" | "edit" | null>(null);
  const holds = useAtomValue(preparedRecoveryHoldsAtom);
  const draft = useComposerDraft(key);
  const retry = useAtomCommand(threadEnvironment.retryPreparedTurn, { reportFailure: false });
  const release = useAtomCommand(threadEnvironment.releasePreparedTurn, { reportFailure: false });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  useLayoutEffect(() => {
    const previous = latest.current;
    if (
      previous.environmentId !== input.environmentId ||
      previous.threadId !== input.threadId ||
      previous.prepared?.recoveryId !== input.prepared?.recoveryId
    )
      controller.current?.abort();
    latest.current = input;
  }, [input]);
  useEffect(() => {
    retireReleasedPreparedCreationOutcome(key, input.prepared);
  }, [key, input.prepared]);

  const run = async (operation: "retry" | "edit", acknowledged = false) => {
    const captured = latest.current;
    const prepared = captured.prepared;
    if (!prepared || appAtomRegistry.get(preparedRecoveryHoldsAtom)[key]) return;
    const queued =
      appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom)[key] ?? [];
    if (
      queued.some(
        (message) => message.messageId === appAtomRegistry.get(dispatchingQueuedMessageIdAtom),
      )
    ) {
      setError({
        key,
        recoveryId: prepared.recoveryId,
        message: "Wait for the current message delivery to finish before recovering this request.",
      });
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setPreparedRecoveryHold(key, true);
    setAction(operation);
    setError(null);
    const current = () => {
      const live = latest.current;
      const ref = scopeThreadRef(captured.environmentId, captured.threadId);
      const detail = appAtomRegistry.get(environmentThreadDetails.detailAtom(ref));
      if (
        abort.signal.aborted ||
        !mounted.current ||
        live.environmentId !== captured.environmentId ||
        live.threadId !== captured.threadId ||
        !live.connected ||
        appAtomRegistry.get(environmentThreadDetails.statusAtom(ref)) !== "live" ||
        detail?.preparedTurn?.recoveryId !== prepared.recoveryId ||
        detail.preparedTurn.expectedCwd !== prepared.expectedCwd ||
        detail.preparedTurn.projectCwd !== prepared.projectCwd ||
        detail.projectId !== prepared.projectId
      )
        throw new Error(
          "The saved request or connection changed. Open this thread again to recover the original message.",
        );
      const review = appAtomRegistry.get(
        serverEnvironment.configValueAtom(captured.environmentId),
      )?.restoreReview;
      if (review && review.status !== "clear")
        throw new Error(
          "Restored work is paused. Review the restored profile on web or desktop before continuing.",
        );
      return { prepared: detail.preparedTurn, setupActive: live.setupActive };
    };
    try {
      if (operation === "retry") {
        await retryPreparedMessage(
          { current },
          acknowledged,
          async (request) => {
            const result = await retry({ environmentId: captured.environmentId, input: request });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            const outcome = appAtomRegistry.get(pendingThreadCreationOutcomesAtom)[key];
            if (outcome?.message.commandId === prepared.command.commandId)
              recordPendingThreadCreationOutcome({ kind: "delivered", message: outcome.message });
          },
          async () => {
            const queue = appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom)[
              key
            ];
            const copy = queue?.find(
              (message) =>
                message.creation !== undefined && message.commandId === prepared.command.commandId,
            );
            if (!copy) return;
            const result = await restoreRejectedQueuedMessage(
              copy,
              "The queued copy is kept separately in Drafts for review. Retry uses the original saved request.",
              { preparedRecovery: true },
            );
            if (result !== "restored")
              throw new Error(
                "The queued copy could not be saved separately yet. Finish editing it or free device storage, then retry.",
              );
          },
        );
      } else {
        await waitForComposerDraftsLoaded();
        const before = getComposerDraftSnapshot(key);
        const ensureUnchangedDraft = () => {
          const now = getComposerDraftSnapshot(key);
          if (
            preparedDraftHasContent(now) ||
            !sameComposerDraftState(before, now) ||
            appAtomRegistry.get(composerContextImportsAtom)[key]
          )
            throw new Error(
              "Keep or move the current draft before restoring the saved message. Nothing in your draft was replaced.",
            );
        };
        await editPreparedMessage({
          current,
          ensureUnchangedDraft,
          loadAttachments: (original) =>
            loadPreparedTurnAttachments(captured.environmentId, original, abort.signal),
          release: async (original) => {
            const result = await release({
              environmentId: captured.environmentId,
              input: {
                threadId: captured.threadId,
                recoveryId: original.recoveryId,
                expectedCwd: original.expectedCwd,
              },
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          },
          restore: async (restored, validate) => {
            try {
              await restoreComposerDraftSnapshot(key, restored, validate);
            } catch (cause) {
              if (getComposerDraftSnapshot(key).attachments === restored.attachments)
                throw new Error(
                  "The message is in your composer, but could not be saved on this device. The original remains available after reload.",
                  { cause },
                );
              throw cause;
            }
          },
          cleanup: scheduleUnusedComposerAttachmentCleanup,
        });
      }
    } catch (cause) {
      if (
        mounted.current &&
        latest.current.environmentId === captured.environmentId &&
        latest.current.threadId === captured.threadId
      )
        setError({
          key,
          recoveryId: prepared.recoveryId,
          message: cause instanceof Error ? cause.message : String(cause),
        });
    } finally {
      setPreparedRecoveryHold(key, false);
      if (controller.current === abort) controller.current = null;
      if (mounted.current) setAction(null);
    }
  };
  return {
    error,
    action,
    busy: Boolean(holds[key]),
    hasDraft: preparedDraftHasContent(draft),
    retry: (acknowledged: boolean) => run("retry", acknowledged),
    edit: () => run("edit"),
  };
}

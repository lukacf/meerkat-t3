import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, MessageId, ThreadPreparedTurn } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atom-registry";
import { environmentShell } from "./shell";
import { threadOutboxManager } from "./thread-outbox";
import { environmentThreadDetails, environmentThreadShells } from "./threads";
import { preparedTurnBlocksSend } from "./prepared-turn-recovery";
import { scopedThreadKey } from "../lib/scopedEntities";
import type { QueuedThreadMessage } from "./thread-outbox-model";

export const preparedRecoveryHoldsAtom = Atom.make<Readonly<Record<string, true>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:prepared-recovery:holds"),
);

export function setPreparedRecoveryHold(threadKey: string, held: boolean): void {
  const next = { ...appAtomRegistry.get(preparedRecoveryHoldsAtom) };
  if (held) next[threadKey] = true;
  else delete next[threadKey];
  appAtomRegistry.set(preparedRecoveryHoldsAtom, next);
}

export function preparedRecoveryBlocksQueuedMessage(
  prepared: ThreadPreparedTurn | null | undefined,
  message: Partial<
    Pick<QueuedThreadMessage, "replacesPreparedRecoveryId" | "creation" | "commandId">
  >,
): boolean {
  if (!prepared) return false;
  if (prepared.phase !== "released") return true;
  // A released creation is preserved separately by the drain, never resent.
  if (message.creation && message.commandId === prepared.command.commandId) return false;
  return message.replacesPreparedRecoveryId !== prepared.recoveryId;
}

export function nextPreparedRecoveryMessage(
  queue: ReadonlyArray<QueuedThreadMessage>,
  prepared: ThreadPreparedTurn | null | undefined,
): QueuedThreadMessage | undefined {
  if (prepared?.phase !== "released") return queue[0];
  // Recover the original queued copy first, then let an explicit replacement
  // precede older follow-ups that were waiting for that original to start.
  return (
    queue.find((message) => message.creation && message.commandId === prepared.command.commandId) ??
    queue.find((message) => message.replacesPreparedRecoveryId === prepared.recoveryId) ??
    queue[0]
  );
}

/** Subscribe even when the target is not open: shells omit prepared requests. */
export const threadOutboxPreparedStateAtom = Atom.make((get) => {
  const holds = get(preparedRecoveryHoldsAtom);
  const shells = get(environmentThreadShells.threadShellsAtom);
  const blocked = new Set<string>();
  for (const queue of Object.values(get(threadOutboxManager.queuedMessagesByThreadKeyAtom))) {
    const target = queue[0];
    if (!target) continue;
    const targetRef = scopeThreadRef(target.environmentId, target.threadId);
    const exists = shells.some(
      (thread) => thread.environmentId === target.environmentId && thread.id === target.threadId,
    );
    const detail = exists ? get(environmentThreadDetails.detailAtom(targetRef)) : null;
    const message = nextPreparedRecoveryMessage(queue, detail?.preparedTurn)!;
    const key = scopedThreadKey(message.environmentId, message.threadId);
    if (holds[key]) blocked.add(key);
    if (!exists) continue;
    const ref = scopeThreadRef(message.environmentId, message.threadId);
    const status = get(environmentThreadDetails.statusAtom(ref));
    if (
      status !== "live" ||
      !detail ||
      preparedRecoveryBlocksQueuedMessage(detail.preparedTurn, message)
    )
      blocked.add(key);
  }
  return blocked;
});

export function useThreadOutboxPreparedState() {
  return useAtomValue(threadOutboxPreparedStateAtom);
}

export function readPreparedTurnForQueuedMessage(
  message: Pick<QueuedThreadMessage, "environmentId" | "threadId">,
) {
  return appAtomRegistry.get(
    environmentThreadDetails.detailAtom(scopeThreadRef(message.environmentId, message.threadId)),
  )?.preparedTurn;
}

/** Read again after attachment/network awaits and before mutating thread settings. */
export function isPreparedRecoveryBlockingMessage(
  message: Pick<QueuedThreadMessage, "environmentId" | "threadId"> &
    Partial<Pick<QueuedThreadMessage, "replacesPreparedRecoveryId" | "creation" | "commandId">>,
): boolean {
  const key = scopedThreadKey(message.environmentId, message.threadId);
  if (appAtomRegistry.get(preparedRecoveryHoldsAtom)[key]) return true;
  const exists = appAtomRegistry
    .get(environmentThreadShells.threadShellsAtom)
    .some(
      (thread) => thread.environmentId === message.environmentId && thread.id === message.threadId,
    );
  if (!exists) return false;
  const ref = scopeThreadRef(message.environmentId, message.threadId);
  return (
    appAtomRegistry.get(environmentThreadDetails.statusAtom(ref)) !== "live" ||
    !appAtomRegistry.get(environmentThreadDetails.detailAtom(ref)) ||
    preparedRecoveryBlocksQueuedMessage(
      appAtomRegistry.get(environmentThreadDetails.detailAtom(ref))?.preparedTurn,
      message,
    )
  );
}

/** Offline typing can still queue, but cannot bypass a known saved request. */
export function isPreparedRecoveryBlockingComposer(
  message: Pick<QueuedThreadMessage, "environmentId" | "threadId">,
): boolean {
  return (
    Boolean(
      appAtomRegistry.get(preparedRecoveryHoldsAtom)[
        scopedThreadKey(message.environmentId, message.threadId)
      ],
    ) || preparedTurnBlocksSend(readPreparedTurnForQueuedMessage(message))
  );
}

const threadOutboxShellStatusesAtom = Atom.make(
  (get): ReadonlyMap<EnvironmentId, EnvironmentShellStatus> => {
    const statuses = new Map<EnvironmentId, EnvironmentShellStatus>();
    for (const queue of Object.values(get(threadOutboxManager.queuedMessagesByThreadKeyAtom))) {
      const environmentId = queue[0]?.environmentId;
      if (environmentId !== undefined && !statuses.has(environmentId)) {
        statuses.set(environmentId, get(environmentShell.stateValueAtom(environmentId)).status);
      }
    }
    return statuses;
  },
).pipe(Atom.withLabel("mobile:thread-outbox:shell-statuses"));

/**
 * Queued pending tasks the outbox drain must not deliver right now: the one
 * open in the new-task editor, plus any whose latest edits could not be saved
 * back yet (delivering those would send stale content). Editing sessions hold
 * their message id here and release it once the queued payload is current.
 */
export const editingQueuedMessageIdsAtom = Atom.make<Readonly<Record<MessageId, true>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-outbox:editing-message-ids"),
);

export const dispatchingQueuedMessageIdAtom = Atom.make<MessageId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-outbox:dispatching-message-id"),
);

export function holdEditingQueuedMessage(messageId: MessageId): void {
  const current = appAtomRegistry.get(editingQueuedMessageIdsAtom);
  if (current[messageId]) {
    return;
  }
  appAtomRegistry.set(editingQueuedMessageIdsAtom, { ...current, [messageId]: true });
}

export function releaseEditingQueuedMessage(messageId: MessageId): void {
  const current = appAtomRegistry.get(editingQueuedMessageIdsAtom);
  if (!current[messageId]) {
    return;
  }
  const next = { ...current };
  delete next[messageId];
  appAtomRegistry.set(editingQueuedMessageIdsAtom, next);
}

export function useThreadOutboxMessages() {
  return useAtomValue(threadOutboxManager.queuedMessagesByThreadKeyAtom);
}

/**
 * Thread keys (`environmentId:threadId`) of existing threads with a message
 * waiting in the outbox. Creations are excluded: they have no thread row yet
 * and surface as pending tasks instead. Derived once so list builders and
 * reorder planners agree on which settled threads are pulled back to active.
 */
export const queuedThreadKeysAtom = Atom.make((get): ReadonlySet<string> => {
  const keys = new Set<string>();
  for (const [threadKey, queue] of Object.entries(
    get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  )) {
    if (queue.some((message) => message.creation === undefined)) {
      keys.add(threadKey);
    }
  }
  return keys;
}).pipe(Atom.withLabel("mobile:thread-outbox:queued-thread-keys"));

export function useQueuedThreadKeys(): ReadonlySet<string> {
  return useAtomValue(queuedThreadKeysAtom);
}

export function useThreadOutboxShellStatuses() {
  return useAtomValue(threadOutboxShellStatusesAtom);
}

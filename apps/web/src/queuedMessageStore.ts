import {
  ChatAttachment,
  EnvironmentId,
  MeerkatCoordinatorSteer,
  UploadChatImageAttachment,
  TrimmedNonEmptyString,
  type MeerkatAgentControlReceipt,
  type PreviewAnnotationPayload,
} from "@t3tools/contracts";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import type { ComposerSubmissionIntent } from "./composer-logic";
import type { ComposerFileAttachment, ComposerImageAttachment } from "./composerDraftStore";
import type { TerminalContextDraft } from "./lib/terminalContext";
import { randomUUID } from "./lib/utils";
import type { ReviewCommentContext } from "./reviewCommentContext";

/**
 * A composer submission held back while the thread's turn is running. It
 * carries the full draft snapshot so the send path can dispatch it later with
 * the same text, attachments, and contexts the user pressed Enter on.
 */
export interface QueuedComposerMessage {
  id: string;
  prompt: string;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  terminalContexts: TerminalContextDraft[];
  previewAnnotations: PreviewAnnotationPayload[];
  reviewComments: ReviewCommentContext[];
  submissionIntent: ComposerSubmissionIntent;
  /**
   * The newest completed tool activity at queue time. A different id later
   * means a tool call finished after the user queued, which is the boundary
   * the message goes out on.
   */
  queuedAfterToolActivityId: string | null;
  /**
   * Set when the message was created by Stop or a failed restore, not by the
   * user pressing send. It waits for Send now instead of leaving on its own.
   */
  holdUntilUserAction?: boolean;
  /** An uncertain native submission can only check its original receipt. */
  nativeSteeringRequest?: MeerkatCoordinatorSteer;
  createdAt: string;
}

interface QueuedMessageStoreState {
  queuesByThreadKey: Record<string, QueuedComposerMessage[]>;
  /**
   * Bumped by `drain`, even when a send already took the last visible row.
   * Only sends from that exact environment/thread are cancelled by Stop.
   */
  drainGenerationsByThreadKey: Record<string, number>;
  enqueue: (threadKey: string, message: Omit<QueuedComposerMessage, "id">) => QueuedComposerMessage;
  /**
   * Removes one message and returns it, or null when another caller already
   * took it. The remaining messages are re-anchored to `toolActivityId` so
   * only one queued message leaves per tool boundary.
   */
  take: (
    threadKey: string,
    id: string,
    toolActivityId: string | null,
  ) => QueuedComposerMessage | null;
  /** Removes one message without touching the others' anchors. Null when already gone. */
  remove: (threadKey: string, id: string) => QueuedComposerMessage | null;
  /**
   * Puts a message back at the head, held for user action. Used when its
   * send failed: the queue keeps its order and nothing behind it overtakes.
   */
  holdAtFront: (threadKey: string, message: QueuedComposerMessage) => void;
  /** Removes unsent intents, oldest first. Submitted delivery notices remain held. */
  drain: (threadKey: string) => QueuedComposerMessage[];
}

const EMPTY_QUEUE: QueuedComposerMessage[] = [];

type NoticeStorage = Pick<Storage, "getItem" | "setItem">;
export const COORDINATOR_DELIVERY_STORAGE_KEY = "t3code:coordinator-delivery-notices:v1";
const PersistedDeliveryNotice = Schema.Struct({
  environmentId: EnvironmentId.check(Schema.isPattern(/^[^:]+$/)),
  id: TrimmedNonEmptyString,
  prompt: Schema.String,
  request: Schema.Struct({
    ...MeerkatCoordinatorSteer.fields,
    message: Schema.Struct({
      ...MeerkatCoordinatorSteer.fields.message.fields,
      // Upload images may already have ids. Decode this branch first so their
      // bytes do not disappear into the metadata-only ChatAttachment branch.
      attachments: Schema.Array(Schema.Union([UploadChatImageAttachment, ChatAttachment])),
    }),
  }),
});
const decodeNotice = Schema.decodeUnknownSync(PersistedDeliveryNotice);
const decodeEnvelope = Schema.decodeUnknownSync(
  Schema.Struct({
    version: Schema.Literal(1),
    notices: Schema.Array(Schema.Unknown),
  }),
);

function noticeFor(threadKey: string, message: QueuedComposerMessage) {
  const ref = parseScopedThreadKey(threadKey);
  if (!ref || ref.threadId !== message.nativeSteeringRequest?.threadId)
    throw new Error("The delivery notice does not match its original environment and thread.");
  // Preserve the prepared wire payload, including inline images, but never File
  // handles, blob preview URLs, or a second copy of the composer's contexts.
  const notice = {
    environmentId: ref.environmentId,
    id: message.id,
    prompt: message.prompt,
    request: message.nativeSteeringRequest,
  };
  return decodeNotice(notice);
}

function readNotices(storage?: NoticeStorage): QueuedMessageStoreState["queuesByThreadKey"] {
  const queues: QueuedMessageStoreState["queuesByThreadKey"] = {};
  try {
    const raw = storage?.getItem(COORDINATOR_DELIVERY_STORAGE_KEY);
    if (!raw) return queues;
    // No older queue format carried a durable submission identity. Never turn
    // legacy or unrecognized data into a sendable intent or guess its scope.
    const saved = decodeEnvelope(JSON.parse(raw));
    for (const candidate of saved.notices) {
      try {
        const notice = decodeNotice(candidate);
        const request = notice.request;
        const threadKey = scopedThreadKey({
          environmentId: notice.environmentId,
          threadId: request.threadId,
        });
        const queue = queues[threadKey] ?? [];
        if (queue.some((message) => message.id === notice.id)) continue;
        queues[threadKey] = [
          ...queue,
          {
            id: notice.id,
            prompt: notice.prompt,
            images: [],
            files: [],
            terminalContexts: [],
            previewAnnotations: [],
            reviewComments: [],
            submissionIntent: "foreground",
            queuedAfterToolActivityId: null,
            holdUntilUserAction: true,
            nativeSteeringRequest: request,
            createdAt: request.createdAt,
          },
        ];
      } catch {
        // A corrupt row must not hide the other exact, recoverable identities.
      }
    }
  } catch {
    // Storage can be absent, denied, corrupt, or from an unknown version.
  }
  return queues;
}

function serializeNotices(queues: QueuedMessageStoreState["queuesByThreadKey"]) {
  return JSON.stringify({
    version: 1,
    notices: Object.entries(queues).flatMap(([threadKey, messages]) =>
      messages
        .filter((message) => message.nativeSteeringRequest)
        .map((message) => noticeFor(threadKey, message)),
    ),
  });
}

/** Ordinary queues are transient. Only already-submitted receipt notices persist. */
export function createQueuedMessageStore(storage?: NoticeStorage) {
  const queuesByThreadKey = readNotices(storage);
  let savedNotices = serializeNotices(queuesByThreadKey);
  return create<QueuedMessageStoreState>()((set, get) => {
    const update = (
      next: QueuedMessageStoreState["queuesByThreadKey"],
      drainGenerationsByThreadKey?: QueuedMessageStoreState["drainGenerationsByThreadKey"],
    ) => {
      const serialized = serializeNotices(next);
      if (serialized !== savedNotices) {
        try {
          if (!storage) throw new Error("Local storage is unavailable.");
          // Synchronous and before state publication/native dispatch: a closed
          // client can recover a receipt lookup even while the RPC is in flight.
          storage.setItem(COORDINATOR_DELIVERY_STORAGE_KEY, serialized);
        } catch {
          throw new Error(
            "Could not save the delivery notice. Free local storage before trying again.",
          );
        }
        savedNotices = serialized;
      }
      set({
        queuesByThreadKey: next,
        ...(drainGenerationsByThreadKey !== undefined ? { drainGenerationsByThreadKey } : {}),
      });
    };
    return {
      queuesByThreadKey,
      drainGenerationsByThreadKey: {},
      enqueue: (threadKey, message) => {
        const entry: QueuedComposerMessage = { ...message, id: randomUUID() };
        const queues = get().queuesByThreadKey;
        update({ ...queues, [threadKey]: [...(queues[threadKey] ?? EMPTY_QUEUE), entry] });
        return entry;
      },
      take: (threadKey, id, toolActivityId) => {
        const queues = get().queuesByThreadKey;
        const queue = queues[threadKey];
        const entry = queue?.find((message) => message.id === id);
        if (!queue || !entry || entry.nativeSteeringRequest) return null;
        const remaining = queue
          .filter((message) => message.id !== id)
          .map((message) =>
            message.queuedAfterToolActivityId === toolActivityId
              ? message
              : { ...message, queuedAfterToolActivityId: toolActivityId },
          );
        const next = { ...queues };
        if (remaining.length === 0) delete next[threadKey];
        else next[threadKey] = remaining;
        update(next);
        return entry;
      },
      remove: (threadKey, id) => {
        const queues = get().queuesByThreadKey;
        const queue = queues[threadKey];
        const entry = queue?.find((message) => message.id === id);
        if (!queue || !entry) return null;
        const remaining = queue.filter((message) => message.id !== id);
        const next = { ...queues };
        if (remaining.length === 0) delete next[threadKey];
        else next[threadKey] = remaining;
        update(next);
        return entry;
      },
      holdAtFront: (threadKey, message) => {
        const queues = get().queuesByThreadKey;
        const rest = (queues[threadKey] ?? EMPTY_QUEUE).filter((entry) => entry.id !== message.id);
        update({ ...queues, [threadKey]: [{ ...message, holdUntilUserAction: true }, ...rest] });
      },
      drain: (threadKey) => {
        const queues = get().queuesByThreadKey;
        const queue = queues[threadKey] ?? EMPTY_QUEUE;
        const notices = queue.filter((message) => message.nativeSteeringRequest);
        const next = { ...queues };
        if (notices.length === 0) delete next[threadKey];
        else next[threadKey] = notices;
        const generations = get().drainGenerationsByThreadKey;
        update(next, { ...generations, [threadKey]: (generations[threadKey] ?? 0) + 1 });
        return queue.filter((message) => !message.nativeSteeringRequest);
      },
    };
  });
}

function browserStorage() {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
export const useQueuedMessageStore = createQueuedMessageStore(browserStorage());

/** Takes one intent and guards its final dispatch after asynchronous preparation. */
export function takeQueuedMessageForDispatch(input: {
  threadKey: string;
  messageId: string;
  toolActivityId: string | null;
  store?: ReturnType<typeof createQueuedMessageStore>;
}) {
  const store = input.store ?? useQueuedMessageStore;
  const state = store.getState();
  const generation = state.drainGenerationsByThreadKey[input.threadKey] ?? 0;
  const message = state.take(input.threadKey, input.messageId, input.toolActivityId);
  if (!message) return null;

  const restoreIfCancelled = () => {
    if ((store.getState().drainGenerationsByThreadKey[input.threadKey] ?? 0) === generation) {
      return false;
    }
    // Navigation may have changed the visible composer. Retain the original
    // snapshot in its own queue, held for Send now or Cancel, never in live refs.
    store.getState().holdAtFront(input.threadKey, message);
    return true;
  };
  return {
    restoreIfCancelled,
    dispatch<T>(send: () => T) {
      if (restoreIfCancelled()) return { status: "cancelled" as const };
      // No await between the cancellation decision and the actual command.
      return { status: "dispatched" as const, result: send() };
    },
  };
}

/**
 * The newest finished tool call. Its id changing is the boundary a queued
 * message goes out on. Live arrays are sorted, but a snapshot loaded from the
 * database is not, so pick by sequence rather than position.
 */
export function latestCompletedToolActivityId(
  activities: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly sequence?: number | undefined;
    readonly createdAt: string;
  }>,
): string | null {
  let latest: (typeof activities)[number] | null = null;
  for (const activity of activities) {
    if (activity.kind !== "tool.completed") continue;
    if (
      latest === null ||
      (activity.sequence ?? -1) > (latest.sequence ?? -1) ||
      ((activity.sequence ?? -1) === (latest.sequence ?? -1) &&
        activity.createdAt > latest.createdAt)
    ) {
      latest = activity;
    }
  }
  return latest?.id ?? null;
}

/**
 * A queued message is due mid-turn once a tool call finished after it was
 * queued, and as soon as the turn is over otherwise. "connecting" is the gap
 * between a send and the provider picking it up, so nothing is due there.
 */
export function isQueuedMessageDue(input: {
  message: Pick<
    QueuedComposerMessage,
    "queuedAfterToolActivityId" | "holdUntilUserAction" | "nativeSteeringRequest"
  >;
  phase: "connecting" | "running" | "ready" | "disconnected";
  latestToolActivityId: string | null;
}): boolean {
  if (input.message.holdUntilUserAction || input.message.nativeSteeringRequest) return false;
  if (input.phase === "connecting") return false;
  if (input.phase !== "running") return true;
  return input.latestToolActivityId !== input.message.queuedAfterToolActivityId;
}

export function useQueuedMessages(threadKey: string): QueuedComposerMessage[] {
  return useQueuedMessageStore((state) => state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE);
}

/** Receipt inspection never takes the row or invokes an ordinary send path. */
export async function checkQueuedCoordinatorDelivery(input: {
  threadKey: string;
  message: QueuedComposerMessage;
  check: (request: MeerkatCoordinatorSteer) => Promise<MeerkatAgentControlReceipt>;
  store?: ReturnType<typeof createQueuedMessageStore>;
}) {
  const original = input.message.nativeSteeringRequest;
  if (!original) throw new Error("This queued message has no native submission to reconcile.");
  const ref = parseScopedThreadKey(input.threadKey);
  if (!ref || ref.threadId !== original.threadId)
    throw new Error("This delivery notice belongs to a different thread.");
  const store = input.store ?? useQueuedMessageStore;
  const current = store
    .getState()
    .queuesByThreadKey[input.threadKey]?.find((message) => message.id === input.message.id);
  if (current?.nativeSteeringRequest !== original)
    throw new Error("This delivery notice is no longer present in its original environment.");
  const receipt = await input.check({ ...original, receiptOnly: true });
  if (receipt.status === "accepted") {
    const current = store
      .getState()
      .queuesByThreadKey[input.threadKey]?.find((message) => message.id === input.message.id);
    if (current?.nativeSteeringRequest === original)
      store.getState().remove(input.threadKey, input.message.id);
  }
  return receipt;
}

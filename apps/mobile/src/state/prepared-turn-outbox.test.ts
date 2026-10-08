import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Atom } from "effect/unstable/reactivity";

vi.mock("./thread-outbox", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    threadOutboxManager: { queuedMessagesByThreadKeyAtom: Atom.make({}).pipe(Atom.keepAlive) },
  };
});
vi.mock("./shell", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return { environmentShell: { stateValueAtom: Atom.family(() => Atom.make({ status: "live" })) } };
});
vi.mock("./threads", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const details = Atom.family((_key: string) => Atom.make<unknown>(null).pipe(Atom.keepAlive));
  const statuses = Atom.family((_key: string) => Atom.make("empty").pipe(Atom.keepAlive));
  const key = (ref: { environmentId: string; threadId: string }) =>
    `${ref.environmentId}:${ref.threadId}`;
  return {
    environmentThreadShells: { threadShellsAtom: Atom.make([]).pipe(Atom.keepAlive) },
    environmentThreadDetails: {
      detailAtom: (ref: Parameters<typeof key>[0]) => details(key(ref)),
      statusAtom: (ref: Parameters<typeof key>[0]) => statuses(key(ref)),
    },
  };
});

import { appAtomRegistry } from "./atom-registry";
import { environmentThreadDetails, environmentThreadShells } from "./threads";
import { threadOutboxManager } from "./thread-outbox";
import {
  isPreparedRecoveryBlockingMessage,
  preparedRecoveryHoldsAtom,
  setPreparedRecoveryHold,
  threadOutboxPreparedStateAtom,
  isPreparedRecoveryBlockingComposer,
  nextPreparedRecoveryMessage,
} from "./use-thread-outbox";
import { decodeQueuedThreadMessage, encodeQueuedThreadMessage } from "./thread-outbox-model";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

const ref = { environmentId: EnvironmentId.make("remote"), threadId: ThreadId.make("thread") };
const key = "remote:thread";
const message: QueuedThreadMessage = {
  ...ref,
  commandId: CommandId.make("follow-up"),
  messageId: MessageId.make("follow-up"),
  createdAt: "2026-10-05T10:00:00.000Z",
  text: "Queued follow-up",
  attachments: [],
};
const recoveryId = CommandId.make("saved-original");
const explicitReplacement = {
  ...message,
  commandId: CommandId.make("replacement"),
  messageId: MessageId.make("replacement"),
  replacesPreparedRecoveryId: recoveryId,
};
const baseDetail: OrchestrationThread = {
  id: ref.threadId,
  projectId: ProjectId.make("project"),
  title: "Original thread",
  modelSelection: { instanceId: ProviderInstanceId.make("meerkat"), model: "original-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: message.createdAt,
  updatedAt: message.createdAt,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};
const shell: EnvironmentThreadShell = {
  ...baseDetail,
  environmentId: ref.environmentId,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};
const setDetail = (phase?: "blocked" | "released") => {
  const atom = environmentThreadDetails.detailAtom(
    ref,
  ) as Atom.Writable<OrchestrationThread | null>;
  const detail: OrchestrationThread = {
    ...baseDetail,
    preparedTurn: phase
      ? {
          phase,
          recoveryId,
          projectId: baseDetail.projectId,
          projectCwd: "/project",
          expectedCwd: "/project/worktree",
          setup: "finished",
          providerIdentity: {
            driverKind: ProviderDriverKind.make("meerkat"),
            continuationKey: "original-provider",
          },
          createdAt: message.createdAt,
          updatedAt: message.createdAt,
          command: {
            type: "thread.turn.start",
            commandId: recoveryId,
            threadId: ref.threadId,
            runtimeMode: baseDetail.runtimeMode,
            interactionMode: baseDetail.interactionMode,
            modelSelection: baseDetail.modelSelection,
            createdAt: message.createdAt,
            message: {
              messageId: MessageId.make("original-message"),
              role: "user",
              text: "Original request",
              attachments: [],
            },
          },
        }
      : undefined,
  };
  appAtomRegistry.set(atom, detail);
};
const setStatus = (status: "empty" | "live") => {
  appAtomRegistry.set(environmentThreadDetails.statusAtom(ref) as Atom.Writable<string>, status);
};

beforeEach(() => {
  appAtomRegistry.set(preparedRecoveryHoldsAtom, {});
  appAtomRegistry.set(
    environmentThreadShells.threadShellsAtom as Atom.Writable<
      ReadonlyArray<EnvironmentThreadShell>
    >,
    [shell],
  );
  appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, { [key]: [message] });
  appAtomRegistry.set(
    environmentThreadDetails.detailAtom(ref) as Atom.Writable<OrchestrationThread | null>,
    null,
  );
  setStatus("empty");
});

describe("prepared recovery and mobile outbox admission", () => {
  it("waits for cold existing-thread details, then reacts to blocked and released recovery", () => {
    const unsubscribe = appAtomRegistry.subscribe(threadOutboxPreparedStateAtom, () => {});
    try {
      expect(appAtomRegistry.get(threadOutboxPreparedStateAtom).has(key)).toBe(true);
      expect(isPreparedRecoveryBlockingMessage(ref)).toBe(true);
      setStatus("live");
      setDetail("blocked");
      expect(appAtomRegistry.get(threadOutboxPreparedStateAtom).has(key)).toBe(true);
      setDetail("released");
      expect(appAtomRegistry.get(threadOutboxPreparedStateAtom).has(key)).toBe(true);
      expect(isPreparedRecoveryBlockingMessage(message)).toBe(true);
      expect(appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom)[key]).toEqual([
        message,
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("holds both normal sends and queued work through release and local persistence", async () => {
    setStatus("live");
    setDetail("blocked");
    setPreparedRecoveryHold(key, true);
    setDetail("released");
    await Promise.resolve();
    expect(isPreparedRecoveryBlockingMessage(ref)).toBe(true);
    setPreparedRecoveryHold(key, false);
    expect(isPreparedRecoveryBlockingMessage(ref)).toBe(true);
    expect(isPreparedRecoveryBlockingMessage(explicitReplacement)).toBe(false);
  });

  it("rechecks a newly blocked saved request after an async preparation step", async () => {
    setStatus("live");
    setDetail();
    expect(isPreparedRecoveryBlockingMessage(ref)).toBe(false);
    await Promise.resolve();
    setDetail("blocked");
    const deliver = vi.fn();
    if (!isPreparedRecoveryBlockingMessage(ref)) deliver();
    expect(deliver).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom)[key]).toEqual([
      message,
    ]);
  });

  it("allows unsent creations and keeps identical thread IDs in other environments independent", () => {
    const other = { environmentId: EnvironmentId.make("other"), threadId: ref.threadId };
    setPreparedRecoveryHold(key, true);
    expect(isPreparedRecoveryBlockingMessage(other)).toBe(false);
    expect(isPreparedRecoveryBlockingMessage(ref)).toBe(true);
  });

  it("allows offline composer enqueue but requires live recovery authority before outbox dispatch", () => {
    expect(isPreparedRecoveryBlockingComposer(ref)).toBe(false);
    expect(isPreparedRecoveryBlockingMessage(message)).toBe(true);
    setDetail("blocked");
    expect(isPreparedRecoveryBlockingComposer(ref)).toBe(true);
  });

  it("persists only explicit replacement consent across restart and binds it to the saved original", () => {
    setStatus("live");
    setDetail("released");
    const restoredOld = decodeQueuedThreadMessage(encodeQueuedThreadMessage(message));
    const restoredExplicit = decodeQueuedThreadMessage(
      encodeQueuedThreadMessage(explicitReplacement),
    );
    expect(restoredOld.replacesPreparedRecoveryId).toBeUndefined();
    expect(restoredExplicit.replacesPreparedRecoveryId).toBe(recoveryId);
    expect(isPreparedRecoveryBlockingMessage(restoredOld)).toBe(true);
    expect(isPreparedRecoveryBlockingMessage(restoredExplicit)).toBe(false);
    expect(
      isPreparedRecoveryBlockingMessage({
        ...restoredExplicit,
        replacesPreparedRecoveryId: CommandId.make("different-original"),
      }),
    ).toBe(true);
  });

  it("lets an explicit replacement precede held follow-ups without automatically authorizing them", () => {
    setStatus("live");
    setDetail("released");
    const prepared = appAtomRegistry.get(environmentThreadDetails.detailAtom(ref))!.preparedTurn;
    expect(nextPreparedRecoveryMessage([message, explicitReplacement], prepared)).toBe(
      explicitReplacement,
    );
    expect(isPreparedRecoveryBlockingMessage(message)).toBe(true);
    expect(nextPreparedRecoveryMessage([message, explicitReplacement], null)).toBe(message);
    appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {
      [key]: [message, explicitReplacement],
    });
    expect(appAtomRegistry.get(threadOutboxPreparedStateAtom).has(key)).toBe(false);
  });

  it("preserves the matching queued creation before any explicit replacement can consume recovery", () => {
    setStatus("live");
    setDetail("released");
    const originalCopy: QueuedThreadMessage = {
      ...message,
      commandId: recoveryId,
      creation: {
        projectId: ProjectId.make("project"),
        workspaceMode: "local",
        branch: null,
        worktreePath: null,
      },
    };
    const prepared = appAtomRegistry.get(environmentThreadDetails.detailAtom(ref))!.preparedTurn;
    const queue = [message, explicitReplacement, originalCopy];
    expect(nextPreparedRecoveryMessage(queue, prepared)).toBe(originalCopy);
    appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, { [key]: queue });
    expect(appAtomRegistry.get(threadOutboxPreparedStateAtom).has(key)).toBe(false);
    expect(isPreparedRecoveryBlockingMessage(originalCopy)).toBe(false);
    expect(
      isPreparedRecoveryBlockingMessage({
        ...originalCopy,
        commandId: CommandId.make("another-creation"),
      }),
    ).toBe(true);
  });
});

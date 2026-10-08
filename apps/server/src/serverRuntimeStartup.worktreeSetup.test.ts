import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type ThreadPreparedTurn,
  ThreadId,
  WORKTREE_SETUP_ACTIVITY_KIND,
  WorktreeSetupSnapshot,
  worktreeSetupActivityId,
  type WorktreeSetupPhase,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import { ProfileRestoreReview, type RestoreReviewService } from "./restoreReview.ts";

const startedAt = "2026-08-20T12:00:00.000Z";

const snapshotFor = (
  threadId: ThreadId,
  phase: WorktreeSetupPhase,
  agentStatus: "pending" | "done" = phase === "running" ? "pending" : "done",
): WorktreeSetupSnapshot => ({
  threadId,
  phase,
  startedAt,
  endedAt: phase === "running" ? null : startedAt,
  branch: "feature",
  baseRef: "main",
  worktreePath: null,
  setupScript: null,
  stages: [
    {
      id: "checkout",
      status: "done",
      startedAt,
      endedAt: startedAt,
      percent: null,
      detail: null,
      tail: [],
    },
    {
      id: "setup-script",
      status: phase === "running" ? "running" : "done",
      startedAt,
      endedAt: phase === "running" ? null : startedAt,
      percent: null,
      detail: null,
      tail: [],
    },
    {
      id: "agent",
      status: agentStatus,
      startedAt: null,
      endedAt: null,
      percent: null,
      detail: null,
      tail: [],
    },
  ],
  error: null,
  sequence: 4,
});

const recordedSetup = (id: string, phase: WorktreeSetupPhase, agentStatus?: "pending" | "done") => {
  const threadId = ThreadId.make(id);
  return {
    id: EventId.make(worktreeSetupActivityId(threadId)),
    tone: "info" as const,
    kind: WORKTREE_SETUP_ACTIVITY_KIND,
    summary: "Setting up worktree",
    payload: snapshotFor(threadId, phase, agentStatus),
    turnId: null,
    createdAt: startedAt,
  };
};

type StartupThread = Pick<
  OrchestrationThread,
  "id" | "archivedAt" | "deletedAt" | "latestTurn" | "session" | "preparedTurn"
>;

const run = (
  activities: ReadonlyArray<ReturnType<typeof recordedSetup>>,
  threads: ReadonlyArray<StartupThread> = [],
) =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationCommand> = [];
    yield* ServerRuntimeStartup.reconcileWorktreeSetups.pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        listActivitiesByKind: (kind: string) =>
          Effect.succeed(kind === WORKTREE_SETUP_ACTIVITY_KIND ? activities : []),
        getCommandReadModel: () => Effect.succeed({ threads } as never),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused"),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      }),
      Effect.provide(NodeServices.layer),
    );
    return dispatched;
  });

it.effect("marks setups still recorded as running failed after a restart", () =>
  Effect.gen(function* () {
    const dispatched = yield* run([
      recordedSetup("thread-running", "running"),
      recordedSetup("thread-done", "done"),
      recordedSetup("thread-failed", "failed"),
    ]);

    assert.equal(dispatched.length, 1);
    const command = dispatched[0]!;
    assert.equal(command.type, "thread.activity.append");
    if (command.type !== "thread.activity.append") return;
    assert.equal(command.threadId, ThreadId.make("thread-running"));
    assert.equal(command.activity.id, worktreeSetupActivityId(ThreadId.make("thread-running")));
    assert.equal(command.activity.tone, "error");
    const payload = yield* Schema.decodeUnknownEffect(WorktreeSetupSnapshot)(
      command.activity.payload,
    );
    assert.equal(payload.phase, "failed");
    assert.isNotNull(payload.endedAt);
    assert.equal(payload.sequence, 5);
    assert.deepEqual(
      payload.stages.map((stage) => stage.status),
      ["done", "failed", "failed"],
    );
  }),
);

const preparedFor = (
  id: string,
  overrides: Partial<ThreadPreparedTurn> = {},
): ThreadPreparedTurn => ({
  recoveryId: CommandId.make(`request-${id}`),
  projectId: ProjectId.make("project"),
  projectCwd: "/repo",
  expectedCwd: `/repo-worktrees/${id}`,
  providerIdentity: {
    driverKind: ProviderDriverKind.make("meerkat"),
    continuationKey: "native-root",
  },
  command: {
    type: "thread.turn.start",
    commandId: CommandId.make(`request-${id}`),
    threadId: ThreadId.make(id),
    message: {
      messageId: MessageId.make(`message-${id}`),
      role: "user",
      text: "Keep this original message",
      attachments: [],
    },
    modelSelection: {
      instanceId: ProviderInstanceId.make("native"),
      model: "openai:original-model",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: startedAt,
  },
  phase: "ready",
  setup: "sync_running",
  createdAt: startedAt,
  updatedAt: startedAt,
  ...overrides,
});
const threadFor = (preparedTurn: ThreadPreparedTurn): StartupThread => ({
  id: preparedTurn.command.threadId,
  archivedAt: null,
  deletedAt: null,
  latestTurn: null,
  session: null,
  preparedTurn,
});
const runPrepared = (threads: ReadonlyArray<StartupThread>) =>
  Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];
    yield* ServerRuntimeStartup.reconcilePreparedTurns.pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed({ threads } as never),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused"),
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      }),
      Effect.provide(NodeServices.layer),
    );
    return commands;
  });

it.effect(
  "does not promote unconfirmed checkout preparation even when an expected path was saved",
  () =>
    Effect.gen(function* () {
      const original = preparedFor("preparing", { phase: "preparing", setup: "not_started" });
      const commands = yield* runPrepared([threadFor(original)]);
      assert.equal(commands.length, 1);
      const command = commands[0]!;
      if (command.type !== "thread.prepared-turn.set") return assert.fail(command.type);
      assert.equal(command.preparedTurn.phase, "preparing");
      assert.equal(command.preparedTurn.expectedCwd, original.expectedCwd);
      assert.deepStrictEqual(command.preparedTurn.command, original.command);
      assert.equal(command.preparedTurn.recoveryId, original.recoveryId);
      assert.deepStrictEqual(command.preparedTurn.providerIdentity, original.providerIdentity);
      assert.match(command.preparedTurn.reason!, /before checkout preparation was confirmed/);
      // A repeated restart has nothing new to dispatch and still cannot execute the pending command.
      const repeated = yield* runPrepared([threadFor(command.preparedTurn)]);
      assert.deepStrictEqual(repeated, []);
    }),
);

it.effect.each([
  "not_started",
  "sync_running",
  "async_running",
  "finished",
  "skipped",
  "failed",
] as const)(
  "blocks surviving ready bootstrap ownership with %s setup without rerunning or sending",
  (setup) =>
    Effect.gen(function* () {
      const original = preparedFor(`setup-${setup}`, { setup });
      const commands = yield* runPrepared([threadFor(original)]);
      assert.equal(commands.length, 1);
      const command = commands[0]!;
      if (command.type !== "thread.prepared-turn.set") return assert.fail(command.type);
      assert.equal(command.preparedTurn.phase, "blocked");
      assert.equal(command.preparedTurn.setup, setup);
      assert.match(
        command.preparedTurn.reason!,
        setup === "not_started" || setup === "sync_running"
          ? /Explicitly continue without rerunning setup/
          : /Review and retry the pending message/,
      );
      assert.deepStrictEqual(command.preparedTurn.command, original.command);
      assert.equal(command.preparedTurn.recoveryId, original.recoveryId);
      assert.equal(command.preparedTurn.expectedCwd, original.expectedCwd);
      assert.deepStrictEqual(command.preparedTurn.providerIdentity, original.providerIdentity);
      assert.deepStrictEqual(yield* runPrepared([threadFor(command.preparedTurn)]), []);
    }),
);

it.effect("preserves blocked account failures and never revives retired or inactive threads", () =>
  Effect.gen(function* () {
    const blocked = preparedFor("account-blocked", {
      phase: "blocked",
      setup: "sync_running",
      reason: "Connect the selected account",
    });
    const released = preparedFor("released", { phase: "released" });
    const deleted = { ...threadFor(preparedFor("deleted")), deletedAt: startedAt };
    const archived = { ...threadFor(preparedFor("archived")), archivedAt: startedAt };
    assert.deepStrictEqual(
      yield* runPrepared([threadFor(blocked), threadFor(released), deleted, archived]),
      [],
    );
  }),
);

it.effect("keeps restored prepared state untouched before restore review", () =>
  Effect.gen(function* () {
    const hold: RestoreReviewService = {
      held: true,
      status: () => ({
        status: "required",
        restoreId: "restore",
        restoredAt: null,
        backupCreatedAt: null,
        message: "Review restored work",
      }),
      consent: async () => {
        throw new Error("Unused consent");
      },
    };
    assert.deepStrictEqual(
      yield* runPrepared([threadFor(preparedFor("restored"))]).pipe(
        Effect.provideService(ProfileRestoreReview, hold),
      ),
      [],
    );
  }),
);

it.effect(
  "points an interrupted typed setup to its saved pending message while preserving legacy recovery copy",
  () =>
    Effect.gen(function* () {
      const typed = preparedFor("typed", { phase: "blocked" });
      const commands = yield* run(
        [recordedSetup("typed", "running"), recordedSetup("legacy", "running")],
        [threadFor(typed)],
      );
      assert.equal(commands.length, 2);
      const payloads = yield* Effect.forEach(commands, (command) => {
        if (command.type !== "thread.activity.append")
          return Effect.die("Unexpected work dispatch");
        return Schema.decodeUnknownEffect(WorktreeSetupSnapshot)(command.activity.payload);
      });
      assert.match(payloads[0]!.error!, /pending message is saved/);
      assert.notMatch(payloads[0]!.error!, /Send the message again/);
      assert.match(payloads[1]!.error!, /Send the message again/);
    }),
);

it.effect(
  "settles an async setup script whose turn already started without failing the setup",
  () =>
    Effect.gen(function* () {
      const dispatched = yield* run([recordedSetup("thread-async", "running", "done")]);

      assert.equal(dispatched.length, 1);
      const command = dispatched[0]!;
      if (command.type !== "thread.activity.append") return assert.fail(command.type);
      const payload = yield* Schema.decodeUnknownEffect(WorktreeSetupSnapshot)(
        command.activity.payload,
      );
      // The turn is live; only the background script was lost. Nothing asks the
      // user to resend, and the setup reads as done with a failed script stage.
      assert.equal(payload.phase, "done");
      assert.isNull(payload.error);
      assert.deepEqual(
        payload.stages.map((stage) => stage.status),
        ["done", "failed", "done"],
      );
    }),
);

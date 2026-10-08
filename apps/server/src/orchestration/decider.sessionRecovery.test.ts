import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { decideOrchestrationCommand } from "./decider.ts";

const before = "2026-09-28T12:00:00.000Z";
const after = "2026-09-28T12:00:01.000Z";
const threadId = ThreadId.make("thread");
const session: OrchestrationSession = {
  threadId,
  status: "error",
  providerName: "meerkat",
  providerInstanceId: ProviderInstanceId.make("native"),
  runtimeMode: "full-access",
  activeTurnId: TurnId.make("old-run"),
  lastError: "Connection lost",
  updatedAt: before,
};
function readModel(overrides: Partial<OrchestrationThread> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [],
    updatedAt: before,
    threads: [
      {
        id: threadId,
        projectId: ProjectId.make("project"),
        title: "Conversation",
        modelSelection: { instanceId: ProviderInstanceId.make("native"), model: "test" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: {
          turnId: TurnId.make("old-run"),
          state: "running",
          requestedAt: before,
          startedAt: before,
          completedAt: null,
          assistantMessageId: null,
        },
        createdAt: before,
        updatedAt: before,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session,
        ...overrides,
      },
    ],
  };
}
const command = {
  type: "thread.session.set" as const,
  commandId: CommandId.make("recover"),
  threadId,
  expectedCurrent: session,
  expectedThreadUpdatedAt: before,
  session: {
    ...session,
    status: "interrupted" as const,
    activeTurnId: null,
    lastError: null,
    updatedAt: after,
  },
  createdAt: after,
};
it.layer(NodeServices.layer)("conditional session recovery", (it) => {
  it.effect("settles the exact interrupted session without inventing a new turn", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({ command, readModel: readModel() });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);
      expect(events[0]?.payload).toMatchObject({
        session: { status: "interrupted", activeTurnId: null },
      });
    }),
  );
  it.effect("rejects a replacement provider, changed mode, newer turn, or updated session", () =>
    Effect.gen(function* () {
      const mutations: Partial<OrchestrationSession>[] = [
        { providerInstanceId: ProviderInstanceId.make("other") },
        { runtimeMode: "approval-required" },
        { activeTurnId: TurnId.make("new-run") },
        { updatedAt: after },
        { lastError: "A different failure" },
      ];
      for (const mutation of mutations) {
        const error = yield* Effect.flip(
          decideOrchestrationCommand({
            command,
            readModel: readModel({ session: { ...session, ...mutation } }),
          }),
        );
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
      }
    }),
  );
  it.effect("rejects a new prompt even while the session still shows error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: { ...command, expectedThreadUpdatedAt: after },
          readModel: readModel({
            updatedAt: after,
            messages: [
              {
                id: MessageId.make("new-message"),
                role: "user",
                text: "New work",
                turnId: null,
                streaming: false,
                createdAt: after,
                updatedAt: after,
              },
            ],
          }),
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
  it.effect("rejects a queued update that changes the thread after the captured snapshot", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({ command, readModel: readModel({ updatedAt: after }) }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
  it.effect("rejects a newer running turn even before its session projection changes", () =>
    Effect.gen(function* () {
      const current = readModel();
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command,
          readModel: readModel({
            latestTurn: { ...current.threads[0]!.latestTurn!, turnId: TurnId.make("new-run") },
          }),
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
  it.effect("preserves unconditional session updates for existing callers", () =>
    Effect.gen(function* () {
      const {
        expectedCurrent: _expected,
        expectedThreadUpdatedAt: _timestamp,
        ...unconditional
      } = command;
      const result = yield* decideOrchestrationCommand({
        command: unconditional,
        readModel: readModel({ session: null }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events[0]?.type).toBe("thread.session-set");
    }),
  );
});

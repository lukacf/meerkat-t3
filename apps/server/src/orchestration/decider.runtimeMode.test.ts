import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-09-28T12:00:00.000Z";
const threadId = ThreadId.make("thread");
const session: OrchestrationSession = {
  threadId,
  status: "ready",
  providerName: "meerkat",
  providerInstanceId: ProviderInstanceId.make("native"),
  runtimeMode: "approval-required",
  activeTurnId: null,
  lastError: null,
  updatedAt: now,
};

function readModel(
  nativeSession: OrchestrationSession | null,
  runtimeMode: RuntimeMode = "approval-required",
): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [],
    updatedAt: now,
    threads: [
      {
        id: threadId,
        projectId: ProjectId.make("project"),
        title: "Conversation",
        modelSelection: { instanceId: ProviderInstanceId.make("native"), model: "test" },
        runtimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
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
        session: nativeSession,
      },
    ],
  };
}

function command(runtimeMode: RuntimeMode) {
  return {
    type: "thread.runtime-mode.set" as const,
    commandId: CommandId.make("set-access"),
    threadId,
    runtimeMode,
    createdAt: now,
  };
}

it.layer(NodeServices.layer)("native session access policy", (it) => {
  it.effect(
    "rejects access changes before emitting a projection event in every session state",
    () =>
      Effect.gen(function* () {
        for (const status of [
          "idle",
          "starting",
          "running",
          "ready",
          "interrupted",
          "stopped",
          "error",
        ] as const) {
          for (const savedMode of ["read-only", "approval-required", "full-access"] as const) {
            const nextMode = savedMode === "full-access" ? "read-only" : "full-access";
            const current = readModel({ ...session, status, runtimeMode: savedMode }, savedMode);
            const result = yield* Effect.flip(
              decideOrchestrationCommand({ command: command(nextMode), readModel: current }),
            );
            expect(result._tag).toBe("OrchestrationCommandInvariantError");
            expect(current.threads[0]?.runtimeMode).toBe(savedMode);
            expect(current.threads[0]?.session?.runtimeMode).toBe(savedMode);
          }
        }
      }),
  );

  it.effect("rejects a legacy requested mode that disagrees with the saved native policy", () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(
        decideOrchestrationCommand({
          command: command("full-access"),
          readModel: readModel(session, "full-access"),
        }),
      );
      expect(result._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("allows repairing an outdated projection to the session's actual policy", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: command("approval-required"),
        readModel: readModel(session, "full-access"),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "thread.runtime-mode-set",
        payload: { threadId, runtimeMode: "approval-required" },
      });
    }),
  );

  it.effect("allows a new conversation to select access before a session exists", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: command("read-only"),
        readModel: readModel(null),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events[0]).toMatchObject({
        type: "thread.runtime-mode-set",
        payload: { runtimeMode: "read-only" },
      });
    }),
  );

  it.effect("preserves mode changes for other providers", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: command("full-access"),
        readModel: readModel({ ...session, providerName: "codex" }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events[0]).toMatchObject({
        type: "thread.runtime-mode-set",
        payload: { runtimeMode: "full-access" },
      });
    }),
  );
});

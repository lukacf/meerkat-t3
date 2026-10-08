import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const TestLayer = OrchestrationEngineLive.pipe(
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provideMerge(OrchestrationProjectionPipelineLive),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-same-run-steering-projection-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const createRunningThread = Effect.fnUntraced(function* (
  name: string,
  providerName: "meerkat" | "codex" = "meerkat",
) {
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const sql = yield* SqlClient.SqlClient;
  const threadId = ThreadId.make(name);
  const projectId = ProjectId.make(`${name}-project`);
  const turnId = TurnId.make(`${name}-run`);
  const createdAt = "2026-09-25T18:00:00.000Z";
  const modelSelection = {
    instanceId: ProviderInstanceId.make(`${providerName}-instance`),
    model: "test-model",
  };
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make(`${name}-project-create`),
    projectId,
    title: name,
    workspaceRoot: `/tmp/${name}`,
    defaultModelSelection: modelSelection,
    createdAt,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`${name}-thread-create`),
    projectId,
    threadId,
    title: name,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt,
  });
  let step = 0;
  const timestamp = () => `2026-09-25T18:00:${String(++step).padStart(2, "0")}.000Z`;
  const send = (suffix: string, handlingMode?: "steer" | "queue") =>
    engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`${name}-${suffix}`),
      threadId,
      message: {
        messageId: MessageId.make(`${name}-${suffix}`),
        role: "user",
        text: suffix,
        attachments: [],
      },
      ...(handlingMode === undefined ? {} : { handlingMode }),
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: timestamp(),
    });
  const setSession = (activeTurnId: TurnId | null) => {
    const updatedAt = timestamp();
    return engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`${name}-native-session-${step}`),
      threadId,
      session: {
        threadId,
        providerName,
        providerInstanceId: modelSelection.instanceId,
        activeTurnId,
        status: activeTurnId === null ? "ready" : "running",
        runtimeMode: "full-access",
        lastError: null,
        updatedAt,
      },
      createdAt: updatedAt,
    });
  };
  const rows = () => sql<{
    readonly turnId: string | null;
    readonly messageId: string | null;
    readonly state: string;
  }>`
    SELECT turn_id AS "turnId", pending_message_id AS "messageId", state
    FROM projection_turns WHERE thread_id = ${threadId}
    ORDER BY requested_at, turn_id
  `;
  const detail = query.getThreadDetailById(threadId).pipe(Effect.map(Option.getOrThrow));
  yield* send("initial");
  yield* setSession(turnId);
  return { engine, threadId, turnId, send, setSession, rows, detail, timestamp };
});

it.layer(TestLayer)("same-run steering projection", (it) => {
  it.effect(
    "settles one Meerkat turn after steering and preserves it through projection rebuild",
    () =>
      Effect.gen(function* () {
        const fixture = yield* createRunningThread("accepted-steer");
        yield* fixture.send("steer", "steer");
        assert.deepEqual(yield* fixture.rows(), [
          { turnId: fixture.turnId, messageId: "accepted-steer-initial", state: "running" },
        ]);
        // Meerkat admits steering to the existing run without another turn.started.
        yield* fixture.setSession(null);
        const expected = [
          { turnId: fixture.turnId, messageId: "accepted-steer-initial", state: "completed" },
        ];
        assert.deepEqual(yield* fixture.rows(), expected);
        const detail = yield* fixture.detail;
        assert.strictEqual(detail.session?.status, "ready");
        assert.strictEqual(detail.session?.activeTurnId, null);
        assert.strictEqual(detail.latestTurn?.turnId, fixture.turnId);
        assert.strictEqual(detail.latestTurn?.state, "completed");
        assert.deepEqual(
          detail.messages.map((message) => message.text),
          ["initial", "steer"],
        );

        const events = yield* Stream.runCollect(fixture.engine.readEvents(0));
        const steering = events.find(
          (event) =>
            event.type === "thread.turn-start-requested" &&
            event.payload.messageId === "accepted-steer-steer",
        );
        assert.strictEqual(steering?.type, "thread.turn-start-requested");
        if (steering?.type !== "thread.turn-start-requested") return;
        assert.strictEqual(steering.payload.steeringTurnId, fixture.turnId);

        // Rebuild only the turn projector while the session projector is already
        // at ready. The persisted request must retain its original run target.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM projection_state WHERE projector = 'projection.thread-turns'`;
        yield* (yield* OrchestrationProjectionPipeline).bootstrap;
        assert.deepEqual(yield* fixture.rows(), expected);
        assert.strictEqual((yield* fixture.detail).latestTurn?.state, "completed");
      }),
  );

  it.effect("rejected steering preserves the active run, queued request and failure message", () =>
    Effect.gen(function* () {
      const fixture = yield* createRunningThread("rejected-steer");
      yield* fixture.send("queued", "queue");
      const before = yield* fixture.rows();
      assert.strictEqual(before[1]?.messageId, "rejected-steer-queued");
      yield* fixture.send("steer", "steer");
      assert.deepEqual(yield* fixture.rows(), before);
      const createdAt = fixture.timestamp();
      yield* fixture.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("rejected-steer-failure"),
        threadId: fixture.threadId,
        activity: {
          id: EventId.make("rejected-steer-failure"),
          tone: "error",
          kind: "provider.turn.start.failed",
          summary: "Steering delivery was not confirmed",
          payload: { requestId: "rejected-steer-steer" },
          turnId: null,
          createdAt,
        },
        createdAt,
      });
      assert.deepEqual(yield* fixture.rows(), before);
      const detail = yield* fixture.detail;
      assert.strictEqual(detail.session?.status, "running");
      assert.strictEqual(detail.session?.activeTurnId, fixture.turnId);
      assert.deepEqual(
        detail.messages.map((message) => message.text),
        ["initial", "queued", "steer"],
      );
      assert.strictEqual(detail.activities.at(-1)?.kind, "provider.turn.start.failed");
    }),
  );

  it.effect("keeps a queued Meerkat turn pending until its distinct native run starts", () =>
    Effect.gen(function* () {
      const fixture = yield* createRunningThread("queued-after-steer");
      yield* fixture.send("queued", "queue");
      yield* fixture.send("steer", "steer");
      yield* fixture.setSession(null);
      assert.deepEqual(yield* fixture.rows(), [
        { turnId: fixture.turnId, messageId: "queued-after-steer-initial", state: "completed" },
        { turnId: null, messageId: "queued-after-steer-queued", state: "pending" },
      ]);
      const nextTurnId = TurnId.make("queued-after-steer-next-run");
      yield* fixture.setSession(nextTurnId);
      yield* fixture.setSession(null);
      assert.deepEqual(yield* fixture.rows(), [
        { turnId: fixture.turnId, messageId: "queued-after-steer-initial", state: "completed" },
        { turnId: nextTurnId, messageId: "queued-after-steer-queued", state: "completed" },
      ]);
    }),
  );

  it.effect("preserves providers whose steering starts a different turn", () =>
    Effect.gen(function* () {
      const fixture = yield* createRunningThread("other-provider-steer", "codex");
      yield* fixture.send("steer", "steer");
      assert.strictEqual((yield* fixture.rows()).at(-1)?.state, "pending");
      const nextTurnId = TurnId.make("other-provider-steered-run");
      yield* fixture.setSession(nextTurnId);
      assert.deepEqual(yield* fixture.rows(), [
        { turnId: fixture.turnId, messageId: "other-provider-steer-initial", state: "completed" },
        { turnId: nextTurnId, messageId: "other-provider-steer-steer", state: "running" },
      ]);
      yield* fixture.setSession(null);
      assert.strictEqual((yield* fixture.detail).latestTurn?.state, "completed");
    }),
  );
});

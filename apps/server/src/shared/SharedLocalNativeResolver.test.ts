import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MeerkatProjectTeam,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { makeSharedLocalNativeResolver } from "./SharedLocalNativeResolver.ts";

const projectId = ProjectId.make("project");
const threadId = ThreadId.make("thread");
const instanceId = ProviderInstanceId.make("native");
const environmentId = EnvironmentId.make("local");
const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) })),
  Layer.provideMerge(SqlitePersistenceMemory),
);
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES ('project','Project','/fixture/project','[]','2026-10-17T00:00:00Z','2026-10-17T00:00:00Z')`;
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at)
    VALUES ('thread','project','Task','{"instanceId":"native","model":"fixture"}','full-access','default','2026-10-17T00:00:00Z','2026-10-17T00:00:00Z')`;
  const agent: MeerkatProjectTeam["providers"][number]["agents"][number] = {
    agentRef: "ref",
    mobId: "thread-mob",
    mobLabel: "Task",
    mobKind: "thread",
    scopeLabel: "Project",
    threadId,
    availability: "live",
    record: {
      identity: "ingress",
      display_name: "Task",
      runtime_key: "runtime",
      runtime_member_id: "ingress",
      session_id: "session",
      visibility: "addressable",
      addressable: true,
      health: "ready",
      labels: {},
    },
  };
  let agents = [agent];
  let observations = 0;
  const resolve = yield* makeSharedLocalNativeResolver({
    projectTeam: ({ projectId: requested }) =>
      Effect.sync((): MeerkatProjectTeam => {
        expect(requested).toBe(projectId);
        observations++;
        return {
          projectId,
          observation: "loaded_runtimes",
          observedAt: "2026-10-17T00:00:00Z",
          projectAgents: [],
          providers: [
            {
              instanceId,
              label: "Native",
              status: "ready",
              errors: [],
              totalScopeCount: 1,
              unloadedScopeCount: 0,
              loadedMobCount: 1,
              agents,
            },
          ],
        };
      }),
  }).pipe(
    Effect.provideService(ServerEnvironment, {
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.die("Descriptor is not needed for native caller resolution"),
    }),
  );
  return {
    sql,
    resolve,
    agent,
    setAgents: (next: typeof agents) => {
      agents = next;
    },
    observations: () => observations,
  };
});

describe("local delegation native caller resolution", () => {
  it.effect(
    "uses each fresh native session observation rather than the saved task model selection",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        expect(yield* f.resolve(threadId)).toEqual({
          environmentId,
          projectId,
          threadId,
          instanceId,
          mobId: "thread-mob",
          sessionId: "session",
        });
        f.setAgents([{ ...f.agent, record: { ...f.agent.record, session_id: "new-session" } }]);
        expect(yield* f.resolve(threadId)).toMatchObject({ sessionId: "new-session" });
        f.setAgents([]);
        expect((yield* f.resolve(threadId).pipe(Effect.flip)).code).toBe("unavailable");
        expect(f.observations()).toBe(3);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses ambiguous, retired, child, nonaddressable and other-task native records", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const agents of [
        [
          f.agent,
          {
            ...f.agent,
            agentRef: "other",
            record: { ...f.agent.record, session_id: "other-session" },
          },
        ],
        [{ ...f.agent, availability: "unloaded" as const }],
        [{ ...f.agent, mobKind: "domain" }],
        [{ ...f.agent, threadId: ThreadId.make("another-thread") }],
        [{ ...f.agent, record: { ...f.agent.record, labels: { source_mob_id: "child" } } }],
        [{ ...f.agent, record: { ...f.agent.record, addressable: false } }],
        [{ ...f.agent, record: { ...f.agent.record, visibility: "retired_readable" as const } }],
        [{ ...f.agent, record: { ...f.agent.record, session_id: undefined } }],
      ]) {
        f.setAgents(agents);
        expect((yield* f.resolve(threadId).pipe(Effect.flip)).code).toBe("unavailable");
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses archived and deleted tasks before observing a native candidate", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`UPDATE projection_threads SET archived_at='2026-10-17T01:00:00Z' WHERE thread_id='thread'`;
      expect((yield* f.resolve(threadId).pipe(Effect.flip)).code).toBe("unavailable");
      yield* f.sql`UPDATE projection_threads SET archived_at=NULL,deleted_at='2026-10-17T01:00:00Z' WHERE thread_id='thread'`;
      expect((yield* f.resolve(threadId).pipe(Effect.flip)).code).toBe("unavailable");
      expect(f.observations()).toBe(0);
    }).pipe(Effect.provide(layer)),
  );
});

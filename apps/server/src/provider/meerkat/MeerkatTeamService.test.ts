import { describe, expect, it } from "@effect/vitest";
import {
  type ConsoleIdentityRecord,
  type ConsoleTimelineWindowPage,
  ProjectId,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderDriverError } from "../Errors.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import type { MeerkatNativeTeamSnapshot, MeerkatTeamReader } from "./MeerkatTeamReader.ts";
import { makeMeerkatTeamService } from "./MeerkatTeamService.ts";
import { ProjectCloneTracker } from "../../project/ProjectCloneTracker.ts";

const projectId = ProjectId.make("project-a");
const otherProjectId = ProjectId.make("project-b");
const instanceId = ProviderInstanceId.make("meerkat-a");
const otherInstanceId = ProviderInstanceId.make("meerkat-b");
const driverKind = ProviderDriverKind.make("meerkat");
const decodeProvider = Schema.decodeEffect(ServerProvider);
const identity: ConsoleIdentityRecord = {
  identity: "ingress",
  display_name: "Native worker",
  runtime_key: "default",
  runtime_member_id: "member-a",
  session_id: "session-a",
  visibility: "addressable",
  addressable: true,
  health: "ready",
  labels: { source_mob_id: "child-a", spawned_by: "ingress" },
};
const timeline: ConsoleTimelineWindowPage = {
  frames: [
    {
      id: "frame-a",
      cursor: "1",
      dedupe_key: "source-a",
      timestamp_ms: 100,
      runtime_key: "default",
      identity: "ingress",
      kind: "tool_call_completed",
      status: "completed",
      frame_version: 2,
      updated_at_ms: 200,
      source: { kind: "console_event", source_cursor: "event-a" },
      run_id: "native-run",
      payload: { nested: ["unmodified", { result: 7 }] },
    },
  ],
  latest_cursor: "1",
  next_cursor: "0",
};
const loaded = (
  records: ReadonlyArray<ConsoleIdentityRecord> = [identity],
): MeerkatNativeTeamSnapshot => ({
  observation: "loaded_runtimes",
  loaded: true,
  mobs: [
    {
      mobId: "root-mob",
      kind: "thread",
      label: "Native team",
      consoleStatus: "ready",
      identities: records,
    },
  ],
});

function provider(
  id: ProviderInstanceId,
  reader: MeerkatTeamReader,
  enabled = true,
): ProviderInstance {
  return {
    instanceId: id,
    driverKind,
    continuationIdentity: { driverKind, continuationKey: id },
    displayName: id,
    enabled,
    meerkatTeam: reader,
    get adapter(): never {
      throw new Error("Team reads cannot start or restore sessions.");
    },
    get snapshot(): never {
      throw new Error("Team reads cannot refresh catalogs.");
    },
    get textGeneration(): never {
      throw new Error("Team reads cannot generate text.");
    },
  };
}

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [id, root] of [
    [projectId, "/workspace/a"],
    [otherProjectId, "/workspace/b"],
  ]) {
    yield* sql`INSERT INTO projection_projects
      (project_id,title,workspace_root,scripts_json,created_at,updated_at)
      VALUES (${id},${id},${root},'[]','now','now')`;
  }
});
const bindWorktree = Effect.fnUntraced(function* (input: {
  threadId: string;
  worktree: string;
  project?: ProjectId;
  instance?: ProviderInstanceId;
  archived?: boolean;
  deleted?: boolean;
  bound?: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_threads
    (thread_id,project_id,title,model_selection_json,worktree_path,created_at,updated_at,archived_at,deleted_at)
    VALUES (${input.threadId},${input.project ?? projectId},'Test','{}',${input.worktree},'now','now',
      ${input.archived ? "now" : null},${input.deleted ? "now" : null})`;
  if (input.bound !== false)
    yield* sql`INSERT INTO provider_session_runtime
    (thread_id,provider_name,provider_instance_id,adapter_key,status,last_seen_at)
    VALUES (${input.threadId},'meerkat',${input.instance ?? instanceId},'meerkat','stopped','now')`;
});
const harness = Effect.fnUntraced(function* (
  input: {
    instances?: ReadonlyArray<ProviderInstance>;
    shadows?: ReadonlyArray<ServerProvider>;
    history?: boolean;
    savedHistory?: ReturnType<NonNullable<MeerkatTeamReader["history"]>>;
    work?: MeerkatTeamReader["work"];
    resume?: MeerkatTeamReader["resume"];
    stopCrew?: MeerkatTeamReader["stopCrew"];
    stop?: MeerkatTeamReader["stop"];
  } = {},
) {
  let native = loaded();
  let stateRoot = "/native-state";
  const reads: string[] = [];
  const activityCalls: Array<Parameters<MeerkatTeamReader["activity"]>[0]> = [];
  const historyCalls: Array<Parameters<MeerkatTeamReader["activity"]>[0]> = [];
  const reader: MeerkatTeamReader = {
    get stateRoot() {
      return stateRoot;
    },
    snapshot: (root) =>
      Effect.sync(() => {
        reads.push(root);
        return native;
      }),
    ...(input.history
      ? {
          history: (request: Parameters<MeerkatTeamReader["activity"]>[0]) =>
            Effect.sync(() => {
              activityCalls.push(request);
              historyCalls.push(request);
            }).pipe(Effect.andThen(input.savedHistory ?? Effect.succeed({ timeline }))),
        }
      : {}),
    ...(input.work ? { work: input.work } : {}),
    ...(input.resume ? { resume: input.resume } : {}),
    ...(input.stopCrew ? { stopCrew: input.stopCrew } : {}),
    ...(input.stop ? { stop: input.stop } : {}),
    activity: (request) =>
      Effect.sync(() => {
        activityCalls.push(request);
        return timeline;
      }),
  };
  const instances = input.instances ?? [provider(instanceId, reader)];
  const service = yield* makeMeerkatTeamService.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
        Layer.mock(ProviderInstanceRegistry)({
          listInstances: Effect.succeed(instances),
          listUnavailable: Effect.succeed(input.shadows ?? []),
        }),
      ),
    ),
  );
  yield* seed;
  return {
    ...service,
    reads,
    activityCalls,
    historyCalls,
    setNative: (value: MeerkatNativeTeamSnapshot) => {
      native = value;
    },
    setStateRoot: (value: string) => {
      stateRoot = value;
    },
  };
});
const testLayer = Layer.mergeAll(SqlitePersistenceMemory, Path.layer);

describe("Meerkat project Team", () => {
  it.effect(
    "reads bound project and archived worktrees once and excludes foreign, deleted and unbound scopes",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* bindWorktree({ threadId: "one", worktree: "/worktrees/shared" });
        yield* bindWorktree({ threadId: "two", worktree: "/worktrees/shared", archived: true });
        yield* bindWorktree({
          threadId: "archived",
          worktree: "/worktrees/archived",
          archived: true,
        });
        yield* bindWorktree({
          threadId: "foreign-project",
          worktree: "/worktrees/foreign",
          project: otherProjectId,
        });
        yield* bindWorktree({
          threadId: "foreign-instance",
          worktree: "/worktrees/other",
          instance: otherInstanceId,
        });
        yield* bindWorktree({ threadId: "deleted", worktree: "/worktrees/deleted", deleted: true });
        yield* bindWorktree({ threadId: "unbound", worktree: "/worktrees/unbound", bound: false });
        const result = yield* h.projectTeam({ projectId });
        expect(h.reads).toEqual(["/workspace/a", "/worktrees/archived", "/worktrees/shared"]);
        expect(result.providers[0]?.totalScopeCount).toBe(3);
        expect(new Set(result.providers[0]?.agents.map((agent) => agent.agentRef)).size).toBe(3);
        expect(result.providers[0]?.agents[0]?.record).toEqual(identity);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects unknown and deleted projects without native reads", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      expect(
        (yield* Effect.flip(h.projectTeam({ projectId: ProjectId.make("missing") }))).message,
      ).toBe("Project not found.");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_projects SET deleted_at = 'now' WHERE project_id = ${projectId}`;
      expect((yield* Effect.flip(h.projectTeam({ projectId }))).message).toBe("Project not found.");
      expect(h.reads).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps cold runtime observations explicit without admission", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setNative({ observation: "loaded_runtimes", loaded: false, mobs: [] });
      for (let count = 0; count < 2; count++) {
        const result = yield* h.projectTeam({ projectId });
        expect(result.providers[0]).toMatchObject({
          status: "ready",
          unloadedScopeCount: 1,
          loadedMobCount: 0,
          agents: [],
        });
      }
      expect(h.activityCalls).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "rejects cross-project, wrong-instance and replaced-incarnation refs, preserving native recent pages",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const team = yield* h.projectTeam({ projectId });
        const agentRef = team.providers[0]!.agents[0]!.agentRef;
        for (const input of [
          { projectId: otherProjectId, instanceId, agentRef },
          { projectId, instanceId: otherInstanceId, agentRef },
        ]) {
          expect((yield* Effect.flip(h.agentActivity(input))).message).toContain(
            "current ready roster",
          );
        }
        expect(h.activityCalls).toEqual([]);
        const activity = yield* h.agentActivity({ projectId, instanceId, agentRef, limit: 7 });
        expect(activity.timeline).toEqual(timeline);
        expect(h.activityCalls).toEqual([
          {
            projectPath: "/workspace/a",
            mobId: "root-mob",
            identity: "ingress",
            record: identity,
            limit: 7,
          },
        ]);
        yield* h.agentActivity({
          projectId,
          instanceId,
          agentRef,
          limit: 100,
          mode: "since",
          after: "opaque-after",
          before: "opaque-frontier",
        });
        expect(h.activityCalls[1]).toMatchObject({
          mode: "since",
          after: "opaque-after",
          before: "opaque-frontier",
          limit: 100,
        });
        h.setNative(loaded([{ ...identity, session_id: "replacement" }]));
        expect(
          (yield* Effect.flip(h.agentActivity({ projectId, instanceId, agentRef }))).message,
        ).toContain("cannot read an unloaded worker session");
        expect(h.activityCalls).toHaveLength(2);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "retains unloaded worker discovery and reads its exact old session without permitting controls",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ history: true });
        const live = (yield* h.projectTeam({ projectId })).providers[0]!.agents[0]!;
        h.setNative({ observation: "loaded_runtimes", loaded: false, mobs: [] });
        const cold = (yield* h.projectTeam({ projectId })).providers[0]!.agents[0]!;
        expect(cold.agentRef).toBe(live.agentRef);
        expect(cold.availability).toBe("unloaded");
        expect(cold.record.addressable).toBe(false);
        expect(cold.work?.status).toBe("unloaded");
        const history = yield* h.agentActivity({ projectId, instanceId, agentRef: live.agentRef });
        expect(history.timeline).toEqual(timeline);
        expect(history.agent?.record.addressable).toBe(false);
        expect(h.activityCalls[0]?.record?.session_id).toBe("session-a");
        expect(
          (yield* Effect.flip(
            h.agentSend({
              projectId,
              instanceId,
              agentRef: live.agentRef,
              requestId: "never-send",
              text: "hello",
              handlingMode: "queue",
            }),
          )).message,
        ).toContain("current project roster");
        expect(
          (yield* Effect.flip(
            h.agentStop({ projectId, instanceId, agentRef: live.agentRef, nativeRunId: "old-run" }),
          )).message,
        ).toContain("current project roster");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("exposes resume only from an observed native stopped crew", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const snapshot = loaded();
      h.setNative({
        ...snapshot,
        mobs: snapshot.mobs.map((mob) => ({ ...mob, stoppedCrewIds: ["child-a"] })),
      });
      const stopped = (yield* h.projectTeam({ projectId })).providers[0]!.agents[0]!;
      expect(stopped.canResume).toBe(true);
      expect(stopped.record.addressable).toBe(true);
      h.setNative(loaded());
      expect((yield* h.projectTeam({ projectId })).providers[0]!.agents[0]!.canResume).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("stops and resumes an owner-bound crew through its exact native session", () =>
    Effect.gen(function* () {
      const calls: Array<{ operation: string; record: ConsoleIdentityRecord }> = [];
      const h = yield* harness({
        stopCrew: ({ record }) =>
          Effect.sync(() => {
            calls.push({ operation: "stop-crew", record });
          }),
        resume: ({ record }) =>
          Effect.sync(() => {
            calls.push({ operation: "resume", record });
          }),
        stop: ({ record }) =>
          Effect.sync(() => {
            calls.push({ operation: "stop-turn", record });
          }),
      });
      const snapshot = loaded();
      const bound = {
        ...snapshot,
        mobs: snapshot.mobs.map((mob) => ({ ...mob, ownerBoundCrewIds: ["child-a"] })),
      };
      h.setNative(bound);
      const agent = (yield* h.projectTeam({ projectId })).providers[0]!.agents[0]!;
      const scope = { projectId, instanceId, agentRef: agent.agentRef };
      yield* h.agentStopCrew(scope);
      h.setNative({
        ...bound,
        mobs: bound.mobs.map((mob) => ({ ...mob, stoppedCrewIds: ["child-a"] })),
      });
      const stopped = (yield* h.projectTeam({ projectId })).providers[0]!.agents[0]!;
      expect(stopped.canResume).toBe(true);
      expect(stopped.agentRef).toBe(agent.agentRef);
      yield* h.agentResume(scope);
      h.setNative(bound);
      yield* h.agentStop({ ...scope, nativeRunId: "observed-run" });
      expect(calls.map((call) => call.operation)).toEqual(["stop-crew", "resume", "stop-turn"]);
      for (const call of calls) {
        expect(call.record).toEqual(identity);
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps saved transcript pages on the same session after owner reconnection", () =>
    Effect.gen(function* () {
      const transcript = {
        sessionId: "session-a",
        storeRevision: "7",
        totalMessages: 3,
        exhausted: false,
        messages: [{ offset: 2, message: { role: "block_assistant", content: "saved result" } }],
        nextBefore: 2,
      };
      const h = yield* harness({
        history: true,
        savedHistory: Effect.succeed({ timeline, transcript, historyStatus: "partial" }),
      });
      const live = (yield* h.projectTeam({ projectId })).providers[0]!.agents[0]!;
      h.setNative({ observation: "loaded_runtimes", loaded: false, mobs: [] });
      const cold = yield* h.agentActivity({ projectId, instanceId, agentRef: live.agentRef });
      expect(cold.transcript).toEqual(transcript);
      expect(cold.historyStatus).toBe("partial");
      expect(cold.timeline).toEqual(timeline);
      h.setNative(loaded());
      const next = yield* h.agentActivity({
        projectId,
        instanceId,
        agentRef: live.agentRef,
        transcriptBefore: 2,
        transcriptRevision: "7",
      });
      expect(next.transcript).toEqual(transcript);
      expect(h.historyCalls[1]).toMatchObject({
        transcriptBefore: 2,
        transcriptRevision: "7",
        record: { session_id: "session-a" },
      });
      expect(
        (yield* Effect.flip(
          h.agentActivity({ projectId, instanceId, agentRef: live.agentRef, transcriptBefore: 2 }),
        )).message,
      ).toContain("requires its native revision");
      expect(h.historyCalls).toHaveLength(2);
      expect(
        (yield* Effect.flip(
          h.agentActivity({
            projectId: otherProjectId,
            instanceId,
            agentRef: live.agentRef,
            transcriptBefore: 2,
            transcriptRevision: "7",
          }),
        )).message,
      ).toContain("current ready roster");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "refreshes committed messages after reconnect without replacing live event history",
    () =>
      Effect.gen(function* () {
        let transcript = {
          sessionId: "session-a",
          storeRevision: "7",
          totalMessages: 1,
          exhausted: true,
          messages: [{ offset: 0, message: { role: "user", content: "Earlier message" } }],
        };
        const savedTimeline = { frames: [] };
        const h = yield* harness({
          history: true,
          savedHistory: Effect.sync(() => ({
            timeline: savedTimeline,
            transcript,
            historyStatus: "partial" as const,
          })),
        });
        const live = (yield* h.projectTeam({ projectId })).providers[0]!.agents[0]!;
        const input = { projectId, instanceId, agentRef: live.agentRef };
        expect(yield* h.agentActivity(input)).toMatchObject({ transcript, timeline });

        h.setNative({ observation: "loaded_runtimes", loaded: false, mobs: [] });
        expect(yield* h.agentActivity(input)).toMatchObject({
          transcript,
          timeline: savedTimeline,
        });
        h.setNative(loaded());
        transcript = {
          ...transcript,
          storeRevision: "16",
          totalMessages: 3,
          messages: [
            ...transcript.messages,
            { offset: 1, message: { role: "user", content: "Queued follow-up" } },
            { offset: 2, message: { role: "block_assistant", content: "Queue completed" } },
          ],
        };
        const completed = yield* h.agentActivity(input);
        expect(completed.transcript).toEqual(transcript);
        expect(completed.timeline).toEqual(timeline);
        expect(completed.historyStatus).toBe("partial");
        expect(completed.agent?.record.session_id).toBe(live.record.session_id);
        expect(h.historyCalls).toHaveLength(3);
        for (const request of h.historyCalls) {
          expect(request.record?.session_id).toBe("session-a");
          expect(request.transcriptRevision).toBeUndefined();
        }
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not label an absent worker retired when its owner reconnects", () =>
    Effect.gen(function* () {
      const h = yield* harness({ history: true });
      const live = (yield* h.projectTeam({ projectId })).providers[0]!.agents[0]!;
      h.setNative({ observation: "loaded_runtimes", loaded: false, mobs: [] });
      yield* h.projectTeam({ projectId });
      h.setNative(loaded([]));
      const missing = (yield* h.projectTeam({ projectId })).providers[0]!.agents[0]!;
      expect(missing.agentRef).toBe(live.agentRef);
      expect(missing.availability).toBe("unknown");
      expect(missing.record.addressable).toBe(false);
      expect(missing.canResume).toBe(false);
      const activity = yield* h.agentActivity({ projectId, instanceId, agentRef: live.agentRef });
      expect(activity.agent?.availability).toBe("unknown");
      expect(h.historyCalls[0]?.record?.session_id).toBe("session-a");
      expect(
        (yield* Effect.flip(h.agentStopCrew({ projectId, instanceId, agentRef: live.agentRef })))
          .message,
      ).toContain("current project roster");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reads a natively retired worker through exact durable history", () =>
    Effect.gen(function* () {
      const h = yield* harness({ history: true });
      h.setNative(loaded([{ ...identity, addressable: false, visibility: "retired_readable" }]));
      const retired = (yield* h.projectTeam({ projectId })).providers[0]!.agents[0]!;
      const result = yield* h.agentActivity({ projectId, instanceId, agentRef: retired.agentRef });
      expect(result.agent?.availability).toBe("retired");
      expect(result.agent?.record.addressable).toBe(false);
      expect(h.historyCalls).toHaveLength(1);
      expect(h.historyCalls[0]?.record?.session_id).toBe("session-a");
      h.setNative(loaded([]));
      expect((yield* h.projectTeam({ projectId })).providers[0]!.agents[0]!.availability).toBe(
        "retired",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "keeps replaced session handles readable while listing the latest durable identity",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ history: true });
        const first = (yield* h.projectTeam({ projectId })).providers[0]!.agents[0]!;
        h.setNative(loaded([{ ...identity, session_id: "replacement" }]));
        const latest = (yield* h.projectTeam({ projectId })).providers[0]!.agents;
        expect(latest).toHaveLength(1);
        expect(latest[0]?.durableId).toBe(first.durableId);
        expect(latest[0]?.agentRef).not.toBe(first.agentRef);
        yield* h.agentActivity({ projectId, instanceId, agentRef: first.agentRef });
        expect(h.activityCalls[0]?.record?.session_id).toBe("session-a");
        expect(
          (yield* Effect.flip(
            h.agentStop({
              projectId,
              instanceId,
              agentRef: first.agentRef,
              nativeRunId: "old-run",
            }),
          )).message,
        ).toContain("current project roster");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("uses native current work status and degrades failed observations to unknown", () =>
    Effect.gen(function* () {
      let fail = false;
      const h = yield* harness({
        work: () =>
          fail
            ? Effect.fail(
                new ProviderDriverError({ driver: driverKind, instanceId, detail: "offline" }),
              )
            : Effect.succeed({ status: "running", nativeRunId: "current-native-run" }),
      });
      expect((yield* h.projectTeam({ projectId })).providers[0]?.agents[0]?.work).toMatchObject({
        status: "running",
        nativeRunId: "current-native-run",
      });
      fail = true;
      expect((yield* h.projectTeam({ projectId })).providers[0]?.agents[0]?.work?.status).toBe(
        "unknown",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("stops the captured run even when a newer run appears during target validation", () =>
    Effect.gen(function* () {
      let nativeRunId = "observed-run";
      const stopped: string[] = [];
      const h = yield* harness({
        work: () => Effect.succeed({ status: "running", nativeRunId }),
        stop: (target) => Effect.sync(() => stopped.push(target.nativeRunId)),
      });
      const observed = (yield* h.projectTeam({ projectId })).providers[0]!.agents[0]!;
      const input = {
        projectId,
        instanceId,
        agentRef: observed.agentRef,
        nativeRunId: observed.work!.nativeRunId!,
      };
      nativeRunId = "newer-run";
      yield* h.agentStop(input);
      expect(stopped).toEqual(["observed-run"]);
      const readsBefore = h.reads.length;
      expect((yield* Effect.result(h.agentStop({ ...input, nativeRunId: "" })))._tag).toBe(
        "Failure",
      );
      expect(stopped).toEqual(["observed-run"]);
      expect(h.reads).toHaveLength(readsBefore);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "resolves question and media targets without allowing ambiguous or foreign ownership",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const live = (yield* h.projectTeam({ projectId })).providers[0]!.agents[0]!;
        const target = yield* h.interactionTarget({
          projectId,
          instanceId,
          agentRef: live.agentRef,
        });
        expect(target.record.session_id).toBe("session-a");
        expect(
          (yield* Effect.flip(
            h.interactionTarget({
              projectId,
              instanceId,
              agentRef: live.agentRef,
              threadId: ThreadId.make("thread"),
            }),
          )).message,
        ).toContain("exactly one");
        expect(
          (yield* Effect.flip(
            h.interactionTarget({ projectId: otherProjectId, instanceId, agentRef: live.agentRef }),
          )).message,
        ).toContain("live native target");
        h.setNative({ observation: "loaded_runtimes", loaded: false, mobs: [] });
        expect(
          (yield* Effect.flip(
            h.interactionTarget({ projectId, instanceId, agentRef: live.agentRef }),
          )).message,
        ).toContain("live native target");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "explicit crew resume uses preserved native identity and returns the fresh roster without sending",
    () =>
      Effect.gen(function* () {
        const resumed: string[] = [];
        const h = yield* harness({
          resume: (target) =>
            Effect.sync(() => {
              resumed.push(target.record.session_id!);
              return { resumed: true };
            }),
        });
        const agent = (yield* h.projectTeam({ projectId })).providers[0]!.agents[0]!;
        const result = yield* h.agentResume({ projectId, instanceId, agentRef: agent.agentRef });
        expect(result.projectId).toBe(projectId);
        expect(resumed).toEqual(["session-a"]);
        expect(h.activityCalls).toEqual([]);
        h.setStateRoot("/other-provider-state");
        expect(
          (yield* Effect.flip(h.agentResume({ projectId, instanceId, agentRef: agent.agentRef })))
            .message,
        ).toContain("original native provider");
        expect(resumed).toHaveLength(1);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("stops only the exact live worker crew and returns native stopped availability", () =>
    Effect.gen(function* () {
      const calls: Array<Parameters<NonNullable<MeerkatTeamReader["stopCrew"]>>[0]> = [];
      const h = yield* harness({
        stopCrew: (target) =>
          Effect.sync(() => {
            calls.push(target);
            h.setNative({
              ...loaded(),
              mobs: loaded().mobs.map((mob) => ({ ...mob, stoppedCrewIds: ["child-a"] })),
            });
            return { stopped: true };
          }),
      });
      const agent = (yield* h.projectTeam({ projectId })).providers[0]!.agents[0]!;
      const scope = { projectId, instanceId, agentRef: agent.agentRef };
      expect(
        (yield* Effect.result(h.agentStopCrew({ ...scope, projectId: otherProjectId })))._tag,
      ).toBe("Failure");
      expect(
        (yield* Effect.result(h.agentStopCrew({ ...scope, instanceId: otherInstanceId })))._tag,
      ).toBe("Failure");
      const stopped = yield* h.agentStopCrew(scope);
      expect(stopped.providers[0]!.agents[0]!.canResume).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        projectPath: "/workspace/a",
        mobId: "root-mob",
        record: identity,
      });
      h.setNative(loaded([{ ...identity, session_id: "replacement" }]));
      expect((yield* Effect.result(h.agentStopCrew(scope)))._tag).toBe("Failure");
      h.setNative({ observation: "loaded_runtimes", loaded: false, mobs: [] });
      expect((yield* Effect.result(h.agentStopCrew(scope)))._tag).toBe("Failure");
      expect(calls).toHaveLength(1);
      expect(h.activityCalls).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects non-crew and sessionless targets before native crew stop", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const h = yield* harness({
        stopCrew: () =>
          Effect.sync(() => {
            calls.push("stop");
          }),
      });
      for (const record of [
        { ...identity, labels: {} },
        { ...identity, session_id: undefined },
      ]) {
        h.setNative(loaded([record]));
        const agent = (yield* h.projectTeam({ projectId })).providers[0]!.agents[0]!;
        expect(
          (yield* Effect.result(
            h.agentStopCrew({ projectId, instanceId, agentRef: agent.agentRef }),
          ))._tag,
        ).toBe("Failure");
      }
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects references from a provider's previous configured state root", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const team = yield* h.projectTeam({ projectId });
      const agentRef = team.providers[0]!.agents[0]!.agentRef;
      h.setStateRoot("/reconfigured-state");
      const error = yield* Effect.flip(h.agentActivity({ projectId, instanceId, agentRef }));
      expect(error.message).toContain("current ready roster");
      expect(h.activityCalls).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("distinguishes child aliases and rejects ambiguous native activity", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setNative(loaded([identity, { ...identity, labels: { source_mob_id: "child-b" } }]));
      const team = yield* h.projectTeam({ projectId });
      const agents = team.providers[0]!.agents;
      expect(agents[0]!.agentRef).not.toBe(agents[1]!.agentRef);
      expect(
        (yield* Effect.flip(
          h.agentActivity({ projectId, instanceId, agentRef: agents[0]!.agentRef }),
        )).message,
      ).toContain("ambiguous");
      expect(h.activityCalls).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("preserves successful siblings and reports unavailable consoles", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setNative({
        ...loaded(),
        mobs: [
          ...loaded().mobs,
          {
            mobId: "no-console",
            kind: "thread",
            label: "Unavailable mob",
            consoleStatus: "unavailable",
            error: "No console",
            identities: [],
          },
        ],
      });
      const team = yield* h.projectTeam({ projectId });
      expect(team.providers[0]).toMatchObject({ status: "partial", loadedMobCount: 2 });
      expect(team.providers[0]?.agents).toHaveLength(1);
      expect(team.providers[0]?.errors).toEqual([
        "Project workspace / Unavailable mob: No console",
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("retains disabled, failed and unavailable configured instances without fallback", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const failing: MeerkatTeamReader = {
        stateRoot: "/native-state",
        snapshot: (root) => {
          calls.push(root);
          return Effect.fail(
            new ProviderDriverError({ driver: driverKind, instanceId, detail: "Gateway offline" }),
          );
        },
        activity: () => Effect.die("No activity may be read"),
      };
      const shadow = yield* decodeProvider({
        instanceId: "unavailable",
        driver: "meerkat",
        enabled: true,
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown", label: "Unavailable" },
        checkedAt: "now",
        availability: "unavailable",
        message: "Driver missing",
        models: [],
      });
      const h = yield* harness({
        instances: [provider(instanceId, failing, false), provider(otherInstanceId, failing)],
        shadows: [shadow],
      });
      const team = yield* h.projectTeam({ projectId });
      expect(team.providers.map((item) => [item.instanceId, item.status])).toEqual([
        [instanceId, "disabled"],
        [otherInstanceId, "unavailable"],
        ["unavailable", "unavailable"],
      ]);
      expect(calls).toEqual(["/workspace/a"]);
      expect(team.providers[1]?.errors[0]).toContain("Gateway offline");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("caps scope reads with an explicit partial response", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      for (let n = 0; n < 65; n++)
        yield* bindWorktree({ threadId: `scope-${n}`, worktree: `/worktrees/${n}` });
      const team = yield* h.projectTeam({ projectId });
      expect(h.reads).toHaveLength(64);
      expect(team.providers[0]).toMatchObject({ status: "partial", totalScopeCount: 66 });
      expect(team.providers[0]?.errors[0]).toContain("first 64 of 66");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects invalid limits before querying the native roster", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      for (const limit of [0, 101, 1.5])
        yield* Effect.flip(h.agentActivity({ projectId, instanceId, agentRef: "unused", limit }));
      expect(h.reads).toEqual([]);
      expect(h.activityCalls).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );
});

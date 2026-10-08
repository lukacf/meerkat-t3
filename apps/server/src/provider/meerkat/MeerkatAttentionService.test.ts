import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  MeerkatControlError,
  MeerkatTeamError,
  type MeerkatPendingQuestion,
  type MeerkatApproval,
  type MeerkatProjectTeam,
  type MeerkatAttentionStreamItem,
  MeerkatTeamAgent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { makeMeerkatAttentionService } from "./MeerkatAttentionService.ts";

const projectId = ProjectId.make("project");
const instanceId = ProviderInstanceId.make("provider");
const threadId = ThreadId.make("thread");
const encodeAgent = Schema.encodeSync(Schema.fromJsonString(MeerkatTeamAgent));
const time = "2026-09-28T12:00:00.000Z";
const question: MeerkatPendingQuestion = {
  requestId: "request",
  sessionId: "session",
  mobId: "mob",
  toolCallId: "tool",
  createdAt: time,
  title: "Review approach",
  questions: [
    {
      id: "choice",
      question: "Proceed?",
      options: [{ id: "yes", label: "Yes", description: "" }],
      allowCustom: true,
      multiSelect: false,
    },
  ],
};
const agent: MeerkatTeamAgent = {
  agentRef: "agent-session",
  durableId: "durable",
  mobId: "mob",
  mobLabel: "Thread",
  mobKind: "thread",
  scopeLabel: "Thread",
  threadId,
  availability: "live",
  record: {
    identity: "reviewer",
    display_name: "Reviewer",
    runtime_key: "default",
    runtime_member_id: "worker",
    session_id: "session",
    visibility: "addressable",
    addressable: true,
    health: "ready",
    labels: { source_mob_id: "crew" },
  },
  work: { status: "idle", observedAt: time },
};
const harness = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Project','/project','[]',${time},${time})`;
  yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,created_at,updated_at) VALUES (${threadId},${projectId},'Thread','{}',${time},${time})`;
  let agents: MeerkatTeamAgent[] = [agent];
  let questions: MeerkatPendingQuestion[] = [];
  let approvals: MeerkatApproval[] = [];
  let approvalFailure = false;
  let queryFailure = false;
  let teamFailure = false;
  let beforeQuestions: Effect.Effect<void> = Effect.void;
  const scopes: unknown[] = [];
  const team = {
    projectTeam: () =>
      teamFailure
        ? Effect.fail(
            new MeerkatTeamError({ projectId, operation: "project-team", message: "Disconnected" }),
          )
        : Effect.succeed<MeerkatProjectTeam>({
            projectId,
            observation: "loaded_runtimes",
            observedAt: time,
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
          }),
  };
  const controls = {
    approvals: () =>
      approvalFailure
        ? Effect.fail(new MeerkatControlError({ projectId, message: "Approval RPC failed" }))
        : Effect.succeed({ approvals }),
    questions: (input: unknown) => {
      scopes.push(input);
      return beforeQuestions.pipe(
        Effect.andThen(
          queryFailure
            ? Effect.fail(new MeerkatControlError({ projectId, message: "Question RPC failed" }))
            : Effect.succeed({ requests: questions }),
        ),
      );
    },
  };
  const service = yield* makeMeerkatAttentionService(team, controls);
  return {
    service,
    sql,
    scopes,
    reopen: () => makeMeerkatAttentionService(team, controls),
    setAgents: (value: MeerkatTeamAgent[]) => {
      agents = value;
    },
    setApprovals: (value: MeerkatApproval[]) => {
      approvals = value;
    },
    setApprovalFailure: (value: boolean) => {
      approvalFailure = value;
    },
    setQuestions: (value: MeerkatPendingQuestion[]) => {
      questions = value;
    },
    setFailure: (value: boolean) => {
      queryFailure = value;
    },
    setTeamFailure: (value: boolean) => {
      teamFailure = value;
    },
    setBeforeQuestions: (value: Effect.Effect<void>) => {
      beforeQuestions = value;
    },
  };
});
const takeSnapshot = <E>(
  events: Queue.Dequeue<MeerkatAttentionStreamItem, E>,
  source: "initial" | "mutation" | "observation",
) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(events);
      if (event.kind === "snapshot" && event.source === source) return event.snapshot;
    }
  });

describe("durable native attention", () => {
  it.effect("persists a native-input completion once without a console interaction", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(time));
      const h = yield* harness();
      yield* h.service.runOnce;
      const completion = {
        kind: "runtime_input" as const,
        sessionId: "session",
        inputId: "initial-input",
        runId: "initial-run",
        status: "completed" as const,
        timestampMs: Date.parse(time) + 1,
      };
      const completed = {
        ...agent,
        work: { ...agent.work!, outcome: "Initial work finished", latestCompletion: completion },
      };
      h.setAgents([completed]);
      yield* h.service.runOnce;
      const first = (yield* h.service.list({ projectId })).items;
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        kind: "completion",
        sessionId: "session",
        unread: true,
        detail: "Initial work finished",
      });
      yield* h.service.markRead({ projectId, itemIds: [first[0]!.id] });
      const reloaded = yield* h.reopen();
      yield* reloaded.runOnce;
      expect((yield* reloaded.list({ projectId })).items).toEqual([]);
      expect((yield* reloaded.list({ projectId, itemId: first[0]!.id })).items[0]?.unread).toBe(
        false,
      );
      // A reused visible agent cannot inherit another session's native receipt.
      h.setAgents([
        {
          ...completed,
          agentRef: "replacement",
          record: { ...agent.record, session_id: "replacement" },
        },
      ]);
      yield* reloaded.runOnce;
      expect((yield* reloaded.list({ projectId })).items).toEqual([]);
      h.setAgents([
        {
          ...completed,
          agentRef: "replacement",
          record: { ...agent.record, session_id: "replacement" },
          work: {
            ...completed.work,
            latestCompletion: { ...completion, sessionId: "replacement" },
          },
        },
      ]);
      yield* reloaded.runOnce;
      const second = (yield* reloaded.list({ projectId })).items;
      expect(second).toHaveLength(1);
      expect(second[0]?.id).not.toBe(first[0]!.id);
      expect(second[0]?.sessionId).toBe("replacement");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("keeps completions at or after startup unread before the first observation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const startedAtMs = Date.parse(time);
        yield* TestClock.setTime(startedAtMs);
        const h = yield* harness();
        const events = yield* Stream.toQueue(h.service.subscribe({ projectId }), {
          capacity: 16,
        });
        expect((yield* takeSnapshot(events, "initial")).observedAt).toBeNull();
        expect(yield* Queue.take(events)).toEqual({ kind: "synchronized" });
        h.setAgents(
          [-1, 0, 1_000].map((offset) => ({
            ...agent,
            agentRef: `startup-${offset}`,
            work: {
              ...agent.work!,
              outcome: `Native completion ${offset}`,
              latestCompletion: {
                interactionId: `startup-${offset}`,
                status: "completed" as const,
                timestampMs: startedAtMs + offset,
              },
            },
          })),
        );
        yield* TestClock.adjust("10 seconds");
        yield* h.service.runOnce;
        const first = yield* takeSnapshot(events, "observation");
        expect(first.items.map((item) => item.agentRef).sort()).toEqual([
          "startup-0",
          "startup-1000",
        ]);
        expect(first.items.every((item) => item.unread)).toBe(true);
        const marked = first.items.find((item) => item.agentRef === "startup-0")!;
        yield* h.service.markRead({ projectId, itemIds: [marked.id] });
        yield* TestClock.adjust("10 seconds");
        const restarted = yield* h.reopen();
        yield* restarted.runOnce;
        expect((yield* restarted.list({ projectId })).items.map((item) => item.agentRef)).toEqual([
          "startup-1000",
        ]);
        expect((yield* restarted.list({ projectId, itemId: marked.id })).items[0]?.unread).toBe(
          false,
        );
      }),
    ).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "streams only complete persisted passes and preserves exact read markers on reconnect",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const events = yield* Stream.toQueue(h.service.subscribe({ projectId }), {
            capacity: 16,
          });
          expect(yield* Queue.take(events)).toEqual({
            kind: "snapshot",
            source: "initial",
            snapshot: { items: [], observedAt: null },
          });
          expect(yield* Queue.take(events)).toEqual({ kind: "synchronized" });
          yield* h.service.runOnce;
          const baseline = yield* takeSnapshot(events, "observation");
          expect(baseline.observedAt).not.toBeNull();
          expect(baseline.items).toEqual([]);
          h.setAgents([
            {
              ...agent,
              work: {
                ...agent.work!,
                latestCompletion: {
                  interactionId: "review",
                  status: "completed",
                  timestampMs: Date.parse(time),
                },
              },
            },
          ]);
          h.setQuestions([question]);
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          h.setBeforeQuestions(
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          );
          const pass = yield* h.service.runOnce.pipe(Effect.forkScoped({ startImmediately: true }));
          yield* Deferred.await(entered);
          let readFinished = false;
          const reading = yield* h.service.list({ projectId }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                readFinished = true;
              }),
            ),
            Effect.forkScoped({ startImmediately: true }),
          );
          expect(readFinished).toBe(false);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(pass);
          const observed = yield* takeSnapshot(events, "observation");
          expect(observed.items.map((item) => item.kind).sort()).toEqual([
            "completion",
            "question",
          ]);
          expect(observed).toEqual(yield* Fiber.join(reading));
          const reopened = yield* h.reopen();
          expect(observed).toEqual(yield* reopened.list({ projectId }));
          const completion = observed.items.find((item) => item.kind === "completion")!;
          expect(completion.unread).toBe(true);
          yield* h.service.markRead({ projectId, itemIds: [completion.id] });
          const marked = yield* takeSnapshot(events, "mutation");
          expect(marked.items.map((item) => item.kind)).toEqual(["question"]);
          const reconnected = yield* Stream.toQueue(
            reopened.subscribe({ projectId, itemId: completion.id }),
            { capacity: 2 },
          );
          const persisted = yield* takeSnapshot(reconnected, "initial");
          expect(persisted.items).toHaveLength(1);
          expect(persisted.items[0]).toMatchObject({ id: completion.id, unread: false });
          expect(yield* Queue.take(reconnected)).toEqual({ kind: "synchronized" });
        }),
      ).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "isolates project subscription read markers and emits native observation failures",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          h.setQuestions([question]);
          yield* h.service.runOnce;
          const events = yield* Stream.toQueue(h.service.subscribe({ projectId }), {
            capacity: 16,
          });
          const initial = yield* takeSnapshot(events, "initial");
          yield* Queue.take(events);
          const item = initial.items[0]!;
          yield* h.service.markRead({
            projectId: ProjectId.make("other-project"),
            itemIds: [item.id],
          });
          h.setFailure(true);
          yield* h.service.runOnce;
          const next = yield* Queue.take(events);
          expect(next.kind).toBe("snapshot");
          if (next.kind !== "snapshot") throw new Error("Missing observation snapshot");
          expect(next.source).toBe("observation");
          expect(next.snapshot.items.map((entry) => entry.kind).sort()).toEqual([
            "query-error",
            "question",
          ]);
          expect(next.snapshot.items.find((entry) => entry.id === item.id)?.unread).toBe(true);
          expect(next.snapshot).toEqual(yield* h.service.list({ projectId }));
        }),
      ).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("propagates typed persisted snapshot read failures to subscribers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        h.setQuestions([question]);
        yield* h.service.runOnce;
        const events = yield* Stream.toQueue(h.service.subscribe({ projectId }), { capacity: 2 });
        yield* Queue.take(events);
        yield* Queue.take(events);
        // Invalid persisted rows must end the stream with the same typed error as a unary read.
        yield* h.sql`UPDATE meerkat_attention SET item_json='{}' WHERE kind='question'`;
        h.setFailure(true);
        yield* h.service.runOnce;
        const liveFailure = yield* Queue.take(events).pipe(Effect.flip);
        expect(liveFailure._tag).toBe("MeerkatAttentionError");
        const initialFailure = yield* h.service
          .subscribe({ projectId })
          .pipe(Stream.runHead, Effect.flip);
        expect(initialFailure._tag).toBe("MeerkatAttentionError");
      }),
    ).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "keeps offscreen approvals actionable until native resolution, preserving failures and exact owners",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const approval: MeerkatApproval = {
          record: {
            approval_id: "exact-tool",
            status: "pending",
            owner: { owner_type: "session", session_id: "session" },
            proposed_action: {
              summary: "Run shell",
              body: { toolName: "shell", arguments: { command: "git status" } },
            },
            created_at: time,
          },
          actionable: true,
        };
        h.setApprovals([approval]);
        yield* h.service.runOnce;
        const reloaded = yield* h.reopen();
        const pending = (yield* reloaded.list({ projectId })).items[0]!;
        expect(pending.kind).toBe("approval");
        expect(pending.sessionId).toBe("session");
        yield* reloaded.markRead({ projectId, itemIds: [pending.id] });
        expect((yield* reloaded.list({ projectId })).items[0]).toMatchObject({
          active: true,
          unread: false,
        });
        h.setApprovalFailure(true);
        yield* reloaded.runOnce;
        expect((yield* reloaded.list({ projectId })).items.map((row) => row.kind).sort()).toEqual([
          "approval",
          "query-error",
        ]);
        h.setApprovalFailure(false);
        h.setApprovals([
          {
            ...approval,
            record: {
              ...approval.record,
              owner: { owner_type: "session", session_id: "replacement" },
            },
          },
        ]);
        yield* reloaded.runOnce;
        expect(
          (yield* reloaded.list({ projectId })).items.find((row) => row.kind === "query-error")
            ?.detail,
        ).toContain("different session");
        h.setApprovals([
          { ...approval, actionable: false, record: { ...approval.record, status: "denied" } },
        ]);
        yield* reloaded.runOnce;
        expect((yield* reloaded.list({ projectId })).items).toEqual([]);
        expect((yield* reloaded.list({ projectId, itemId: pending.id })).items[0]?.active).toBe(
          false,
        );
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect(
    "observes offscreen worker questions and completions, persists across reload, and records exact read markers",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.service.runOnce;
        h.setQuestions([question]);
        h.setAgents([
          {
            ...agent,
            work: {
              ...agent.work!,
              latestCompletion: {
                interactionId: "review",
                status: "completed",
                timestampMs: Date.parse(time),
              },
            },
          },
        ]);
        yield* h.service.runOnce;
        const reloaded = yield* h.reopen();
        const items = (yield* reloaded.list({ projectId })).items;
        expect(items.map((i) => i.kind).sort()).toEqual(["completion", "question"]);
        expect(
          items.every(
            (i) =>
              i.unread &&
              i.agentRef === agent.agentRef &&
              i.sessionId === "session" &&
              i.threadId === threadId,
          ),
        ).toBe(true);
        expect(h.scopes).toContainEqual({ projectId, instanceId, agentRef: agent.agentRef });
        const completion = items.find((i) => i.kind === "completion")!;
        yield* reloaded.markRead({ projectId, itemIds: [completion.id] });
        yield* reloaded.runOnce;
        expect((yield* reloaded.list({ projectId })).items.map((i) => i.kind)).toEqual([
          "question",
        ]);
        expect((yield* reloaded.list({ projectId, itemId: completion.id })).items[0]?.unread).toBe(
          false,
        );
        const pending = items.find((i) => i.kind === "question")!;
        yield* reloaded.markRead({ projectId, itemIds: [pending.id] });
        expect((yield* reloaded.list({ projectId })).items[0]?.active).toBe(true);
        h.setQuestions([]);
        yield* reloaded.runOnce;
        expect((yield* reloaded.list({ projectId })).items).toEqual([]);
        expect((yield* reloaded.list({ projectId, itemId: pending.id })).items[0]?.active).toBe(
          false,
        );
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "a failed question query preserves pending attention and is distinct from no requests",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        h.setQuestions([question]);
        yield* h.service.runOnce;
        h.setFailure(true);
        yield* h.service.runOnce;
        expect((yield* h.service.list({ projectId })).items.map((i) => i.kind).sort()).toEqual([
          "query-error",
          "question",
        ]);
        h.setFailure(false);
        h.setQuestions([]);
        yield* h.service.runOnce;
        expect((yield* h.service.list({ projectId })).items).toEqual([]);
        h.setTeamFailure(true);
        yield* h.service.runOnce;
        expect((yield* h.service.list({ projectId })).items[0]?.detail).toContain("Disconnected");
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "does not retarget a question after session replacement or mark historical completions unread on first startup",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(time));
        const h = yield* harness();
        h.setAgents([
          {
            ...agent,
            work: {
              ...agent.work!,
              latestCompletion: { interactionId: "historic", status: "completed", timestampMs: 1 },
            },
          },
        ]);
        h.setQuestions([question]);
        yield* h.service.runOnce;
        const original = (yield* h.service.list({ projectId })).items.find(
          (i) => i.kind === "question",
        )!;
        expect(
          (yield* h.service.list({ projectId })).items.some((i) => i.kind === "completion"),
        ).toBe(false);
        h.setAgents([
          { ...agent, availability: "retired" },
          {
            ...agent,
            agentRef: "replacement-ref",
            record: { ...agent.record, session_id: "replacement" },
          },
        ]);
        yield* h.service.runOnce;
        const current = yield* h.service.list({ projectId });
        expect(current.items.map((i) => i.kind)).toEqual(["query-error"]);
        const saved = (yield* h.service.list({ projectId, itemId: original.id })).items[0]!;
        expect(saved.sessionId).toBe("session");
        expect(saved.active).toBe(false);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("does not turn a runtime disconnect into a successful empty question read", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setQuestions([question]);
      yield* h.service.runOnce;
      h.setAgents([{ ...agent, availability: "unloaded" }]);
      yield* h.service.runOnce;
      const items = (yield* h.service.list({ projectId })).items;
      expect(items.map((item) => item.kind).sort()).toEqual(["query-error", "question"]);
      expect(items.find((item) => item.kind === "query-error")?.detail).toContain(
        "could not be verified",
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("projects queue failures and clears only when the durable queue is resolved", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.sql`INSERT INTO meerkat_agent_queues (target_key,project_id,instance_id,durable_id,binding_json) VALUES ('queue',${projectId},${instanceId},'durable','{}')`;
      yield* h.sql`INSERT INTO meerkat_observed_agents (agent_ref,durable_id,project_id,instance_id,provider_state_root,project_path,thread_id,agent_json,last_seen_at) VALUES (${agent.agentRef},'durable',${projectId},${instanceId},'/state','/project',${threadId},${encodeAgent(agent)},${time})`;
      yield* h.sql`INSERT INTO meerkat_agent_queue_items (item_id,target_key,request_id,enqueue_fingerprint,payload_json,position,status,error,created_at,updated_at) VALUES ('item','queue','request','fingerprint','{}',0,'uncertain','Lost delivery receipt',${time},${time})`;
      yield* h.sql`UPDATE meerkat_agent_queue_items SET dispatch_agent_ref=${agent.agentRef}, dispatch_session_id='session' WHERE item_id='item'`;
      const replacement = {
        ...agent,
        agentRef: "replacement",
        record: { ...agent.record, session_id: "replacement" },
      };
      yield* h.sql`INSERT INTO meerkat_observed_agents (agent_ref,durable_id,project_id,instance_id,provider_state_root,project_path,thread_id,agent_json,last_seen_at) VALUES ('replacement','durable',${projectId},${instanceId},'/state','/project',${threadId},${encodeAgent(replacement)},'2026-09-29T00:00:00.000Z')`;
      yield* h.service.runOnce;
      const item = (yield* h.service.list({ projectId })).items[0]!;
      expect(item.kind).toBe("delivery-error");
      expect(item.agentRef).toBe(agent.agentRef);
      expect(item.sessionId).toBe("session");
      expect(item.threadId).toBe(threadId);
      yield* h.service.markRead({ projectId, itemIds: [item.id] });
      expect((yield* h.service.list({ projectId })).items[0]?.active).toBe(true);
      yield* h.sql`UPDATE meerkat_agent_queue_items SET status='completed' WHERE item_id='item'`;
      yield* h.service.runOnce;
      expect((yield* h.service.list({ projectId })).items).toEqual([]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("cannot read or clear another project's attention, and excludes deleted owners", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setQuestions([question]);
      yield* h.service.runOnce;
      const item = (yield* h.service.list({ projectId })).items[0]!;
      expect(
        (yield* h.service.list({ projectId: ProjectId.make("foreign"), itemId: item.id })).items,
      ).toEqual([]);
      yield* h.service.markRead({ projectId: ProjectId.make("foreign"), itemIds: [item.id] });
      expect((yield* h.service.list({ projectId })).items[0]?.unread).toBe(true);
      yield* h.sql`UPDATE projection_threads SET deleted_at=${time} WHERE thread_id=${threadId}`;
      expect((yield* h.service.list({ projectId })).items).toEqual([]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});

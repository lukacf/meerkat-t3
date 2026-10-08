import { describe, expect, it } from "@effect/vitest";
import {
  ComposerContextId,
  ProjectId,
  ProviderInstanceId,
  MeerkatAgentQueueError,
  type MeerkatAgentControlReceipt,
  type MeerkatAgentSendInput,
  type MeerkatAgentQueueStreamItem,
  type MeerkatAgentWork,
  type MeerkatTeamAgent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  makeMeerkatAgentQueue,
  makeMeerkatAgentQueueService,
  MeerkatQueueSendRejected,
  type MeerkatAgentQueueBinding,
  type MeerkatAgentQueueObservation,
} from "./MeerkatAgentQueueService.ts";

import { makeMeerkatObservedAgents } from "./MeerkatObservedAgents.ts";
import { extractMeerkatSkillSelections } from "@t3tools/shared/meerkatSkills";
import type { MeerkatTeamReader } from "./MeerkatTeamReader.ts";
import {
  ProfileRestoreReview,
  RESTORE_REVIEW_MESSAGE,
  type RestoreReviewService,
} from "../../restoreReview.ts";

const restoreHold: RestoreReviewService = {
  held: true,
  status: () => ({
    status: "required",
    restoreId: "restore",
    restoredAt: null,
    backupCreatedAt: null,
    message: RESTORE_REVIEW_MESSAGE,
  }),
  consent: async () => {
    throw new Error("Unused consent");
  },
};

const projectId = ProjectId.make("queue-project");
const instanceId = ProviderInstanceId.make("queue-provider");
const target = { projectId, instanceId, agentRef: "agent-session-one" };
const binding: MeerkatAgentQueueBinding = {
  projectId,
  instanceId,
  durableId: "durable-agent",
  providerStateRoot: "/provider",
  projectPath: "/project",
  stateRoot: "/project-state",
  mobId: "domain-agent",
  identity: "specialist",
};
const harness = Effect.fnUntraced(function* () {
  const sends: MeerkatAgentSendInput[] = [];
  const accepted = new Map<string, MeerkatAgentControlReceipt>();
  const receiptReads: MeerkatAgentSendInput[] = [];
  let status: MeerkatAgentQueueObservation["work"]["status"] = "idle";
  let questions = 0;
  let stale = false;
  let unavailable = false;
  let reject = false;
  let uncertain = false;
  let receiptLost = false;
  let sessionId = "session-one";
  let currentRef = target.agentRef;
  const completed: string[] = [];
  const deps = {
    resolve: (input: typeof target) =>
      Effect.succeed({ ...binding, projectId: input.projectId, instanceId: input.instanceId }),
    observe: () =>
      Effect.gen(function* () {
        if (unavailable)
          return yield* new MeerkatAgentQueueError({ projectId, message: "Offline" });
        const observedAt = stale
          ? "2000-01-01T00:00:00.000Z"
          : (yield* DateTime.nowAsDate).toISOString();
        return {
          agentRef: currentRef,
          sessionId,
          work: { status, observedAt },
          pendingQuestions: questions,
          completedInteractionIds: completed,
        };
      }),
    send: (input: MeerkatAgentSendInput) =>
      Effect.gen(function* () {
        if (reject)
          return yield* new MeerkatQueueSendRejected({ message: "Model no longer available" });
        sends.push(input);
        if (receiptLost)
          return yield* new MeerkatAgentQueueError({
            projectId,
            message: "Receipt persistence failed",
          });
        const receipt: MeerkatAgentControlReceipt = uncertain
          ? {
              status: "uncertain",
              requestId: input.requestId,
              receipt: null,
              message: "Transport disconnected",
            }
          : {
              status: "accepted",
              requestId: input.requestId,
              receipt: { receipt: { interaction_id: `interaction-${sends.length}` } },
              message: null,
            };
        accepted.set(input.requestId, receipt);
        return receipt;
      }),
    reconcile: (_binding: MeerkatAgentQueueBinding, input: MeerkatAgentSendInput) =>
      Effect.sync(() => {
        receiptReads.push(input);
        return accepted.get(input.requestId);
      }),
  };
  const service = yield* makeMeerkatAgentQueue(deps);
  const add = (requestId: string, text = requestId) =>
    service.enqueue({ ...target, requestId, payload: { text } });
  return {
    service,
    deps,
    add,
    sends,
    completed,
    accepted,
    receiptReads,
    set: (input: {
      status?: typeof status;
      questions?: number;
      stale?: boolean;
      unavailable?: boolean;
      reject?: boolean;
      uncertain?: boolean;
      receiptLost?: boolean;
      sessionId?: string;
      agentRef?: string;
    }) => {
      status = input.status ?? status;
      questions = input.questions ?? questions;
      stale = input.stale ?? stale;
      unavailable = input.unavailable ?? unavailable;
      reject = input.reject ?? reject;
      uncertain = input.uncertain ?? uncertain;
      receiptLost = input.receiptLost ?? receiptLost;
      sessionId = input.sessionId ?? sessionId;
      currentRef = input.agentRef ?? currentRef;
    },
  };
});
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(SqlitePersistenceMemory));
const takeSnapshot = <E>(
  events: Queue.Dequeue<MeerkatAgentQueueStreamItem, E>,
  matches: (event: Extract<MeerkatAgentQueueStreamItem, { kind: "snapshot" }>) => boolean,
) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(events);
      if (event.kind === "snapshot" && matches(event)) return event;
    }
  });

describe("server-owned native agent queue", () => {
  it.effect("holds restored queued work before dispatch claims while allowing cancellation", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness();
        const original = yield* h.add("saved", "Preserve this message");
        yield* Effect.gen(function* () {
          yield* h.service.runOnce;
          const held = yield* h.service.list(target);
          expect(h.sends).toHaveLength(0);
          expect(held.items[0]).toEqual(original.items[0]);
          expect(held.waitingReason).toBe(RESTORE_REVIEW_MESSAGE);
          const sql = yield* SqlClient.SqlClient;
          const rows =
            yield* sql`SELECT status,dispatch_session_id,dispatch_agent_ref FROM meerkat_agent_queue_items`;
          expect(rows).toEqual([
            { status: "queued", dispatch_session_id: null, dispatch_agent_ref: null },
          ]);
          const blocked = yield* h.add("new").pipe(Effect.flip);
          expect(blocked.message).toBe(RESTORE_REVIEW_MESSAGE);
          const after = yield* h.service.list(target);
          const cancelled = yield* h.service.cancel({
            ...target,
            itemId: after.items[0]!.id,
            expectedRevision: after.revision,
          });
          expect(cancelled.items).toHaveLength(0);
        }).pipe(Effect.provideService(ProfileRestoreReview, restoreHold));
      }),
    ),
  );

  it.effect("reconciles restored uncertain receipts without sending the next queued message", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.add("earlier");
        yield* h.add("next");
        h.set({ uncertain: true });
        yield* h.service.runOnce;
        const sent = h.sends[0]!;
        h.accepted.set(sent.requestId, {
          status: "accepted",
          requestId: sent.requestId,
          receipt: { receipt: { interaction_id: "interaction-1" } },
          message: null,
        });
        yield* Effect.gen(function* () {
          const before = yield* h.service.list(target);
          const reconciled = yield* h.service.retry({
            ...target,
            itemId: before.items[0]!.id,
            expectedRevision: before.revision,
          });
          expect(reconciled.items[0]?.status).toBe("accepted");
          expect(h.receiptReads[0]).toEqual(sent);
          h.completed.push("interaction-1");
          yield* h.service.runOnce;
          yield* h.service.runOnce;
          expect(h.sends).toHaveLength(1);
          expect((yield* h.service.list(target)).items[0]?.requestId).toBe("next");
        }).pipe(Effect.provideService(ProfileRestoreReview, restoreHold));
      }),
    ),
  );

  it.effect("keeps a rejected saved send failed when retry would admit new work", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.add("failed");
        h.set({ reject: true });
        yield* h.service.runOnce;
        const before = yield* h.service.list(target);
        expect(before.items[0]?.status).toBe("failed");
        const blocked = yield* h.service
          .retry({ ...target, itemId: before.items[0]!.id, expectedRevision: before.revision })
          .pipe(Effect.provideService(ProfileRestoreReview, restoreHold), Effect.flip);
        expect(blocked.message).toBe(RESTORE_REVIEW_MESSAGE);
        expect((yield* h.service.list(target)).items).toEqual(before.items);
        expect(h.sends).toHaveLength(0);
      }),
    ),
  );

  it.effect("native initialization cannot settle a console send with the same run ID", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const observedAt = (yield* DateTime.nowAsDate).toISOString();
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
        VALUES (${projectId},'Project','/project','[]',${observedAt},${observedAt})`;
        const agent: MeerkatTeamAgent = {
          agentRef: target.agentRef,
          durableId: binding.durableId,
          mobId: binding.mobId,
          mobLabel: "Specialist",
          mobKind: "domain",
          scopeLabel: "Project",
          availability: "live",
          record: {
            identity: binding.identity,
            display_name: "Specialist",
            runtime_key: "default",
            runtime_member_id: "worker",
            session_id: "session-one",
            addressable: true,
            visibility: "addressable",
            health: "ready",
            labels: {},
          },
        };
        const observed = yield* makeMeerkatObservedAgents;
        yield* observed.save({
          projectId,
          instanceId,
          providerStateRoot: binding.providerStateRoot,
          projectPath: binding.projectPath,
          stateRoot: binding.stateRoot!,
          agent,
          observedAt,
        });
        let latestCompletion: MeerkatAgentWork["latestCompletion"] = {
          kind: "runtime_input",
          sessionId: "session-one",
          inputId: "initial-input",
          runId: "same-id",
          status: "completed",
          timestampMs: 100,
        };
        const reader: MeerkatTeamReader = {
          stateRoot: binding.providerStateRoot,
          snapshot: () => Effect.die("Unused snapshot"),
          activity: () => Effect.succeed({ frames: [] }),
          work: () => Effect.succeed({ status: "idle", latestCompletion }),
          send: () => Effect.die("Unused direct send"),
          stop: () => Effect.die("Unused direct stop"),
          busy: () => Effect.succeed(false),
        };
        let sends = 0;
        const accepted = new Map<string, MeerkatAgentControlReceipt>();
        const service = yield* makeMeerkatAgentQueueService(
          {
            projectTeam: () => Effect.die("Already observed"),
            queueTarget: () =>
              Effect.succeed({
                agent,
                target: {
                  reader,
                  projectPath: binding.projectPath,
                  stateRoot: binding.stateRoot!,
                  mobKind: "domain",
                  mobId: binding.mobId,
                  record: agent.record,
                  ambiguous: false,
                },
              }),
            agentSend: (input) =>
              Effect.sync(() => {
                sends += 1;
                const receipt: MeerkatAgentControlReceipt = {
                  status: "accepted" as const,
                  requestId: input.requestId,
                  receipt: { receipt: { interaction_id: "same-id" } },
                  message: null,
                };
                accepted.set(input.requestId, receipt);
                return receipt;
              }),
            agentDeliveryReconcile: (input) => Effect.sync(() => accepted.get(input.requestId)),
          },
          { questions: () => Effect.succeed({ requests: [] }) },
        );
        yield* service.enqueue({
          ...target,
          requestId: "queued",
          payload: { text: "Console work" },
        });
        yield* service.runOnce;
        expect((yield* service.list(target)).items[0]?.status).toBe("accepted");
        yield* service.runOnce;
        expect((yield* service.list(target)).items[0]?.status).toBe("accepted");
        expect(sends).toBe(1);
        latestCompletion = { interactionId: "same-id", status: "completed", timestampMs: 101 };
        yield* service.runOnce;
        expect((yield* service.list(target)).items).toEqual([]);
      }),
    ),
  );

  it.effect(
    "streams committed queue state and worker observations, reconstructing after disconnect",
    () =>
      run(
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* harness();
            yield* Effect.scoped(
              Effect.gen(function* () {
                const events = yield* Stream.toQueue(h.service.subscribe(target), { capacity: 16 });
                expect(yield* Queue.take(events)).toEqual({
                  kind: "snapshot",
                  source: "initial",
                  snapshot: {
                    revision: 0,
                    durableId: binding.durableId,
                    items: [],
                    waitingReason: null,
                  },
                });
                expect(yield* Queue.take(events)).toEqual({ kind: "synchronized" });
                const queued = yield* h.add("once");
                expect(
                  (yield* takeSnapshot(events, (event) => event.source === "mutation")).snapshot,
                ).toEqual(queued);
                yield* h.service.runOnce;
                const observed = yield* takeSnapshot(
                  events,
                  (event) => event.source === "observation",
                );
                expect(observed.snapshot.items[0]).toMatchObject({
                  status: "accepted",
                  receipt: {
                    status: "accepted",
                    receipt: { receipt: { interaction_id: "interaction-1" } },
                  },
                });
                const independentReader = yield* makeMeerkatAgentQueue(h.deps);
                expect(observed.snapshot).toEqual(yield* independentReader.list(target));
              }),
            );
            // The worker remains server-owned when the last subscriber disconnects.
            h.completed.push("interaction-1");
            yield* h.service.runOnce;
            const reopened = yield* makeMeerkatAgentQueue(h.deps);
            const events = yield* Stream.toQueue(reopened.subscribe(target), { capacity: 16 });
            expect(yield* Queue.take(events)).toEqual({
              kind: "snapshot",
              source: "initial",
              snapshot: yield* reopened.list(target),
            });
            expect(yield* Queue.take(events)).toEqual({ kind: "synchronized" });
            expect((yield* reopened.list(target)).items).toEqual([]);
            yield* reopened.enqueue({ ...target, requestId: "once", payload: { text: "once" } });
            yield* reopened.runOnce;
            const observed = yield* takeSnapshot(events, (event) => event.source === "observation");
            expect(observed.snapshot.items).toEqual([]);
            expect(h.sends).toHaveLength(1);
          }),
        ),
      ),
  );

  it.effect("keeps queue subscription mutations isolated by project and provider", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const events = yield* Stream.toQueue(h.service.subscribe(target), { capacity: 16 });
          yield* Queue.take(events);
          yield* Queue.take(events);
          yield* h.service.enqueue({
            ...target,
            projectId: ProjectId.make("other-project"),
            requestId: "foreign",
            payload: { text: "foreign" },
          });
          yield* h.service.enqueue({
            ...target,
            instanceId: ProviderInstanceId.make("other-provider"),
            requestId: "foreign",
            payload: { text: "foreign" },
          });
          const own = yield* h.add("own");
          const next = yield* Queue.take(events);
          expect(next).toEqual({ kind: "snapshot", source: "mutation", snapshot: own });
          expect(own.items.map((item) => item.payload.text)).toEqual(["own"]);
        }),
      ),
    ),
  );

  it.effect("returns typed initial and subsequent subscription read failures", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const denied = yield* makeMeerkatAgentQueue({
            ...h.deps,
            resolve: () =>
              Effect.fail(new MeerkatAgentQueueError({ projectId, message: "Unknown target" })),
          });
          const firstFailure = yield* denied.subscribe(target).pipe(Stream.runHead, Effect.flip);
          expect(firstFailure.message).toBe("Unknown target");
          const events = yield* Stream.toQueue(h.service.subscribe(target), { capacity: 16 });
          yield* Queue.take(events);
          yield* Queue.take(events);
          const sql = yield* SqlClient.SqlClient;
          // A fresh worker pass forces a read of committed state, including corruption.
          yield* sql`UPDATE meerkat_agent_queues SET revision=-1`;
          yield* h.service.runOnce;
          const failure = yield* Queue.take(events).pipe(Effect.flip);
          expect(failure._tag).toBe("MeerkatAgentQueueError");
        }),
      ),
    ),
  );

  it.effect("finishes the exact original interaction from its durable receipt while unloaded", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.add("first");
        yield* h.add("second");
        yield* h.service.runOnce;
        h.set({ unavailable: true, sessionId: "replacement" });
        const requestId = h.sends[0]!.requestId;
        const completion = {
          id: "done",
          cursor: "c-2",
          dedupe_key: "done",
          timestamp_ms: 2,
          runtime_key: "default",
          identity: binding.identity,
          kind: "interaction_complete",
          status: "completed",
          frame_version: 1,
          payload: {},
          source: { kind: "console_event" },
          session_id: "session-one",
          interaction_id: "interaction-1",
        };
        h.accepted.set(requestId, {
          status: "accepted",
          requestId,
          message: null,
          receipt: {
            receipt: {
              interaction_id: "interaction-1",
              completion: { ...completion, session_id: "wrong" },
            },
          },
        });
        yield* h.service.runOnce;
        expect((yield* h.service.list(target)).items[0]?.status).toBe("accepted");
        h.accepted.set(requestId, {
          status: "accepted",
          requestId,
          message: null,
          receipt: { receipt: { interaction_id: "interaction-1", completion } },
        });
        yield* h.service.runOnce;
        expect((yield* h.service.list(target)).items.map((item) => item.payload.text)).toEqual([
          "second",
        ]);
        yield* h.service.runOnce;
        expect(h.sends).toHaveLength(1);
        h.set({ unavailable: false, sessionId: "replacement", agentRef: "replacement-ref" });
        yield* h.service.runOnce;
        expect(h.sends).toHaveLength(2);
        expect(h.sends[1]?.agentRef).toBe("replacement-ref");
      }),
    ),
  );

  it.effect(
    "completed payloads leave the active projection while duplicate enqueue remains deduplicated",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* harness();
          yield* h.add("once");
          yield* h.service.runOnce;
          h.completed.push("interaction-1");
          yield* h.service.runOnce;
          expect((yield* h.service.list(target)).items).toEqual([]);
          expect((yield* h.add("once")).items).toEqual([]);
          yield* h.service.runOnce;
          expect(h.sends).toHaveLength(1);
        }),
      ),
  );

  it.effect("persists typed context, model and image snapshots through edits and restart", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness();
        const payload = {
          text: "Explain [tests](t3-context://v1/terminal/test-output) using [review](meerkat-skill://b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64/review) and [review](meerkat-skill://4fa3e1a2-5b6c-47d8-9012-3456789abcde/review)",
          images: [
            {
              type: "image" as const,
              source: "blob" as const,
              media_type: "image/png" as const,
              blob_id: `sha256:${"a".repeat(64)}`,
            },
          ],
          modelSelection: { instanceId, model: "anthropic:claude-haiku-4-5" },
          context: {
            version: 1 as const,
            records: [
              {
                version: 1 as const,
                kind: "terminal" as const,
                contextId: ComposerContextId.make("test-output"),
                label: "tests",
                terminalId: "shell-a",
                terminalLabel: "tests",
                lineStart: 1,
                lineEnd: 2,
                text: "FAIL\nexpected 42",
              },
            ],
          },
        };
        const queue = yield* h.service.enqueue({ ...target, requestId: "context", payload });
        yield* h.service.edit({
          ...target,
          itemId: queue.items[0]!.id,
          expectedRevision: queue.revision,
          payload: { ...payload, text: `First check. ${payload.text}` },
        });
        payload.context.records[0]!.text = "mutated later";
        const restarted = yield* makeMeerkatAgentQueue(h.deps);
        yield* restarted.runOnce;
        expect(h.sends[0]?.context?.records[0]).toMatchObject({ text: "FAIL\nexpected 42" });
        expect(h.sends[0]?.images).toEqual(payload.images);
        expect(h.sends[0]?.modelSelection).toEqual(payload.modelSelection);
        expect(h.sends[0]?.text).toContain("First check.");
        expect(extractMeerkatSkillSelections(h.sends[0]!.text).skillReferences).toEqual([
          { source_uuid: "b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64", skill_name: "review" },
          { source_uuid: "4fa3e1a2-5b6c-47d8-9012-3456789abcde", skill_name: "review" },
        ]);
      }),
    ),
  );

  it.effect(
    "deduplicates two clients, preserves edits and rejects conflicting enqueue payloads",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* harness();
          const second = yield* makeMeerkatAgentQueue(h.deps);
          const first = yield* h.add("same", "original");
          yield* second.enqueue({ ...target, requestId: "same", payload: { text: "original" } });
          const edited = yield* h.service.edit({
            ...target,
            itemId: first.items[0]!.id,
            expectedRevision: first.revision,
            payload: { text: "edited" },
          });
          const replay = yield* second.enqueue({
            ...target,
            requestId: "same",
            payload: { text: "original" },
          });
          expect(replay.items).toHaveLength(1);
          expect(replay.items[0]?.payload.text).toBe("edited");
          expect(replay.revision).toBe(edited.revision);
          expect(
            (yield* second
              .enqueue({ ...target, requestId: "same", payload: { text: "different" } })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(
            (yield* second
              .cancel({ ...target, itemId: first.items[0]!.id, expectedRevision: first.revision })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }),
      ),
  );
  it.effect("reorders, edits and cancels before dispatch and runs without a mounted client", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.add("one");
        yield* h.add("two");
        let queue = yield* h.add("three");
        const three = queue.items[2]!.id;
        queue = yield* h.service.move({
          ...target,
          itemId: three,
          expectedRevision: queue.revision,
          direction: "up",
        });
        queue = yield* h.service.move({
          ...target,
          itemId: three,
          expectedRevision: queue.revision,
          direction: "up",
        });
        queue = yield* h.service.edit({
          ...target,
          itemId: three,
          expectedRevision: queue.revision,
          payload: { text: "third edited" },
        });
        yield* h.service.cancel({
          ...target,
          itemId: queue.items.find((item) => item.requestId === "one")!.id,
          expectedRevision: queue.revision,
        });
        const background = yield* makeMeerkatAgentQueue(h.deps);
        yield* background.runOnce;
        expect(h.sends.map((send) => send.text)).toEqual(["third edited"]);
        yield* background.runOnce;
        expect(h.sends).toHaveLength(1);
        h.completed.push("interaction-1");
        yield* background.runOnce;
        yield* background.runOnce;
        expect(h.sends.map((send) => send.text)).toEqual(["third edited", "two"]);
      }),
    ),
  );
  it.effect("requires current native idle and no unanswered question", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.add("one");
        for (const state of [
          { status: "running" as const },
          { status: "unknown" as const },
          { status: "idle" as const, stale: true },
          { stale: false, questions: 1 },
          { questions: 0, unavailable: true },
        ]) {
          h.set(state);
          yield* h.service.runOnce;
          expect(h.sends).toHaveLength(0);
        }
        h.set({ unavailable: false });
        yield* h.service.runOnce;
        expect(h.sends).toHaveLength(1);
      }),
    ),
  );
  it.effect(
    "concurrent workers claim only one send and restart waits for the exact accepted completion",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* harness();
          yield* h.add("one");
          yield* h.add("two");
          const second = yield* makeMeerkatAgentQueue(h.deps);
          yield* Effect.all([h.service.runOnce, second.runOnce], { concurrency: "unbounded" });
          expect(h.sends).toHaveLength(1);
          const restarted = yield* makeMeerkatAgentQueue(h.deps);
          yield* restarted.recoverInterrupted;
          h.completed.push("some-other-interaction");
          yield* restarted.runOnce;
          expect(h.sends).toHaveLength(1);
          h.completed.push("interaction-1");
          yield* restarted.runOnce;
          yield* restarted.runOnce;
          expect(h.sends).toHaveLength(2);
        }),
      ),
  );
  it.effect("does not mistake a new session's idle for completion of accepted previous work", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.add("one");
        yield* h.add("two");
        yield* h.service.runOnce;
        h.set({ sessionId: "session-two", agentRef: "agent-session-two" });
        h.completed.push("interaction-1");
        yield* h.service.runOnce;
        expect(h.sends).toHaveLength(1);
        expect(
          (yield* h.service.list({ ...target, agentRef: "agent-session-two" })).items[0]?.status,
        ).toBe("accepted");
      }),
    ),
  );
  it.effect("fences transport uncertainty and retry only reconciles a proven receipt", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.add("one");
        yield* h.add("two");
        h.set({ uncertain: true });
        yield* h.service.runOnce;
        let queue = yield* h.service.list(target);
        expect(queue.items[0]?.status).toBe("uncertain");
        queue = yield* h.service.retry({
          ...target,
          itemId: queue.items[0]!.id,
          expectedRevision: queue.revision,
        });
        yield* h.service.runOnce;
        expect(h.sends).toHaveLength(1);
        expect(queue.items[0]?.status).toBe("uncertain");
        h.accepted.set(h.sends[0]!.requestId, {
          status: "accepted",
          requestId: h.sends[0]!.requestId,
          receipt: { receipt: { interaction_id: "interaction-1" } },
          message: null,
        });
        yield* h.service.runOnce;
        h.completed.push("interaction-1");
        yield* h.service.runOnce;
        h.set({ uncertain: false });
        yield* h.service.runOnce;
        expect(h.sends).toHaveLength(2);
      }),
    ),
  );
  it.effect(
    "reconciles the original dispatch after replacement and keeps failed native receipts fenced",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* harness();
          yield* h.add("one", "original text");
          h.set({ uncertain: true });
          yield* h.service.runOnce;
          h.set({ sessionId: "replacement", agentRef: "replacement-ref" });
          h.accepted.set(h.sends[0]!.requestId, {
            requestId: h.sends[0]!.requestId,
            status: "accepted",
            receipt: { receipt: { interaction_id: "interaction-1", status: "delivery_failed" } },
            message: "Native delivery failed",
          });
          const restarted = yield* makeMeerkatAgentQueue(h.deps);
          yield* restarted.runOnce;
          expect(h.receiptReads[0]).toEqual(h.sends[0]);
          expect(h.receiptReads[0]?.agentRef).toBe(target.agentRef);
          const state = yield* restarted.list(target);
          expect(state.items[0]?.status).toBe("uncertain");
          expect(state.items[0]?.error).toBe("Native delivery failed");
          yield* restarted.runOnce;
          expect(h.sends).toHaveLength(1);
        }),
      ),
  );
  it.effect("a server crash during dispatch is uncertain and never automatically resends", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness();
        const queued = yield* h.add("one");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE meerkat_agent_queue_items SET status='dispatching' WHERE item_id=${queued.items[0]!.id}`;
        const restarted = yield* makeMeerkatAgentQueue(h.deps);
        yield* restarted.recoverInterrupted;
        yield* restarted.runOnce;
        expect(h.sends).toHaveLength(0);
        expect((yield* restarted.list(target)).items[0]?.status).toBe("uncertain");
      }),
    ),
  );
  it.effect(
    "allows explicit retry only after proof that validation rejected before native delivery",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* harness();
          yield* h.add("one");
          h.set({ reject: true });
          yield* h.service.runOnce;
          let queue = yield* h.service.list(target);
          expect(queue.items[0]?.status).toBe("failed");
          h.set({ reject: false });
          yield* h.service.runOnce;
          expect(h.sends).toHaveLength(0);
          queue = yield* h.service.list(target);
          queue = yield* h.service.retry({
            ...target,
            itemId: queue.items[0]!.id,
            expectedRevision: queue.revision,
          });
          expect(queue.items[0]?.status).toBe("queued");
          yield* h.service.runOnce;
          expect(h.sends).toHaveLength(1);
        }),
      ),
  );
  it.effect("fences thrown post-acceptance persistence failures", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.add("one");
        h.set({ receiptLost: true });
        yield* h.service.runOnce;
        expect((yield* h.service.list(target)).items[0]?.status).toBe("uncertain");
        yield* h.service.runOnce;
        expect(h.sends).toHaveLength(1);
      }),
    ),
  );
  it.effect(
    "isolates project and provider bindings and follows a durable agent across its ref change",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* harness();
          yield* h.add("one");
          expect(
            (yield* h.service.list({ ...target, projectId: ProjectId.make("other") })).items,
          ).toHaveLength(0);
          expect(
            (yield* h.service.list({ ...target, instanceId: ProviderInstanceId.make("other") }))
              .items,
          ).toHaveLength(0);
          h.set({ agentRef: "new-ref" });
          yield* h.service.runOnce;
          expect(h.sends[0]?.agentRef).toBe("new-ref");
        }),
      ),
  );
});

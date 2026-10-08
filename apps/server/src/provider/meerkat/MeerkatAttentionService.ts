import {
  MeerkatAttentionItem,
  MeerkatAttentionError,
  ProjectId,
  ProviderInstanceId,
  type MeerkatAttention,
  type MeerkatAttentionInput,
  type MeerkatAttentionReadInput,
  type MeerkatTeamError,
  type MeerkatControlError,
  type MeerkatProjectTeam,
  type MeerkatQuestionTarget,
  type MeerkatQuestions,
  type MeerkatApprovals,
  MeerkatTeamAgent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { agentFingerprint } from "./MeerkatProjectAgentStore.ts";
import { makeMeerkatStateSubscriptions } from "./MeerkatStateSubscriptions.ts";

interface AttentionSources {
  readonly projectTeam: (input: {
    projectId: ProjectId;
  }) => Effect.Effect<MeerkatProjectTeam, MeerkatTeamError>;
}
interface ControlSources {
  readonly approvals: (
    input: MeerkatQuestionTarget,
  ) => Effect.Effect<typeof MeerkatApprovals.Type, MeerkatControlError>;
  readonly questions: (
    input: MeerkatQuestionTarget,
  ) => Effect.Effect<typeof MeerkatQuestions.Type, MeerkatControlError>;
}
const Rows = Schema.Array(
  Schema.Struct({
    item_json: Schema.String,
    active: Schema.Number,
    read_at: Schema.NullOr(Schema.String),
    created_at: Schema.String,
    updated_at: Schema.String,
  }),
);
const decodeAgentJson = Schema.decodeEffect(Schema.fromJsonString(MeerkatTeamAgent));
const decodeRows = Schema.decodeUnknownEffect(Rows);
const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(MeerkatAttentionItem));
const encodeItem = Schema.encodeSync(Schema.fromJsonString(MeerkatAttentionItem));
const decodeProjects = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ project_id: ProjectId })),
);
const decodeTimes = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ observed_at: Schema.String })),
);
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const idFor = (...parts: string[]) => agentFingerprint(parts);
const systemInstance = ProviderInstanceId.make("meerkat-attention");

/** Product attention/read positions only. Questions, approvals and terminal work remain native facts. */
export const makeMeerkatAttentionService = Effect.fn("makeMeerkatAttentionService")(function* (
  team: AttentionSources,
  controls: ControlSources,
) {
  const sql = yield* SqlClient.SqlClient;
  const subscriptions = makeMeerkatStateSubscriptions();
  const observationLock = Semaphore.makeUnsafe(1);
  const startedAtMs = DateTime.toEpochMillis(yield* DateTime.now);
  const now = DateTime.nowAsDate.pipe(Effect.map((value) => value.toISOString()));
  const fail = (projectId: ProjectId, cause: unknown) =>
    new MeerkatAttentionError({ projectId, message: errorText(cause) });
  const upsert = Effect.fn("MeerkatAttention.upsert")(function* (
    item: MeerkatAttentionItem,
    baseline = false,
  ) {
    yield* sql`INSERT INTO meerkat_attention
      (id,project_id,instance_id,agent_ref,session_id,kind,item_json,active,read_at,created_at,updated_at)
      VALUES (${item.id},${item.projectId},${item.instanceId},${item.agentRef},${item.sessionId},${item.kind},${encodeItem(item)},1,
        ${baseline ? item.updatedAt : null},${item.createdAt},${item.updatedAt})
      ON CONFLICT(id) DO UPDATE SET item_json=excluded.item_json, active=1,
        read_at=CASE WHEN meerkat_attention.active=0 THEN NULL ELSE meerkat_attention.read_at END,
        updated_at=excluded.updated_at`;
  });
  const clear = (
    projectId: ProjectId,
    instanceId: ProviderInstanceId,
    kind: MeerkatAttentionItem["kind"],
    agentRef: string | null,
    keep: readonly string[] = [],
  ) =>
    sql`UPDATE meerkat_attention SET active=0 WHERE project_id=${projectId} AND instance_id=${instanceId}
      AND kind=${kind} AND agent_ref IS ${agentRef} AND id NOT IN ${sql.in(keep.length ? keep : [""])}`;
  const base = (
    projectId: ProjectId,
    instanceId: ProviderInstanceId,
    agent: MeerkatTeamAgent | null,
    timestamp: string,
  ) => ({
    projectId,
    instanceId,
    agentRef: agent?.agentRef ?? null,
    sessionId: agent?.record.session_id ?? null,
    projectAgentId: agent?.projectAgentId ?? null,
    threadId: agent?.threadId ?? null,
    coordinator: Boolean(
      agent?.threadId &&
      agent.mobKind === "thread" &&
      agent.record.runtime_member_id === "ingress" &&
      !agent.record.labels.source_mob_id,
    ),
    label: agent?.record.display_name ?? "Project agents",
    active: true,
    unread: true,
    question: null,
    completionStatus: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const queryError = (
    projectId: ProjectId,
    instanceId: ProviderInstanceId,
    agent: MeerkatTeamAgent | null,
    cause: unknown,
    timestamp: string,
  ) =>
    upsert({
      ...base(projectId, instanceId, agent, timestamp),
      id: idFor("query", projectId, instanceId, agent?.agentRef ?? "project"),
      kind: "query-error",
      title: "Could not check agent attention",
      detail: errorText(cause),
    });
  const observeProject = Effect.fn("MeerkatAttention.observeProject")(
    function* (projectId: ProjectId) {
      const timestamp = yield* now;
      const previous =
        yield* sql`SELECT observed_at FROM meerkat_attention_observations WHERE project_id=${projectId}`.pipe(
          Effect.flatMap(decodeTimes),
        );
      const observation = yield* team.projectTeam({ projectId }).pipe(Effect.result);
      if (observation._tag === "Failure") {
        yield* queryError(projectId, systemInstance, null, observation.failure, timestamp);
        return;
      }
      yield* clear(projectId, systemInstance, "query-error", null);
      for (const provider of observation.success.providers) {
        if (provider.errors.length)
          yield* queryError(
            projectId,
            provider.instanceId,
            null,
            provider.errors.join("\n"),
            timestamp,
          );
        else yield* clear(projectId, provider.instanceId, "query-error", null);
        yield* Effect.forEach(
          provider.agents,
          (agent) =>
            Effect.gen(function* () {
              const scope = base(projectId, provider.instanceId, agent, timestamp);
              const completion = agent.work?.latestCompletion;
              if (
                completion &&
                agent.record.session_id &&
                !scope.coordinator &&
                (!("kind" in completion) || completion.sessionId === agent.record.session_id)
              ) {
                yield* upsert(
                  {
                    ...scope,
                    id: idFor(
                      "completion",
                      projectId,
                      provider.instanceId,
                      agent.agentRef,
                      agent.record.session_id,
                      ...("kind" in completion
                        ? ["runtime_input", completion.inputId, completion.runId]
                        : [completion.interactionId]),
                    ),
                    kind: "completion",
                    title: completion.status === "completed" ? "Agent completed" : "Agent failed",
                    detail: agent.work?.outcome ?? "",
                    completionStatus: completion.status,
                    createdAt: DateTime.formatIso(DateTime.makeUnsafe(completion.timestampMs)),
                  },
                  // The first periodic pass can follow new work. Only native
                  // completions predating this service are startup history.
                  previous.length === 0 && completion.timestampMs < startedAtMs,
                );
              }
              if (agent.availability === "retired") {
                yield* clear(projectId, provider.instanceId, "question", agent.agentRef);
                yield* clear(projectId, provider.instanceId, "approval", agent.agentRef);
                yield* clear(projectId, provider.instanceId, "query-error", agent.agentRef);
                return;
              }
              // An unavailable runtime is not evidence that a previously observed question was answered.
              if (
                agent.availability !== "live" ||
                !agent.record.session_id ||
                !agent.record.addressable
              ) {
                const pending =
                  yield* sql`SELECT id FROM meerkat_attention WHERE project_id=${projectId}
            AND instance_id=${provider.instanceId} AND agent_ref=${agent.agentRef} AND kind IN ('question','approval') AND active=1 LIMIT 1`;
                if (pending.length)
                  yield* queryError(
                    projectId,
                    provider.instanceId,
                    agent,
                    "This agent is unavailable. Its previously observed input request could not be verified.",
                    timestamp,
                  );
                return;
              }
              const questions = yield* controls
                .questions({ projectId, instanceId: provider.instanceId, agentRef: agent.agentRef })
                .pipe(Effect.result);
              if (questions._tag === "Failure") {
                yield* queryError(
                  projectId,
                  provider.instanceId,
                  agent,
                  questions.failure,
                  timestamp,
                );
                return;
              }
              if (
                questions.success.requests.some(
                  (request) => request.sessionId !== agent.record.session_id,
                )
              ) {
                yield* queryError(
                  projectId,
                  provider.instanceId,
                  agent,
                  "The native question belongs to a different session. Refresh the conversation.",
                  timestamp,
                );
                return;
              }
              const approvals = yield* controls
                .approvals({ projectId, instanceId: provider.instanceId, agentRef: agent.agentRef })
                .pipe(Effect.result);
              if (approvals._tag === "Failure") {
                yield* queryError(
                  projectId,
                  provider.instanceId,
                  agent,
                  approvals.failure,
                  timestamp,
                );
                return;
              }
              if (
                approvals.success.approvals.some(
                  (row) => row.record.owner.session_id !== agent.record.session_id,
                )
              ) {
                yield* queryError(
                  projectId,
                  provider.instanceId,
                  agent,
                  "The native approval belongs to a different session. Refresh the conversation.",
                  timestamp,
                );
                return;
              }
              yield* clear(projectId, provider.instanceId, "query-error", agent.agentRef);
              const approvalIds: string[] = [];
              for (const row of approvals.success.approvals) {
                if (!row.actionable || row.record.status !== "pending") continue;
                const id = idFor(
                  "approval",
                  projectId,
                  provider.instanceId,
                  agent.agentRef,
                  row.record.owner.session_id,
                  row.record.approval_id,
                );
                approvalIds.push(id);
                yield* upsert({
                  ...scope,
                  id,
                  kind: "approval",
                  approvalId: row.record.approval_id,
                  title: row.record.proposed_action.summary,
                  detail: "A tool call is waiting for your approval.",
                  createdAt: row.record.created_at,
                });
              }
              yield* clear(projectId, provider.instanceId, "approval", agent.agentRef, approvalIds);
              const currentIds: string[] = [];
              for (const question of questions.success.requests) {
                const id = idFor(
                  "question",
                  projectId,
                  provider.instanceId,
                  agent.agentRef,
                  question.sessionId,
                  question.requestId,
                );
                currentIds.push(id);
                yield* upsert({
                  ...scope,
                  id,
                  kind: "question",
                  title: question.title,
                  detail: "Your answer is needed",
                  question,
                  createdAt: question.createdAt,
                });
              }
              yield* clear(projectId, provider.instanceId, "question", agent.agentRef, currentIds);
            }),
          { concurrency: 2 },
        );
      }
      // Queue delivery failures are canonical product receipts, not inferred from a missing response.
      const failures =
        yield* sql`SELECT i.item_id,i.status,i.error,i.updated_at,q.instance_id,o.agent_json
      FROM meerkat_agent_queue_items i JOIN meerkat_agent_queues q ON q.target_key=i.target_key
      LEFT JOIN meerkat_observed_agents o ON o.project_id=q.project_id AND o.instance_id=q.instance_id AND o.agent_ref = COALESCE(i.dispatch_agent_ref, (
        SELECT a.agent_ref FROM meerkat_observed_agents a WHERE a.project_id=q.project_id AND a.instance_id=q.instance_id AND a.durable_id=q.durable_id ORDER BY a.last_seen_at DESC LIMIT 1))
      WHERE q.project_id=${projectId} AND i.status IN ('failed','uncertain')`.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Array(
                Schema.Struct({
                  item_id: Schema.String,
                  status: Schema.String,
                  error: Schema.NullOr(Schema.String),
                  updated_at: Schema.String,
                  instance_id: ProviderInstanceId,
                  agent_json: Schema.NullOr(Schema.String),
                }),
              ),
            ),
          ),
        );
      const deliveryIds: string[] = [];
      for (const row of failures) {
        const agent = row.agent_json ? yield* decodeAgentJson(row.agent_json) : null;
        const id = idFor("delivery", projectId, row.instance_id, row.item_id);
        deliveryIds.push(id);
        yield* upsert({
          ...base(projectId, row.instance_id, agent, timestamp),
          id,
          kind: "delivery-error",
          title:
            row.status === "uncertain"
              ? "Delivery needs reconciliation"
              : "Message delivery failed",
          detail: row.error ?? "Open the conversation to review this queued message.",
          createdAt: row.updated_at,
        });
      }
      yield* sql`UPDATE meerkat_attention SET active=0 WHERE project_id=${projectId} AND kind='delivery-error' AND id NOT IN ${sql.in(deliveryIds.length ? deliveryIds : [""])}`;
      yield* sql`INSERT INTO meerkat_attention_observations(project_id,observed_at) VALUES (${projectId},${timestamp})
      ON CONFLICT(project_id) DO UPDATE SET observed_at=excluded.observed_at`;
    },
    observationLock.withPermits(1),
    (effect, projectId) =>
      effect.pipe(Effect.tap(() => subscriptions.publish(projectId, "observation"))),
  );
  const read = Effect.fn("MeerkatAttention.read")(function* (
    input: typeof MeerkatAttentionInput.Type,
  ): Effect.fn.Return<MeerkatAttention, MeerkatAttentionError> {
    const rows =
      yield* sql`SELECT a.item_json,a.active,a.read_at,a.created_at,a.updated_at FROM meerkat_attention a
      JOIN projection_projects p ON p.project_id=a.project_id AND p.deleted_at IS NULL
      WHERE a.project_id=${input.projectId} AND (${input.itemId ?? null} IS NOT NULL AND a.id=${input.itemId ?? null}
        OR ${input.itemId ?? null} IS NULL AND a.active=1 AND (a.kind != 'completion' OR a.read_at IS NULL))
        AND (json_extract(a.item_json,'$.threadId') IS NULL OR EXISTS (
          SELECT 1 FROM projection_threads t WHERE t.thread_id=json_extract(a.item_json,'$.threadId') AND t.project_id=a.project_id AND t.deleted_at IS NULL))
      ORDER BY a.created_at DESC LIMIT 500`.pipe(
        Effect.flatMap(decodeRows),
        Effect.mapError((cause) => fail(input.projectId, cause)),
      );
    const times =
      yield* sql`SELECT observed_at FROM meerkat_attention_observations WHERE project_id=${input.projectId}`.pipe(
        Effect.flatMap(decodeTimes),
        Effect.mapError((cause) => fail(input.projectId, cause)),
      );
    const items = yield* Effect.forEach(rows, (row) =>
      decodeItem(row.item_json).pipe(
        Effect.map((item) => ({
          ...item,
          active: row.active === 1,
          unread: row.read_at === null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      ),
    ).pipe(Effect.mapError((cause) => fail(input.projectId, cause)));
    return {
      items,
      observedAt: times[0]?.observed_at ?? null,
    };
  });
  // Readers share the pass lock, so the SQL snapshot never exposes half an
  // observation or a read marker racing that observation's completion update.
  const list = (input: typeof MeerkatAttentionInput.Type) =>
    observationLock.withPermits(1)(read(input));
  const subscribe = (input: typeof MeerkatAttentionInput.Type) =>
    subscriptions.subscribe(input.projectId, list(input));
  const markRead = Effect.fn("MeerkatAttention.markRead")(
    function* (input: typeof MeerkatAttentionReadInput.Type) {
      if (input.itemIds.length) {
        const timestamp = yield* now;
        yield* sql`UPDATE meerkat_attention SET read_at=${timestamp} WHERE project_id=${input.projectId} AND id IN ${sql.in(input.itemIds)}`.pipe(
          Effect.mapError((cause) => fail(input.projectId, cause)),
        );
      }
      return yield* read(input);
    },
    observationLock.withPermits(1),
    (effect, input) => effect.pipe(Effect.tap(() => subscriptions.publish(input.projectId))),
  );
  const runOnce = Effect.gen(function* () {
    const projects =
      yield* sql`SELECT project_id FROM projection_projects WHERE deleted_at IS NULL`.pipe(
        Effect.flatMap(decodeProjects),
      );
    yield* Effect.forEach(
      projects,
      (row) =>
        observeProject(row.project_id).pipe(
          Effect.catch((cause) => Effect.logWarning("Native attention observation failed", cause)),
        ),
      { concurrency: 2 },
    );
  });
  const run = Effect.forever(
    runOnce.pipe(
      Effect.catch((cause) => Effect.logWarning("Native attention pass failed", cause)),
      Effect.andThen(Effect.sleep("10 seconds")),
    ),
  );
  return { list, subscribe, markRead, observeProject, runOnce, run };
});

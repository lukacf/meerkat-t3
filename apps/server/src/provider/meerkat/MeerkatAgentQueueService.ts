import {
  MeerkatAgentControlReceipt,
  ConsoleFrame,
  MeerkatAgentQueue,
  MeerkatAgentQueueError,
  MeerkatAgentQueuePayload,
  MeerkatAgentQueueItem,
  type MeerkatAgentQueueTarget,
  type MeerkatAgentQueueEnqueueInput,
  type MeerkatAgentQueueEditInput,
  type MeerkatAgentQueueMutationInput,
  type MeerkatAgentQueueMoveInput,
  type MeerkatAgentSendInput,
  type MeerkatAgentWork,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { agentFingerprint } from "./MeerkatProjectAgentStore.ts";
import { makeMeerkatObservedAgents } from "./MeerkatObservedAgents.ts";
import type { makeMeerkatTeamService } from "./MeerkatTeamService.ts";
import type { makeMeerkatControlsService } from "./MeerkatControlsService.ts";
import { nativeWorkCompletion } from "./MeerkatWork.ts";
import { makeMeerkatStateSubscriptions } from "./MeerkatStateSubscriptions.ts";
import {
  requireRestoreReviewReleased,
  restoreReviewHeld,
  RESTORE_REVIEW_MESSAGE,
} from "../../restoreReview.ts";

const Binding = Schema.Struct({
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
  durableId: Schema.String,
  providerStateRoot: Schema.String,
  projectPath: Schema.String,
  stateRoot: Schema.NullOr(Schema.String),
  mobId: Schema.String,
  identity: Schema.String,
});
export type MeerkatAgentQueueBinding = typeof Binding.Type;
export interface MeerkatAgentQueueObservation {
  readonly agentRef: string;
  readonly sessionId: string;
  readonly work: MeerkatAgentWork;
  readonly pendingQuestions: number;
  readonly completedInteractionIds: ReadonlyArray<string>;
}
export class MeerkatQueueSendRejected extends Schema.TaggedError<MeerkatQueueSendRejected>()(
  "MeerkatQueueSendRejected",
  { message: Schema.String },
) {}
export interface MeerkatAgentQueueDependencies {
  readonly resolve: (
    input: MeerkatAgentQueueTarget,
  ) => Effect.Effect<MeerkatAgentQueueBinding, MeerkatAgentQueueError>;
  readonly observe: (
    binding: MeerkatAgentQueueBinding,
    interactionId?: string,
  ) => Effect.Effect<MeerkatAgentQueueObservation, MeerkatAgentQueueError>;
  readonly send: (
    input: MeerkatAgentSendInput,
  ) => Effect.Effect<MeerkatAgentControlReceipt, MeerkatAgentQueueError | MeerkatQueueSendRejected>;
  /** Read-only lookup. An absent receipt is never permission to resend an uncertain dispatch. */
  readonly reconcile?: (
    binding: MeerkatAgentQueueBinding,
    input: MeerkatAgentSendInput,
  ) => Effect.Effect<
    MeerkatAgentControlReceipt | undefined,
    MeerkatAgentQueueError | MeerkatQueueSendRejected
  >;
}
const QueueRow = Schema.Struct({
  target_key: Schema.String,
  binding_json: Schema.String,
  durable_id: Schema.String,
  revision: Schema.Number,
  waiting_reason: Schema.NullOr(Schema.String),
});
const ItemRow = Schema.Struct({
  item_id: Schema.String,
  target_key: Schema.String,
  request_id: Schema.String,
  enqueue_fingerprint: Schema.String,
  payload_json: Schema.String,
  position: Schema.Number,
  status: MeerkatAgentQueueItem.fields.status,
  error: Schema.NullOr(Schema.String),
  receipt_json: Schema.NullOr(Schema.String),
  dispatch_session_id: Schema.NullOr(Schema.String),
  dispatch_agent_ref: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
});
const decodeQueueRows = Schema.decodeUnknownEffect(Schema.Array(QueueRow));
const decodeItemRows = Schema.decodeUnknownEffect(Schema.Array(ItemRow));
const decodeBinding = Schema.decodeUnknownEffect(Schema.fromJsonString(Binding));
const encodeBinding = Schema.encodeSync(Schema.fromJsonString(Binding));
const decodePayload = Schema.decodeUnknownEffect(Schema.fromJsonString(MeerkatAgentQueuePayload));
const encodePayload = Schema.encodeSync(Schema.fromJsonString(MeerkatAgentQueuePayload));
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(MeerkatAgentControlReceipt));
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(MeerkatAgentControlReceipt));
const NativeReceipt = Schema.Struct({
  receipt: Schema.Struct({
    interaction_id: Schema.String,
    status: Schema.optional(Schema.String),
    completion: Schema.optional(Schema.NullOr(ConsoleFrame)),
  }),
});
const decodeNativeReceipt = Schema.decodeUnknownOption(NativeReceipt);
const isQueueError = Schema.is(MeerkatAgentQueueError);
const isSendRejected = Schema.is(MeerkatQueueSendRejected);
const decodeQueue = Schema.decodeUnknownEffect(MeerkatAgentQueue);
const validateQueuePayload = Schema.decodeEffect(MeerkatAgentQueuePayload);
const decodeTargetKeyRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ target_key: Schema.String })),
);
const receiptInteraction = (
  receipt: MeerkatAgentControlReceipt | undefined,
): string | undefined => {
  if (receipt?.status !== "accepted") return undefined;
  const result = decodeNativeReceipt(receipt.receipt);
  return result._tag === "Some" &&
    !["delivery_failed", "redacted"].includes(result.value.receipt.status ?? "")
    ? result.value.receipt.interaction_id
    : undefined;
};
const receiptCompleted = (
  receipt: MeerkatAgentControlReceipt,
  binding: MeerkatAgentQueueBinding,
  sessionId: string,
) => {
  if (!receiptInteraction(receipt)) return false;
  const result = decodeNativeReceipt(receipt.receipt);
  if (result._tag !== "Some") return false;
  const completion = result.value.receipt.completion;
  return (
    completion !== null &&
    completion !== undefined &&
    completion.identity === binding.identity &&
    completion.interaction_id === result.value.receipt.interaction_id &&
    (completion.session_id === undefined || completion.session_id === sessionId) &&
    ["interaction_complete", "interaction_failed"].includes(completion.kind) &&
    completion.source.kind !== "session_history" &&
    nativeWorkCompletion([completion], {
      identity: binding.identity,
      session_id: sessionId,
    }) !== undefined
  );
};
const keyFor = (binding: MeerkatAgentQueueBinding) =>
  agentFingerprint([
    binding.projectId,
    binding.instanceId,
    binding.durableId,
    binding.providerStateRoot,
    binding.projectPath,
    binding.stateRoot ?? "",
    binding.mobId,
    binding.identity,
  ]);
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Product-owned editable drafts. Native sends, questions and completion receipts retain authority. */
export const makeMeerkatAgentQueue = Effect.fn("makeMeerkatAgentQueue")(function* (
  dependencies: MeerkatAgentQueueDependencies,
) {
  const sql = yield* SqlClient.SqlClient;
  const subscriptions = makeMeerkatStateSubscriptions();
  const now = DateTime.nowAsDate.pipe(Effect.map((value) => value.toISOString()));
  const fail = (projectId: ProjectId, message: string) =>
    new MeerkatAgentQueueError({ projectId, message });
  const guard = <A, E, R>(projectId: ProjectId, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) => (isQueueError(cause) ? cause : fail(projectId, errorText(cause)))),
    );
  const queueRow = (key: string) =>
    sql`SELECT * FROM meerkat_agent_queues WHERE target_key=${key}`.pipe(
      Effect.flatMap(decodeQueueRows),
      Effect.map((rows) => rows[0]),
    );
  const itemRows = (key: string) =>
    sql`SELECT * FROM meerkat_agent_queue_items WHERE target_key=${key} AND status NOT IN ('completed','cancelled') ORDER BY position,item_id`.pipe(
      Effect.flatMap(decodeItemRows),
    );
  const ensure = Effect.fn("MeerkatAgentQueue.ensure")(function* (input: MeerkatAgentQueueTarget) {
    const binding = yield* dependencies.resolve(input);
    const key = keyFor(binding);
    yield* sql`INSERT INTO meerkat_agent_queues(target_key,project_id,instance_id,durable_id,binding_json)
      VALUES (${key},${binding.projectId},${binding.instanceId},${binding.durableId},${encodeBinding(binding)}) ON CONFLICT(target_key) DO NOTHING`;
    return { key, binding };
  });
  const snapshot = Effect.fn("MeerkatAgentQueue.snapshot")(function* (key: string) {
    const queue = yield* queueRow(key);
    if (!queue) return yield* Effect.die(new Error("Queue binding disappeared."));
    const items = yield* Effect.forEach(yield* itemRows(key), (row) =>
      Effect.gen(function* () {
        return {
          id: row.item_id,
          requestId: row.request_id,
          payload: yield* decodePayload(row.payload_json),
          status: row.status,
          error: row.error,
          receipt: row.receipt_json ? yield* decodeReceipt(row.receipt_json) : null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }),
    );
    return yield* decodeQueue({
      revision: queue.revision,
      durableId: queue.durable_id,
      items,
      waitingReason: queue.waiting_reason,
    });
  }, sql.withTransaction);
  const list = (input: MeerkatAgentQueueTarget) =>
    guard(input.projectId, ensure(input).pipe(Effect.flatMap(({ key }) => snapshot(key))));
  const subscribe = (input: MeerkatAgentQueueTarget) =>
    Stream.unwrap(
      guard(
        input.projectId,
        ensure(input).pipe(
          Effect.map(({ key }) =>
            subscriptions.subscribe(key, guard(input.projectId, snapshot(key))),
          ),
        ),
      ),
    );
  const validatePayload = Effect.fn("MeerkatAgentQueue.validatePayload")(function* (
    projectId: ProjectId,
    raw: MeerkatAgentQueuePayload,
  ) {
    const payload = yield* validateQueuePayload(raw);
    if (!payload.text.trim() && !payload.images?.length)
      return yield* fail(projectId, "A queued message needs text or an image.");
    return payload;
  });
  const bump = (key: string) =>
    sql`UPDATE meerkat_agent_queues SET revision=revision+1 WHERE target_key=${key}`;
  const enqueue = (input: MeerkatAgentQueueEnqueueInput) =>
    guard(
      input.projectId,
      Effect.gen(function* () {
        const payload = yield* validatePayload(input.projectId, input.payload);
        yield* requireRestoreReviewReleased;
        const { key } = yield* ensure(input);
        const encoded = encodePayload(payload);
        const fingerprint = agentFingerprint([encoded]);
        const timestamp = yield* now;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* itemRows(key);
            const previous =
              (yield* sql`SELECT * FROM meerkat_agent_queue_items WHERE target_key=${key} AND request_id=${input.requestId}`.pipe(
                Effect.flatMap(decodeItemRows),
              ))[0];
            if (previous) {
              if (previous.enqueue_fingerprint !== fingerprint)
                return yield* fail(
                  input.projectId,
                  "This enqueue request was already used with different content.",
                );
              return;
            }
            if (
              rows.filter((row) => !["completed", "cancelled"].includes(row.status)).length >= 100
            )
              return yield* fail(input.projectId, "This agent already has 100 pending messages.");
            yield* sql`INSERT INTO meerkat_agent_queue_items
        (item_id,target_key,request_id,enqueue_fingerprint,payload_json,position,status,created_at,updated_at)
        VALUES (${agentFingerprint([key, input.requestId])},${key},${input.requestId},${fingerprint},${encoded},${Math.max(0, ...rows.map((row) => row.position)) + 1},'queued',${timestamp},${timestamp})`;
            yield* bump(key);
          }),
        );
        yield* subscriptions.publish(key);
        return yield* snapshot(key);
      }),
    );
  const mutation = Effect.fn("MeerkatAgentQueue.mutation")(function* <E>(
    input: MeerkatAgentQueueMutationInput,
    change: (
      key: string,
      row: typeof ItemRow.Type,
      rows: ReadonlyArray<typeof ItemRow.Type>,
    ) => Effect.Effect<void, E>,
  ) {
    const { key } = yield* ensure(input);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const queue = yield* queueRow(key);
        if (queue?.revision !== input.expectedRevision)
          return yield* fail(
            input.projectId,
            "The queue changed in another window. Refresh it before editing.",
          );
        const rows = yield* itemRows(key);
        const row = rows.find((item) => item.item_id === input.itemId);
        if (!row) return yield* fail(input.projectId, "Queued message not found for this agent.");
        yield* change(key, row, rows);
        yield* bump(key);
      }),
    );
    yield* subscriptions.publish(key);
    return yield* snapshot(key);
  });
  const editable = (input: MeerkatAgentQueueMutationInput, row: typeof ItemRow.Type) =>
    ["queued", "failed"].includes(row.status)
      ? Effect.void
      : Effect.fail(
          fail(input.projectId, "Only an unsent message can be edited, moved or cancelled."),
        );
  const edit = (input: MeerkatAgentQueueEditInput) =>
    guard(
      input.projectId,
      Effect.gen(function* () {
        const payload = yield* validatePayload(input.projectId, input.payload);
        const timestamp = yield* now;
        return yield* mutation(input, (_key, row) =>
          Effect.gen(function* () {
            yield* editable(input, row);
            yield* sql`UPDATE meerkat_agent_queue_items SET payload_json=${encodePayload(payload)},updated_at=${timestamp} WHERE item_id=${row.item_id}`;
          }),
        );
      }),
    );
  const cancel = (input: MeerkatAgentQueueMutationInput) =>
    guard(
      input.projectId,
      mutation(input, (_key, row) =>
        Effect.gen(function* () {
          yield* editable(input, row);
          const timestamp = yield* now;
          yield* sql`UPDATE meerkat_agent_queue_items SET status='cancelled',error=NULL,updated_at=${timestamp} WHERE item_id=${row.item_id}`;
        }),
      ),
    );
  const move = (input: MeerkatAgentQueueMoveInput) =>
    guard(
      input.projectId,
      mutation(input, (_key, row, rows) =>
        Effect.gen(function* () {
          yield* editable(input, row);
          const pending = rows.filter((item) => ["queued", "failed"].includes(item.status));
          const index = pending.findIndex((item) => item.item_id === row.item_id);
          const adjacent = pending[index + (input.direction === "up" ? -1 : 1)];
          if (!adjacent) return;
          yield* sql`UPDATE meerkat_agent_queue_items SET position=${adjacent.position} WHERE item_id=${row.item_id}`;
          yield* sql`UPDATE meerkat_agent_queue_items SET position=${row.position} WHERE item_id=${adjacent.item_id}`;
        }),
      ),
    );
  const setWaiting = (key: string, reason: string | null) =>
    sql`UPDATE meerkat_agent_queues SET waiting_reason=${reason},revision=revision+1
    WHERE target_key=${key} AND waiting_reason IS NOT ${reason} RETURNING target_key`.pipe(
      Effect.tap((rows) => (rows.length ? subscriptions.publish(key) : Effect.void)),
    );
  const changeStatus = Effect.fn("MeerkatAgentQueue.changeStatus")(function* (
    row: typeof ItemRow.Type,
    status: (typeof ItemRow.Type)["status"],
    message: string | null,
    receipt?: MeerkatAgentControlReceipt,
  ) {
    const timestamp = yield* now;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const changed =
          yield* sql`UPDATE meerkat_agent_queue_items SET status=${status},error=${message},receipt_json=${receipt ? encodeReceipt(receipt) : row.receipt_json},updated_at=${timestamp}
        WHERE item_id=${row.item_id} AND status=${row.status} RETURNING item_id`;
        if (changed.length) yield* bump(row.target_key);
      }),
    );
    yield* subscriptions.publish(row.target_key);
  });
  const reconcile = Effect.fn("MeerkatAgentQueue.reconcile")(function* (
    binding: MeerkatAgentQueueBinding,
    row: typeof ItemRow.Type,
  ) {
    if (!dependencies.reconcile || !row.dispatch_agent_ref || !row.dispatch_session_id) return;
    const payload = yield* decodePayload(row.payload_json);
    const result = yield* dependencies
      .reconcile(binding, {
        projectId: binding.projectId,
        instanceId: binding.instanceId,
        agentRef: row.dispatch_agent_ref,
        requestId: `agent-queue-${row.item_id}`,
        handlingMode: "queue",
        ...payload,
      })
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      if (isSendRejected(result.failure))
        yield* changeStatus(row, "failed", result.failure.message);
      return;
    }
    const receipt = result.success;
    if (receipt && receiptCompleted(receipt, binding, row.dispatch_session_id)) {
      yield* changeStatus(row, "completed", null, receipt);
      return true;
    }
    if (
      receipt &&
      receiptInteraction(receipt) &&
      (row.status !== "accepted" || encodeReceipt(receipt) !== row.receipt_json)
    )
      yield* changeStatus(row, "accepted", null, receipt);
    else if (receipt && encodeReceipt(receipt) !== row.receipt_json)
      yield* changeStatus(row, "uncertain", receipt.message ?? row.error, receipt);
  });
  const retry = (input: MeerkatAgentQueueMutationInput) =>
    guard(
      input.projectId,
      Effect.gen(function* () {
        const { key, binding } = yield* ensure(input);
        const queue = yield* queueRow(key);
        if (queue?.revision !== input.expectedRevision)
          return yield* fail(input.projectId, "The queue changed. Refresh it before retrying.");
        const row = (yield* itemRows(key)).find((item) => item.item_id === input.itemId);
        if (!row) return yield* fail(input.projectId, "Queued message not found.");
        if (row.status === "uncertain") {
          yield* reconcile(binding, row);
          return yield* snapshot(key);
        }
        yield* requireRestoreReviewReleased;
        return yield* mutation(input, (_key, item) =>
          Effect.gen(function* () {
            if (item.status !== "failed")
              return yield* fail(input.projectId, "Only a failed unsent message can be retried.");
            const timestamp = yield* now;
            yield* sql`UPDATE meerkat_agent_queue_items SET status='queued',error=NULL,updated_at=${timestamp} WHERE item_id=${item.item_id}`;
          }),
        );
      }),
    );
  const process = Effect.fn("MeerkatAgentQueue.process")(function* (queue: typeof QueueRow.Type) {
    const binding = yield* decodeBinding(queue.binding_json);
    const rows = yield* itemRows(queue.target_key);
    const head = rows.find((row) => !["completed", "cancelled"].includes(row.status));
    if (!head) {
      yield* setWaiting(queue.target_key, null);
      return;
    }
    if (head.status === "dispatching") return;
    if (head.status === "uncertain") {
      yield* reconcile(binding, head);
      yield* setWaiting(
        queue.target_key,
        "Delivery is uncertain. Check this message's receipt before continuing the queue.",
      );
      return;
    }
    if (head.status === "failed") {
      yield* setWaiting(queue.target_key, "Review the failed message and retry or cancel it.");
      return;
    }
    if (head.status === "accepted" && (yield* reconcile(binding, head))) {
      yield* setWaiting(queue.target_key, null);
      return;
    }
    if (head.status === "queued" && (yield* restoreReviewHeld)) {
      yield* setWaiting(queue.target_key, RESTORE_REVIEW_MESSAGE);
      return;
    }
    const receipt = head.receipt_json ? yield* decodeReceipt(head.receipt_json) : undefined;
    const interactionId = receiptInteraction(receipt);
    const observed = yield* dependencies.observe(binding, interactionId).pipe(Effect.result);
    if (observed._tag === "Failure") {
      yield* setWaiting(queue.target_key, `Waiting for the agent: ${errorText(observed.failure)}`);
      return;
    }
    const observation = observed.success;
    const age = Date.parse(yield* now) - Date.parse(observation.work.observedAt);
    if (!Number.isFinite(age) || age < 0 || age >= 30_000) {
      yield* setWaiting(queue.target_key, "Waiting for a current native status.");
      return;
    }
    if (head.status === "accepted") {
      if (head.dispatch_session_id !== observation.sessionId) {
        yield* setWaiting(
          queue.target_key,
          "The agent session changed. Waiting for the previous message's completion receipt.",
        );
        return;
      }
      if (interactionId && observation.completedInteractionIds.includes(interactionId)) {
        yield* changeStatus(head, "completed", null);
        yield* setWaiting(queue.target_key, null);
      } else yield* setWaiting(queue.target_key, "Waiting for the current message to finish.");
      return;
    }
    if (observation.pendingQuestions > 0) {
      yield* setWaiting(
        queue.target_key,
        "Answer the agent's question before queued work continues.",
      );
      return;
    }
    if (observation.work.status !== "idle") {
      yield* setWaiting(queue.target_key, "Waiting for the agent to become idle.");
      return;
    }
    const timestamp = yield* now;
    const claimed = yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* queueRow(queue.target_key);
        if (current?.revision !== queue.revision) return false;
        const changed =
          yield* sql`UPDATE meerkat_agent_queue_items SET status='dispatching',dispatch_session_id=${observation.sessionId},dispatch_agent_ref=${observation.agentRef},updated_at=${timestamp}
        WHERE item_id=${head.item_id} AND status='queued'
        AND NOT EXISTS (SELECT 1 FROM meerkat_agent_queue_items WHERE target_key=${queue.target_key} AND status IN ('dispatching','accepted','uncertain')) RETURNING item_id`;
        if (!changed.length) return false;
        yield* bump(queue.target_key);
        return true;
      }),
    );
    if (!claimed) return;
    yield* subscriptions.publish(queue.target_key);
    const payload = yield* decodePayload(head.payload_json);
    const result = yield* dependencies
      .send({
        projectId: binding.projectId,
        instanceId: binding.instanceId,
        agentRef: observation.agentRef,
        requestId: `agent-queue-${head.item_id}`,
        handlingMode: "queue",
        ...payload,
      })
      .pipe(Effect.result);
    const dispatching = { ...head, status: "dispatching" as const };
    if (result._tag === "Failure") {
      // Persistence may fail after native acceptance; a thrown error is not proof of rejection.
      yield* changeStatus(
        dispatching,
        isSendRejected(result.failure) ? "failed" : "uncertain",
        errorText(result.failure),
      );
    } else if (result.success.status === "uncertain" || !receiptInteraction(result.success)) {
      yield* changeStatus(
        dispatching,
        "uncertain",
        result.success.message ?? "The runtime did not return a verifiable interaction receipt.",
        result.success,
      );
    } else yield* changeStatus(dispatching, "accepted", null, result.success);
  });
  const runOnce = Effect.gen(function* () {
    const queues = yield* sql`SELECT q.* FROM meerkat_agent_queues q WHERE EXISTS
      (SELECT 1 FROM meerkat_agent_queue_items i WHERE i.target_key=q.target_key AND i.status NOT IN ('completed','cancelled'))`.pipe(
      Effect.flatMap(decodeQueueRows),
    );
    yield* Effect.forEach(
      queues,
      (queue) =>
        process(queue).pipe(
          Effect.catch((cause) => setWaiting(queue.target_key, errorText(cause))),
        ),
      { concurrency: 4 },
    );
    // A completed pass is useful even when no draft remains. It is an observation
    // barrier, never an extra native completion or permission to resend work.
    yield* Effect.forEach(subscriptions.keys(), (key) => subscriptions.publish(key, "observation"));
  });
  /** Call once at server startup, before starting the worker, never when opening a UI or facade. */
  const recoverInterrupted = sql
    .withTransaction(
      Effect.gen(function* () {
        const timestamp = yield* now;
        const rows =
          yield* sql`UPDATE meerkat_agent_queue_items SET status='uncertain',error='The server restarted during dispatch. Delivery must be reconciled before continuing.',updated_at=${timestamp}
      WHERE status='dispatching' RETURNING target_key`.pipe(Effect.flatMap(decodeTargetKeyRows));
        for (const key of new Set(rows.map((row) => row.target_key))) yield* bump(key);
        return rows;
      }),
    )
    .pipe(
      Effect.tap((rows) => Effect.forEach(rows, (row) => subscriptions.publish(row.target_key))),
      Effect.asVoid,
    );
  const run = Effect.forever(
    runOnce.pipe(
      Effect.catch((cause) => Effect.logWarning("Native agent queue pass failed", cause)),
      Effect.andThen(Effect.sleep("2 seconds")),
    ),
  );
  return { list, subscribe, enqueue, edit, move, cancel, retry, runOnce, recoverInterrupted, run };
});

export const makeMeerkatAgentQueueService = Effect.fn("makeMeerkatAgentQueueService")(function* (
  team: Pick<
    Effect.Success<typeof makeMeerkatTeamService>,
    "projectTeam" | "queueTarget" | "agentSend" | "agentDeliveryReconcile"
  >,
  controls: Pick<Effect.Success<ReturnType<typeof makeMeerkatControlsService>>, "questions">,
) {
  const observed = yield* makeMeerkatObservedAgents;
  const sql = yield* SqlClient.SqlClient;
  const resolve = Effect.fn("MeerkatAgentQueue.resolve")(function* (
    input: MeerkatAgentQueueTarget,
  ) {
    // Refresh if live, then allow a known unloaded identity to retain its editable drafts.
    let saved = (yield* observed.list(input.projectId, input.instanceId, input.agentRef))[0];
    if (!saved) {
      yield* team.projectTeam({ projectId: input.projectId }).pipe(Effect.catch(() => Effect.void));
      saved = (yield* observed.list(input.projectId, input.instanceId, input.agentRef))[0];
    }
    if (!saved)
      return yield* new MeerkatAgentQueueError({
        projectId: input.projectId,
        message: "This agent has not been observed in this project.",
      });
    if (
      saved.agent.mobKind === "thread" &&
      saved.agent.record.runtime_member_id === "ingress" &&
      !saved.agent.record.labels.source_mob_id
    )
      return yield* new MeerkatAgentQueueError({
        projectId: input.projectId,
        message: "Use the thread composer for coordinator messages.",
      });
    return {
      projectId: input.projectId,
      instanceId: input.instanceId,
      durableId: saved.durable_id,
      providerStateRoot: saved.provider_state_root,
      projectPath: saved.project_path,
      stateRoot: saved.state_root,
      mobId: saved.agent.mobId,
      identity: saved.agent.record.identity,
    };
  });
  const observe = Effect.fn("MeerkatAgentQueue.observe")(function* (
    binding: MeerkatAgentQueueBinding,
    interactionId?: string,
  ) {
    const { agent, target } = yield* team.queueTarget({
      projectId: binding.projectId,
      instanceId: binding.instanceId,
      durableId: binding.durableId,
    });
    if (!target.record.session_id)
      return yield* new MeerkatAgentQueueError({
        projectId: binding.projectId,
        message: "The native agent has no live session.",
      });
    if (
      target.reader.stateRoot !== binding.providerStateRoot ||
      target.projectPath !== binding.projectPath ||
      (target.stateRoot ?? null) !== binding.stateRoot ||
      target.mobId !== binding.mobId ||
      target.record.identity !== binding.identity ||
      !target.reader.work
    )
      return yield* new MeerkatAgentQueueError({
        projectId: binding.projectId,
        message: "The native agent binding changed.",
      });
    const questions = yield* controls.questions({
      projectId: binding.projectId,
      instanceId: binding.instanceId,
      agentRef: agent.agentRef,
    });
    const work = yield* target.reader.work(target);
    const observedAt = (yield* DateTime.nowAsDate).toISOString();
    // Runtime inputs have no console interaction and cannot settle a queued send.
    const completedInteractionIds =
      work.latestCompletion && "interactionId" in work.latestCompletion
        ? [work.latestCompletion.interactionId]
        : [];
    if (interactionId && !completedInteractionIds.includes(interactionId)) {
      const page = yield* target.reader.activity({
        ...target,
        identity: target.record.identity,
        limit: 100,
      });
      const completion = nativeWorkCompletion(
        page.frames.filter((frame) => frame.interaction_id === interactionId),
        target.record,
      );
      if (completion) completedInteractionIds.push(completion.interactionId);
    }
    return {
      agentRef: agent.agentRef,
      sessionId: target.record.session_id!,
      pendingQuestions: questions.requests.length,
      work: { ...work, observedAt },
      completedInteractionIds,
    };
  });
  const queueFailure = (projectId: ProjectId) => (cause: unknown) =>
    new MeerkatAgentQueueError({ projectId, message: errorText(cause) });
  return yield* makeMeerkatAgentQueue({
    resolve: (input) => resolve(input).pipe(Effect.mapError(queueFailure(input.projectId))),
    observe: (binding, interactionId) =>
      observe(binding, interactionId).pipe(Effect.mapError(queueFailure(binding.projectId))),
    send: (input) =>
      team.agentSend(input).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            // Native I/O is preceded by agentSend's durable claim. A successful absence read proves validation rejected before I/O.
            const claimed =
              yield* sql`SELECT request_id FROM meerkat_agent_delivery_receipts WHERE project_id=${input.projectId} AND instance_id=${input.instanceId} AND request_id=${input.requestId}`.pipe(
                Effect.mapError(queueFailure(input.projectId)),
              );
            if (!claimed.length)
              return yield* new MeerkatQueueSendRejected({ message: errorText(cause) });
            return yield* queueFailure(input.projectId)(cause);
          }),
        ),
      ),
    reconcile: (binding, input) =>
      team.agentDeliveryReconcile(input).pipe(
        Effect.mapError(queueFailure(binding.projectId)),
        Effect.flatMap((receipt) =>
          receipt
            ? Effect.succeed(receipt)
            : Effect.fail(
                new MeerkatQueueSendRejected({
                  message:
                    "The server stopped before native delivery was claimed. Review this message and retry it.",
                }),
              ),
        ),
      ),
  });
});

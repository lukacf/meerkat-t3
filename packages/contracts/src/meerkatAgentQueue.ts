import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { MeerkatAgentSendInput, MeerkatAgentControlReceipt } from "./meerkatTeam.ts";

export const MeerkatAgentQueueTarget = Schema.Struct({
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
  agentRef: TrimmedNonEmptyString,
});
export type MeerkatAgentQueueTarget = typeof MeerkatAgentQueueTarget.Type;
export const MeerkatAgentQueuePayload = Schema.Struct({
  text: MeerkatAgentSendInput.fields.text,
  images: MeerkatAgentSendInput.fields.images,
  modelSelection: MeerkatAgentSendInput.fields.modelSelection,
  context: MeerkatAgentSendInput.fields.context,
});
export type MeerkatAgentQueuePayload = typeof MeerkatAgentQueuePayload.Type;
export const MeerkatAgentQueueEnqueueInput = Schema.Struct({
  ...MeerkatAgentQueueTarget.fields,
  requestId: TrimmedNonEmptyString,
  payload: MeerkatAgentQueuePayload,
});
export type MeerkatAgentQueueEnqueueInput = typeof MeerkatAgentQueueEnqueueInput.Type;
export const MeerkatAgentQueueMutationInput = Schema.Struct({
  ...MeerkatAgentQueueTarget.fields,
  itemId: TrimmedNonEmptyString,
  expectedRevision: NonNegativeInt,
});
export type MeerkatAgentQueueMutationInput = typeof MeerkatAgentQueueMutationInput.Type;
export const MeerkatAgentQueueEditInput = Schema.Struct({
  ...MeerkatAgentQueueMutationInput.fields,
  payload: MeerkatAgentQueuePayload,
});
export type MeerkatAgentQueueEditInput = typeof MeerkatAgentQueueEditInput.Type;
export const MeerkatAgentQueueMoveInput = Schema.Struct({
  ...MeerkatAgentQueueMutationInput.fields,
  direction: Schema.Literals(["up", "down"]),
});
export type MeerkatAgentQueueMoveInput = typeof MeerkatAgentQueueMoveInput.Type;
export const MeerkatAgentQueueItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  requestId: TrimmedNonEmptyString,
  payload: MeerkatAgentQueuePayload,
  status: Schema.Literals([
    "queued",
    "dispatching",
    "accepted",
    "failed",
    "uncertain",
    "completed",
    "cancelled",
  ]),
  error: Schema.NullOr(Schema.String),
  receipt: Schema.NullOr(MeerkatAgentControlReceipt),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type MeerkatAgentQueueItem = typeof MeerkatAgentQueueItem.Type;
export const MeerkatAgentQueue = Schema.Struct({
  revision: NonNegativeInt,
  durableId: Schema.String,
  items: Schema.Array(MeerkatAgentQueueItem),
  waitingReason: Schema.NullOr(Schema.String),
});
export type MeerkatAgentQueue = typeof MeerkatAgentQueue.Type;
/** Latest state, not an event log. An observation follows a server pass, not a native completion. */
export const MeerkatAgentQueueStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    source: Schema.Literals(["initial", "mutation", "observation"]),
    snapshot: MeerkatAgentQueue,
  }),
  Schema.Struct({ kind: Schema.Literal("synchronized") }),
]);
export type MeerkatAgentQueueStreamItem = typeof MeerkatAgentQueueStreamItem.Type;
export class MeerkatAgentQueueError extends Schema.TaggedError<MeerkatAgentQueueError>()(
  "MeerkatAgentQueueError",
  {
    projectId: ProjectId,
    message: Schema.String,
  },
) {}

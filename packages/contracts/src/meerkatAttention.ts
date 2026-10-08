import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { MeerkatPendingQuestion } from "./meerkatControls.ts";

export const MeerkatAttentionInput = Schema.Struct({
  projectId: ProjectId,
  itemId: Schema.optional(TrimmedNonEmptyString),
});
export const MeerkatAttentionItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
  agentRef: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  projectAgentId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  coordinator: Schema.Boolean,
  label: Schema.String,
  kind: Schema.Literals(["question", "approval", "completion", "query-error", "delivery-error"]),
  title: Schema.String,
  detail: Schema.String,
  question: Schema.NullOr(MeerkatPendingQuestion),
  approvalId: Schema.optional(TrimmedNonEmptyString),
  completionStatus: Schema.NullOr(Schema.Literals(["completed", "failed"])),
  active: Schema.Boolean,
  unread: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type MeerkatAttentionItem = typeof MeerkatAttentionItem.Type;
export const MeerkatAttention = Schema.Struct({
  items: Schema.Array(MeerkatAttentionItem),
  observedAt: Schema.NullOr(IsoDateTime),
});
export type MeerkatAttention = typeof MeerkatAttention.Type;
/** Latest state, not an event log. An observation follows a complete project attention pass. */
export const MeerkatAttentionStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    source: Schema.Literals(["initial", "mutation", "observation"]),
    snapshot: MeerkatAttention,
  }),
  Schema.Struct({ kind: Schema.Literal("synchronized") }),
]);
export type MeerkatAttentionStreamItem = typeof MeerkatAttentionStreamItem.Type;
export const MeerkatAttentionReadInput = Schema.Struct({
  projectId: ProjectId,
  itemIds: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(100)),
});
export class MeerkatAttentionError extends Schema.TaggedError<MeerkatAttentionError>()(
  "MeerkatAttentionError",
  { projectId: ProjectId, message: Schema.String },
) {}

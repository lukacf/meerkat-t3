import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const RestoreReviewStatus = Schema.Struct({
  status: Schema.Literals(["clear", "required", "invalid", "restart-required"]),
  restoreId: Schema.NullOr(TrimmedNonEmptyString),
  restoredAt: Schema.NullOr(IsoDateTime),
  backupCreatedAt: Schema.NullOr(IsoDateTime),
  message: Schema.String,
});
export type RestoreReviewStatus = typeof RestoreReviewStatus.Type;

export const RestoreReviewDestination = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("thread"),
    label: TrimmedNonEmptyString,
    threadId: ThreadId,
    member: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("project-agent"),
    label: TrimmedNonEmptyString,
    agentId: TrimmedNonEmptyString,
    nativeAgent: Schema.optional(TrimmedNonEmptyString),
    instanceId: ProviderInstanceId,
  }),
]);
export type RestoreReviewDestination = typeof RestoreReviewDestination.Type;

export const RestoreReviewItem = Schema.Struct({
  kind: Schema.Literals([
    "queued-message",
    "uncertain-delivery",
    "interrupted-session",
    "saved-agent",
  ]),
  id: Schema.String,
  projectId: Schema.String,
  instanceId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  label: Schema.String,
  status: Schema.String,
  detail: Schema.String,
  /** Absent when saved records cannot identify an existing conversation unambiguously. */
  destination: Schema.optional(RestoreReviewDestination),
});
export type RestoreReviewItem = typeof RestoreReviewItem.Type;

export const RestoreReviewSnapshot = Schema.Struct({
  ...RestoreReviewStatus.fields,
  nativeMailbox: Schema.Literal("unknown-unloaded"),
  counts: Schema.Struct({
    queuedMessages: NonNegativeInt,
    uncertainDeliveries: NonNegativeInt,
    interruptedSessions: NonNegativeInt,
    savedAgents: NonNegativeInt,
  }),
  items: Schema.Array(RestoreReviewItem),
  truncated: Schema.Boolean,
});
export type RestoreReviewSnapshot = typeof RestoreReviewSnapshot.Type;

export const RestoreReviewConsentInput = Schema.Struct({ restoreId: TrimmedNonEmptyString });
export class RestoreReviewError extends Schema.TaggedError<RestoreReviewError>()(
  "RestoreReviewError",
  { message: Schema.String },
) {}

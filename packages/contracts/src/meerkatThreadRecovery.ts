import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const MeerkatThreadRecoveryTarget = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  instanceId: ProviderInstanceId,
});
export type MeerkatThreadRecoveryTarget = typeof MeerkatThreadRecoveryTarget.Type;
export const MeerkatThreadRecovery = Schema.Struct({
  status: Schema.Literals([
    "none",
    "running",
    "settled",
    "interrupted",
    "unavailable",
    "recovered",
  ]),
  runId: Schema.NullOr(TrimmedNonEmptyString),
  canRecover: Schema.Boolean,
  message: Schema.String,
});
export type MeerkatThreadRecovery = typeof MeerkatThreadRecovery.Type;
export const MeerkatRecoverThreadInput = Schema.Struct({
  ...MeerkatThreadRecoveryTarget.fields,
  runId: TrimmedNonEmptyString,
});
export type MeerkatRecoverThreadInput = typeof MeerkatRecoverThreadInput.Type;
export const MeerkatThreadRecoveryReceipt = Schema.Struct({
  runId: TrimmedNonEmptyString,
  recovered: Schema.Literal(true),
  cleanupCompleted: Schema.Literal(true),
  outcome: Schema.Literal("unresolved"),
});
export type MeerkatThreadRecoveryReceipt = typeof MeerkatThreadRecoveryReceipt.Type;
export class MeerkatThreadRecoveryError extends Schema.TaggedError<MeerkatThreadRecoveryError>()(
  "MeerkatThreadRecoveryError",
  { projectId: ProjectId, threadId: ThreadId, message: Schema.String },
) {}

export const MeerkatReconnectThreadReceipt = Schema.Struct({
  runId: TrimmedNonEmptyString,
  reconnected: Schema.Literal(true),
  status: Schema.Literals(["running", "ready"]),
});
export type MeerkatReconnectThreadReceipt = typeof MeerkatReconnectThreadReceipt.Type;

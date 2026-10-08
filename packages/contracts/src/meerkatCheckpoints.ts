import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { MeerkatQuestionTarget } from "./meerkatControls.ts";

export const MeerkatCheckpointTarget = MeerkatQuestionTarget;
export type MeerkatCheckpointTarget = typeof MeerkatCheckpointTarget.Type;
export const MeerkatWorkspaceCheckpoint = Schema.Struct({
  id: TrimmedNonEmptyString,
  source: Schema.Literals(["native", "manual"]),
  sessionId: TrimmedNonEmptyString,
  workspace: Schema.String,
  /** Server-verified path used by this conversation, before filesystem canonicalization. */
  workspacePath: Schema.optional(Schema.String),
  startedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  status: Schema.Literals(["active", "complete", "partial", "unavailable"]),
  detail: Schema.NullOr(Schema.String),
});
export type MeerkatWorkspaceCheckpoint = typeof MeerkatWorkspaceCheckpoint.Type;
export const MeerkatCheckpointList = Schema.Struct({
  checkpoints: Schema.Array(MeerkatWorkspaceCheckpoint),
});
export const MeerkatCheckpointPreviewInput = Schema.Struct({
  ...MeerkatCheckpointTarget.fields,
  checkpointId: TrimmedNonEmptyString,
});
export type MeerkatCheckpointPreviewInput = typeof MeerkatCheckpointPreviewInput.Type;
export const MeerkatCheckpointFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  status: Schema.Literals(["modified", "added", "deleted", "type-changed"]),
  before: Schema.NullOr(Schema.String),
  current: Schema.NullOr(Schema.String),
  expectedCurrent: Schema.String,
  restorable: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
});
export type MeerkatCheckpointFile = typeof MeerkatCheckpointFile.Type;
export const MeerkatCheckpointPreview = Schema.Struct({
  checkpoint: MeerkatWorkspaceCheckpoint,
  patch: Schema.String,
  files: Schema.Array(MeerkatCheckpointFile),
  sharedWorkspace: Schema.Literal(true),
});
export type MeerkatCheckpointPreview = typeof MeerkatCheckpointPreview.Type;
export const MeerkatCheckpointRestoreInput = Schema.Struct({
  ...MeerkatCheckpointPreviewInput.fields,
  files: Schema.Array(
    Schema.Struct({ path: TrimmedNonEmptyString, expectedCurrent: Schema.String }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export type MeerkatCheckpointRestoreInput = typeof MeerkatCheckpointRestoreInput.Type;
export const MeerkatCheckpointRestoreResult = Schema.Struct({
  restored: Schema.Array(Schema.String),
  conflicts: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
});
export type MeerkatCheckpointRestoreResult = typeof MeerkatCheckpointRestoreResult.Type;
export class MeerkatCheckpointError extends Schema.TaggedError<MeerkatCheckpointError>()(
  "MeerkatCheckpointError",
  { message: Schema.String },
) {}

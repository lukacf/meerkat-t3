import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Resolved only on the participant's local environment, never on the shared host. */
export const SharedCheckoutRevisionInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
});
export type SharedCheckoutRevisionInput = typeof SharedCheckoutRevisionInput.Type;
export const SharedCheckoutRevision = Schema.Struct({
  projectId: ProjectId,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  commit: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)),
  dirty: Schema.Boolean,
  observedAt: IsoDateTime,
});
export type SharedCheckoutRevision = typeof SharedCheckoutRevision.Type;
export const SharedCheckoutPatchInput = SharedCheckoutRevisionInput;
export type SharedCheckoutPatchInput = typeof SharedCheckoutPatchInput.Type;
/** A local preview only. Uploading the retained patch requires a separate explicit action. */
export const SharedCheckoutPatch = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
  branch: SharedCheckoutRevision.fields.branch,
  commit: SharedCheckoutRevision.fields.commit,
  observedAt: IsoDateTime,
  status: Schema.Literals(["ready", "clean", "unsupported"]),
  scope: Schema.Literal("tracked_changes"),
  patch: Schema.NullOr(Schema.String),
  sha256: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      change: Schema.Literals(["added", "modified", "deleted", "type_changed"]),
    }),
  ),
  filesTruncated: Schema.Boolean,
  excluded: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      reason: Schema.Literals([
        "ignored",
        "untracked",
        "binary",
        "submodule",
        "symlink",
        "conflict",
        "unsupported_path",
        "oversize",
        "detached",
        "filter",
      ]),
    }),
  ),
  excludedTruncated: Schema.Boolean,
  maxBytes: Schema.Int,
  maxFiles: Schema.Int,
});
export type SharedCheckoutPatch = typeof SharedCheckoutPatch.Type;
export class SharedCheckoutRevisionError extends Schema.TaggedError<SharedCheckoutRevisionError>()(
  "SharedCheckoutRevisionError",
  {
    code: Schema.Literals(["not_found", "unavailable", "uncommitted", "changed"]),
    message: Schema.String,
  },
) {}

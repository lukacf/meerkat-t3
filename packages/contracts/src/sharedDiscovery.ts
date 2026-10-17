import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SharedDirectoryListInput, SharedSpecialistSummary } from "./sharedDirectory.ts";
import { SharedSpecialistAssignment } from "./sharedWorkspace.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(200));

/** Project and text filters narrow results; paths and tags are alternative relevance signals. */
export const SharedDiscoveryInput = Schema.Struct({
  sharedProjectId: Schema.optional(Id),
  paths: Schema.optional(SharedSpecialistAssignment.fields.paths),
  tags: Schema.optional(SharedSpecialistAssignment.fields.tags),
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  includeSuperseded: Schema.optional(Schema.Boolean),
  ...SharedDirectoryListInput.fields,
});
export type SharedDiscoveryInput = typeof SharedDiscoveryInput.Type;

/** Each path/tag reason is one literal witness, not an exhaustive list of matching scopes. */
export const SharedDiscoveryReason = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("project") }),
  Schema.Struct({
    kind: Schema.Literal("path"),
    path: Schema.String.check(Schema.isMaxLength(1024)),
  }),
  Schema.Struct({ kind: Schema.Literal("tag"), tag: Id }),
  Schema.Struct({
    kind: Schema.Literal("description"),
    source: Schema.Literals(["label", "charter"]),
  }),
  Schema.Struct({ kind: Schema.Literal("general") }),
]);
export type SharedDiscoveryReason = typeof SharedDiscoveryReason.Type;

export const SharedDiscoveryAssignmentMatch = Schema.Struct({
  sharedProjectId: Id,
  reasons: Schema.Array(SharedDiscoveryReason).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
  /** Display preview only. Fetch the specialist detail to read its retained charter. */
  charterExcerpt: Schema.String.check(Schema.isMaxLength(600)),
  charterExcerptTruncated: Schema.Boolean,
});
export type SharedDiscoveryAssignmentMatch = typeof SharedDiscoveryAssignmentMatch.Type;

export const SharedDiscoveryMatch = Schema.Struct({
  ...SharedSpecialistSummary.fields,
  matches: Schema.Array(SharedDiscoveryAssignmentMatch).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
});
export type SharedDiscoveryMatch = typeof SharedDiscoveryMatch.Type;

/** App directory relevance only; this result makes no claim about native availability. */
export const SharedDiscoveryResult = Schema.Struct({
  items: Schema.Array(SharedDiscoveryMatch).check(Schema.isMaxLength(100)),
  nextCursor: Schema.NullOr(Id),
});
export type SharedDiscoveryResult = typeof SharedDiscoveryResult.Type;

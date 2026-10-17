import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SharedProject, SharedSpecialist } from "./sharedWorkspace.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(200));

/** Stable ID cursor, never an array offset or an implicit complete directory. */
export const SharedDirectoryListInput = Schema.Struct({
  after: Schema.optional(Id),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type SharedDirectoryListInput = typeof SharedDirectoryListInput.Type;

export const SharedProjectDetailInput = Schema.Struct({ sharedProjectId: Id });
export const SharedSpecialistDetailInput = Schema.Struct({ specialistId: Id });

export const SharedProjectSummary = Schema.Struct({
  sharedProjectId: SharedProject.fields.sharedProjectId,
  name: SharedProject.fields.name,
  repository: SharedProject.fields.repository,
  forkOf: SharedProject.fields.forkOf,
});
export type SharedProjectSummary = typeof SharedProjectSummary.Type;
export const SharedSpecialistSummary = Schema.Struct({
  specialistId: SharedSpecialist.fields.specialistId,
  label: SharedSpecialist.fields.label,
  sharedProjectIds: Schema.Array(Id).check(Schema.isMaxLength(32)),
  assignmentVersion: SharedSpecialist.fields.assignmentVersion,
  supersededAt: SharedSpecialist.fields.supersededAt,
  successorId: SharedSpecialist.fields.successorId,
});
export type SharedSpecialistSummary = typeof SharedSpecialistSummary.Type;

export const SharedProjectPage = Schema.Struct({
  items: Schema.Array(SharedProjectSummary),
  nextCursor: Schema.NullOr(Id),
});
export type SharedProjectPage = typeof SharedProjectPage.Type;
export const SharedSpecialistPage = Schema.Struct({
  items: Schema.Array(SharedSpecialistSummary),
  nextCursor: Schema.NullOr(Id),
});
export type SharedSpecialistPage = typeof SharedSpecialistPage.Type;

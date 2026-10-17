import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderOptionSelections } from "./model.ts";
import { SharedNativeTarget, SharedParticipant, SharedSpecialist } from "./sharedWorkspace.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const Instructions = TrimmedNonEmptyString.check(Schema.isMaxLength(32_000));
export const SharedCompositionReference = Schema.Union([
  Schema.Struct({ specialistId: Id, expectedVersion: NonNegativeInt }),
  Schema.Struct({ creationKey: Id }),
]);
export type SharedCompositionReference = typeof SharedCompositionReference.Type;
export const SharedCompositionCreation = Schema.Struct({
  key: Id,
  anchorSharedProjectId: Id,
  instanceId: ProviderInstanceId,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  role: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  instructions: Instructions,
  model: Id,
  options: Schema.optional(ProviderOptionSelections),
  assignments: SharedSpecialist.fields.assignments,
});
export const SharedCompositionRevision = Schema.Struct({
  specialistId: Id,
  expectedVersion: NonNegativeInt,
  label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  assignments: SharedSpecialist.fields.assignments,
  /** Omitted for a directory-only routing change; presence requires native activation. */
  instructions: Schema.optional(Instructions),
});
export const SharedCompositionTransition = Schema.Struct({
  predecessorId: Id,
  expectedVersion: NonNegativeInt,
  successors: Schema.Array(SharedCompositionReference).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
  /** False retains the predecessor for the responsibilities left in its assignments. */
  supersede: Schema.Boolean,
});
export const SharedCompositionInput = Schema.Struct({
  operationId: Id,
  kind: Schema.Literals(["create", "revise", "connect", "split", "consolidate", "supersede"]),
  creations: Schema.Array(SharedCompositionCreation).check(Schema.isMaxLength(8)),
  revisions: Schema.Array(SharedCompositionRevision).check(Schema.isMaxLength(8)),
  peers: Schema.Array(
    Schema.Struct({ source: SharedCompositionReference, target: SharedCompositionReference }),
  ).check(Schema.isMaxLength(16)),
  transitions: Schema.Array(SharedCompositionTransition).check(Schema.isMaxLength(8)),
});
export type SharedCompositionInput = typeof SharedCompositionInput.Type;
export const SharedCompositionEvidence = Schema.Struct({
  step: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  kind: Schema.Literals(["native_identity", "native_revision", "native_peer"]),
  nativeTarget: SharedNativeTarget,
  sessionId: Schema.optional(Id),
  revisionId: Schema.optional(Id),
  peerEdgeId: Schema.optional(Id),
  peerTarget: Schema.optional(SharedNativeTarget),
  observedAt: IsoDateTime,
});
export type SharedCompositionEvidence = typeof SharedCompositionEvidence.Type;
export const SharedCompositionLineage = Schema.Struct({
  predecessorId: Id,
  successorIds: Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  superseded: Schema.Boolean,
});
export const SharedCompositionOperation = Schema.Struct({
  operationKey: Id,
  operationId: Id,
  actor: Schema.Struct({ kind: Schema.Literals(["participant", "specialist"]), id: Id }),
  kind: SharedCompositionInput.fields.kind,
  status: Schema.Literals(["pending", "conflict", "completed"]),
  detail: Schema.NullOr(Schema.String),
  creations: Schema.Array(
    Schema.Struct({ key: Id, nativeTarget: SharedNativeTarget, specialistId: Schema.NullOr(Id) }),
  ),
  evidence: Schema.Array(SharedCompositionEvidence),
  lineage: Schema.Array(SharedCompositionLineage),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SharedCompositionOperation = typeof SharedCompositionOperation.Type;

export const SharedCompositionOperationInput = Schema.Struct({ operationId: Id });
export type SharedCompositionOperationInput = typeof SharedCompositionOperationInput.Type;

/** Read-only responsibility history omits runtime instructions and provider configuration. */
export const SharedCompositionHistoryInput = Schema.Struct({
  specialistId: Id,
  cursor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
});
export type SharedCompositionHistoryInput = typeof SharedCompositionHistoryInput.Type;
export const SharedCompositionHistoryItem = Schema.Struct({
  operation: SharedCompositionOperation,
  /** Current host identity label. The retained actor identity remains in operation.actor. */
  authorDisplayName: Schema.NullOr(SharedParticipant.fields.displayName),
  assignments: Schema.Array(
    Schema.Struct({
      specialistId: Schema.NullOr(Id),
      creationKey: Schema.NullOr(Id),
      label: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
      expectedVersion: Schema.NullOr(NonNegativeInt),
      assignments: SharedSpecialist.fields.assignments,
    }),
  ).check(Schema.isMaxLength(16)),
  transitions: SharedCompositionInput.fields.transitions,
  peers: SharedCompositionInput.fields.peers,
});
export type SharedCompositionHistoryItem = typeof SharedCompositionHistoryItem.Type;
export const SharedCompositionHistory = Schema.Struct({
  items: Schema.Array(SharedCompositionHistoryItem).check(Schema.isMaxLength(20)),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  observedAt: IsoDateTime,
});
export type SharedCompositionHistory = typeof SharedCompositionHistory.Type;

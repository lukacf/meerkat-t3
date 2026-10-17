import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import { ServerAuthDescriptor } from "./auth.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const Label = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(32_768));
const Repository = TrimmedNonEmptyString.check(Schema.isMaxLength(2048));
const Paths = Schema.Array(Schema.String.check(Schema.isMaxLength(1024))).check(
  Schema.isMaxLength(128),
);
const Tags = Schema.Array(Label).check(Schema.isMaxLength(32));

/** App-owned assignments and evidence. No field here is a native lifecycle fact. */
export const SharedWorkspaceLimits = Schema.Struct({
  maxSpecialists: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  maxSnapshotBytes: Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 4_194_304 })),
});
export type SharedWorkspaceLimits = typeof SharedWorkspaceLimits.Type;
export const SharedWorkspace = Schema.Struct({
  workspaceId: Id,
  name: Label,
  limits: SharedWorkspaceLimits,
  createdAt: IsoDateTime,
});
export type SharedWorkspace = typeof SharedWorkspace.Type;
export const SharedWorkspaceConfigureInput = Schema.Struct({
  name: Label,
  limits: Schema.optional(SharedWorkspaceLimits),
});
export type SharedWorkspaceConfigureInput = typeof SharedWorkspaceConfigureInput.Type;

/** Issued by the host from authenticated session identity, never supplied by a publisher. */
export const SharedParticipant = Schema.Struct({
  participantId: Id,
  kind: Schema.Literals(["person", "specialist", "local_agent"]),
  displayName: Label,
  createdAt: IsoDateTime,
  /** Saved remote grant attribution. This does not claim remote native identity attestation. */
  provenance: Schema.optional(
    Schema.Struct({
      kind: Schema.Literal("participant_broker_assertion"),
      delegationId: Id,
      ownerParticipantId: Id,
      localEnvironmentId: EnvironmentId,
      localProjectId: ProjectId,
      localThreadId: ThreadId,
    }),
  ),
});
export type SharedParticipant = typeof SharedParticipant.Type;
export const SharedWorkspaceJoinInput = Schema.Struct({ displayName: Label });
export type SharedWorkspaceJoinInput = typeof SharedWorkspaceJoinInput.Type;

export const SharedProject = Schema.Struct({
  sharedProjectId: Id,
  name: Label,
  repository: Repository,
  aliases: Schema.Array(Repository).check(Schema.isMaxLength(32)),
  /** Explicit ancestry is informational. Forks are not automatic aliases. */
  forkOf: Schema.NullOr(Id),
  hostProjectId: ProjectId,
  createdAt: IsoDateTime,
});
export type SharedProject = typeof SharedProject.Type;
export const SharedProjectRegisterInput = Schema.Struct({
  requestId: Id,
  name: Label,
  repository: Repository,
  aliases: Schema.optional(Schema.Array(Repository).check(Schema.isMaxLength(32))),
  forkOf: Schema.optional(Id),
  hostProjectId: ProjectId,
});
export type SharedProjectRegisterInput = typeof SharedProjectRegisterInput.Type;

export const SharedNativeTarget = Schema.Struct({
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
  agentId: Id,
});
export type SharedNativeTarget = typeof SharedNativeTarget.Type;
export const SharedSpecialistAssignment = Schema.Struct({
  sharedProjectId: Id,
  charter: Text,
  paths: Paths,
  tags: Tags,
});
export type SharedSpecialistAssignment = typeof SharedSpecialistAssignment.Type;
export const SharedSpecialist = Schema.Struct({
  specialistId: Id,
  nativeTarget: SharedNativeTarget,
  label: Label,
  assignments: Schema.Array(SharedSpecialistAssignment).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
  assignmentVersion: NonNegativeInt,
  /** Stops future app assignments only. The predecessor retains its admitted native work. */
  supersededAt: Schema.NullOr(IsoDateTime),
  successorId: Schema.NullOr(Id),
  createdAt: IsoDateTime,
});
export type SharedSpecialist = typeof SharedSpecialist.Type;
export const SharedSpecialistRegisterInput = Schema.Struct({
  requestId: Id,
  nativeTarget: SharedNativeTarget,
  label: Label,
  assignments: SharedSpecialist.fields.assignments,
});
export type SharedSpecialistRegisterInput = typeof SharedSpecialistRegisterInput.Type;

export const SharedCheckout = Schema.Struct({
  checkoutId: Id,
  participantId: Id,
  sharedProjectId: Id,
  localEnvironmentId: EnvironmentId,
  localProjectId: ProjectId,
  repository: Repository,
  /** App association only. Its working tree is not the origin of an observed revision. */
  association: Schema.optional(Schema.Literal("specialist_observation_host")),
  createdAt: IsoDateTime,
});
export type SharedCheckout = typeof SharedCheckout.Type;
export const SharedCheckoutAttachInput = Schema.Struct({
  localEnvironmentId: EnvironmentId,
  localProjectId: ProjectId,
  repository: Repository,
  /** Optional explicit choice must still match a registered repository or alias. */
  sharedProjectId: Schema.optional(Id),
});
export type SharedCheckoutAttachInput = typeof SharedCheckoutAttachInput.Type;

export const SharedRevision = Schema.Struct({
  branch: Label,
  commit: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)),
  applicability: Schema.Literals(["proposal", "branch", "merged"]),
  snapshotId: Schema.optional(Id),
});
export type SharedRevision = typeof SharedRevision.Type;
export const SharedWorkContextInput = Schema.Struct({
  contextId: Id,
  checkoutId: Id,
  source: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
    Schema.Struct({ kind: Schema.Literal("project_conversation") }),
  ]),
  objective: Text,
  revision: SharedRevision,
  paths: Paths,
  tags: Tags,
});
export type SharedWorkContextInput = typeof SharedWorkContextInput.Type;
/** Host-derived proof of a delivered product observation, never a native request binding. */
export const SharedInboxObservationSource = Schema.Struct({
  kind: Schema.Literal("specialist_observation"),
  specialistId: Id,
  batchId: Id,
  eventId: Id,
  sequence: NonNegativeInt,
  sourceContextId: Id,
  sourceContextVersion: Id,
  /** Original revision/snapshot owner, not the observer's host association. */
  revisionCheckoutId: Id,
});
export type SharedInboxObservationSource = typeof SharedInboxObservationSource.Type;
export const SharedWorkContext = Schema.Struct({
  ...SharedWorkContextInput.fields,
  source: Schema.Union([SharedWorkContextInput.fields.source, SharedInboxObservationSource]),
  /** Immutable content version, retained even after this task's current context changes. */
  contextVersion: Id,
  participantId: Id,
  sharedProjectId: Id,
  updatedAt: IsoDateTime,
});
export type SharedWorkContext = typeof SharedWorkContext.Type;
export const SharedSource = Schema.Struct({
  title: Label,
  uri: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  native: Schema.optional(
    Schema.Struct({
      owner: Schema.Literals(["core", "meta", "workgraph"]),
      reference: Id,
      stream: Id,
      cursor: Id,
    }),
  ),
});
export type SharedSource = typeof SharedSource.Type;
const Sources = Schema.Array(SharedSource).check(Schema.isMaxLength(64));

export const SharedActivityKind = Schema.Literals([
  "task_started",
  "objective_changed",
  "finding",
  "decision",
  "blocker",
  "changes",
  "test_result",
  "commit",
  "pull_request",
  "merge",
  "abandoned",
  "briefing",
  "correction",
]);
export const SharedActivityPublishInput = Schema.Struct({
  eventId: Id,
  contextId: Id,
  contextVersion: Id,
  /** Required even if unchanged, so a delayed retry cannot silently acquire a newer revision. */
  revision: SharedRevision,
  kind: SharedActivityKind,
  summary: Text,
  paths: Paths,
  tags: Tags,
  sources: Sources,
  recipientIds: Schema.optional(Schema.Array(Id).check(Schema.isMaxLength(128))),
});
export type SharedActivityPublishInput = typeof SharedActivityPublishInput.Type;
export const SharedActivityFromInboxInput = Schema.Struct({
  source: Schema.Struct({ batchId: Id, eventId: Id }),
  eventId: Id,
  kind: SharedActivityKind,
  summary: Text,
  /** Additional evidence. Original source references are retained by the host. */
  sources: Schema.optional(Sources),
});
export type SharedActivityFromInboxInput = typeof SharedActivityFromInboxInput.Type;
export const SharedActivity = Schema.Struct({
  ...SharedActivityPublishInput.fields,
  /** Product evidence references, attached atomically when a correction is recorded. */
  knowledge: Schema.optional(
    Schema.Struct({ evidenceId: Id, supersedes: Schema.Array(Id).check(Schema.isMaxLength(64)) }),
  ),
  sequence: NonNegativeInt,
  author: SharedParticipant,
  context: SharedWorkContext,
  createdAt: IsoDateTime,
});
export type SharedActivity = typeof SharedActivity.Type;
export const SharedInboxReadInput = Schema.Struct({
  recipientId: Schema.optional(Id),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type SharedInboxReadInput = typeof SharedInboxReadInput.Type;
export const SharedInbox = Schema.Struct({
  recipientId: Id,
  /** A sealed product batch. Its acknowledgement says nothing about native execution. */
  batchId: Schema.NullOr(Id),
  events: Schema.Array(SharedActivity),
  hasMore: Schema.Boolean,
});
export type SharedInbox = typeof SharedInbox.Type;
export const SharedInboxAcknowledgeInput = Schema.Struct({
  recipientId: Schema.optional(Id),
  batchId: Id,
});
export type SharedInboxAcknowledgeInput = typeof SharedInboxAcknowledgeInput.Type;

export const SharedSnapshotPutInput = Schema.Struct({
  checkoutId: Id,
  revision: SharedRevision,
  patch: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_194_304)),
});
export type SharedSnapshotPutInput = typeof SharedSnapshotPutInput.Type;
export const SharedSnapshot = Schema.Struct({
  snapshotId: Id,
  sharedProjectId: Id,
  checkoutId: Id,
  revision: SharedRevision,
  sha256: Id,
  bytes: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type SharedSnapshot = typeof SharedSnapshot.Type;

export const SharedKnowledgeKind = Schema.Literals([
  "finding",
  "decision",
  "incident",
  "resolution",
  "investigation",
  "commitment",
]);
export const SharedKnowledgePutInput = Schema.Struct({
  evidenceId: Id,
  contextId: Id,
  contextVersion: Id,
  revision: SharedRevision,
  kind: SharedKnowledgeKind,
  title: Label,
  body: Text,
  sources: Sources,
  supersedes: Schema.Array(Id).check(Schema.isMaxLength(64)),
  state: Schema.Literals(["open", "resolved", "abandoned"]),
});
export type SharedKnowledgePutInput = typeof SharedKnowledgePutInput.Type;
export const SharedKnowledgeFromInboxInput = Schema.Struct({
  source: SharedActivityFromInboxInput.fields.source,
  evidenceId: Id,
  kind: SharedKnowledgeKind,
  title: Label,
  body: Text,
  sources: Schema.optional(Sources),
  supersedes: SharedKnowledgePutInput.fields.supersedes,
  state: SharedKnowledgePutInput.fields.state,
});
export type SharedKnowledgeFromInboxInput = typeof SharedKnowledgeFromInboxInput.Type;
export const SharedKnowledge = Schema.Struct({
  ...SharedKnowledgePutInput.fields,
  observationSource: Schema.optional(SharedInboxObservationSource),
  sharedProjectId: Id,
  author: SharedParticipant,
  createdAt: IsoDateTime,
});
export type SharedKnowledge = typeof SharedKnowledge.Type;
export const SharedKnowledgeSearchInput = Schema.Struct({
  /** Exact retrieval and correction-lineage paging do not depend on full-text matches. */
  evidenceId: Schema.optional(Id),
  supersedes: Schema.optional(Id),
  sharedProjectId: Schema.optional(Id),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  branch: Schema.optional(Label),
  commit: Schema.optional(SharedRevision.fields.commit),
  kind: Schema.optional(SharedKnowledgeKind),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  /** Opaque exclusive position returned by the previous page, not an evidence identity. */
  cursor: Schema.optional(Schema.String.check(Schema.isPattern(/^knowledge:[1-9][0-9]{0,18}$/))),
});
export type SharedKnowledgeSearchInput = typeof SharedKnowledgeSearchInput.Type;

export const SharedKnowledgeCorrection = Schema.Struct({
  evidenceId: Id,
  title: Label,
  contextId: Id,
  contextVersion: Id,
  revision: SharedRevision,
  author: SharedParticipant,
  createdAt: IsoDateTime,
});
export const SharedKnowledgeSearchHit = Schema.Struct({
  ...SharedKnowledge.fields,
  /** Reverse lineage is observed at query time; the original evidence stays immutable. */
  corrections: Schema.Array(SharedKnowledgeCorrection).check(Schema.isMaxLength(8)),
  /** Page all direct corrections with search({supersedes: evidenceId}). */
  hasMoreCorrections: Schema.Boolean,
});
export type SharedKnowledgeSearchHit = typeof SharedKnowledgeSearchHit.Type;
export const SharedKnowledgeSearchResult = Schema.Struct({
  records: Schema.Array(SharedKnowledgeSearchHit),
  hasMore: Schema.Boolean,
  nextCursor: Schema.NullOr(Schema.String.check(Schema.isPattern(/^knowledge:[1-9][0-9]{0,18}$/))),
});
export type SharedKnowledgeSearchResult = typeof SharedKnowledgeSearchResult.Type;

/** Product storage accounting, not disk size, native backlog or lifecycle truth. */
export const SharedWorkspaceCapacity = Schema.Struct({
  evidence: Schema.Struct({
    bytes: NonNegativeInt,
    maxBytes: NonNegativeInt,
    records: NonNegativeInt,
    maxRecords: NonNegativeInt,
  }),
  inbox: Schema.Struct({ pending: NonNegativeInt, maxPending: NonNegativeInt }),
  specialists: Schema.Struct({
    registeredAndReserved: NonNegativeInt,
    maxSpecialists: NonNegativeInt,
  }),
  /** Retained app requests without an observed terminal outcome. */
  pendingRequests: NonNegativeInt,
  pendingCompositionOperations: NonNegativeInt,
});
export type SharedWorkspaceCapacity = typeof SharedWorkspaceCapacity.Type;

export const SharedWorkspaceSnapshot = Schema.Struct({
  workspace: Schema.NullOr(SharedWorkspace),
  participant: Schema.NullOr(SharedParticipant),
  projects: Schema.Array(SharedProject),
  specialists: Schema.Array(SharedSpecialist),
  checkouts: Schema.Array(SharedCheckout),
  capacity: Schema.optional(SharedWorkspaceCapacity),
});
export type SharedWorkspaceSnapshot = typeof SharedWorkspaceSnapshot.Type;

export class SharedWorkspaceError extends Schema.TaggedError<SharedWorkspaceError>()(
  "SharedWorkspaceError",
  {
    code: Schema.Literals([
      "not_configured",
      "not_joined",
      "not_found",
      "conflict",
      "invalid_input",
      "forbidden",
      "limit_exceeded",
      "unavailable",
    ]),
    message: Schema.String,
  },
) {}

/** The shared connection bootstrap deliberately omits host settings and files. */
export const SharedWorkspaceSession = Schema.Struct({
  environment: ExecutionEnvironmentDescriptor,
  auth: ServerAuthDescriptor,
  snapshot: SharedWorkspaceSnapshot,
  permissions: Schema.Struct({
    read: Schema.Boolean,
    contribute: Schema.Boolean,
    admin: Schema.Boolean,
  }),
});
export type SharedWorkspaceSession = typeof SharedWorkspaceSession.Type;

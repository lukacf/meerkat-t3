import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { MeerkatImageRef, MEERKAT_MAX_IMAGES } from "./meerkatMedia.ts";
import { ModelSelection } from "./orchestration.ts";
import { ProviderOptionSelections } from "./model.ts";
import { OrchestrationMessageContext } from "./composerContext.ts";

/** Canonical MobKit console records. Native labels and health retain their native meaning. */
export const ConsoleIdentityRecord = Schema.Struct({
  identity: Schema.String,
  display_name: Schema.String,
  runtime_key: Schema.String,
  runtime_member_id: Schema.String,
  session_id: Schema.optional(Schema.String),
  visibility: Schema.Literals(["addressable", "hidden", "retired_readable", "unreachable"]),
  addressable: Schema.Boolean,
  health: Schema.String,
  topology_peers: Schema.optional(Schema.Array(Schema.String)),
  labels: Schema.Record(Schema.String, Schema.String),
});
export type ConsoleIdentityRecord = typeof ConsoleIdentityRecord.Type;

export const ConsoleFrame = Schema.Struct({
  id: Schema.String,
  cursor: Schema.String,
  dedupe_key: Schema.String,
  timestamp_ms: NonNegativeInt,
  runtime_key: Schema.String,
  identity: Schema.String,
  kind: Schema.String,
  status: Schema.Literals([
    "accepted",
    "dispatching",
    "delivered",
    "delivery_failed",
    "completed",
    "redacted",
  ]),
  frame_version: NonNegativeInt,
  payload: Schema.Unknown,
  source: Schema.Struct({
    kind: Schema.Literals(["console_event", "session_history", "send", "synthetic"]),
    source_cursor: Schema.optional(Schema.String),
  }),
  conversation_id: Schema.optional(Schema.String),
  session_id: Schema.optional(Schema.String),
  updated_at_ms: Schema.optional(NonNegativeInt),
  source_event_id: Schema.optional(Schema.String),
  interaction_id: Schema.optional(Schema.String),
  turn_id: Schema.optional(Schema.String),
  run_id: Schema.optional(Schema.String),
  parent_frame_id: Schema.optional(Schema.String),
  caused_by_frame_id: Schema.optional(Schema.String),
});
export type ConsoleFrame = typeof ConsoleFrame.Type;

export const ConsoleTimelineWindowPage = Schema.Struct({
  frames: Schema.Array(ConsoleFrame),
  next_cursor: Schema.optional(Schema.String),
  latest_cursor: Schema.optional(Schema.String),
  exhausted: Schema.optional(Schema.Boolean),
});
export type ConsoleTimelineWindowPage = typeof ConsoleTimelineWindowPage.Type;

/** Committed native session messages, kept separate from the console event log. */
export const MeerkatSavedTranscript = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  storeRevision: TrimmedNonEmptyString,
  messages: Schema.Array(Schema.Struct({ offset: NonNegativeInt, message: Schema.Unknown })),
  totalMessages: NonNegativeInt,
  exhausted: Schema.Boolean,
  nextBefore: Schema.optional(NonNegativeInt),
});
export type MeerkatSavedTranscript = typeof MeerkatSavedTranscript.Type;
export const MeerkatAgentHistory = Schema.Struct({
  timeline: ConsoleTimelineWindowPage,
  transcript: Schema.optional(MeerkatSavedTranscript),
  historyStatus: Schema.optional(Schema.Literal("partial")),
});
export type MeerkatAgentHistory = typeof MeerkatAgentHistory.Type;

/** Observed native session settings, never a replacement for next-message intent. */
export const MeerkatAgentReasoningObservation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("default") }),
  Schema.Struct({ kind: Schema.Literal("unknown") }),
  Schema.Struct({
    kind: Schema.Literal("configured"),
    values: Schema.Array(
      Schema.Struct({
        parameter: Schema.Literals([
          "reasoning_effort",
          "effort",
          "thinking_level",
          "thinking",
          "thinking_budget",
        ]),
        value: TrimmedNonEmptyString,
      }),
    ).check(Schema.isMinLength(1)),
  }),
]);
export type MeerkatAgentReasoningObservation = typeof MeerkatAgentReasoningObservation.Type;

export const MeerkatAgentWork = Schema.Struct({
  status: Schema.Literals(["running", "idle", "unknown", "unloaded"]),
  observedAt: IsoDateTime,
  interactionId: Schema.optional(Schema.String),
  nativeRunId: Schema.optional(TrimmedNonEmptyString),
  latestCompletion: Schema.optional(
    Schema.Union([
      Schema.Struct({
        interactionId: Schema.String,
        status: Schema.Literals(["completed", "failed"]),
        timestampMs: NonNegativeInt,
      }),
      Schema.Struct({
        kind: Schema.Literal("runtime_input"),
        sessionId: TrimmedNonEmptyString,
        inputId: TrimmedNonEmptyString,
        runId: TrimmedNonEmptyString,
        status: Schema.Literals(["completed", "failed"]),
        timestampMs: NonNegativeInt,
      }),
    ]),
  ),
  model: Schema.optional(Schema.String),
  modelProvider: Schema.optional(TrimmedNonEmptyString),
  reasoning: Schema.optional(MeerkatAgentReasoningObservation),
  objective: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.String),
});
export type MeerkatAgentWork = typeof MeerkatAgentWork.Type;

export const MeerkatTeamAgent = Schema.Struct({
  canResume: Schema.optional(Schema.Boolean),
  durableId: Schema.optional(Schema.String),
  availability: Schema.optional(Schema.Literals(["live", "unloaded", "retired", "unknown"])),
  lastSeenAt: Schema.optional(IsoDateTime),
  work: Schema.optional(MeerkatAgentWork),
  agentRef: TrimmedNonEmptyString,
  mobId: Schema.String,
  mobLabel: Schema.String,
  mobKind: Schema.String,
  scopeLabel: Schema.String,
  projectAgentId: Schema.optional(Schema.String),
  threadId: Schema.optional(ThreadId),
  record: ConsoleIdentityRecord,
});
export type MeerkatTeamAgent = typeof MeerkatTeamAgent.Type;

export const MeerkatTeamProvider = Schema.Struct({
  instanceId: ProviderInstanceId,
  label: Schema.String,
  status: Schema.Literals(["ready", "partial", "unavailable", "disabled"]),
  errors: Schema.Array(Schema.String),
  totalScopeCount: NonNegativeInt,
  unloadedScopeCount: NonNegativeInt,
  loadedMobCount: NonNegativeInt,
  agents: Schema.Array(MeerkatTeamAgent),
});
export type MeerkatTeamProvider = typeof MeerkatTeamProvider.Type;

export const MeerkatProjectAgentPreparation = Schema.Struct({
  assignmentId: Schema.String,
  fingerprint: Schema.String,
  attempt: NonNegativeInt,
  revisionVersion: Schema.optional(NonNegativeInt),
  status: Schema.Literals([
    "queued",
    "dispatching",
    "studying",
    "ready",
    "failed",
    "interrupted",
    "uncertain",
  ]),
  requestId: Schema.String,
  interactionId: Schema.NullOr(Schema.String),
  inputFrameId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
  evidence: Schema.optional(
    Schema.Struct({
      contentFingerprint: Schema.String,
      fileCount: NonNegativeInt,
      capturedAt: IsoDateTime,
      paths: Schema.Array(Schema.String),
      excludedDirectories: Schema.Array(Schema.String),
    }),
  ),
});
export type MeerkatProjectAgentPreparation = typeof MeerkatProjectAgentPreparation.Type;

export const MeerkatProjectAgentRevision = Schema.Struct({
  revisionId: Schema.String,
  requestId: Schema.String,
  version: NonNegativeInt,
  instructions: Schema.String,
  focus: Schema.String,
  charter: Schema.String,
  ownershipPaths: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type MeerkatProjectAgentRevision = typeof MeerkatProjectAgentRevision.Type;

/** Project specialists currently support fixed native policies, without per-tool approvals. */
export const MeerkatProjectAgentAccessMode = Schema.Literals(["read-only", "full-access"]);
export type MeerkatProjectAgentAccessMode = typeof MeerkatProjectAgentAccessMode.Type;

export const MeerkatProjectAgent = Schema.Struct({
  agentId: TrimmedNonEmptyString,
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
  label: TrimmedNonEmptyString,
  role: TrimmedNonEmptyString,
  instructions: TrimmedNonEmptyString,
  focus: Schema.optional(Schema.String),
  charter: Schema.optional(Schema.String),
  ownershipPaths: Schema.optional(Schema.Array(Schema.String)),
  preparation: Schema.optional(Schema.NullOr(MeerkatProjectAgentPreparation)),
  revisionVersion: Schema.optional(NonNegativeInt),
  pendingRevision: Schema.optional(Schema.NullOr(MeerkatProjectAgentRevision)),
  model: TrimmedNonEmptyString,
  options: Schema.optional(ProviderOptionSelections),
  // Optional only for compatibility with servers predating explicit specialist permissions.
  accessMode: Schema.optional(MeerkatProjectAgentAccessMode),
  enabled: Schema.Boolean,
  archived: Schema.Boolean,
  connectionStatus: Schema.Literals(["unloaded", "connecting", "connected", "error", "disabled"]),
  error: Schema.NullOr(Schema.String),
  agentRef: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type MeerkatProjectAgent = typeof MeerkatProjectAgent.Type;

const AgentLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
const AgentInstructions = TrimmedNonEmptyString.check(Schema.isMaxLength(32_000));
export const MeerkatProjectAgentCreateInput = Schema.Struct({
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
  requestId: TrimmedNonEmptyString,
  label: AgentLabel,
  role: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  instructions: AgentInstructions,
  model: TrimmedNonEmptyString,
  options: Schema.optional(ProviderOptionSelections),
  /** Omitted by older clients; new specialists default to read-only. */
  accessMode: Schema.optional(MeerkatProjectAgentAccessMode),
});
export type MeerkatProjectAgentCreateInput = typeof MeerkatProjectAgentCreateInput.Type;
export const MeerkatProjectAgentUpdateInput = Schema.Struct({
  projectId: ProjectId,
  agentId: TrimmedNonEmptyString,
  label: Schema.optional(AgentLabel),
  revision: Schema.optional(
    Schema.Struct({
      requestId: TrimmedNonEmptyString,
      instructions: AgentInstructions,
      focus: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
      charter: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
      ownershipPaths: Schema.Array(TrimmedNonEmptyString).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(64),
      ),
    }),
  ),
  applyPending: Schema.optional(Schema.Boolean),
});
export type MeerkatProjectAgentUpdateInput = typeof MeerkatProjectAgentUpdateInput.Type;
export const MeerkatProjectAgentLifecycleInput = Schema.Struct({
  projectId: ProjectId,
  agentId: TrimmedNonEmptyString,
  action: Schema.Literals(["connect", "disconnect", "archive", "unarchive"]),
});
export type MeerkatProjectAgentLifecycleInput = typeof MeerkatProjectAgentLifecycleInput.Type;
export const MeerkatAgentSendInput = Schema.Struct({
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
  agentRef: TrimmedNonEmptyString,
  requestId: TrimmedNonEmptyString,
  text: Schema.String.check(Schema.isMaxLength(64_000)),
  handlingMode: Schema.Literals(["queue", "steer"]),
  images: Schema.optional(
    Schema.Array(MeerkatImageRef).check(Schema.isMaxLength(MEERKAT_MAX_IMAGES)),
  ),
  modelSelection: Schema.optional(ModelSelection),
  context: Schema.optional(OrchestrationMessageContext),
});
export type MeerkatAgentSendInput = typeof MeerkatAgentSendInput.Type;
export const MeerkatAgentLifecycleInput = Schema.Struct({
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
  agentRef: TrimmedNonEmptyString,
});
export type MeerkatAgentLifecycleInput = typeof MeerkatAgentLifecycleInput.Type;
export const MeerkatAgentStopInput = Schema.Struct({
  ...MeerkatAgentLifecycleInput.fields,
  nativeRunId: TrimmedNonEmptyString,
});
export type MeerkatAgentStopInput = typeof MeerkatAgentStopInput.Type;
export const MeerkatAgentControlReceipt = Schema.Struct({
  status: Schema.Literals(["accepted", "uncertain"]),
  requestId: Schema.NullOr(Schema.String),
  receipt: Schema.Unknown,
  message: Schema.NullOr(Schema.String),
});
export type MeerkatAgentControlReceipt = typeof MeerkatAgentControlReceipt.Type;
/** Null means no saved delivery was found; it is not permission to replay the request. */
export const MeerkatAgentDeliveryReconcileResult = Schema.NullOr(MeerkatAgentControlReceipt);
export type MeerkatAgentDeliveryReconcileResult = typeof MeerkatAgentDeliveryReconcileResult.Type;

export const MeerkatProjectTeamInput = Schema.Struct({ projectId: ProjectId });
export type MeerkatProjectTeamInput = typeof MeerkatProjectTeamInput.Type;
export const MeerkatProjectTeam = Schema.Struct({
  projectId: ProjectId,
  observedAt: IsoDateTime,
  observation: Schema.Literal("loaded_runtimes"),
  providers: Schema.Array(MeerkatTeamProvider),
  projectAgents: Schema.Array(MeerkatProjectAgent),
});
export type MeerkatProjectTeam = typeof MeerkatProjectTeam.Type;

export const MeerkatAgentActivityInput = Schema.Struct({
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
  agentRef: TrimmedNonEmptyString,
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  before: Schema.optional(TrimmedNonEmptyString),
  after: Schema.optional(TrimmedNonEmptyString),
  mode: Schema.optional(Schema.Literals(["recent", "since"])),
  transcriptBefore: Schema.optional(NonNegativeInt),
  transcriptRevision: Schema.optional(TrimmedNonEmptyString),
});
export type MeerkatAgentActivityInput = typeof MeerkatAgentActivityInput.Type;
export const MeerkatAgentActivity = Schema.Struct({
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
  agentRef: TrimmedNonEmptyString,
  observedAt: IsoDateTime,
  timeline: ConsoleTimelineWindowPage,
  transcript: Schema.optional(MeerkatSavedTranscript),
  historyStatus: MeerkatAgentHistory.fields.historyStatus,
  agent: Schema.optional(MeerkatTeamAgent),
});
export type MeerkatAgentActivity = typeof MeerkatAgentActivity.Type;

export class MeerkatTeamError extends Schema.TaggedError<MeerkatTeamError>()("MeerkatTeamError", {
  operation: Schema.Literals([
    "project-team",
    "agent-activity",
    "project-agent",
    "agent-control",
    "agent-connections",
  ]),
  projectId: ProjectId,
  message: Schema.String,
}) {}

export const MeerkatProjectAgents = Schema.Struct({
  projectId: ProjectId,
  agents: Schema.Array(MeerkatProjectAgent),
});
export type MeerkatProjectAgents = typeof MeerkatProjectAgents.Type;
export const MeerkatThreadConnectionsInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  instanceId: ProviderInstanceId,
});
export type MeerkatThreadConnectionsInput = typeof MeerkatThreadConnectionsInput.Type;
export const MeerkatThreadConnectionsSetInput = Schema.Struct({
  ...MeerkatThreadConnectionsInput.fields,
  agentIds: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(8)),
  requestId: TrimmedNonEmptyString,
});
export type MeerkatThreadConnectionsSetInput = typeof MeerkatThreadConnectionsSetInput.Type;
export const MeerkatThreadConnections = Schema.Struct({
  ...MeerkatThreadConnectionsInput.fields,
  explicit: Schema.Boolean,
  desiredAgentIds: Schema.Array(Schema.String),
  connections: Schema.Array(
    Schema.Struct({
      agentId: Schema.String,
      status: Schema.Literals(["connected", "disconnected", "unloaded", "error"]),
      error: Schema.NullOr(Schema.String),
      snapshot: Schema.Unknown,
    }),
  ),
});
export type MeerkatThreadConnections = typeof MeerkatThreadConnections.Type;

export const MeerkatPeerEndpoint = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project-agent"),
    projectId: ProjectId,
    instanceId: ProviderInstanceId,
    agentId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread"),
    projectId: ProjectId,
    instanceId: ProviderInstanceId,
    threadId: ThreadId,
  }),
]);
export type MeerkatPeerEndpoint = typeof MeerkatPeerEndpoint.Type;
export const MeerkatPeerConnectionsInput = Schema.Struct({ endpoint: MeerkatPeerEndpoint });
export type MeerkatPeerConnectionsInput = typeof MeerkatPeerConnectionsInput.Type;
export const MeerkatPeerConnectionSetInput = Schema.Struct({
  source: MeerkatPeerEndpoint,
  target: MeerkatPeerEndpoint,
  connected: Schema.Boolean,
  requestId: TrimmedNonEmptyString,
});
export type MeerkatPeerConnectionSetInput = typeof MeerkatPeerConnectionSetInput.Type;
export const MeerkatPeerConnection = Schema.Struct({
  edgeId: Schema.String,
  source: MeerkatPeerEndpoint,
  target: MeerkatPeerEndpoint,
  desired: Schema.Boolean,
  status: Schema.Literals(["connected", "disconnected", "unloaded", "error"]),
  error: Schema.NullOr(Schema.String),
});
export type MeerkatPeerConnection = typeof MeerkatPeerConnection.Type;
export const MeerkatPeerConnections = Schema.Struct({
  endpoint: MeerkatPeerEndpoint,
  connections: Schema.Array(MeerkatPeerConnection),
});
export type MeerkatPeerConnections = typeof MeerkatPeerConnections.Type;

export const MeerkatProjectAgentProposalCandidate = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  role: TrimmedNonEmptyString,
  focus: TrimmedNonEmptyString,
  charter: TrimmedNonEmptyString,
  recommended: Schema.Boolean,
  ownershipPaths: Schema.Array(TrimmedNonEmptyString),
});
export type MeerkatProjectAgentProposalCandidate = typeof MeerkatProjectAgentProposalCandidate.Type;
export const MeerkatProjectAgentProposal = Schema.Struct({
  proposalId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  summary: Schema.NullOr(Schema.String),
  agents: Schema.Array(MeerkatProjectAgentProposalCandidate),
});
export type MeerkatProjectAgentProposal = typeof MeerkatProjectAgentProposal.Type;
export const MeerkatProjectProposalInput = Schema.Struct({
  projectId: ProjectId,
  instanceId: Schema.optional(ProviderInstanceId),
  sourceThreadId: Schema.optional(ThreadId),
});
export type MeerkatProjectProposalInput = typeof MeerkatProjectProposalInput.Type;
export const MeerkatProjectProposal = Schema.Struct({
  projectId: ProjectId,
  isSetupThread: Schema.Boolean,
  isSourceThreadPersisted: Schema.Boolean,
  sourceThreadId: Schema.NullOr(ThreadId),
  instanceId: Schema.NullOr(ProviderInstanceId),
  model: Schema.NullOr(Schema.String),
  available: Schema.Boolean,
  status: Schema.Literals(["unavailable", "none", "pending", "invalid", "ready"]),
  error: Schema.NullOr(Schema.String),
  proposal: Schema.NullOr(MeerkatProjectAgentProposal),
});
export type MeerkatProjectProposal = typeof MeerkatProjectProposal.Type;
export const MeerkatProjectProposalSetupInput = Schema.Struct({
  projectId: ProjectId,
  sourceThreadId: ThreadId,
  instanceId: ProviderInstanceId,
});
export type MeerkatProjectProposalSetupInput = typeof MeerkatProjectProposalSetupInput.Type;
export const MeerkatProjectProposalCreateInput = Schema.Struct({
  projectId: ProjectId,
  sourceThreadId: ThreadId,
  proposalId: TrimmedNonEmptyString,
  candidateIds: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(6)),
  /** Applies to newly created specialists. Existing agents retain their native policy. */
  accessMode: Schema.optional(MeerkatProjectAgentAccessMode),
});
export type MeerkatProjectProposalCreateInput = typeof MeerkatProjectProposalCreateInput.Type;
export const MeerkatProjectProposalCreateResult = Schema.Struct({
  projectId: ProjectId,
  sourceThreadId: ThreadId,
  proposalId: Schema.String,
  results: Schema.Array(
    Schema.Struct({
      candidateId: Schema.String,
      agent: Schema.NullOr(MeerkatProjectAgent),
      error: Schema.NullOr(Schema.String),
    }),
  ),
});
export type MeerkatProjectProposalCreateResult = typeof MeerkatProjectProposalCreateResult.Type;
export const MeerkatProjectAgentPrepareInput = Schema.Struct({
  projectId: ProjectId,
  agentId: TrimmedNonEmptyString,
  retry: Schema.optional(Schema.Boolean),
  refresh: Schema.optional(Schema.Boolean),
});
export type MeerkatProjectAgentPrepareInput = typeof MeerkatProjectAgentPrepareInput.Type;

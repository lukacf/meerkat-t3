import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const MeerkatControlScope = Schema.Struct({
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
});
export const MeerkatAuthScope = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: Schema.optional(ProjectId),
  threadTarget: Schema.optional(
    Schema.Struct({
      threadId: ThreadId,
      // A stale-link fence. The server resolves the directory from the thread.
      expectedCwd: TrimmedNonEmptyString,
    }),
  ),
});
export type MeerkatAuthScope = typeof MeerkatAuthScope.Type;
export const MeerkatQuestionTarget = Schema.Struct({
  ...MeerkatControlScope.fields,
  agentRef: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(ThreadId),
});
export type MeerkatQuestionTarget = typeof MeerkatQuestionTarget.Type;
export const MeerkatQuestion = Schema.Struct({
  id: TrimmedNonEmptyString,
  question: TrimmedNonEmptyString,
  options: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      label: TrimmedNonEmptyString,
      description: Schema.String,
    }),
  ),
  allowCustom: Schema.Boolean,
  multiSelect: Schema.Boolean,
});
export const MeerkatPendingQuestion = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  mobId: TrimmedNonEmptyString,
  toolCallId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  title: TrimmedNonEmptyString,
  questions: Schema.Array(MeerkatQuestion),
});
export type MeerkatPendingQuestion = typeof MeerkatPendingQuestion.Type;
export const MeerkatQuestions = Schema.Struct({ requests: Schema.Array(MeerkatPendingQuestion) });
export const MeerkatQuestionAnswerInput = Schema.Struct({
  ...MeerkatQuestionTarget.fields,
  requestId: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  answers: Schema.Array(
    Schema.Struct({
      questionId: TrimmedNonEmptyString,
      selectedOptionIds: Schema.Array(Schema.String),
      customText: Schema.String.check(Schema.isMaxLength(16_000)),
    }),
  ),
  dismissed: Schema.Boolean,
});
export type MeerkatQuestionAnswerInput = typeof MeerkatQuestionAnswerInput.Type;
export const MeerkatQuestionAnswerReceipt = Schema.Struct({
  accepted: Schema.Boolean,
  requestId: TrimmedNonEmptyString,
});

export const MeerkatAuthConnection = Schema.Struct({
  provider: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  realmId: Schema.String,
  bindingId: Schema.String,
  profileId: Schema.String,
  source: Schema.String,
  state: Schema.Literals(["connected", "needs_auth", "reauth_required", "host_managed", "unknown"]),
  credentialObservation: Schema.optional(
    Schema.NullOr(
      Schema.Literals([
        "not_observed",
        "pending",
        "unavailable",
        "denied",
        "interaction_required",
        "owner_busy",
      ]),
    ),
  ),
  supportsInteractiveLogin: Schema.Boolean,
  authMethod: Schema.optional(Schema.String),
  backendKind: Schema.optional(Schema.String),
  loginFlow: Schema.optional(Schema.NullOr(Schema.Literals(["browser", "device"]))),
  editable: Schema.optional(Schema.Boolean),
  supportsSecretUpdate: Schema.optional(Schema.Boolean),
  supportsDefault: Schema.optional(Schema.Boolean),
  supportsRemoval: Schema.optional(Schema.Boolean),
  isDefault: Schema.optional(Schema.Boolean),
  expiresAt: Schema.optional(Schema.NullOr(Schema.String)),
  accountId: Schema.optional(Schema.NullOr(Schema.String)),
  accountLabel: Schema.optional(Schema.String),
  credentialAccount: Schema.optional(
    Schema.Struct({ realm: TrimmedNonEmptyString, account: TrimmedNonEmptyString }),
  ),
  hasRefreshToken: Schema.optional(Schema.Boolean),
  fields: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  modelsVerified: Schema.optional(Schema.Boolean),
  models: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: TrimmedNonEmptyString,
        displayName: Schema.String,
        tier: Schema.String,
        recommended: Schema.Boolean,
      }),
    ),
  ),
});
export type MeerkatAuthConnection = typeof MeerkatAuthConnection.Type;
export const MeerkatAuthMethod = Schema.Struct({
  id: TrimmedNonEmptyString,
  provider: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  authMethod: TrimmedNonEmptyString,
  backendKind: TrimmedNonEmptyString,
  flow: Schema.Literals(["browser", "device", "secret", "host"]),
  callback: Schema.optional(
    Schema.Struct({
      redirectHost: Schema.Literals(["localhost", "127.0.0.1"]),
      path: TrimmedNonEmptyString,
      ports: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 }))),
    }),
  ),
  description: Schema.String,
  secretLabel: Schema.optional(TrimmedNonEmptyString),
  fields: Schema.Array(
    Schema.Struct({
      key: TrimmedNonEmptyString,
      label: TrimmedNonEmptyString,
      required: Schema.Boolean,
      secret: Schema.Boolean,
    }),
  ),
});
export type MeerkatAuthMethod = typeof MeerkatAuthMethod.Type;
export const MeerkatAuthOverview = Schema.Struct({
  connections: Schema.Array(MeerkatAuthConnection),
  methods: Schema.optional(Schema.Array(MeerkatAuthMethod)),
  workspace: Schema.optional(
    Schema.Struct({
      projectId: ProjectId,
      threadId: Schema.optional(ThreadId),
      cwd: TrimmedNonEmptyString,
    }),
  ),
});
export const MeerkatAuthActionInput = Schema.Struct({
  ...MeerkatAuthScope.fields,
  provider: TrimmedNonEmptyString,
  action: Schema.Literals([
    "start",
    "complete",
    "status",
    "cancel",
    "logout",
    "configure",
    "check",
    "delete",
    "default",
    "deviceStart",
    "devicePoll",
  ]),
  realmId: Schema.optional(TrimmedNonEmptyString),
  bindingId: Schema.optional(TrimmedNonEmptyString),
  profileId: Schema.optional(TrimmedNonEmptyString),
  methodId: Schema.optional(TrimmedNonEmptyString),
  fields: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  secret: Schema.optional(Schema.String.check(Schema.isMaxLength(32_000))),
  flowId: Schema.optional(TrimmedNonEmptyString),
  callbackUrl: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(8_000))),
});
export type MeerkatAuthActionInput = typeof MeerkatAuthActionInput.Type;
export const MeerkatAuthDefaultActivation = Schema.Struct({
  status: Schema.Literals(["updated", "unchanged", "needs_selection"]),
  // Only native defaults changed by this operation. Unchanged does not imply selected.
  providers: Schema.Array(TrimmedNonEmptyString),
});
export type MeerkatAuthDefaultActivation = typeof MeerkatAuthDefaultActivation.Type;
export const MeerkatAuthFlow = Schema.Struct({
  flowId: Schema.NullOr(Schema.String),
  authorizeUrl: Schema.NullOr(Schema.String),
  status: Schema.Literals(["waiting", "connected", "cancelled", "disconnected", "failed"]),
  message: Schema.NullOr(Schema.String),
  connection: Schema.optional(MeerkatAuthConnection),
  defaultActivation: Schema.optional(MeerkatAuthDefaultActivation),
  credentialsSaved: Schema.optional(Schema.Boolean),
  userCode: Schema.optional(Schema.String),
  verificationUri: Schema.optional(Schema.String),
  verificationUriComplete: Schema.optional(Schema.NullOr(Schema.String)),
  expiresAt: Schema.optional(Schema.String),
  intervalSeconds: Schema.optional(Schema.Number),
});
export type MeerkatAuthFlow = typeof MeerkatAuthFlow.Type;

export class MeerkatControlError extends Schema.TaggedError<MeerkatControlError>()(
  "MeerkatControlError",
  {
    projectId: Schema.optional(ProjectId),
    message: Schema.String,
  },
) {}

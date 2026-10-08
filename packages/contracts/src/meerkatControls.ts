import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const MeerkatControlScope = Schema.Struct({
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
});
export const MeerkatAuthScope = Schema.Struct({
  ...MeerkatControlScope.fields,
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
  state: Schema.Literals(["connected", "needs_auth", "reauth_required", "host_managed"]),
  supportsInteractiveLogin: Schema.Boolean,
});
export type MeerkatAuthConnection = typeof MeerkatAuthConnection.Type;
export const MeerkatAuthOverview = Schema.Struct({
  connections: Schema.Array(MeerkatAuthConnection),
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
  provider: Schema.Literals(["openai", "anthropic", "gemini"]),
  action: Schema.Literals(["start", "complete", "status", "cancel", "logout"]),
  flowId: Schema.optional(TrimmedNonEmptyString),
  callbackUrl: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(8_000))),
});
export type MeerkatAuthActionInput = typeof MeerkatAuthActionInput.Type;
export const MeerkatAuthFlow = Schema.Struct({
  flowId: Schema.NullOr(Schema.String),
  authorizeUrl: Schema.NullOr(Schema.String),
  status: Schema.Literals(["waiting", "connected", "cancelled", "disconnected", "failed"]),
  message: Schema.NullOr(Schema.String),
});
export type MeerkatAuthFlow = typeof MeerkatAuthFlow.Type;

export class MeerkatControlError extends Schema.TaggedError<MeerkatControlError>()(
  "MeerkatControlError",
  {
    projectId: ProjectId,
    message: Schema.String,
  },
) {}

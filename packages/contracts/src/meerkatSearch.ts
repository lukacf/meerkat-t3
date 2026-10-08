import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestrationSearchThreadsInput } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const MeerkatConversationSearchInput = Schema.Struct({
  query: OrchestrationSearchThreadsInput.fields.query,
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
});
export type MeerkatConversationSearchInput = typeof MeerkatConversationSearchInput.Type;
export const MeerkatConversationSearchMessage = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  storeRevision: TrimmedNonEmptyString,
  offset: NonNegativeInt,
  source: Schema.Literals(["user", "assistant"]),
  snippet: Schema.String.check(Schema.isMaxLength(240)),
});
export type MeerkatConversationSearchMessage = typeof MeerkatConversationSearchMessage.Type;
export const MeerkatConversationSearchMatch = Schema.Struct({
  projectId: ProjectId,
  projectTitle: Schema.String,
  instanceId: ProviderInstanceId,
  label: Schema.String,
  agentRef: Schema.optional(TrimmedNonEmptyString),
  projectAgentId: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(ThreadId),
  threadTitle: Schema.optional(Schema.String),
  message: Schema.optional(MeerkatConversationSearchMessage),
});
export type MeerkatConversationSearchMatch = typeof MeerkatConversationSearchMatch.Type;
/** Bounded pages of durable identities, independent of loaded runtimes. */
export const MeerkatConversationSearchResult = Schema.Struct({
  matches: Schema.Array(MeerkatConversationSearchMatch),
  nextCursor: Schema.optional(Schema.String),
  scanned: NonNegativeInt,
  unavailable: NonNegativeInt,
});
export type MeerkatConversationSearchResult = typeof MeerkatConversationSearchResult.Type;
export class MeerkatConversationSearchError extends Schema.TaggedError<MeerkatConversationSearchError>()(
  "MeerkatConversationSearchError",
  {
    message: Schema.String,
  },
) {}

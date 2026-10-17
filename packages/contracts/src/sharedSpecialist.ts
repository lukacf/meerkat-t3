import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ConsoleFrame, MeerkatAgentActivity, MeerkatAgentControlReceipt } from "./meerkatTeam.ts";
import { SharedParticipant, SharedSpecialist, SharedWorkContext } from "./sharedWorkspace.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export const SharedSpecialistConversationInput = Schema.Struct({
  specialistId: Id,
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type SharedSpecialistConversationInput = typeof SharedSpecialistConversationInput.Type;
export const SharedSpecialistSendInput = Schema.Struct({
  specialistId: Id,
  requestId: Id,
  contextId: Id,
  contextVersion: Id,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(32_768)),
});
export type SharedSpecialistSendInput = typeof SharedSpecialistSendInput.Type;
export const SharedSpecialistRequestInput = Schema.Struct({ requestId: Id });
export type SharedSpecialistRequestInput = typeof SharedSpecialistRequestInput.Type;

/** Not-admitted is the app delivery-claim boundary; all accepted/terminal evidence is native. */
export const SharedSpecialistOutcome = Schema.Struct({
  status: Schema.Literals(["not_admitted", "unresolved", "accepted", "completed", "failed"]),
  receipt: Schema.NullOr(MeerkatAgentControlReceipt),
  completion: Schema.NullOr(ConsoleFrame),
  detail: Schema.NullOr(Schema.String),
  observedAt: IsoDateTime,
});
export type SharedSpecialistOutcome = typeof SharedSpecialistOutcome.Type;
export const SharedSpecialistRequest = Schema.Struct({
  /** Server-issued identifier for this immutable attribution record. */
  requestId: Id,
  clientRequestId: Id,
  specialistId: Id,
  nativeRequestId: Id,
  author: SharedParticipant,
  context: SharedWorkContext,
  text: Schema.String,
  createdAt: IsoDateTime,
  outcome: SharedSpecialistOutcome,
});
export type SharedSpecialistRequest = typeof SharedSpecialistRequest.Type;
export const SharedSpecialistConversation = Schema.Struct({
  specialist: SharedSpecialist,
  requests: Schema.Array(SharedSpecialistRequest),
  /** Native shared activity remains separate from any participant's request result. */
  activity: Schema.NullOr(MeerkatAgentActivity),
  activityError: Schema.NullOr(Schema.String),
});
export type SharedSpecialistConversation = typeof SharedSpecialistConversation.Type;

import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  SharedCheckout,
  SharedSnapshot,
  SharedParticipant,
  SharedWorkContext,
} from "./sharedWorkspace.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const Label = TrimmedNonEmptyString.check(Schema.isMaxLength(200));

/** Narrow identity observation for the personal broker, without directory materialization. */
export const SharedDelegationSession = Schema.Struct({
  environmentId: EnvironmentId,
  workspaceId: Id,
  participantId: Id,
  canContribute: Schema.Boolean,
  expiresAt: IsoDateTime,
});
export type SharedDelegationSession = typeof SharedDelegationSession.Type;

/** Immutable proof read only by the authenticated owner and its personal broker. */
export const SharedDelegationContextInput = Schema.Struct({ contextId: Id, contextVersion: Id });
export type SharedDelegationContextInput = typeof SharedDelegationContextInput.Type;
export const SharedDelegationContext = Schema.Struct({
  context: SharedWorkContext,
  checkout: SharedCheckout,
  snapshot: Schema.NullOr(SharedSnapshot),
});
export type SharedDelegationContext = typeof SharedDelegationContext.Type;

/** Asserted by the authenticated participant's broker, not attested by remote Core. */
export const SharedLocalAgentBinding = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  instanceId: ProviderInstanceId,
  mobId: Id,
  sessionId: Id,
});
export type SharedLocalAgentBinding = typeof SharedLocalAgentBinding.Type;
export const SharedDelegationAction = Schema.Literals([
  "projects.list",
  "projects.get",
  "specialists.list",
  "specialists.get",
  "specialists.send",
  "specialists.request",
  "inbox.list",
  "inbox.ack",
  "activity.publish",
  "knowledge.search",
  "knowledge.record",
  "knowledge.supersede",
]);
export type SharedDelegationAction = typeof SharedDelegationAction.Type;
const Actions = Schema.Array(SharedDelegationAction).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(12),
);
export const SharedDelegationRegisterInput = Schema.Struct({
  requestId: Id,
  label: Label,
  binding: SharedLocalAgentBinding,
  contextId: Id,
  contextVersion: Id,
  actions: Actions,
  expiresAt: IsoDateTime,
});
export type SharedDelegationRegisterInput = typeof SharedDelegationRegisterInput.Type;
export const SharedDelegation = Schema.Struct({
  delegationId: Id,
  ownerParticipantId: Id,
  participant: SharedParticipant,
  binding: SharedLocalAgentBinding,
  context: SharedWorkContext,
  actions: Actions,
  expiresAt: IsoDateTime,
  createdAt: IsoDateTime,
  revokedAt: Schema.NullOr(IsoDateTime),
});
export type SharedDelegation = typeof SharedDelegation.Type;
export const SharedDelegationRevokeInput = Schema.Struct({ delegationId: Id });
export type SharedDelegationRevokeInput = typeof SharedDelegationRevokeInput.Type;
export const SharedDelegationInvokeInput = Schema.Struct({
  delegationId: Id,
  action: SharedDelegationAction,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
});
export type SharedDelegationInvokeInput = typeof SharedDelegationInvokeInput.Type;

/** Personal opt-in only. This input belongs to a human settings RPC, never a model tool. */
export const SharedLocalConnectionCreateInput = Schema.Struct({
  requestId: Id,
  label: Label,
  origin: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  credential: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
  expected: Schema.Struct({ environmentId: EnvironmentId, workspaceId: Id, participantId: Id }),
  consent: Schema.Literal(true),
});
export type SharedLocalConnectionCreateInput = typeof SharedLocalConnectionCreateInput.Type;
/** Contains no credential or private secret-store reference. */
export const SharedLocalConnection = Schema.Struct({
  connectionId: Id,
  requestId: Id,
  label: Label,
  origin: Schema.String,
  environmentId: EnvironmentId,
  workspaceId: Id,
  participantId: Id,
  createdAt: IsoDateTime,
  revokedAt: Schema.NullOr(IsoDateTime),
  /** Retained only after local disconnect; remote confirmation is a separate fact. */
  remoteRevocation: Schema.optional(Schema.Literals(["confirmed", "unconfirmed"])),
});
export type SharedLocalConnection = typeof SharedLocalConnection.Type;
export const SharedLocalConnectionDisconnectResult = Schema.Struct({
  connection: SharedLocalConnection,
  remoteRevocation: Schema.Literals(["confirmed", "unconfirmed"]),
});
export type SharedLocalConnectionDisconnectResult =
  typeof SharedLocalConnectionDisconnectResult.Type;
export const SharedLocalConnectionCancelSetupInput = Schema.Struct({ requestId: Id });
export type SharedLocalConnectionCancelSetupInput =
  typeof SharedLocalConnectionCancelSetupInput.Type;
export const SharedLocalConnectionCancelSetupResult = Schema.Struct({
  canceled: Schema.Literal(true),
  requestId: Id,
  /** A confirmed account receives the same complete cleanup as disconnect. */
  cleanup: Schema.NullOr(SharedLocalConnectionDisconnectResult),
});
export type SharedLocalConnectionCancelSetupResult =
  typeof SharedLocalConnectionCancelSetupResult.Type;
export const SharedLocalDelegationEnableInput = Schema.Struct({
  connectionId: Id,
  requestId: Id,
  threadId: ThreadId,
  label: Label,
  contextId: Id,
  contextVersion: Id,
  actions: Actions,
  expiresAt: IsoDateTime,
});
export type SharedLocalDelegationEnableInput = typeof SharedLocalDelegationEnableInput.Type;
export const SharedLocalDelegation = Schema.Struct({
  localId: Id,
  connectionId: Id,
  threadId: ThreadId,
  grant: Schema.NullOr(SharedDelegation),
  revokedAt: Schema.NullOr(IsoDateTime),
});
export type SharedLocalDelegation = typeof SharedLocalDelegation.Type;

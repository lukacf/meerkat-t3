import {
  EnvironmentId,
  ProjectId,
  SharedDelegationAction,
  SharedLocalConnection,
  SharedLocalDelegation,
  SharedWorkContextInput,
  ThreadId,
  type SharedDelegationSession,
  type SharedLocalConnectionCancelSetupResult,
  type SharedLocalConnectionCreateInput,
  type SharedLocalDelegationEnableInput,
  type SharedWorkContext,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { browserAgentDraftStorage, writeAgentDraftStorage } from "./agentDraftStorage";

export const TaskAccessScope = Schema.Struct({
  localEnvironmentId: EnvironmentId,
  localProjectId: ProjectId,
  localConnectionKey: Schema.String,
  hostEnvironmentId: EnvironmentId,
  hostConnectionKey: Schema.String,
  workspaceId: Schema.String,
  participantId: Schema.String,
  checkoutId: Schema.String,
  sharedProjectId: Schema.String,
});
export type TaskAccessScope = typeof TaskAccessScope.Type;
export const TaskAccessAttempt = Schema.Struct({
  requestId: Schema.String,
  threadId: ThreadId,
  label: Schema.String,
  context: SharedWorkContextInput,
  contextVersion: Schema.NullOr(Schema.String),
  actions: Schema.Array(SharedDelegationAction),
  expiresAt: Schema.String,
  result: Schema.NullOr(SharedLocalDelegation),
});
export type TaskAccessAttempt = typeof TaskAccessAttempt.Type;
export const TaskAccessSetup = Schema.Struct({
  scope: TaskAccessScope,
  connectionRequestId: Schema.String,
  connectionLabel: Schema.String,
  origin: Schema.String,
  connection: Schema.NullOr(SharedLocalConnection),
  attempt: Schema.NullOr(TaskAccessAttempt),
  cancelRequested: Schema.optional(Schema.Literal(true)),
  requestGeneration: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  ),
});
export type TaskAccessSetup = typeof TaskAccessSetup.Type;
const decode = Schema.decodeUnknownSync(TaskAccessSetup);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export function taskAccessKey(scope: TaskAccessScope): string {
  return `meerkat-t3:shared-task-access:v1:${JSON.stringify(scope)}`;
}
export function readTaskAccess(scope: TaskAccessScope): TaskAccessSetup | null {
  const storage = browserAgentDraftStorage("localStorage");
  if (!storage)
    throw new Error("Local storage is unavailable. Access requests cannot be saved safely.");
  const raw = storage.getItem(taskAccessKey(scope));
  if (!raw) return null;
  const setup = decode(JSON.parse(raw));
  if (!same(setup.scope, scope))
    throw new Error("This saved request belongs to another connection.");
  const attempt = setup.attempt;
  if (
    attempt &&
    (attempt.context.checkoutId !== scope.checkoutId ||
      attempt.context.source.kind !== "thread" ||
      attempt.context.source.threadId !== attempt.threadId)
  )
    throw new Error("The saved task and checkout do not match. The request has been kept.");
  return setup;
}
function immutableAttempt(attempt: TaskAccessAttempt) {
  const { contextVersion: _version, result: _result, ...input } = attempt;
  return input;
}
/** A second tab must not replace a pending grant or mutate an already-bound revision. */
export function saveTaskAccess(setup: TaskAccessSetup): boolean {
  try {
    const current = readTaskAccess(setup.scope);
    if (current) {
      if ((current.requestGeneration ?? 0) !== (setup.requestGeneration ?? 0)) return false;
      if (current.cancelRequested && !setup.cancelRequested) return false;
      if (current.connection && current.connection.connectionId !== setup.connection?.connectionId)
        return false;
      if (
        !current.connection &&
        (current.connectionRequestId !== setup.connectionRequestId ||
          current.origin !== setup.origin ||
          current.connectionLabel !== setup.connectionLabel)
      )
        return false;
      const pending = current.attempt;
      if (pending && !pending.result) {
        if (!setup.attempt || !same(immutableAttempt(pending), immutableAttempt(setup.attempt)))
          return false;
        if (pending.contextVersion && pending.contextVersion !== setup.attempt.contextVersion)
          return false;
      }
    }
    return writeAgentDraftStorage(
      browserAgentDraftStorage("localStorage"),
      taskAccessKey(setup.scope),
      setup,
    );
  } catch {
    return false;
  }
}

export function taskAccessAttemptExpired(attempt: TaskAccessAttempt, now = Date.now()): boolean {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(attempt.expiresAt)
  )
    return false;
  const expiry = Date.parse(attempt.expiresAt);
  return Number.isFinite(expiry) && expiry <= now;
}

/** Release only this expired browser draft. Backend history and grant admission remain authoritative. */
export function startNewTaskAccessRequest(
  expected: TaskAccessSetup,
  now = Date.now(),
): TaskAccessSetup | null {
  try {
    const current = readTaskAccess(expected.scope);
    if (
      !current ||
      !same(current, decode(expected)) ||
      current.cancelRequested ||
      !current.attempt ||
      current.attempt.result ||
      !taskAccessAttemptExpired(current.attempt, now)
    )
      return null;
    const generation = (current.requestGeneration ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) return null;
    const next = { ...current, requestGeneration: generation, attempt: null };
    return writeAgentDraftStorage(
      browserAgentDraftStorage("localStorage"),
      taskAccessKey(current.scope),
      next,
    )
      ? next
      : null;
  } catch {
    return null;
  }
}

/** Called only after the backend confirms revocation and secret removal. */
export function clearRemovedTaskAccount(
  scope: TaskAccessScope,
  connection: SharedLocalConnection,
): boolean {
  try {
    if (
      !connection.revokedAt ||
      !connection.remoteRevocation ||
      connection.environmentId !== scope.hostEnvironmentId ||
      connection.workspaceId !== scope.workspaceId ||
      connection.participantId !== scope.participantId
    )
      return false;
    const current = readTaskAccess(scope);
    if (!current) return true;
    if (
      current.connection
        ? current.connection.connectionId !== connection.connectionId
        : current.connectionRequestId !== connection.requestId
    )
      return false;
    if (current.origin !== connection.origin) return false;
    const storage = browserAgentDraftStorage("localStorage");
    if (!storage?.removeItem) return false;
    storage.removeItem(taskAccessKey(scope));
    return storage.getItem(taskAccessKey(scope)) === null;
  } catch {
    return false;
  }
}

/** A lost cancellation reply must not clear a different tab's new setup. */
export function clearCanceledTaskSetup(
  scope: TaskAccessScope,
  requestId: string,
  result: SharedLocalConnectionCancelSetupResult,
): boolean {
  try {
    if (!result.canceled || result.requestId !== requestId) return false;
    const current = readTaskAccess(scope);
    if (!current) return true;
    if (current.connectionRequestId !== requestId || !current.cancelRequested) return false;
    if (result.cleanup) {
      if (
        result.cleanup.connection.requestId !== requestId ||
        result.cleanup.connection.remoteRevocation !== result.cleanup.remoteRevocation
      )
        return false;
      return clearRemovedTaskAccount(scope, result.cleanup.connection);
    }
    // A known account requires the complete disconnect receipt.
    if (current.connection) return false;
    const storage = browserAgentDraftStorage("localStorage");
    if (!storage?.removeItem) return false;
    storage.removeItem(taskAccessKey(scope));
    return storage.getItem(taskAccessKey(scope)) === null;
  } catch {
    return false;
  }
}

export function taskAccessExpiry(parentExpiresAt: string, now = Date.now()): string {
  const end = Math.min(Date.parse(parentExpiresAt), now + 60 * 60 * 1000);
  if (!Number.isFinite(end) || end <= now)
    throw new Error("The shared account has expired. Reconnect before enabling task access.");
  return new Date(end).toISOString();
}

export function assertTaskAccessSession(scope: TaskAccessScope, session: SharedDelegationSession) {
  if (
    session.environmentId !== scope.hostEnvironmentId ||
    session.workspaceId !== scope.workspaceId ||
    session.participantId !== scope.participantId ||
    !session.canContribute
  )
    throw new Error(
      "The shared account has changed or cannot contribute. Reconnect before enabling task access.",
    );
}

function assertConnection(setup: TaskAccessSetup, connection: SharedLocalConnection) {
  if (
    connection.environmentId !== setup.scope.hostEnvironmentId ||
    connection.workspaceId !== setup.scope.workspaceId ||
    connection.participantId !== setup.scope.participantId ||
    connection.origin !== setup.origin ||
    connection.revokedAt
  )
    throw new Error("The local backend returned a different or disabled shared account.");
}
function assertGrant(setup: TaskAccessSetup, result: SharedLocalDelegation) {
  const attempt = setup.attempt!;
  if (
    result.threadId !== attempt.threadId ||
    result.connectionId !== setup.connection?.connectionId
  )
    throw new Error("The local backend returned access for a different task or account.");
  const grant = result.grant;
  if (
    grant &&
    (grant.ownerParticipantId !== setup.scope.participantId ||
      grant.binding.environmentId !== setup.scope.localEnvironmentId ||
      grant.binding.projectId !== setup.scope.localProjectId ||
      grant.binding.threadId !== attempt.threadId ||
      grant.context.contextId !== attempt.context.contextId ||
      grant.context.contextVersion !== attempt.contextVersion ||
      grant.expiresAt !== attempt.expiresAt ||
      !same([...grant.actions].sort(), [...attempt.actions].sort()))
  )
    throw new Error("The granted task, context, actions, or expiry differ from the saved request.");
}

/** Credential acquisition occurs only in the caller's explicitly consented action. */
export async function enableTaskAccess(
  setup: TaskAccessSetup,
  actions: {
    persist: (setup: TaskAccessSetup) => boolean;
    putContext: (input: SharedWorkContextInput) => Promise<SharedWorkContext>;
    createConnection: (
      input: Omit<SharedLocalConnectionCreateInput, "credential">,
    ) => Promise<SharedLocalConnection>;
    enable: (input: SharedLocalDelegationEnableInput) => Promise<SharedLocalDelegation>;
  },
): Promise<TaskAccessSetup> {
  let current = setup;
  if (current.cancelRequested)
    throw new Error("Setup cancellation is pending. Retry cancellation before enabling access.");
  if (!current.attempt) throw new Error("Choose a task before enabling access.");
  const persist = () => {
    if (!actions.persist(current))
      throw new Error(
        "This request could not be saved. Retry it when local storage is available; its IDs have been kept.",
      );
  };
  persist();
  if (!current.attempt.contextVersion) {
    const input = current.attempt.context;
    const context = await actions.putContext(input);
    if (
      context.contextId !== input.contextId ||
      context.participantId !== current.scope.participantId ||
      context.sharedProjectId !== current.scope.sharedProjectId ||
      context.checkoutId !== input.checkoutId ||
      !same(context.source, input.source) ||
      !same(context.revision, input.revision) ||
      context.objective !== input.objective ||
      !same(context.paths, input.paths) ||
      !same(context.tags, input.tags)
    )
      throw new Error("The shared host returned a different task context.");
    current = {
      ...current,
      attempt: { ...current.attempt, contextVersion: context.contextVersion },
    };
    persist();
  }
  if (!current.connection) {
    const connection = await actions.createConnection({
      requestId: current.connectionRequestId,
      label: current.connectionLabel,
      origin: current.origin,
      expected: {
        environmentId: current.scope.hostEnvironmentId,
        workspaceId: current.scope.workspaceId,
        participantId: current.scope.participantId,
      },
      consent: true,
    });
    assertConnection(current, connection);
    if (connection.requestId !== current.connectionRequestId)
      throw new Error("The backend returned a different account creation request.");
    current = { ...current, connection };
    persist();
  }
  assertConnection(current, current.connection!);
  const attempt = current.attempt!;
  const result = await actions.enable({
    connectionId: current.connection!.connectionId,
    requestId: attempt.requestId,
    threadId: attempt.threadId,
    label: attempt.label,
    contextId: attempt.context.contextId,
    contextVersion: attempt.contextVersion!,
    actions: attempt.actions,
    expiresAt: attempt.expiresAt,
  });
  assertGrant(current, result);
  // A null grant is still pending. It must retain its immutable request for retry.
  current = { ...current, attempt: { ...attempt, result: result.grant ? result : null } };
  persist();
  return current;
}

export function taskAccessStatus(delegation: SharedLocalDelegation, now = Date.now()): string {
  if (delegation.revokedAt)
    return delegation.grant?.revokedAt ? "Revoked" : "Blocked locally; remote confirmation pending";
  if (delegation.grant?.revokedAt) return "Revoked";
  if (!delegation.grant) return "Awaiting confirmation";
  if (Date.parse(delegation.grant.expiresAt) <= now) return "Expired";
  return "Access enabled";
}

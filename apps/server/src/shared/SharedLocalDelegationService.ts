// @effect-diagnostics nodeBuiltinImport:off - generates opaque local connection identities.
import * as NodeCrypto from "node:crypto";
import {
  SharedDelegation,
  SharedDelegationAction,
  SharedDelegationRegisterInput,
  SharedLocalConnection,
  SharedLocalConnectionCreateInput,
  SharedLocalConnectionCancelSetupInput,
  SharedLocalDelegationEnableInput,
  SharedLocalAgentBinding,
  SharedWorkspaceError,
  type EnvironmentId,
  type ThreadId,
  type SharedLocalDelegation,
  type SharedDelegationInvokeInput,
  type SharedDelegationContextInput,
  type SharedDelegationContext,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import type { SharedLocalCheckoutValidator } from "./SharedLocalCheckoutValidator.ts";
import type { SharedToolInvocation } from "./SharedToolHost.ts";
import { sharedFingerprint } from "./SharedWorkspaceStore.ts";

export interface SharedRemoteConnection {
  readonly origin: string;
  /** Private transport input. Never serialize into metadata, errors or tool output. */
  readonly credential: string;
  /** Transport must verify these against the same authenticated remote connection before work. */
  readonly expected?: {
    readonly environmentId: EnvironmentId;
    readonly workspaceId: string;
    readonly participantId: string;
  };
}
export interface SharedDelegationRemote {
  readonly context: (
    connection: SharedRemoteConnection,
    input: SharedDelegationContextInput,
  ) => Effect.Effect<SharedDelegationContext, SharedWorkspaceError>;
  readonly session: (connection: SharedRemoteConnection) => Effect.Effect<
    {
      readonly environmentId: EnvironmentId;
      readonly workspaceId: string;
      readonly participantId: string;
      readonly canContribute: boolean;
    },
    SharedWorkspaceError
  >;
  readonly register: (
    connection: SharedRemoteConnection,
    input: SharedDelegationRegisterInput,
  ) => Effect.Effect<SharedDelegation, SharedWorkspaceError>;
  readonly revoke: (
    connection: SharedRemoteConnection,
    delegationId: string,
  ) => Effect.Effect<SharedDelegation, SharedWorkspaceError>;
  readonly invoke: (
    connection: SharedRemoteConnection,
    input: SharedDelegationInvokeInput,
  ) => Effect.Effect<unknown, SharedWorkspaceError>;
}
/** Must resolve current native ownership, not only a saved thread projection. */
export type SharedLocalNativeResolver = (
  threadId: ThreadId,
) => Effect.Effect<SharedLocalAgentBinding, SharedWorkspaceError>;
const fail = (code: SharedWorkspaceError["code"], message: string) =>
  new SharedWorkspaceError({ code, message });
const isSharedWorkspaceError = Schema.is(SharedWorkspaceError);
const failure = (cause: unknown) =>
  isSharedWorkspaceError(cause)
    ? cause
    : fail("unavailable", "The local shared connection is unavailable.");
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const parse = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => fail("invalid_input", "Invalid shared connection request.")),
  );
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const decodeRegistration = Schema.decodeUnknownSync(
  Schema.fromJsonString(SharedDelegationRegisterInput),
);
const expiryWithTimezone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const registrationExpired = (row: { registration_json: string }, observedAt: number) => {
  try {
    const expiry = decodeRegistration(row.registration_json).expiresAt;
    // A timezone-free timestamp may expire at different instants on the two hosts.
    if (!expiryWithTimezone.test(expiry)) return false;
    const expiresAt = Date.parse(expiry);
    return Number.isFinite(expiresAt) && expiresAt <= observedAt;
  } catch {
    // Missing or malformed retained evidence must never release admission.
    return false;
  }
};
const sameExpiry = (left: string, right: string) =>
  Number.isFinite(Date.parse(left)) && Date.parse(left) === Date.parse(right);
const EXPIRY_SCAN_PAGE_SIZE = 100;
/** Keep history without letting expired registrations occupy the task's admission slot. */
const unexpiredRegistrations = Effect.fn("SharedLocalDelegation.unexpiredRegistrations")(function* <
  A extends { local_id: string; registration_json: string },
  E,
  R,
>(page: (after: string) => Effect.Effect<ReadonlyArray<A>, E, R>, limit: number) {
  const observedAt = (yield* DateTime.now).epochMilliseconds;
  const active: A[] = [];
  let after = "";
  while (true) {
    const rows = yield* page(after);
    for (const row of rows) {
      if (!registrationExpired(row, observedAt)) active.push(row);
      if (active.length === limit) return active;
    }
    if (rows.length < EXPIRY_SCAN_PAGE_SIZE) return active;
    after = rows[rows.length - 1]!.local_id;
  }
});
type ConnectionRow = {
  owner_session_id: string;
  request_id: string;
  secret_name: string;
  definition_json: string | null;
};
type DelegationRow = {
  local_id: string;
  connection_id: string;
  thread_id: string;
  fingerprint: string;
  registration_json: string;
  definition_json: string | null;
  revoked_at: string | null;
};

export const sharedConnectionOrigin = (value: string) =>
  Effect.try({
    try: () => {
      const url = new URL(value);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      )
        throw new Error("origin");
      return url.origin;
    },
    catch: () =>
      fail(
        "invalid_input",
        "Use an HTTPS server origin without a path, credentials, query or fragment. Loopback HTTP is supported for local servers.",
      ),
  });

/** Personal opt-in broker. Only server-authenticated UI calls may create or enable a connection. */
export const makeSharedLocalDelegationService = Effect.fn("SharedLocalDelegation.make")(function* (
  remote: SharedDelegationRemote,
  resolveNative: SharedLocalNativeResolver,
  validateCheckout: SharedLocalCheckoutValidator,
) {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore;
  const requireOwner = Effect.fn("SharedLocalDelegation.requireOwner")(function* (
    sessionId: string,
  ) {
    const timestamp = yield* now;
    const rows = yield* sql<{
      expires_at: string;
    }>`SELECT expires_at FROM auth_sessions WHERE session_id=${sessionId} AND revoked_at IS NULL`;
    if (!rows[0] || !(Date.parse(rows[0].expires_at) > Date.parse(timestamp)))
      return yield* fail("forbidden", "The local connection owner has expired or been revoked.");
  });
  const requireSetupActive = Effect.fn("SharedLocalDelegation.requireSetupActive")(function* (
    sessionId: string,
    requestId: string,
  ) {
    const canceled = yield* sql`SELECT request_id FROM shared_local_connection_cancellations
      WHERE owner_session_id=${sessionId} AND request_id=${requestId}`;
    if (canceled.length)
      return yield* fail("forbidden", "This setup was canceled. Start a new setup explicitly.");
  });
  const connection = Effect.fn("SharedLocalDelegation.connection")(function* (
    sessionId: string,
    connectionId: string,
    allowRevoked = false,
  ) {
    yield* requireOwner(sessionId);
    const rows =
      yield* sql<ConnectionRow>`SELECT owner_session_id,request_id,secret_name,definition_json FROM shared_local_connections
      WHERE connection_id=${connectionId} AND owner_session_id=${sessionId}`;
    if (!rows[0])
      return yield* fail(
        "forbidden",
        "This shared connection does not belong to the current session.",
      );
    if (!rows[0].definition_json)
      return yield* fail(
        "unavailable",
        "Connection setup is not confirmed. Retry with the same setup request ID.",
      );
    const value = yield* parse(
      Schema.fromJsonString(SharedLocalConnection),
      rows[0].definition_json,
    );
    if (value.revokedAt && !allowRevoked)
      return yield* fail("forbidden", "This shared connection is disconnected.");
    if (!allowRevoked) yield* requireSetupActive(sessionId, rows[0].request_id);
    return { row: rows[0], value };
  });
  const privateConnection = Effect.fn("SharedLocalDelegation.privateConnection")(function* (
    row: ConnectionRow,
    value: SharedLocalConnection,
  ) {
    const saved = yield* secrets
      .get(row.secret_name)
      .pipe(
        Effect.mapError(() =>
          fail("unavailable", "The shared connection credential is unavailable."),
        ),
      );
    if (Option.isNone(saved))
      return yield* fail(
        "unavailable",
        "Reconnect this shared account before enabling a local agent.",
      );
    const credential = new TextDecoder().decode(saved.value);
    if (!/^[A-Za-z0-9_.~+/-]+=*$/.test(credential))
      return yield* fail("unavailable", "The shared connection credential is invalid.");
    return {
      origin: value.origin,
      credential,
      expected: {
        environmentId: value.environmentId,
        workspaceId: value.workspaceId,
        participantId: value.participantId,
      },
    };
  });
  // Transport failures can carry URL/header details. Never expose their arbitrary message or cause.
  const remoteCall = <A>(effect: Effect.Effect<A, SharedWorkspaceError>) =>
    effect.pipe(
      Effect.timeout("45 seconds"),
      Effect.mapError(() =>
        fail(
          "unavailable",
          "The remote shared operation could not be confirmed. Retry with the same request ID; no work was replayed.",
        ),
      ),
    );
  const connect = Effect.fn("SharedLocalDelegation.connect")(function* (
    sessionId: string,
    raw: SharedLocalConnectionCreateInput,
  ) {
    yield* requireOwner(sessionId);
    const input = yield* parse(SharedLocalConnectionCreateInput, raw);
    if (!/^[A-Za-z0-9_.~+/-]+=*$/.test(input.credential))
      return yield* fail("invalid_input", "Use a shared participant connection credential.");
    const origin = yield* sharedConnectionOrigin(input.origin);
    const connectionId = `connection-${sharedFingerprint([sessionId, input.requestId])}`;
    // Only metadata is fingerprinted. The exact credential is compared in the secret store.
    const fingerprint = sharedFingerprint({
      label: input.label,
      origin,
      consent: input.consent,
      expected: input.expected,
    });
    const secretName = `shared-${connectionId}`;
    const claimed = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* requireOwner(sessionId);
        yield* requireSetupActive(sessionId, input.requestId);
        const old = yield* sql<
          ConnectionRow & { fingerprint: string; created_at: string }
        >`SELECT * FROM shared_local_connections
        WHERE connection_id=${connectionId} AND owner_session_id=${sessionId}`;
        if (old[0]) {
          if (old[0].fingerprint !== fingerprint)
            return yield* fail(
              "conflict",
              "This connection setup request already has different contents.",
            );
          return old[0];
        }
        const createdAt = yield* now;
        yield* sql`INSERT INTO shared_local_connections(connection_id,owner_session_id,request_id,fingerprint,secret_name,created_at)
        VALUES (${connectionId},${sessionId},${input.requestId},${fingerprint},${secretName},${createdAt})`;
        return {
          owner_session_id: sessionId,
          request_id: input.requestId,
          secret_name: secretName,
          definition_json: null,
          fingerprint,
          created_at: createdAt,
        };
      }),
    );
    // The metadata lock orders credential creation against disconnect. A stale
    // setup retry must never recreate a credential after disconnect removed it.
    const previous = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* requireOwner(sessionId);
        yield* requireSetupActive(sessionId, input.requestId);
        const rows =
          yield* sql<ConnectionRow>`SELECT * FROM shared_local_connections WHERE connection_id=${connectionId}`;
        const current = rows[0];
        if (!current)
          return yield* fail("unavailable", "The connection setup claim is unavailable.");
        if (current.definition_json) {
          const previous = yield* parse(
            Schema.fromJsonString(SharedLocalConnection),
            current.definition_json,
          );
          if (previous.revokedAt)
            return yield* fail(
              "forbidden",
              "This setup request belongs to a disconnected connection. Start a new setup explicitly.",
            );
        }
        const submitted = new TextEncoder().encode(input.credential);
        let saved = yield* secrets
          .get(secretName)
          .pipe(
            Effect.mapError(() =>
              fail("unavailable", "The saved shared credential is unavailable."),
            ),
          );
        if (Option.isNone(saved)) {
          // Exclusive secret creation arbitrates overlapping calls and survives process restart.
          // If another call won, read and compare it; never overwrite an existing credential.
          yield* secrets.create(secretName, submitted).pipe(Effect.ignore);
          saved = yield* secrets
            .get(secretName)
            .pipe(
              Effect.mapError(() =>
                fail("unavailable", "The shared credential could not be saved securely."),
              ),
            );
        }
        if (Option.isNone(saved))
          return yield* fail(
            "unavailable",
            "The shared credential could not be saved securely. Retry the same setup request.",
          );
        if (
          submitted.byteLength !== saved.value.byteLength ||
          !NodeCrypto.timingSafeEqual(submitted, saved.value)
        )
          return yield* fail(
            "conflict",
            "This setup request already has a different credential. Start a new setup explicitly.",
          );
        return current.definition_json
          ? yield* parse(Schema.fromJsonString(SharedLocalConnection), current.definition_json)
          : null;
      }),
    );
    if (previous) return previous;
    const observed = yield* remoteCall(
      remote.session({ origin, credential: input.credential, expected: input.expected }),
    );
    if (
      observed.environmentId !== input.expected.environmentId ||
      observed.workspaceId !== input.expected.workspaceId ||
      observed.participantId !== input.expected.participantId
    )
      return yield* fail(
        "conflict",
        "The authenticated remote identity differs from the shared account selected for this connection.",
      );
    if (!observed.canContribute)
      return yield* fail(
        "forbidden",
        "This connection requires shared read and contribution permissions and a joined participant.",
      );
    const value: SharedLocalConnection = {
      connectionId,
      requestId: input.requestId,
      label: input.label,
      origin,
      environmentId: observed.environmentId,
      workspaceId: observed.workspaceId,
      participantId: observed.participantId,
      createdAt: claimed.created_at,
      revokedAt: null,
    };
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* requireOwner(sessionId);
        yield* requireSetupActive(sessionId, input.requestId);
        const rows =
          yield* sql<ConnectionRow>`SELECT * FROM shared_local_connections WHERE connection_id=${connectionId}`;
        if (rows[0]?.definition_json) {
          const previous = yield* parse(
            Schema.fromJsonString(SharedLocalConnection),
            rows[0].definition_json,
          );
          if (previous.revokedAt)
            return yield* fail(
              "forbidden",
              "This shared connection was disconnected during setup.",
            );
          if (sharedFingerprint(previous) !== sharedFingerprint(value))
            return yield* fail("conflict", "The remote identity changed during connection setup.");
          return previous;
        }
        yield* sql`UPDATE shared_local_connections SET definition_json=${encode(value)} WHERE connection_id=${connectionId}`;
        return value;
      }),
    );
  }, Effect.mapError(failure));
  const list = Effect.fn("SharedLocalDelegation.list")(function* (sessionId: string) {
    yield* requireOwner(sessionId);
    const rows = yield* sql<{
      definition_json: string;
    }>`SELECT definition_json FROM shared_local_connections WHERE owner_session_id=${sessionId} AND definition_json IS NOT NULL`;
    return yield* Effect.forEach(rows, (row) =>
      parse(Schema.fromJsonString(SharedLocalConnection), row.definition_json),
    );
  }, Effect.mapError(failure));
  const local = (row: DelegationRow) =>
    Effect.gen(function* (): Effect.fn.Return<SharedLocalDelegation, SharedWorkspaceError> {
      const registration = yield* parse(
        Schema.fromJsonString(SharedDelegationRegisterInput),
        row.registration_json,
      );
      return {
        localId: row.local_id,
        connectionId: row.connection_id,
        threadId: registration.binding.threadId,
        grant: row.definition_json
          ? yield* parse(Schema.fromJsonString(SharedDelegation), row.definition_json)
          : null,
        revokedAt: row.revoked_at,
      };
    });
  const enable = Effect.fn("SharedLocalDelegation.enable")(function* (
    sessionId: string,
    raw: SharedLocalDelegationEnableInput,
  ) {
    const input = yield* parse(SharedLocalDelegationEnableInput, raw);
    const saved = yield* connection(sessionId, input.connectionId);
    const binding = yield* parse(SharedLocalAgentBinding, yield* resolveNative(input.threadId));
    if (binding.threadId !== input.threadId)
      return yield* fail("forbidden", "Native ownership does not match the selected task.");
    const localId = `delegation-${sharedFingerprint([sessionId, input.connectionId, input.requestId])}`;
    const registration: SharedDelegationRegisterInput = {
      requestId: localId,
      label: input.label,
      binding,
      contextId: input.contextId,
      contextVersion: input.contextVersion,
      actions: [...new Set(input.actions)].sort(),
      expiresAt: input.expiresAt,
    };
    const fingerprint = sharedFingerprint(registration);
    // An admitted retry retains its original revision even when the checkout has
    // since moved. New requests must prove current local content before custody.
    const existing =
      yield* sql`SELECT local_id FROM shared_local_delegations WHERE local_id=${localId}`;
    if (!existing.length)
      yield* validateCheckout(yield* privateConnection(saved.row, saved.value), registration);
    const retained = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* connection(sessionId, input.connectionId);
        const old =
          yield* sql<DelegationRow>`SELECT * FROM shared_local_delegations WHERE local_id=${localId}`;
        if (old[0]) {
          if (old[0].fingerprint !== fingerprint)
            return yield* fail(
              "conflict",
              "This delegation request already has a different native binding or contents.",
            );
          if (old[0].revoked_at)
            return yield* fail("forbidden", "This local delegation has been revoked.");
          return old[0];
        }
        // This transaction owns admission across connections. Expiry releases only
        // the local slot; retained local and remote revocation evidence is unchanged.
        const active = yield* unexpiredRegistrations(
          (after) => sql<{
            local_id: string;
            registration_json: string;
          }>`SELECT local_id,registration_json
            FROM shared_local_delegations WHERE thread_id=${input.threadId} AND revoked_at IS NULL
              AND local_id > ${after} ORDER BY local_id LIMIT ${EXPIRY_SCAN_PAGE_SIZE}`,
          1,
        );
        if (active.length)
          return yield* fail(
            "conflict",
            "Revoke the task's existing delegation before changing its connection or context.",
          );
        yield* sql`INSERT INTO shared_local_delegations(local_id,connection_id,thread_id,fingerprint,registration_json)
        VALUES (${localId},${input.connectionId},${input.threadId},${fingerprint},${encode(registration)})`;
        return undefined;
      }),
    );
    if (retained?.definition_json) return yield* local(retained);
    const credentials = yield* privateConnection(saved.row, saved.value);
    const grant = yield* parse(
      SharedDelegation,
      yield* remoteCall(remote.register(credentials, registration)),
    );
    if (
      grant.ownerParticipantId !== saved.value.participantId ||
      sharedFingerprint(grant.binding) !== sharedFingerprint(binding) ||
      grant.context.contextId !== registration.contextId ||
      grant.context.contextVersion !== registration.contextVersion ||
      sharedFingerprint([...grant.actions].sort()) !== sharedFingerprint(registration.actions) ||
      !sameExpiry(grant.expiresAt, registration.expiresAt) ||
      grant.revokedAt
    )
      return yield* fail(
        "unavailable",
        "The remote grant does not match this immutable delegation request.",
      );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* connection(sessionId, input.connectionId);
        const current =
          yield* sql<DelegationRow>`SELECT * FROM shared_local_delegations WHERE local_id=${localId}`;
        if (!current[0] || current[0].revoked_at)
          return yield* fail("forbidden", "The delegation was revoked before activation.");
        yield* sql`UPDATE shared_local_delegations SET definition_json=${encode(grant)} WHERE local_id=${localId}`;
        return yield* local({ ...current[0], definition_json: encode(grant) });
      }),
    );
  }, Effect.mapError(failure));
  const listDelegations = Effect.fn("SharedLocalDelegation.listDelegations")(function* (
    sessionId: string,
    connectionId: string,
  ) {
    yield* connection(sessionId, connectionId, true);
    const rows =
      yield* sql<DelegationRow>`SELECT * FROM shared_local_delegations WHERE connection_id=${connectionId}`;
    return yield* Effect.forEach(rows, local);
  }, Effect.mapError(failure));
  const revokeRemote = Effect.fn("SharedLocalDelegation.revokeRemote")(function* (
    row: DelegationRow,
    saved: SharedLocalConnection,
    credentials: SharedRemoteConnection | undefined,
  ) {
    const previous = row.definition_json
      ? yield* parse(Schema.fromJsonString(SharedDelegation), row.definition_json)
      : undefined;
    if (previous?.revokedAt)
      return yield* local({ ...row, revoked_at: row.revoked_at ?? previous.revokedAt });
    const registration = yield* parse(
      Schema.fromJsonString(SharedDelegationRegisterInput),
      row.registration_json,
    );
    if (!credentials || (!previous && Date.parse(registration.expiresAt) <= Date.parse(yield* now)))
      return yield* fail(
        "unavailable",
        "Remote revocation is unconfirmed. Local access is disabled.",
      );
    // A refused recovery attempt cannot prove that an earlier response-lost
    // registration never happened. Only an exact revoked grant confirms it.
    const grant =
      previous ??
      (yield* parse(
        SharedDelegation,
        yield* remoteCall(remote.register(credentials, registration)),
      ));
    if (
      grant.ownerParticipantId !== saved.participantId ||
      sharedFingerprint(grant.binding) !== sharedFingerprint(registration.binding) ||
      grant.context.contextId !== registration.contextId ||
      grant.context.contextVersion !== registration.contextVersion ||
      sharedFingerprint([...grant.actions].sort()) !== sharedFingerprint(registration.actions) ||
      !sameExpiry(grant.expiresAt, registration.expiresAt)
    )
      return yield* fail(
        "unavailable",
        "The remote grant does not match this immutable delegation request.",
      );
    const revoked = grant.revokedAt
      ? grant
      : yield* parse(
          SharedDelegation,
          yield* remoteCall(remote.revoke(credentials, grant.delegationId)),
        );
    if (
      !revoked.revokedAt ||
      sharedFingerprint(revoked) !== sharedFingerprint({ ...grant, revokedAt: revoked.revokedAt })
    )
      return yield* fail("unavailable", "Remote revocation is not yet confirmed.");
    yield* sql`UPDATE shared_local_delegations SET definition_json=${encode(revoked)} WHERE local_id=${row.local_id}`;
    return yield* local({
      ...row,
      definition_json: encode(revoked),
      revoked_at: row.revoked_at ?? revoked.revokedAt,
    });
  });
  const revoke = Effect.fn("SharedLocalDelegation.revoke")(function* (
    sessionId: string,
    localId: string,
  ) {
    const rows =
      yield* sql<DelegationRow>`SELECT * FROM shared_local_delegations WHERE local_id=${localId}`;
    if (!rows[0]) return yield* fail("not_found", "Local delegation not found.");
    const saved = yield* connection(sessionId, rows[0].connection_id, true);
    // Stop local selection before network I/O. Keep the credential until remote revocation succeeds.
    yield* sql`UPDATE shared_local_delegations SET revoked_at=COALESCE(revoked_at,${yield* now}) WHERE local_id=${localId}`;
    const credentials = yield* privateConnection(saved.row, saved.value).pipe(Effect.option);
    return yield* revokeRemote(rows[0], saved.value, Option.getOrUndefined(credentials));
  }, Effect.mapError(failure));
  const disconnect = Effect.fn("SharedLocalDelegation.disconnect")(function* (
    sessionId: string,
    connectionId: string,
  ) {
    const { saved, rows } = yield* sql.withTransaction(
      Effect.gen(function* () {
        const saved = yield* connection(sessionId, connectionId, true);
        const timestamp = yield* now;
        const value = {
          ...saved.value,
          revokedAt: saved.value.revokedAt ?? timestamp,
        };
        yield* sql`UPDATE shared_local_connections SET definition_json=${encode(value)} WHERE connection_id=${connectionId}`;
        yield* sql`UPDATE shared_local_delegations SET revoked_at=COALESCE(revoked_at,${timestamp}) WHERE connection_id=${connectionId}`;
        const rows =
          yield* sql<DelegationRow>`SELECT * FROM shared_local_delegations WHERE connection_id=${connectionId}`;
        return { saved: { ...saved, value }, rows };
      }),
    );
    // Keep a credential only in this bounded operation's memory. Remote outages,
    // refused registration recovery and dead remote logins never prevent deletion.
    const credentials = yield* privateConnection(saved.row, saved.value).pipe(Effect.option);
    yield* secrets
      .remove(saved.row.secret_name)
      .pipe(
        Effect.mapError(() =>
          fail(
            "unavailable",
            "The connection is disabled, but its stored credential could not yet be removed. Retry disconnecting.",
          ),
        ),
      );
    yield* Effect.forEach(
      rows,
      (row) =>
        revokeRemote(row, saved.value, Option.getOrUndefined(credentials)).pipe(Effect.ignore),
      { concurrency: 4 },
    ).pipe(Effect.timeout("10 seconds"), Effect.ignore);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* connection(sessionId, connectionId, true);
        const unconfirmed = yield* sql`SELECT local_id FROM shared_local_delegations
        WHERE connection_id=${connectionId} AND (definition_json IS NULL OR json_extract(definition_json,'$.revokedAt') IS NULL) LIMIT 1`;
        const remoteRevocation = unconfirmed.length
          ? ("unconfirmed" as const)
          : ("confirmed" as const);
        const value = { ...current.value, remoteRevocation };
        yield* sql`UPDATE shared_local_connections SET definition_json=${encode(value)} WHERE connection_id=${connectionId}`;
        return { connection: value, remoteRevocation };
      }),
    );
  }, Effect.mapError(failure));
  const cancelSetup = Effect.fn("SharedLocalDelegation.cancelSetup")(function* (
    sessionId: string,
    raw: SharedLocalConnectionCancelSetupInput,
  ) {
    const input = yield* parse(SharedLocalConnectionCancelSetupInput, raw);
    const existing = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* requireOwner(sessionId);
        // A cancellation may reach the server before the original setup request.
        // Keep the tombstone even if deletion fails, so no delayed retry can save a secret.
        yield* sql`INSERT INTO shared_local_connection_cancellations(owner_session_id,request_id,canceled_at)
          VALUES (${sessionId},${input.requestId},${yield* now}) ON CONFLICT DO NOTHING`;
        const rows = yield* sql<
          ConnectionRow & { connection_id: string }
        >`SELECT * FROM shared_local_connections
          WHERE owner_session_id=${sessionId} AND request_id=${input.requestId}`;
        return rows[0];
      }),
    );
    if (existing?.definition_json) {
      const cleanup = yield* disconnect(sessionId, existing.connection_id);
      return { canceled: true as const, requestId: input.requestId, cleanup };
    }
    if (existing) {
      yield* secrets
        .remove(existing.secret_name)
        .pipe(
          Effect.mapError(() =>
            fail(
              "unavailable",
              "Setup is canceled, but its stored credential could not yet be removed. Retry canceling setup.",
            ),
          ),
        );
    }
    return { canceled: true as const, requestId: input.requestId, cleanup: null };
  }, Effect.mapError(failure));
  const invoke = Effect.fn("SharedLocalDelegation.invoke")(function* (
    invocation: SharedToolInvocation,
  ) {
    const action = yield* parse(SharedDelegationAction, invocation.action);
    const rows = yield* unexpiredRegistrations(
      (after) => sql<DelegationRow & { owner_session_id: string }>`SELECT d.*,c.owner_session_id
        FROM shared_local_delegations d JOIN shared_local_connections c ON c.connection_id=d.connection_id
        WHERE d.revoked_at IS NULL AND json_extract(c.definition_json,'$.revokedAt') IS NULL
          AND json_extract(d.registration_json,'$.binding.mobId')=${invocation.mobId}
          AND json_extract(d.registration_json,'$.binding.sessionId')=${invocation.sessionId}
          AND d.local_id > ${after} ORDER BY d.local_id LIMIT ${EXPIRY_SCAN_PAGE_SIZE}`,
      2,
    );
    if (rows.length !== 1)
      return yield* fail(
        "forbidden",
        "This native caller has no unambiguous enabled local delegation.",
      );
    const row = rows[0]!;
    const registration = yield* parse(
      Schema.fromJsonString(SharedDelegationRegisterInput),
      row.registration_json,
    );
    const binding = yield* parse(
      SharedLocalAgentBinding,
      yield* resolveNative(registration.binding.threadId),
    );
    if (sharedFingerprint(binding) !== sharedFingerprint(registration.binding))
      return yield* fail("forbidden", "The current native session differs from this delegation.");
    const saved = yield* connection(row.owner_session_id, row.connection_id);
    if (!row.definition_json)
      return yield* fail(
        "unavailable",
        "The remote delegation is not yet confirmed. Retry enabling it with the same request ID.",
      );
    const grant = yield* parse(Schema.fromJsonString(SharedDelegation), row.definition_json);
    if (
      grant.revokedAt ||
      !(Date.parse(grant.expiresAt) > Date.parse(yield* now)) ||
      !grant.actions.includes(action)
    )
      return yield* fail("forbidden", "This action is not permitted by the active delegation.");
    let remoteArguments = invocation.arguments;
    if (
      action === "specialists.send" ||
      action === "activity.publish" ||
      action === "knowledge.record" ||
      action === "knowledge.supersede"
    ) {
      const context = grant.context;
      for (const key of ["contextId", "contextVersion"] as const) {
        if (Object.hasOwn(remoteArguments, key) && remoteArguments[key] !== context[key])
          return yield* fail(
            "forbidden",
            "This action must use the delegation's exact immutable task context.",
          );
      }
      remoteArguments = {
        ...remoteArguments,
        contextId: context.contextId,
        contextVersion: context.contextVersion,
      };
      if (action !== "specialists.send") {
        if (
          Object.hasOwn(remoteArguments, "revision") &&
          sharedFingerprint(remoteArguments.revision) !== sharedFingerprint(context.revision)
        )
          return yield* fail(
            "forbidden",
            "This action must use the delegation's exact immutable task revision.",
          );
        remoteArguments = { ...remoteArguments, revision: context.revision };
      }
    }
    if (Buffer.byteLength(encode(remoteArguments)) > 128 * 1024)
      return yield* fail("limit_exceeded", "Shared action arguments exceed 128 KiB.");
    const credentials = yield* privateConnection(saved.row, saved.value);
    // No credential, target, grant or caller identity is taken from model arguments.
    // Recheck after asynchronous native/secret observation and immediately before dispatch.
    const current =
      yield* sql`SELECT local_id FROM shared_local_delegations WHERE local_id=${row.local_id} AND revoked_at IS NULL`;
    if (!current.length) return yield* fail("forbidden", "This local delegation has been revoked.");
    yield* connection(row.owner_session_id, row.connection_id);
    const dispatchAt = Date.parse(yield* now);
    if (
      !(Date.parse(registration.expiresAt) > dispatchAt) ||
      !(Date.parse(grant.expiresAt) > dispatchAt)
    )
      return yield* fail("forbidden", "This local delegation has expired.");
    return yield* remoteCall(
      remote.invoke(credentials, {
        delegationId: grant.delegationId,
        action,
        arguments: remoteArguments,
      }),
    );
  }, Effect.mapError(failure));
  return { connect, list, enable, listDelegations, revoke, disconnect, cancelSetup, invoke };
});

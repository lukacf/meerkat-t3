import {
  AuthSharedContributeScope,
  AuthSharedReadScope,
  SharedDelegation,
  SharedWorkspaceError,
  type SharedDelegationAction,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeScopes = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeDelegation = Schema.decodeEffect(Schema.fromJsonString(SharedDelegation));
const fail = () =>
  new SharedWorkspaceError({
    code: "forbidden",
    message:
      "This delegation or its parent connection has expired, been revoked, or lacks permission.",
  });
export const makeSharedDelegationAuthority = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const requireSharedParentSession = Effect.fn("SharedDelegation.requireParent")(function* (
    sessionId: string,
  ) {
    const rows = yield* sql<{
      expires_at: string;
      scopes: string;
    }>`SELECT expires_at,scopes FROM auth_sessions
    WHERE session_id=${sessionId} AND revoked_at IS NULL`;
    const observedAt = yield* DateTime.now;
    if (!rows[0] || !(Date.parse(rows[0].expires_at) > observedAt.epochMilliseconds))
      return yield* fail();
    const scopes = yield* decodeScopes(rows[0].scopes).pipe(Effect.mapError(fail));
    if (!scopes.includes(AuthSharedReadScope) || !scopes.includes(AuthSharedContributeScope))
      return yield* fail();
    return { expiresAt: rows[0].expires_at, observedAt: DateTime.formatIso(observedAt) };
  });

  /** Revalidated in the product transaction, including already-retained idempotent retries. */
  const requireSharedDelegation = Effect.fn("SharedDelegation.require")(function* (
    sessionId: string,
    delegationId: string,
    action?: SharedDelegationAction,
  ) {
    const parent = yield* requireSharedParentSession(sessionId);
    const rows = yield* sql<{
      definition_json: string;
    }>`SELECT d.definition_json FROM shared_delegations d
    JOIN shared_participant_sessions p ON p.session_id=d.parent_session_id AND p.participant_id=d.owner_participant_id
    WHERE d.delegation_id=${delegationId} AND d.parent_session_id=${sessionId}`;
    if (!rows[0]) return yield* fail();
    const grant = yield* decodeDelegation(rows[0].definition_json).pipe(Effect.mapError(fail));
    if (
      grant.revokedAt ||
      !(Date.parse(grant.expiresAt) > Date.parse(parent.observedAt)) ||
      (action && !grant.actions.includes(action))
    )
      return yield* fail();
    return grant;
  });

  return { requireSharedParentSession, requireSharedDelegation };
});

// @effect-diagnostics nodeBuiltinImport:off - host-issued opaque delegation identities.
import * as NodeCrypto from "node:crypto";
import {
  SharedDelegation,
  SharedDelegationRegisterInput,
  SharedDelegationRevokeInput,
  SharedWorkspaceError,
  type SharedDelegationAction,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeSharedDelegationAuthority } from "./SharedDelegationAuthority.ts";
import {
  sharedFingerprint,
  sharedInterestEntries,
  type SharedActor,
  type SharedWorkspaceStore,
} from "./SharedWorkspaceStore.ts";

const fail = (code: SharedWorkspaceError["code"], message: string) =>
  new SharedWorkspaceError({ code, message });
const isWorkspaceError = Schema.is(SharedWorkspaceError);
const failure = (cause: unknown) =>
  isWorkspaceError(cause)
    ? cause
    : fail("unavailable", "Delegation storage is unavailable. Retry with the same request ID.");
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const parse = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => fail("invalid_input", "Invalid delegation request.")),
  );
const normalizedExpiry = (value: string) =>
  Effect.try({
    try: () => {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
        throw new Error("timezone");
      return DateTime.formatIso(DateTime.makeUnsafe(value));
    },
    catch: () =>
      fail(
        "invalid_input",
        "Delegation expiry must be a valid timestamp with an explicit timezone.",
      ),
  });

export const makeSharedDelegationService = Effect.fn("SharedDelegation.make")(function* (
  workspace: SharedWorkspaceStore,
) {
  const sql = yield* SqlClient.SqlClient;
  const { requireSharedDelegation, requireSharedParentSession } =
    yield* makeSharedDelegationAuthority;
  const indexInterests = Effect.fn("SharedDelegation.indexInterests")(function* (
    grant: SharedDelegation,
  ) {
    // Grant context is immutable. A later human context version must not silently
    // retarget the enabled task or delete its existing inbox.
    for (const [dimension, value] of sharedInterestEntries(grant.context))
      yield* sql`INSERT INTO shared_interests(owner_id,project_id,recipient_id,dimension,value)
        VALUES (${`delegation:${grant.delegationId}`},${grant.context.sharedProjectId},${grant.delegationId},${dimension},${value})
        ON CONFLICT(owner_id,project_id,dimension,value) DO NOTHING`;
  });
  // Older enabled grants were retained without their own routing index. Repair
  // missing projections in bounded pages, without creating events or changing grants.
  while (true) {
    const repaired = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ definition_json: string }>`SELECT d.definition_json
          FROM shared_delegations d WHERE NOT EXISTS (
            SELECT 1 FROM shared_interests i WHERE i.owner_id = 'delegation:' || d.delegation_id
          ) ORDER BY d.delegation_id LIMIT 64`;
          for (const row of rows)
            yield* indexInterests(
              yield* parse(Schema.fromJsonString(SharedDelegation), row.definition_json),
            );
          return rows.length;
        }),
      )
      .pipe(Effect.mapError(failure));
    if (repaired < 64) break;
  }
  const register = Effect.fn("SharedDelegation.register")(function* (
    sessionId: string,
    raw: SharedDelegationRegisterInput,
  ) {
    const input = yield* parse(SharedDelegationRegisterInput, raw);
    const normalized = {
      ...input,
      actions: [...new Set(input.actions)].sort(),
      expiresAt: yield* normalizedExpiry(input.expiresAt),
    };
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const parent = yield* requireSharedParentSession(sessionId);
        const owner = yield* workspace.requireParticipant(sessionId);
        if (owner.kind !== "person")
          return yield* fail("forbidden", "Only a participant can delegate a local agent.");
        const fingerprint = sharedFingerprint(normalized);
        const old = yield* sql<{
          fingerprint: string;
          definition_json: string;
        }>`SELECT fingerprint,definition_json FROM shared_delegations
        WHERE parent_session_id=${sessionId} AND request_id=${input.requestId}`;
        if (old[0]) {
          const retained = yield* parse(
            Schema.fromJsonString(SharedDelegation),
            old[0].definition_json,
          );
          // Earlier rows fingerprinted the original timezone spelling. Compare
          // their retained request contents so equivalent instants remain retries.
          const previous = {
            requestId: input.requestId,
            label: retained.participant.displayName,
            binding: retained.binding,
            contextId: retained.context.contextId,
            contextVersion: retained.context.contextVersion,
            actions: [...new Set(retained.actions)].sort(),
            expiresAt: yield* normalizedExpiry(retained.expiresAt),
          };
          if (old[0].fingerprint !== fingerprint && sharedFingerprint(previous) !== fingerprint)
            return yield* fail(
              "conflict",
              "This delegation request already has different contents.",
            );
          yield* indexInterests(retained);
          return retained;
        }
        const expires = Date.parse(normalized.expiresAt);
        if (
          !(expires > Date.parse(parent.observedAt)) ||
          expires > Date.parse(parent.expiresAt) ||
          expires > Date.parse(parent.observedAt) + 86_400_000
        )
          return yield* fail(
            "invalid_input",
            "Delegation must expire within 24 hours and before its parent connection expires.",
          );
        const context = yield* workspace.context(input.contextId, input.contextVersion);
        const checkout = yield* workspace.checkout(context.checkoutId);
        if (
          context.participantId !== owner.participantId ||
          context.source.kind !== "thread" ||
          context.source.threadId !== input.binding.threadId ||
          checkout.localEnvironmentId !== input.binding.environmentId ||
          checkout.localProjectId !== input.binding.projectId
        )
          return yield* fail(
            "forbidden",
            "The delegation must use the participant's exact checkout, task and immutable context version.",
          );
        const active = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM shared_delegations
        WHERE parent_session_id=${sessionId} AND json_extract(definition_json,'$.revokedAt') IS NULL
        AND ((json_extract(definition_json,'$.expiresAt') NOT GLOB '*Z'
            AND json_extract(definition_json,'$.expiresAt') NOT GLOB '*[+-][0-9][0-9]:[0-9][0-9]')
          OR julianday(json_extract(definition_json,'$.expiresAt')) IS NULL
          OR julianday(json_extract(definition_json,'$.expiresAt')) > julianday(${parent.observedAt}))`;
        if ((active[0]?.count ?? 0) >= 100)
          return yield* fail(
            "limit_exceeded",
            "This connection already has 100 active delegations.",
          );
        const delegationId = `local-agent-${NodeCrypto.randomUUID()}`;
        const value: SharedDelegation = {
          delegationId,
          ownerParticipantId: owner.participantId,
          binding: input.binding,
          context,
          actions: normalized.actions,
          expiresAt: normalized.expiresAt,
          createdAt: parent.observedAt,
          revokedAt: null,
          participant: {
            participantId: delegationId,
            kind: "local_agent",
            displayName: input.label,
            createdAt: parent.observedAt,
            provenance: {
              kind: "participant_broker_assertion",
              delegationId,
              ownerParticipantId: owner.participantId,
              localEnvironmentId: input.binding.environmentId,
              localProjectId: input.binding.projectId,
              localThreadId: input.binding.threadId,
            },
          },
        };
        yield* sql`INSERT INTO shared_delegations(delegation_id,parent_session_id,owner_participant_id,request_id,fingerprint,definition_json)
        VALUES (${delegationId},${sessionId},${owner.participantId},${input.requestId},${fingerprint},${encode(value)})`;
        yield* sql`INSERT INTO shared_participants(participant_id,definition_json) VALUES (${delegationId},${encode(value.participant)})`;
        yield* indexInterests(value);
        // The participant separately opts into publication. Retain the objective
        // once with its admitted context, never a later task title or checkout.
        if (value.actions.includes("activity.publish"))
          yield* workspace.publishActivity(
            {
              kind: "local_agent",
              delegationId,
              sessionId,
              action: "activity.publish",
            },
            {
              eventId: `task-started-${delegationId}`,
              contextId: context.contextId,
              contextVersion: context.contextVersion,
              revision: context.revision,
              kind: "task_started",
              summary: context.objective,
              paths: context.paths,
              tags: context.tags,
              sources: [],
            },
          );
        return value;
      }),
    );
  }, Effect.mapError(failure));
  const revoke = Effect.fn("SharedDelegation.revoke")(function* (
    sessionId: string,
    raw: SharedDelegationRevokeInput,
  ) {
    const input = yield* parse(SharedDelegationRevokeInput, raw);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const parent = yield* requireSharedParentSession(sessionId);
        const rows = yield* sql<{
          definition_json: string;
        }>`SELECT definition_json FROM shared_delegations
        WHERE delegation_id=${input.delegationId} AND parent_session_id=${sessionId}`;
        if (!rows[0])
          return yield* fail("forbidden", "This delegation does not belong to the connection.");
        const old = yield* parse(Schema.fromJsonString(SharedDelegation), rows[0].definition_json);
        const value = { ...old, revokedAt: old.revokedAt ?? parent.observedAt };
        yield* sql`UPDATE shared_delegations SET definition_json=${encode(value)} WHERE delegation_id=${value.delegationId}`;
        return value;
      }),
    );
  }, Effect.mapError(failure));
  const authorize = Effect.fn("SharedDelegation.authorize")(function* (
    sessionId: string,
    input: { readonly delegationId: string; readonly action: SharedDelegationAction },
  ) {
    const grant = yield* requireSharedDelegation(sessionId, input.delegationId, input.action);
    const actor: Extract<SharedActor, { kind: "local_agent" }> = {
      kind: "local_agent",
      delegationId: grant.delegationId,
      sessionId,
      action: input.action,
    };
    return { grant, actor };
  }, Effect.mapError(failure));
  return { register, revoke, authorize };
});

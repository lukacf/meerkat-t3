import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type SharedDelegationRegisterInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeSharedDelegationService } from "./SharedDelegationService.ts";
import { makeSharedWorkspaceStore, sharedFingerprint } from "./SharedWorkspaceStore.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fixture = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse("2026-10-17T12:00:00Z"));
  const sql = yield* SqlClient.SqlClient;
  const timestamp = DateTime.formatIso(yield* DateTime.now);
  yield* sql`INSERT INTO auth_sessions(session_id,subject,scopes,method,issued_at,expires_at)
    VALUES ('session','owner','["shared:read","shared:contribute"]','pairing',${timestamp},'2026-10-18T12:00:00Z')`;
  const store = yield* makeSharedWorkspaceStore;
  yield* store.configure({ name: "Expiry fixture" });
  const owner = yield* store.join("session", { displayName: "Owner" });
  const project = yield* store.registerProject({
    requestId: "project",
    name: "Project",
    repository: "https://github.com/example/project",
    hostProjectId: ProjectId.make("host-project"),
  });
  const checkout = yield* store.attachCheckout("session", {
    repository: project.repository,
    localEnvironmentId: EnvironmentId.make("personal"),
    localProjectId: ProjectId.make("local-project"),
  });
  const context = yield* store.putContext(
    { kind: "participant", participantId: owner.participantId },
    {
      contextId: "context",
      checkoutId: checkout.checkoutId,
      source: { kind: "thread", threadId: ThreadId.make("task") },
      objective: "Inspect the project",
      revision: { branch: "feature", commit: "a".repeat(40), applicability: "branch" },
      paths: ["src"],
      tags: [],
    },
  );
  const input: SharedDelegationRegisterInput = {
    requestId: "grant",
    label: "Project task",
    binding: {
      environmentId: checkout.localEnvironmentId,
      projectId: checkout.localProjectId,
      threadId: ThreadId.make("task"),
      instanceId: ProviderInstanceId.make("meerkat"),
      mobId: "mob",
      sessionId: "native-session",
    },
    contextId: context.contextId,
    contextVersion: context.contextVersion,
    actions: ["inbox.list"],
    expiresAt: "2026-10-17T01:00:00-12:00",
  };
  return { sql, input, grants: yield* makeSharedDelegationService(store), owner };
});

describe("shared delegation expiry", () => {
  it.effect("normalizes timezone-qualified instants and preserves equivalent retries", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.grants.register("session", f.input);
      expect(first.expiresAt).toBe("2026-10-17T13:00:00.000Z");
      expect(
        yield* f.grants.register("session", {
          ...f.input,
          expiresAt: "2026-10-17T15:00:00+02:00",
        }),
      ).toEqual(first);
      expect(
        (yield* f.grants
          .register("session", { ...f.input, expiresAt: "2026-10-17T13:01:00Z" })
          .pipe(Effect.flip)).code,
      ).toBe("conflict");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("counts active legacy offset grants and releases only expired admission slots", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.grants.register("session", f.input);
      // Model the pre-normalization database, not only newly canonicalized rows.
      const legacy = { ...first, expiresAt: f.input.expiresAt };
      yield* f.sql`UPDATE shared_delegations SET definition_json=${encode(legacy)},
        fingerprint=${sharedFingerprint(f.input)} WHERE delegation_id=${first.delegationId}`;
      for (let index = 1; index < 100; index++) {
        const delegationId = `legacy-${index}`;
        yield* f.sql`INSERT INTO shared_delegations
          (delegation_id,parent_session_id,owner_participant_id,request_id,fingerprint,definition_json)
          VALUES (${delegationId},'session',${f.owner.participantId},${`request-${index}`},'legacy',${encode({ ...legacy, delegationId })})`;
      }
      expect(
        (yield* f.grants
          .register("session", { ...f.input, requestId: "over-limit" })
          .pipe(Effect.flip)).code,
      ).toBe("limit_exceeded");
      expect(
        yield* f.grants.register("session", {
          ...f.input,
          expiresAt: "2026-10-17T13:00:00.000Z",
        }),
      ).toEqual(legacy);
      for (const expiresAt of ["2026-10-17T01:00:00", "unknown"]) {
        yield* f.sql`UPDATE shared_delegations SET definition_json=${encode({ ...legacy, delegationId: "legacy-1", expiresAt })}
          WHERE delegation_id='legacy-1'`;
        expect(
          (yield* f.grants
            .register("session", { ...f.input, requestId: "ambiguous-history" })
            .pipe(Effect.flip)).code,
        ).toBe("limit_exceeded");
      }
      yield* f.sql`UPDATE shared_delegations SET definition_json=${encode({ ...legacy, delegationId: "legacy-1", expiresAt: "2026-10-17T23:59:59+12:00" })}
        WHERE delegation_id='legacy-1'`;
      const admitted = yield* f.grants.register("session", {
        ...f.input,
        requestId: "reuses-expired-slot",
      });
      expect(admitted.revokedAt).toBeNull();
      expect(yield* f.sql`SELECT delegation_id FROM shared_delegations`).toHaveLength(101);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("refuses ambiguous expiry and preserves the parent and 24-hour bounds", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const expiresAt of [
        "2026-10-17T13:00:00",
        "tomorrow",
        "2026-10-17T13:00:00+99:00",
        "2026-10-17T11:00:00Z",
        "2026-10-18T12:00:01Z",
      ])
        expect(
          (yield* f.grants.register("session", { ...f.input, expiresAt }).pipe(Effect.flip)).code,
        ).toBe("invalid_input");
      expect(yield* f.sql`SELECT delegation_id FROM shared_delegations`).toHaveLength(0);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});

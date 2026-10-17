import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  type SharedCompositionInput,
  type SharedCompositionOperation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeSharedCompositionHistory } from "./SharedCompositionHistory.ts";
import { makeSharedWorkspaceStore, type SharedActor } from "./SharedWorkspaceStore.ts";

const timestamp = "2026-10-17T12:00:00.000Z";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* makeSharedWorkspaceStore;
  yield* store.configure({ name: "Shared engineering" });
  const participant = yield* store.join("alice-session", { displayName: "Alice" });
  const actor: SharedActor = { kind: "participant", participantId: participant.participantId };
  const project = yield* store.registerProject({
    requestId: "catalog-project",
    name: "Catalog",
    repository: "https://github.com/example/catalog",
    hostProjectId: ProjectId.make("host-catalog"),
  });
  const assignments = [
    {
      sharedProjectId: project.sharedProjectId,
      charter: "Own catalog compatibility",
      paths: ["src/catalog"],
      tags: ["catalog"],
    },
  ];
  const specialist = yield* store.registerSpecialist({
    requestId: "catalog-specialist",
    label: "Catalog contracts",
    nativeTarget: {
      projectId: project.hostProjectId,
      instanceId: ProviderInstanceId.make("meerkat"),
      agentId: "native-catalog",
    },
    assignments,
  });
  const other = yield* store.registerSpecialist({
    requestId: "storage-specialist",
    label: "Storage",
    nativeTarget: { ...specialist.nativeTarget, agentId: "native-storage" },
    assignments,
  });
  const history = yield* makeSharedCompositionHistory(store);
  const insert = (
    operationId: string,
    patch: Partial<SharedCompositionOperation> = {},
    inputPatch: Partial<SharedCompositionInput> = {},
  ) => {
    const input: SharedCompositionInput = {
      operationId,
      kind: "revise",
      creations: [],
      revisions: [
        {
          specialistId: specialist.specialistId,
          expectedVersion: 0,
          assignments,
          instructions: "PRIVATE RUNTIME INSTRUCTIONS",
        },
      ],
      peers: [],
      transitions: [],
      ...inputPatch,
    };
    const operation: SharedCompositionOperation = {
      operationId,
      operationKey: `key-${operationId}`,
      actor: { kind: "participant", id: participant.participantId },
      kind: input.kind,
      status: "pending",
      detail: null,
      creations: [],
      evidence: [],
      lineage: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      ...patch,
    };
    return sql`INSERT INTO shared_composition_operations (operation_key, actor_key, operation_id, fingerprint, input_json, definition_json) VALUES (${operation.operationKey}, ${`${operation.actor.kind}:${operation.actor.id}`}, ${operationId}, ${`fingerprint-${operationId}`}, ${encode(input)}, ${encode(operation)})`;
  };
  return { sql, store, actor, specialist, other, assignments, insert, history };
});

describe("shared responsibility history", () => {
  it.effect(
    "reads pending, conflict and completed observations without executing or rewriting them",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.insert("pending", {
          detail: "Native acknowledgement unavailable; retry retained.",
        });
        yield* f.insert("conflict", {
          status: "conflict",
          detail: "Assignment version has changed.",
        });
        yield* f.insert("completed", {
          status: "completed",
          evidence: [
            {
              step: "revision",
              kind: "native_revision",
              nativeTarget: f.specialist.nativeTarget,
              revisionId: "native-revision-7",
              observedAt: timestamp,
            },
          ],
        });
        const before = yield* f.sql`SELECT * FROM shared_composition_operations ORDER BY rowid`;
        const page = yield* f.history.read(f.actor, { specialistId: f.specialist.specialistId });
        expect(page.items.map((item) => item.operation.status)).toEqual([
          "completed",
          "conflict",
          "pending",
        ]);
        expect(page.items[0]?.operation.evidence[0]?.revisionId).toBe("native-revision-7");
        expect(page.items[2]?.operation.detail).toContain("acknowledgement unavailable");
        expect(page.items[0]?.assignments[0]?.expectedVersion).toBe(0);
        expect(encode(page)).not.toContain("PRIVATE RUNTIME INSTRUCTIONS");
        expect(yield* f.sql`SELECT * FROM shared_composition_operations ORDER BY rowid`).toEqual(
          before,
        );
        expect(yield* f.store.specialist(f.specialist.specialistId)).toEqual(f.specialist);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("resolves current host author names without changing retained actor identity", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const bob = yield* f.store.join("bob-session", { displayName: "Bob" });
      yield* f.insert("bob-change", { actor: { kind: "participant", id: bob.participantId } });
      yield* f.insert("specialist-change", {
        actor: { kind: "specialist", id: f.other.specialistId },
      });
      yield* f.insert("missing-author", { actor: { kind: "participant", id: "missing-member" } });
      yield* f.store.join("bob-session", { displayName: "Robert" });
      const page = yield* f.history.read(f.actor, { specialistId: f.specialist.specialistId });
      expect(page.items.map((item) => item.authorDisplayName)).toEqual([null, "Storage", "Robert"]);
      expect(page.items[2]?.operation.actor).toEqual({
        kind: "participant",
        id: bob.participantId,
      });
      expect(page.items[0]?.operation.actor).toEqual({ kind: "participant", id: "missing-member" });
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("pages by immutable admission order and excludes unrelated specialists", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const id of ["first", "second", "third"]) yield* f.insert(id);
      yield* f.insert(
        "unrelated",
        {},
        {
          revisions: [
            { specialistId: f.other.specialistId, expectedVersion: 0, assignments: f.assignments },
          ],
        },
      );
      const first = yield* f.history.read(f.actor, {
        specialistId: f.specialist.specialistId,
        limit: 2,
      });
      expect(first.items.map((item) => item.operation.operationId)).toEqual(["third", "second"]);
      expect(first.nextCursor).not.toBeNull();
      yield* f.insert("arrived-after-page");
      const second = yield* f.history.read(f.actor, {
        specialistId: f.specialist.specialistId,
        cursor: first.nextCursor!,
        limit: 2,
      });
      expect(second.items.map((item) => item.operation.operationId)).toEqual(["first"]);
      expect(second.nextCursor).toBeNull();
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect(
    "includes retained predecessor, successor, peer and creation evidence across authors",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.insert(
          "split",
          {
            kind: "split",
            status: "completed",
            actor: { kind: "specialist", id: f.other.specialistId },
            lineage: [
              {
                predecessorId: f.other.specialistId,
                successorIds: [f.specialist.specialistId],
                superseded: true,
              },
            ],
          },
          {
            kind: "split",
            revisions: [],
            transitions: [
              {
                predecessorId: f.other.specialistId,
                expectedVersion: 0,
                successors: [{ creationKey: "new-specialist" }],
                supersede: true,
              },
            ],
          },
        );
        yield* f.insert(
          "connect",
          { kind: "connect" },
          {
            kind: "connect",
            revisions: [],
            peers: [
              {
                source: { specialistId: f.other.specialistId, expectedVersion: 0 },
                target: { specialistId: f.specialist.specialistId, expectedVersion: 0 },
              },
            ],
          },
        );
        yield* f.insert(
          "create",
          {
            kind: "create",
            status: "completed",
            creations: [
              {
                key: "created",
                nativeTarget: f.specialist.nativeTarget,
                specialistId: f.specialist.specialistId,
              },
            ],
          },
          {
            kind: "create",
            revisions: [],
            creations: [
              {
                key: "created",
                anchorSharedProjectId: f.assignments[0]!.sharedProjectId,
                instanceId: f.specialist.nativeTarget.instanceId,
                label: "Catalog contracts",
                role: "contracts",
                instructions: "PRIVATE CREATION INSTRUCTIONS",
                model: "PRIVATE MODEL",
                assignments: f.assignments,
              },
            ],
          },
        );
        const page = yield* f.history.read(f.actor, { specialistId: f.specialist.specialistId });
        expect(page.items.map((item) => item.operation.operationId)).toEqual([
          "create",
          "connect",
          "split",
        ]);
        expect(page.items[2]?.operation.lineage[0]).toEqual({
          predecessorId: f.other.specialistId,
          successorIds: [f.specialist.specialistId],
          superseded: true,
        });
        expect(page.items[0]?.assignments[0]?.specialistId).toBe(f.specialist.specialistId);
        expect(encode(page)).not.toContain("PRIVATE");
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("does not mistake provider option content for a specialist relationship", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.insert(
        "unrelated-creation",
        {},
        {
          revisions: [],
          creations: [
            {
              key: "new",
              anchorSharedProjectId: f.assignments[0]!.sharedProjectId,
              instanceId: f.other.nativeTarget.instanceId,
              label: "Independent specialist",
              role: "independent",
              instructions: "Private instructions",
              model: "test-model",
              assignments: f.assignments,
            },
          ],
        },
      );
      yield* f.sql`UPDATE shared_composition_operations
        SET input_json = json_set(input_json, '$.creations[0].options', json(${encode({ specialistId: f.specialist.specialistId })}))
        WHERE operation_id = 'unrelated-creation'`;
      const page = yield* f.history.read(f.actor, { specialistId: f.specialist.specialistId });
      expect(page.items).toEqual([]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("bounds response bytes without losing the continuation record", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.insert("older", { detail: "a".repeat(150_000) });
      yield* f.insert("newer", { detail: "b".repeat(150_000) });
      const first = yield* f.history.read(f.actor, { specialistId: f.specialist.specialistId });
      expect(first.items.map((item) => item.operation.operationId)).toEqual(["newer"]);
      const second = yield* f.history.read(f.actor, {
        specialistId: f.specialist.specialistId,
        cursor: first.nextCursor!,
      });
      expect(second.items.map((item) => item.operation.operationId)).toEqual(["older"]);
      expect(second.nextCursor).toBeNull();
      yield* f.insert("oversized", { detail: "c".repeat(300_000) });
      expect(
        yield* f.history
          .read(f.actor, { specialistId: f.specialist.specialistId })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "limit_exceeded" });
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect(
    "requires a workspace member and a known specialist, and rejects malformed paging",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        expect(
          yield* f.history
            .read(
              { kind: "participant", participantId: "unknown" },
              { specialistId: f.specialist.specialistId },
            )
            .pipe(Effect.flip),
        ).toMatchObject({ code: "not_joined" });
        expect(
          yield* f.history.read(f.actor, { specialistId: "unknown" }).pipe(Effect.flip),
        ).toMatchObject({ code: "not_found" });
        for (const cursor of [
          "0",
          "composition:0",
          "composition:-1",
          "composition:9223372036854775808",
          "composition:1.5",
        ])
          expect(
            yield* f.history
              .read(f.actor, { specialistId: f.specialist.specialistId, cursor })
              .pipe(Effect.flip),
          ).toMatchObject({ code: "invalid_input" });
        expect(
          yield* f.history
            .read(f.actor, { specialistId: f.specialist.specialistId, limit: 21 })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "invalid_input" });
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});

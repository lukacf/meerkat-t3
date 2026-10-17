import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  SharedKnowledge,
  type SharedActivityPublishInput,
  type SharedRevision,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeSharedWorkspaceStore, type SharedActor } from "./SharedWorkspaceStore.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const isKnowledge = Schema.is(SharedKnowledge);
const revisionA: SharedRevision = {
  branch: "feature/interface",
  commit: "a".repeat(40),
  applicability: "branch",
};
const revisionB: SharedRevision = {
  branch: "feature/client",
  commit: "b".repeat(40),
  applicability: "branch",
};
const fixture = Effect.gen(function* () {
  const store = yield* makeSharedWorkspaceStore;
  yield* store.configure({ name: "Shared development" });
  const a = yield* store.join("session-a", { displayName: "Ada" });
  const b = yield* store.join("session-b", { displayName: "Ben" });
  const actorA: SharedActor = { kind: "participant", participantId: a.participantId };
  const actorB: SharedActor = { kind: "participant", participantId: b.participantId };
  const project = yield* store.registerProject({
    requestId: "register-api",
    name: "API",
    repository: "git@github.com:Example/API.git",
    aliases: ["https://mirror.example/Example/API.git"],
    hostProjectId: ProjectId.make("host-api"),
  });
  const second = yield* store.registerProject({
    requestId: "register-web",
    name: "Web",
    repository: "https://github.com/example/web",
    hostProjectId: ProjectId.make("host-web"),
  });
  const aCheckout = yield* store.attachCheckout("session-a", {
    localEnvironmentId: EnvironmentId.make("ada-mac"),
    localProjectId: ProjectId.make("ada-api"),
    repository: "https://github.com/example/api.git",
  });
  const bCheckout = yield* store.attachCheckout("session-b", {
    localEnvironmentId: EnvironmentId.make("ben-mac"),
    localProjectId: ProjectId.make("ben-api"),
    repository: "ssh://git@github.com/Example/API",
  });
  const specialist = yield* store.registerSpecialist({
    requestId: "register-contracts",
    label: "API contracts",
    nativeTarget: {
      projectId: project.hostProjectId,
      instanceId: ProviderInstanceId.make("meerkat"),
      agentId: "native-contracts",
    },
    assignments: [project, second].map((p) => ({
      sharedProjectId: p.sharedProjectId,
      charter: "Own interface compatibility.",
      paths: ["src/api"],
      tags: ["interfaces"],
    })),
  });
  const aContext = yield* store.putContext(actorA, {
    contextId: "ada-task",
    checkoutId: aCheckout.checkoutId,
    source: { kind: "project_conversation" },
    objective: "Change the API",
    revision: revisionA,
    paths: ["src/api"],
    tags: ["interfaces"],
  });
  const bContext = yield* store.putContext(actorB, {
    contextId: "ben-task",
    checkoutId: bCheckout.checkoutId,
    source: { kind: "project_conversation" },
    objective: "Integrate the API",
    revision: revisionB,
    paths: ["src/api"],
    tags: ["interfaces"],
  });
  const activity = (eventId: string): SharedActivityPublishInput => ({
    eventId,
    contextId: aContext.contextId,
    contextVersion: aContext.contextVersion,
    revision: revisionA,
    kind: "changes",
    summary: "The interface adds a required tenant field.",
    paths: ["src/api/types.ts"],
    tags: ["interfaces"],
    sources: [
      { title: "Revision", uri: "https://github.com/example/api/commit/" + revisionA.commit },
    ],
  });
  return {
    store,
    a,
    b,
    actorA,
    actorB,
    project,
    second,
    specialist,
    aCheckout,
    bCheckout,
    aContext,
    bContext,
    activity,
  };
});

describe("shared workspace evidence capacity", () => {
  it.effect(
    "reserves saved inbox copies once and retains accounting through replay and acknowledgement",
    () =>
      Effect.gen(function* () {
        const { store, actorA, actorB, aCheckout, activity } = yield* fixture;
        const before = (yield* store.snapshot("session-a")).capacity!;
        const patch = { checkoutId: aCheckout.checkoutId, revision: revisionA, patch: "+漢字\n" };
        const snapshot = yield* store.putSnapshot(actorA, patch);
        const published = yield* store.publishActivity(actorA, activity("reserved-copy"));
        const after = (yield* store.snapshot("session-a")).capacity!;
        expect(after.evidence.bytes).toBeGreaterThan(before.evidence.bytes);
        expect(after.evidence.records).toBe(before.evidence.records + 4);
        expect(after.inbox.pending).toBe(2);
        expect(after.specialists).toEqual({ registeredAndReserved: 1, maxSpecialists: 24 });
        expect(after.pendingRequests).toBe(0);
        expect(after.pendingCompositionOperations).toBe(0);
        // Recreate the store over retained rows, as after a service restart.
        const resumed = yield* makeSharedWorkspaceStore;
        expect(yield* resumed.putSnapshot(actorA, patch)).toEqual(snapshot);
        expect(yield* resumed.publishActivity(actorA, activity("reserved-copy"))).toEqual(
          published,
        );
        const batch = yield* resumed.readInbox(actorB, {});
        expect(batch.events).toEqual([published]);
        expect(yield* resumed.readInbox(actorB, {})).toEqual(batch);
        expect((yield* resumed.snapshot("session-a")).capacity).toEqual(after);
        yield* resumed.acknowledgeInbox(actorB, { batchId: batch.batchId! });
        const acknowledged = (yield* resumed.snapshot("session-a")).capacity!;
        expect(acknowledged.evidence).toEqual(after.evidence);
        expect(acknowledged.inbox.pending).toBe(1);
        yield* resumed.acknowledgeInbox(actorB, { batchId: batch.batchId! });
        expect((yield* resumed.snapshot("session-a")).capacity).toEqual(acknowledged);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("refuses aggregate growth without replacing accepted contexts or snapshots", () =>
    Effect.gen(function* () {
      const { store, actorA, aContext, aCheckout, activity } = yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      const patch = { checkoutId: aCheckout.checkoutId, revision: revisionA, patch: "+retained\n" };
      const saved = yield* store.putSnapshot(actorA, patch);
      const limit = (yield* store.snapshot("session-a")).capacity!.evidence.maxBytes;
      // Model preexisting usage without allocating 256 MiB in a unit fixture.
      // The migration test separately verifies counters against actual UTF-8 rows.
      yield* sql`UPDATE shared_evidence_usage SET bytes = ${limit} WHERE singleton = 1`;
      const before = yield* sql`SELECT * FROM shared_evidence_usage`;
      const changed = yield* store
        .putContext(actorA, {
          contextId: aContext.contextId,
          checkoutId: aCheckout.checkoutId,
          source: { kind: "project_conversation" },
          objective: "A new objective",
          revision: revisionB,
          paths: ["different-area"],
          tags: [],
        })
        .pipe(Effect.flip);
      expect(changed.code).toBe("limit_exceeded");
      expect(changed.message).toContain("raise its server evidence limits");
      expect(yield* store.context(aContext.contextId)).toEqual(aContext);
      expect(
        (yield* store.putSnapshot(actorA, { ...patch, patch: "+new\n" }).pipe(Effect.flip)).code,
      ).toBe("limit_exceeded");
      expect(
        (yield* store.publishActivity(actorA, activity("over-budget")).pipe(Effect.flip)).code,
      ).toBe("limit_exceeded");
      expect(yield* sql`SELECT * FROM shared_activity`).toEqual([]);
      expect(yield* sql`SELECT * FROM shared_inbox`).toEqual([]);
      expect(yield* sql`SELECT * FROM shared_evidence_usage`).toEqual(before);
      expect(yield* store.putSnapshot(actorA, patch)).toEqual(saved);
      expect((yield* store.getSnapshot(saved.snapshotId)).patch).toBe(patch.patch);
      expect(yield* sql`SELECT * FROM shared_evidence_usage`).toEqual(before);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "rolls back a correction and fan-out at the record limit while retaining original evidence and receipts",
    () =>
      Effect.gen(function* () {
        const { store, actorA, actorB, aContext, activity } = yield* fixture;
        const sql = yield* SqlClient.SqlClient;
        const input = {
          evidenceId: "retained-finding",
          contextId: aContext.contextId,
          contextVersion: aContext.contextVersion,
          revision: revisionA,
          kind: "finding" as const,
          title: "Original finding",
          body: "Still retained.",
          sources: [],
          supersedes: [],
          state: "open" as const,
        };
        const original = yield* store.putKnowledge(actorA, input);
        yield* store.publishActivity(actorA, activity("retained-briefing"));
        const batch = yield* store.readInbox(actorB, {});
        yield* store.acknowledgeInbox(actorB, { batchId: batch.batchId! });
        const receipts = yield* sql`SELECT * FROM shared_inbox_batches`;
        const limit = (yield* store.snapshot("session-a")).capacity!.evidence.maxRecords;
        // There is room for knowledge and its event, but not their inbox fan-out.
        yield* sql`UPDATE shared_evidence_usage SET records = ${limit - 2} WHERE singleton = 1`;
        const before = yield* sql`SELECT * FROM shared_evidence_usage`;
        const result = yield* store
          .putKnowledge(actorA, {
            ...input,
            evidenceId: "refused-correction",
            title: "Revised finding",
            supersedes: [input.evidenceId],
          })
          .pipe(Effect.flip);
        expect(result.code).toBe("limit_exceeded");
        expect(yield* sql`SELECT evidence_id FROM shared_knowledge`).toEqual([
          { evidence_id: input.evidenceId },
        ]);
        expect(yield* sql`SELECT evidence_id FROM shared_knowledge_search`).toEqual([
          { evidence_id: input.evidenceId },
        ]);
        expect(yield* sql`SELECT * FROM shared_knowledge_corrections`).toEqual([]);
        expect(yield* sql`SELECT event_id FROM shared_activity`).toEqual([
          { event_id: "retained-briefing" },
        ]);
        expect(yield* sql`SELECT * FROM shared_evidence_usage`).toEqual(before);
        expect(yield* sql`SELECT * FROM shared_inbox_batches`).toEqual(receipts);
        yield* sql`UPDATE shared_evidence_usage SET records = ${limit} WHERE singleton = 1`;
        expect(yield* store.putKnowledge(actorA, input)).toEqual(original);
        expect(
          (yield* store.searchKnowledge({ evidenceId: input.evidenceId })).records[0]?.body,
        ).toBe(original.body);
        expect(
          (yield* store
            .putKnowledge(actorA, { ...input, evidenceId: "one-too-many" })
            .pipe(Effect.flip)).code,
        ).toBe("limit_exceeded");
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "refuses an overflowing fan-out and lets recipients drain and retry at the boundary",
    () =>
      Effect.gen(function* () {
        const { store, actorA, actorB, activity } = yield* fixture;
        const sql = yield* SqlClient.SqlClient;
        yield* store.publishActivity(actorA, activity("already-pending"));
        const limits = (yield* store.snapshot("session-a")).capacity!;
        yield* sql`UPDATE shared_evidence_usage SET pending_inbox = ${limits.inbox.maxPending - 1}
        WHERE singleton = 1`;
        const before = yield* sql`SELECT * FROM shared_evidence_usage`;
        const refused = yield* store
          .publishActivity(actorA, activity("retry-after-catchup"))
          .pipe(Effect.flip);
        expect(refused.code).toBe("limit_exceeded");
        expect(refused.message).toContain("fetch and acknowledge");
        expect(yield* sql`SELECT event_id FROM shared_activity`).toEqual([
          { event_id: "already-pending" },
        ]);
        expect(yield* sql`SELECT * FROM shared_evidence_usage`).toEqual(before);
        const batch = yield* store.readInbox(actorB, {});
        yield* store.acknowledgeInbox(actorB, { batchId: batch.batchId! });
        yield* store.publishActivity(actorA, activity("retry-after-catchup"));
        expect((yield* store.snapshot("session-a")).capacity!.inbox.pending).toBe(
          limits.inbox.maxPending,
        );
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "keeps fetch, acknowledgement and exact request outcome recording available at full evidence capacity",
    () =>
      Effect.gen(function* () {
        const { store, actorA, actorB, a, aContext, specialist, activity } = yield* fixture;
        const sql = yield* SqlClient.SqlClient;
        const published = yield* store.publishActivity(actorA, activity("accepted-before-full"));
        const limit = (yield* store.snapshot("session-a")).capacity!.evidence;
        yield* sql`INSERT INTO shared_specialist_requests
        (request_id, participant_id, specialist_id, client_request_id, fingerprint, definition_json, native_input_json)
        VALUES ('native-bound-request', ${a.participantId}, ${specialist.specialistId}, 'client-request', 'fingerprint',
          ${encodeJson({ context: aContext, outcome: { status: "accepted" } })}, '{}')`;
        yield* sql`UPDATE shared_evidence_usage SET bytes = ${limit.maxBytes}, records = ${limit.maxRecords}
        WHERE singleton = 1`;
        expect((yield* store.snapshot("session-a")).capacity!.pendingRequests).toBe(1);
        const batch = yield* store.readInbox(actorB, {});
        expect(batch.events).toEqual([published]);
        yield* store.acknowledgeInbox(actorB, { batchId: batch.batchId! });
        expect(yield* store.publishActivity(actorA, activity("accepted-before-full"))).toEqual(
          published,
        );
        const completed = encodeJson({
          context: aContext,
          outcome: { status: "completed", completion: "exact observed outcome" },
        });
        yield* sql`UPDATE shared_specialist_requests SET definition_json = ${completed}
        WHERE request_id = 'native-bound-request'`;
        expect(
          yield* sql`SELECT definition_json FROM shared_specialist_requests WHERE request_id = 'native-bound-request'`,
        ).toEqual([{ definition_json: completed }]);
        const capacity = (yield* store.snapshot("session-a")).capacity!;
        expect(capacity.pendingRequests).toBe(0);
        expect(capacity.evidence.bytes).toBe(limit.maxBytes);
        expect(capacity.evidence.records).toBe(limit.maxRecords);
        expect(capacity.inbox.pending).toBe(1);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});

describe("shared workspace capacity configuration", () => {
  it.effect(
    "reopens above lowered limits and resumes growth after raising limits on the same workspace",
    () =>
      Effect.gen(function* () {
        const { store, actorA, actorB, activity } = yield* fixture;
        const published = yield* store.publishActivity(actorA, activity("retained-across-config"));
        const original = yield* store.snapshot("session-a");
        const reopen = (env: Record<string, string>) =>
          makeSharedWorkspaceStore.pipe(
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
          );
        const lowered = yield* reopen({
          T3CODE_SHARED_EVIDENCE_MAX_BYTES: "1",
          T3CODE_SHARED_EVIDENCE_MAX_RECORDS: "1",
          T3CODE_SHARED_INBOX_MAX_PENDING: "1",
        });
        const lowSnapshot = yield* lowered.snapshot("session-a");
        expect(lowSnapshot.capacity!.evidence.bytes).toBe(original.capacity!.evidence.bytes);
        expect(lowSnapshot.capacity!.evidence.maxBytes).toBe(1);
        expect(lowSnapshot.capacity!.evidence.maxRecords).toBe(1);
        expect(lowSnapshot.workspace).toEqual(original.workspace);
        expect(lowSnapshot.specialists).toEqual(original.specialists);
        expect(yield* lowered.publishActivity(actorA, activity("retained-across-config"))).toEqual(
          published,
        );
        const batch = yield* lowered.readInbox(actorB, {});
        expect(batch.events).toEqual([published]);
        yield* lowered.acknowledgeInbox(actorB, { batchId: batch.batchId! });
        expect(
          (yield* lowered
            .publishActivity(actorA, activity("after-limit-increase"))
            .pipe(Effect.flip)).code,
        ).toBe("limit_exceeded");
        const raised = yield* reopen({
          T3CODE_SHARED_EVIDENCE_MAX_BYTES: "1000000",
          T3CODE_SHARED_EVIDENCE_MAX_RECORDS: "100",
          T3CODE_SHARED_INBOX_MAX_PENDING: "100",
        });
        yield* raised.publishActivity(actorA, activity("after-limit-increase"));
        const increased = yield* raised.snapshot("session-a");
        expect(increased.workspace).toEqual(original.workspace);
        expect(increased.specialists).toEqual(original.specialists);
        expect(increased.capacity!.evidence.maxBytes).toBe(1000000);
        expect(increased.capacity!.evidence.maxRecords).toBe(100);
        expect(increased.capacity!.inbox.maxPending).toBe(100);
        expect(increased.capacity!.evidence.records).toBe(original.capacity!.evidence.records + 3);
        // Each service retains its startup limits, regardless of later providers.
        expect((yield* lowered.snapshot("session-a")).capacity!.evidence.maxBytes).toBe(1);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("fails startup for invalid capacity values instead of silently applying defaults", () =>
    Effect.gen(function* () {
      for (const name of [
        "T3CODE_SHARED_EVIDENCE_MAX_BYTES",
        "T3CODE_SHARED_EVIDENCE_MAX_RECORDS",
        "T3CODE_SHARED_INBOX_MAX_PENDING",
      ]) {
        for (const value of ["0", "-1", "1.5", "Infinity", "unlimited", "9007199254740992"]) {
          const result = yield* makeSharedWorkspaceStore.pipe(
            Effect.provide(
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: { [name]: value } })),
            ),
            Effect.exit,
          );
          expect(result._tag, `${name}=${value}`).toBe("Failure");
        }
      }
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "rolls back generated observation ownership rows on refusal without changing the source batch",
    () =>
      Effect.gen(function* () {
        const { store, actorA, specialist, activity } = yield* fixture;
        const sql = yield* SqlClient.SqlClient;
        const original = yield* store.publishActivity(actorA, activity("source-observation"));
        const specialistActor: SharedActor = {
          kind: "specialist",
          specialistId: specialist.specialistId,
        };
        const batch = yield* store.readInbox(specialistActor, {});
        const before = yield* sql`SELECT * FROM shared_context_versions ORDER BY context_id`;
        const limit = (yield* store.snapshot("session-a")).capacity!.evidence.maxBytes;
        yield* sql`UPDATE shared_evidence_usage SET bytes = ${limit} WHERE singleton = 1`;
        const refused = yield* store
          .putKnowledgeFromInbox(
            specialistActor,
            { environmentId: EnvironmentId.make("host"), nativeTarget: specialist.nativeTarget },
            {
              source: { batchId: batch.batchId!, eventId: original.eventId },
              evidenceId: "over-budget-observation",
              kind: "finding",
              title: "Observed interface",
              body: "Keep the exact original context.",
              state: "open",
              supersedes: [],
            },
          )
          .pipe(Effect.flip);
        expect(refused.code).toBe("limit_exceeded");
        expect(yield* sql`SELECT * FROM shared_context_versions ORDER BY context_id`).toEqual(
          before,
        );
        expect(
          yield* sql`SELECT * FROM shared_participants WHERE participant_id = ${specialist.specialistId}`,
        ).toEqual([]);
        expect(
          yield* sql`SELECT * FROM shared_checkouts WHERE participant_id = ${specialist.specialistId}`,
        ).toEqual([]);
        expect(yield* sql`SELECT * FROM shared_knowledge`).toEqual([]);
        expect(yield* store.readInbox(specialistActor, {})).toEqual(batch);
        expect((yield* store.snapshot("session-a")).capacity!.evidence.bytes).toBe(limit);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});

describe("shared workspace product custody", () => {
  it.effect("attaches two checkouts to one specialist without copying native identity", () =>
    Effect.gen(function* () {
      const { store, project, specialist, aCheckout, bCheckout, a } = yield* fixture;
      expect(aCheckout.sharedProjectId).toBe(project.sharedProjectId);
      expect(bCheckout.sharedProjectId).toBe(project.sharedProjectId);
      expect(aCheckout.checkoutId).not.toBe(bCheckout.checkoutId);
      const secondClient = yield* store.snapshot("session-b");
      expect(secondClient.specialists).toEqual([specialist]);
      expect(specialist.assignments).toHaveLength(2);
      expect(secondClient.checkouts).toEqual([bCheckout]);
      expect((yield* store.join("session-a", { displayName: "Ada's Mac" })).participantId).toBe(
        a.participantId,
      );
      expect((yield* store.join("new-session", { displayName: "Ada" })).participantId).not.toBe(
        a.participantId,
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("refuses basename and fork matching while allowing explicit aliases", () =>
    Effect.gen(function* () {
      const { store, project } = yield* fixture;
      const input = {
        localEnvironmentId: EnvironmentId.make("extra"),
        localProjectId: ProjectId.make("other"),
        repository: "https://github.com/fork-owner/api",
      };
      expect((yield* store.attachCheckout("session-a", input).pipe(Effect.flip)).code).toBe(
        "not_found",
      );
      const alias = yield* store.attachCheckout("session-a", {
        ...input,
        repository: "https://mirror.example/Example/API",
      });
      expect(alias.sharedProjectId).toBe(project.sharedProjectId);
      expect(
        (yield* store
          .attachCheckout("session-a", { ...input, repository: "/tmp/api" })
          .pipe(Effect.flip)).code,
      ).toBe("invalid_input");
      expect(
        (yield* store
          .registerProject({
            requestId: "duplicate-alias",
            name: "Different",
            repository: "https://other.example/org/repo",
            aliases: ["https://github.com/example/api"],
            hostProjectId: ProjectId.make("other"),
          })
          .pipe(Effect.flip)).code,
      ).toBe("conflict");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "seals immutable batches, retries publications and catches up after acknowledgement",
    () =>
      Effect.gen(function* () {
        const { store, actorA, actorB, activity } = yield* fixture;
        const published = yield* store.publishActivity(actorA, activity("change-1"));
        expect(yield* store.publishActivity(actorA, activity("change-1"))).toEqual(published);
        const batch = yield* store.readInbox(actorB, { limit: 1 });
        expect(batch.events.map((event) => event.eventId)).toEqual(["change-1"]);
        yield* store.publishActivity(actorA, activity("change-2"));
        // Reopening the service cannot mutate an outstanding batch or reset its acknowledgement.
        const reopened = yield* makeSharedWorkspaceStore;
        expect(yield* reopened.readInbox(actorB, { limit: 100 })).toEqual(batch);
        yield* reopened.acknowledgeInbox(actorB, { batchId: batch.batchId! });
        yield* reopened.acknowledgeInbox(actorB, { batchId: batch.batchId! });
        const next = yield* reopened.readInbox(actorB, {});
        expect(next.events.map((event) => event.eventId)).toEqual(["change-2"]);
        expect(next.batchId).not.toBe(batch.batchId);
        yield* reopened.acknowledgeInbox(actorB, { batchId: next.batchId! });
        expect((yield* store.readInbox(actorB, {})).events).toEqual([]);
        const sql = yield* SqlClient.SqlClient;
        expect(
          (yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM shared_activity`)[0]?.total,
        ).toBe(2);
        expect(
          (yield* store
            .publishActivity(actorA, { ...activity("change-1"), summary: "Changed retry" })
            .pipe(Effect.flip)).code,
        ).toBe("conflict");
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "retains exact submitted revisions and rejects forged author, context and inbox access",
    () =>
      Effect.gen(function* () {
        const { store, actorA, actorB, activity, aContext, specialist } = yield* fixture;
        expect(
          (yield* store.publishActivity(actorB, activity("forged")).pipe(Effect.flip)).code,
        ).toBe("forbidden");
        yield* store.putContext(actorA, {
          ...aContext,
          revision: revisionB,
          objective: "Later objective",
        });
        const event = yield* store.publishActivity(actorA, activity("delayed-observation"));
        expect(event.revision).toEqual(revisionA);
        expect(event.context.revision).toEqual(revisionA);
        expect(event.context.objective).toBe(aContext.objective);
        expect(event.context.contextVersion).toBe(aContext.contextVersion);
        expect(event.author.displayName).toBe("Ada");
        expect(
          (yield* store
            .readInbox(actorA, { recipientId: specialist.specialistId })
            .pipe(Effect.flip)).code,
        ).toBe("forbidden");
        const batch = yield* store.readInbox(actorB, {});
        expect(
          (yield* store.acknowledgeInbox(actorA, { batchId: batch.batchId! }).pipe(Effect.flip))
            .code,
        ).toBe("not_found");
        expect((yield* store.readInbox(actorB, {})).batchId).toBe(batch.batchId);
        expect(
          (yield* store
            .putContext(actorB, { ...aContext, objective: "Take ownership" })
            .pipe(Effect.flip)).code,
        ).toBe("forbidden");
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("retains snapshots with their exact checkout and base revision", () =>
    Effect.gen(function* () {
      const { store, actorA, actorB, aCheckout, aContext, activity } = yield* fixture;
      const input = {
        checkoutId: aCheckout.checkoutId,
        revision: revisionA,
        patch: "diff --git a/src/api/types.ts b/src/api/types.ts\n+tenant: string\n",
      };
      const snapshot = yield* store.putSnapshot(actorA, input);
      expect(yield* store.putSnapshot(actorA, input)).toEqual(snapshot);
      expect((yield* store.getSnapshot(snapshot.snapshotId)).patch).toBe(input.patch);
      expect((yield* store.putSnapshot(actorB, input).pipe(Effect.flip)).code).toBe("forbidden");
      expect(
        (yield* store
          .publishActivity(actorA, {
            ...activity("wrong-revision"),
            revision: { ...revisionB, snapshotId: snapshot.snapshotId },
          })
          .pipe(Effect.flip)).code,
      ).toBe("conflict");
      const snapshotContext = yield* store.putContext(actorA, {
        ...aContext,
        revision: { ...revisionA, snapshotId: snapshot.snapshotId },
      });
      const observed = yield* store.publishActivity(actorA, {
        ...activity("snapshot-event"),
        contextVersion: snapshotContext.contextVersion,
        revision: snapshotContext.revision,
      });
      expect(observed.context.revision.snapshotId).toBe(snapshot.snapshotId);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("searches revision-qualified evidence and keeps corrections as retained lineage", () =>
    Effect.gen(function* () {
      const { store, actorA, actorB, aContext, bContext, project } = yield* fixture;
      const original = {
        evidenceId: "finding-a",
        contextId: aContext.contextId,
        contextVersion: aContext.contextVersion,
        revision: revisionA,
        kind: "finding" as const,
        title: "Tenant field",
        body: "The tenant field is required by this branch.",
        sources: [],
        supersedes: [],
        state: "open" as const,
      };
      yield* store.putKnowledge(actorA, original);
      yield* store.putKnowledge(actorB, {
        ...original,
        evidenceId: "finding-b",
        contextId: bContext.contextId,
        contextVersion: bContext.contextVersion,
        revision: revisionB,
        body: "This branch has an optional tenant field.",
      });
      const search = yield* store.searchKnowledge({
        sharedProjectId: project.sharedProjectId,
        query: "tenant field",
        branch: revisionA.branch,
      });
      expect(search.records.map((row) => row.evidenceId)).toEqual(["finding-a"]);
      expect(search.records[0]?.revision.commit).toBe(revisionA.commit);
      expect(search.hasMore).toBe(false);
      expect(search.nextCursor).toBeNull();
      const correction = yield* store.putKnowledge(actorB, {
        ...original,
        evidenceId: "finding-correction",
        contextId: bContext.contextId,
        contextVersion: bContext.contextVersion,
        revision: revisionB,
        title: "Signed-in callers",
        body: "The field is required only for signed-in callers.",
        supersedes: ["finding-a"],
      });
      const retained = yield* store.searchKnowledge({
        query: "tenant field",
        branch: revisionA.branch,
        commit: revisionA.commit,
      });
      expect(retained.records).toHaveLength(1);
      expect(retained.records[0]).toMatchObject({
        ...original,
        corrections: [
          {
            evidenceId: correction.evidenceId,
            revision: revisionB,
            author: correction.author,
            contextVersion: bContext.contextVersion,
          },
        ],
        hasMoreCorrections: false,
      });
      expect(
        (yield* store.searchKnowledge({ evidenceId: correction.evidenceId })).records[0],
      ).toMatchObject({ ...correction, corrections: [], hasMoreCorrections: false });
      expect(
        (yield* store.searchKnowledge({ sharedProjectId: project.sharedProjectId })).records,
      ).toHaveLength(3);
      expect(
        (yield* store
          .putKnowledge(actorA, { ...original, body: "Rewrite history" })
          .pipe(Effect.flip)).code,
      ).toBe("conflict");
      expect(
        (yield* store
          .putKnowledge(actorA, {
            ...original,
            evidenceId: "missing-correction",
            supersedes: ["missing"],
          })
          .pipe(Effect.flip)).code,
      ).toBe("invalid_input");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("publishes a correction once and preserves an already sealed inbox", () =>
    Effect.gen(function* () {
      const { store, actorA, actorB, aContext, activity } = yield* fixture;
      yield* store.publishActivity(actorA, activity("before-correction"));
      const sealed = yield* store.readInbox(actorB, {});
      const original = {
        evidenceId: "original",
        contextId: aContext.contextId,
        contextVersion: aContext.contextVersion,
        revision: revisionA,
        kind: "finding" as const,
        title: "Legacy tenant header",
        body: "Required for all callers.",
        sources: [],
        supersedes: [],
        state: "open" as const,
      };
      const retained = yield* store.putKnowledge(actorA, original);
      const correction = {
        ...original,
        evidenceId: "correction",
        title: "Signed-in callers",
        body: "Anonymous requests are exempt.",
        supersedes: [original.evidenceId],
      };
      const saved = yield* store.putKnowledge(actorA, correction);
      expect(yield* store.putKnowledge(actorA, correction)).toEqual(saved);
      const reopened = yield* makeSharedWorkspaceStore;
      expect(yield* reopened.readInbox(actorB, {})).toEqual(sealed);
      yield* reopened.acknowledgeInbox(actorB, { batchId: sealed.batchId! });
      const catchup = yield* reopened.readInbox(actorB, {});
      expect(catchup.events).toHaveLength(1);
      expect(catchup.events[0]).toMatchObject({
        kind: "correction",
        context: aContext,
        revision: revisionA,
        knowledge: { evidenceId: correction.evidenceId, supersedes: [original.evidenceId] },
      });
      expect(catchup.events[0]?.recipientIds).toBeUndefined();
      const sql = yield* SqlClient.SqlClient;
      const raw = yield* sql<{
        definition_json: string;
      }>`SELECT definition_json FROM shared_knowledge WHERE evidence_id = 'original'`;
      expect(yield* decodeJson(raw[0]!.definition_json)).toEqual(retained);
      expect(
        (yield* store.putKnowledge(actorA, { ...correction, body: "Rewritten" }).pipe(Effect.flip))
          .code,
      ).toBe("conflict");
      expect(
        (yield* store
          .publishActivity(actorA, {
            ...activity(catchup.events[0]!.eventId),
            summary: "Spoof correction",
          })
          .pipe(Effect.flip)).code,
      ).toBe("invalid_input");
      yield* reopened.acknowledgeInbox(actorB, { batchId: catchup.batchId! });
      expect((yield* reopened.readInbox(actorB, {})).events).toEqual([]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "bounds correction references and pages all lineage without mutating older evidence",
    () =>
      Effect.gen(function* () {
        const { store, actorA, aContext } = yield* fixture;
        const original = {
          evidenceId: "lineage-root",
          contextId: aContext.contextId,
          contextVersion: aContext.contextVersion,
          revision: revisionA,
          kind: "finding" as const,
          title: "Root observation",
          body: "Old applicability.",
          sources: [],
          supersedes: [],
          state: "open" as const,
        };
        yield* store.putKnowledge(actorA, original);
        for (let index = 0; index < 10; index++)
          yield* store.putKnowledge(actorA, {
            ...original,
            evidenceId: `lineage-${index}`,
            title: `Correction ${index}`,
            supersedes: [original.evidenceId],
          });
        const old = (yield* store.searchKnowledge({ evidenceId: original.evidenceId })).records[0]!;
        expect(old.corrections).toHaveLength(8);
        expect(old.hasMoreCorrections).toBe(true);
        expect(old.state).toBe("open");
        const all: string[] = [];
        let cursor: string | undefined;
        do {
          const page = yield* store.searchKnowledge({
            supersedes: original.evidenceId,
            limit: 3,
            ...(cursor ? { cursor } : {}),
          });
          all.push(...page.records.map((record) => record.evidenceId));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        expect(all).toEqual(Array.from({ length: 10 }, (_, index) => `lineage-${9 - index}`));
        expect((yield* store.searchKnowledge({ supersedes: "missing" })).records).toEqual([]);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "rolls back evidence and correction routing when the captured activity is too large",
    () =>
      Effect.gen(function* () {
        const { store, actorA, aContext, aCheckout } = yield* fixture;
        const original = {
          evidenceId: "atomic-original",
          contextId: aContext.contextId,
          contextVersion: aContext.contextVersion,
          revision: revisionA,
          kind: "finding" as const,
          title: "Earlier finding",
          body: "Retained.",
          sources: [],
          supersedes: [],
          state: "open" as const,
        };
        yield* store.putKnowledge(actorA, original);
        // Input and evidence fit independently, but the captured context is also
        // included in an activity. Force that last step to reject the entire write.
        const wide = yield* store.putContext(actorA, {
          contextId: "wide-context",
          checkoutId: aCheckout.checkoutId,
          source: { kind: "project_conversation" },
          objective: "x".repeat(8000),
          revision: revisionA,
          paths: Array.from({ length: 64 }, (_, i) => `${i}/${"x".repeat(950)}`),
          tags: [],
        });
        const result = yield* store
          .putKnowledge(actorA, {
            ...original,
            evidenceId: "atomic-correction",
            contextId: wide.contextId,
            contextVersion: wide.contextVersion,
            supersedes: [original.evidenceId],
          })
          .pipe(Effect.flip);
        expect(result.code).toBe("limit_exceeded");
        const sql = yield* SqlClient.SqlClient;
        expect(
          (yield* sql<{ total: number }>`SELECT count(*) total FROM shared_knowledge`)[0]?.total,
        ).toBe(1);
        expect(
          (yield* sql<{ total: number }>`SELECT count(*) total FROM shared_knowledge_search`)[0]
            ?.total,
        ).toBe(1);
        expect(
          (yield* sql<{
            total: number;
          }>`SELECT count(*) total FROM shared_knowledge_corrections`)[0]?.total,
        ).toBe(0);
        expect(
          (yield* sql<{ total: number }>`SELECT count(*) total FROM shared_activity`)[0]?.total,
        ).toBe(0);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("notifies original-area readers when a correction concerns a different area", () =>
    Effect.gen(function* () {
      const { store, actorA, actorB, aContext, bCheckout } = yield* fixture;
      const original = {
        evidenceId: "api-evidence",
        contextId: aContext.contextId,
        contextVersion: aContext.contextVersion,
        revision: revisionA,
        kind: "finding" as const,
        title: "API contract",
        body: "An earlier API finding.",
        sources: [],
        supersedes: [],
        state: "open" as const,
      };
      yield* store.putKnowledge(actorA, original);
      const docs = yield* store.putContext(actorB, {
        contextId: "docs-correction",
        checkoutId: bCheckout.checkoutId,
        source: { kind: "project_conversation" },
        objective: "Document applicability",
        revision: revisionB,
        paths: ["docs"],
        tags: ["documentation"],
      });
      yield* store.putKnowledge(actorB, {
        ...original,
        evidenceId: "docs-evidence",
        contextId: docs.contextId,
        contextVersion: docs.contextVersion,
        revision: revisionB,
        title: "Documentation correction",
        supersedes: [original.evidenceId],
      });
      const inbox = yield* store.readInbox(actorA, {});
      expect(inbox.events).toHaveLength(1);
      expect(inbox.events[0]).toMatchObject({
        paths: ["docs"],
        tags: ["documentation"],
        revision: revisionB,
        context: docs,
        knowledge: { evidenceId: "docs-evidence", supersedes: [original.evidenceId] },
      });
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("keeps exact evidence fetch readable when correction attribution is large", () =>
    Effect.gen(function* () {
      const { store, actorA, aContext } = yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      const original = {
        evidenceId: "large-root",
        contextId: aContext.contextId,
        contextVersion: aContext.contextVersion,
        revision: revisionA,
        kind: "finding" as const,
        title: "Earlier observation",
        body: "Retained.",
        sources: [],
        supersedes: [],
        state: "open" as const,
      };
      yield* store.putKnowledge(actorA, original);
      for (let index = 0; index < 8; index++) {
        const correction = yield* store.putKnowledge(actorA, {
          ...original,
          evidenceId: `large-correction-${index}`,
          supersedes: [original.evidenceId],
        });
        // Branded IDs have no length bound. Reproduce valid retained broker
        // attribution; every whole record remains below the 128 KiB write limit.
        const large = {
          ...correction,
          author: {
            ...correction.author,
            kind: "local_agent" as const,
            provenance: {
              kind: "participant_broker_assertion" as const,
              delegationId: "local-grant",
              ownerParticipantId: correction.author.participantId,
              localEnvironmentId: EnvironmentId.make("e".repeat(30000)),
              localProjectId: ProjectId.make("p".repeat(30000)),
              localThreadId: ThreadId.make("t".repeat(30000)),
            },
          },
        };
        expect(isKnowledge(large)).toBe(true);
        expect(Buffer.byteLength(encodeJson(large))).toBeLessThan(128 * 1024);
        yield* sql`UPDATE shared_knowledge SET definition_json = ${encodeJson(large)} WHERE evidence_id = ${correction.evidenceId}`;
      }
      const fetched = yield* store.searchKnowledge({ evidenceId: original.evidenceId });
      expect(fetched.records).toHaveLength(1);
      expect(fetched.records[0]?.hasMoreCorrections).toBe(true);
      expect(fetched.records[0]!.corrections.length).toBeLessThan(8);
      expect(fetched.records[0]!.corrections.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(encodeJson(fetched))).toBeLessThanOrEqual(192 * 1024);
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = yield* store.searchKnowledge({
          supersedes: original.evidenceId,
          ...(cursor ? { cursor } : {}),
        });
        ids.push(...page.records.map((record) => record.evidenceId));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(ids).toHaveLength(8);
      expect(new Set(ids).size).toBe(8);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("bounds workspace capacity and atomically rejects invalid recipients", () =>
    Effect.gen(function* () {
      const { store, actorA, actorB, specialist, activity } = yield* fixture;
      yield* store.configure({
        name: "Shared development",
        limits: { maxSpecialists: 1, maxSnapshotBytes: 1024 },
      });
      expect(
        (yield* store
          .registerSpecialist({
            requestId: "extra",
            label: "Extra",
            nativeTarget: { ...specialist.nativeTarget, agentId: "new" },
            assignments: specialist.assignments,
          })
          .pipe(Effect.flip)).code,
      ).toBe("limit_exceeded");
      expect(
        (yield* store
          .publishActivity(actorA, {
            ...activity("invalid-recipient"),
            recipientIds: ["not-a-participant"],
          })
          .pipe(Effect.flip)).code,
      ).toBe("invalid_input");
      expect((yield* store.readInbox(actorB, {})).events).toEqual([]);
      yield* store.publishActivity(actorA, activity("invalid-recipient"));
      expect((yield* store.readInbox(actorB, {})).events).toHaveLength(1);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "matches literal path segments in both directions and replaces current task interests",
    () =>
      Effect.gen(function* () {
        const { store, actorA, actorB, activity, bContext } = yield* fixture;
        yield* store.putContext(actorB, { ...bContext, paths: ["src/api_v2/%contract"], tags: [] });
        for (const path of ["src/api_v2/%contract/types.ts", "src/api_v2", "src/"]) {
          const event = yield* store.publishActivity(actorA, {
            ...activity(path),
            paths: [path],
            tags: [],
          });
          const batch = yield* store.readInbox(actorB, {});
          expect(batch.events.map((item) => item.eventId)).toEqual([event.eventId]);
          yield* store.acknowledgeInbox(actorB, { batchId: batch.batchId! });
        }
        for (const path of [
          "src/apiXv2/a-contract/types.ts",
          "src/api_v2/%contracts/types.ts",
          "src/api",
        ]) {
          yield* store.publishActivity(actorA, { ...activity(path), paths: [path], tags: [] });
          expect((yield* store.readInbox(actorB, {})).events).toEqual([]);
        }
        yield* store.putContext(actorB, { ...bContext, paths: ["docs"], tags: ["deployment"] });
        yield* store.publishActivity(actorA, {
          ...activity("previous-interest"),
          paths: ["src/api_v2/%contract/types.ts"],
          tags: [],
        });
        expect((yield* store.readInbox(actorB, {})).events).toEqual([]);
        yield* store.publishActivity(actorA, {
          ...activity("new-tag"),
          paths: [],
          tags: ["deployment"],
        });
        expect((yield* store.readInbox(actorB, {})).events.map((item) => item.eventId)).toEqual([
          "new-tag",
        ]);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("keeps task interest IDs separate from specialist IDs", () =>
    Effect.gen(function* () {
      const { store, actorA, actorB, activity, bContext, specialist } = yield* fixture;
      yield* store.putContext(actorB, {
        ...bContext,
        contextId: specialist.specialistId,
        paths: ["docs"],
        tags: [],
      });
      yield* store.publishActivity(actorA, activity("namespace-check"));
      const batch = yield* store.readInbox(
        { kind: "specialist", specialistId: specialist.specialistId },
        {},
      );
      expect(batch.events.map((item) => item.eventId)).toEqual(["namespace-check"]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "rejects oversized encoded activity before persisting its captured Unicode context",
    () =>
      Effect.gen(function* () {
        const { store, actorA, actorB, aContext, activity } = yield* fixture;
        const work = yield* store.putContext(actorA, {
          ...aContext,
          objective: "界".repeat(30_000),
        });
        const input = {
          ...activity("oversized-context"),
          contextVersion: work.contextVersion,
          summary: "界".repeat(20_000),
        };
        expect((yield* store.publishActivity(actorA, input).pipe(Effect.flip)).code).toBe(
          "limit_exceeded",
        );
        const sql = yield* SqlClient.SqlClient;
        expect(
          (yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM shared_activity`)[0]?.total,
        ).toBe(0);
        expect((yield* store.readInbox(actorB, {})).events).toEqual([]);
        const admitted = yield* store.publishActivity(actorA, {
          ...input,
          summary: "A smaller observation retains the entire objective.",
        });
        expect(admitted.context.objective).toBe(work.objective);
        expect(Buffer.byteLength(encodeJson(admitted), "utf8")).toBeLessThanOrEqual(128 * 1024);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "seals complete byte-bounded inbox pages, preserves retries, and drains every admitted event",
    () =>
      Effect.gen(function* () {
        const { store, actorA, actorB, aContext, activity } = yield* fixture;
        const work = yield* store.putContext(actorA, {
          ...aContext,
          objective: "界".repeat(20_000),
        });
        const input = (eventId: string) => ({
          ...activity(eventId),
          contextVersion: work.contextVersion,
          summary: "界".repeat(20_000),
        });
        const ids = ["large-1", "large-2", "large-3", "large-4"];
        for (const eventId of ids) {
          const value = yield* store.publishActivity(actorA, input(eventId));
          expect(Buffer.byteLength(encodeJson(value), "utf8")).toBeLessThanOrEqual(128 * 1024);
        }
        const first = yield* store.readInbox(actorB, { limit: 100 });
        expect(first.events).toHaveLength(1);
        expect(first.hasMore).toBe(true);
        yield* store.publishActivity(actorA, input("large-after-seal"));
        const reopened = yield* makeSharedWorkspaceStore;
        expect(yield* reopened.readInbox(actorB, { limit: 1 })).toEqual(first);
        const observed: string[] = [];
        for (;;) {
          const page = yield* reopened.readInbox(actorB, { limit: 100 });
          expect(page.events.length).toBeGreaterThan(0);
          expect(Buffer.byteLength(encodeJson(page), "utf8")).toBeLessThanOrEqual(192 * 1024);
          for (const event of page.events) {
            expect(event.summary).toBe(input(event.eventId).summary);
            expect(event.context.objective).toBe(work.objective);
            observed.push(event.eventId);
          }
          yield* reopened.acknowledgeInbox(actorB, { batchId: page.batchId! });
          if (!page.hasMore) break;
        }
        expect(observed).toEqual([...ids, "large-after-seal"]);
        expect((yield* reopened.readInbox(actorB, {})).events).toEqual([]);
        expect((yield* reopened.readInbox(actorB, {})).hasMore).toBe(false);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("rejects oversized evidence without persisting it or its search index", () =>
    Effect.gen(function* () {
      const { store, actorA, aContext } = yield* fixture;
      const input = {
        evidenceId: "oversized-evidence",
        contextId: aContext.contextId,
        contextVersion: aContext.contextVersion,
        revision: revisionA,
        kind: "finding" as const,
        title: "Encoded limit",
        body: "界".repeat(32_768),
        sources: Array.from({ length: 40 }, (_, index) => ({
          title: `Source ${index}`,
          uri: `https://example.invalid/${"x".repeat(1000)}`,
        })),
        supersedes: [],
        state: "open" as const,
      };
      expect((yield* store.putKnowledge(actorA, input).pipe(Effect.flip)).code).toBe(
        "limit_exceeded",
      );
      const sql = yield* SqlClient.SqlClient;
      expect(
        (yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM shared_knowledge`)[0]?.total,
      ).toBe(0);
      expect(
        (yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM shared_knowledge_search`)[0]
          ?.total,
      ).toBe(0);
      const admitted = yield* store.putKnowledge(actorA, { ...input, sources: [] });
      expect(admitted.body).toBe(input.body);
      expect(Buffer.byteLength(encodeJson(admitted), "utf8")).toBeLessThanOrEqual(128 * 1024);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "paginates complete large knowledge records with stable exclusive cursors and no loss",
    () =>
      Effect.gen(function* () {
        const { store, actorA, aContext, project } = yield* fixture;
        const input = (evidenceId: string) => ({
          evidenceId,
          contextId: aContext.contextId,
          contextVersion: aContext.contextVersion,
          revision: revisionA,
          kind: "finding" as const,
          title: "Large retained finding",
          body: "界".repeat(32_768),
          sources: [],
          supersedes: [],
          state: "open" as const,
        });
        const ids = ["knowledge-1", "knowledge-2", "knowledge-3", "knowledge-4"];
        for (const evidenceId of ids) yield* store.putKnowledge(actorA, input(evidenceId));
        const query = { sharedProjectId: project.sharedProjectId, limit: 100 };
        const first = yield* store.searchKnowledge(query);
        expect(first.records).toHaveLength(1);
        expect(first.hasMore).toBe(true);
        expect(first.nextCursor).toBeTruthy();
        yield* store.putKnowledge(actorA, input("knowledge-newest"));
        const seen = first.records.map((record) => record.evidenceId);
        let cursor = first.nextCursor;
        while (cursor) {
          const page = yield* store.searchKnowledge({ ...query, cursor });
          expect(page.records.length).toBeGreaterThan(0);
          expect(Buffer.byteLength(encodeJson(page), "utf8")).toBeLessThanOrEqual(192 * 1024);
          expect(yield* store.searchKnowledge({ ...query, cursor })).toEqual(page);
          for (const record of page.records) {
            expect(record.body).toBe(input(record.evidenceId).body);
            seen.push(record.evidenceId);
          }
          expect(page.hasMore).toBe(page.nextCursor !== null);
          cursor = page.nextCursor;
        }
        expect(seen).toEqual(ids.toReversed());
        expect((yield* store.searchKnowledge(query)).records[0]?.evidenceId).toBe(
          "knowledge-newest",
        );
        for (const cursor of [
          "knowledge:0",
          "knowledge:-1",
          "knowledge:9223372036854775808",
          "knowledge:1 OR 1=1",
        ])
          expect((yield* store.searchKnowledge({ ...query, cursor }).pipe(Effect.flip)).code).toBe(
            "invalid_input",
          );
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});

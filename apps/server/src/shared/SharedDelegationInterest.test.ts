import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type SharedDelegation,
  type SharedDelegationRegisterInput,
  type SharedWorkContext,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeSharedDelegationService } from "./SharedDelegationService.ts";
import { makeSharedWorkspaceStore, type SharedActor } from "./SharedWorkspaceStore.ts";

const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const observed = yield* DateTime.now;
  const timestamp = DateTime.formatIso(observed);
  const expiry = DateTime.formatIso(DateTime.add(observed, { hours: 1 }));
  for (const session of ["owner-session", "publisher-session"])
    yield* sql`INSERT INTO auth_sessions(session_id,subject,scopes,method,issued_at,expires_at)
      VALUES (${session},${session},'["shared:read","shared:contribute"]','pairing',${timestamp},${expiry})`;
  const store = yield* makeSharedWorkspaceStore;
  yield* store.configure({ name: "Interest routing" });
  const owner = yield* store.join("owner-session", { displayName: "Owner" });
  const publisher = yield* store.join("publisher-session", { displayName: "Publisher" });
  const ownerActor: SharedActor = { kind: "participant", participantId: owner.participantId };
  const publisherActor: SharedActor = {
    kind: "participant",
    participantId: publisher.participantId,
  };
  const projects = [];
  for (const name of ["api", "storefront"])
    projects.push(
      yield* store.registerProject({
        requestId: name,
        name,
        repository: `https://github.com/example/${name}`,
        hostProjectId: ProjectId.make(`host-${name}`),
      }),
    );
  const checkout = yield* store.attachCheckout("owner-session", {
    localEnvironmentId: EnvironmentId.make("personal"),
    localProjectId: ProjectId.make("personal-api"),
    repository: projects[0]!.repository,
  });
  const context = yield* store.putContext(ownerActor, {
    contextId: "task",
    checkoutId: checkout.checkoutId,
    source: { kind: "thread", threadId: ThreadId.make("thread") },
    objective: "Check API contracts",
    revision: { branch: "feature", commit: "a".repeat(40), applicability: "branch" },
    paths: ["src/api_v2/%contract/"],
    tags: ["contract"],
  });
  const publicationContexts: SharedWorkContext[] = [];
  for (const project of projects) {
    const attached = yield* store.attachCheckout("publisher-session", {
      localEnvironmentId: EnvironmentId.make("publisher"),
      localProjectId: ProjectId.make(`publisher-${project.name}`),
      repository: project.repository,
    });
    publicationContexts.push(
      yield* store.putContext(publisherActor, {
        contextId: `publisher-${project.name}`,
        checkoutId: attached.checkoutId,
        source: { kind: "project_conversation" },
        objective: "Publish repository findings",
        revision: { branch: "main", commit: "b".repeat(40), applicability: "branch" },
        paths: [],
        tags: [],
      }),
    );
  }
  const input: SharedDelegationRegisterInput = {
    requestId: "grant",
    label: "API task",
    contextId: context.contextId,
    contextVersion: context.contextVersion,
    binding: {
      environmentId: checkout.localEnvironmentId,
      projectId: checkout.localProjectId,
      threadId: ThreadId.make("thread"),
      instanceId: ProviderInstanceId.make("meerkat"),
      mobId: "local-mob",
      sessionId: "native-session",
    },
    actions: ["inbox.list", "inbox.ack"],
    expiresAt: DateTime.formatIso(DateTime.add(observed, { minutes: 10 })),
  };
  const grants = yield* makeSharedDelegationService(store);
  const taskActor = (grant: SharedDelegation): SharedActor => ({
    kind: "local_agent",
    delegationId: grant.delegationId,
    sessionId: "owner-session",
    action: "inbox.list",
  });
  const publish = (
    eventId: string,
    paths: ReadonlyArray<string>,
    tags: ReadonlyArray<string> = [],
    options: {
      readonly context?: SharedWorkContext;
      readonly actor?: SharedActor;
      readonly recipientIds?: ReadonlyArray<string>;
    } = {},
  ) => {
    const current = options.context ?? publicationContexts[0]!;
    return store.publishActivity(options.actor ?? publisherActor, {
      eventId,
      contextId: current.contextId,
      contextVersion: current.contextVersion,
      revision: current.revision,
      kind: "finding",
      summary: eventId,
      paths,
      tags,
      sources: [],
      ...(options.recipientIds ? { recipientIds: options.recipientIds } : {}),
    });
  };
  const queued = (recipientId: string) => sql<{ event_id: string }>`SELECT a.event_id
    FROM shared_inbox i JOIN shared_activity a ON a.sequence=i.sequence
    WHERE i.recipient_id=${recipientId} ORDER BY i.sequence`;
  return {
    sql,
    store,
    ownerActor,
    grants,
    context,
    input,
    taskActor,
    publish,
    queued,
    publicationContexts,
    timestamp,
  };
});

describe("local task interest delivery", () => {
  it.effect(
    "routes normal path and tag observations to the task with literal segment and project boundaries",
    () =>
      Effect.gen(function* () {
        const { grants, input, store, taskActor, publish, publicationContexts, sql } =
          yield* fixture;
        const grant = yield* grants.register("owner-session", input);
        expect(yield* grants.register("owner-session", input)).toEqual(grant);
        expect(
          (yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM shared_interests
        WHERE owner_id=${`delegation:${grant.delegationId}`}`)[0]?.total,
        ).toBe(2);
        yield* publish("descendant", ["src/api_v2/%contract/types.ts"]);
        yield* publish("ancestor", ["src/api_v2"]);
        yield* publish("tag", [], ["contract"]);
        yield* publish("literal-prefix-miss", ["src/api_v2/%contracts/types.ts"]);
        yield* publish("wildcard-miss", ["src/apiXv2/contract/types.ts"]);
        yield* publish("other-project", ["src/api_v2/%contract/types.ts"], ["contract"], {
          context: publicationContexts[1]!,
        });
        const batch = yield* store.readInbox(taskActor(grant), {});
        expect(batch.recipientId).toBe(grant.delegationId);
        expect(batch.events.map((event) => event.eventId)).toEqual([
          "descendant",
          "ancestor",
          "tag",
        ]);
        expect(batch.events.every((event) => event.recipientIds === undefined)).toBe(true);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "keeps the captured grant interests when its human publishes a later context version",
    () =>
      Effect.gen(function* () {
        const { grants, input, store, ownerActor, context, taskActor, publish } = yield* fixture;
        const original = yield* grants.register("owner-session", input);
        const updated = yield* store.putContext(ownerActor, {
          ...context,
          objective: "Now inspect deployment",
          paths: ["docs"],
          tags: ["deployment"],
          revision: { ...context.revision, commit: "c".repeat(40) },
        });
        const newer = yield* grants.register("owner-session", {
          ...input,
          requestId: "later-grant",
          contextVersion: updated.contextVersion,
        });
        yield* publish("old-interest", ["src/api_v2/%contract/types.ts"]);
        yield* publish("new-interest", ["docs/deploy.md"]);
        expect(
          (yield* store.readInbox(taskActor(original), {})).events.map((event) => event.eventId),
        ).toEqual(["old-interest"]);
        expect(
          (yield* store.readInbox(taskActor(newer), {})).events.map((event) => event.eventId),
        ).toEqual(["new-interest"]);
        expect(
          (yield* store.readInbox(ownerActor, {})).events.map((event) => event.eventId),
        ).toEqual(["new-interest"]);
        expect((yield* grants.register("owner-session", input)).context).toEqual(context);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "routes a human's own briefing to its task and supports whole-project task interests",
    () =>
      Effect.gen(function* () {
        const {
          grants,
          input,
          store,
          ownerActor,
          context,
          taskActor,
          publish,
          publicationContexts,
        } = yield* fixture;
        const broad = yield* store.putContext(ownerActor, { ...context, paths: [], tags: [] });
        const grant = yield* grants.register("owner-session", {
          ...input,
          contextVersion: broad.contextVersion,
        });
        yield* publish("owner-briefing", ["unrelated/file.ts"], [], {
          actor: ownerActor,
          context: broad,
        });
        yield* publish("other-repo", [], [], { context: publicationContexts[1]! });
        expect(
          (yield* store.readInbox(taskActor(grant), {})).events.map((event) => event.eventId),
        ).toEqual(["owner-briefing"]);
        expect((yield* store.readInbox(ownerActor, {})).events).toEqual([]);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  for (const invalidation of [
    "grant-revoked",
    "grant-expired",
    "parent-revoked",
    "parent-expired",
    "parent-scope-removed",
    "parent-owner-removed",
  ] as const)
    it.effect(
      `excludes ${invalidation} tasks from new matched and explicit delivery without rewriting sealed batches`,
      () =>
        Effect.gen(function* () {
          const { sql, grants, input, store, taskActor, publish, queued, timestamp } =
            yield* fixture;
          const grant = yield* grants.register("owner-session", input);
          yield* publish("before-invalidation", [], ["contract"]);
          const sealed = yield* store.readInbox(taskActor(grant), {});
          const original = yield* sql<{
            definition_json: string;
          }>`SELECT definition_json FROM shared_inbox_batches WHERE batch_id=${sealed.batchId}`;
          switch (invalidation) {
            case "grant-revoked":
              yield* grants.revoke("owner-session", { delegationId: grant.delegationId });
              break;
            case "grant-expired":
              yield* TestClock.adjust("11 minutes");
              break;
            case "parent-revoked":
              yield* sql`UPDATE auth_sessions SET revoked_at=${timestamp} WHERE session_id='owner-session'`;
              break;
            case "parent-expired":
              yield* sql`UPDATE auth_sessions SET expires_at=${timestamp} WHERE session_id='owner-session'`;
              break;
            case "parent-scope-removed":
              yield* sql`UPDATE auth_sessions SET scopes='["shared:read"]' WHERE session_id='owner-session'`;
              break;
            case "parent-owner-removed":
              yield* sql`DELETE FROM shared_participant_sessions WHERE session_id='owner-session'`;
              break;
          }
          yield* publish("matched-after", [], ["contract"]);
          yield* publish("explicit-after", ["elsewhere"], [], {
            recipientIds: [grant.delegationId],
          });
          expect((yield* queued(grant.delegationId)).map((row) => row.event_id)).toEqual([
            "before-invalidation",
          ]);
          expect(
            yield* sql<{
              definition_json: string;
            }>`SELECT definition_json FROM shared_inbox_batches WHERE batch_id=${sealed.batchId}`,
          ).toEqual(original);
          expect((yield* store.readInbox(taskActor(grant), {}).pipe(Effect.flip)).code).toBe(
            "forbidden",
          );
        }).pipe(Effect.provide(SqlitePersistenceMemory)),
    );

  it.effect("does not accumulate task deliveries when inbox access was not delegated", () =>
    Effect.gen(function* () {
      const { grants, input, publish, queued } = yield* fixture;
      const grant = yield* grants.register("owner-session", {
        ...input,
        actions: ["projects.list"],
      });
      yield* publish("matched-no-inbox", [], ["contract"]);
      yield* publish("explicit-no-inbox", [], [], { recipientIds: [grant.delegationId] });
      expect(yield* queued(grant.delegationId)).toEqual([]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "repairs pre-index grants across bounded restart pages without rewriting their identity or context",
    () =>
      Effect.gen(function* () {
        const { sql, grants, input, store, ownerActor, context, publish } = yield* fixture;
        const retained: SharedDelegation[] = [];
        for (let index = 0; index < 65; index++)
          retained.push(
            yield* grants.register("owner-session", { ...input, requestId: `legacy-${index}` }),
          );
        yield* sql`DELETE FROM shared_interests WHERE owner_id LIKE 'delegation:%'`;
        yield* store.putContext(ownerActor, { ...context, paths: ["docs"], tags: [] });
        const reopened = yield* makeSharedDelegationService(store);
        expect(
          yield* reopened.register("owner-session", { ...input, requestId: "legacy-0" }),
        ).toEqual(retained[0]);
        yield* publish("recovered-interest", [], ["contract"]);
        expect(
          (yield* sql<{ recipient_id: string }>`SELECT recipient_id FROM shared_inbox
        WHERE sequence=(SELECT sequence FROM shared_activity WHERE event_id='recovered-interest')
        ORDER BY recipient_id`).map((row) => row.recipient_id),
        ).toEqual(retained.map((grant) => grant.delegationId).sort());
        expect(
          (yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM shared_delegations`)[0]
            ?.total,
        ).toBe(65);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});

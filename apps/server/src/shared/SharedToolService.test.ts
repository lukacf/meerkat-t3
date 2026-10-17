import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  SharedWorkspaceError,
  SharedActivity,
  SharedKnowledge,
  type MeerkatProjectTeam,
  type SharedCompositionInput,
  type SharedCompositionOperation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeMeerkatProjectAgentStore } from "../provider/meerkat/MeerkatProjectAgentStore.ts";
import { makeSharedWorkspaceStore, type SharedActor } from "./SharedWorkspaceStore.ts";
import { makeSharedToolService } from "./SharedToolService.ts";
import { makeSharedNativeToolRouter } from "./SharedNativeToolRouter.ts";
import type { SharedToolInvocation } from "./SharedToolHost.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const fixture = Effect.gen(function* () {
  const workspace = yield* makeSharedWorkspaceStore;
  yield* workspace.configure({ name: "Shared tools" });
  const participant = yield* workspace.join("session", { displayName: "Ada" });
  const projectId = ProjectId.make("host-project");
  const instanceId = ProviderInstanceId.make("meerkat");
  const project = yield* workspace.registerProject({
    requestId: "project",
    name: "API",
    repository: "https://github.com/example/api",
    hostProjectId: projectId,
  });
  const nativeStore = yield* makeMeerkatProjectAgentStore;
  const { row } = yield* nativeStore.create(
    {
      projectId,
      instanceId,
      requestId: "native",
      label: "API specialist",
      role: "api",
      instructions: "Review API evidence",
      model: "fixture",
      accessMode: "repository-read-only",
    },
    "/fixture/native",
  );
  const specialist = yield* workspace.registerSpecialist({
    requestId: "specialist",
    nativeTarget: { projectId, instanceId, agentId: row.agent_id },
    label: "API specialist",
    assignments: [
      {
        sharedProjectId: project.sharedProjectId,
        charter: "Review API evidence",
        paths: [],
        tags: [],
      },
    ],
  });
  const checkout = yield* workspace.attachCheckout("session", {
    localEnvironmentId: EnvironmentId.make("local"),
    localProjectId: ProjectId.make("api"),
    repository: project.repository,
  });
  const context = yield* workspace.putContext(
    { kind: "participant", participantId: participant.participantId },
    {
      contextId: "task",
      checkoutId: checkout.checkoutId,
      source: { kind: "project_conversation" },
      objective: "Review an API change",
      revision: { branch: "feature/api", commit: "a".repeat(40), applicability: "branch" },
      paths: [],
      tags: [],
    },
  );
  const roster: MeerkatProjectTeam = {
    projectId,
    observation: "loaded_runtimes",
    observedAt: row.created_at,
    projectAgents: [
      {
        agentId: row.agent_id,
        projectId,
        instanceId,
        label: row.label,
        role: row.role,
        instructions: row.instructions,
        model: row.model,
        accessMode: "repository-read-only",
        enabled: true,
        archived: false,
        connectionStatus: "connected",
        error: null,
        agentRef: "ref",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    ],
    providers: [
      {
        instanceId,
        label: "Native",
        status: "ready",
        errors: [],
        totalScopeCount: 1,
        unloadedScopeCount: 0,
        loadedMobCount: 1,
        agents: [
          {
            agentRef: "ref",
            mobId: row.mob_id,
            mobLabel: "Native",
            mobKind: "domain",
            scopeLabel: "API",
            projectAgentId: row.agent_id,
            availability: "live",
            observedAccessMode: "repository-read-only",
            record: {
              identity: row.agent_identity,
              display_name: row.label,
              runtime_key: "runtime",
              runtime_member_id: "member",
              session_id: "native-session",
              visibility: "addressable",
              addressable: true,
              health: "ready",
              labels: {},
            },
          },
        ],
      },
    ],
  };
  const repositories = {
    list: () => Effect.succeed([]),
    read: () => Effect.succeed({}),
    search: () => Effect.succeed([]),
  };
  let permissive = false;
  const service = yield* makeSharedToolService(
    workspace,
    {
      contextForInteraction: (_specialistId, sessionId, interactionId) =>
        sessionId === "native-session" && interactionId === "request-interaction"
          ? Effect.succeed(context)
          : Effect.fail(
              new SharedWorkspaceError({ code: "unavailable", message: "No exact binding" }),
            ),
    },
    {
      projectTeam: () =>
        Effect.succeed(
          permissive
            ? {
                ...roster,
                projectAgents: roster.projectAgents.map((agent) => ({
                  ...agent,
                  accessMode: "full-access" as const,
                })),
              }
            : roster,
        ),
    },
    repositories,
    undefined,
    { environmentId: EnvironmentId.make("shared-host") },
  );
  const invocation = (
    action: string,
    args: Record<string, unknown> = {},
  ): SharedToolInvocation => ({
    version: 1,
    mobId: row.mob_id,
    sessionId: "native-session",
    runId: "run",
    callId: "call",
    interactionId: "request-interaction",
    action,
    arguments: args,
  });
  const publication = {
    eventId: "finding",
    contextId: context.contextId,
    contextVersion: context.contextVersion,
    revision: context.revision,
    kind: "finding",
    summary: "The API change requires client coordination.",
    paths: [],
    tags: [],
    sources: [],
  };
  return {
    service,
    roster,
    repositories,
    workspace,
    specialist,
    context,
    invocation,
    publication,
    participant,
    allowFullAccess: () => {
      permissive = true;
    },
  };
});
const sealedSource = Effect.fn("test.sealedSource")(function* (
  h: Effect.Success<typeof fixture>,
  recipientIds?: ReadonlyArray<string>,
) {
  const event = yield* h.workspace.publishActivity(
    { kind: "participant", participantId: h.participant.participantId },
    {
      ...h.publication,
      eventId: "source-event",
      kind: "finding",
      paths: ["src/api.ts"],
      tags: ["api"],
      sources: [
        {
          title: "Native observation",
          uri: "shared://source/native",
          native: { owner: "meta", reference: "receipt-exact", stream: "console", cursor: "18" },
        },
      ],
      ...(recipientIds ? { recipientIds } : {}),
    },
  );
  const inbox = yield* h.workspace.readInbox(
    { kind: "specialist", specialistId: h.specialist.specialistId },
    {},
  );
  expect(inbox.events).toHaveLength(1);
  expect(inbox.batchId).not.toBeNull();
  return { event, inbox, source: { batchId: inbox.batchId!, eventId: event.eventId } };
});
const run = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient | Path.Path>) =>
  work.pipe(Effect.provide([SqlitePersistenceMemory, Path.layer]));

describe("native tool caller and context authority", () => {
  it.effect(
    "publishes an unbound inbox observation with its own immutable context and source proof",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* fixture;
          const sql = yield* SqlClient.SqlClient;
          const { event, inbox, source } = yield* sealedSource(h);
          const interests =
            yield* sql`SELECT * FROM shared_interests ORDER BY owner_id, project_id, dimension, value`;
          yield* h.workspace.putContext(
            { kind: "participant", participantId: h.participant.participantId },
            {
              ...h.context,
              objective: "New task revision",
              revision: { ...h.context.revision, commit: "b".repeat(40) },
            },
          );
          const args = {
            source,
            eventId: "derived-event",
            kind: "briefing",
            summary: "The API finding affects its consumers.",
            sources: [{ title: "Additional source", uri: "shared://more" }],
          };
          const unbound = {
            ...h.invocation("activity.publish_from_inbox", args),
            interactionId: undefined,
          };
          const value = yield* Schema.decodeUnknownEffect(SharedActivity)(
            (yield* h.service.invoke(unbound)).content,
          );
          expect(value.author).toMatchObject({
            kind: "specialist",
            participantId: h.specialist.specialistId,
          });
          expect(value.context.participantId).toBe(h.specialist.specialistId);
          expect(value.context.contextId).not.toBe(h.context.contextId);
          expect(value.context.source).toEqual({
            kind: "specialist_observation",
            specialistId: h.specialist.specialistId,
            ...source,
            sequence: event.sequence,
            sourceContextId: h.context.contextId,
            sourceContextVersion: h.context.contextVersion,
            revisionCheckoutId: h.context.checkoutId,
          });
          expect(value.revision).toEqual(event.revision);
          expect(value.paths).toEqual(event.paths);
          expect(value.tags).toEqual(event.tags);
          expect(value.sources).toEqual([...event.sources, ...args.sources]);
          expect(yield* h.workspace.checkout(value.context.checkoutId)).toMatchObject({
            participantId: h.specialist.specialistId,
            localEnvironmentId: "shared-host",
            association: "specialist_observation_host",
          });
          expect(
            yield* h.workspace.readInbox(
              { kind: "specialist", specialistId: h.specialist.specialistId },
              {},
            ),
          ).toEqual(inbox);
          expect(
            yield* sql`SELECT * FROM shared_interests ORDER BY owner_id, project_id, dimension, value`,
          ).toEqual(interests);
          expect((yield* h.service.invoke(unbound)).content).toEqual(value);
          yield* h.workspace.acknowledgeInbox(
            { kind: "specialist", specialistId: h.specialist.specialistId },
            { batchId: source.batchId },
          );
          expect((yield* h.service.invoke(unbound)).content).toEqual(value);
          expect(
            (yield* h.service
              .invoke({ ...unbound, arguments: { ...args, summary: "Changed retry" } })
              .pipe(Effect.flip)).code,
          ).toBe("conflict");
          expect(
            (yield* h.service
              .invoke({ ...unbound, action: "activity.publish", arguments: h.publication })
              .pipe(Effect.flip)).code,
          ).toBe("forbidden");
        }),
      ),
  );
  it.effect(
    "rejects another recipient's batch, an event outside the batch, and forged authority fields",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* fixture;
          const other = yield* h.workspace.join("other-session", { displayName: "Bea" });
          const { source } = yield* sealedSource(h, [other.participantId]);
          const foreign = yield* h.workspace.readInbox(
            { kind: "participant", participantId: other.participantId },
            {},
          );
          const args = { source, eventId: "derived", kind: "finding", summary: "Observation" };
          for (const invalid of [
            { ...args, source: { ...source, batchId: foreign.batchId } },
            { ...args, source: { ...source, eventId: "not-in-this-batch" } },
          ]) {
            expect(
              (yield* h.service
                .invoke({
                  ...h.invocation("activity.publish_from_inbox", invalid),
                  interactionId: undefined,
                })
                .pipe(Effect.flip)).code,
            ).toBe("forbidden");
          }
          for (const field of [
            "author",
            "contextId",
            "contextVersion",
            "revision",
            "recipientIds",
            "sessionId",
          ]) {
            expect(
              (yield* h.service
                .invoke(h.invocation("activity.publish_from_inbox", { ...args, [field]: "forged" }))
                .pipe(Effect.flip)).code,
            ).toBe("invalid_input");
          }
          expect(
            (yield* h.service
              .invoke({
                ...h.invocation("activity.publish_from_inbox", args),
                sessionId: "old-native-session",
              })
              .pipe(Effect.flip)).code,
          ).toBe("forbidden");
          h.allowFullAccess();
          expect(
            (yield* h.service
              .invoke(h.invocation("activity.publish_from_inbox", args))
              .pipe(Effect.flip)).code,
          ).toBe("forbidden");
          const sql = yield* SqlClient.SqlClient;
          expect(
            yield* sql`SELECT context_id FROM shared_work_contexts WHERE participant_id = ${h.specialist.specialistId}`,
          ).toEqual([]);
        }),
      ),
  );
  it.effect(
    "rechecks current assignment and registration instead of treating a sealed delivery as permanent authority",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* fixture;
          const { source } = yield* sealedSource(h);
          const actor = { kind: "specialist" as const, specialistId: h.specialist.specialistId };
          const args = {
            source,
            eventId: "derived",
            kind: "finding" as const,
            summary: "Observation",
          };
          expect(
            (yield* h.workspace
              .publishActivityFromInbox(
                actor,
                {
                  environmentId: EnvironmentId.make("shared-host"),
                  nativeTarget: { ...h.specialist.nativeTarget, agentId: "former-native-identity" },
                },
                args,
              )
              .pipe(Effect.flip)).code,
          ).toBe("forbidden");
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM shared_assignments WHERE specialist_id = ${h.specialist.specialistId}`;
          expect(
            (yield* h.service
              .invoke(h.invocation("activity.publish_from_inbox", args))
              .pipe(Effect.flip)).code,
          ).toBe("forbidden");
          expect(
            yield* sql`SELECT context_id FROM shared_work_contexts WHERE participant_id = ${h.specialist.specialistId}`,
          ).toEqual([]);
        }),
      ),
  );
  it.effect(
    "retains snapshot ownership and normal correction lineage without acknowledging or merging source history",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* fixture;
          const actor = {
            kind: "participant" as const,
            participantId: h.participant.participantId,
          };
          const snapshot = yield* h.workspace.putSnapshot(actor, {
            checkoutId: h.context.checkoutId,
            revision: h.context.revision,
            patch: "diff --git a/src/api.ts b/src/api.ts\n+changed\n",
          });
          const snapContext = yield* h.workspace.putContext(actor, {
            ...h.context,
            revision: { ...h.context.revision, snapshotId: snapshot.snapshotId },
          });
          const old = yield* h.workspace.putKnowledge(actor, {
            evidenceId: "original",
            contextId: snapContext.contextId,
            contextVersion: snapContext.contextVersion,
            revision: snapContext.revision,
            kind: "finding",
            title: "Original",
            body: "Earlier evidence",
            sources: [],
            supersedes: [],
            state: "open",
          });
          const event = yield* h.workspace.publishActivity(actor, {
            ...h.publication,
            contextVersion: snapContext.contextVersion,
            revision: snapContext.revision,
            eventId: "snapshot-source",
            kind: "finding",
            sources: [{ title: "Original", uri: "shared://knowledge/original" }],
          });
          const batch = yield* h.workspace.readInbox(
            { kind: "specialist", specialistId: h.specialist.specialistId },
            {},
          );
          const value = yield* Schema.decodeUnknownEffect(SharedKnowledge)(
            (yield* h.service.invoke({
              ...h.invocation("knowledge.record_from_inbox", {
                source: { batchId: batch.batchId, eventId: event.eventId },
                evidenceId: "corrected",
                kind: "resolution",
                title: "Correction",
                body: "The patch resolves this concern.",
                supersedes: [old.evidenceId],
                state: "resolved",
              }),
              interactionId: undefined,
            })).content,
          );
          expect(value.observationSource).toMatchObject({
            revisionCheckoutId: h.context.checkoutId,
            sourceContextVersion: snapContext.contextVersion,
            specialistId: h.specialist.specialistId,
            batchId: batch.batchId,
            eventId: event.eventId,
          });
          expect(value.revision).toEqual(snapContext.revision);
          expect(value.author.kind).toBe("specialist");
          expect(value.sources).toEqual(event.sources);
          expect(
            (yield* h.workspace.searchKnowledge({ evidenceId: old.evidenceId })).records[0]!
              .corrections,
          ).toMatchObject([{ evidenceId: value.evidenceId }]);
          const humanInbox = yield* h.workspace.readInbox(actor, {});
          expect(humanInbox.events).toMatchObject([
            {
              kind: "correction",
              knowledge: { evidenceId: value.evidenceId, supersedes: [old.evidenceId] },
              context: { source: value.observationSource },
            },
          ]);
          expect(
            yield* h.workspace.readInbox(
              { kind: "specialist", specialistId: h.specialist.specialistId },
              {},
            ),
          ).toEqual(batch);
          expect(
            (yield* h.workspace.context(h.context.contextId, h.context.contextVersion))
              .participantId,
          ).toBe(h.participant.participantId);
        }),
      ),
  );
  it.effect(
    "rolls back owned projections on correction or encoded-size failure and never drops inherited references",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* fixture;
          const { source, inbox } = yield* sealedSource(h);
          const input = {
            source,
            evidenceId: "bad-correction",
            kind: "finding",
            title: "Finding",
            body: "Evidence",
            supersedes: ["missing"],
            state: "open",
          };
          expect(
            (yield* h.service
              .invoke(h.invocation("knowledge.record_from_inbox", input))
              .pipe(Effect.flip)).code,
          ).toBe("invalid_input");
          const sources = Array.from({ length: 20 }, (_, index) => ({
            title: `Reference ${index}`,
            uri: `https://example.com/${"a".repeat(1980)}${index}`,
          }));
          expect(
            (yield* h.service
              .invoke(
                h.invocation("knowledge.record_from_inbox", {
                  ...input,
                  supersedes: [],
                  body: "界".repeat(32_768),
                  sources,
                }),
              )
              .pipe(Effect.flip)).code,
          ).toBe("limit_exceeded");
          expect(
            (yield* h.service
              .invoke(
                h.invocation("knowledge.record_from_inbox", {
                  ...input,
                  supersedes: [],
                  sources: Array.from({ length: 64 }, (_, index) => ({
                    title: `Source ${index}`,
                    uri: `shared://additional/${index}`,
                  })),
                }),
              )
              .pipe(Effect.flip)).code,
          ).toBe("limit_exceeded");
          const sql = yield* SqlClient.SqlClient;
          expect(
            yield* sql`SELECT context_id FROM shared_work_contexts WHERE participant_id = ${h.specialist.specialistId}`,
          ).toEqual([]);
          expect(
            yield* sql`SELECT participant_id FROM shared_participants WHERE participant_id = ${h.specialist.specialistId}`,
          ).toEqual([]);
          expect((yield* h.workspace.searchKnowledge({})).records).toEqual([]);
          expect(
            yield* h.workspace.readInbox(
              { kind: "specialist", specialistId: h.specialist.specialistId },
              {},
            ),
          ).toEqual(inbox);
        }),
      ),
  );
  it.effect(
    "never falls back to a personal delegation after a registered native caller fails verification",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* fixture;
          let localCalls = 0;
          const router = yield* makeSharedNativeToolRouter(h.service, {
            invoke: () =>
              Effect.sync(() => {
                localCalls++;
                return { personal: true };
              }),
          });
          expect((yield* router.invoke(h.invocation("projects.list"))).content).toMatchObject({
            items: [{ name: "API" }],
          });
          expect(
            (yield* router
              .invoke({ ...h.invocation("projects.list"), sessionId: "forged" })
              .pipe(Effect.flip)).code,
          ).toBe("forbidden");
          h.allowFullAccess();
          expect((yield* router.invoke(h.invocation("projects.list")).pipe(Effect.flip)).code).toBe(
            "forbidden",
          );
          expect(localCalls).toBe(0);
        }),
      ),
  );

  it.effect(
    "passes an unregistered mob to the personal verifier without changing its native identity",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* fixture;
          const calls: SharedToolInvocation[] = [];
          const router = yield* makeSharedNativeToolRouter(h.service, {
            invoke: (input) => {
              calls.push(input);
              return Effect.fail(
                new SharedWorkspaceError({ code: "forbidden", message: "No enabled grant" }),
              );
            },
          });
          const input = {
            ...h.invocation("projects.list", { mobId: h.roster.providers[0]!.agents[0]!.mobId }),
            mobId: "unregistered-thread",
          };
          expect((yield* router.invoke(input).pipe(Effect.flip)).code).toBe("forbidden");
          expect(calls).toEqual([input]);
        }),
      ),
  );

  it.effect(
    "returns bounded directory summaries and explicit details after caller verification",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* fixture;
          const listed = yield* h.service.invoke(h.invocation("specialists.list", { limit: 1 }));
          expect(listed.content).toMatchObject({
            items: [{ specialistId: h.specialist.specialistId }],
            nextCursor: null,
          });
          expect(encode(listed.content)).not.toContain('"assignments":');
          expect(listed.content).toMatchObject({
            items: [
              {
                matches: [
                  { charterExcerpt: "Review API evidence", charterExcerptTruncated: false },
                ],
              },
            ],
          });
          expect(
            (yield* h.service.invoke(
              h.invocation("specialists.get", { specialistId: h.specialist.specialistId }),
            )).content,
          ).toEqual(h.specialist);
          const projects = yield* h.workspace.listProjects({});
          expect((yield* h.service.invoke(h.invocation("projects.list", {}))).content).toEqual(
            projects,
          );
          expect(
            (yield* h.service.invoke(
              h.invocation("projects.get", { sharedProjectId: projects.items[0]!.sharedProjectId }),
            )).content,
          ).toMatchObject({ sharedProjectId: projects.items[0]!.sharedProjectId });
          expect(
            (yield* h.service
              .invoke(h.invocation("projects.list", { limit: 101 }))
              .pipe(Effect.flip)).code,
          ).toBe("invalid_input");
          expect(
            (yield* h.service
              .invoke({
                ...h.invocation("specialists.get", { specialistId: h.specialist.specialistId }),
                sessionId: "someone-else",
              })
              .pipe(Effect.flip)).code,
          ).toBe("forbidden");
        }),
      ),
  );
  it.effect(
    "rejects spoofed mob/session and permissive native policy even with a valid transport token",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* fixture;
          expect(
            (yield* h.service
              .invoke({ ...h.invocation("projects.list"), sessionId: "someone-else" })
              .pipe(Effect.flip)).code,
          ).toBe("forbidden");
          expect(
            (yield* h.service
              .invoke({ ...h.invocation("projects.list"), mobId: "another-mob" })
              .pipe(Effect.flip)).code,
          ).toBe("forbidden");
          h.allowFullAccess();
          expect(
            (yield* h.service.invoke(h.invocation("projects.list")).pipe(Effect.flip)).code,
          ).toBe("forbidden");
        }),
      ),
  );
  it.effect(
    "binds authored evidence to the exact native interaction and retained context version",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* fixture;
          yield* h.workspace.putContext(
            { kind: "participant", participantId: h.context.participantId },
            {
              ...h.context,
              objective: "Later objective",
              revision: { ...h.context.revision, commit: "b".repeat(40) },
            },
          );
          const published = yield* h.service.invoke(
            h.invocation("activity.publish", h.publication),
          );
          expect(published.content).toMatchObject({
            context: { objective: h.context.objective, revision: h.context.revision },
            author: { kind: "specialist", participantId: h.specialist.specialistId },
          });
          expect(
            (yield* h.service
              .invoke({
                ...h.invocation("activity.publish", { ...h.publication, eventId: "unbound" }),
                interactionId: "peer-interaction",
              })
              .pipe(Effect.flip)).code,
          ).toBe("unavailable");
          expect(
            (yield* h.service
              .invoke(
                h.invocation("activity.publish", {
                  ...h.publication,
                  eventId: "forged",
                  contextVersion: "new-version",
                }),
              )
              .pipe(Effect.flip)).code,
          ).toBe("forbidden");
        }),
      ),
  );
  it.effect(
    "allows unbound peer turns to fetch their own product inbox without borrowing a participant",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* fixture;
          const unbound = { ...h.invocation("inbox.list"), interactionId: undefined };
          expect((yield* h.service.invoke(unbound)).content).toMatchObject({
            recipientId: h.specialist.specialistId,
            batchId: null,
          });
          expect(
            (yield* h.service
              .invoke({ ...unbound, arguments: { recipientId: h.context.participantId } })
              .pipe(Effect.flip)).code,
          ).toBe("forbidden");
          expect(
            (yield* h.service
              .invoke({ ...unbound, action: "activity.publish", arguments: h.publication })
              .pipe(Effect.flip)).code,
          ).toBe("forbidden");
        }),
      ),
  );
  it.effect(
    "routes composition through the verified specialist and exposes retained actor-scoped operations",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* fixture;
          const calls: Array<{ actor: SharedActor; input: SharedCompositionInput }> = [];
          const observations: Array<{ actor: SharedActor; operationId: string }> = [];
          const operation: SharedCompositionOperation = {
            operationKey: "retained",
            operationId: "test-operation",
            actor: { kind: "specialist", id: h.specialist.specialistId },
            kind: "create",
            status: "pending",
            detail: "Waiting for native evidence",
            creations: [],
            evidence: [],
            lineage: [],
            createdAt: h.specialist.createdAt,
            updatedAt: h.specialist.createdAt,
          };
          const service = yield* makeSharedToolService(
            h.workspace,
            {
              contextForInteraction: () =>
                Effect.fail(
                  new SharedWorkspaceError({
                    code: "forbidden",
                    message: "Composition does not borrow participant contexts",
                  }),
                ),
            },
            { projectTeam: () => Effect.succeed(h.roster) },
            h.repositories,
            {
              execute: (actor, input) => {
                calls.push({ actor, input });
                return Effect.succeed(operation);
              },
              operation: (actor, operationId) => {
                observations.push({ actor, operationId });
                return Effect.succeed(operation);
              },
            },
          );
          const actions = [
            "specialists.create",
            "specialists.update",
            "specialists.connect",
            "specialists.split",
            "specialists.consolidate",
            "specialists.supersede",
          ];
          for (const action of actions) {
            const result = yield* service.invoke({
              ...h.invocation(action, {
                operationId: "test-operation",
                kind: "forged-kind",
                actor: { kind: "participant", id: "forged" },
                creations: [],
                revisions: [],
                peers: [],
                transitions: [],
              }),
              interactionId: undefined,
            });
            expect(result.content).toEqual(operation);
          }
          expect(calls.map((call) => call.input.kind)).toEqual([
            "create",
            "revise",
            "connect",
            "split",
            "consolidate",
            "supersede",
          ]);
          expect(
            calls.every(
              (call) =>
                call.actor.kind === "specialist" &&
                call.actor.specialistId === h.specialist.specialistId,
            ),
          ).toBe(true);
          expect(
            (yield* service.invoke(
              h.invocation("operations.get", { operationId: "test-operation" }),
            )).content,
          ).toEqual(operation);
          expect(observations).toEqual([
            {
              actor: { kind: "specialist", specialistId: h.specialist.specialistId },
              operationId: "test-operation",
            },
          ]);
          expect(
            (yield* service
              .invoke({
                ...h.invocation("operations.get", { operationId: "test-operation" }),
                sessionId: "forged",
              })
              .pipe(Effect.flip)).code,
          ).toBe("forbidden");
          expect(observations).toHaveLength(1);
          expect(
            (yield* service.invoke(h.invocation("specialists.disconnect", {})).pipe(Effect.flip))
              .code,
          ).toBe("invalid_input");
          expect(
            (yield* h.service
              .invoke(h.invocation("operations.get", { operationId: "test-operation" }))
              .pipe(Effect.flip)).code,
          ).toBe("unavailable");
        }),
      ),
  );
});

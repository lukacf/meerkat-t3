import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  MeerkatTeamError,
  type ConsoleFrame,
  type MeerkatAgentControlReceipt,
  type MeerkatAgentSendInput,
  type SharedCompositionInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { agentFingerprint } from "../provider/meerkat/MeerkatProjectAgentStore.ts";
import { makeSharedCompositionService } from "./SharedCompositionService.ts";
import { makeSharedWorkspaceStore } from "./SharedWorkspaceStore.ts";
import { makeSharedDelegationService } from "./SharedDelegationService.ts";
import {
  makeSharedSpecialistService,
  sharedOutcomeFromReceipt,
} from "./SharedSpecialistService.ts";

const timestamp = "2026-10-17T00:00:00.000Z";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const terminal = (interactionId: string, answer: string): ConsoleFrame => ({
  id: `completed-${interactionId}`,
  cursor: "2",
  dedupe_key: `completed-${interactionId}`,
  timestamp_ms: 2,
  runtime_key: "native-runtime",
  identity: "native-specialist",
  session_id: "native-session",
  kind: "interaction_complete",
  status: "completed",
  frame_version: 1,
  payload: { answer },
  source: { kind: "console_event" },
  interaction_id: interactionId,
});
const receipt = (requestId: string, completion?: ConsoleFrame): MeerkatAgentControlReceipt => ({
  status: "accepted",
  requestId,
  message: null,
  receipt: {
    mobId: "native-mob",
    identity: "native-specialist",
    receipt: {
      identity: "native-specialist",
      session_id: "native-session",
      interaction_id: `interaction-${requestId}`,
      input_frame_id: `input-${requestId}`,
      cursor: "1",
      status: completion ? "completed" : "accepted",
      ...(completion ? { completion } : {}),
    },
  },
});
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* DateTime.now;
  for (const session of ["alice-session", "bob-session"])
    yield* sql`INSERT INTO auth_sessions(session_id,subject,scopes,method,issued_at,expires_at)
      VALUES (${session},${session},'["shared:read","shared:contribute"]','pairing',${DateTime.formatIso(now)},${DateTime.formatIso(DateTime.add(now, { hours: 1 }))})`;
  const store = yield* makeSharedWorkspaceStore;
  yield* store.configure({ name: "Shared workspace" });
  const alice = yield* store.join("alice-session", { displayName: "Alice" });
  const bob = yield* store.join("bob-session", { displayName: "Bob" });
  const projectId = ProjectId.make("host-project");
  const instanceId = ProviderInstanceId.make("meerkat");
  const project = yield* store.registerProject({
    requestId: "project",
    name: "API",
    repository: "https://github.com/example/api",
    hostProjectId: projectId,
  });
  const specialist = yield* store.registerSpecialist({
    requestId: "specialist",
    label: "API specialist",
    nativeTarget: { projectId, instanceId, agentId: "native-agent" },
    assignments: [
      {
        sharedProjectId: project.sharedProjectId,
        charter: "Understand API compatibility.",
        paths: ["src"],
        tags: ["api"],
      },
    ],
  });
  const aliceCheckout = yield* store.attachCheckout("alice-session", {
    localEnvironmentId: EnvironmentId.make("alice-local"),
    localProjectId: ProjectId.make("alice-project"),
    repository: project.repository,
  });
  const bobCheckout = yield* store.attachCheckout("bob-session", {
    localEnvironmentId: EnvironmentId.make("bob-local"),
    localProjectId: ProjectId.make("bob-project"),
    repository: project.repository,
  });
  const aliceContext = yield* store.putContext(
    { kind: "participant", participantId: alice.participantId },
    {
      contextId: "alice-task",
      checkoutId: aliceCheckout.checkoutId,
      source: { kind: "project_conversation" },
      objective: "Change API",
      revision: { branch: "feature/api", commit: "a".repeat(40), applicability: "branch" },
      paths: ["src"],
      tags: ["api"],
    },
  );
  const bobContext = yield* store.putContext(
    { kind: "participant", participantId: bob.participantId },
    {
      contextId: "bob-task",
      checkoutId: bobCheckout.checkoutId,
      source: { kind: "project_conversation" },
      objective: "Integrate API",
      revision: { branch: "feature/client", commit: "b".repeat(40), applicability: "branch" },
      paths: ["src"],
      tags: ["api"],
    },
  );
  const sends: MeerkatAgentSendInput[] = [];
  const receipts = new Map<string, MeerkatAgentControlReceipt>();
  let nativeUnavailable = false;
  let preflight: Effect.Effect<void, MeerkatTeamError> = Effect.void;
  let observedPolicy: "repository-read-only" | "full-access" | undefined = "repository-read-only";
  let availability: "live" | "unloaded" = "live";
  const team = {
    projectTeam: () =>
      Effect.succeed({
        projectId,
        observedAt: timestamp,
        observation: "loaded_runtimes" as const,
        providers: [
          {
            instanceId,
            label: "Meerkat",
            status: "ready" as const,
            errors: [],
            totalScopeCount: 1,
            unloadedScopeCount: 0,
            loadedMobCount: 1,
            agents: [
              {
                agentRef: "native-agent-ref",
                projectAgentId: "native-agent",
                mobId: "native-mob",
                mobLabel: "API specialist",
                mobKind: "project",
                scopeLabel: "Project",
                availability,
                ...(observedPolicy ? { observedAccessMode: observedPolicy } : {}),
                record: {
                  identity: "native-specialist",
                  display_name: "API specialist",
                  runtime_key: "native-runtime",
                  runtime_member_id: "native-member",
                  session_id: "native-session",
                  visibility: "addressable" as const,
                  addressable: true,
                  health: "healthy",
                  labels: {},
                },
              },
            ],
          },
        ],
        projectAgents: [
          {
            agentId: "native-agent",
            projectId,
            instanceId,
            label: "API specialist",
            role: "api",
            instructions: "Understand the API",
            model: "test-model",
            accessMode: "repository-read-only" as const,
            enabled: true,
            archived: false,
            connectionStatus: "connected" as const,
            error: null,
            agentRef: "native-agent-ref",
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      }),
    agentActivity: () =>
      Effect.fail(
        new MeerkatTeamError({
          projectId,
          operation: "agent-activity",
          message: "Not part of request result evidence.",
        }),
      ),
    agentSendWithAdmission: <E = never, R = never>(
      input: MeerkatAgentSendInput,
      admission?: { readonly check: Effect.Effect<void, E, R> },
    ) =>
      Effect.gen(function* () {
        const saved = receipts.get(input.requestId);
        if (saved) return saved;
        yield* preflight;
        yield* admission?.check ?? Effect.void;
        sends.push(input);
        const accepted = nativeUnavailable
          ? {
              status: "uncertain" as const,
              requestId: input.requestId,
              receipt: null,
              message: "Transport lost",
            }
          : receipt(input.requestId);
        receipts.set(input.requestId, accepted);
        return accepted;
      }),
    agentDeliveryReconcile: <E = never, R = never>(
      input: MeerkatAgentSendInput,
      onMissing: Effect.Effect<void, E, R> = Effect.void,
    ) =>
      Effect.gen(function* () {
        const saved = receipts.get(input.requestId);
        if (!saved) yield* onMissing;
        return saved;
      }),
  } satisfies Parameters<typeof makeSharedSpecialistService>[1];
  const service = yield* makeSharedSpecialistService(store, team);
  const inputA = {
    specialistId: specialist.specialistId,
    requestId: "same-client-id",
    contextId: aliceContext.contextId,
    contextVersion: aliceContext.contextVersion,
    text: "Review Alice's branch",
  };
  const inputB = {
    ...inputA,
    contextId: bobContext.contextId,
    contextVersion: bobContext.contextVersion,
    text: "Review Bob's branch",
  };
  return {
    store,
    service,
    team,
    alice,
    bob,
    specialist,
    aliceContext,
    bobContext,
    sends,
    receipts,
    inputA,
    inputB,
    setPreflight: (effect: typeof preflight) => {
      preflight = effect;
    },
    offline: () => {
      nativeUnavailable = true;
    },
    online: () => {
      nativeUnavailable = false;
    },
    nativePolicy: (mode: typeof observedPolicy, live: typeof availability = "live") => {
      observedPolicy = mode;
      availability = live;
    },
  };
});

describe("shared specialist request custody", () => {
  const delegated = Effect.gen(function* () {
    const h = yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    const observedAt = yield* DateTime.now;
    const timestamp = DateTime.formatIso(observedAt);
    const expiresAt = DateTime.formatIso(DateTime.add(observedAt, { hours: 1 }));
    yield* sql`INSERT OR REPLACE INTO auth_sessions(session_id,subject,scopes,method,issued_at,expires_at)
      VALUES ('alice-session','alice','["shared:read","shared:contribute"]','pairing',${timestamp},${expiresAt})`;
    const context = yield* h.store.putContext(
      { kind: "participant", participantId: h.alice.participantId },
      {
        ...h.aliceContext,
        contextId: "local-agent-task",
        source: { kind: "thread", threadId: ThreadId.make("local-thread") },
      },
    );
    const grants = yield* makeSharedDelegationService(h.store);
    const grant = yield* grants.register("alice-session", {
      requestId: "delegate",
      label: "Local task",
      binding: {
        environmentId: EnvironmentId.make("alice-local"),
        projectId: ProjectId.make("alice-project"),
        threadId: ThreadId.make("local-thread"),
        instanceId: ProviderInstanceId.make("meerkat"),
        mobId: "local-mob",
        sessionId: "local-session",
      },
      contextId: context.contextId,
      contextVersion: context.contextVersion,
      actions: ["specialists.send", "specialists.request"],
      expiresAt,
    });
    const { actor } = yield* grants.authorize("alice-session", {
      delegationId: grant.delegationId,
      action: "specialists.send",
    });
    return {
      ...h,
      grants,
      grant,
      actor,
      context,
      input: { ...h.inputA, contextId: context.contextId, contextVersion: context.contextVersion },
    };
  });

  it.effect(
    "retries a definitely unsent request after preflight recovers and service reconstruction",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture;
        h.setPreflight(
          Effect.fail(
            new MeerkatTeamError({
              projectId: h.specialist.nativeTarget.projectId,
              operation: "agent-control",
              message: "Account unavailable",
            }),
          ),
        );
        expect((yield* h.service.send("alice-session", h.inputA).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        const conversation = yield* h.service.conversation("alice-session", {
          specialistId: h.specialist.specialistId,
        });
        const unsent = conversation.requests[0]!;
        expect(unsent.outcome.status).toBe("not_admitted");
        expect(h.sends).toHaveLength(0);
        h.setPreflight(Effect.void);
        const restarted = yield* makeSharedSpecialistService(h.store, h.team);
        const delivered = yield* restarted.send("alice-session", h.inputA);
        expect(delivered.requestId).toBe(unsent.requestId);
        expect(delivered.nativeRequestId).toBe(unsent.nativeRequestId);
        expect(delivered.context).toEqual(unsent.context);
        expect(delivered.outcome.status).toBe("accepted");
        yield* restarted.send("alice-session", h.inputA);
        expect(h.sends).toHaveLength(1);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "recovers the original ID after interruption between attribution and delivery admission",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture;
        const entered = yield* Deferred.make<void>();
        h.setPreflight(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)));
        const pending = yield* h.service.send("alice-session", h.inputA).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(pending);
        const sql = yield* SqlClient.SqlClient;
        const saved = yield* sql<{
          request_id: string;
        }>`SELECT request_id FROM shared_specialist_requests`;
        expect(saved).toHaveLength(1);
        expect(h.sends).toHaveLength(0);
        h.setPreflight(Effect.void);
        const restarted = yield* makeSharedSpecialistService(h.store, h.team);
        expect((yield* restarted.send("alice-session", h.inputA)).requestId).toBe(
          saved[0]!.request_id,
        );
        expect(h.sends).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("rechecks human session revocation after preflight and before delivery admission", () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      h.setPreflight(
        sql`UPDATE auth_sessions SET revoked_at = 'revoked' WHERE session_id = 'alice-session'`.pipe(
          Effect.asVoid,
          Effect.orDie,
        ),
      );
      expect((yield* h.service.send("alice-session", h.inputA).pipe(Effect.flip)).code).toBe(
        "forbidden",
      );
      expect(h.sends).toHaveLength(0);
      const requests = yield* h.service.conversation("bob-session", {
        specialistId: h.specialist.specialistId,
      });
      expect(requests.requests[0]!.outcome.status).toBe("not_admitted");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("rejects revoked delegation and changed routing after model preflight", () =>
    Effect.gen(function* () {
      const h = yield* delegated;
      h.setPreflight(
        h.grants
          .revoke("alice-session", { delegationId: h.grant.delegationId })
          .pipe(Effect.asVoid, Effect.orDie),
      );
      expect((yield* h.service.sendDelegated(h.actor, h.input).pipe(Effect.flip)).code).toBe(
        "forbidden",
      );
      expect(h.sends).toHaveLength(0);
      const sql = yield* SqlClient.SqlClient;
      h.setPreflight(
        sql`UPDATE shared_specialists SET definition_json = json_set(definition_json, '$.supersededAt', ${timestamp}) WHERE specialist_id = ${h.specialist.specialistId}`.pipe(
          Effect.asVoid,
          Effect.orDie,
        ),
      );
      expect((yield* h.service.send("bob-session", h.inputB).pipe(Effect.flip)).code).toBe(
        "conflict",
      );
      expect(h.sends).toHaveLength(0);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("does not recover an unsent request against a changed context version", () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      h.setPreflight(
        Effect.fail(
          new MeerkatTeamError({
            projectId: h.specialist.nativeTarget.projectId,
            operation: "agent-control",
            message: "Account unavailable",
          }),
        ),
      );
      yield* h.service.send("alice-session", h.inputA).pipe(Effect.result);
      yield* h.store.putContext(
        { kind: "participant", participantId: h.alice.participantId },
        {
          ...h.aliceContext,
          revision: { ...h.aliceContext.revision, commit: "d".repeat(40) },
        },
      );
      h.setPreflight(Effect.void);
      expect((yield* h.service.send("alice-session", h.inputA).pipe(Effect.flip)).code).toBe(
        "conflict",
      );
      expect(h.sends).toHaveLength(0);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "attributes delegated requests to the local agent while preserving the person's exact context",
    () =>
      Effect.gen(function* () {
        const h = yield* delegated;
        const request = yield* h.service.sendDelegated(h.actor, h.input);
        expect(request.author).toEqual(h.grant.participant);
        expect(request.author.kind).toBe("local_agent");
        expect(request.context).toEqual(h.context);
        expect(request.context.participantId).toBe(h.alice.participantId);
        expect((yield* h.service.sendDelegated(h.actor, h.input)).requestId).toBe(
          request.requestId,
        );
        expect(h.sends).toHaveLength(1);
        expect(
          (yield* h.service
            .sendDelegated(h.actor, {
              ...h.input,
              requestId: "different-context",
              contextId: h.aliceContext.contextId,
              contextVersion: h.aliceContext.contextVersion,
            })
            .pipe(Effect.flip)).code,
        ).toBe("forbidden");
        const { actor } = yield* h.grants.authorize("alice-session", {
          delegationId: h.grant.delegationId,
          action: "specialists.request",
        });
        expect((yield* h.service.requestDelegated(actor, request.requestId)).requestId).toBe(
          request.requestId,
        );
        const personRequest = yield* h.service.send("alice-session", h.inputA);
        expect(
          (yield* h.service.requestDelegated(actor, personRequest.requestId).pipe(Effect.flip))
            .code,
        ).toBe("forbidden");
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "refuses a delegated admission revoked while native roster observation was pending",
    () =>
      Effect.gen(function* () {
        const h = yield* delegated;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const service = yield* makeSharedSpecialistService(h.store, {
          ...h.team,
          projectTeam: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* h.team.projectTeam();
            }),
        });
        const sending = yield* service
          .sendDelegated(h.actor, h.input)
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(entered);
        yield* h.grants.revoke("alice-session", { delegationId: h.grant.delegationId });
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(sending)).code).toBe("forbidden");
        expect(h.sends).toHaveLength(0);
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT request_id FROM shared_specialist_requests`).toEqual([]);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("rechecks future-work routing atomically after native observation", () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      for (const cutover of ["superseded", "assignment"] as const) {
        const observing = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const service = yield* makeSharedSpecialistService(h.store, {
          ...h.team,
          projectTeam: () =>
            Effect.gen(function* () {
              const roster = yield* h.team.projectTeam();
              yield* Deferred.succeed(observing, undefined);
              yield* Deferred.await(resume);
              return roster;
            }),
        });
        const pending = yield* service
          .send("alice-session", { ...h.inputA, requestId: cutover })
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Deferred.await(observing);
        const changed =
          cutover === "superseded"
            ? { ...h.specialist, supersededAt: timestamp, assignmentVersion: 1 }
            : {
                ...h.specialist,
                assignmentVersion: 1,
                assignments: h.specialist.assignments.map((assignment) => ({
                  ...assignment,
                  sharedProjectId: "different-project",
                })),
              };
        yield* sql`UPDATE shared_specialists SET definition_json = ${encode(changed)}
          WHERE specialist_id = ${h.specialist.specialistId}`;
        yield* Deferred.succeed(resume, undefined);
        expect((yield* Fiber.join(pending)).code).toBe(
          cutover === "superseded" ? "conflict" : "forbidden",
        );
        yield* sql`UPDATE shared_specialists SET definition_json = ${encode(h.specialist)}
          WHERE specialist_id = ${h.specialist.specialistId}`;
      }
      expect(h.sends).toHaveLength(0);
      const claims = yield* sql`SELECT request_id FROM shared_specialist_requests`;
      expect(claims).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "holds new admission across partial native revision and recovery without replaying claimed work",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture;
        const accepted = yield* h.service.send("alice-session", h.inputA);
        h.offline();
        const claimedInput = { ...h.inputA, requestId: "claimed-before-revision" };
        const claimed = yield* h.service.send("alice-session", claimedInput);
        expect(claimed.outcome.status).toBe("unresolved");
        h.online();

        const second = yield* h.store.registerSpecialist({
          requestId: "second-specialist",
          label: "Second specialist",
          nativeTarget: { ...h.specialist.nativeTarget, agentId: "second-native-agent" },
          assignments: h.specialist.assignments,
        });
        const roster = yield* h.team.projectTeam();
        const domain = roster.projectAgents[0]!;
        const provider = roster.providers[0]!;
        const live = provider.agents[0]!;
        const observed = {
          ...roster,
          projectAgents: [
            domain,
            { ...domain, agentId: second.nativeTarget.agentId, agentRef: "second-native-ref" },
          ],
          providers: [
            {
              ...provider,
              agents: [
                live,
                {
                  ...live,
                  projectAgentId: second.nativeTarget.agentId,
                  agentRef: "second-native-ref",
                  record: { ...live.record, session_id: "second-native-session" },
                },
              ],
            },
          ],
        };
        let secondReady = false;
        const nativeRevisions = new Map<string, string>();
        const unexpected = () =>
          Effect.die("This revision does not create agents or connect peers.");
        const compositionTeam = {
          projectTeam: () => Effect.succeed(observed),
          projectAgentCreate: unexpected,
          projectAgentLifecycle: unexpected,
          peerConnectionSet: unexpected,
          projectAgentReviseShared: (input: {
            projectId: ProjectId;
            agentId: string;
            requestId: string;
            instructions: string;
          }) =>
            Effect.sync(() => {
              const applied = input.agentId === h.specialist.nativeTarget.agentId || secondReady;
              if (applied) nativeRevisions.set(input.agentId, input.instructions);
              return {
                applied,
                revisionId: `revision-${agentFingerprint([input.agentId, input.requestId])}`,
                detail: applied ? null : "The second specialist is still working.",
              };
            }),
        } satisfies Parameters<typeof makeSharedCompositionService>[1];
        const composition = yield* makeSharedCompositionService(h.store, compositionTeam);
        const input: SharedCompositionInput = {
          operationId: "revise-both",
          kind: "revise",
          creations: [],
          revisions: [h.specialist, second].map((specialist) => ({
            specialistId: specialist.specialistId,
            expectedVersion: specialist.assignmentVersion,
            assignments: specialist.assignments.map((assignment) => ({
              ...assignment,
              paths: ["src/client"],
            })),
            instructions: "Own client compatibility for future work.",
          })),
          peers: [],
          transitions: [],
        };
        // Start after the sender's outer checks, before its native admission check.
        // The first revision succeeds, but the second keeps the routing change pending.
        h.setPreflight(
          Effect.gen(function* () {
            const pending = yield* composition.execute(
              { kind: "participant", participantId: h.alice.participantId },
              input,
            );
            expect(pending.status).toBe("pending");
            expect(pending.evidence.map((item) => item.kind)).toEqual(["native_revision"]);
          }).pipe(Effect.orDie),
        );
        const blocked = yield* h.service.send("bob-session", h.inputB).pipe(Effect.flip);
        expect(blocked.code).toBe("conflict");
        expect(blocked.message).toContain("responsibilities are changing");
        expect(nativeRevisions.has(h.specialist.nativeTarget.agentId)).toBe(true);
        expect(nativeRevisions.has(second.nativeTarget.agentId)).toBe(false);
        expect(yield* h.store.specialist(h.specialist.specialistId)).toEqual(h.specialist);
        expect(h.sends).toHaveLength(2);
        h.setPreflight(Effect.void);

        // Recreate application services over the retained state. The reservation must
        // survive, while accepted and uncertain native requests remain reconcilable.
        const recovered = yield* makeSharedSpecialistService(h.store, h.team);
        expect((yield* recovered.send("bob-session", h.inputB).pipe(Effect.flip)).code).toBe(
          "conflict",
        );
        const heldRequest = (yield* recovered.conversation("bob-session", {
          specialistId: h.specialist.specialistId,
        })).requests.find((request) => request.author.participantId === h.bob.participantId);
        expect(heldRequest?.outcome.status).toBe("not_admitted");
        expect((yield* recovered.send("alice-session", h.inputA)).outcome.status).toBe("accepted");
        expect((yield* recovered.send("alice-session", claimedInput)).outcome.status).toBe(
          "unresolved",
        );
        for (const request of [accepted, claimed]) {
          h.receipts.set(
            request.nativeRequestId,
            receipt(
              request.nativeRequestId,
              terminal(`interaction-${request.nativeRequestId}`, "Original request completed"),
            ),
          );
          const completed = yield* recovered.request("alice-session", request.requestId);
          expect(completed.outcome.status).toBe("completed");
          expect(completed.nativeRequestId).toBe(request.nativeRequestId);
          expect(completed.context).toEqual(request.context);
        }
        expect(h.sends).toHaveLength(2);

        secondReady = true;
        const continuation = yield* makeSharedCompositionService(h.store, compositionTeam);
        expect(yield* continuation.runOnce).toBe(1);
        expect((yield* h.store.specialist(h.specialist.specialistId)).assignmentVersion).toBe(
          h.specialist.assignmentVersion + 1,
        );
        const retried = yield* recovered.send("bob-session", h.inputB);
        expect(retried.outcome.status).toBe("accepted");
        expect(retried.nativeRequestId).toBe(heldRequest!.nativeRequestId);
        expect(h.sends).toHaveLength(3);
        expect((yield* recovered.send("bob-session", h.inputB)).requestId).toBe(retried.requestId);
        expect(h.sends).toHaveLength(3);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("keeps admitted work and exact retries with a superseded predecessor", () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      const admitted = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const service = yield* makeSharedSpecialistService(h.store, {
        ...h.team,
        agentSendWithAdmission: (input, admission) =>
          Effect.gen(function* () {
            const receipt = yield* h.team.agentSendWithAdmission(input, admission);
            yield* Deferred.succeed(admitted, undefined);
            yield* Deferred.await(resume);
            return receipt;
          }),
      });
      const pending = yield* service.send("alice-session", h.inputA).pipe(Effect.forkScoped);
      yield* Deferred.await(admitted);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE shared_specialists SET definition_json = ${encode({
        ...h.specialist,
        assignmentVersion: 1,
        supersededAt: timestamp,
        successorId: "future-specialist",
      })} WHERE specialist_id = ${h.specialist.specialistId}`;
      yield* Deferred.succeed(resume, undefined);
      const accepted = yield* Fiber.join(pending);
      h.receipts.set(
        accepted.nativeRequestId,
        receipt(
          accepted.nativeRequestId,
          terminal(`interaction-${accepted.nativeRequestId}`, "Original owner's result"),
        ),
      );
      const completed = yield* service.send("alice-session", h.inputA);
      expect(completed.requestId).toBe(accepted.requestId);
      expect(completed.context).toEqual(h.aliceContext);
      expect(completed.specialistId).toBe(h.specialist.specialistId);
      expect(completed.outcome.status).toBe("completed");
      expect(h.sends).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("retains native acceptance when an earlier empty observation finishes later", () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      const sendEntered = yield* Deferred.make<void>();
      const allowSend = yield* Deferred.make<void>();
      const observedEmpty = yield* Deferred.make<void>();
      const releaseObservation = yield* Deferred.make<void>();
      let holdFirstObservation = false;
      const service = yield* makeSharedSpecialistService(h.store, {
        ...h.team,
        agentSendWithAdmission: (input, admission) =>
          Effect.gen(function* () {
            holdFirstObservation = true;
            yield* Deferred.succeed(sendEntered, undefined);
            yield* Deferred.await(allowSend);
            return yield* h.team.agentSendWithAdmission(input, admission);
          }),
        agentDeliveryReconcile: (input) =>
          Effect.gen(function* () {
            const observed = yield* h.team.agentDeliveryReconcile(input);
            if (holdFirstObservation) {
              holdFirstObservation = false;
              expect(observed).toBeUndefined();
              yield* Deferred.succeed(observedEmpty, undefined);
              yield* Deferred.await(releaseObservation);
            }
            return observed;
          }),
      });
      const sending = yield* service.send("alice-session", h.inputA).pipe(Effect.forkScoped);
      yield* Deferred.await(sendEntered);
      const sql = yield* SqlClient.SqlClient;
      const claims = yield* sql<{
        request_id: string;
      }>`SELECT request_id FROM shared_specialist_requests`;
      expect(claims).toHaveLength(1);
      const observing = yield* service
        .request("alice-session", claims[0]!.request_id)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(observedEmpty);
      yield* Deferred.succeed(allowSend, undefined);
      const accepted = yield* Fiber.join(sending);
      expect(accepted.outcome.status).toBe("accepted");
      yield* Deferred.succeed(releaseObservation, undefined);
      expect((yield* Fiber.join(observing)).outcome).toEqual(accepted.outcome);
      expect(
        yield* service.contextForInteraction(
          h.specialist.specialistId,
          "native-session",
          `interaction-${accepted.nativeRequestId}`,
        ),
      ).toEqual(h.aliceContext);
      expect(h.sends).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "preserves the accepted binding across uncertain evidence and rejects replacement anchors",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture;
        const accepted = yield* h.service.send("alice-session", h.inputA);
        const original = accepted.outcome.receipt!;
        const originalOuter = original.receipt as Record<string, unknown>;
        const originalNative = originalOuter.receipt as Record<string, unknown>;
        h.receipts.set(
          accepted.nativeRequestId,
          receipt(accepted.nativeRequestId, terminal("unrelated-interaction", "Unrelated result")),
        );
        expect((yield* h.service.request("alice-session", accepted.requestId)).outcome).toEqual(
          accepted.outcome,
        );
        for (const changed of [
          { identity: "other-specialist" },
          { session_id: "other-session" },
          { interaction_id: "other-interaction" },
        ]) {
          h.receipts.set(accepted.nativeRequestId, {
            ...original,
            receipt: {
              ...originalOuter,
              ...(changed.identity ? { identity: changed.identity } : {}),
              receipt: { ...originalNative, ...changed },
            },
          });
          expect(
            (yield* h.service.request("alice-session", accepted.requestId).pipe(Effect.flip)).code,
          ).toBe("unavailable");
          expect(
            yield* h.service.contextForInteraction(
              h.specialist.specialistId,
              "native-session",
              `interaction-${accepted.nativeRequestId}`,
            ),
          ).toEqual(h.aliceContext);
        }
        h.receipts.set(
          accepted.nativeRequestId,
          receipt(accepted.nativeRequestId, {
            ...terminal(`interaction-${accepted.nativeRequestId}`, "Native failure"),
            kind: "interaction_failed",
          }),
        );
        const failed = yield* h.service.request("alice-session", accepted.requestId);
        expect(failed.outcome.status).toBe("failed");
        expect(failed.outcome.completion?.payload).toEqual({ answer: "Native failure" });
        expect(h.sends).toHaveLength(1);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "requires live native read-only policy instead of trusting the persisted project definition",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture;
        for (const [mode, live] of [
          [undefined, "live"],
          ["full-access", "live"],
          ["repository-read-only", "unloaded"],
        ] as const) {
          h.nativePolicy(mode, live);
          expect((yield* h.service.send("alice-session", h.inputA).pipe(Effect.flip)).code).toBe(
            "unavailable",
          );
        }
        expect(h.sends).toHaveLength(0);
        h.nativePolicy("repository-read-only");
        expect((yield* h.service.send("alice-session", h.inputA)).outcome.status).toBe("accepted");
        expect(h.sends).toHaveLength(1);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect(
    "binds two participants on different branches to exact outcomes through service restart",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture;
        const [a, b] = yield* Effect.all(
          [h.service.send("alice-session", h.inputA), h.service.send("bob-session", h.inputB)],
          { concurrency: 2 },
        );
        expect(h.sends).toHaveLength(2);
        expect(a.nativeRequestId).not.toBe(b.nativeRequestId);
        expect(a.author.participantId).toBe(h.alice.participantId);
        expect(b.author.participantId).toBe(h.bob.participantId);
        expect(a.context.revision.commit).toBe("a".repeat(40));
        expect(b.context.revision.commit).toBe("b".repeat(40));
        h.receipts.set(
          "peer-traffic",
          receipt("peer-traffic", terminal("interaction-peer-traffic", "peer result")),
        );
        h.receipts.set(
          "scheduled-traffic",
          receipt(
            "scheduled-traffic",
            terminal("interaction-scheduled-traffic", "scheduled result"),
          ),
        );
        h.receipts.set(
          b.nativeRequestId,
          receipt(b.nativeRequestId, terminal(`interaction-${b.nativeRequestId}`, "Bob's result")),
        );
        const restarted = yield* makeSharedSpecialistService(
          yield* makeSharedWorkspaceStore,
          h.team,
        );
        expect((yield* restarted.request("alice-session", a.requestId)).outcome.status).toBe(
          "accepted",
        );
        expect(
          (yield* restarted.request("bob-session", b.requestId)).outcome.completion?.payload,
        ).toEqual({ answer: "Bob's result" });
        h.receipts.set(
          a.nativeRequestId,
          receipt(
            a.nativeRequestId,
            terminal(`interaction-${a.nativeRequestId}`, "Alice's result"),
          ),
        );
        expect(
          (yield* restarted.request("alice-session", a.requestId)).outcome.completion?.payload,
        ).toEqual({ answer: "Alice's result" });
        expect((yield* restarted.send("alice-session", h.inputA)).requestId).toBe(a.requestId);
        expect(h.sends).toHaveLength(2);
        expect(
          (yield* restarted.conversation("alice-session", {
            specialistId: h.specialist.specialistId,
          })).requests,
        ).toHaveLength(2);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("retains the selected immutable context version when the current context changes", () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      const changed = yield* h.store.putContext(
        { kind: "participant", participantId: h.alice.participantId },
        {
          ...h.aliceContext,
          objective: "Different task",
          revision: { branch: "new-branch", commit: "c".repeat(40), applicability: "branch" },
        },
      );
      expect(changed.contextVersion).not.toBe(h.inputA.contextVersion);
      const result = yield* h.service.send("alice-session", h.inputA);
      expect(result.context.revision.commit).toBe("a".repeat(40));
      expect(result.context.objective).toBe("Change API");
      expect((yield* h.service.send("bob-session", h.inputA).pipe(Effect.flip)).code).toBe(
        "forbidden",
      );
      expect(
        (yield* h.service
          .send("alice-session", { ...h.inputA, text: "Different message" })
          .pipe(Effect.flip)).code,
      ).toBe("conflict");
      expect(h.sends).toHaveLength(1);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "does not replay after an admission transport failure or reconstruct a result from activity",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture;
        h.offline();
        const result = yield* h.service.send("alice-session", h.inputA);
        expect(result.outcome.status).toBe("unresolved");
        const restarted = yield* makeSharedSpecialistService(
          yield* makeSharedWorkspaceStore,
          h.team,
        );
        const retried = yield* restarted.send("alice-session", h.inputA);
        expect(retried.outcome.completion).toBeNull();
        expect(retried.outcome.status).toBe("unresolved");
        expect(h.sends).toHaveLength(1);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "keeps predecessor requests readable while preventing future assignment after supersession",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture;
        const existing = yield* h.service.send("alice-session", h.inputA);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE shared_specialists SET definition_json = json_set(definition_json, '$.supersededAt', ${timestamp}, '$.successorId', 'successor') WHERE specialist_id = ${h.specialist.specialistId}`;
        expect(
          (yield* h.service
            .send("alice-session", { ...h.inputA, requestId: "new-work" })
            .pipe(Effect.flip)).code,
        ).toBe("conflict");
        expect((yield* h.service.request("alice-session", existing.requestId)).requestId).toBe(
          existing.requestId,
        );
        expect(h.sends).toHaveLength(1);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it("rejects unrelated terminal evidence and completed receipts without a terminal frame", () => {
    expect(
      sharedOutcomeFromReceipt(
        "request",
        receipt("request", terminal("another-interaction", "wrong")),
        timestamp,
      ).status,
    ).toBe("unresolved");
    expect(sharedOutcomeFromReceipt("request", receipt("another-request"), timestamp).status).toBe(
      "unresolved",
    );
    const wrongSession = {
      ...terminal("interaction-request", "wrong"),
      session_id: "different-session",
    };
    expect(
      sharedOutcomeFromReceipt("request", receipt("request", wrongSession), timestamp).completion,
    ).toBeNull();
    const completed = {
      ...receipt("request"),
      receipt: {
        mobId: "native-mob",
        identity: "native-specialist",
        receipt: {
          identity: "native-specialist",
          session_id: "native-session",
          interaction_id: "interaction-request",
          status: "completed",
        },
      },
    };
    expect(sharedOutcomeFromReceipt("request", completed, timestamp).status).toBe("unresolved");
  });

  it("requires an exact native binding for sessionless completion frames", () => {
    const { session_id: _session, ...completion } = terminal("interaction-request", "Exact result");
    const unbound = receipt("request", completion);
    expect(sharedOutcomeFromReceipt("request", unbound, timestamp).status).toBe("unresolved");
    const bound = (overrides: Record<string, unknown> = {}) => ({
      ...unbound,
      receipt: {
        mobId: "native-mob",
        identity: "native-specialist",
        receipt: {
          identity: "native-specialist",
          session_id: "native-session",
          interaction_id: "interaction-request",
          status: "completed",
          completion,
          completionBinding: {
            source: "native-console-exact-interaction",
            identity: "native-specialist",
            runtimeKey: "native-runtime",
            sessionId: "native-session",
            interactionId: "interaction-request",
            frameId: completion.id,
            ...overrides,
          },
        },
      },
    });
    expect(sharedOutcomeFromReceipt("request", bound(), timestamp).status).toBe("completed");
    for (const field of [
      "source",
      "identity",
      "runtimeKey",
      "sessionId",
      "interactionId",
      "frameId",
    ])
      expect(
        sharedOutcomeFromReceipt("request", bound({ [field]: "wrong" }), timestamp).status,
      ).toBe("unresolved");
  });

  it.effect(
    "resolves native tool context from the exact pending interaction and rejects unrelated traffic",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture;
        const a = yield* h.service.send("alice-session", h.inputA);
        yield* h.service.send("bob-session", h.inputB);
        const context = yield* h.service.contextForInteraction(
          h.specialist.specialistId,
          "native-session",
          `interaction-${a.nativeRequestId}`,
        );
        expect(context).toEqual(h.aliceContext);
        for (const [session, interaction] of [
          ["other-session", `interaction-${a.nativeRequestId}`],
          ["native-session", "peer-interaction"],
          ["native-session", "scheduled-interaction"],
        ]) {
          expect(
            (yield* h.service
              .contextForInteraction(h.specialist.specialistId, session!, interaction!)
              .pipe(Effect.flip)).code,
          ).toBe("unavailable");
        }
        expect(h.sends).toHaveLength(2);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "rotates bounded correlation recovery across restart without starving old or newer claims",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture;
        h.offline();
        const old = yield* h.service.send("bob-session", { ...h.inputB, requestId: "old-0" });
        for (let index = 1; index < 100; index++)
          yield* h.service.send("bob-session", { ...h.inputB, requestId: `old-${index}` });
        const newest = yield* h.service.send("alice-session", h.inputA);
        expect(newest.outcome.status).toBe("unresolved");
        h.receipts.set(newest.nativeRequestId, receipt(newest.nativeRequestId));
        const reconciled: string[] = [];
        const team = {
          ...h.team,
          agentDeliveryReconcile: (input: MeerkatAgentSendInput) =>
            Effect.gen(function* () {
              reconciled.push(input.requestId);
              return yield* h.team.agentDeliveryReconcile(input);
            }),
        };
        const firstOwner = yield* makeSharedSpecialistService(h.store, team);
        const target = [
          h.specialist.specialistId,
          "native-session",
          `interaction-${newest.nativeRequestId}`,
        ] as const;
        const firstPass = yield* firstOwner.contextForInteraction(...target).pipe(Effect.flip);
        expect(firstPass.code).toBe("unavailable");
        expect(reconciled).toHaveLength(100);
        expect(reconciled).not.toContain(newest.nativeRequestId);

        // Arrivals cannot extend the active scan forever and prevent its next wrap.
        for (let index = 0; index < 101; index++)
          yield* h.service.send("bob-session", { ...h.inputB, requestId: `arriving-${index}` });
        h.receipts.set(old.nativeRequestId, receipt(old.nativeRequestId));
        reconciled.length = 0;
        const restarted = yield* makeSharedSpecialistService(yield* makeSharedWorkspaceStore, team);
        expect(yield* restarted.contextForInteraction(...target)).toEqual(h.aliceContext);
        expect(reconciled).toEqual([newest.nativeRequestId]);
        expect(firstPass.message).toContain("Correlation remains pending");

        reconciled.length = 0;
        expect(
          yield* restarted.contextForInteraction(
            h.specialist.specialistId,
            "native-session",
            `interaction-${old.nativeRequestId}`,
          ),
        ).toEqual(h.bobContext);
        expect(reconciled).toEqual([old.nativeRequestId]);
        expect(h.sends).toHaveLength(202);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "advances past a persistently blocked native observation after interruption and restart",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture;
        h.offline();
        const blocked = yield* h.service.send("bob-session", h.inputB);
        const target = yield* h.service.send("alice-session", h.inputA);
        h.receipts.set(target.nativeRequestId, receipt(target.nativeRequestId));
        const entered = yield* Deferred.make<void>();
        const retryObserved = yield* Deferred.make<void>();
        let retrying = false;
        const reconciled: string[] = [];
        const team = {
          ...h.team,
          agentDeliveryReconcile: (input: MeerkatAgentSendInput) =>
            Effect.gen(function* () {
              reconciled.push(input.requestId);
              if (retrying) yield* Deferred.succeed(retryObserved, undefined);
              if (input.requestId === blocked.nativeRequestId) {
                yield* Deferred.succeed(entered, undefined);
                return yield* Effect.never;
              }
              return yield* h.team.agentDeliveryReconcile(input);
            }),
        };
        const firstOwner = yield* makeSharedSpecialistService(h.store, team);
        const binding = [
          h.specialist.specialistId,
          "native-session",
          `interaction-${target.nativeRequestId}`,
        ] as const;
        const firstPass = yield* firstOwner
          .contextForInteraction(...binding)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(firstPass);
        retrying = true;
        const restarted = yield* makeSharedSpecialistService(h.store, team);
        const retry = yield* restarted.contextForInteraction(...binding).pipe(Effect.forkScoped);
        yield* Deferred.await(retryObserved);
        expect(reconciled.filter((id) => id === blocked.nativeRequestId)).toHaveLength(1);
        expect(yield* Fiber.join(retry)).toEqual(h.aliceContext);
        expect(reconciled).toEqual([blocked.nativeRequestId, target.nativeRequestId]);
        expect(h.sends).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "reserves separate recovery candidates for overlapping callbacks and revisits an interrupted lookup",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture;
        h.offline();
        const old = yield* h.service.send("bob-session", { ...h.inputB, requestId: "old-0" });
        for (let index = 1; index < 100; index++)
          yield* h.service.send("bob-session", { ...h.inputB, requestId: `old-${index}` });
        const newest = yield* h.service.send("alice-session", h.inputA);
        h.receipts.set(newest.nativeRequestId, receipt(newest.nativeRequestId));
        const entered = yield* Deferred.make<void>();
        const interruptedOwner = yield* makeSharedSpecialistService(h.store, {
          ...h.team,
          agentDeliveryReconcile: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        });
        const target = [
          h.specialist.specialistId,
          "native-session",
          `interaction-${newest.nativeRequestId}`,
        ] as const;
        const firstPage = yield* interruptedOwner
          .contextForInteraction(...target)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const reconciled: string[] = [];
        const otherOwner = yield* makeSharedSpecialistService(h.store, {
          ...h.team,
          agentDeliveryReconcile: (input) =>
            Effect.gen(function* () {
              reconciled.push(input.requestId);
              return yield* h.team.agentDeliveryReconcile(input);
            }),
        });
        expect(yield* otherOwner.contextForInteraction(...target)).toEqual(h.aliceContext);
        expect(reconciled).toHaveLength(100);
        expect(reconciled.at(-1)).toBe(newest.nativeRequestId);
        expect(reconciled).not.toContain(old.nativeRequestId);
        yield* Fiber.interrupt(firstPage);
        h.receipts.set(old.nativeRequestId, receipt(old.nativeRequestId));
        reconciled.length = 0;
        expect(
          yield* otherOwner.contextForInteraction(
            h.specialist.specialistId,
            "native-session",
            `interaction-${old.nativeRequestId}`,
          ),
        ).toEqual(h.bobContext);
        expect(reconciled).toEqual([old.nativeRequestId]);
        expect(h.sends).toHaveLength(101);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "keeps older indexed context addressable and recovers only uncorrelated admission claims",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture;
        const original = yield* h.service.send("alice-session", h.inputA);
        for (let index = 0; index < 101; index++)
          yield* h.service.send("bob-session", { ...h.inputB, requestId: `later-${index}` });
        const target = [
          h.specialist.specialistId,
          "native-session",
          `interaction-${original.nativeRequestId}`,
        ] as const;
        expect(yield* h.service.contextForInteraction(...target)).toEqual(h.aliceContext);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE shared_specialist_requests SET native_session_id = NULL, native_interaction_id = NULL WHERE request_id = ${original.requestId}`;
        expect(yield* h.service.contextForInteraction(...target)).toEqual(h.aliceContext);
        const rows = yield* sql<{
          native_session_id: string;
          native_interaction_id: string;
        }>`SELECT native_session_id, native_interaction_id FROM shared_specialist_requests WHERE request_id = ${original.requestId}`;
        expect(rows[0]).toEqual({
          native_session_id: "native-session",
          native_interaction_id: target[2],
        });
        expect(h.sends).toHaveLength(102);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("rejects ambiguous or inconsistent native correlation indexes", () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      const a = yield* h.service.send("alice-session", h.inputA);
      const b = yield* h.service.send("bob-session", h.inputB);
      const sql = yield* SqlClient.SqlClient;
      const interaction = `interaction-${a.nativeRequestId}`;
      yield* sql`UPDATE shared_specialist_requests SET native_interaction_id = ${interaction} WHERE request_id = ${b.requestId}`;
      expect(
        (yield* h.service
          .contextForInteraction(h.specialist.specialistId, "native-session", interaction)
          .pipe(Effect.flip)).code,
      ).toBe("unavailable");
      yield* sql`UPDATE shared_specialist_requests SET native_interaction_id = 'unrelated' WHERE request_id = ${a.requestId}`;
      expect(
        (yield* h.service
          .contextForInteraction(h.specialist.specialistId, "native-session", interaction)
          .pipe(Effect.flip)).code,
      ).toBe("unavailable");
      expect(h.sends).toHaveLength(2);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});

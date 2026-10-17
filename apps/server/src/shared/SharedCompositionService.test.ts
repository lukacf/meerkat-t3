import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  SharedWorkspaceError,
  type MeerkatProjectAgent,
  type MeerkatProjectAgentCreateInput,
  type MeerkatPeerConnectionSetInput,
  type MeerkatTeamError,
  type SharedCompositionInput,
  type SharedNativeTarget,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { agentFingerprint } from "../provider/meerkat/MeerkatProjectAgentStore.ts";
import { makeSharedWorkspaceStore, type SharedActor } from "./SharedWorkspaceStore.ts";
import { makeSharedCompositionService } from "./SharedCompositionService.ts";

const timestamp = "2026-10-17T00:00:00.000Z";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const instanceId = ProviderInstanceId.make("meerkat");
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* makeSharedWorkspaceStore;
  yield* store.configure({ name: "Shared workspace" });
  const alice = yield* store.join("alice", { displayName: "Alice" });
  const bob = yield* store.join("bob", { displayName: "Bob" });
  const actor: SharedActor = { kind: "participant", participantId: alice.participantId };
  const actorB: SharedActor = { kind: "participant", participantId: bob.participantId };
  const project = yield* store.registerProject({
    requestId: "project",
    name: "API",
    repository: "https://github.com/example/api",
    hostProjectId: ProjectId.make("host-api"),
  });
  const assignments = [
    {
      sharedProjectId: project.sharedProjectId,
      charter: "Own API compatibility.",
      paths: ["src"],
      tags: ["api"],
    },
  ];
  const agents = new Map<string, MeerkatProjectAgent>();
  const addNative = (target: SharedNativeTarget, label: string) => {
    const agent: MeerkatProjectAgent = {
      ...target,
      label,
      role: "api",
      instructions: "Understand API.",
      model: "openai:gpt-test",
      accessMode: "repository-read-only",
      enabled: true,
      archived: false,
      connectionStatus: "connected",
      error: null,
      agentRef: `ref-${target.agentId}`,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    agents.set(agent.agentId, agent);
    return agent;
  };
  const original = yield* store.registerSpecialist({
    requestId: "original",
    label: "API specialist",
    nativeTarget: { projectId: project.hostProjectId, instanceId, agentId: "native-api" },
    assignments,
  });
  addNative(original.nativeTarget, original.label);
  const calls = {
    create: [] as MeerkatProjectAgentCreateInput[],
    connect: [] as string[],
    revise: [] as string[],
    peer: [] as MeerkatPeerConnectionSetInput[],
  };
  const controls = {
    failCreationAck: false,
    policy: true,
    revisionApplied: true,
    peerConnected: true,
  };
  const unavailable = (): MeerkatTeamError =>
    ({
      _tag: "MeerkatTeamError",
      projectId: project.hostProjectId,
      operation: "project-agent",
      message: "Native acknowledgement unavailable",
    }) as MeerkatTeamError;
  const team = {
    projectAgentCreate: (input: MeerkatProjectAgentCreateInput) =>
      Effect.gen(function* () {
        calls.create.push(input);
        const target = {
          projectId: input.projectId,
          instanceId: input.instanceId,
          agentId: `agent-${agentFingerprint([input.projectId, input.instanceId, input.requestId])}`,
        };
        const agent = agents.get(target.agentId) ?? addNative(target, input.label);
        if (controls.failCreationAck) return yield* Effect.fail(unavailable());
        return agent;
      }),
    projectAgentLifecycle: (input: { projectId: ProjectId; agentId: string; action: string }) =>
      Effect.sync(() => {
        expect(input.action).toBe("connect");
        calls.connect.push(input.agentId);
        const agent = agents.get(input.agentId)!;
        const connected = { ...agent, connectionStatus: "connected" as const };
        agents.set(input.agentId, connected);
        return connected;
      }),
    projectAgentReviseShared: (input: {
      projectId: ProjectId;
      agentId: string;
      requestId: string;
      instructions: string;
    }) => {
      calls.revise.push(input.requestId);
      return Effect.succeed({
        applied: controls.revisionApplied,
        revisionId: `revision-${agentFingerprint([input.agentId, input.requestId])}`,
        detail: controls.revisionApplied ? null : "Waiting for native idle boundary.",
      });
    },
    peerConnectionSet: (input: MeerkatPeerConnectionSetInput) => {
      calls.peer.push(input);
      return Effect.succeed({
        endpoint: input.source,
        connections: [
          {
            edgeId: `edge-${input.requestId}`,
            source: input.source,
            target: input.target,
            desired: true,
            status: controls.peerConnected ? ("connected" as const) : ("unloaded" as const),
            error: null,
          },
        ],
      });
    },
    projectTeam: (input: { projectId: ProjectId }) =>
      Effect.succeed({
        projectId: input.projectId,
        observedAt: timestamp,
        observation: "loaded_runtimes" as const,
        providers: [
          {
            instanceId,
            label: "Meerkat",
            status: "ready" as const,
            errors: [],
            totalScopeCount: agents.size,
            unloadedScopeCount: 0,
            loadedMobCount: agents.size,
            agents: [...agents.values()]
              .filter((agent) => agent.projectId === input.projectId)
              .map((agent) => ({
                agentRef: agent.agentRef!,
                projectAgentId: agent.agentId,
                mobId: `mob-${agent.agentId}`,
                mobLabel: agent.label,
                mobKind: "project",
                scopeLabel: "Project",
                availability: "live" as const,
                observedAccessMode: controls.policy
                  ? ("repository-read-only" as const)
                  : ("full-access" as const),
                record: {
                  identity: `identity-${agent.agentId}`,
                  display_name: agent.label,
                  runtime_key: "runtime",
                  runtime_member_id: "member",
                  session_id: `session-${agent.agentId}`,
                  visibility: "addressable" as const,
                  addressable: true,
                  health: "healthy",
                  labels: {},
                },
              })),
          },
        ],
        projectAgents: [...agents.values()].filter((agent) => agent.projectId === input.projectId),
      }),
  };
  const service = yield* makeSharedCompositionService(store, team);
  const creation = (key: string) => ({
    key,
    anchorSharedProjectId: project.sharedProjectId,
    instanceId,
    label: `${key} specialist`,
    role: key,
    instructions: "Use explicit immutable repository revisions.",
    model: "openai:gpt-test",
    assignments,
  });
  const plan = (
    operationId: string,
    values: Partial<SharedCompositionInput> = {},
  ): SharedCompositionInput => ({
    operationId,
    kind: "create",
    creations: [creation("new")],
    revisions: [],
    peers: [],
    transitions: [],
    ...values,
  });
  return {
    sql,
    store,
    actor,
    actorB,
    project,
    original,
    assignments,
    agents,
    addNative,
    calls,
    controls,
    team,
    service,
    creation,
    plan,
  };
});

const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(SqlitePersistenceMemory));

describe("shared composition intent and future routing", () => {
  it.effect("continues an admitted self revision after restart and its native idle boundary", () =>
    provided(
      Effect.gen(function* () {
        const f = yield* fixture;
        const self: SharedActor = { kind: "specialist", specialistId: f.original.specialistId };
        const input = f.plan("self-revise", {
          kind: "revise",
          creations: [],
          revisions: [
            {
              specialistId: f.original.specialistId,
              expectedVersion: 1,
              instructions: "Own immutable API compatibility evidence.",
              assignments: f.assignments,
            },
          ],
        });
        f.controls.revisionApplied = false;
        const pending = yield* f.service.execute(self, input);
        expect(pending.status).toBe("pending");
        expect(pending.actor).toEqual({ kind: "specialist", id: f.original.specialistId });
        expect(
          (yield* f.service.operation(f.actor, input.operationId).pipe(Effect.flip)).code,
        ).toBe("not_found");
        // The continuation cannot turn a busy observation into an applied revision.
        expect(yield* f.service.runOnce).toBe(1);
        expect((yield* f.service.operation(self, input.operationId)).status).toBe("pending");
        expect((yield* f.store.specialist(f.original.specialistId)).assignmentVersion).toBe(1);
        expect(yield* f.sql`SELECT * FROM shared_composition_targets`).toHaveLength(1);
        f.controls.revisionApplied = true;
        const restarted = yield* makeSharedCompositionService(f.store, f.team);
        expect(yield* restarted.runOnce).toBe(1);
        const complete = yield* restarted.operation(self, input.operationId);
        expect(complete).toMatchObject({
          operationKey: pending.operationKey,
          actor: pending.actor,
          status: "completed",
        });
        expect(complete.evidence[0]).toMatchObject({
          kind: "native_revision",
          sessionId: `session-${f.original.nativeTarget.agentId}`,
        });
        expect(new Set(f.calls.revise).size).toBe(1);
        expect((yield* f.store.specialist(f.original.specialistId)).assignmentVersion).toBe(2);
        expect(yield* f.sql`SELECT * FROM shared_composition_targets`).toHaveLength(0);
        expect(yield* restarted.runOnce).toBe(0);
        expect(f.calls.revise).toHaveLength(3);
      }),
    ),
  );

  it.effect("bounds each continuation pass and retains fair progress across service restart", () =>
    provided(
      Effect.gen(function* () {
        const f = yield* fixture;
        f.controls.revisionApplied = false;
        const inputs: SharedCompositionInput[] = [];
        for (let index = 0; index < 6; index++) {
          const specialist = yield* f.store.registerSpecialist({
            requestId: `pending-${index}`,
            label: `Pending ${index}`,
            nativeTarget: { ...f.original.nativeTarget, agentId: `pending-${index}` },
            assignments: f.assignments,
          });
          f.addNative(specialist.nativeTarget, specialist.label);
          const input = f.plan(`continue-${index}`, {
            kind: "revise",
            creations: [],
            revisions: [
              {
                specialistId: specialist.specialistId,
                expectedVersion: 1,
                instructions: "Retain exact responsibility intent.",
                assignments: f.assignments,
              },
            ],
          });
          inputs.push(input);
          expect((yield* f.service.execute(f.actor, input)).status).toBe("pending");
        }
        expect(yield* f.service.runOnce).toBe(4);
        expect(f.calls.revise).toHaveLength(10);
        f.controls.revisionApplied = true;
        const restarted = yield* makeSharedCompositionService(f.store, f.team);
        expect(yield* restarted.runOnce).toBe(2);
        expect((yield* restarted.operation(f.actor, inputs[0]!.operationId)).status).toBe(
          "pending",
        );
        expect((yield* restarted.operation(f.actor, inputs[5]!.operationId)).status).toBe(
          "completed",
        );
        expect(yield* restarted.runOnce).toBe(4);
        expect(yield* restarted.runOnce).toBe(0);
        for (const input of inputs)
          expect((yield* restarted.operation(f.actor, input.operationId)).status).toBe("completed");
        expect(yield* f.sql`SELECT * FROM shared_composition_targets`).toHaveLength(0);
      }),
    ),
  );

  it.effect("a persistently slow earlier revision does not strand later native continuations", () =>
    provided(
      Effect.gen(function* () {
        const f = yield* fixture;
        const second = yield* f.store.registerSpecialist({
          requestId: "next",
          label: "Next",
          nativeTarget: { ...f.original.nativeTarget, agentId: "next" },
          assignments: f.assignments,
        });
        f.addNative(second.nativeTarget, second.label);
        const plans = [f.original, second].map((specialist, index) =>
          f.plan(`slow-${index}`, {
            kind: "revise",
            creations: [],
            revisions: [
              {
                specialistId: specialist.specialistId,
                expectedVersion: 1,
                instructions: "Continue at a native idle boundary.",
                assignments: f.assignments,
              },
            ],
          }),
        );
        f.controls.revisionApplied = false;
        for (const input of plans) yield* f.service.execute(f.actor, input);
        f.controls.revisionApplied = true;
        const entered = yield* Deferred.make<void>();
        const service = yield* makeSharedCompositionService(f.store, {
          ...f.team,
          projectAgentReviseShared: (input) =>
            input.agentId === f.original.nativeTarget.agentId
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
              : f.team.projectAgentReviseShared(input),
        });
        const pass = yield* service.runOnce.pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("16 seconds");
        expect(yield* Fiber.join(pass)).toBe(2);
        expect((yield* service.operation(f.actor, plans[0]!.operationId)).status).toBe("pending");
        expect((yield* service.operation(f.actor, plans[1]!.operationId)).status).toBe("completed");
        const restarted = yield* makeSharedCompositionService(f.store, f.team);
        expect(yield* restarted.runOnce).toBe(1);
        expect((yield* restarted.operation(f.actor, plans[0]!.operationId)).status).toBe(
          "completed",
        );
      }),
    ),
  );

  it.effect("does not create a new admission from mismatched retained actor identity", () =>
    provided(
      Effect.gen(function* () {
        const f = yield* fixture;
        f.controls.revisionApplied = false;
        const input = f.plan("retained-identity", {
          kind: "revise",
          creations: [],
          revisions: [
            {
              specialistId: f.original.specialistId,
              expectedVersion: 1,
              instructions: "Preserve admitted identity.",
              assignments: f.assignments,
            },
          ],
        });
        const pending = yield* f.service.execute(f.actor, input);
        const invalid = {
          ...pending,
          actor: {
            kind: "participant",
            id: f.actorB.kind === "participant" ? f.actorB.participantId : "invalid",
          },
        };
        yield* f.sql`UPDATE shared_composition_operations SET definition_json=${encode(invalid)} WHERE operation_key=${pending.operationKey}`;
        f.controls.revisionApplied = true;
        expect(yield* f.service.runOnce).toBe(1);
        expect(f.calls.revise).toHaveLength(1);
        expect(yield* f.sql`SELECT * FROM shared_composition_operations`).toHaveLength(1);
        expect((yield* f.store.specialist(f.original.specialistId)).assignmentVersion).toBe(1);
      }),
    ),
  );

  it.effect(
    "recovers a lost creation acknowledgement with one permanent identity and immutable retry",
    () =>
      provided(
        Effect.gen(function* () {
          const f = yield* fixture;
          const input = f.plan("create-api");
          f.controls.failCreationAck = true;
          const pending = yield* f.service.execute(f.actor, input);
          expect(pending.status).toBe("pending");
          expect(pending.creations[0]!.specialistId).toBeNull();
          expect(f.agents.size).toBe(2);
          expect((yield* f.store.snapshot("alice")).specialists).toHaveLength(1);
          expect(
            (yield* f.store
              .registerSpecialist({
                requestId: "take-pending-identity",
                nativeTarget: pending.creations[0]!.nativeTarget,
                label: "Wrong publication",
                assignments: f.assignments,
              })
              .pipe(Effect.flip)).code,
          ).toBe("conflict");
          f.controls.failCreationAck = false;
          const recoveredService = yield* makeSharedCompositionService(f.store, f.team);
          const complete = yield* recoveredService.execute(f.actor, input);
          expect(complete.status).toBe("completed");
          expect(complete.creations[0]!.nativeTarget).toEqual(pending.creations[0]!.nativeTarget);
          expect(complete.creations[0]!.specialistId).not.toBeNull();
          expect(f.calls.create.map((call) => call.requestId)[0]).toBe(
            f.calls.create[1]!.requestId,
          );
          expect(f.agents.size).toBe(2);
          expect(yield* recoveredService.execute(f.actor, input)).toEqual(complete);
          expect(f.calls.create).toHaveLength(2);
          expect(
            (yield* recoveredService
              .execute(f.actor, { ...input, creations: [f.creation("different")] })
              .pipe(Effect.flip)).code,
          ).toBe("conflict");
          expect(
            (yield* recoveredService.operation(f.actorB, input.operationId).pipe(Effect.flip)).code,
          ).toBe("not_found");
        }),
      ),
  );

  it.effect(
    "reserves pending creation capacity across ordinary registration and other operations",
    () =>
      provided(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.store.configure({
            name: "Shared workspace",
            limits: { maxSpecialists: 2, maxSnapshotBytes: 1_048_576 },
          });
          f.controls.failCreationAck = true;
          expect((yield* f.service.execute(f.actor, f.plan("first"))).status).toBe("pending");
          expect((yield* f.service.execute(f.actorB, f.plan("second"))).status).toBe("conflict");
          expect(f.calls.create).toHaveLength(1);
          expect(
            (yield* f.store
              .registerSpecialist({
                requestId: "manual",
                nativeTarget: { ...f.original.nativeTarget, agentId: "manual" },
                label: "Manual",
                assignments: f.assignments,
              })
              .pipe(Effect.flip)).code,
          ).toBe("limit_exceeded");
          expect(
            (yield* f.store
              .configure({
                name: "Shared workspace",
                limits: { maxSpecialists: 1, maxSnapshotBytes: 1_048_576 },
              })
              .pipe(Effect.flip)).code,
          ).toBe("limit_exceeded");
          f.controls.failCreationAck = false;
          expect((yield* f.service.execute(f.actor, f.plan("first"))).status).toBe("completed");
          expect(yield* f.store.specialistCapacity).toBe(2);
        }),
      ),
  );

  it.effect(
    "waits for exact native revision activation and keeps competing revisions reserved",
    () =>
      provided(
        Effect.gen(function* () {
          const f = yield* fixture;
          const input = f.plan("revise", {
            kind: "revise",
            creations: [],
            revisions: [
              {
                specialistId: f.original.specialistId,
                expectedVersion: 1,
                label: "API ownership",
                assignments: [{ ...f.assignments[0]!, paths: ["src/api"] }],
                instructions: "Use revision evidence for API changes.",
              },
            ],
          });
          f.controls.revisionApplied = false;
          const pending = yield* f.service.execute(f.actor, input);
          expect(pending.status).toBe("pending");
          expect(yield* f.store.specialist(f.original.specialistId)).toEqual(f.original);
          expect(
            (yield* f.service.execute(f.actorB, { ...input, operationId: "competing" })).status,
          ).toBe("conflict");
          expect(f.calls.revise).toHaveLength(1);
          f.controls.revisionApplied = true;
          const complete = yield* f.service.execute(f.actor, input);
          expect(complete.status).toBe("completed");
          expect(complete.evidence[0]!.kind).toBe("native_revision");
          expect(f.calls.revise[0]).toBe(f.calls.revise[1]);
          expect((yield* f.store.specialist(f.original.specialistId)).assignmentVersion).toBe(2);
          expect(
            (yield* f.store.specialist(f.original.specialistId)).assignments[0]!.paths,
          ).toEqual(["src/api"]);
          expect(yield* f.service.execute(f.actor, input)).toEqual(complete);
          expect(f.calls.revise).toHaveLength(2);
        }),
      ),
  );

  it.effect(
    "requires observed native policy and peer connectivity before publishing a new destination",
    () =>
      provided(
        Effect.gen(function* () {
          const f = yield* fixture;
          const input = f.plan("create-and-peer", {
            peers: [
              {
                source: { specialistId: f.original.specialistId, expectedVersion: 1 },
                target: { creationKey: "new" },
              },
            ],
          });
          f.controls.policy = false;
          expect((yield* f.service.execute(f.actor, input)).status).toBe("pending");
          expect(f.calls.peer).toHaveLength(0);
          f.controls.policy = true;
          f.controls.peerConnected = false;
          expect((yield* f.service.execute(f.actor, input)).status).toBe("pending");
          expect((yield* f.store.snapshot("alice")).specialists).toHaveLength(1);
          f.controls.peerConnected = true;
          const complete = yield* f.service.execute(f.actor, input);
          expect(complete.status).toBe("completed");
          expect(complete.evidence.map((entry) => entry.kind)).toEqual([
            "native_identity",
            "native_peer",
          ]);
          expect(f.calls.peer[0]!.requestId).toBe(f.calls.peer[1]!.requestId);
          expect(f.calls.peer.every((call) => call.connected)).toBe(true);
        }),
      ),
  );

  it.effect(
    "splits future routing atomically while preserving predecessors, admitted requests and evidence",
    () =>
      provided(
        Effect.gen(function* () {
          const f = yield* fixture;
          const checkout = yield* f.store.attachCheckout("alice", {
            localEnvironmentId: EnvironmentId.make("alice-local"),
            localProjectId: ProjectId.make("alice-api"),
            repository: f.project.repository,
          });
          const context = yield* f.store.putContext(f.actor, {
            contextId: "existing-work",
            checkoutId: checkout.checkoutId,
            source: { kind: "project_conversation" },
            objective: "Change existing API",
            revision: { branch: "feature", commit: "a".repeat(40), applicability: "branch" },
            paths: ["src"],
            tags: ["api"],
          });
          const evidence = {
            contextId: context.contextId,
            contextVersion: context.contextVersion,
            revision: context.revision,
            sources: [],
          };
          yield* f.store.publishActivity(f.actor, {
            ...evidence,
            eventId: "before-split",
            kind: "changes",
            summary: "Existing work",
            paths: ["src"],
            tags: ["api"],
          });
          const inbox = yield* f.store.readInbox(
            { kind: "specialist", specialistId: f.original.specialistId },
            {},
          );
          const knowledge = yield* f.store.putKnowledge(f.actor, {
            ...evidence,
            evidenceId: "known-finding",
            kind: "finding",
            title: "Compatibility",
            body: "The admitted work still belongs to the original specialist.",
            supersedes: [],
            state: "open",
          });
          const accepted = encode({ accepted: "immutable original session and interaction" });
          yield* f.sql`INSERT INTO shared_specialist_requests(request_id,participant_id,specialist_id,client_request_id,fingerprint,definition_json,native_input_json,native_session_id,native_interaction_id)
      VALUES ('admitted',${f.actor.kind === "participant" ? f.actor.participantId : ""},${f.original.specialistId},'client-admitted','fingerprint',${accepted},'{}','old-session','old-interaction')`;
          const input = f.plan("split", {
            kind: "split",
            creations: [f.creation("schema"), f.creation("transport")],
            peers: [{ source: { creationKey: "schema" }, target: { creationKey: "transport" } }],
            transitions: [
              {
                predecessorId: f.original.specialistId,
                expectedVersion: 1,
                successors: [{ creationKey: "schema" }, { creationKey: "transport" }],
                supersede: true,
              },
            ],
          });
          f.controls.peerConnected = false;
          const pending = yield* f.service.execute(f.actor, input);
          expect(pending.status).toBe("pending");
          expect(f.agents.size).toBe(3);
          expect((yield* f.store.snapshot("alice")).specialists).toEqual([f.original]);
          f.controls.peerConnected = true;
          const complete = yield* f.service.execute(f.actor, input);
          expect(complete.status).toBe("completed");
          const successors = complete.creations.map((item) => item.specialistId!);
          expect(complete.lineage).toEqual([
            { predecessorId: f.original.specialistId, successorIds: successors, superseded: true },
          ]);
          const predecessor = yield* f.store.specialist(f.original.specialistId);
          expect(predecessor.nativeTarget).toEqual(f.original.nativeTarget);
          expect(predecessor.supersededAt).not.toBeNull();
          expect(predecessor.successorId).toBeNull();
          expect(predecessor.assignmentVersion).toBe(2);
          expect(f.agents.get(f.original.nativeTarget.agentId)!.enabled).toBe(true);
          const saved = yield* f.sql<{
            specialist_id: string;
            definition_json: string;
            native_session_id: string;
            native_interaction_id: string;
          }>`SELECT specialist_id,definition_json,native_session_id,native_interaction_id FROM shared_specialist_requests WHERE request_id='admitted'`;
          expect(saved[0]).toEqual({
            specialist_id: f.original.specialistId,
            definition_json: accepted,
            native_session_id: "old-session",
            native_interaction_id: "old-interaction",
          });
          expect(
            yield* f.store.readInbox(
              { kind: "specialist", specialistId: f.original.specialistId },
              {},
            ),
          ).toEqual(inbox);
          expect((yield* f.store.searchKnowledge({})).records).toEqual([
            { ...knowledge, corrections: [], hasMoreCorrections: false },
          ]);
          const interests = yield* f.sql<{
            recipient_id: string;
          }>`SELECT DISTINCT recipient_id FROM shared_interests WHERE owner_id LIKE 'specialist:%'`;
          expect(interests.map((row) => row.recipient_id).sort()).toEqual([...successors].sort());
          for (const specialistId of successors)
            expect(
              (yield* f.store.readInbox({ kind: "specialist", specialistId }, {})).events,
            ).toEqual([]);
          expect(yield* f.sql`SELECT * FROM shared_specialist_lineage`).toHaveLength(2);
          expect(yield* f.service.execute(f.actor, input)).toEqual(complete);
          expect(yield* f.sql`SELECT * FROM shared_specialist_lineage`).toHaveLength(2);
        }),
      ),
  );

  it.effect(
    "consolidates existing responsibilities without cloning or destroying any native agent",
    () =>
      provided(
        Effect.gen(function* () {
          const f = yield* fixture;
          const second = yield* f.store.registerSpecialist({
            requestId: "second",
            nativeTarget: { ...f.original.nativeTarget, agentId: "second" },
            label: "Second",
            assignments: f.assignments,
          });
          const target = yield* f.store.registerSpecialist({
            requestId: "target",
            nativeTarget: { ...f.original.nativeTarget, agentId: "target" },
            label: "Target",
            assignments: f.assignments,
          });
          f.addNative(second.nativeTarget, second.label);
          f.addNative(target.nativeTarget, target.label);
          const input = f.plan("consolidate", {
            kind: "consolidate",
            creations: [],
            revisions: [
              {
                specialistId: target.specialistId,
                expectedVersion: 1,
                assignments: [{ ...f.assignments[0]!, charter: "Own the consolidated API scope." }],
              },
            ],
            transitions: [f.original, second].map((item) => ({
              predecessorId: item.specialistId,
              expectedVersion: 1,
              successors: [{ specialistId: target.specialistId, expectedVersion: 1 }],
              supersede: true,
            })),
          });
          expect((yield* f.service.execute(f.actor, input)).status).toBe("completed");
          expect(f.calls.create).toHaveLength(0);
          expect(f.calls.revise).toHaveLength(0);
          expect(f.calls.connect).toHaveLength(0);
          expect(f.agents.size).toBe(3);
          expect((yield* f.store.specialist(target.specialistId)).assignmentVersion).toBe(2);
          expect((yield* f.store.specialist(f.original.specialistId)).successorId).toBe(
            target.specialistId,
          );
          const stale = yield* f.service.execute(f.actor, { ...input, operationId: "stale" });
          expect(stale.status).toBe("conflict");
        }),
      ),
  );

  it.effect("rejects invalid definitions before reserving capacity or touching native agents", () =>
    provided(
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const creation of [
          { ...f.creation("bad"), role: "system" },
          { ...f.creation("bad"), assignments: [{ ...f.assignments[0]!, paths: ["../outside"] }] },
          { ...f.creation("bad"), instructions: "x".repeat(32_000) },
        ]) {
          expect(
            yield* f.service
              .execute(f.actor, f.plan("invalid", { creations: [creation] }))
              .pipe(Effect.flip),
          ).toBeInstanceOf(SharedWorkspaceError);
        }
        expect(yield* f.sql`SELECT * FROM shared_composition_operations`).toHaveLength(0);
        expect(f.calls.create).toHaveLength(0);
        expect(yield* f.store.specialistCapacity).toBe(1);
      }),
    ),
  );

  it.effect(
    "isolates operation IDs by authenticated actor and only records directory revisions as routing",
    () =>
      provided(
        Effect.gen(function* () {
          const f = yield* fixture;
          const first = yield* f.service.execute(f.actor, f.plan("same-id"));
          const second = yield* f.service.execute(f.actorB, f.plan("same-id"));
          expect(first.operationKey).not.toBe(second.operationKey);
          expect(first.creations[0]!.nativeTarget).not.toEqual(second.creations[0]!.nativeTarget);
          const revision = yield* f.service.execute(
            f.actor,
            f.plan("routing", {
              kind: "revise",
              creations: [],
              revisions: [
                {
                  specialistId: f.original.specialistId,
                  expectedVersion: 1,
                  assignments: [{ ...f.assignments[0]!, paths: ["src/api"] }],
                },
              ],
            }),
          );
          expect(revision.status).toBe("completed");
          expect(revision.evidence).toEqual([]);
          expect(f.calls.revise).toHaveLength(0);
        }),
      ),
  );
  it.effect("serializes concurrent retries so only one native creation and cutover occur", () =>
    provided(
      Effect.gen(function* () {
        const f = yield* fixture;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const service = yield* makeSharedCompositionService(f.store, {
          ...f.team,
          projectAgentCreate: (input) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return yield* f.team.projectAgentCreate(input);
            }),
        });
        const input = f.plan("overlap");
        const first = yield* service.execute(f.actor, input).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const second = yield* service.execute(f.actor, input).pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        const results = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
        expect(results[0]).toEqual(results[1]);
        expect(results[0]!.status).toBe("completed");
        expect(f.calls.create).toHaveLength(1);
        expect((yield* f.store.snapshot("alice")).specialists).toHaveLength(2);
      }),
    ),
  );

  it.effect(
    "rolls back all shared publication when the final assignment version no longer matches",
    () =>
      provided(
        Effect.gen(function* () {
          const f = yield* fixture;
          const input = f.plan("stale-cutover", {
            kind: "supersede",
            transitions: [
              {
                predecessorId: f.original.specialistId,
                expectedVersion: 1,
                successors: [{ creationKey: "new" }],
                supersede: true,
              },
            ],
          });
          const service = yield* makeSharedCompositionService(f.store, {
            ...f.team,
            projectAgentCreate: (value) =>
              Effect.gen(function* () {
                const agent = yield* f.team.projectAgentCreate(value);
                yield* f.sql`UPDATE shared_specialists SET definition_json=${encode({ ...f.original, assignmentVersion: 2 })} WHERE specialist_id=${f.original.specialistId}`.pipe(
                  Effect.orDie,
                );
                return agent;
              }),
          });
          const result = yield* service.execute(f.actor, input);
          expect(result.status).toBe("pending");
          expect(result.detail).toContain("changed");
          expect(result.creations[0]!.specialistId).toBeNull();
          expect((yield* f.store.snapshot("alice")).specialists).toHaveLength(1);
          expect(yield* f.sql`SELECT * FROM shared_specialist_lineage`).toHaveLength(0);
          expect(yield* f.store.specialistCapacity).toBe(2);
          expect(f.agents.size).toBe(2);
        }),
      ),
  );

  it.effect("rejects local delegations and disappearing successors without changing routing", () =>
    provided(
      Effect.gen(function* () {
        const f = yield* fixture;
        expect(
          (yield* f.service
            .execute(
              {
                kind: "local_agent",
                sessionId: "alice",
                delegationId: "untrusted",
                action: "projects.list",
              },
              f.plan("denied"),
            )
            .pipe(Effect.flip)).code,
        ).toBe("invalid_input");
        const input = f.plan("cycle", {
          kind: "supersede",
          creations: [],
          transitions: [
            {
              predecessorId: f.original.specialistId,
              expectedVersion: 1,
              successors: [{ specialistId: "other", expectedVersion: 1 }],
              supersede: true,
            },
            {
              predecessorId: "other",
              expectedVersion: 1,
              successors: [{ specialistId: f.original.specialistId, expectedVersion: 1 }],
              supersede: true,
            },
          ],
        });
        expect((yield* f.service.execute(f.actor, input).pipe(Effect.flip)).code).toBe(
          "invalid_input",
        );
        const chain = {
          ...input,
          operationId: "chain",
          transitions: input.transitions.map((transition, index) =>
            index === 1
              ? { ...transition, successors: [{ specialistId: "terminal", expectedVersion: 1 }] }
              : transition,
          ),
        };
        expect((yield* f.service.execute(f.actor, chain).pipe(Effect.flip)).code).toBe(
          "invalid_input",
        );
        expect(yield* f.sql`SELECT * FROM shared_composition_operations`).toHaveLength(0);
        expect(f.calls.create).toHaveLength(0);
      }),
    ),
  );
});

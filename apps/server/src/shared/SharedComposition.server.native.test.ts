// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - opt-in real host restart owns disposable processes, native agents and a loopback provider.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  AuthAdministrativeScopes,
  AuthSharedParticipantScopes,
  CommandId,
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  WS_METHODS,
  WsRpcGroup,
  type MeerkatProjectTeam,
  type SharedCompositionInput,
  type SharedSpecialistRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type { RpcClient } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { describe, expect, it } from "@effect/vitest";
import {
  availablePort,
  bounded,
  exchangeToken,
  fixtureTimeoutMs,
  ownedServer,
  prepareFixture,
  withClient,
  workflowModel,
} from "../provider/meerkat/MeerkatWorkflow.server.native.support.ts";
import {
  initializeSharedRepository,
  issueSharedPairing,
} from "./SharedSpecialist.server.native.support.ts";
import {
  compositionAnswer,
  compositionMarkers,
  controlledCompositionProvider,
  persistedComposition,
} from "./SharedComposition.server.native.support.ts";

const serverEntry = process.env.T3CODE_TEST_MEERKAT_SERVER_ENTRY;
const runtimeDirectory = process.env.T3CODE_TEST_MEERKAT_RUNTIME_DIR;
const projectId = ProjectId.make("composition-native-host-project");
const instanceId = ProviderInstanceId.make("meerkat");
const now = () => DateTime.formatIso(DateTime.nowUnsafe());
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const result = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.String }));
const nativeAnchor = Schema.decodeUnknownSync(
  Schema.Struct({
    receipt: Schema.Struct({ session_id: Schema.String, interaction_id: Schema.String }),
  }),
);
type Client = RpcClient.FromGroup<typeof WsRpcGroup, RpcClientError>;

function nativeIdentity(team: MeerkatProjectTeam, agentId: string) {
  const matches = team.providers
    .flatMap((provider) => provider.agents)
    .filter((agent) => agent.projectAgentId === agentId);
  expect(matches).toHaveLength(1);
  const native = matches[0]!;
  expect(native.record.session_id).toBeTruthy();
  return {
    mobId: native.mobId,
    identity: native.record.identity,
    sessionId: native.record.session_id,
    memberId: native.record.runtime_member_id,
  };
}
const waitCompleted = (client: Client, requestId: string) =>
  Effect.gen(function* () {
    for (;;) {
      const value = yield* client[WS_METHODS.sharedSpecialistRequest]({ requestId });
      if (value.outcome.status === "failed") throw new Error("A retained native request failed");
      if (value.outcome.status === "completed") return value;
      expect(value.outcome.completion).toBeNull();
      yield* Effect.sleep("100 millis");
    }
  }).pipe(Effect.timeout("45 seconds"));
const waitOperation = (admin: Client, operationId: string) =>
  Effect.gen(function* () {
    for (;;) {
      const value = yield* admin[WS_METHODS.sharedCompositionOperation]({ operationId });
      expect(value.status, value.detail ?? undefined).not.toBe("conflict");
      if (value.status === "completed") return value;
      yield* Effect.sleep("100 millis");
    }
  }).pipe(Effect.timeout("90 seconds"));
function assertPreserved(actual: SharedSpecialistRequest, original: SharedSpecialistRequest) {
  expect(actual.requestId).toBe(original.requestId);
  expect(actual.nativeRequestId).toBe(original.nativeRequestId);
  expect(actual.specialistId).toBe(original.specialistId);
  expect(actual.author).toEqual(original.author);
  expect(actual.context).toEqual(original.context);
  expect(actual.outcome.status).toBe("completed");
  expect(actual.outcome.receipt).toEqual(original.outcome.receipt);
  expect(actual.outcome.completion).toEqual(original.outcome.completion);
}

describe.skipIf(!serverEntry || !runtimeDirectory)(
  "actual pending composition host restart",
  () => {
    it.live(
      "reconciles a pending split after restart and consolidates future work without moving admitted requests",
      () =>
        Effect.gen(function* () {
          if (!serverEntry || !runtimeDirectory)
            throw new Error("Supply exact server and native runtime paths");
          expect(NodePath.isAbsolute(serverEntry) && NodePath.isAbsolute(runtimeDirectory)).toBe(
            true,
          );
          const root = yield* Effect.promise(async () =>
            NodeFSP.realpath(
              await NodeFSP.mkdtemp(
                NodePath.join(NodeOS.tmpdir(), "t3-native-composition-restart-"),
              ),
            ),
          );
          yield* Effect.promise(() => NodeFSP.chmod(root, 0o700));
          const fixture = controlledCompositionProvider();
          let server: ReturnType<typeof ownedServer> | undefined;
          const evidence: Record<string, unknown> = {
            phase: "setup",
            serverEntrySha256: yield* Effect.promise(async () =>
              NodeCrypto.createHash("sha256")
                .update(await NodeFSP.readFile(serverEntry))
                .digest("hex"),
            ),
          };
          yield* Effect.addFinalizer((exit) =>
            Effect.promise(async () => {
              fixture.releaseAll();
              let cleanupComplete = false;
              try {
                await server?.close();
                cleanupComplete = true;
              } finally {
                if (cleanupComplete) {
                  fixture.provider.closeAllConnections();
                  if (fixture.provider.listening)
                    await new Promise<void>((resolve, reject) =>
                      fixture.provider.close((error) => (error ? reject(error) : resolve())),
                    );
                }
                const directory = NodePath.join(root, "evidence");
                await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
                await NodeFSP.writeFile(
                  NodePath.join(directory, "shared-composition-acceptance.json"),
                  encode({
                    ...evidence,
                    passed: Exit.isSuccess(exit) && cleanupComplete,
                    cleanupComplete,
                    providerErrors: fixture.errors,
                    providerCounts: fixture.counts,
                    canceledControlRequests: fixture.canceled.blocker,
                  }),
                  { mode: 0o600 },
                );
              }
            }).pipe(
              Effect.ensuring(Effect.logInfo(`Shared composition evidence retained at ${root}`)),
            ),
          );
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                fixture.provider.once("error", reject);
                fixture.provider.listen(0, "127.0.0.1", resolve);
              }),
          );
          const address = fixture.provider.address();
          if (!address || typeof address === "string")
            throw new Error("No controlled provider port");
          const prepared = yield* Effect.promise(() =>
            prepareFixture(root, runtimeDirectory, address.port),
          ).pipe(Effect.uninterruptible);
          const revisions = yield* Effect.promise(() =>
            initializeSharedRepository(prepared.projectPath, prepared.env),
          );
          evidence.manifest = prepared.manifest;
          const port = yield* Effect.promise(availablePort);
          const origin = `http://127.0.0.1:${port}`;
          const start = (name: string) => {
            server = ownedServer(
              serverEntry,
              prepared.projectPath,
              prepared.baseDir,
              port,
              prepared.env,
              prepared.shutdownHorizonMs,
              NodePath.join(prepared.evidenceRoot, name),
            );
            return Effect.promise(() =>
              bounded(server!.ready, "composition host readiness", 60_000),
            );
          };
          const adminBearer = yield* exchangeToken(
            origin,
            yield* start("before-restart.json"),
            AuthAdministrativeScopes.join(" "),
          );
          const beforePid = server!.child.pid;
          const aliceBearer = yield* exchangeToken(
            origin,
            yield* issueSharedPairing(origin, adminBearer, "Composition participant"),
            AuthSharedParticipantScopes.join(" "),
          );
          const retained = yield* withClient(origin, adminBearer, (admin) =>
            Effect.gen(function* () {
              yield* admin[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "project.create",
                commandId: CommandId.make("composition-create-project"),
                projectId,
                title: "Composition API",
                workspaceRoot: prepared.projectPath,
                createdAt: now(),
              });
              yield* admin[WS_METHODS.sharedWorkspaceConfigure]({ name: "Composition workspace" });
              const owner = yield* admin[WS_METHODS.sharedWorkspaceJoin]({
                displayName: "Composition administrator",
              });
              const project = yield* admin[WS_METHODS.sharedProjectRegister]({
                requestId: "composition-project",
                name: "API",
                repository: "https://github.com/example/shared-api",
                hostProjectId: projectId,
              });
              const assignments = [
                {
                  sharedProjectId: project.sharedProjectId,
                  charter: "Own immutable API compatibility.",
                  paths: ["src"],
                  tags: ["api"],
                },
              ];
              const create = (name: string) =>
                admin[WS_METHODS.meerkatProjectAgentCreate]({
                  projectId,
                  instanceId,
                  requestId: `composition-${name}`,
                  label: name,
                  role: `composition-${name}`,
                  instructions:
                    "Answer each exact request independently using its immutable revision.",
                  model: workflowModel,
                  accessMode: "repository-read-only",
                });
              const originalAgent = yield* create("original");
              const successorAgent = yield* create("transport");
              for (const agent of [originalAgent, successorAgent]) {
                expect(agent.connectionStatus, agent.error ?? undefined).toBe("connected");
                expect(agent.agentRef).toBeTruthy();
              }
              const register = (agent: typeof originalAgent) =>
                admin[WS_METHODS.sharedSpecialistRegister]({
                  requestId: `register-${agent.agentId}`,
                  label: agent.label,
                  nativeTarget: { projectId, instanceId, agentId: agent.agentId },
                  assignments,
                });
              const original = yield* register(originalAgent);
              const successor = yield* register(successorAgent);
              const before = yield* admin[WS_METHODS.meerkatProjectTeam]({ projectId });
              const originalIdentity = nativeIdentity(before, originalAgent.agentId);
              const successorIdentity = nativeIdentity(before, successorAgent.agentId);
              return yield* withClient(origin, aliceBearer, (alice) =>
                Effect.gen(function* () {
                  const participant = yield* alice[WS_METHODS.sharedWorkspaceJoin]({
                    displayName: "Alice",
                  });
                  const checkout = yield* alice[WS_METHODS.sharedCheckoutAttach]({
                    localEnvironmentId: EnvironmentId.make("composition-alice-local"),
                    localProjectId: ProjectId.make("composition-alice-project"),
                    repository: project.repository,
                  });
                  const context = yield* alice[WS_METHODS.sharedWorkContextPut]({
                    contextId: "composition-alice-task",
                    checkoutId: checkout.checkoutId,
                    source: { kind: "project_conversation" },
                    objective: "Preserve API review through responsibility changes",
                    revision: {
                      branch: revisions.alice.branch,
                      commit: revisions.alice.commit,
                      applicability: "branch",
                    },
                    paths: ["src/api.ts"],
                    tags: ["api"],
                  });
                  const originalInput = {
                    specialistId: original.specialistId,
                    requestId: "original-before-split",
                    contextId: context.contextId,
                    contextVersion: context.contextVersion,
                    text: compositionMarkers.original,
                  };
                  const admitted = yield* alice[WS_METHODS.sharedSpecialistSend](originalInput);
                  yield* Effect.promise(() =>
                    bounded(fixture.entered("original"), "original native admission"),
                  );
                  yield* admin[WS_METHODS.meerkatAgentSend]({
                    projectId,
                    instanceId,
                    agentRef: successorAgent.agentRef!,
                    requestId: "native-revision-control",
                    text: compositionMarkers.blocker,
                    handlingMode: "queue",
                  });
                  yield* Effect.promise(() =>
                    bounded(fixture.entered("blocker"), "native revision blocker"),
                  );
                  const split: SharedCompositionInput = {
                    operationId: "durable-split",
                    kind: "split",
                    creations: [
                      {
                        key: "schema",
                        anchorSharedProjectId: project.sharedProjectId,
                        instanceId,
                        label: "Schema",
                        role: "composition-schema",
                        model: workflowModel,
                        instructions:
                          "Own schema compatibility using retained evidence references.",
                        assignments: [
                          {
                            ...assignments[0]!,
                            charter: "Own schema changes.",
                            paths: ["src/schema"],
                          },
                        ],
                      },
                    ],
                    revisions: [
                      {
                        specialistId: successor.specialistId,
                        expectedVersion: successor.assignmentVersion,
                        instructions:
                          "Own transport compatibility using retained evidence references.",
                        assignments: [
                          {
                            ...assignments[0]!,
                            charter: "Own transport changes.",
                            paths: ["src/api.ts"],
                          },
                        ],
                      },
                    ],
                    peers: [],
                    transitions: [
                      {
                        predecessorId: original.specialistId,
                        expectedVersion: original.assignmentVersion,
                        successors: [
                          {
                            specialistId: successor.specialistId,
                            expectedVersion: successor.assignmentVersion,
                          },
                          { creationKey: "schema" },
                        ],
                        supersede: true,
                      },
                    ],
                  };
                  const pending = yield* admin[WS_METHODS.sharedCompositionExecute](split);
                  expect(pending.status, pending.detail ?? undefined).toBe("pending");
                  expect(pending.actor).toEqual({ kind: "participant", id: owner.participantId });
                  expect(pending.creations).toHaveLength(1);
                  expect(pending.creations[0]!.specialistId).toBeNull();
                  expect(pending.evidence.map((entry) => entry.kind)).toEqual(["native_identity"]);
                  const nativeCreated = pending.creations[0]!.nativeTarget;
                  const during = yield* admin[WS_METHODS.meerkatProjectTeam]({ projectId });
                  expect(during.projectAgents).toHaveLength(3);
                  const createdIdentity = nativeIdentity(during, nativeCreated.agentId);
                  expect(createdIdentity.mobId).not.toBe(originalIdentity.mobId);
                  expect(createdIdentity.mobId).not.toBe(successorIdentity.mobId);
                  expect(
                    (yield* admin[WS_METHODS.sharedWorkspaceSession]({})).snapshot.specialists,
                  ).toHaveLength(2);
                  expect(
                    (yield* alice[WS_METHODS.sharedSpecialistRequest]({
                      requestId: admitted.requestId,
                    })).outcome.completion,
                  ).toBeNull();
                  fixture.release("original");
                  const completedOriginal = yield* waitCompleted(alice, admitted.requestId);
                  expect(result(completedOriginal.outcome.completion?.payload).result).toBe(
                    compositionAnswer("original"),
                  );
                  expect(
                    nativeAnchor(completedOriginal.outcome.receipt?.receipt).receipt.session_id,
                  ).toBe(originalIdentity.sessionId);
                  expect(completedOriginal.author.participantId).toBe(participant.participantId);
                  expect(completedOriginal.context).toEqual(context);
                  const stillPending = yield* admin[WS_METHODS.sharedCompositionOperation]({
                    operationId: split.operationId,
                  });
                  expect(stillPending.status).toBe("pending");
                  expect(stillPending.operationKey).toBe(pending.operationKey);
                  evidence.phase = "split-pending-with-created-native-successor";
                  evidence.before = {
                    pending: stillPending,
                    originalIdentity,
                    successorIdentity,
                    createdIdentity,
                    completedOriginal,
                  };
                  return {
                    split,
                    pending,
                    project,
                    assignments,
                    original,
                    successor,
                    originalAgent,
                    successorAgent,
                    originalIdentity,
                    successorIdentity,
                    createdIdentity,
                    nativeCreated,
                    context,
                    originalInput,
                    completedOriginal,
                  };
                }),
              );
            }),
          );
          // Product work is already completed. Only the unrelated control turn is held
          // across orderly shutdown; the durable composition itself remains pending.
          const stopped = yield* Effect.promise(() => server!.close());
          expect(stopped.signal).toBeNull();
          expect([0, 130]).toContain(stopped.code);
          yield* Effect.promise(() =>
            bounded(fixture.canceledRequest("blocker"), "owned control request cancellation"),
          );
          expect(fixture.canceled.blocker).toBe(1);
          // Native cancellation can race the final continuation tick during shutdown.
          // Only the actual persisted pending state proves recovery after restart.
          const offline = persistedComposition(
            NodePath.join(prepared.baseDir, "userdata", "state.sqlite"),
            retained.pending.operationKey,
          );
          expect(offline.status).toBe("pending");
          expect(offline.operationKey).toBe(retained.pending.operationKey);
          expect(offline.actor).toEqual(retained.pending.actor);
          expect(offline.creations[0]!.nativeTarget).toEqual(retained.nativeCreated);
          expect(offline.creations[0]!.specialistId).toBeNull();
          expect(offline.evidence.map((entry) => entry.kind)).toEqual(["native_identity"]);
          evidence.offline = {
            operation: offline,
            canceledControlRequests: fixture.canceled.blocker,
          };
          fixture.release("blocker");
          evidence.phase = "host-stopped-with-pending-composition";
          yield* start("after-restart.json");
          expect(server!.child.pid).not.toBe(beforePid);
          yield* withClient(origin, adminBearer, (admin) =>
            Effect.gen(function* () {
              const observed = yield* admin[WS_METHODS.sharedCompositionOperation]({
                operationId: retained.split.operationId,
              });
              expect(observed.operationKey).toBe(retained.pending.operationKey);
              expect(observed.actor).toEqual(retained.pending.actor);
              expect(observed.creations[0]!.nativeTarget).toEqual(retained.nativeCreated);
              // Reconnect exact existing native owners. This does not replay composition.
              for (const agentId of [
                retained.originalAgent.agentId,
                retained.successorAgent.agentId,
                retained.nativeCreated.agentId,
              ]) {
                const connected = yield* admin[WS_METHODS.meerkatProjectAgentLifecycle]({
                  projectId,
                  agentId,
                  action: "connect",
                });
                expect(connected.connectionStatus, connected.error ?? undefined).toBe("connected");
              }
              const split = yield* waitOperation(admin, retained.split.operationId);
              expect(split.operationKey).toBe(retained.pending.operationKey);
              expect(split.actor).toEqual(retained.pending.actor);
              expect(split.evidence.map((entry) => entry.kind)).toEqual([
                "native_identity",
                "native_revision",
              ]);
              expect(split.creations[0]!.nativeTarget).toEqual(retained.nativeCreated);
              expect(split.creations[0]!.specialistId).toBeTruthy();
              const after = yield* admin[WS_METHODS.meerkatProjectTeam]({ projectId });
              expect(after.projectAgents).toHaveLength(3);
              expect(nativeIdentity(after, retained.originalAgent.agentId)).toEqual(
                retained.originalIdentity,
              );
              expect(nativeIdentity(after, retained.successorAgent.agentId)).toEqual(
                retained.successorIdentity,
              );
              expect(nativeIdentity(after, retained.nativeCreated.agentId)).toEqual(
                retained.createdIdentity,
              );
              const state = (yield* admin[WS_METHODS.sharedWorkspaceSession]({})).snapshot;
              const old = state.specialists.find(
                (entry) => entry.specialistId === retained.original.specialistId,
              )!;
              const transport = state.specialists.find(
                (entry) => entry.specialistId === retained.successor.specialistId,
              )!;
              const schema = state.specialists.find(
                (entry) => entry.specialistId === split.creations[0]!.specialistId,
              )!;
              expect(old.supersededAt).not.toBeNull();
              expect(old.assignmentVersion).toBe(retained.original.assignmentVersion + 1);
              expect(transport.assignmentVersion).toBe(retained.successor.assignmentVersion + 1);
              expect(
                after.projectAgents.find((entry) => entry.agentId === old.nativeTarget.agentId),
              ).toMatchObject({ enabled: true, archived: false });
              const coverage = yield* admin[WS_METHODS.sharedSpecialistDiscover]({
                sharedProjectId: retained.project.sharedProjectId,
              });
              expect(coverage.items.map((entry) => entry.specialistId).sort()).toEqual(
                [transport.specialistId, schema.specialistId].sort(),
              );
              yield* withClient(origin, aliceBearer, (alice) =>
                Effect.gen(function* () {
                  assertPreserved(
                    yield* alice[WS_METHODS.sharedSpecialistRequest]({
                      requestId: retained.completedOriginal.requestId,
                    }),
                    retained.completedOriginal,
                  );
                  assertPreserved(
                    yield* alice[WS_METHODS.sharedSpecialistSend](retained.originalInput),
                    retained.completedOriginal,
                  );
                  expect(
                    (yield* alice[WS_METHODS.sharedSpecialistSend]({
                      ...retained.originalInput,
                      requestId: "new-after-split",
                    }).pipe(Effect.flip))._tag,
                  ).toBe("SharedWorkspaceError");
                  const successorInput = {
                    ...retained.originalInput,
                    specialistId: transport.specialistId,
                    requestId: "admitted-before-consolidation",
                    text: compositionMarkers.successor,
                  };
                  const admitted = yield* alice[WS_METHODS.sharedSpecialistSend](successorInput);
                  yield* Effect.promise(() =>
                    bounded(fixture.entered("successor"), "successor native admission"),
                  );
                  const accepted = yield* alice[WS_METHODS.sharedSpecialistRequest]({
                    requestId: admitted.requestId,
                  });
                  const binding = nativeAnchor(accepted.outcome.receipt?.receipt).receipt;
                  expect(binding.session_id).toBe(retained.successorIdentity.sessionId);
                  expect(accepted.outcome.completion).toBeNull();
                  const consolidate: SharedCompositionInput = {
                    operationId: "consolidate-successors",
                    kind: "consolidate",
                    creations: [
                      {
                        key: "integrator",
                        anchorSharedProjectId: retained.project.sharedProjectId,
                        instanceId,
                        label: "Integration",
                        role: "composition-integration",
                        model: workflowModel,
                        instructions:
                          "Own future integration work. Cite retained predecessor evidence; do not assume their pending work was transferred.",
                        assignments: retained.assignments,
                      },
                    ],
                    revisions: [],
                    peers: [],
                    transitions: [transport, schema].map((entry) => ({
                      predecessorId: entry.specialistId,
                      expectedVersion: entry.assignmentVersion,
                      successors: [{ creationKey: "integrator" }],
                      supersede: true,
                    })),
                  };
                  const submitted = yield* admin[WS_METHODS.sharedCompositionExecute](consolidate);
                  expect(submitted.status).not.toBe("conflict");
                  const completed = yield* waitOperation(admin, consolidate.operationId);
                  expect(completed.evidence.map((entry) => entry.kind)).toEqual([
                    "native_identity",
                  ]);
                  expect(completed.lineage).toHaveLength(2);
                  const integratedId = completed.creations[0]!.specialistId!;
                  expect(
                    completed.lineage.every(
                      (entry) =>
                        entry.superseded &&
                        entry.successorIds.length === 1 &&
                        entry.successorIds[0] === integratedId,
                    ),
                  ).toBe(true);
                  const stillAdmitted = yield* alice[WS_METHODS.sharedSpecialistRequest]({
                    requestId: accepted.requestId,
                  });
                  expect(nativeAnchor(stillAdmitted.outcome.receipt?.receipt).receipt).toEqual(
                    binding,
                  );
                  expect(stillAdmitted.outcome.completion).toBeNull();
                  expect(
                    (yield* alice[WS_METHODS.sharedSpecialistSend]({
                      ...successorInput,
                      requestId: "new-after-consolidation",
                    }).pipe(Effect.flip))._tag,
                  ).toBe("SharedWorkspaceError");
                  expect(
                    (yield* alice[WS_METHODS.sharedSpecialistSend](successorInput)).requestId,
                  ).toBe(accepted.requestId);
                  fixture.release("successor");
                  const originalSuccessorResult = yield* waitCompleted(alice, accepted.requestId);
                  expect(result(originalSuccessorResult.outcome.completion?.payload).result).toBe(
                    compositionAnswer("successor"),
                  );
                  expect(
                    nativeAnchor(originalSuccessorResult.outcome.receipt?.receipt).receipt,
                  ).toEqual(binding);
                  expect(originalSuccessorResult.specialistId).toBe(transport.specialistId);
                  expect(originalSuccessorResult.context).toEqual(retained.context);
                  const latest = (yield* admin[WS_METHODS.sharedWorkspaceSession]({})).snapshot;
                  const integration = latest.specialists.find(
                    (entry) => entry.specialistId === integratedId,
                  )!;
                  const native = yield* admin[WS_METHODS.meerkatProjectTeam]({ projectId });
                  expect(native.projectAgents).toHaveLength(4);
                  expect(new Set(native.projectAgents.map((entry) => entry.agentId)).size).toBe(4);
                  for (const entry of native.projectAgents)
                    expect(entry).toMatchObject({ enabled: true, archived: false });
                  expect(nativeIdentity(native, retained.originalAgent.agentId)).toEqual(
                    retained.originalIdentity,
                  );
                  expect(nativeIdentity(native, retained.successorAgent.agentId)).toEqual(
                    retained.successorIdentity,
                  );
                  expect(nativeIdentity(native, retained.nativeCreated.agentId)).toEqual(
                    retained.createdIdentity,
                  );
                  const integratedIdentity = nativeIdentity(
                    native,
                    integration.nativeTarget.agentId,
                  );
                  expect([
                    retained.originalIdentity.mobId,
                    retained.successorIdentity.mobId,
                    retained.createdIdentity.mobId,
                  ]).not.toContain(integratedIdentity.mobId);
                  const routed = yield* alice[WS_METHODS.sharedSpecialistDiscover]({
                    sharedProjectId: retained.project.sharedProjectId,
                  });
                  expect(routed.items.map((entry) => entry.specialistId)).toEqual([
                    integration.specialistId,
                  ]);
                  fixture.release("final");
                  const future = yield* alice[WS_METHODS.sharedSpecialistSend]({
                    ...retained.originalInput,
                    specialistId: integration.specialistId,
                    requestId: "future-consolidated-work",
                    text: compositionMarkers.final,
                  });
                  const futureResult = yield* waitCompleted(alice, future.requestId);
                  expect(result(futureResult.outcome.completion?.payload).result).toBe(
                    compositionAnswer("final"),
                  );
                  expect(
                    nativeAnchor(futureResult.outcome.receipt?.receipt).receipt.session_id,
                  ).toBe(integratedIdentity.sessionId);
                  assertPreserved(
                    yield* alice[WS_METHODS.sharedSpecialistRequest]({
                      requestId: retained.completedOriginal.requestId,
                    }),
                    retained.completedOriginal,
                  );
                  expect(yield* admin[WS_METHODS.sharedCompositionExecute](retained.split)).toEqual(
                    split,
                  );
                  expect(yield* admin[WS_METHODS.sharedCompositionExecute](consolidate)).toEqual(
                    completed,
                  );
                  expect(
                    (yield* admin[WS_METHODS.meerkatProjectTeam]({ projectId })).projectAgents,
                  ).toHaveLength(4);
                  evidence.after = {
                    split,
                    consolidation: completed,
                    originalSuccessorResult,
                    futureResult,
                    integratedIdentity,
                  };
                }),
              );
            }),
          );
          expect(fixture.errors).toEqual([]);
          expect(fixture.counts.original).toBe(1);
          expect(fixture.counts.successor).toBe(1);
          expect(fixture.counts.final).toBe(1);
          evidence.phase = "complete";
          evidence.restartScope =
            "pending composition and retained completed product request; unrelated control turn canceled by orderly shutdown";
          evidence.proofs = [
            "actual-owned-host-restart",
            "durable-pending-split",
            "same-operation-and-native-creation",
            "background-native-revision-continuation",
            "same-predecessor-session-and-result",
            "future-routing-split",
            "native-consolidation-to-new-independent-specialist",
            "admitted-predecessor-completes-after-cutover",
            "no-native-retirement",
            "exact-idempotent-operation-retry",
            "no-duplicate-native-creation",
          ];
        }).pipe(Effect.timeout(fixtureTimeoutMs(360_000, 1, false)), Effect.scoped),
      fixtureTimeoutMs(360_000, 2) + 10_000,
    );
  },
);

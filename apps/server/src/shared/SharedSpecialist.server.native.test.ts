// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - opt-in real WebSocket/native acceptance owns disposable processes and loopback fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
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
  answers,
  controlledSharedProvider,
  initializeSharedRepository,
  issueSharedPairing,
  markers,
} from "./SharedSpecialist.server.native.support.ts";
import { exerciseLivePeerIsolation } from "./SharedSpecialist.server.native.peer.ts";

const serverEntry = process.env.T3CODE_TEST_MEERKAT_SERVER_ENTRY;
const runtimeDirectory = process.env.T3CODE_TEST_MEERKAT_RUNTIME_DIR;
const instanceId = ProviderInstanceId.make("meerkat");
const projectId = ProjectId.make("shared-specialist-host-project");
const now = () => DateTime.formatIso(DateTime.nowUnsafe());
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeResult = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.String }));
type Client = RpcClient.FromGroup<typeof WsRpcGroup, RpcClientError>;

const waitCompleted = (client: Client, requestId: string) =>
  Effect.gen(function* () {
    for (;;) {
      const request = yield* client[WS_METHODS.sharedSpecialistRequest]({ requestId });
      if (request.outcome.status === "failed") throw new Error("The controlled native turn failed");
      if (request.outcome.status === "completed") return request;
      expect(request.outcome.completion).toBeNull();
      yield* Effect.sleep("100 millis");
    }
  }).pipe(Effect.timeout("30 seconds"));

function assertExact(
  request: SharedSpecialistRequest,
  answer: string,
  commit: string,
  authorId: string,
) {
  expect(request.outcome.status).toBe("completed");
  expect(request.outcome.receipt?.requestId).toBe(request.nativeRequestId);
  expect(decodeResult(request.outcome.completion?.payload).result).toBe(answer);
  expect(request.context.revision.commit).toBe(commit);
  expect(request.author.participantId).toBe(authorId);
}

function nativeIdentity(team: MeerkatProjectTeam, agentRef: string) {
  const agents = team.providers
    .flatMap((provider) => provider.agents)
    .filter((agent) => agent.agentRef === agentRef);
  expect(agents).toHaveLength(1);
  const agent = agents[0]!;
  return {
    mobId: agent.mobId,
    identity: agent.record.identity,
    runtimeKey: agent.record.runtime_key,
    memberId: agent.record.runtime_member_id,
    sessionId: agent.record.session_id,
  };
}

describe.skipIf(!serverEntry || !runtimeDirectory)(
  "actual shared specialist two-client custody",
  () => {
    it.live(
      "keeps participant revisions, completed native results, and offline inbox batches through a server restart",
      () =>
        Effect.gen(function* () {
          if (!serverEntry || !runtimeDirectory)
            throw new Error("Supply the immutable server entry and packaged runtime directory");
          expect(NodePath.isAbsolute(serverEntry) && NodePath.isAbsolute(runtimeDirectory)).toBe(
            true,
          );
          const root = yield* Effect.promise(async () =>
            NodeFSP.realpath(
              await NodeFSP.mkdtemp(
                NodePath.join(NodeOS.tmpdir(), "t3-native-shared-specialists-"),
              ),
            ),
          );
          yield* Effect.promise(() => NodeFSP.chmod(root, 0o700));
          const fixture = controlledSharedProvider();
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
              let cleanupComplete = false;
              for (const barrier of fixture.release) barrier.resolve();
              fixture.peer.release.resolve();
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
                  NodePath.join(directory, "shared-specialist-acceptance.json"),
                  encode({
                    ...evidence,
                    passed: Exit.isSuccess(exit) && cleanupComplete,
                    cleanupComplete,
                    nativeTurnCount:
                      fixture.requests.length +
                      Object.keys(fixture.peer.observation().counts).length,
                    providerRequestCount: fixture.inferenceCount(),
                    repositoryReadVerified: fixture.repositoryReadVerified(),
                    providerErrors: fixture.errors,
                  }),
                  { mode: 0o600 },
                );
              }
            }).pipe(
              Effect.ensuring(Effect.logInfo(`Shared specialist evidence retained at ${root}`)),
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
          evidence.revisions = { alice: revisions.alice.commit, bob: revisions.bob.commit };
          const port = yield* Effect.promise(availablePort);
          const origin = `http://127.0.0.1:${port}`;
          const start = (diagnostic: string) => {
            server = ownedServer(
              serverEntry,
              prepared.projectPath,
              prepared.baseDir,
              port,
              prepared.env,
              prepared.shutdownHorizonMs,
              NodePath.join(prepared.evidenceRoot, diagnostic),
            );
            return Effect.promise(() => bounded(server!.ready, "shared server readiness", 60_000));
          };
          const adminBearer = yield* exchangeToken(
            origin,
            yield* start("server-before-restart.json"),
            AuthAdministrativeScopes.join(" "),
          );
          const aliceBearer = yield* exchangeToken(
            origin,
            yield* issueSharedPairing(origin, adminBearer, "Alice fixture"),
            AuthSharedParticipantScopes.join(" "),
          );
          const bobBearer = yield* exchangeToken(
            origin,
            yield* issueSharedPairing(origin, adminBearer, "Bob fixture"),
            AuthSharedParticipantScopes.join(" "),
          );
          const retained = yield* withClient(origin, adminBearer, (admin) =>
            Effect.gen(function* () {
              yield* admin[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "project.create",
                commandId: CommandId.make("shared-create-host-project"),
                projectId,
                title: "Shared API",
                workspaceRoot: prepared.projectPath,
                createdAt: now(),
              });
              const created = yield* admin[WS_METHODS.meerkatProjectAgentCreate]({
                projectId,
                instanceId,
                requestId: "shared-create-native",
                label: "API specialist",
                role: "api-specialist",
                instructions:
                  "Understand API compatibility across explicit repository revisions. Reply to each request independently.",
                accessMode: "repository-read-only",
                model: workflowModel,
              });
              expect(created.connectionStatus, created.error ?? undefined).toBe("connected");
              expect(created.agentRef).toBeTruthy();
              const agentRef = created.agentRef!;
              const identity = nativeIdentity(
                yield* admin[WS_METHODS.meerkatProjectTeam]({ projectId }),
                agentRef,
              );
              yield* admin[WS_METHODS.sharedWorkspaceConfigure]({
                name: "Shared fixture workspace",
              });
              const project = yield* admin[WS_METHODS.sharedProjectRegister]({
                requestId: "shared-register-project",
                name: "API",
                repository: "https://github.com/example/shared-api",
                hostProjectId: projectId,
              });
              fixture.setRepository(project.sharedProjectId, revisions.alice.commit);
              const specialist = yield* admin[WS_METHODS.sharedSpecialistRegister]({
                requestId: "shared-register-specialist",
                label: "API specialist",
                nativeTarget: { projectId, instanceId, agentId: created.agentId },
                assignments: [
                  {
                    sharedProjectId: project.sharedProjectId,
                    charter: "Review API compatibility.",
                    paths: ["src/api.ts"],
                    tags: ["api"],
                  },
                ],
              });
              evidence.phase = "two-authenticated-clients";
              return yield* withClient(origin, aliceBearer, (alice) =>
                Effect.gen(function* () {
                  const aliceParticipant = yield* alice[WS_METHODS.sharedWorkspaceJoin]({
                    displayName: "Alice",
                  });
                  const aliceSession = yield* alice[WS_METHODS.sharedWorkspaceSession]({});
                  expect(aliceSession.permissions).toEqual({
                    read: true,
                    contribute: true,
                    admin: false,
                  });
                  expect(aliceSession.snapshot.participant?.participantId).toBe(
                    aliceParticipant.participantId,
                  );
                  expect(
                    (yield* alice[WS_METHODS.serverGetConfig]({}).pipe(Effect.flip))._tag,
                  ).toBe("EnvironmentAuthorizationError");
                  expect(
                    (yield* alice[WS_METHODS.sharedCheckoutRevision]({ projectId }).pipe(
                      Effect.flip,
                    ))._tag,
                  ).toBe("EnvironmentAuthorizationError");
                  expect(
                    (yield* alice[WS_METHODS.sharedWorkspaceConfigure]({
                      name: "Unauthorized",
                    }).pipe(Effect.flip))._tag,
                  ).toBe("EnvironmentAuthorizationError");
                  expect(
                    (yield* alice[WS_METHODS.meerkatAgentSend]({
                      projectId,
                      instanceId,
                      agentRef,
                      requestId: "forbidden-native-send",
                      text: "Forbidden",
                      handlingMode: "queue",
                    }).pipe(Effect.flip))._tag,
                  ).toBe("EnvironmentAuthorizationError");
                  const aliceCheckout = yield* alice[WS_METHODS.sharedCheckoutAttach]({
                    localEnvironmentId: EnvironmentId.make("alice-local"),
                    localProjectId: ProjectId.make("alice-project"),
                    repository: project.repository,
                  });
                  const aliceContext = yield* alice[WS_METHODS.sharedWorkContextPut]({
                    contextId: "alice-task",
                    checkoutId: aliceCheckout.checkoutId,
                    source: { kind: "project_conversation" },
                    objective: "Review Alice's API change",
                    revision: {
                      branch: revisions.alice.branch,
                      commit: revisions.alice.commit,
                      applicability: "branch",
                    },
                    paths: ["src/api.ts"],
                    tags: ["api"],
                  });
                  const aliceInput = {
                    specialistId: specialist.specialistId,
                    requestId: "same-client-request-id",
                    contextId: aliceContext.contextId,
                    contextVersion: aliceContext.contextVersion,
                    text: markers[0],
                  };
                  const pair = yield* withClient(origin, bobBearer, (bob) =>
                    Effect.gen(function* () {
                      const bobParticipant = yield* bob[WS_METHODS.sharedWorkspaceJoin]({
                        displayName: "Bob",
                      });
                      expect(bobParticipant.participantId).not.toBe(aliceParticipant.participantId);
                      const bobCheckout = yield* bob[WS_METHODS.sharedCheckoutAttach]({
                        localEnvironmentId: EnvironmentId.make("bob-local"),
                        localProjectId: ProjectId.make("bob-project"),
                        repository: project.repository,
                      });
                      const bobContext = yield* bob[WS_METHODS.sharedWorkContextPut]({
                        contextId: "bob-task",
                        checkoutId: bobCheckout.checkoutId,
                        source: { kind: "project_conversation" },
                        objective: "Review Bob's API integration",
                        revision: {
                          branch: revisions.bob.branch,
                          commit: revisions.bob.commit,
                          applicability: "branch",
                        },
                        paths: ["src/api.ts"],
                        tags: ["api"],
                      });
                      expect(
                        (yield* bob[WS_METHODS.sharedSpecialistSend](aliceInput).pipe(Effect.flip))
                          ._tag,
                      ).toBe("SharedWorkspaceError");
                      const a = yield* alice[WS_METHODS.sharedSpecialistSend](aliceInput);
                      yield* Effect.promise(() =>
                        bounded(fixture.entered[0]!.promise, "Alice native admission"),
                      );
                      const bobInput = {
                        ...aliceInput,
                        contextId: bobContext.contextId,
                        contextVersion: bobContext.contextVersion,
                        text: markers[1],
                      };
                      const b = yield* bob[WS_METHODS.sharedSpecialistSend](bobInput);
                      expect(a.requestId).not.toBe(b.requestId);
                      expect(a.nativeRequestId).not.toBe(b.nativeRequestId);
                      for (const pending of [a, b]) {
                        expect(["accepted", "unresolved"]).toContain(pending.outcome.status);
                        expect(pending.outcome.completion).toBeNull();
                      }
                      // A separate native ingress must never become either participant's result.
                      yield* admin[WS_METHODS.meerkatAgentSend]({
                        projectId,
                        instanceId,
                        agentRef,
                        requestId: "unrelated-native-ingress",
                        text: markers[2],
                        handlingMode: "queue",
                      });
                      fixture.release[0]!.resolve();
                      const completedA = yield* waitCompleted(alice, a.requestId);
                      assertExact(
                        completedA,
                        answers[0],
                        revisions.alice.commit,
                        aliceParticipant.participantId,
                      );
                      const stillPendingB = yield* bob[WS_METHODS.sharedSpecialistRequest]({
                        requestId: b.requestId,
                      });
                      expect(stillPendingB.outcome.completion).toBeNull();
                      expect(["accepted", "unresolved"]).toContain(stillPendingB.outcome.status);
                      // Native admission decides the order of queued ingress. Let the
                      // unrelated turn finish regardless of which queued turn starts first.
                      fixture.release[2]!.resolve();
                      yield* Effect.promise(() =>
                        bounded(fixture.entered[1]!.promise, "Bob native admission"),
                      );
                      fixture.release[1]!.resolve();
                      const completedB = yield* waitCompleted(bob, b.requestId);
                      assertExact(
                        completedB,
                        answers[1],
                        revisions.bob.commit,
                        bobParticipant.participantId,
                      );
                      yield* Effect.promise(() =>
                        bounded(fixture.entered[2]!.promise, "unrelated native admission"),
                      );
                      for (;;) {
                        const team = yield* admin[WS_METHODS.meerkatProjectTeam]({ projectId });
                        const native = team.providers
                          .flatMap((provider) => provider.agents)
                          .find((agent) => agent.agentRef === agentRef);
                        if (
                          native?.work?.status === "idle" &&
                          [answers[1], answers[2]].some((answer) => native.work?.outcome === answer)
                        )
                          break;
                        yield* Effect.sleep("100 millis");
                      }
                      assertExact(
                        yield* alice[WS_METHODS.sharedSpecialistRequest]({
                          requestId: a.requestId,
                        }),
                        answers[0],
                        revisions.alice.commit,
                        aliceParticipant.participantId,
                      );
                      expect(
                        (yield* alice[WS_METHODS.sharedSpecialistSend](aliceInput)).requestId,
                      ).toBe(a.requestId);
                      expect(fixture.requests).toHaveLength(3);
                      expect(fixture.requests.find((text) => text.includes(markers[0]))).toContain(
                        revisions.alice.commit,
                      );
                      expect(fixture.requests.find((text) => text.includes(markers[1]))).toContain(
                        revisions.bob.commit,
                      );
                      expect(
                        nativeIdentity(
                          yield* admin[WS_METHODS.meerkatProjectTeam]({ projectId }),
                          agentRef,
                        ),
                      ).toEqual(identity);
                      return { a: completedA, b: completedB, bobParticipant, bobContext };
                    }),
                  );
                  // Bob's actual socket is closed here. Events are retained for that authenticated participant.
                  const event = {
                    contextId: aliceContext.contextId,
                    contextVersion: aliceContext.contextVersion,
                    revision: aliceContext.revision,
                    kind: "finding" as const,
                    paths: ["src/api.ts"],
                    tags: ["api"],
                    sources: [],
                    recipientIds: [pair.bobParticipant.participantId],
                  };
                  yield* alice[WS_METHODS.sharedActivityPublish]({
                    ...event,
                    eventId: "while-bob-offline",
                    summary: "Alice found an API compatibility risk.",
                  });
                  const batch = yield* withClient(origin, bobBearer, (bob) =>
                    Effect.gen(function* () {
                      expect(
                        (yield* bob[WS_METHODS.sharedWorkspaceSession]({})).snapshot.participant
                          ?.participantId,
                      ).toBe(pair.bobParticipant.participantId);
                      const first = yield* bob[WS_METHODS.sharedInboxRead]({});
                      expect(first.batchId).toBeTruthy();
                      expect(first.events.map((item) => item.eventId)).toContain(
                        "while-bob-offline",
                      );
                      expect(
                        first.events.find((item) => item.eventId === "while-bob-offline")?.author
                          .participantId,
                      ).toBe(aliceParticipant.participantId);
                      yield* alice[WS_METHODS.sharedActivityPublish]({
                        ...event,
                        eventId: "after-batch-sealed",
                        summary: "A later observation belongs to the next batch.",
                      });
                      expect(yield* bob[WS_METHODS.sharedInboxRead]({})).toEqual(first);
                      return first;
                    }),
                  );
                  evidence.phase = "requests-and-offline-inbox-verified";
                  return {
                    ...pair,
                    identity,
                    agentRef,
                    agentId: created.agentId,
                    specialistId: specialist.specialistId,
                    aliceParticipant,
                    aliceContext,
                    aliceInput,
                    batch,
                  };
                }),
              );
            }),
          );
          // This restart proves completed request retention, not pending native work recovery.
          // All three client sockets have closed before the owned server is stopped.
          const stopped = yield* Effect.promise(() => server!.close());
          expect(stopped.signal).toBeNull();
          expect([0, 130]).toContain(stopped.code);
          evidence.phase = "server-stopped";
          yield* start("server-after-restart.json");
          yield* withClient(origin, adminBearer, (admin) =>
            Effect.gen(function* () {
              yield* withClient(origin, aliceBearer, (alice) =>
                Effect.gen(function* () {
                  expect(
                    (yield* alice[WS_METHODS.sharedWorkspaceSession]({})).snapshot.participant
                      ?.participantId,
                  ).toBe(retained.aliceParticipant.participantId);
                  assertExact(
                    yield* alice[WS_METHODS.sharedSpecialistRequest]({
                      requestId: retained.a.requestId,
                    }),
                    answers[0],
                    revisions.alice.commit,
                    retained.aliceParticipant.participantId,
                  );
                  const conversation = yield* alice[WS_METHODS.sharedSpecialistConversation]({
                    specialistId: retained.specialistId,
                  });
                  expect(conversation.requests.map((request) => request.requestId).sort()).toEqual(
                    [retained.a.requestId, retained.b.requestId].sort(),
                  );
                  expect(fixture.requests).toHaveLength(3);
                  yield* withClient(origin, bobBearer, (bob) =>
                    Effect.gen(function* () {
                      assertExact(
                        yield* bob[WS_METHODS.sharedSpecialistRequest]({
                          requestId: retained.b.requestId,
                        }),
                        answers[1],
                        revisions.bob.commit,
                        retained.bobParticipant.participantId,
                      );
                      expect(yield* bob[WS_METHODS.sharedInboxRead]({})).toEqual(retained.batch);
                      yield* bob[WS_METHODS.sharedInboxAcknowledge]({
                        batchId: retained.batch.batchId!,
                      });
                      const next = yield* bob[WS_METHODS.sharedInboxRead]({});
                      expect(next.batchId).not.toBe(retained.batch.batchId);
                      expect(next.events.map((event) => event.eventId)).toContain(
                        "after-batch-sealed",
                      );
                      expect(next.events.map((event) => event.eventId)).not.toContain(
                        "while-bob-offline",
                      );
                    }),
                  );
                  const resumed = yield* admin[WS_METHODS.meerkatProjectAgentLifecycle]({
                    projectId,
                    agentId: retained.agentId,
                    action: "connect",
                  });
                  expect(resumed.connectionStatus, resumed.error ?? undefined).toBe("connected");
                  expect(
                    nativeIdentity(
                      yield* admin[WS_METHODS.meerkatProjectTeam]({ projectId }),
                      retained.agentRef,
                    ),
                  ).toEqual(retained.identity);
                  const continuation = yield* alice[WS_METHODS.sharedSpecialistSend]({
                    ...retained.aliceInput,
                    requestId: "after-restart",
                    text: markers[3],
                  });
                  yield* Effect.promise(() =>
                    bounded(fixture.entered[3]!.promise, "same specialist after restart"),
                  );
                  fixture.release[3]!.resolve();
                  assertExact(
                    yield* waitCompleted(alice, continuation.requestId),
                    answers[3],
                    revisions.alice.commit,
                    retained.aliceParticipant.participantId,
                  );
                  expect(
                    nativeIdentity(
                      yield* admin[WS_METHODS.meerkatProjectTeam]({ projectId }),
                      retained.agentRef,
                    ),
                  ).toEqual(retained.identity);
                  evidence.phase = "live-peer-isolation";
                  evidence.livePeer = yield* exerciseLivePeerIsolation({
                    admin,
                    participant: alice,
                    fixture: fixture.peer,
                    projectId,
                    instanceId,
                    agentId: retained.agentId,
                    agentRef: retained.agentRef,
                    boundRequest: retained.aliceInput,
                  });
                }),
              );
            }),
          );
          expect(fixture.requests).toHaveLength(4);
          expect(fixture.inferenceCount()).toBe(10);
          expect(fixture.repositoryReadVerified()).toBe(true);
          expect(fixture.errors).toEqual([]);
          evidence.phase = "complete";
          evidence.restartScope = "completed requests and same-specialist continuation";
          evidence.pendingWorkRecoveryTested = false;
          evidence.liveScheduledDeliveryTested = false;
          evidence.nativeIdentity = retained.identity;
          evidence.participantIds = [
            retained.aliceParticipant.participantId,
            retained.bobParticipant.participantId,
          ];
          evidence.requestIds = [retained.a.requestId, retained.b.requestId];
          evidence.proofs = [
            "native-revision-bound-repository-tool",
            "two-scoped-WebSocket-clients",
            "distinct-real-checkouts-and-revisions",
            "one-shared-native-specialist",
            "exact-request-outcomes",
            "pending-is-not-completed",
            "unrelated-native-ingress-separated",
            "live-native-peer-outcome-separated",
            "offline-product-inbox",
            "immutable-batch-restart",
            "same-native-session-resumed",
            "no-application-replay",
          ];
        }).pipe(Effect.timeout(fixtureTimeoutMs(240_000, 1, false)), Effect.scoped),
      fixtureTimeoutMs(240_000, 2) + 10_000,
    );
  },
);

// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - opt-in real three-server/native pilot owns disposable processes and synthetic loopback accounts.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  AuthAdministrativeScopes,
  AuthSharedParticipantScopes,
  CommandId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
  type OrchestrationThreadStreamItem,
  type SharedWorkContext,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type { RpcClient } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { describe, expect, it } from "@effect/vitest";
import {
  availablePort,
  bounded,
  configureWorkspace,
  exchangeToken,
  fixtureTimeoutMs,
  ownedServer,
  ownedServerShutdownBudget,
  prepareFixture,
  watch,
  withClient,
  workflowModel,
} from "../provider/meerkat/MeerkatWorkflow.server.native.support.ts";
import {
  initializeSharedRepository,
  issueSharedPairing,
} from "./SharedSpecialist.server.native.support.ts";
import {
  controlledExpansionProvider,
  expansionFinal,
  expansionGit,
  expansionLanes,
  expansionMarker,
  growthFinal,
  growthMarker,
  selfRevisionMarker,
  selfRevisionFinal,
  selfRevisionObserveMarker,
  selfRevisionObservedFinal,
  inboxPeerSenderMarker,
  inboxPeerFinal,
  snapshotPatchMarker,
  type ExpansionLane,
} from "./SharedExpansion.server.native.support.ts";
import { prepareSharedTlsFixture } from "./SharedExpansion.https.native.support.ts";

const serverEntry = process.env.T3CODE_TEST_MEERKAT_SERVER_ENTRY;
const runtimeDirectory = process.env.T3CODE_TEST_MEERKAT_RUNTIME_DIR;
// This mode still requires both exact native artifact inputs. Default tests start no servers.
const tlsEnabled = process.env.T3CODE_TEST_SHARED_TLS === "1";
const instanceId = ProviderInstanceId.make("meerkat");
const modelSelection = { instanceId, model: workflowModel };
const now = () => DateTime.formatIso(DateTime.nowUnsafe());
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const result = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.String }));
const receiptAnchor = Schema.decodeUnknownSync(
  Schema.Struct({
    receipt: Schema.Struct({ session_id: Schema.String, interaction_id: Schema.String }),
  }),
);
const inboxEvents = Schema.decodeUnknownEffect(
  Schema.Struct({ events: Schema.Array(Schema.Struct({ eventId: Schema.String })) }),
);
type Client = RpcClient.FromGroup<typeof WsRpcGroup, RpcClientError>;
type Prepared = Awaited<ReturnType<typeof prepareFixture>>;
const hostProjectId = (lane: ExpansionLane) => ProjectId.make(`expansion-host-${lane}`);
const localProjectId = (lane: ExpansionLane) => ProjectId.make(`expansion-local-${lane}`);
const localThreadId = (lane: ExpansionLane) => ThreadId.make(`expansion-task-${lane}`);
const repository = (lane: ExpansionLane) =>
  `https://github.com/example/shared-${lane === "A" ? "api" : "storefront"}`;
const failureOf = (item: OrchestrationThreadStreamItem) => {
  const session =
    item.kind === "snapshot"
      ? item.snapshot.thread.session
      : item.kind === "event" && item.event.type === "thread.session-set"
        ? item.event.payload.session
        : undefined;
  if (session?.status === "error")
    return new Error(`Expansion native task failed: ${session.lastError ?? "unknown"}`);
  if (
    item.kind === "event" &&
    item.event.type === "thread.activity-appended" &&
    item.event.payload.activity.kind === "provider.turn.start.failed"
  )
    return new Error("Expansion native task could not start");
  return undefined;
};
const runTask = (client: Client, lane: ExpansionLane, kind: "BOOT" | "RUN" | "DENIED") =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* watch(
        client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId: localThreadId(lane) }),
        failureOf,
      );
      const shell = yield* watch(
        client[ORCHESTRATION_WS_METHODS.subscribeShell]({ requestCompletionMarker: true }),
      );
      yield* shell.waitFor((item) => item.kind === "synchronized", "local shell initialized");
      const after = shell.index();
      const marker = expansionMarker(kind, lane);
      yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
        type: "thread.turn.start",
        commandId: CommandId.make(`command-${marker}`),
        threadId: localThreadId(lane),
        message: {
          messageId: MessageId.make(`message-${marker}`),
          role: "user",
          text: marker,
          attachments: [],
        },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: now(),
      });
      const expected = expansionFinal(kind, lane);
      yield* thread.waitFor(
        (item) =>
          item.kind === "snapshot"
            ? item.snapshot.thread.messages.some(
                (message) =>
                  message.role === "assistant" && message.text === expected && !message.streaming,
              )
            : item.kind === "event" &&
              item.event.type === "thread.message-sent" &&
              item.event.payload.role === "assistant" &&
              item.event.payload.text === expected &&
              !item.event.payload.streaming,
        `native ${expected}`,
      );
      yield* shell.waitFor(
        (item) =>
          item.kind === "thread-upserted" &&
          item.thread.id === localThreadId(lane) &&
          item.thread.latestTurn?.state === "completed" &&
          item.thread.session?.status === "ready",
        `settled ${expected}`,
        after,
      );
    }),
  );
const waitRequest = (client: Client, requestId: string) =>
  Effect.gen(function* () {
    for (;;) {
      const request = yield* client[WS_METHODS.sharedSpecialistRequest]({ requestId });
      if (request.outcome.status === "failed") throw new Error("Expansion shared request failed");
      if (request.outcome.status === "completed") return request;
      expect(request.outcome.completion).toBeNull();
      yield* Effect.sleep("100 millis");
    }
  }).pipe(Effect.timeout("60 seconds"));

describe.skipIf(!serverEntry || !runtimeDirectory)(
  "actual personal brokers and permanent shared composition",
  () => {
    it.live(
      "uses two personal task grants across projects, retains attributed corrections, revokes tools, and creates an independent peer",
      () =>
        Effect.gen(function* () {
          if (!serverEntry || !runtimeDirectory)
            throw new Error("Supply the immutable server entry and staged native runtime");
          expect(NodePath.isAbsolute(serverEntry) && NodePath.isAbsolute(runtimeDirectory)).toBe(
            true,
          );
          const root = yield* Effect.promise(async () =>
            NodeFSP.realpath(
              await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-native-shared-expansion-")),
            ),
          );
          yield* Effect.promise(() => NodeFSP.chmod(root, 0o700));
          const fixture = controlledExpansionProvider();
          const servers: ReturnType<typeof ownedServer>[] = [];
          let tls: Awaited<ReturnType<typeof prepareSharedTlsFixture>> | undefined;
          let shutdownBudgetMs = 30_000;
          const evidence: Record<string, unknown> = {
            phase: "setup",
            transport: tlsEnabled ? "https-wss" : "loopback-http-ws",
            serverEntrySha256: yield* Effect.promise(async () =>
              NodeCrypto.createHash("sha256")
                .update(await NodeFSP.readFile(serverEntry))
                .digest("hex"),
            ),
          };
          yield* Effect.addFinalizer((exit) =>
            Effect.promise(async () => {
              const cleanupServers = servers.toReversed();
              const shutdown = await Promise.allSettled(
                cleanupServers.map(async (server) => {
                  const stopped = await server.close();
                  const observation = server.shutdownObservation();
                  // Effect's runMain reports requested interruption as code 130.
                  // Accept it only for this owner's successful SIGTERM request.
                  const expectedInterruption =
                    stopped.code === 130 && observation.requestedSignal === "SIGTERM";
                  if (
                    observation.forced ||
                    stopped.signal !== null ||
                    (stopped.code !== 0 && !expectedInterruption)
                  )
                    throw new Error(
                      `Owned server exited without orderly cleanup (${stopped.code ?? stopped.signal})`,
                    );
                  return stopped;
                }),
              );
              const serversClosed = shutdown.every((entry) => entry.status === "fulfilled");
              const tlsShutdown =
                tls && serversClosed ? await Promise.allSettled([tls.close()]) : [];
              const tlsCleanupComplete =
                (!tls || serversClosed) &&
                tlsShutdown.every((entry) => entry.status === "fulfilled");
              const tlsCleanup = tls?.cleanupObservation() ?? [];
              const cleanupComplete = serversClosed && tlsCleanupComplete;
              const shutdownObservations = shutdown.map((entry, index) => ({
                pid: cleanupServers[index]!.child.pid,
                status: entry.status,
                code: cleanupServers[index]!.child.exitCode,
                signal: cleanupServers[index]!.child.signalCode,
                ...cleanupServers[index]!.shutdownObservation(),
                ...(entry.status === "rejected"
                  ? {
                      error:
                        entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
                    }
                  : {}),
              }));
              const originalFailure = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : null;
              if (serversClosed) {
                fixture.provider.closeAllConnections();
                if (fixture.provider.listening)
                  await new Promise<void>((resolve, reject) =>
                    fixture.provider.close((error) => (error ? reject(error) : resolve())),
                  );
              }
              const directory = NodePath.join(root, "evidence");
              await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
              await NodeFSP.writeFile(
                NodePath.join(directory, "shared-expansion-acceptance.json"),
                encode({
                  ...evidence,
                  ...(tls ? { tls: tls.observe(), tlsCleanupComplete, tlsCleanup } : {}),
                  passed: Exit.isSuccess(exit) && cleanupComplete,
                  assertionsPassed: Exit.isSuccess(exit),
                  originalFailure,
                  cleanupComplete,
                  shutdownBudgetMs,
                  shutdown: shutdownObservations,
                  providerErrors: fixture.errors,
                  providerRequestCount: fixture.inferenceCount(),
                  completed: [...fixture.completed],
                  growth: fixture.growth(),
                  inboxObservation: fixture.inboxObservation(),
                }),
                { mode: 0o600 },
              );
              if (!cleanupComplete)
                throw new Error(
                  `Owned expansion cleanup failed: ${encode({ servers: shutdownObservations, tls: tlsCleanup })}` +
                    (originalFailure ? `\nOriginal test failure:\n${originalFailure}` : ""),
                );
            }).pipe(
              Effect.ensuring(Effect.logInfo(`Shared expansion evidence retained at ${root}`)),
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
          if (!address || typeof address === "string") throw new Error("No provider fixture port");
          const host = yield* Effect.promise(() =>
            prepareFixture(NodePath.join(root, "shared-host"), runtimeDirectory, address.port),
          ).pipe(Effect.uninterruptible);
          const api = yield* Effect.promise(() =>
            initializeSharedRepository(host.projectPath, host.env),
          );
          const storefrontPath = NodePath.join(root, "shared-storefront", "project");
          yield* Effect.promise(() =>
            NodeFSP.mkdir(storefrontPath, { recursive: true, mode: 0o700 }),
          );
          const storefront = yield* Effect.promise(() =>
            initializeSharedRepository(storefrontPath, host.env),
          );
          yield* Effect.promise(() =>
            expansionGit(storefrontPath, host.env, [
              "remote",
              "set-url",
              "origin",
              repository("B"),
            ]),
          );
          yield* Effect.promise(() =>
            configureWorkspace(
              storefrontPath,
              host.nativeRoot,
              runtimeDirectory,
              address.port,
              host.env,
            ),
          ).pipe(Effect.uninterruptible);
          const personal = new Map<ExpansionLane, Prepared>();
          for (const lane of expansionLanes) {
            const personalRoot = NodePath.join(root, `personal-${lane}`);
            yield* Effect.promise(() =>
              NodeFSP.mkdir(personalRoot, { recursive: true, mode: 0o700 }),
            );
            yield* Effect.promise(() =>
              expansionGit(root, host.env, [
                "clone",
                "--no-hardlinks",
                lane === "A" ? host.projectPath : storefrontPath,
                NodePath.join(personalRoot, "project"),
              ]),
            );
            const prepared = yield* Effect.promise(() =>
              prepareFixture(personalRoot, runtimeDirectory, address.port),
            ).pipe(Effect.uninterruptible);
            yield* Effect.promise(() =>
              expansionGit(prepared.projectPath, prepared.env, [
                "remote",
                "set-url",
                "origin",
                repository(lane),
              ]),
            );
            // A clone's remote branches must be made local without contacting any remote host.
            const sourceBranch = lane === "A" ? "alice" : "bob";
            yield* Effect.promise(() =>
              expansionGit(prepared.projectPath, prepared.env, [
                "branch",
                `feature/${sourceBranch}`,
                `refs/remotes/origin/feature/${sourceBranch}`,
              ]),
            );
            personal.set(lane, prepared);
          }
          const start = (prepared: Prepared, label: string, caPath?: string) =>
            Effect.gen(function* () {
              // All three server shutdowns run together under their native-derived bounds.
              shutdownBudgetMs = Math.max(
                shutdownBudgetMs,
                ownedServerShutdownBudget(prepared.shutdownHorizonMs),
              );
              const port = yield* Effect.promise(availablePort);
              const origin = `http://127.0.0.1:${port}`;
              const server = ownedServer(
                serverEntry,
                prepared.projectPath,
                prepared.baseDir,
                port,
                caPath ? { ...prepared.env, NODE_EXTRA_CA_CERTS: caPath } : prepared.env,
                prepared.shutdownHorizonMs,
                NodePath.join(prepared.evidenceRoot, `${label}.json`),
              );
              servers.push(server);
              const token = yield* Effect.promise(() =>
                bounded(server.ready, `${label} readiness`, 60_000),
              );
              const bearer = yield* exchangeToken(
                origin,
                token,
                AuthAdministrativeScopes.join(" "),
              );
              return { origin, bearer };
            });
          const sharedServer = yield* start(host, "shared-server");
          if (tlsEnabled)
            yield* Effect.uninterruptible(
              Effect.promise(() =>
                prepareSharedTlsFixture(
                  NodePath.join(root, "tls"),
                  Number(new URL(sharedServer.origin).port),
                ),
              ).pipe(
                Effect.tap((prepared) =>
                  Effect.sync(() => {
                    tls = prepared;
                  }),
                ),
              ),
            );
          const brokerOrigin = tls?.trustedOrigin ?? sharedServer.origin;
          const localA = yield* start(personal.get("A")!, "personal-A-server", tls?.caPath);
          const localB = yield* start(personal.get("B")!, "personal-B-server", tls?.caPath);
          evidence.manifest = host.manifest;
          evidence.phase = "three-servers-ready";
          yield* withClient(sharedServer.origin, sharedServer.bearer, (admin) =>
            Effect.gen(function* () {
              yield* admin[WS_METHODS.sharedWorkspaceConfigure]({
                name: "Expansion shared workspace",
              });
              yield* admin[WS_METHODS.sharedWorkspaceJoin]({ displayName: "Shared host operator" });
              for (const lane of expansionLanes)
                yield* admin[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                  type: "project.create",
                  commandId: CommandId.make(`host-project-${lane}`),
                  projectId: hostProjectId(lane),
                  title: lane === "A" ? "Shared API" : "Shared Storefront",
                  workspaceRoot: lane === "A" ? host.projectPath : storefrontPath,
                  createdAt: now(),
                });
              const projectA = yield* admin[WS_METHODS.sharedProjectRegister]({
                requestId: "register-api",
                name: "API",
                repository: repository("A"),
                hostProjectId: hostProjectId("A"),
              });
              const projectB = yield* admin[WS_METHODS.sharedProjectRegister]({
                requestId: "register-storefront",
                name: "Storefront",
                repository: repository("B"),
                hostProjectId: hostProjectId("B"),
              });
              const assignments = [
                {
                  sharedProjectId: projectA.sharedProjectId,
                  charter: "API and client compatibility",
                  paths: ["src/api.ts"],
                  tags: ["api"],
                },
                {
                  sharedProjectId: projectB.sharedProjectId,
                  charter: "Storefront integration and contracts",
                  paths: ["src/api.ts"],
                  tags: ["storefront"],
                },
              ];
              const agent = yield* admin[WS_METHODS.meerkatProjectAgentCreate]({
                projectId: hostProjectId("A"),
                instanceId,
                requestId: "create-cross-project-specialist",
                label: "Integration specialist",
                role: "integration-specialist",
                instructions:
                  "Keep API and storefront knowledge connected across explicit task revisions. Use application tools to create independent specialists when requested.",
                model: workflowModel,
                accessMode: "repository-read-only",
              });
              expect(agent.connectionStatus, agent.error ?? undefined).toBe("connected");
              const specialist = yield* admin[WS_METHODS.sharedSpecialistRegister]({
                requestId: "register-cross-project-specialist",
                label: "Integration specialist",
                nativeTarget: { projectId: hostProjectId("A"), instanceId, agentId: agent.agentId },
                assignments,
              });
              const identities = (yield* admin[WS_METHODS.meerkatProjectTeam]({
                projectId: hostProjectId("A"),
              })).providers
                .flatMap((provider) => provider.agents)
                .filter((value) => value.projectAgentId === agent.agentId);
              expect(identities).toHaveLength(1);
              const original = identities[0]!;
              expect(original.observedAccessMode).toBe("repository-read-only");
              expect(original.record.session_id).toBeTruthy();
              const aliceBearer = yield* exchangeToken(
                sharedServer.origin,
                yield* issueSharedPairing(
                  sharedServer.origin,
                  sharedServer.bearer,
                  "Expansion Alice",
                ),
                AuthSharedParticipantScopes.join(" "),
              );
              const bobBearer = yield* exchangeToken(
                sharedServer.origin,
                yield* issueSharedPairing(
                  sharedServer.origin,
                  sharedServer.bearer,
                  "Expansion Bob",
                ),
                AuthSharedParticipantScopes.join(" "),
              );
              // A joined participant with contribution-only auth is deliberately missing read
              // authority. Rejection cannot be explained by an absent workspace membership.
              const insufficientScope = tls
                ? yield* Effect.gen(function* () {
                    const credential = yield* exchangeToken(
                      sharedServer.origin,
                      yield* issueSharedPairing(
                        sharedServer.origin,
                        sharedServer.bearer,
                        "TLS limited scope",
                      ),
                      "shared:contribute",
                    );
                    const participant = yield* withClient(
                      sharedServer.origin,
                      credential,
                      (client) =>
                        client[WS_METHODS.sharedWorkspaceJoin]({
                          displayName: "TLS limited scope",
                        }),
                    );
                    return { credential, participantId: participant.participantId };
                  })
                : undefined;
              yield* withClient(sharedServer.origin, aliceBearer, (alice) =>
                withClient(sharedServer.origin, bobBearer, (bob) =>
                  withClient(localA.origin, localA.bearer, (a) =>
                    withClient(localB.origin, localB.bearer, (b) =>
                      Effect.gen(function* () {
                        const settings = new Map<
                          ExpansionLane,
                          {
                            local: Client;
                            remote: Client;
                            credential: string;
                            context: SharedWorkContext;
                            localId: string;
                            delegationId: string;
                          }
                        >();
                        for (const lane of expansionLanes) {
                          const local = lane === "A" ? a : b;
                          const remote = lane === "A" ? alice : bob;
                          const credential = lane === "A" ? aliceBearer : bobBearer;
                          const prepared = personal.get(lane)!;
                          yield* local[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                            type: "project.create",
                            commandId: CommandId.make(`personal-project-${lane}`),
                            projectId: localProjectId(lane),
                            title: `Personal ${lane}`,
                            workspaceRoot: prepared.projectPath,
                            createdAt: now(),
                          });
                          const branch = `codex/expansion-${lane.toLowerCase()}`;
                          const worktree = yield* local[WS_METHODS.vcsCreateWorktree]({
                            cwd: prepared.projectPath,
                            refName: lane === "A" ? "feature/alice" : "feature/bob",
                            newRefName: branch,
                            path: NodePath.join(root, `selected-worktree-${lane}`),
                          });
                          const path = yield* Effect.promise(() =>
                            NodeFSP.realpath(worktree.worktree.path),
                          );
                          const commit = lane === "A" ? api.alice.commit : storefront.bob.commit;
                          expect(
                            yield* Effect.promise(() =>
                              expansionGit(path, prepared.env, ["rev-parse", "HEAD"]),
                            ),
                          ).toBe(commit);
                          yield* Effect.promise(() =>
                            configureWorkspace(
                              path,
                              prepared.nativeRoot,
                              runtimeDirectory,
                              address.port,
                              prepared.env,
                            ),
                          ).pipe(Effect.uninterruptible);
                          yield* local[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                            type: "thread.create",
                            commandId: CommandId.make(`personal-task-${lane}`),
                            threadId: localThreadId(lane),
                            projectId: localProjectId(lane),
                            title: `Integration task ${lane}`,
                            modelSelection,
                            runtimeMode: "full-access",
                            interactionMode: "default",
                            branch,
                            worktreePath: path,
                            createdAt: now(),
                          });
                          yield* runTask(local, lane, "BOOT");
                          const person = yield* remote[WS_METHODS.sharedWorkspaceJoin]({
                            displayName: lane === "A" ? "Alice" : "Bob",
                          });
                          const identity = yield* remote[WS_METHODS.sharedDelegationSession]({});
                          expect(identity.participantId).toBe(person.participantId);
                          if (tls && lane === "A") {
                            const expected = {
                              environmentId: identity.environmentId,
                              workspaceId: identity.workspaceId,
                              participantId: identity.participantId,
                            };
                            const failures = [];
                            for (const probe of [
                              {
                                name: "untrusted-certificate",
                                origin: tls.untrustedOrigin,
                                credential,
                                expected,
                              },
                              {
                                name: "hostname-mismatch",
                                origin: tls.wrongHostOrigin,
                                credential,
                                expected,
                              },
                              {
                                name: "invalid-credential",
                                origin: brokerOrigin,
                                credential: "synthetic-invalid-token",
                                expected,
                              },
                              {
                                name: "insufficient-scope",
                                origin: brokerOrigin,
                                credential: insufficientScope!.credential,
                                expected: {
                                  ...expected,
                                  participantId: insufficientScope!.participantId,
                                },
                              },
                              {
                                name: "wrong-participant",
                                origin: brokerOrigin,
                                credential,
                                expected: { ...expected, participantId: "different-participant" },
                              },
                            ]) {
                              const requestId = `tls-rejected-${probe.name}`;
                              const outcome = yield* local[WS_METHODS.sharedLocalConnectionCreate]({
                                requestId,
                                label: `TLS negative probe: ${probe.name}`,
                                origin: probe.origin,
                                credential: probe.credential,
                                expected: probe.expected,
                                consent: true,
                              }).pipe(
                                Effect.match({
                                  onFailure: (error) => ({
                                    tag: error._tag,
                                    code: "code" in error ? error.code : null,
                                  }),
                                  onSuccess: () => ({ tag: "unexpected-success", code: null }),
                                }),
                              );
                              expect(outcome).toMatchObject({
                                tag: "SharedWorkspaceError",
                                code: "unavailable",
                              });
                              // Failed setup retains an exact retry claim until explicitly canceled.
                              // Clean only these synthetic attempts, never assert remote revocation.
                              expect(
                                yield* local[WS_METHODS.sharedLocalConnectionCancelSetup]({
                                  requestId,
                                }),
                              ).toMatchObject({ canceled: true, requestId, cleanup: null });
                              failures.push({ probe: probe.name, ...outcome });
                            }
                            expect(yield* local[WS_METHODS.sharedLocalConnectionList]({})).toEqual(
                              [],
                            );
                            const observed = tls.observe();
                            for (const rejected of [observed.untrusted, observed.wrongHost]) {
                              expect(rejected.tcpConnections).toBeGreaterThan(0);
                              expect(rejected.handshakeErrors).toBeGreaterThan(0);
                              expect(rejected.secureConnections).toBe(0);
                              expect(rejected.upstreamConnections).toBe(0);
                              expect(rejected.receivedBytes).toBe(0);
                            }
                            expect(observed.trusted.upstreamConnections).toBeGreaterThanOrEqual(3);
                            evidence.tlsRejectedSetups = failures;
                          }
                          const localEnvironment = (yield* local[WS_METHODS.serverGetConfig]({}))
                            .environment.environmentId;
                          const checkout = yield* remote[WS_METHODS.sharedCheckoutAttach]({
                            localEnvironmentId: localEnvironment,
                            localProjectId: localProjectId(lane),
                            repository: repository(lane),
                          });
                          if (lane === "A")
                            yield* Effect.promise(() =>
                              NodeFSP.appendFile(
                                NodePath.join(path, "src/api.ts"),
                                `\n// ${snapshotPatchMarker}\n`,
                              ),
                            );
                          const preview = yield* local[WS_METHODS.sharedCheckoutPatch]({
                            projectId: localProjectId(lane),
                            threadId: localThreadId(lane),
                          });
                          expect(preview.branch).toBe(branch);
                          expect(preview.commit).toBe(commit);
                          expect(preview.status, encode(preview.excluded)).toBe(
                            lane === "A" ? "ready" : "clean",
                          );
                          const snapshot =
                            lane === "A"
                              ? yield* remote[WS_METHODS.sharedSnapshotPut]({
                                  checkoutId: checkout.checkoutId,
                                  revision: { branch, commit, applicability: "branch" },
                                  patch: preview.patch!,
                                })
                              : undefined;
                          if (snapshot) {
                            expect(snapshot.sha256).toBe(preview.sha256);
                            expect(snapshot.bytes).toBe(preview.bytes);
                          }
                          const context = yield* remote[WS_METHODS.sharedWorkContextPut]({
                            contextId: `personal-task-context-${lane}`,
                            checkoutId: checkout.checkoutId,
                            source: { kind: "thread", threadId: localThreadId(lane) },
                            objective: `Coordinate integration task ${lane}`,
                            revision: {
                              branch,
                              commit,
                              applicability: "branch",
                              ...(snapshot ? { snapshotId: snapshot.snapshotId } : {}),
                            },
                            paths: ["src/api.ts"],
                            tags: [lane === "A" ? "api" : "storefront"],
                          });
                          const connection = yield* local[WS_METHODS.sharedLocalConnectionCreate]({
                            requestId: `connection-${lane}`,
                            label: `Shared work as ${person.displayName}`,
                            origin: brokerOrigin,
                            credential,
                            expected: {
                              environmentId: identity.environmentId,
                              workspaceId: identity.workspaceId,
                              participantId: identity.participantId,
                            },
                            consent: true,
                          });
                          expect(encode(connection)).not.toContain(credential);
                          expect(connection.origin).toBe(brokerOrigin);
                          const enabled = yield* local[WS_METHODS.sharedLocalDelegationEnable]({
                            connectionId: connection.connectionId,
                            requestId: `grant-${lane}`,
                            threadId: localThreadId(lane),
                            label: `Task ${lane} assistant`,
                            contextId: context.contextId,
                            contextVersion: context.contextVersion,
                            actions: [
                              "projects.list",
                              "projects.get",
                              "specialists.list",
                              "specialists.get",
                              "specialists.send",
                              "specialists.request",
                              "inbox.list",
                              "inbox.ack",
                              "activity.publish",
                              "knowledge.search",
                              "knowledge.record",
                              "knowledge.supersede",
                            ],
                            expiresAt: DateTime.formatIso(
                              DateTime.add(yield* DateTime.now, { minutes: 20 }),
                            ),
                          });
                          if (!enabled.grant)
                            throw new Error("Native task grant was not confirmed");
                          expect(enabled.grant.binding).toMatchObject({
                            environmentId: localEnvironment,
                            projectId: localProjectId(lane),
                            threadId: localThreadId(lane),
                            instanceId,
                          });
                          expect(enabled.grant.context).toEqual(context);
                          fixture.configureLane(lane, enabled.grant, specialist);
                          // The task is offline until native RUN reads its inbox. Its immutable
                          // grant-context interests must match this briefing without explicit routing.
                          yield* remote[WS_METHODS.sharedActivityPublish]({
                            eventId: `briefing-${lane}`,
                            contextId: context.contextId,
                            contextVersion: context.contextVersion,
                            revision: context.revision,
                            kind: "briefing",
                            summary: `Catch up on task ${lane}`,
                            paths: ["src/api.ts"],
                            tags: [],
                            sources: [
                              {
                                title: `Task ${lane} retained revision`,
                                uri: snapshot
                                  ? `shared://snapshot/${snapshot.snapshotId}`
                                  : `shared://project/${context.sharedProjectId}/commit/${commit}`,
                              },
                            ],
                          });
                          settings.set(lane, {
                            local,
                            remote,
                            credential,
                            context,
                            localId: enabled.localId,
                            delegationId: enabled.grant.delegationId,
                          });
                        }
                        evidence.phase = "native-local-tools";
                        const beforeNativeTls = tls?.observe().trusted.upstreamConnections;
                        yield* Effect.all(
                          expansionLanes.map((lane) =>
                            runTask(settings.get(lane)!.local, lane, "RUN"),
                          ),
                          { concurrency: 2 },
                        );
                        if (tls) {
                          expect(tls.observe().trusted.upstreamConnections).toBeGreaterThan(
                            beforeNativeTls!,
                          );
                          evidence.nativeDelegationOverTls = true;
                        }
                        const observationA = fixture.observation("A");
                        const observationB = fixture.observation("B");
                        expect(observationA.inspectedSnapshot).toMatchObject({
                          applied: false,
                          snapshot: { snapshotId: settings.get("A")!.context.revision.snapshotId },
                        });
                        expect(observationB.inspectedSnapshot).toBeUndefined();
                        expect(observationA.completed && observationB.completed).toBe(true);
                        expect(observationA.request!.requestId).not.toBe(
                          observationB.request!.requestId,
                        );
                        expect(observationA.request!.nativeRequestId).not.toBe(
                          observationB.request!.nativeRequestId,
                        );
                        const anchorA = receiptAnchor(
                          observationA.request!.outcome.receipt?.receipt,
                        ).receipt;
                        const anchorB = receiptAnchor(
                          observationB.request!.outcome.receipt?.receipt,
                        ).receipt;
                        expect(anchorA.session_id).toBe(original.record.session_id);
                        expect(anchorB.session_id).toBe(original.record.session_id);
                        expect(anchorA.interaction_id).not.toBe(anchorB.interaction_id);
                        expect(observationA.request!.context.sharedProjectId).not.toBe(
                          observationB.request!.context.sharedProjectId,
                        );
                        expect(observationA.request!.context.revision.branch).not.toBe(
                          observationB.request!.context.revision.branch,
                        );
                        for (const lane of expansionLanes) {
                          const observed = fixture.observation(lane);
                          expect(observed.acknowledged).toBe(true);
                          const records = yield* settings
                            .get(lane)!
                            .remote[WS_METHODS.sharedKnowledgeSearch]({
                              sharedProjectId: settings.get(lane)!.context.sharedProjectId,
                              query: `Legacy ${lane} protocol`,
                            });
                          expect(records.records.map((record) => record.evidenceId)).toEqual([
                            observed.original!.evidenceId,
                          ]);
                          expect(
                            records.records[0]!.corrections.map((entry) => entry.evidenceId),
                          ).toEqual([observed.correction!.evidenceId]);
                          expect(records.records[0]!.hasMoreCorrections).toBe(false);
                          const correction = yield* settings
                            .get(lane)!
                            .remote[WS_METHODS.sharedKnowledgeSearch]({
                              evidenceId: observed.correction!.evidenceId,
                            });
                          expect(correction.records).toHaveLength(1);
                          expect(correction.records[0]).toMatchObject(observed.correction!);
                          expect(correction.records[0]!.supersedes).toEqual([
                            observed.original!.evidenceId,
                          ]);
                          expect(
                            `${correction.records[0]!.title} ${correction.records[0]!.body}`,
                          ).not.toContain(`Legacy ${lane} protocol`);
                          expect(
                            [...records.records, ...correction.records].every(
                              (record) =>
                                record.author.kind === "local_agent" &&
                                record.author.provenance?.localThreadId === localThreadId(lane),
                            ),
                          ).toBe(true);
                          const personInbox = yield* settings
                            .get(lane)!
                            .remote[WS_METHODS.sharedInboxRead]({});
                          const correctionNotice = personInbox.events.find(
                            (event) =>
                              event.knowledge?.evidenceId === observed.correction!.evidenceId,
                          );
                          expect(correctionNotice).toMatchObject({
                            kind: "correction",
                            author: observed.correction!.author,
                            context: settings.get(lane)!.context,
                            knowledge: {
                              evidenceId: observed.correction!.evidenceId,
                              supersedes: [observed.original!.evidenceId],
                            },
                          });
                          expect(correctionNotice?.recipientIds).toBeUndefined();
                          expect(
                            personInbox.events.find((event) => event.kind === "task_started"),
                          ).toMatchObject({
                            summary: settings.get(lane)!.context.objective,
                            context: settings.get(lane)!.context,
                            author: observed.correction!.author,
                          });
                          const inbox = yield* settings
                            .get(lane)!
                            .remote[WS_METHODS.sharedDelegationInvoke]({
                              delegationId: settings.get(lane)!.delegationId,
                              action: "inbox.list",
                              arguments: {},
                            });
                          const decoded = yield* inboxEvents(inbox);
                          expect(
                            decoded.events.some((event) => event.eventId === `briefing-${lane}`),
                          ).toBe(false);
                        }
                        evidence.phase = "revocation";
                        const beforeRevokeTls = tls?.observe().trusted.upstreamConnections;
                        const revoked = yield* a[WS_METHODS.sharedLocalDelegationRevoke]({
                          localId: settings.get("A")!.localId,
                        });
                        expect(revoked.revokedAt).not.toBeNull();
                        expect(revoked.grant?.revokedAt).toBeTruthy();
                        if (tls) {
                          expect(tls.observe().trusted.upstreamConnections).toBeGreaterThan(
                            beforeRevokeTls!,
                          );
                          evidence.remoteRevocationOverTls = true;
                        }
                        yield* runTask(a, "A", "DENIED");
                        expect(fixture.observation("A").denied).toBe(true);
                        const denied = yield* alice[WS_METHODS.sharedDelegationInvoke]({
                          delegationId: settings.get("A")!.delegationId,
                          action: "projects.list",
                          arguments: {},
                        }).pipe(
                          Effect.match({
                            onFailure: (cause) => cause._tag,
                            onSuccess: () => "unexpected-success",
                          }),
                        );
                        expect(denied).toBe("SharedWorkspaceError");
                        evidence.phase = "autonomous-independent-growth";
                        fixture.configureGrowth({
                          operationId: "autonomous-independent-growth",
                          kind: "create",
                          creations: [
                            {
                              key: "contract",
                              anchorSharedProjectId: projectB.sharedProjectId,
                              instanceId,
                              label: "Contract specialist",
                              role: "contract-specialist",
                              instructions:
                                "Own future client contract analysis using explicit project revisions.",
                              model: workflowModel,
                              assignments: [assignments[1]!],
                            },
                          ],
                          revisions: [],
                          peers: [
                            {
                              source: {
                                specialistId: specialist.specialistId,
                                expectedVersion: specialist.assignmentVersion,
                              },
                              target: { creationKey: "contract" },
                            },
                          ],
                          transitions: [],
                        });
                        const context = settings.get("A")!.context;
                        const growth = yield* alice[WS_METHODS.sharedSpecialistSend]({
                          specialistId: specialist.specialistId,
                          requestId: "request-independent-growth",
                          contextId: context.contextId,
                          contextVersion: context.contextVersion,
                          text: growthMarker,
                        });
                        const completedGrowth = yield* waitRequest(alice, growth.requestId);
                        expect(result(completedGrowth.outcome.completion?.payload).result).toBe(
                          growthFinal,
                        );
                        const operation = fixture.growth();
                        expect(operation?.status).toBe("completed");
                        expect(operation?.creations).toHaveLength(1);
                        const created = operation!.creations[0]!;
                        expect(created.specialistId).toBeTruthy();
                        expect(created.nativeTarget.agentId).not.toBe(agent.agentId);
                        expect(created.nativeTarget.projectId).toBe(hostProjectId("B"));
                        const after = (yield* admin[WS_METHODS.sharedWorkspaceSession]({}))
                          .snapshot;
                        expect(after.specialists).toHaveLength(2);
                        expect(
                          after.specialists.find(
                            (entry) => entry.specialistId === specialist.specialistId,
                          ),
                        ).toEqual(specialist);
                        const next = (yield* admin[WS_METHODS.meerkatProjectTeam]({
                          projectId: hostProjectId("B"),
                        })).providers
                          .flatMap((provider) => provider.agents)
                          .find((value) => value.projectAgentId === created.nativeTarget.agentId);
                        expect(next).toBeDefined();
                        expect(next!.mobKind).toBe("domain");
                        expect(next!.record.labels.source_mob_id).toBeUndefined();
                        expect(next!.observedAccessMode).toBe("repository-read-only");
                        expect(next!.mobId).not.toBe(original.mobId);
                        expect(next!.record.session_id).not.toBe(original.record.session_id);
                        expect(next!.record.session_id).toBeTruthy();
                        const edges = yield* admin[WS_METHODS.meerkatPeerConnections]({
                          endpoint: { kind: "project-agent", ...specialist.nativeTarget },
                        });
                        expect(
                          edges.connections.some(
                            (edge) =>
                              edge.status === "connected" &&
                              edge.desired &&
                              edge.edgeId ===
                                operation!.evidence.find((entry) => entry.kind === "native_peer")
                                  ?.peerEdgeId,
                          ),
                        ).toBe(true);
                        expect(
                          (yield* alice[WS_METHODS.sharedSpecialistRequest]({
                            requestId: growth.requestId,
                          })).outcome.status,
                        ).toBe("completed");
                        evidence.phase = "native-peer-inbox-observation";
                        // The independently owned successor is already natively peered.
                        // Its real comms tool triggers a turn with no shared request record.
                        yield* admin[WS_METHODS.meerkatAgentSend]({
                          projectId: created.nativeTarget.projectId,
                          instanceId: created.nativeTarget.instanceId,
                          agentRef: next!.agentRef,
                          requestId: "inbox-peer-trigger",
                          text: inboxPeerSenderMarker,
                          handlingMode: "queue",
                        });
                        yield* Effect.gen(function* () {
                          for (;;) {
                            const roster = yield* admin[WS_METHODS.meerkatProjectTeam]({
                              projectId: specialist.nativeTarget.projectId,
                            });
                            const observed = roster.providers
                              .flatMap((provider) => provider.agents)
                              .find(
                                (entry) => entry.projectAgentId === specialist.nativeTarget.agentId,
                              );
                            if (
                              observed?.work?.status === "idle" &&
                              observed.work.outcome === inboxPeerFinal
                            )
                              return;
                            if (fixture.errors.length) throw new Error(fixture.errors.join("; "));
                            yield* Effect.sleep("100 millis");
                          }
                        }).pipe(Effect.timeout("45 seconds"));
                        const inboxObservation = fixture.inboxObservation();
                        expect(inboxObservation.senderStep).toBe(3);
                        expect(inboxObservation.participantWriteRejected).toBe(true);
                        expect(inboxObservation.unchangedInbox).toEqual(inboxObservation.inbox);
                        expect(inboxObservation.knowledge!.revision).toEqual(
                          settings.get("A")!.context.revision,
                        );
                        const retainedObservation = yield* alice[WS_METHODS.sharedKnowledgeSearch]({
                          evidenceId: inboxObservation.knowledge!.evidenceId,
                        });
                        expect(retainedObservation.records).toMatchObject([
                          inboxObservation.knowledge!,
                        ]);
                        for (const lane of expansionLanes) {
                          const admitted = fixture.observation(lane).request!;
                          const afterPeer = yield* settings
                            .get(lane)!
                            .remote[WS_METHODS.sharedSpecialistRequest]({
                              requestId: admitted.requestId,
                            });
                          expect(afterPeer.outcome).toEqual(admitted.outcome);
                          expect(afterPeer.context).toEqual(admitted.context);
                          expect(afterPeer.author).toEqual(admitted.author);
                        }
                        evidence.inboxObservation = inboxObservation;
                        evidence.phase = "native-self-revision";
                        const revisedAssignments = specialist.assignments.map((assignment) => ({
                          ...assignment,
                          charter: `${assignment.charter}. Track explicit backward compatibility evidence.`,
                        }));
                        fixture.configureSelfRevision({
                          operationId: "self-revision-at-native-idle",
                          kind: "revise",
                          creations: [],
                          revisions: [
                            {
                              specialistId: specialist.specialistId,
                              expectedVersion: specialist.assignmentVersion,
                              assignments: revisedAssignments,
                              instructions:
                                "Own cross-project compatibility using immutable evidence and explain corrections to prior conclusions.",
                            },
                          ],
                          peers: [],
                          transitions: [],
                        });
                        const revisionRequest = yield* alice[WS_METHODS.sharedSpecialistSend]({
                          specialistId: specialist.specialistId,
                          requestId: "request-self-revision",
                          contextId: context.contextId,
                          contextVersion: context.contextVersion,
                          text: selfRevisionMarker,
                        });
                        const admittedRevision = yield* waitRequest(
                          alice,
                          revisionRequest.requestId,
                        );
                        expect(result(admittedRevision.outcome.completion?.payload).result).toBe(
                          selfRevisionFinal,
                        );
                        const pendingRevision = fixture.selfRevision()!.pending!;
                        expect(pendingRevision.status).toBe("pending");
                        // No second mutation or caller retry is made. The server worker must
                        // activate the saved native revision after the requesting turn ends.
                        const revised = yield* Effect.gen(function* () {
                          for (;;) {
                            const snapshot = (yield* admin[WS_METHODS.sharedWorkspaceSession]({}))
                              .snapshot;
                            const current = snapshot.specialists.find(
                              (entry) => entry.specialistId === specialist.specialistId,
                            );
                            if (current?.assignmentVersion === specialist.assignmentVersion + 1)
                              return current;
                            yield* Effect.sleep("100 millis");
                          }
                        }).pipe(Effect.timeout("60 seconds"));
                        expect(revised.nativeTarget).toEqual(specialist.nativeTarget);
                        expect(revised.assignments).toEqual(revisedAssignments);
                        expect(revised.supersededAt).toBeNull();
                        const observeRevision = yield* alice[WS_METHODS.sharedSpecialistSend]({
                          specialistId: specialist.specialistId,
                          requestId: "observe-self-revision",
                          contextId: context.contextId,
                          contextVersion: context.contextVersion,
                          text: selfRevisionObserveMarker,
                        });
                        const observedRevision = yield* waitRequest(
                          alice,
                          observeRevision.requestId,
                        );
                        expect(result(observedRevision.outcome.completion?.payload).result).toBe(
                          selfRevisionObservedFinal,
                        );
                        const selfRevision = fixture.selfRevision()!.completed!;
                        expect(selfRevision.operationKey).toBe(pendingRevision.operationKey);
                        expect(selfRevision.actor).toEqual(pendingRevision.actor);
                        expect(selfRevision.evidence[0]).toMatchObject({
                          kind: "native_revision",
                          nativeTarget: specialist.nativeTarget,
                          sessionId: original.record.session_id,
                        });
                        expect(selfRevision.evidence[0]!.revisionId).toBeTruthy();
                        const retainedTeam = yield* admin[WS_METHODS.meerkatProjectTeam]({
                          projectId: hostProjectId("A"),
                        });
                        const retainedDefinition = retainedTeam.projectAgents.find(
                          (entry) => entry.agentId === specialist.nativeTarget.agentId,
                        );
                        expect(retainedDefinition).toMatchObject({
                          revisionVersion: (agent.revisionVersion ?? 0) + 1,
                          pendingRevision: null,
                          enabled: true,
                          archived: false,
                        });
                        expect(retainedDefinition!.instructions).toContain(
                          fixture.selfRevision()!.plan.revisions[0]!.instructions,
                        );
                        const retainedNative = retainedTeam.providers
                          .flatMap((provider) => provider.agents)
                          .filter(
                            (entry) => entry.projectAgentId === specialist.nativeTarget.agentId,
                          );
                        expect(retainedNative).toHaveLength(1);
                        expect(retainedNative[0]).toMatchObject({
                          mobId: original.mobId,
                          availability: "live",
                          observedAccessMode: "repository-read-only",
                          record: { session_id: original.record.session_id, addressable: true },
                        });
                        expect(
                          (yield* alice[WS_METHODS.sharedSpecialistRequest]({
                            requestId: growth.requestId,
                          })).outcome.status,
                        ).toBe("completed");
                        evidence.selfRevision = {
                          pending: pendingRevision,
                          completed: selfRevision,
                        };
                        evidence.localGrants = expansionLanes.map((lane) => ({
                          lane,
                          context: settings.get(lane)!.context,
                          delegationId: settings.get(lane)!.delegationId,
                          observation: fixture.observation(lane),
                        }));
                        evidence.independentIdentities = [
                          { mobId: original.mobId, sessionId: original.record.session_id },
                          { mobId: next!.mobId, sessionId: next!.record.session_id },
                        ];
                      }),
                    ),
                  ),
                ),
              );
              expect(fixture.errors).toEqual([]);
              if (tls) {
                const observed = tls.observe();
                expect(observed.trusted.upstreamErrors).toBe(0);
                expect(observed.trusted.receivedBytes).toBeGreaterThan(0);
                expect(observed.trusted.sentBytes).toBeGreaterThan(0);
                expect(observed.trusted.protocols.length).toBeGreaterThan(0);
                expect(
                  observed.trusted.protocols.every((protocol) =>
                    ["TLSv1.2", "TLSv1.3"].includes(protocol),
                  ),
                ).toBe(true);
              }
              evidence.phase = "complete";
              evidence.proofs = [
                "three-real-servers",
                "two-canonical-projects",
                "selected-local-worktrees",
                "actual-local-patch-capture-and-grant-validation",
                "native-immutable-snapshot-read",
                "one-cross-project-specialist",
                "native-delegated-tools",
                "broker-context-injection",
                "exact-request-outcomes",
                "attributed-local-agent-evidence",
                "retained-knowledge-correction",
                "original-search-exposes-correction-and-exact-fetch",
                "offline-inbox-sealed-retry-and-ack",
                "local-and-remote-revocation",
                "native-autonomous-permanent-create-and-peer",
                "native-peer-inbox-derived-publication",
                "inbox-source-cannot-borrow-participant-attribution",
                "inbox-publication-preserves-request-outcomes-and-sealed-batch",
                "growth-preserves-predecessor-before-explicit-self-revision",
                "self-revision-continues-at-native-idle-with-same-identity",
              ];
            }),
          );
        }).pipe(Effect.timeout("360 seconds"), Effect.scoped),
      // TLS acquisition is uninterruptible until the already-registered finalizer
      // owns it. Six 15s OpenSSL commands and three 10s listeners add at most 120s
      // to a timed-out 360s body, before parallel native cleanup and 10s settlement.
      fixtureTimeoutMs(360_000) + (tlsEnabled ? 130_000 : 10_000),
    );
  },
);

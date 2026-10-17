// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - opt-in actual server/native boundary proof with disposable state and no paid provider.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  CommandId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type MeerkatTeamAgent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import {
  availablePort,
  bounded,
  exchangeToken,
  fixtureTimeoutMs,
  ownedServer,
  prepareFixture,
  readRetainedNativeHistory,
  withClient,
  workflowModel,
} from "./MeerkatWorkflow.server.native.support.ts";
import {
  childMobId,
  childSpawnText,
  controlledSteeringProvider,
  finalText,
  inputWithMarker,
  locateNativeInputs,
  readNativeInputs,
  startText,
  steerText,
  survivorFinal,
  survivorText,
  transcriptUserCount,
  waitFor,
} from "./MeerkatSteering.server.native.support.ts";

const serverEntry = process.env.T3CODE_TEST_MEERKAT_SERVER_ENTRY;
const runtimeDirectory = process.env.T3CODE_TEST_MEERKAT_RUNTIME_DIR;
const instanceId = ProviderInstanceId.make("meerkat");
const projectId = ProjectId.make("steering-boundary-project");
const threadId = ThreadId.make("steering-boundary-thread");
const modelSelection = { instanceId, model: workflowModel };
const now = () => DateTime.formatIso(DateTime.nowUnsafe());
const encodeEvidence = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const surfaces = ["thread", "project-agent", "owned-child"] as const;

async function initializeRepository(path: string, env: NodeJS.ProcessEnv) {
  const git = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      NodeChildProcess.execFile("/usr/bin/git", args, { cwd: path, env }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Steering fixture"]);
  await git(["config", "user.email", "steering@example.invalid"]);
  await NodeFSP.writeFile(NodePath.join(path, "fixture.txt"), "Native steering boundary fixture\n");
  await git(["add", "fixture.txt"]);
  await git(["commit", "-m", "Initialize private steering fixture"]);
}

describe.skipIf(!serverEntry || !runtimeDirectory)(
  "actual public native steering boundaries",
  () => {
    for (const surface of surfaces)
      it.live(
        `${surface}: admits one User steer into the original native run at a tool boundary`,
        () =>
          Effect.gen(function* () {
            if (!serverEntry || !runtimeDirectory)
              throw new Error("Supply prebuilt server entry and runtime directory");
            expect(NodePath.isAbsolute(serverEntry) && NodePath.isAbsolute(runtimeDirectory)).toBe(
              true,
            );
            const root = yield* Effect.promise(async () =>
              NodeFSP.realpath(
                await NodeFSP.mkdtemp(
                  NodePath.join(NodeOS.tmpdir(), `t3-native-steering-${surface}-`),
                ),
              ),
            );
            yield* Effect.promise(() => NodeFSP.chmod(root, 0o700));
            const fixture = controlledSteeringProvider();
            let server: ReturnType<typeof ownedServer> | undefined;
            const evidence: Record<string, unknown> = { surface, phase: "setup" };
            yield* Effect.addFinalizer((exit) =>
              Effect.gen(function* () {
                let clean = false;
                yield* Effect.promise(async () => {
                  const evidenceRoot = NodePath.join(root, "evidence");
                  await NodeFSP.mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
                  await NodeFSP.writeFile(
                    NodePath.join(evidenceRoot, "steering-boundaries.json"),
                    encodeEvidence({
                      ...evidence,
                      boundaries: fixture.boundaries,
                      errors: fixture.errors,
                    }),
                    { mode: 0o600 },
                  );
                  fixture.beginTeardown();
                  try {
                    await server?.close();
                    clean = true;
                  } finally {
                    if (clean) {
                      fixture.provider.closeAllConnections();
                      if (fixture.provider.listening)
                        await new Promise<void>((resolve, reject) =>
                          fixture.provider.close((error) => (error ? reject(error) : resolve())),
                        );
                    }
                    await NodeFSP.writeFile(
                      NodePath.join(evidenceRoot, "steering-acceptance.json"),
                      encodeEvidence({
                        ...evidence,
                        passed: Exit.isSuccess(exit) && clean,
                        cleanupComplete: clean,
                        providerErrors: fixture.errors,
                        shutdown: server
                          ? {
                              pid: server.child.pid,
                              code: server.child.exitCode,
                              signal: server.child.signalCode,
                              ...server.shutdownObservation(),
                            }
                          : null,
                      }),
                      { mode: 0o600 },
                    );
                  }
                }).pipe(
                  Effect.ensuring(
                    Effect.suspend(() =>
                      Exit.isFailure(exit) || !clean
                        ? Effect.logError(
                            `Native steering ${surface} failed; private evidence retained at ${root}`,
                          )
                        : Effect.logInfo(`Native steering ${surface} evidence retained at ${root}`),
                    ),
                  ),
                );
              }),
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
              throw new Error("No fixture provider port");
            const prepared = yield* Effect.promise(() =>
              prepareFixture(root, runtimeDirectory, address.port),
            ).pipe(Effect.uninterruptible);
            evidence.manifest = prepared.manifest;
            yield* Effect.promise(() => initializeRepository(prepared.projectPath, prepared.env));
            const port = yield* Effect.promise(availablePort);
            expect(port).not.toBe(52258);
            const origin = `http://127.0.0.1:${port}`;
            server = ownedServer(
              serverEntry,
              prepared.projectPath,
              prepared.baseDir,
              port,
              prepared.env,
              prepared.shutdownHorizonMs,
              NodePath.join(prepared.evidenceRoot, "server-diagnostics.json"),
            );
            const readiness = server.ready;
            const bearer = yield* exchangeToken(
              origin,
              yield* Effect.promise(() => bounded(readiness, "actual T3 readiness", 60_000)),
            );
            yield* withClient(origin, bearer, (client) =>
              Effect.gen(function* () {
                const config = yield* client[WS_METHODS.serverGetConfig]({});
                expect(
                  config.providers
                    .filter((provider) => provider.enabled)
                    .map((provider) => provider.instanceId),
                ).toEqual([instanceId]);
                expect(
                  config.providers.find((provider) => provider.instanceId === instanceId)?.status,
                ).toBe("ready");
                yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                  type: "project.create",
                  commandId: CommandId.make("steering-create-project"),
                  projectId,
                  title: "Steering boundary fixture",
                  workspaceRoot: prepared.projectPath,
                  createdAt: now(),
                });
                const createAgent = (requestId: string) =>
                  client[WS_METHODS.meerkatProjectAgentCreate]({
                    accessMode: "full-access",
                    projectId,
                    instanceId,
                    requestId,
                    label: requestId,
                    role: "specialist",
                    instructions: "Follow the user's instructions in this isolated fixture.",
                    model: workflowModel,
                  });
                const independent = yield* createAgent("steering-independent");
                expect(independent.connectionStatus, independent.error ?? undefined).toBe(
                  "connected",
                );
                expect(independent.agentRef).toBeTruthy();
                const independentRef = independent.agentRef!;
                const initialTeam = yield* client[WS_METHODS.meerkatProjectTeam]({ projectId });
                const independentSession = initialTeam.providers
                  .flatMap((provider) => provider.agents)
                  .find((agent) => agent.agentRef === independentRef)?.record.session_id;
                expect(independentSession).toBeTruthy();
                const sendAgent = (
                  agentRef: string,
                  text: string,
                  handlingMode: "queue" | "steer",
                  requestId: string,
                ) =>
                  client[WS_METHODS.meerkatAgentSend]({
                    projectId,
                    instanceId,
                    agentRef,
                    text,
                    handlingMode,
                    requestId,
                  });
                const sendThread = (text: string, handlingMode: "queue" | "steer", id: string) =>
                  client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                    type: "thread.turn.start",
                    commandId: CommandId.make(`steering-${id}`),
                    threadId,
                    message: {
                      messageId: MessageId.make(`steering-message-${id}`),
                      role: "user",
                      text,
                      attachments: [],
                    },
                    modelSelection,
                    handlingMode,
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    createdAt: now(),
                  });
                const readThread = () =>
                  client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId }).pipe(
                    Stream.filter((item) => item.kind === "snapshot"),
                    Stream.runHead,
                    Effect.map(Option.getOrThrow),
                    Effect.map((item) => item.snapshot.thread),
                  );
                let targetRef: string | undefined;
                evidence.phase = "start-original-input";
                if (surface === "project-agent") {
                  const target = yield* createAgent("steering-target");
                  expect(target.connectionStatus, target.error ?? undefined).toBe("connected");
                  expect(target.agentRef).toBeTruthy();
                  targetRef = target.agentRef!;
                  expect(
                    (yield* sendAgent(targetRef, startText, "queue", "steering-original")).status,
                  ).toBe("accepted");
                } else {
                  yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                    type: "thread.create",
                    commandId: CommandId.make("steering-create-thread"),
                    threadId,
                    projectId,
                    title: "Native steering boundary",
                    modelSelection,
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    branch: "main",
                    worktreePath: null,
                    createdAt: now(),
                  });
                  yield* sendThread(
                    surface === "thread" ? startText : childSpawnText,
                    "queue",
                    "original",
                  );
                }
                yield* Effect.promise(() =>
                  bounded(fixture.started, "original native provider request", 45_000),
                );
                const team = yield* client[WS_METHODS.meerkatProjectTeam]({ projectId });
                const targets = team.providers
                  .flatMap((provider) => provider.agents)
                  .filter((agent) => {
                    if (surface === "project-agent") return agent.agentRef === targetRef;
                    if (surface === "owned-child")
                      return (
                        agent.threadId === threadId &&
                        agent.record.labels.source_mob_id === childMobId
                      );
                    return (
                      agent.threadId === threadId &&
                      agent.record.runtime_member_id === "ingress" &&
                      !agent.record.labels.source_mob_id
                    );
                  });
                expect(targets).toHaveLength(1);
                const target: MeerkatTeamAgent = targets[0]!;
                targetRef = target.agentRef;
                expect(target.record.session_id).toBeTruthy();
                const sessionId = target.record.session_id!;
                expect(sessionId).not.toBe(independentSession);
                const databasePath = yield* Effect.promise(() =>
                  locateNativeInputs(prepared.nativeRoot, sessionId),
                );
                const original = inputWithMarker(
                  readNativeInputs(databasePath, sessionId),
                  startText,
                );
                expect(original.last_run_id).toBeTruthy();
                expect(original.terminal_outcome).toBeUndefined();
                const originalRun = original.last_run_id!;
                evidence.target = {
                  agentRef: targetRef,
                  sessionId,
                  inputId: original.input_id,
                  runId: originalRun,
                  databasePath,
                };
                const beforeThread = surface === "thread" ? yield* readThread() : undefined;
                evidence.phase = "admit-steering-input";
                if (surface === "thread") {
                  const publicWork = yield* client[WS_METHODS.meerkatCoordinatorWork]({
                    projectId,
                    instanceId,
                    threadId,
                  });
                  expect(publicWork.sessionId).toBe(sessionId);
                  expect(
                    publicWork.inputs.some(
                      (input) => input.inputId === original.input_id && input.runId === originalRun,
                    ),
                  ).toBe(true);
                  yield* sendThread(steerText, "steer", "append");
                } else
                  expect(
                    (yield* sendAgent(targetRef, steerText, "steer", "steering-append")).status,
                  ).toBe("accepted");
                // Console/T3 admission may precede native dispatch. Do not release the held
                // model until the exact steering payload is durably admitted by native.
                const admitted = yield* Effect.promise(() =>
                  waitFor(
                    () => readNativeInputs(databasePath, sessionId),
                    (rows) =>
                      rows.some((row) => JSON.stringify(row.persisted_input)?.includes(steerText)),
                    "exact native steering input admission",
                  ),
                );
                const steering = inputWithMarker(admitted, steerText);
                expect(steering.input_id).not.toBe(original.input_id);
                evidence.admittedSteering = steering;
                evidence.phase = "original-run-tool-boundaries";
                fixture.installObservation(() => {
                  const rows = readNativeInputs(databasePath, sessionId);
                  const currentOriginal = rows.find((row) => row.input_id === original.input_id);
                  const currentSteer = rows.find((row) => row.input_id === steering.input_id);
                  expect(currentOriginal).toBeTruthy();
                  expect(currentSteer).toBeTruthy();
                  expect(currentOriginal!.last_run_id).toBe(originalRun);
                  expect(
                    currentOriginal!.terminal_outcome,
                    "Original native input must still be executing at this model boundary",
                  ).toBeUndefined();
                  // A queued steer has no run association yet. Once applied, it must join
                  // this original run; an app-level continuation cannot satisfy the proof.
                  if (currentSteer!.last_run_id)
                    expect(currentSteer!.last_run_id).toBe(originalRun);
                  return { original: currentOriginal!, steering: currentSteer! };
                });
                fixture.releaseFirst();
                yield* Effect.promise(() =>
                  bounded(fixture.observed, "one User steer in original native run", 30_000),
                );
                const whileHeld = readNativeInputs(databasePath, sessionId);
                const joinedSteer = whileHeld.find((row) => row.input_id === steering.input_id)!;
                expect(joinedSteer.last_run_id).toBe(originalRun);
                if (surface === "thread") {
                  const stillThread = yield* readThread();
                  expect(stillThread.latestTurn?.turnId).toBe(beforeThread?.latestTurn?.turnId);
                  expect(stillThread.session?.activeTurnId).toBe(
                    beforeThread?.session?.activeTurnId,
                  );
                }
                evidence.phase = "independent-session-continuation";
                expect(
                  (yield* sendAgent(
                    independentRef,
                    survivorText,
                    "queue",
                    "steering-independent-input",
                  )).status,
                ).toBe("accepted");
                yield* Effect.promise(() =>
                  bounded(fixture.survivor, "independent native session response"),
                );
                yield* Effect.gen(function* () {
                  for (;;) {
                    const snapshot = yield* client[WS_METHODS.meerkatProjectTeam]({ projectId });
                    const agent = snapshot.providers
                      .flatMap((provider) => provider.agents)
                      .find((entry) => entry.agentRef === independentRef);
                    expect(agent?.record.session_id).toBe(independentSession);
                    if (agent?.work?.status === "idle" && agent.work.outcome === survivorFinal)
                      return;
                    yield* Effect.sleep("100 millis");
                  }
                }).pipe(Effect.timeout("30 seconds"));
                evidence.phase = "native-terminal-receipts";
                fixture.releaseFinal();
                yield* Effect.promise(() =>
                  bounded(fixture.completed, "original native final response"),
                );
                const settled = yield* Effect.promise(() =>
                  waitFor(
                    () => readNativeInputs(databasePath, sessionId),
                    (rows) =>
                      [original.input_id, steering.input_id].every(
                        (id) =>
                          rows.find((row) => row.input_id === id)?.terminal_completion?.phase
                            .phase === "finalized",
                      ),
                    "exact original and steering native terminal receipts",
                  ),
                );
                for (const id of [original.input_id, steering.input_id]) {
                  const input = settled.find((row) => row.input_id === id)!;
                  expect(input.last_run_id).toBe(originalRun);
                  expect(input.current_state).toBe("consumed");
                  expect(input.terminal_completion?.input_id).toBe(id);
                  expect(input.terminal_completion?.batch_key).toEqual({
                    scope: "run",
                    run_id: originalRun,
                  });
                  expect(input.terminal_completion?.phase.finalization).toBe("succeeded");
                }
                evidence.phase = "saved-native-history";
                // The exact session store was located above. Domain agents
                // have their own native root, separate from project threads.
                const nativeStateRoot = NodePath.dirname(
                  NodePath.dirname(NodePath.dirname(databasePath)),
                );
                const [history] = yield* readRetainedNativeHistory({
                  binaryPath: NodePath.join(runtimeDirectory, prepared.manifest.binary),
                  projectPath: prepared.projectPath,
                  nativeRoot: prepared.nativeRoot,
                  stateRoot: nativeStateRoot,
                  instanceId,
                  env: prepared.env,
                  agents: [target],
                });
                expect(history?.transcript?.sessionId).toBe(sessionId);
                const saved = history?.transcript?.messages.map((message) => message.message) ?? [];
                expect(transcriptUserCount(saved, startText)).toBe(1);
                expect(transcriptUserCount(saved, steerText)).toBe(1);
                expect(encodeEvidence(saved)).toContain(finalText);
                evidence.phase = "public-completion";
                yield* Effect.gen(function* () {
                  for (;;) {
                    if (surface === "thread") {
                      const thread = yield* readThread();
                      if (
                        thread.latestTurn?.state === "completed" &&
                        thread.session?.status === "ready"
                      ) {
                        expect(
                          thread.messages.filter(
                            (message) =>
                              message.role === "assistant" &&
                              message.text === finalText &&
                              !message.streaming,
                          ),
                        ).toHaveLength(1);
                        expect(thread.latestTurn.turnId).toBe(beforeThread?.latestTurn?.turnId);
                        return;
                      }
                    } else {
                      const snapshot = yield* client[WS_METHODS.meerkatProjectTeam]({ projectId });
                      const agent = snapshot.providers
                        .flatMap((provider) => provider.agents)
                        .find((entry) => entry.agentRef === targetRef);
                      expect(agent?.record.session_id).toBe(sessionId);
                      if (agent?.work?.status === "idle" && agent.work.outcome === finalText) {
                        expect(agent.work.latestCompletion?.status).toBe("completed");
                        if (surface === "owned-child") {
                          expect(agent.work.latestCompletion).toMatchObject({
                            kind: "runtime_input",
                            sessionId,
                            runId: originalRun,
                          });
                        }
                        evidence.publicCompletion = agent.work.latestCompletion;
                        return;
                      }
                    }
                    yield* Effect.sleep("100 millis");
                  }
                }).pipe(Effect.timeout("30 seconds"));
                evidence.settled = settled;
                evidence.savedRevision = history?.transcript?.storeRevision;
                expect(fixture.errors).toEqual([]);
                expect(fixture.boundaries.some((boundary) => boundary.exactUserAppends === 1)).toBe(
                  true,
                );
                evidence.phase = "complete";
              }),
            ).pipe(Effect.raceFirst(Effect.promise(() => fixture.failed)));
          }).pipe(Effect.timeout(180_000), Effect.scoped),
        fixtureTimeoutMs(180_000) + 10_000,
      );
  },
);

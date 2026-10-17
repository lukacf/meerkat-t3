// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - opt-in actual server/native acceptance with disposable state and no paid provider.
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
  MeerkatProjectAgentPreparation,
  type MeerkatProjectAgent,
  type MeerkatProjectTeam,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
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
} from "./MeerkatWorkflow.server.native.support.ts";
import {
  brief,
  busyFinal,
  busyText,
  controlledSpecialistProvider,
  coordinatorAfter,
  coordinatorBefore,
  fileContents,
  messageTexts,
  originalInstructions,
  persistedSpecialist,
  readSpecialistHistory,
  revisedCharter,
  revisedFocus,
  revisedInstructions,
  savedAssistantTexts,
  specialistLabel,
} from "./MeerkatSpecialistRevision.server.native.support.ts";

const serverEntry = process.env.T3CODE_TEST_MEERKAT_SERVER_ENTRY;
const runtimeDirectory = process.env.T3CODE_TEST_MEERKAT_RUNTIME_DIR;
const instanceId = ProviderInstanceId.make("meerkat");
const projectId = ProjectId.make("specialist-revision-project");
const threadId = ThreadId.make("specialist-revision-coordinator");
const modelSelection = { instanceId, model: workflowModel };
const now = () => DateTime.formatIso(DateTime.nowUnsafe());
const encodeEvidence = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodePreparation = Schema.decodeUnknownSync(MeerkatProjectAgentPreparation);

async function initializeRepository(path: string, env: NodeJS.ProcessEnv) {
  const git = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      NodeChildProcess.execFile("/usr/bin/git", args, { cwd: path, env }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Specialist revision fixture"]);
  await git(["config", "user.email", "specialist@example.invalid"]);
  await NodeFSP.mkdir(NodePath.join(path, "src"));
  await NodeFSP.writeFile(NodePath.join(path, "src", "core.ts"), fileContents(1));
  await git(["add", "src/core.ts"]);
  await git(["commit", "-m", "Initialize private specialist fixture"]);
}

function specialist(team: MeerkatProjectTeam, agentId: string) {
  const matches = team.projectAgents.filter((agent) => agent.agentId === agentId);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe.skipIf(!serverEntry || !runtimeDirectory)(
  "actual specialist responsibility and study revision",
  () => {
    it.live(
      "stages a busy revision, applies it once, and refreshes dirty files in the same connected native session",
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
                NodePath.join(NodeOS.tmpdir(), "t3-native-specialist-revision-"),
              ),
            ),
          );
          yield* Effect.promise(() => NodeFSP.chmod(root, 0o700));
          const fixture = controlledSpecialistProvider();
          let server: ReturnType<typeof ownedServer> | undefined;
          const evidence: Record<string, unknown> = { phase: "setup" };
          yield* Effect.addFinalizer((exit) =>
            Effect.gen(function* () {
              let cleanupComplete = false;
              yield* Effect.promise(async () => {
                fixture.beginTeardown();
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
                  const evidenceRoot = NodePath.join(root, "evidence");
                  await NodeFSP.mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
                  await NodeFSP.writeFile(
                    NodePath.join(evidenceRoot, "specialist-revision-acceptance.json"),
                    encodeEvidence({
                      ...evidence,
                      passed: Exit.isSuccess(exit) && cleanupComplete,
                      cleanupComplete,
                      providerRequests: fixture.requestCount(),
                      completed: [...fixture.completed].sort(),
                      checkedTools: fixture.checkedTools,
                      peers: Object.fromEntries(fixture.peers),
                      studies: fixture.studies.map(({ fingerprint, probe }) => ({
                        fingerprint,
                        probe,
                      })),
                      errors: fixture.errors,
                    }),
                    { mode: 0o600 },
                  );
                }
              }).pipe(
                Effect.ensuring(Effect.logInfo(`Specialist revision evidence retained at ${root}`)),
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
            throw new Error("No controlled provider port");
          const prepared = yield* Effect.promise(() =>
            prepareFixture(root, runtimeDirectory, address.port),
          ).pipe(Effect.uninterruptible);
          evidence.manifest = prepared.manifest;
          yield* Effect.promise(() => initializeRepository(prepared.projectPath, prepared.env));
          fixture.setWorkspace(prepared.projectPath);
          const databasePath = NodePath.join(prepared.baseDir, "userdata", "state.sqlite");
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
                commandId: CommandId.make("specialist-create-project"),
                projectId,
                title: "Specialist responsibility revision",
                workspaceRoot: prepared.projectPath,
                createdAt: now(),
              });
              const created = yield* client[WS_METHODS.meerkatProjectAgentCreate]({
                accessMode: "full-access",
                projectId,
                instanceId,
                requestId: "specialist-create",
                label: specialistLabel,
                role: "core-specialist",
                instructions: originalInstructions,
                model: workflowModel,
              });
              expect(created.connectionStatus, created.error ?? undefined).toBe("connected");
              expect(created.agentRef).toBeTruthy();
              expect(created.revisionVersion).toBe(1);
              const agentRef = created.agentRef!;
              const initialTeam = yield* client[WS_METHODS.meerkatProjectTeam]({ projectId });
              const originals = initialTeam.providers
                .flatMap((provider) => provider.agents)
                .filter((agent) => agent.agentRef === agentRef);
              expect(originals).toHaveLength(1);
              const original = originals[0]!;
              expect(original.record.session_id).toBeTruthy();
              const sessionId = original.record.session_id!;
              const assertIdentity = (team: MeerkatProjectTeam) => {
                const domain = specialist(team, created.agentId);
                expect(domain.agentRef).toBe(agentRef);
                const agents = team.providers
                  .flatMap((provider) => provider.agents)
                  .filter((agent) => agent.agentRef === agentRef);
                expect(agents).toHaveLength(1);
                expect(agents[0]!.mobId).toBe(original.mobId);
                expect(agents[0]!.record.session_id).toBe(sessionId);
                expect(agents[0]!.record.identity).toBe(original.record.identity);
                expect(agents[0]!.record.runtime_key).toBe(original.record.runtime_key);
                expect(agents[0]!.record.runtime_member_id).toBe(original.record.runtime_member_id);
                return agents[0]!;
              };
              evidence.target = {
                agentId: created.agentId,
                agentRef,
                sessionId,
                mobId: original.mobId,
              };
              const waitIdle = (ref: string, outcome: string) =>
                Effect.gen(function* () {
                  for (;;) {
                    const team = yield* client[WS_METHODS.meerkatProjectTeam]({ projectId });
                    const agent = team.providers
                      .flatMap((provider) => provider.agents)
                      .find((entry) => entry.agentRef === ref);
                    if (agent?.work?.status === "idle" && agent.work.outcome === outcome)
                      return team;
                    yield* Effect.sleep("100 millis");
                  }
                }).pipe(Effect.timeout("30 seconds"));
              const waitStudy = (attempt: number) =>
                Effect.gen(function* () {
                  for (;;) {
                    const team = yield* client[WS_METHODS.meerkatProjectTeam]({ projectId });
                    const domain = specialist(team, created.agentId);
                    const runtime = assertIdentity(team);
                    const state = domain.preparation;
                    expect(state?.attempt).toBe(attempt);
                    if (state && ["failed", "interrupted", "uncertain"].includes(state.status))
                      throw new Error(
                        `Specialist study ${attempt} failed: ${state.error ?? state.status}`,
                      );
                    if (
                      state?.status === "ready" &&
                      runtime.work?.status === "idle" &&
                      runtime.work.outcome === brief(attempt)
                    )
                      return domain;
                    yield* Effect.sleep("100 millis");
                  }
                }).pipe(Effect.timeout("30 seconds"));
              const assertRevised = (agent: MeerkatProjectAgent) => {
                expect(agent.agentId).toBe(created.agentId);
                expect(agent.agentRef).toBe(agentRef);
                expect(agent.instructions).toBe(revisedInstructions);
                expect(agent.revisionVersion).toBe(2);
                expect(agent.pendingRevision).toBeNull();
                expect(agent.focus).toBe(revisedFocus);
                expect(agent.charter).toBe(revisedCharter);
                expect(agent.ownershipPaths).toEqual(["src/core.ts"]);
              };
              yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "thread.create",
                commandId: CommandId.make("specialist-create-coordinator"),
                threadId,
                projectId,
                title: "Connected specialist coordinator",
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt: now(),
              });
              yield* client[WS_METHODS.meerkatThreadConnectionsSet]({
                projectId,
                instanceId,
                threadId,
                agentIds: [created.agentId],
                requestId: "specialist-connect",
              });
              const sendCoordinator = (text: string) =>
                client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                  type: "thread.turn.start",
                  commandId: CommandId.make(`command-${text}`),
                  threadId,
                  message: {
                    messageId: MessageId.make(`message-${text}`),
                    role: "user",
                    text,
                    attachments: [],
                  },
                  modelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  createdAt: now(),
                });
              evidence.phase = "connected-coordinator";
              yield* sendCoordinator(coordinatorBefore);
              const connectedTeam = yield* Effect.gen(function* () {
                for (;;) {
                  const team = yield* client[WS_METHODS.meerkatProjectTeam]({ projectId });
                  const coordinators = team.providers
                    .flatMap((provider) => provider.agents)
                    .filter(
                      (agent) =>
                        agent.threadId === threadId &&
                        agent.record.runtime_member_id === "ingress" &&
                        !agent.record.labels.source_mob_id,
                    );
                  expect(coordinators.length).toBeLessThanOrEqual(1);
                  if (
                    coordinators[0]?.work?.status === "idle" &&
                    coordinators[0].work.outcome === `${coordinatorBefore}_COMPLETE`
                  )
                    return { team, coordinator: coordinators[0] };
                  yield* Effect.sleep("100 millis");
                }
              }).pipe(Effect.timeout("30 seconds"));
              assertIdentity(connectedTeam.team);
              const coordinator = connectedTeam.coordinator;
              expect(coordinator.record.session_id).toBeTruthy();
              expect(coordinator.record.session_id).not.toBe(sessionId);
              const checkConnection = Effect.gen(function* () {
                const connections = yield* client[WS_METHODS.meerkatThreadConnections]({
                  projectId,
                  instanceId,
                  threadId,
                });
                expect(connections.desiredAgentIds).toEqual([created.agentId]);
                expect(
                  connections.connections.map(({ agentId, status }) => ({ agentId, status })),
                ).toEqual([{ agentId: created.agentId, status: "connected" }]);
              });
              yield* checkConnection;
              evidence.phase = "stage-busy-revision";
              expect(
                (yield* client[WS_METHODS.meerkatAgentSend]({
                  projectId,
                  instanceId,
                  agentRef,
                  requestId: "specialist-busy",
                  text: busyText,
                  handlingMode: "queue",
                })).status,
              ).toBe("accepted");
              yield* Effect.promise(() =>
                bounded(fixture.busyStarted, "real specialist work before responsibility revision"),
              );
              const revision = {
                requestId: "specialist-revision-once",
                instructions: revisedInstructions,
                focus: revisedFocus,
                charter: revisedCharter,
                ownershipPaths: ["src/core.ts"],
              };
              const revise = () =>
                client[WS_METHODS.meerkatProjectAgentUpdate]({
                  projectId,
                  agentId: created.agentId,
                  revision,
                });
              const pending = yield* revise();
              expect(pending.instructions).toBe(originalInstructions);
              expect(pending.revisionVersion).toBe(1);
              expect(pending.pendingRevision?.instructions).toBe(revisedInstructions);
              expect(pending.pendingRevision?.error).toContain("current work");
              expect(pending.preparation).toBeNull();
              const revisionId = pending.pendingRevision!.revisionId;
              const pendingReplay = yield* revise();
              expect(pendingReplay.pendingRevision?.revisionId).toBe(revisionId);
              expect(pendingReplay.revisionVersion).toBe(1);
              expect(pendingReplay.instructions).toBe(originalInstructions);
              expect(fixture.studies).toHaveLength(0);
              const pendingState = persistedSpecialist(databasePath, projectId, created.agentId);
              expect(pendingState.agent.revision_version).toBe(1);
              expect(pendingState.revisions).toHaveLength(0);
              expect(pendingState.studies).toHaveLength(0);
              assertIdentity(yield* client[WS_METHODS.meerkatProjectTeam]({ projectId }));
              evidence.pendingRevisionId = revisionId;
              fixture.releaseBusy();
              assertIdentity(yield* waitIdle(agentRef, busyFinal));
              evidence.phase = "apply-idle-revision-and-first-study";
              const applied = yield* client[WS_METHODS.meerkatProjectAgentUpdate]({
                projectId,
                agentId: created.agentId,
                applyPending: true,
              });
              assertRevised(applied);
              expect(applied.error).toBeNull();
              expect(applied.preparation?.status).toBe("studying");
              expect(applied.preparation?.attempt).toBe(1);
              expect(applied.preparation?.revisionVersion).toBe(2);
              expect(applied.preparation?.interactionId).toBeTruthy();
              yield* Effect.promise(() =>
                bounded(fixture.studyStarted[0]!, "actual first study with revised instructions"),
              );
              const replay = yield* revise();
              assertRevised(replay);
              expect(replay.preparation?.interactionId).toBe(applied.preparation!.interactionId);
              const refreshDuringStudy = yield* client[WS_METHODS.meerkatProjectAgentPrepare]({
                projectId,
                agentId: created.agentId,
                refresh: true,
              });
              expect(refreshDuringStudy.preparation?.interactionId).toBe(
                applied.preparation!.interactionId,
              );
              expect(refreshDuringStudy.preparation?.requestId).toBe(
                applied.preparation!.requestId,
              );
              expect(refreshDuringStudy.preparation?.attempt).toBe(1);
              expect(fixture.studies).toHaveLength(1);
              fixture.releaseStudy(0);
              const first = yield* waitStudy(1);
              assertRevised(first);
              expect(first.preparation?.evidence?.fileCount).toBe(1);
              expect(first.preparation?.evidence?.paths).toEqual(["src/core.ts"]);
              expect(first.preparation?.evidence?.contentFingerprint).toBe(
                fixture.studies[0]!.fingerprint,
              );
              yield* checkConnection;
              evidence.firstStudy = first.preparation;
              const initialStored = persistedSpecialist(databasePath, projectId, created.agentId);
              expect(initialStored.revisions).toHaveLength(2);
              expect(initialStored.studies).toHaveLength(1);
              const readHistory = () =>
                readSpecialistHistory({
                  binaryPath: NodePath.join(runtimeDirectory, prepared.manifest.binary),
                  projectPath: prepared.projectPath,
                  nativeRoot: prepared.nativeRoot,
                  stateRoot: initialStored.agent.state_root,
                  instanceId,
                  env: prepared.env,
                  agent: original,
                });
              const firstHistory = yield* readHistory();
              expect(firstHistory.transcript?.sessionId).toBe(sessionId);
              const firstSaved =
                firstHistory.transcript?.messages.map((entry) => entry.message) ?? [];
              expect(firstHistory.transcript?.totalMessages).toBe(firstSaved.length);
              expect(
                messageTexts(firstSaved, "user").filter((text) => text === busyText),
              ).toHaveLength(1);
              expect(
                savedAssistantTexts(firstSaved).filter((text) => text === brief(1)),
              ).toHaveLength(1);
              evidence.phase = "dirty-file-refresh";
              yield* client[WS_METHODS.projectsWriteFile]({
                cwd: prepared.projectPath,
                relativePath: "src/core.ts",
                contents: fileContents(2),
              });
              const refreshed = yield* client[WS_METHODS.meerkatProjectAgentPrepare]({
                projectId,
                agentId: created.agentId,
                refresh: true,
              });
              assertRevised(refreshed);
              expect(refreshed.preparation?.status).toBe("studying");
              expect(refreshed.preparation?.attempt).toBe(2);
              expect(refreshed.preparation?.revisionVersion).toBe(2);
              expect(refreshed.preparation?.interactionId).toBeTruthy();
              expect(refreshed.preparation?.interactionId).not.toBe(
                first.preparation!.interactionId,
              );
              expect(refreshed.preparation?.requestId).not.toBe(first.preparation!.requestId);
              expect(refreshed.preparation?.evidence?.contentFingerprint).not.toBe(
                first.preparation!.evidence!.contentFingerprint,
              );
              yield* Effect.promise(() =>
                bounded(fixture.studyStarted[1]!, "actual second study after dirty file write"),
              );
              const secondReplay = yield* revise();
              assertRevised(secondReplay);
              expect(secondReplay.preparation?.interactionId).toBe(
                refreshed.preparation!.interactionId,
              );
              const repeatedRefresh = yield* client[WS_METHODS.meerkatProjectAgentPrepare]({
                projectId,
                agentId: created.agentId,
                refresh: true,
              });
              expect(repeatedRefresh.preparation?.interactionId).toBe(
                refreshed.preparation!.interactionId,
              );
              expect(repeatedRefresh.preparation?.attempt).toBe(2);
              fixture.releaseStudy(1);
              const second = yield* waitStudy(2);
              assertRevised(second);
              expect(second.preparation?.evidence?.contentFingerprint).toBe(
                fixture.studies[1]!.fingerprint,
              );
              expect(second.preparation?.evidence?.fileCount).toBe(1);
              expect(second.preparation?.evidence?.paths).toEqual(["src/core.ts"]);
              evidence.secondStudy = second.preparation;
              yield* checkConnection;
              evidence.phase = "same-peer-and-retained-history";
              yield* sendCoordinator(coordinatorAfter);
              const finalTeam = yield* waitIdle(
                coordinator.agentRef,
                `${coordinatorAfter}_COMPLETE`,
              );
              assertIdentity(finalTeam);
              expect(
                finalTeam.providers
                  .flatMap((provider) => provider.agents)
                  .find((agent) => agent.agentRef === coordinator.agentRef)?.record.session_id,
              ).toBe(coordinator.record.session_id);
              const finalHistory = yield* readHistory();
              expect(finalHistory.transcript?.sessionId).toBe(sessionId);
              expect(finalHistory.transcript?.storeRevision).not.toBe(
                firstHistory.transcript?.storeRevision,
              );
              const finalSaved =
                finalHistory.transcript?.messages.map((entry) => entry.message) ?? [];
              expect(finalHistory.transcript?.totalMessages).toBe(finalSaved.length);
              expect(finalSaved.slice(0, firstSaved.length)).toEqual(firstSaved);
              expect(
                messageTexts(finalSaved, "user").filter((text) => text === busyText),
              ).toHaveLength(1);
              for (const marker of [busyFinal, brief(1), brief(2)])
                expect(
                  savedAssistantTexts(finalSaved).filter((text) => text === marker),
                ).toHaveLength(1);
              expect(
                messageTexts(finalSaved, "user").filter((text) =>
                  text.startsWith(`Refresh the domain study for ${specialistLabel}.\n`),
                ),
              ).toHaveLength(2);
              const persisted = persistedSpecialist(databasePath, projectId, created.agentId);
              expect(persisted.agent.revision_version).toBe(2);
              expect(persisted.agent.pending_revision_json).toBeNull();
              expect(persisted.revisions).toEqual([
                { revision_id: "version:1", version: 1, instructions: originalInstructions },
                { revision_id: revisionId, version: 2, instructions: revisedInstructions },
              ]);
              const retainedStudies = persisted.studies
                .map((study) => decodePreparation(study.preparation))
                .sort((a, b) => a.attempt - b.attempt);
              expect(retainedStudies).toHaveLength(2);
              expect(
                retainedStudies.map((study) => ({
                  attempt: study.attempt,
                  status: study.status,
                  revisionVersion: study.revisionVersion,
                })),
              ).toEqual([
                { attempt: 1, status: "ready", revisionVersion: 2 },
                { attempt: 2, status: "ready", revisionVersion: 2 },
              ]);
              expect(retainedStudies.map((study) => study.interactionId)).toEqual([
                first.preparation!.interactionId,
                second.preparation!.interactionId,
              ]);
              expect(fixture.requestCount()).toBe(12);
              expect(fixture.checkedTools.map((tool) => tool.name).sort()).toEqual([
                "peers",
                "peers",
                "peers",
                "peers",
                "peers",
                "shell",
                "shell",
              ]);
              expect([...fixture.completed].sort()).toEqual(
                [coordinatorBefore, coordinatorAfter, "busy", "study-1", "study-2"].sort(),
              );
              expect(fixture.errors).toEqual([]);
              expect(
                yield* Effect.promise(() =>
                  NodeFSP.readFile(NodePath.join(prepared.projectPath, "src", "core.ts"), "utf8"),
                ),
              ).toBe(fileContents(2));
              evidence.savedHistory = {
                sessionId,
                firstRevision: firstHistory.transcript?.storeRevision,
                finalRevision: finalHistory.transcript?.storeRevision,
                firstMessages: firstSaved.length,
                finalMessages: finalSaved.length,
              };
              evidence.persistedRevisions = persisted.revisions;
              evidence.retainedStudies = retainedStudies;
              evidence.phase = "complete";
            }),
          ).pipe(Effect.raceFirst(Effect.promise(() => fixture.failed)));
        }).pipe(Effect.timeout(240_000), Effect.scoped),
      fixtureTimeoutMs(240_000) + 10_000,
    );
  },
);

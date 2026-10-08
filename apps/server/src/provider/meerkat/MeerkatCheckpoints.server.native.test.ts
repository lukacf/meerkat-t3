// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - opt-in packaged server/native acceptance with private state and a controlled provider.
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
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import { inspectPackage } from "./MeerkatProfileUpgrade.server.native.support.ts";
import {
  availablePort,
  bounded,
  configureWorkspace,
  exchangeToken,
  ownedServer,
  prepareFixture,
  readRetainedNativeHistory,
  watch,
  withClient,
  workflowModel,
} from "./MeerkatWorkflow.server.native.support.ts";
import {
  checkpointFiles,
  checkpointGit,
  checkpointPhases,
  checkpointProvider,
  expectedCheckpointCurrent,
  initializeCheckpointRepository,
  type CheckpointPhase,
} from "./MeerkatCheckpoints.server.native.support.ts";

const packageApp = process.env.T3CODE_TEST_MEERKAT_CHECKPOINT_APP;
const instanceId = ProviderInstanceId.make("meerkat");
const projectId = ProjectId.make("checkpoint-acceptance-project");
const ownerId = ThreadId.make("checkpoint-owner");
const sameId = ThreadId.make("checkpoint-same-worktree");
const siblingId = ThreadId.make("checkpoint-sibling-worktree");
const selection = { instanceId, model: workflowModel };
const now = () => DateTime.formatIso(DateTime.nowUnsafe());
const encodeEvidence = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const selectedBaseline = "Saved dirty baseline\r\nKeep these working bytes\r\n";
const selectedChanged = "Changed selected file\n";
const otherChanged = "Unselected work must remain\n";
const selectedNewer = "Newer user edit after preview\n";

function threadFailure(item: OrchestrationThreadStreamItem) {
  const session =
    item.kind === "snapshot"
      ? item.snapshot.thread.session
      : item.kind === "event" && item.event.type === "thread.session-set"
        ? item.event.payload.session
        : undefined;
  if (
    session?.status === "error" ||
    (item.kind === "event" &&
      item.event.type === "thread.activity-appended" &&
      item.event.payload.activity.kind === "provider.turn.start.failed")
  )
    return new Error("The isolated checkpoint thread failed");
  return undefined;
}
function coordinator(agents: readonly MeerkatTeamAgent[], threadId: ThreadId) {
  const matches = agents.filter(
    (agent) =>
      agent.threadId === threadId &&
      agent.mobKind === "thread" &&
      agent.record.runtime_member_id === "ingress" &&
      !agent.record.labels.source_mob_id,
  );
  expect(matches).toHaveLength(1);
  expect(matches[0]!.record.session_id).toBeTruthy();
  return matches[0]!;
}

describe.skipIf(!packageApp)("Meerkat packaged manual workspace snapshots", () => {
  it.live(
    "restores only selected bytes and rejects stale, foreign, and busy-workspace authority",
    () =>
      Effect.gen(function* () {
        if (!packageApp) throw new Error("Supply an immutable extracted packaged app");
        const pkg = yield* Effect.promise(() => inspectPackage(packageApp));
        const root = yield* Effect.promise(async () =>
          NodeFSP.realpath(
            await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-native-checkpoints-")),
          ),
        );
        yield* Effect.promise(() => NodeFSP.chmod(root, 0o700));
        const fixture = checkpointProvider();
        let server: ReturnType<typeof ownedServer> | undefined;
        const evidence: Record<string, unknown> = {
          phase: "setup",
          app: pkg.app,
          archiveSha256: pkg.archiveSha256,
          executableSha256: pkg.executableSha256,
          manifest: pkg.manifest,
        };
        yield* Effect.addFinalizer((exit) =>
          Effect.promise(async () => {
            fixture.beginTeardown();
            let cleanupComplete = false;
            try {
              await server?.close();
              cleanupComplete = true;
            } finally {
              fixture.provider.closeAllConnections();
              if (fixture.provider.listening)
                await new Promise<void>((resolve, reject) =>
                  fixture.provider.close((error) => (error ? reject(error) : resolve())),
                );
              const directory = NodePath.join(root, "evidence");
              await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
              await NodeFSP.writeFile(
                NodePath.join(directory, "checkpoint-acceptance.json"),
                encodeEvidence({
                  ...evidence,
                  passed: Exit.isSuccess(exit) && cleanupComplete,
                  cleanupComplete,
                  providerCalls: fixture.calls,
                  automaticEpisodeCaptureClaimed: false,
                  restartClaimed: false,
                }),
                { mode: 0o600 },
              );
            }
          }).pipe(
            Effect.ensuring(Effect.logInfo(`Packaged checkpoint evidence retained at ${root}`)),
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
          throw new Error("Checkpoint provider port unavailable");
        const prepared = yield* Effect.promise(() =>
          prepareFixture(root, pkg.runtime, address.port),
        );
        yield* Effect.promise(() =>
          initializeCheckpointRepository(prepared.projectPath, prepared.env),
        );
        const port = yield* Effect.promise(availablePort);
        expect(port).not.toBe(52258);
        const origin = `http://127.0.0.1:${port}`;
        server = ownedServer(
          pkg.entry,
          prepared.projectPath,
          prepared.baseDir,
          port,
          prepared.env,
          NodePath.join(prepared.evidenceRoot, "server-diagnostics.json"),
          pkg.executable,
        );
        const bearer = yield* exchangeToken(
          origin,
          yield* Effect.promise(() =>
            bounded(server!.ready, "checkpoint packaged server readiness", 60_000),
          ),
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
              commandId: CommandId.make("checkpoint-project"),
              projectId,
              title: "Manual checkpoint acceptance",
              workspaceRoot: prepared.projectPath,
              createdAt: now(),
            });
            const selectedTree = yield* client[WS_METHODS.vcsCreateWorktree]({
              cwd: prepared.projectPath,
              refName: "main",
              newRefName: "codex/checkpoint-selected",
              path: NodePath.join(root, "selected-worktree"),
            });
            const siblingTree = yield* client[WS_METHODS.vcsCreateWorktree]({
              cwd: prepared.projectPath,
              refName: "main",
              newRefName: "codex/checkpoint-sibling",
              path: NodePath.join(root, "sibling-worktree"),
            });
            const workspace = yield* Effect.promise(() =>
              NodeFSP.realpath(selectedTree.worktree.path),
            );
            const siblingWorkspace = yield* Effect.promise(() =>
              NodeFSP.realpath(siblingTree.worktree.path),
            );
            expect(new Set([workspace, siblingWorkspace, prepared.projectPath]).size).toBe(3);
            for (const cwd of [workspace, siblingWorkspace])
              yield* Effect.promise(() =>
                configureWorkspace(
                  cwd,
                  prepared.nativeRoot,
                  pkg.runtime,
                  address.port,
                  prepared.env,
                ),
              );
            const shell = yield* watch(
              client[ORCHESTRATION_WS_METHODS.subscribeShell]({ requestCompletionMarker: true }),
            );
            yield* shell.waitFor(
              (item) => item.kind === "synchronized",
              "checkpoint shell subscription",
            );
            const openThread = Effect.fnUntraced(function* (
              threadId: ThreadId,
              cwd: string,
              branch: string,
            ) {
              yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "thread.create",
                commandId: CommandId.make(`create-${threadId}`),
                threadId,
                projectId,
                title: threadId,
                modelSelection: selection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch,
                worktreePath: cwd,
                createdAt: now(),
              });
              const stream = yield* watch(
                client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId }),
                threadFailure,
              );
              yield* stream.waitFor((item) => item.kind === "snapshot", `${threadId} subscription`);
              return { threadId, stream };
            });
            const owner = yield* openThread(ownerId, workspace, selectedTree.worktree.refName);
            const same = yield* openThread(sameId, workspace, selectedTree.worktree.refName);
            const sibling = yield* openThread(
              siblingId,
              siblingWorkspace,
              siblingTree.worktree.refName,
            );
            const start = Effect.fnUntraced(function* (
              conversation: typeof owner,
              phase: CheckpointPhase,
            ) {
              const afterShell = shell.index(),
                afterThread = conversation.stream.index();
              yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "thread.turn.start",
                commandId: CommandId.make(`checkpoint-${phase}`),
                threadId: conversation.threadId,
                message: {
                  messageId: MessageId.make(`checkpoint-${phase}`),
                  role: "user",
                  text: `CHECKPOINT_${phase}`,
                  attachments: [],
                },
                modelSelection: selection,
                runtimeMode: "full-access",
                interactionMode: "default",
                createdAt: now(),
              });
              return Effect.gen(function* () {
                yield* conversation.stream.waitFor(
                  (item) =>
                    item.kind === "snapshot"
                      ? item.snapshot.thread.messages.some(
                          (message) =>
                            message.role === "assistant" &&
                            message.text === `CHECKPOINT_${phase}_COMPLETE` &&
                            !message.streaming,
                        )
                      : item.kind === "event" &&
                        item.event.type === "thread.message-sent" &&
                        item.event.payload.role === "assistant" &&
                        item.event.payload.text === `CHECKPOINT_${phase}_COMPLETE` &&
                        !item.event.payload.streaming,
                  `${phase} committed response`,
                  afterThread,
                );
                yield* shell.waitFor(
                  (item) =>
                    item.kind === "thread-upserted" &&
                    item.thread.id === conversation.threadId &&
                    item.thread.latestTurn?.state === "completed" &&
                    item.thread.session?.status === "ready",
                  `${phase} terminal receipt`,
                  afterShell,
                );
              });
            });
            for (const [conversation, phase] of [
              [owner, "OWNER_READY"],
              [same, "SAME_READY"],
              [sibling, "SIBLING_READY"],
            ] as const) {
              const completion = yield* start(conversation, phase);
              yield* completion;
            }
            const agents = (yield* client[WS_METHODS.meerkatProjectTeam]({
              projectId,
            })).providers.flatMap((provider) => provider.agents);
            const original = coordinator(agents, ownerId);
            const sameAgent = coordinator(agents, sameId),
              siblingAgent = coordinator(agents, siblingId);
            expect(
              new Set([
                original.record.session_id,
                sameAgent.record.session_id,
                siblingAgent.record.session_id,
              ]).size,
            ).toBe(3);
            const target = { projectId, instanceId, threadId: ownerId };
            // Live activity is an event stream. Saved transcript preservation
            // is checked through the exact read-only native history surface.
            const ownerHistory = () =>
              readRetainedNativeHistory({
                binaryPath: NodePath.join(pkg.runtime, prepared.manifest.binary),
                projectPath: workspace,
                nativeRoot: prepared.nativeRoot,
                instanceId,
                env: prepared.env,
                agents: [original],
              }).pipe(Effect.map((history) => history[0]!));
            const historyBefore = yield* ownerHistory();
            expect(historyBefore.transcript?.sessionId).toBe(original.record.session_id);
            expect(encodeEvidence(historyBefore.transcript)).toContain(
              "CHECKPOINT_OWNER_READY_COMPLETE",
            );
            const transcriptBefore = historyBefore.transcript;
            const mainBefore = yield* Effect.promise(() => checkpointFiles(prepared.projectPath));
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(siblingWorkspace, "selected.txt"),
                "Sibling user bytes\n",
              ),
            );
            const siblingBefore = yield* Effect.promise(() => checkpointFiles(siblingWorkspace));
            const git = (cwd: string, args: string[]) =>
              Effect.promise(() => checkpointGit(cwd, prepared.env, args));
            const headBefore = yield* git(workspace, ["rev-parse", "HEAD"]);
            const siblingHead = yield* git(siblingWorkspace, ["rev-parse", "HEAD"]);
            const siblingIndex = yield* git(siblingWorkspace, ["write-tree"]);
            yield* Effect.promise(() =>
              NodeFSP.writeFile(NodePath.join(workspace, "selected.txt"), "Staged user bytes\n"),
            );
            yield* git(workspace, ["add", "selected.txt"]);
            yield* Effect.promise(() =>
              NodeFSP.writeFile(NodePath.join(workspace, "selected.txt"), selectedBaseline),
            );
            const indexBefore = yield* git(workspace, ["write-tree"]);
            const baselineFiles = yield* Effect.promise(() => checkpointFiles(workspace));
            evidence.phase = "manual-capture";
            const checkpoint = yield* client[WS_METHODS.meerkatCheckpointCapture](target);
            expect(checkpoint).toMatchObject({
              source: "manual",
              status: "complete",
              sessionId: original.record.session_id,
              workspace,
              detail: null,
            });
            expect(
              (yield* client[WS_METHODS.meerkatCheckpoints](target)).checkpoints.map(
                (item) => item.id,
              ),
            ).toContain(checkpoint.id);
            expect(yield* git(workspace, ["write-tree"])).toBe(indexBefore);
            expect(yield* Effect.promise(() => checkpointFiles(workspace))).toEqual(baselineFiles);
            yield* Effect.promise(() =>
              NodeFSP.writeFile(NodePath.join(workspace, "selected.txt"), selectedChanged),
            );
            yield* Effect.promise(() =>
              NodeFSP.writeFile(NodePath.join(workspace, "other.txt"), otherChanged),
            );
            const preview = yield* client[WS_METHODS.meerkatCheckpointPreview]({
              ...target,
              checkpointId: checkpoint.id,
            });
            expect(preview.sharedWorkspace).toBe(true);
            expect(preview.files.map((file) => file.path).sort()).toEqual([
              "other.txt",
              "selected.txt",
            ]);
            expect(preview.patch).toContain("Changed selected file");
            expect(preview.patch).toContain("Unselected work must remain");
            const selected = preview.files.find((file) => file.path === "selected.txt")!;
            expect(selected).toMatchObject({
              before: selectedBaseline,
              current: selectedChanged,
              restorable: true,
              reason: null,
            });
            for (const file of preview.files)
              expect(file.expectedCurrent).toBe(
                yield* Effect.promise(() => expectedCheckpointCurrent(workspace, file.path)),
              );
            const changedFiles = yield* Effect.promise(() => checkpointFiles(workspace));
            evidence.phase = "foreign-authority";
            for (const foreign of [sameId, siblingId]) {
              const foreignTarget = { projectId, instanceId, threadId: foreign };
              expect(
                (yield* client[WS_METHODS.meerkatCheckpoints](foreignTarget)).checkpoints.map(
                  (item) => item.id,
                ),
              ).not.toContain(checkpoint.id);
              const wrongPreview = yield* client[WS_METHODS.meerkatCheckpointPreview]({
                ...foreignTarget,
                checkpointId: checkpoint.id,
              }).pipe(Effect.result);
              const wrongRestore = yield* client[WS_METHODS.meerkatCheckpointRestore]({
                ...foreignTarget,
                checkpointId: checkpoint.id,
                files: [{ path: selected.path, expectedCurrent: selected.expectedCurrent }],
              }).pipe(Effect.result);
              for (const refused of [wrongPreview, wrongRestore])
                expect(refused).toMatchObject({
                  _tag: "Failure",
                  failure: {
                    _tag: "MeerkatCheckpointError",
                    message: expect.stringContaining("does not belong"),
                  },
                });
              expect(yield* Effect.promise(() => checkpointFiles(workspace))).toEqual(changedFiles);
              expect(yield* Effect.promise(() => checkpointFiles(siblingWorkspace))).toEqual(
                siblingBefore,
              );
            }
            evidence.phase = "selected-restore";
            const restored = yield* client[WS_METHODS.meerkatCheckpointRestore]({
              ...target,
              checkpointId: checkpoint.id,
              files: [{ path: selected.path, expectedCurrent: selected.expectedCurrent }],
            });
            expect(restored).toEqual({ restored: ["selected.txt"], conflicts: [] });
            const selectedOnly = yield* Effect.promise(() => checkpointFiles(workspace));
            expect(selectedOnly["selected.txt"]).toEqual(baselineFiles["selected.txt"]);
            expect(selectedOnly["other.txt"]).toEqual(changedFiles["other.txt"]);
            expect(yield* git(workspace, ["write-tree"])).toBe(indexBefore);
            evidence.phase = "stale-preview";
            yield* Effect.promise(() =>
              NodeFSP.writeFile(NodePath.join(workspace, "selected.txt"), selectedChanged),
            );
            const stalePreview = yield* client[WS_METHODS.meerkatCheckpointPreview]({
              ...target,
              checkpointId: checkpoint.id,
            });
            yield* Effect.promise(() =>
              NodeFSP.writeFile(NodePath.join(workspace, "selected.txt"), selectedNewer),
            );
            const newerFiles = yield* Effect.promise(() => checkpointFiles(workspace));
            const stale = yield* client[WS_METHODS.meerkatCheckpointRestore]({
              ...target,
              checkpointId: checkpoint.id,
              files: stalePreview.files.map((file) => ({
                path: file.path,
                expectedCurrent: file.expectedCurrent,
              })),
            });
            expect(stale.restored).toEqual([]);
            expect(stale.conflicts.map((file) => file.path)).toEqual(["selected.txt"]);
            expect(yield* Effect.promise(() => checkpointFiles(workspace))).toEqual(newerFiles);
            evidence.phase = "busy-workspace";
            const fresh = yield* client[WS_METHODS.meerkatCheckpointPreview]({
              ...target,
              checkpointId: checkpoint.id,
            });
            const busyCompletion = yield* start(same, "BUSY");
            yield* Effect.promise(() =>
              bounded(fixture.busyStarted, "actual other-conversation native work"),
            );
            const busyCapture = yield* client[WS_METHODS.meerkatCheckpointCapture](target).pipe(
              Effect.result,
            );
            const busyRestore = yield* client[WS_METHODS.meerkatCheckpointRestore]({
              ...target,
              checkpointId: checkpoint.id,
              files: fresh.files.map((file) => ({
                path: file.path,
                expectedCurrent: file.expectedCurrent,
              })),
            }).pipe(Effect.result);
            for (const refused of [busyCapture, busyRestore])
              expect(refused).toMatchObject({
                _tag: "Failure",
                failure: {
                  _tag: "MeerkatCheckpointError",
                  message: expect.stringContaining("Native work is active"),
                },
              });
            expect(yield* Effect.promise(() => checkpointFiles(workspace))).toEqual(newerFiles);
            const retained = yield* client[WS_METHODS.meerkatCheckpoints](target);
            expect(
              retained.checkpoints
                .filter((item) => item.source === "manual")
                .map((item) => item.id),
            ).toEqual([checkpoint.id]);
            fixture.releaseBusy();
            yield* busyCompletion;
            expect((yield* ownerHistory()).transcript).toEqual(transcriptBefore);
            evidence.phase = "idle-recovery";
            const idleRestored = yield* client[WS_METHODS.meerkatCheckpointRestore]({
              ...target,
              checkpointId: checkpoint.id,
              files: [
                {
                  path: "selected.txt",
                  expectedCurrent: fresh.files.find((file) => file.path === "selected.txt")!
                    .expectedCurrent,
                },
              ],
            });
            expect(idleRestored).toEqual({ restored: ["selected.txt"], conflicts: [] });
            const continuation = yield* start(owner, "CONTINUE");
            yield* continuation;
            const finalHistory = yield* ownerHistory();
            expect(finalHistory.transcript?.sessionId).toBe(original.record.session_id);
            expect(
              finalHistory.transcript?.messages.slice(0, transcriptBefore!.messages.length),
            ).toEqual(transcriptBefore!.messages);
            expect(encodeEvidence(finalHistory.transcript)).toContain(
              "CHECKPOINT_CONTINUE_COMPLETE",
            );
            const finalAgent = coordinator(
              (yield* client[WS_METHODS.meerkatProjectTeam]({ projectId })).providers.flatMap(
                (provider) => provider.agents,
              ),
              ownerId,
            );
            const identity = (agent: MeerkatTeamAgent) => ({
              mobId: agent.mobId,
              agentRef: agent.agentRef,
              sessionId: agent.record.session_id,
              identity: agent.record.identity,
              runtimeKey: agent.record.runtime_key,
              runtimeMemberId: agent.record.runtime_member_id,
            });
            expect(identity(finalAgent)).toEqual(identity(original));
            const finalFiles = yield* Effect.promise(() => checkpointFiles(workspace));
            expect(finalFiles["selected.txt"]).toEqual(baselineFiles["selected.txt"]);
            expect(finalFiles["other.txt"]).toEqual(changedFiles["other.txt"]);
            expect(yield* git(workspace, ["write-tree"])).toBe(indexBefore);
            expect(yield* git(workspace, ["rev-parse", "HEAD"])).toBe(headBefore);
            expect(yield* Effect.promise(() => checkpointFiles(prepared.projectPath))).toEqual(
              mainBefore,
            );
            expect(yield* Effect.promise(() => checkpointFiles(siblingWorkspace))).toEqual(
              siblingBefore,
            );
            expect(yield* git(siblingWorkspace, ["write-tree"])).toBe(siblingIndex);
            expect(yield* git(siblingWorkspace, ["rev-parse", "HEAD"])).toBe(siblingHead);
            expect(fixture.calls).toEqual([...checkpointPhases]);
            evidence.phase = "complete";
            Object.assign(evidence, {
              checkpoint,
              owner: {
                agentRef: original.agentRef,
                mobId: original.mobId,
                sessionId: original.record.session_id,
              },
              workspace,
              siblingWorkspace,
              baselineFiles,
              changedFiles,
              finalFiles,
              selectedRestore: restored,
              staleConflict: stale,
              busyCaptureRefused: true,
              busyRestoreRefused: true,
              wrongConversationRefused: true,
              wrongWorktreeRefused: true,
              gitIndexUnchanged: true,
              gitHeadUnchanged: true,
              nativeHistoryPreserved: true,
            });
          }),
        ).pipe(Effect.raceFirst(Effect.promise(() => fixture.failed)));
      }).pipe(Effect.scoped, Effect.timeout("240 seconds")),
    250_000,
  );
});

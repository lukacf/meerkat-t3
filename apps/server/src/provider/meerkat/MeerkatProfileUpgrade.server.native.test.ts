// @effect-diagnostics nodeBuiltinImport:off - opt-in acceptance uses two real packaged servers and one private populated profile.
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
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";
import {
  availablePort,
  bounded,
  exchangeToken,
  ownedServer,
  prepareFixture,
  watch,
  withClient,
  workflowModel,
} from "./MeerkatWorkflow.server.native.support.ts";
import {
  encodeUpgradeEvidence,
  initializeUpgradeRepository,
  inspectPackage,
  upgradeImage,
  upgradeProvider,
} from "./MeerkatProfileUpgrade.server.native.support.ts";

const previousApp = process.env.T3CODE_TEST_MEERKAT_UPGRADE_PREVIOUS_APP;
const currentApp = process.env.T3CODE_TEST_MEERKAT_UPGRADE_CURRENT_APP;
const projectId = ProjectId.make("packaged-upgrade-project");
const threadId = ThreadId.make("packaged-upgrade-thread");
const instanceId = ProviderInstanceId.make("meerkat");
const modelSelection = { instanceId, model: workflowModel };
const now = () => DateTime.formatIso(DateTime.nowUnsafe());
const nativeIdentity = (agent: MeerkatTeamAgent) => ({
  agentRef: agent.agentRef,
  mobId: agent.mobId,
  identity: agent.record.identity,
  runtimeKey: agent.record.runtime_key,
  runtimeMemberId: agent.record.runtime_member_id,
  sessionId: agent.record.session_id,
});
function threadFailure(item: OrchestrationThreadStreamItem) {
  const session =
    item.kind === "snapshot"
      ? item.snapshot.thread.session
      : item.kind === "event" && item.event.type === "thread.session-set"
        ? item.event.payload.session
        : undefined;
  return session?.status === "error"
    ? new Error(session.lastError ?? "Native thread failed")
    : undefined;
}
function coordinator(agents: readonly MeerkatTeamAgent[]) {
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
type UpgradeClient = Parameters<Parameters<typeof withClient>[2]>[0];
const savedHistory = Effect.fnUntraced(function* (
  client: UpgradeClient,
  agent: MeerkatTeamAgent,
  completedText: string,
) {
  // Live activity is a console window. The public saved-conversation search
  // supplies the native revision required to read committed session messages.
  const search = yield* client[WS_METHODS.meerkatSearchConversations]({ query: completedText });
  expect(search.unavailable).toBe(0);
  expect(search.nextCursor).toBeUndefined();
  const matches = search.matches.filter(
    (match) =>
      match.projectId === projectId &&
      match.instanceId === instanceId &&
      match.agentRef === agent.agentRef &&
      match.message?.sessionId === agent.record.session_id,
  );
  expect(matches).toHaveLength(1);
  const message = matches[0]!.message!;
  expect(message.source).toBe("assistant");
  expect(message.snippet).toContain(completedText);
  const history = yield* client[WS_METHODS.meerkatAgentActivity]({
    projectId,
    instanceId,
    agentRef: agent.agentRef,
    limit: 100,
    transcriptRevision: message.storeRevision,
  });
  expect(history.transcript?.sessionId).toBe(agent.record.session_id);
  expect(history.transcript?.storeRevision).toBe(message.storeRevision);
  expect(history.transcript?.exhausted).toBe(true);
  expect(encodeUpgradeEvidence(history.transcript?.messages)).toContain(completedText);
  return history;
});

describe.skipIf(!previousApp || !currentApp)("Meerkat packaged app profile upgrade", () => {
  it.live(
    "preserves populated T3 and native identity, history, images and peer topology across packages",
    () =>
      Effect.gen(function* () {
        if (!previousApp || !currentApp) throw new Error("Supply both packaged app paths");
        const previous = yield* Effect.promise(() => inspectPackage(previousApp));
        const current = yield* Effect.promise(() => inspectPackage(currentApp));
        expect(previous.archiveSha256).not.toBe(current.archiveSha256);
        const root = yield* Effect.promise(async () =>
          NodeFSP.realpath(
            await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-profile-upgrade-")),
          ),
        );
        yield* Effect.promise(() => NodeFSP.chmod(root, 0o700));
        const fixture = upgradeProvider();
        const servers: ReturnType<typeof ownedServer>[] = [];
        const stages: string[] = [];
        const exits: { code: number | null; signal: NodeJS.Signals | null }[] = [];
        const identities: unknown[] = [];
        const failures: string[] = [];
        const persist = async (pass = false) => {
          await NodeFSP.writeFile(
            NodePath.join(root, "upgrade-evidence.json"),
            encodeUpgradeEvidence({
              root,
              previous,
              current,
              stages,
              exits,
              identities,
              failures,
              calls: fixture.calls,
              peers: Object.fromEntries(fixture.peers),
              pass,
            }),
            { mode: 0o600 },
          );
        };
        const stage = (label: string) =>
          Effect.promise(async () => {
            stages.push(label);
            await persist();
          });
        const recordFailure = <A, E>(exit: Exit.Exit<A, E>) =>
          Effect.promise(async () => {
            if (Exit.isFailure(exit)) failures.push(Cause.pretty(exit.cause));
            await persist();
          });
        yield* stage("fixture:prepared");
        yield* Effect.addFinalizer((exit) =>
          Effect.promise(async () => {
            if (Exit.isFailure(exit)) failures.push(Cause.pretty(exit.cause));
            await persist();
            const cleanupErrors: unknown[] = [];
            for (const server of servers) {
              try {
                await server.close();
              } catch (error) {
                cleanupErrors.push(error);
                failures.push(String(error));
              }
            }
            fixture.provider.closeAllConnections();
            try {
              if (fixture.provider.listening)
                await bounded(
                  new Promise<void>((resolve, reject) =>
                    fixture.provider.close((error) => (error ? reject(error) : resolve())),
                  ),
                  "upgrade provider shutdown",
                  5_000,
                );
            } catch (error) {
              cleanupErrors.push(error);
              failures.push(String(error));
            }
            await persist(Exit.isSuccess(exit) && cleanupErrors.length === 0);
            // Retain this owned profile on success too: the exact upgrade inputs and outputs are reviewable.
            process.stdout.write(`Packaged profile upgrade evidence: ${root}\n`);
            if (cleanupErrors.length)
              throw new AggregateError(cleanupErrors, "Packaged upgrade cleanup failed");
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
        if (!address || typeof address === "string") throw new Error("No isolated provider port");
        const prepared = yield* Effect.promise(() =>
          prepareFixture(root, previous.runtime, address.port, {
            PATH: [
              NodePath.dirname(previous.executable),
              "/usr/bin",
              "/bin",
              "/usr/sbin",
              "/sbin",
            ].join(NodePath.delimiter),
            MEERKAT_NODE_PATH: previous.executable,
            ELECTRON_RUN_AS_NODE: "1",
          }),
        );
        yield* Effect.promise(() =>
          initializeUpgradeRepository(prepared.projectPath, prepared.env),
        );
        const launch = (artifact: typeof previous, label: string) =>
          Effect.gen(function* () {
            yield* stage(`${label}:launching`);
            const port = yield* Effect.promise(availablePort);
            expect(port).not.toBe(52258);
            const env = {
              ...prepared.env,
              PATH: [
                NodePath.dirname(artifact.executable),
                "/usr/bin",
                "/bin",
                "/usr/sbin",
                "/sbin",
              ].join(NodePath.delimiter),
              MEERKAT_RUNTIME_DIR: artifact.runtime,
              MEERKAT_NODE_PATH: artifact.executable,
              T3CODE_TRACE_FILE: NodePath.join(prepared.evidenceRoot, `${label}.trace.ndjson`),
            };
            expect(env.MEERKAT_NODE_PATH.startsWith(artifact.app + NodePath.sep)).toBe(true);
            yield* Effect.promise(() =>
              NodeFSP.writeFile(env.T3CODE_TRACE_FILE, "", { mode: 0o600 }),
            );
            const server = ownedServer(
              artifact.entry,
              prepared.projectPath,
              prepared.baseDir,
              port,
              env,
              NodePath.join(prepared.evidenceRoot, `${label}-server.json`),
              artifact.executable,
            );
            servers.push(server);
            const origin = `http://127.0.0.1:${port}`;
            const credential = yield* Effect.promise(() =>
              bounded(server.ready, `${label} packaged server startup`, 60_000),
            );
            const bearer = yield* exchangeToken(origin, credential);
            yield* stage(`${label}:server-ready`);
            return { server, origin, bearer };
          });
        const first = yield* launch(previous, "previous");
        const saved = yield* withClient(first.origin, first.bearer, (client) =>
          Effect.gen(function* () {
            const config = yield* client[WS_METHODS.serverGetConfig]({});
            expect(
              config.providers
                .filter((provider) => provider.enabled)
                .map((provider) => provider.instanceId),
            ).toEqual([instanceId]);
            expect(
              config.providers.find((provider) => provider.instanceId === instanceId)?.version,
            ).toBe(
              `${previous.manifest.build.meerkatVersion} / MobKit ${previous.manifest.build.mobkitVersion}`,
            );
            yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "project.create",
              commandId: CommandId.make("upgrade-project-create"),
              projectId,
              title: "Packaged upgrade",
              workspaceRoot: prepared.projectPath,
              createdAt: now(),
            });
            yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.create",
              commandId: CommandId.make("upgrade-thread-create"),
              threadId,
              projectId,
              title: "Persisted upgrade conversation",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: "main",
              worktreePath: null,
              createdAt: now(),
            });
            const reviewer = yield* client[WS_METHODS.meerkatProjectAgentCreate]({
              accessMode: "full-access",
              projectId,
              instanceId,
              requestId: "upgrade-create-reviewer",
              label: "Upgrade reviewer",
              role: "reviewer",
              instructions:
                "Keep the review conversation and inspect only explicitly requested native peer identities.",
              model: workflowModel,
            });
            expect(reviewer.connectionStatus, reviewer.error ?? undefined).toBe("connected");
            if (!reviewer.agentRef) throw new Error("The native reviewer reference is required");
            const target = { projectId, instanceId, agentRef: reviewer.agentRef };
            yield* client[WS_METHODS.meerkatThreadConnectionsSet]({
              projectId,
              instanceId,
              threadId,
              agentIds: [reviewer.agentId],
              requestId: "upgrade-connect-reviewer",
            });
            const shell = yield* watch(
              client[ORCHESTRATION_WS_METHODS.subscribeShell]({ requestCompletionMarker: true }),
            );
            const attention = yield* watch(
              client[WS_METHODS.meerkatAttentionSubscribe]({ projectId }),
            );
            const thread = yield* watch(
              client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId }),
              threadFailure,
            );
            yield* shell.waitFor((item) => item.kind === "synchronized", "old shell subscription");
            yield* attention.waitFor(
              (item) => item.kind === "synchronized",
              "old attention subscription",
            );
            // The historical package baselines all first-observed completions
            // as read. Populate an already-observed profile for this upgrade
            // proof; current startup completion behavior is tested separately.
            yield* stage("previous:awaiting-historical-attention-baseline");
            yield* attention.waitFor(
              (item) => item.kind === "snapshot" && item.source === "observation",
              "historical attention baseline before populating the upgrade profile",
            );
            yield* stage("previous:subscribed-before-coordinator-send");
            const shellIndex = shell.index();
            yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("upgrade-first-coordinator"),
              threadId,
              message: {
                messageId: MessageId.make("upgrade-first-coordinator-message"),
                role: "user",
                text: "UPGRADE_FIRST_COORD",
                attachments: [
                  {
                    type: "image",
                    name: "upgrade.png",
                    mimeType: "image/png",
                    sizeBytes: Buffer.from(upgradeImage, "base64").length,
                    dataUrl: `data:image/png;base64,${upgradeImage}`,
                  },
                ],
              },
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: now(),
            });
            yield* stage("previous:awaiting-coordinator-committed-output");
            yield* thread.waitFor(
              (item) =>
                item.kind === "event" &&
                item.event.type === "thread.message-sent" &&
                item.event.payload.role === "assistant" &&
                item.event.payload.text === "UPGRADE_FIRST_COORD_COMPLETE" &&
                !item.event.payload.streaming,
              "old coordinator committed output",
            );
            yield* shell.waitFor(
              (item) =>
                item.kind === "thread-upserted" &&
                item.thread.id === threadId &&
                item.thread.latestTurn?.state === "completed" &&
                item.thread.session?.status === "ready",
              "old coordinator terminal receipt",
              shellIndex,
            );
            yield* stage("previous:coordinator-completed-uploading-reviewer-image");
            const image = yield* client[WS_METHODS.meerkatImageUpload]({
              ...target,
              mediaType: "image/png",
              dataBase64: upgradeImage,
            });
            // Native content addressing owns this identity. Preserve it and
            // verify actual bytes, rather than deriving a separate hash recipe.
            const blobId = image.blob.blobId;
            expect(image.blob.mediaType).toBe("image/png");
            expect(image.blob.size).toBe(Buffer.from(upgradeImage, "base64").length);
            const originalImage = yield* client[WS_METHODS.meerkatImageRead]({
              ...target,
              blobId,
            });
            expect(originalImage.dataBase64).toBe(upgradeImage);
            yield* stage("previous:verified-native-image-sending-reviewer");
            const receipt = yield* client[WS_METHODS.meerkatAgentSend]({
              ...target,
              requestId: "upgrade-first-reviewer",
              text: "UPGRADE_FIRST_REVIEW",
              handlingMode: "queue",
              images: [
                {
                  type: "image",
                  media_type: "image/png",
                  source: "blob",
                  blob_id: image.blob.blobId,
                },
              ],
            });
            expect(receipt.status, receipt.message ?? undefined).toBe("accepted");
            yield* stage("previous:awaiting-reviewer-terminal-receipt");
            yield* attention.waitFor(
              (item) =>
                item.kind === "snapshot" &&
                item.snapshot.items.some(
                  (entry) =>
                    entry.agentRef === reviewer.agentRef &&
                    entry.kind === "completion" &&
                    entry.completionStatus === "completed" &&
                    entry.detail === "UPGRADE_FIRST_REVIEW_COMPLETE",
                ),
              "old reviewer terminal receipt",
            );
            const snapshot = yield* client[ORCHESTRATION_WS_METHODS.subscribeThread]({
              threadId,
            }).pipe(
              Stream.filter((item) => item.kind === "snapshot"),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
              Effect.map((item) => item.snapshot.thread),
            );
            const team = yield* client[WS_METHODS.meerkatProjectTeam]({ projectId });
            const agents = team.providers.flatMap((provider) => provider.agents);
            const rootAgent = coordinator(agents);
            const reviewAgent = agents.find((agent) => agent.agentRef === reviewer.agentRef);
            if (!reviewAgent?.record.session_id)
              throw new Error("Missing original reviewer session");
            const histories = [];
            for (const agent of [rootAgent, reviewAgent]) {
              yield* stage(`previous:reading-saved-transcript:${agent.record.identity}`);
              const completedText =
                agent === rootAgent
                  ? "UPGRADE_FIRST_COORD_COMPLETE"
                  : "UPGRADE_FIRST_REVIEW_COMPLETE";
              const history = yield* savedHistory(client, agent, completedText);
              const text = encodeUpgradeEvidence(history.transcript?.messages);
              expect(text).toContain(blobId);
              histories.push({ agent, completedText, transcript: history.transcript });
            }
            const connections = yield* client[WS_METHODS.meerkatThreadConnections]({
              projectId,
              instanceId,
              threadId,
            });
            expect(connections.desiredAgentIds).toEqual([reviewer.agentId]);
            expect(connections.connections[0]?.status).toBe("connected");
            identities.push(nativeIdentity(rootAgent), nativeIdentity(reviewAgent));
            yield* stage("previous:both-original-sessions-completed");
            return {
              reviewer,
              target,
              rootAgent,
              reviewAgent,
              snapshot,
              histories,
              connections,
              blobId,
            };
          }).pipe(Effect.onExit(recordFailure)),
        ).pipe(Effect.raceFirst(Effect.promise(() => fixture.failed)));
        yield* stage("previous:closing");
        const oldExit = yield* Effect.promise(() => first.server.close());
        expect(oldExit.signal).toBeNull();
        expect([0, 130]).toContain(oldExit.code);
        exits.push(oldExit);
        yield* stage("previous:ordinary-shutdown");
        const sqlStat = yield* Effect.promise(() =>
          NodeFSP.stat(NodePath.join(prepared.baseDir, "userdata", "state.sqlite")),
        );
        expect(sqlStat.size).toBeGreaterThan(0);
        const next = yield* launch(current, "current");
        expect(next.server.child.pid).not.toBe(first.server.child.pid);
        yield* withClient(next.origin, next.bearer, (client) =>
          Effect.gen(function* () {
            const config = yield* client[WS_METHODS.serverGetConfig]({});
            expect(
              config.providers
                .filter((provider) => provider.enabled)
                .map((provider) => provider.instanceId),
            ).toEqual([instanceId]);
            expect(
              config.providers.find((provider) => provider.instanceId === instanceId)?.version,
            ).toBe(
              `${current.manifest.build.meerkatVersion} / MobKit ${current.manifest.build.mobkitVersion}`,
            );
            const readThread = () =>
              client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId }).pipe(
                Stream.filter((item) => item.kind === "snapshot"),
                Stream.runHead,
                Effect.map(Option.getOrThrow),
                Effect.map((item) => item.snapshot.thread),
              );
            const restored = yield* readThread();
            expect(restored.id).toBe(saved.snapshot.id);
            expect(restored.projectId).toBe(saved.snapshot.projectId);
            expect(restored.modelSelection).toEqual(saved.snapshot.modelSelection);
            expect(restored.messages).toEqual(saved.snapshot.messages);
            expect(restored.latestTurn?.turnId).toBe(saved.snapshot.latestTurn?.turnId);
            const coldTeam = yield* client[WS_METHODS.meerkatProjectTeam]({ projectId });
            const coldAgents = coldTeam.providers.flatMap((provider) => provider.agents);
            expect(nativeIdentity(coordinator(coldAgents))).toEqual(
              nativeIdentity(saved.rootAgent),
            );
            const coldReviewer = coldAgents.find(
              (agent) => agent.agentRef === saved.reviewer.agentRef,
            );
            if (!coldReviewer)
              throw new Error("The persisted reviewer was not projected after upgrade");
            expect(nativeIdentity(coldReviewer)).toEqual(nativeIdentity(saved.reviewAgent));
            for (const before of saved.histories) {
              const history = yield* savedHistory(client, before.agent, before.completedText);
              expect(history.transcript?.sessionId).toBe(before.transcript?.sessionId);
              expect(history.transcript?.messages).toEqual(before.transcript?.messages);
              const image = yield* client[WS_METHODS.meerkatImageRead]({
                projectId,
                instanceId,
                agentRef: before.agent.agentRef,
                blobId: saved.blobId,
              });
              expect(image.dataBase64).toBe(upgradeImage);
            }
            expect(fixture.completed.size).toBe(2);
            const persistedConnections = yield* client[WS_METHODS.meerkatThreadConnections]({
              projectId,
              instanceId,
              threadId,
            });
            expect(persistedConnections.desiredAgentIds).toEqual(saved.connections.desiredAgentIds);
            yield* stage("current:exact-history-identities-and-image-bytes");
            const connected = yield* client[WS_METHODS.meerkatProjectAgentLifecycle]({
              projectId,
              agentId: saved.reviewer.agentId,
              action: "connect",
            });
            expect(connected.connectionStatus, connected.error ?? undefined).toBe("connected");
            expect(connected.agentRef).toBe(saved.reviewer.agentRef);
            const attention = yield* watch(
              client[WS_METHODS.meerkatAttentionSubscribe]({ projectId }),
            );
            const shell = yield* watch(
              client[ORCHESTRATION_WS_METHODS.subscribeShell]({ requestCompletionMarker: true }),
            );
            const thread = yield* watch(
              client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId }),
              threadFailure,
            );
            yield* attention.waitFor(
              (item) => item.kind === "synchronized",
              "new attention subscription",
            );
            yield* shell.waitFor((item) => item.kind === "synchronized", "new shell subscription");
            yield* stage("current:subscribed-before-coordinator-continuation");
            const shellIndex = shell.index();
            yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("upgrade-continue-coordinator"),
              threadId,
              message: {
                messageId: MessageId.make("upgrade-continue-coordinator-message"),
                role: "user",
                text: "UPGRADE_CONTINUE_COORD",
                attachments: [],
              },
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: now(),
            });
            yield* stage("current:awaiting-coordinator-committed-output");
            yield* thread.waitFor(
              (item) =>
                item.kind === "event" &&
                item.event.type === "thread.message-sent" &&
                item.event.payload.role === "assistant" &&
                item.event.payload.text === "UPGRADE_CONTINUE_COORD_COMPLETE" &&
                !item.event.payload.streaming,
              "continued coordinator committed output",
            );
            yield* shell.waitFor(
              (item) =>
                item.kind === "thread-upserted" &&
                item.thread.id === threadId &&
                item.thread.latestTurn?.state === "completed" &&
                item.thread.session?.status === "ready",
              "continued coordinator terminal receipt",
              shellIndex,
            );
            yield* stage("current:coordinator-completed-sending-reviewer");
            const sent = yield* client[WS_METHODS.meerkatAgentSend]({
              ...saved.target,
              requestId: "upgrade-continue-reviewer",
              text: "UPGRADE_CONTINUE_REVIEW",
              handlingMode: "queue",
            });
            expect(sent.status, sent.message ?? undefined).toBe("accepted");
            yield* stage("current:awaiting-reviewer-terminal-receipt");
            yield* attention.waitFor(
              (item) =>
                item.kind === "snapshot" &&
                item.snapshot.items.some(
                  (entry) =>
                    entry.agentRef === saved.reviewer.agentRef &&
                    entry.kind === "completion" &&
                    entry.completionStatus === "completed" &&
                    entry.detail === "UPGRADE_CONTINUE_REVIEW_COMPLETE",
                ),
              "continued reviewer terminal receipt",
            );
            const team = yield* client[WS_METHODS.meerkatProjectTeam]({ projectId });
            const agents = team.providers.flatMap((provider) => provider.agents);
            expect(nativeIdentity(coordinator(agents))).toEqual(nativeIdentity(saved.rootAgent));
            const reviewAgent = agents.find((agent) => agent.agentRef === saved.reviewer.agentRef);
            if (!reviewAgent) throw new Error("Reviewer disappeared after continuation");
            expect(nativeIdentity(reviewAgent)).toEqual(nativeIdentity(saved.reviewAgent));
            for (const before of saved.histories) {
              const completedText =
                before.agent.agentRef === saved.rootAgent.agentRef
                  ? "UPGRADE_CONTINUE_COORD_COMPLETE"
                  : "UPGRADE_CONTINUE_REVIEW_COMPLETE";
              const after = yield* savedHistory(client, before.agent, completedText);
              expect(after.transcript?.sessionId).toBe(before.transcript?.sessionId);
              expect(
                after.transcript?.messages.slice(0, before.transcript?.messages.length),
              ).toEqual(before.transcript?.messages);
            }
            const final = yield* readThread();
            expect(
              final.messages
                .filter((message) => message.role === "user")
                .map((message) => message.text),
            ).toEqual(["UPGRADE_FIRST_COORD", "UPGRADE_CONTINUE_COORD"]);
            expect(fixture.completed.size).toBe(4);
            expect(fixture.calls).toHaveLength(8);
            expect(fixture.peers.size).toBe(2);
            yield* stage("current:both-original-sessions-continued-with-stable-peers");
          }).pipe(Effect.onExit(recordFailure)),
        ).pipe(Effect.raceFirst(Effect.promise(() => fixture.failed)));
        yield* stage("current:closing");
        const newExit = yield* Effect.promise(() => next.server.close());
        expect(newExit.signal).toBeNull();
        expect([0, 130]).toContain(newExit.code);
        exits.push(newExit);
        yield* stage("current:ordinary-shutdown");
      }).pipe(Effect.scoped, Effect.timeout("300 seconds")),
    310_000,
  );
});

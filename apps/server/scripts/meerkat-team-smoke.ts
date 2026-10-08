#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - manual proof against the owned isolated prototype.
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ORCHESTRATION_WS_METHODS as O,
  WS_METHODS as W,
  WsRpcGroup,
  type MeerkatProjectTeam,
  type MeerkatAgentActivity,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const home = process.env.MEERKAT_PROTOTYPE_HOME;
if (!home) throw new Error("Set MEERKAT_PROTOTYPE_HOME.");
const server = JSON.parse(await NodeFSP.readFile(`${home}/server-process.json`, "utf8"));
const auth = JSON.parse(await NodeFSP.readFile(`${home}/smoke-auth.json`, "utf8"));
const previous = JSON.parse(await NodeFSP.readFile(`${home}/client-smoke-report.json`, "utf8"));
const projectPath = await NodeFSP.mkdtemp(NodePath.join(home, "team-project-"));
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
await execFile("git", ["init", "--initial-branch=main", projectPath]);
await execFile("git", [
  "-C",
  projectPath,
  "-c",
  "user.name=Meerkat Proof",
  "-c",
  "user.email=proof@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "commit",
  "--allow-empty",
  "-m",
  "Initialize disposable Team proof",
]);
const otherPath = await NodeFSP.mkdtemp(NodePath.join(home, "team-other-project-"));
const nonce = NodeCrypto.randomUUID();
const projectId = ProjectId.make(`team-project-${nonce}`);
const otherProjectId = ProjectId.make(`team-other-${nonce}`);
const threadId = ThreadId.make(`team-thread-${nonce}`);
const instanceId = ProviderInstanceId.make("meerkat");
const modelSelection = { instanceId, model: previous.model };
const expected = `NATIVE_TEAM_${NodeCrypto.randomBytes(16).toString("hex")}`;
const tokenPath = NodePath.join(projectPath, "worker-token.txt");
const resultPath = NodePath.join(projectPath, "worker-result.txt");
await NodeFSP.writeFile(tokenPath, expected);
const url = new URL("/ws", server.url);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
const protocol = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(
    Socket.layerWebSocket(url.toString()).pipe(
      Layer.provide(
        Layer.succeed(
          Socket.WebSocketConstructor,
          (address, protocols) =>
            new NodeSocket.NodeWS.WebSocket(address, protocols as string[] | undefined, {
              headers: { authorization: `Bearer ${auth.token}` },
            }) as unknown as globalThis.WebSocket,
        ),
      ),
    ),
  ),
  Layer.provide(RpcSerialization.layerJson),
);
const check = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const evidence: Record<string, unknown> = {
  projectId,
  otherProjectId,
  threadId,
  projectPath,
  model: previous.model,
  startedAt: DateTime.formatIso(DateTime.nowUnsafe()),
  serverPid: server.pid,
};
let phase = "connect";
let selectedRef = "";
let finalActivity: MeerkatAgentActivity | undefined;
const run = Effect.gen(function* () {
  yield* Effect.scoped(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(WsRpcGroup);
      const now = () => DateTime.formatIso(DateTime.nowUnsafe());
      const config = yield* client[W.serverGetConfig]({});
      check(
        config.providers.some(
          (provider) => provider.instanceId === instanceId && provider.status === "ready",
        ),
        "Meerkat provider is unavailable.",
      );
      for (const [id, path, title] of [
        [projectId, projectPath, "Native Team proof"],
        [otherProjectId, otherPath, "Team isolation proof"],
      ] as const) {
        yield* client[O.dispatchCommand]({
          type: "project.create",
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          projectId: id,
          title,
          workspaceRoot: path,
          createdAt: now(),
        });
      }
      yield* client[O.dispatchCommand]({
        type: "thread.create",
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId,
        projectId,
        title: "Native worker with no chat observer",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now(),
      });
      phase = "cold-observation";
      const cold = yield* client[W.meerkatProjectTeam]({ projectId });
      const coldAgain = yield* client[W.meerkatProjectTeam]({ projectId });
      for (const observation of [cold, coldAgain]) {
        const provider = observation.providers.find((entry) => entry.instanceId === instanceId);
        check(
          Boolean(
            provider &&
            provider.unloadedScopeCount > 0 &&
            provider.loadedMobCount === 0 &&
            provider.agents.length === 0,
          ),
          "A cold read did not report the unloaded runtime.",
        );
      }
      evidence.cold = [cold, coldAgain];
      const subscribed = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<string>();
      const observer = yield* client[O.subscribeShell]({ requestCompletionMarker: true }).pipe(
        Stream.runForEach((item) => {
          if (item.kind === "synchronized") return Deferred.succeed(subscribed, undefined);
          if (
            item.kind === "thread-upserted" &&
            item.thread.id === threadId &&
            item.thread.latestTurn &&
            ["completed", "failed", "interrupted"].includes(item.thread.latestTurn.state)
          ) {
            return Deferred.succeed(completed, item.thread.latestTurn.state);
          }
          return Effect.void;
        }),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Deferred.await(subscribed);
      const childMobId = `team-proof-${nonce}`;
      const definition = {
        id: childMobId,
        profiles: {
          worker: {
            model: previous.model.replace(/^[^:]+:/, ""),
            runtime_mode: "autonomous_host",
            tools: { builtins: true, shell: true, comms: true },
          },
        },
      };
      const worker = {
        mob_id: childMobId,
        profile: "worker",
        member_id: "team-worker",
        runtime_mode: "autonomous_host",
        auto_wire_parent: true,
        initial_message: `This is a disposable integration proof. Run exactly one shell command: sleep 15; cat '${tokenPath}' | tee '${resultPath}'. Reply with exactly the token from stdout. Do not delegate or use other tools.`,
      };
      phase = "spawn-native-child";
      yield* client[O.dispatchCommand]({
        type: "thread.turn.start",
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId,
        message: {
          messageId: MessageId.make(NodeCrypto.randomUUID()),
          role: "user",
          attachments: [],
          text: `Perform orchestration only. Call mob_create with definition ${encodeJson(definition)}, then mob_spawn_member with ${encodeJson(worker)}. After the spawn call succeeds, immediately reply TEAM_SPAWNED. Do not wait for the worker, inspect its output, run shell, read files, or retire/destroy the team.`,
        },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        handlingMode: "queue",
        createdAt: now(),
      });
      const terminal = yield* Deferred.await(completed).pipe(Effect.timeout("2 minutes"));
      check(terminal === "completed", "Coordinator did not complete its spawn turn.");
      yield* Fiber.interrupt(observer);
      evidence.chatObserversClosedAt = now();
      yield* Console.log(
        "Coordinator finished. Observing the native worker through Team with no chat subscription.",
      );
      phase = "observe-child-independent-of-chat";
      const observations: Array<{ team: MeerkatProjectTeam; activity?: MeerkatAgentActivity }> = [];
      yield* Effect.gen(function* () {
        for (;;) {
          const team = yield* client[W.meerkatProjectTeam]({ projectId });
          const provider = team.providers.find((entry) => entry.instanceId === instanceId);
          const agent = provider?.agents.find(
            (entry) =>
              entry.record.runtime_member_id === "team-worker" ||
              entry.record.identity === "team-worker",
          );
          if (agent) {
            check(
              agent.record.labels.source_mob_id === childMobId,
              "Native child provenance was lost.",
            );
            selectedRef = agent.agentRef;
            const activity = yield* client[W.meerkatAgentActivity]({
              projectId,
              instanceId,
              agentRef: selectedRef,
              limit: 100,
            });
            observations.push({ team, activity });
            if (
              activity.timeline.frames.some(
                (frame) =>
                  frame.kind === "interaction_complete" &&
                  JSON.stringify(frame.payload).includes(expected),
              )
            ) {
              finalActivity = activity;
              return;
            }
          } else observations.push({ team });
          yield* Effect.sleep("2 seconds");
        }
      }).pipe(Effect.timeout("2 minutes"));
      check(
        observations.length > 1,
        "Worker did not remain observable after coordinator completion.",
      );
      evidence.observations = observations;
      const data = yield* Effect.promise(() => NodeFSP.readFile(resultPath, "utf8"));
      check(data === expected, "Worker did not produce the expected independent file effect.");
      check(
        finalActivity?.timeline.frames.some(
          (frame) =>
            frame.kind === "tool_execution_completed" &&
            JSON.stringify(frame.payload).includes(expected),
        ) ?? false,
        "Team activity did not include the real worker tool result.",
      );
      phase = "project-isolation";
      const other = yield* client[W.meerkatProjectTeam]({ projectId: otherProjectId });
      check(
        other.providers.every((entry) => entry.agents.length === 0),
        "Another project leaked this team's agents.",
      );
      const rejected = yield* client[W.meerkatAgentActivity]({
        projectId: otherProjectId,
        instanceId,
        agentRef: selectedRef,
      }).pipe(Effect.match({ onFailure: () => true, onSuccess: () => false }));
      check(rejected, "Cross-project activity reference was accepted.");
      evidence.crossProjectRefRejected = rejected;
      evidence.otherProject = other;
    }).pipe(Effect.provide(protocol)),
  );
  phase = "fresh-websocket-reconnect";
  yield* Effect.scoped(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(WsRpcGroup);
      const team = yield* client[W.meerkatProjectTeam]({ projectId });
      check(
        team.providers.some(
          (provider) =>
            provider.instanceId === instanceId &&
            provider.agents.some((agent) => agent.agentRef === selectedRef),
        ),
        "The native worker disappeared across a client reconnect.",
      );
      const activity = yield* client[W.meerkatAgentActivity]({
        projectId,
        instanceId,
        agentRef: selectedRef,
        limit: 100,
      });
      check(
        activity.timeline.frames.some(
          (frame) =>
            frame.kind === "interaction_complete" &&
            JSON.stringify(frame.payload).includes(expected),
        ),
        "Worker completion was lost across reconnect.",
      );
      check(
        new Set(activity.timeline.frames.map((frame) => frame.id)).size ===
          activity.timeline.frames.length,
        "Duplicate native frame IDs after reconnect.",
      );
      evidence.reconnected = { team, activity };
    }).pipe(Effect.provide(protocol)),
  );
  evidence.ok = true;
});
await Effect.runPromise(run.pipe(Effect.scoped, Effect.timeout("5 minutes"))).catch(
  (error: unknown) => {
    evidence.ok = false;
    evidence.error = error instanceof Error ? error.message : "Team integration proof failed.";
    process.exitCode = 1;
  },
);
evidence.phase = phase;
evidence.finishedAt = DateTime.formatIso(DateTime.nowUnsafe());
await NodeFSP.writeFile(
  `${home}/team-smoke-report.json`,
  `${JSON.stringify(evidence, null, 2)}\n`,
  {
    mode: 0o600,
  },
);
await Effect.runPromise(
  Console.log(
    JSON.stringify({
      ok: evidence.ok,
      phase,
      projectId,
      threadId,
      report: `${home}/team-smoke-report.json`,
      error: evidence.error,
    }),
  ),
);

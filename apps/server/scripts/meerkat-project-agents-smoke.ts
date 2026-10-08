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
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

const home = process.env.MEERKAT_PROTOTYPE_HOME;
if (!home) throw new Error("Set MEERKAT_PROTOTYPE_HOME.");
const server = JSON.parse(await NodeFSP.readFile(`${home}/server-process.json`, "utf8"));
const auth = JSON.parse(await NodeFSP.readFile(`${home}/smoke-auth.json`, "utf8"));
const previous = JSON.parse(await NodeFSP.readFile(`${home}/client-smoke-report.json`, "utf8"));
const resumeFile = process.env.MEERKAT_AGENT_PROOF_RESUME;
const resume = resumeFile ? JSON.parse(await NodeFSP.readFile(resumeFile, "utf8")) : null;
const nonce = resume
  ? String(resume.projectId).replace("agents-project-", "")
  : NodeCrypto.randomUUID();
const projectId = ProjectId.make(`agents-project-${nonce}`);
const otherProjectId = ProjectId.make(`agents-isolation-${nonce}`);
const threadId = ThreadId.make(`agents-thread-${nonce}`);
const instanceId = ProviderInstanceId.make("meerkat");
const modelSelection = { instanceId, model: previous.model };
const projectPath =
  resume?.projectPath ?? (await NodeFSP.mkdtemp(NodePath.join(home, "agents-project-")));
const otherPath = await NodeFSP.mkdtemp(NodePath.join(home, "agents-isolation-"));
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
if (!resume) {
  await exec("git", ["init", "--initial-branch=main", projectPath]);
  await exec("git", [
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
    "Initialize disposable project agent proof",
  ]);
}
const secret = `PROJECT_MEMORY_${NodeCrypto.randomBytes(12).toString("hex")}`;
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
const check = (ok: unknown, message: string) => {
  if (!ok) throw new Error(message);
};
const now = () => DateTime.formatIso(DateTime.nowUnsafe());
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const evidence: Record<string, unknown> = {
  projectId,
  otherProjectId,
  threadId,
  projectPath,
  model: previous.model,
  startedAt: now(),
  ...(resume ? { resumedFrom: resumeFile, agentId: resume.agentId } : {}),
};
let phase = "connect";
const run = Effect.scoped(
  Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    const rejected = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.match({ onFailure: () => true, onSuccess: () => false }));
    let activeAgent;
    if (!resume) {
      for (const [id, path, title] of [
        [projectId, projectPath, "Project agents proof"],
        [otherProjectId, otherPath, "Project agent isolation proof"],
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
      const createInput = {
        projectId,
        instanceId,
        requestId: NodeCrypto.randomUUID(),
        label: "Project Architect",
        role: "architect",
        model: previous.model,
        instructions:
          "You are the persistent project architect in a disposable integration proof. Follow the user's instructions precisely. Retain facts from your conversation. Do not change files or spawn agents unless explicitly asked. For simple recall questions respond directly from conversation history.",
      };
      phase = "create";
      const agent = yield* client[W.meerkatProjectAgentCreate](createInput);
      evidence.agentId = agent.agentId;
      check(
        agent.connectionStatus === "connected" && agent.agentRef,
        `Agent did not connect: ${agent.error ?? agent.connectionStatus}`,
      );
      const duplicate = yield* client[W.meerkatProjectAgentCreate](createInput);
      check(duplicate.agentId === agent.agentId, "Creation retry duplicated agent.");
      check(
        (yield* client[W.meerkatProjectAgents]({ projectId })).agents.length === 1,
        "Creation is not idempotent.",
      );
      check(
        yield* rejected(client[W.meerkatProjectAgentCreate]({ ...createInput, label: "Changed" })),
        "Changed creation request was accepted.",
      );
      const activity = (agentRef: string) =>
        client[W.meerkatAgentActivity]({ projectId, instanceId, agentRef, limit: 100 });
      const waitAnswer = (agentRef: string, expected: string, after: number) =>
        Effect.gen(function* () {
          for (;;) {
            const observation = yield* activity(agentRef);
            if (
              observation.timeline.frames.some(
                (frame) =>
                  frame.timestamp_ms >= after &&
                  frame.kind === "interaction_complete" &&
                  encodeJson(frame.payload).includes(expected),
              )
            )
              return observation;
            yield* Effect.sleep("1 second");
          }
        }).pipe(Effect.timeout("90 seconds"));
      phase = "first-conversation";
      const firstTime = DateTime.toEpochMillis(yield* DateTime.now);
      const sendInput = {
        projectId,
        instanceId,
        agentRef: agent.agentRef!,
        requestId: NodeCrypto.randomUUID(),
        text: `Remember this exact project marker for future questions: ${secret}. Reply with exactly SAVED. Do not use tools.`,
        handlingMode: "queue" as const,
      };
      const receipt = yield* client[W.meerkatAgentSend](sendInput);
      check(receipt.status === "accepted", "First send was not accepted.");
      const replay = yield* client[W.meerkatAgentSend](sendInput);
      check(
        encodeJson(receipt.receipt) === encodeJson(replay.receipt),
        "Retry did not reuse native receipt.",
      );
      evidence.first = yield* waitAnswer(agent.agentRef!, "SAVED", firstTime);
      check(
        yield* rejected(
          client[W.meerkatAgentActivity]({
            projectId: otherProjectId,
            instanceId,
            agentRef: agent.agentRef!,
          }),
        ),
        "Cross-project history leaked.",
      );
      check(
        yield* rejected(
          client[W.meerkatAgentSend]({
            ...sendInput,
            projectId: otherProjectId,
            requestId: NodeCrypto.randomUUID(),
          }),
        ),
        "Cross-project send was accepted.",
      );
      phase = "disconnect-and-restore";
      yield* client[W.meerkatProjectAgentLifecycle]({
        projectId,
        agentId: agent.agentId,
        action: "disconnect",
      });
      check(
        yield* rejected(
          client[W.meerkatAgentSend]({ ...sendInput, requestId: NodeCrypto.randomUUID() }),
        ),
        "Disconnected agent still accepts messages.",
      );
      const restored = yield* client[W.meerkatProjectAgentLifecycle]({
        projectId,
        agentId: agent.agentId,
        action: "connect",
      });
      check(
        restored.connectionStatus === "connected" && restored.agentRef,
        "Agent did not reconnect.",
      );
      const retained = yield* activity(restored.agentRef!);
      check(
        retained.timeline.frames.some((frame) => encodeJson(frame.payload).includes(secret)),
        "Native conversation history did not survive teardown.",
      );
      const recallTime = DateTime.toEpochMillis(yield* DateTime.now);
      yield* client[W.meerkatAgentSend]({
        ...sendInput,
        agentRef: restored.agentRef!,
        requestId: NodeCrypto.randomUUID(),
        text: "What was the exact project marker I asked you to remember? Reply with just that marker. Do not use tools.",
      });
      evidence.recalled = yield* waitAnswer(restored.agentRef!, secret, recallTime);
      activeAgent = restored;
    } else {
      activeAgent = yield* client[W.meerkatProjectAgentLifecycle]({
        projectId,
        agentId: resume.agentId,
        action: "connect",
      });
    }
    const agent = activeAgent;
    const restored = activeAgent;
    const sendInput = {
      projectId,
      instanceId,
      agentRef: agent.agentRef!,
      requestId: NodeCrypto.randomUUID(),
      text: "Do not accept while archived",
      handlingMode: "queue" as const,
    };
    phase = "native-thread-connections";
    yield* Console.log("Checking native thread connections");
    if (!resume)
      yield* client[O.dispatchCommand]({
        type: "thread.create",
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId,
        projectId,
        title: "Thread with project architect",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now(),
      });
    const before = yield* client[W.meerkatThreadConnections]({ projectId, threadId, instanceId });
    check(
      before.desiredAgentIds.includes(agent.agentId) && (resume || !before.explicit),
      "New thread did not default to its enabled project agent.",
    );
    yield* client[W.meerkatThreadConnectionsSet]({
      projectId,
      threadId,
      instanceId,
      agentIds: [agent.agentId],
      requestId: NodeCrypto.randomUUID(),
    });
    const synchronized = yield* Deferred.make<void>();
    const threadCompleted = yield* Deferred.make<string>();
    const turnStartedAt = now();
    yield* client[O.subscribeShell]({ requestCompletionMarker: true }).pipe(
      Stream.runForEach((item) => {
        if (item.kind === "synchronized") return Deferred.succeed(synchronized, undefined);
        if (
          item.kind === "thread-upserted" &&
          item.thread.id === threadId &&
          item.thread.latestTurn &&
          item.thread.latestTurn.requestedAt >= turnStartedAt &&
          ["completed", "error", "interrupted"].includes(item.thread.latestTurn.state)
        ) return Deferred.succeed(threadCompleted, item.thread.latestTurn.state);
        return Effect.void;
      }),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* Deferred.await(synchronized);
    yield* client[O.dispatchCommand]({
      type: "thread.turn.start",
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      threadId,
      message: {
        messageId: MessageId.make(NodeCrypto.randomUUID()),
        role: "user",
        attachments: [],
        text: "Reply exactly THREAD_READY. Do not use tools or delegate.",
      },
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      handlingMode: "queue",
      createdAt: now(),
    });
    const connected = yield* Effect.gen(function* () {
      for (;;) {
        const state = yield* client[W.meerkatThreadConnections]({
          projectId,
          threadId,
          instanceId,
        });
        if (
          state.connections.some(
            (entry) => entry.agentId === agent.agentId && entry.status === "connected",
          )
        )
          return state;
        yield* Effect.sleep("1 second");
      }
    }).pipe(Effect.timeout("90 seconds"));
    evidence.connections = connected;
    const terminal = yield* Deferred.await(threadCompleted).pipe(Effect.timeout("90 seconds"));
    check(terminal === "completed", `Connected thread ended as ${terminal}.`);
    evidence.threadTerminal = terminal;
    const solo = yield* client[W.meerkatThreadConnectionsSet]({
      projectId,
      threadId,
      instanceId,
      agentIds: [],
      requestId: NodeCrypto.randomUUID(),
    });
    check(
      solo.explicit &&
        solo.desiredAgentIds.length === 0 &&
        solo.connections.every((entry) => entry.status !== "connected"),
      "Live solo did not remove the native edge.",
    );
    evidence.solo = solo;
    const reconnected = yield* client[W.meerkatThreadConnectionsSet]({
      projectId,
      threadId,
      instanceId,
      agentIds: [agent.agentId],
      requestId: NodeCrypto.randomUUID(),
    });
    check(
      reconnected.connections.some(
        (entry) => entry.agentId === agent.agentId && entry.status === "connected",
      ),
      "Live reconnect did not restore native edge.",
    );
    phase = "archive-and-return";
    const archived = yield* client[W.meerkatProjectAgentLifecycle]({
      projectId,
      agentId: agent.agentId,
      action: "archive",
    });
    check(archived.archived && !archived.enabled, "Archive did not disable agent.");
    check(
      yield* rejected(
        client[W.meerkatAgentSend]({
          ...sendInput,
          agentRef: restored.agentRef!,
          requestId: NodeCrypto.randomUUID(),
        }),
      ),
      "Archived agent accepted a send.",
    );
    yield* client[W.meerkatProjectAgentLifecycle]({
      projectId,
      agentId: agent.agentId,
      action: "unarchive",
    });
    const finalAgent = yield* client[W.meerkatProjectAgentLifecycle]({
      projectId,
      agentId: agent.agentId,
      action: "connect",
    });
    check(finalAgent.connectionStatus === "connected", "Unarchive/connect failed.");
    evidence.finalAgent = finalAgent;
    evidence.finalTeam = yield* client[W.meerkatProjectTeam]({ projectId });
    evidence.ok = true;
  }).pipe(Effect.provide(protocol), Effect.timeout("6 minutes")),
);
await Effect.runPromise(run).catch((error: unknown) => {
  evidence.ok = false;
  evidence.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
});
evidence.phase = phase;
evidence.finishedAt = now();
await NodeFSP.writeFile(`${home}/project-agents-smoke-report.json`, encodeJson(evidence), {
  mode: 0o600,
});
await Effect.runPromise(
  Console.log(
    encodeJson({
      ok: evidence.ok,
      phase,
      projectId,
      threadId,
      agentId: evidence.agentId,
      error: evidence.error ?? null,
    }),
  ),
);

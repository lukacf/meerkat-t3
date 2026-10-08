#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - manual integration proof owns local evidence and a Node WebSocket client.
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
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

// Connects only to the already-running isolated prototype. Root owns its server
// process. A fresh disposable project and thread keep prior proofs untouched.
// No command is retried when its outcome is uncertain. Auth stays in private
// files and is never copied into the report or printed in an exception object.
const home = process.env.MEERKAT_PROTOTYPE_HOME;
if (!home) throw new Error("Set MEERKAT_PROTOTYPE_HOME.");
const server = JSON.parse(await NodeFSP.readFile(`${home}/server-process.json`, "utf8"));
const auth = JSON.parse(await NodeFSP.readFile(`${home}/smoke-auth.json`, "utf8"));
const previous = JSON.parse(await NodeFSP.readFile(`${home}/client-smoke-report.json`, "utf8"));
const projectPath = await NodeFSP.mkdtemp(NodePath.join(home, "steering-project-"));
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
  "Initialize disposable steering proof",
]);
const nonce = NodeCrypto.randomUUID();
const projectId = ProjectId.make(`steering-project-${nonce}`);
const threadId = ThreadId.make(`steering-thread-${nonce}`);
const firstMessageId = MessageId.make(`initial-${nonce}`);
const steerMessageId = MessageId.make(`steer-${nonce}`);
const modelSelection = { instanceId: ProviderInstanceId.make("meerkat"), model: previous.model };
const expected = `STEERING_APPLIED_${nonce}`;
const marker = "steered-result.txt";
const forbidden = "original-action-must-not-run.txt";
const readyMarker = "steering-tool-ready.txt";
const heldCommand = `printf TOOL_READY > ${readyMarker}; sleep 15`;
const correctedCommand = `echo ${expected} | tee -a ${marker}`;
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
class SteeringProofError extends Schema.TaggedError<SteeringProofError>()("SteeringProofError", {
  detail: Schema.String,
}) {}
const check = (condition: boolean, detail: string) => {
  if (!condition) throw new SteeringProofError({ detail });
};
const ActivityPayload = Schema.Struct({
  toolCallId: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Struct({ command: Schema.optional(Schema.String) })),
});
const decodeActivityPayload = Schema.decodeUnknownSync(ActivityPayload);
const payload = (activity: OrchestrationThreadActivity) => decodeActivityPayload(activity.payload);
const activities: OrchestrationThreadActivity[] = [];
const shellStates: Array<{
  turnId: string | null;
  state: string | null;
  activeTurnId: string | null;
}> = [];
const evidence: Record<string, unknown> = {
  threadId,
  projectId,
  projectPath,
  model: previous.model,
  serverPid: server.pid,
  startedAt: DateTime.formatIso(DateTime.nowUnsafe()),
};
let phase = "connect";

const run = Effect.gen(function* () {
  const client = yield* RpcClient.make(WsRpcGroup);
  const read = () =>
    client[O.subscribeThread]({ threadId }).pipe(
      Stream.filter((event) => event.kind === "snapshot"),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
      Effect.map((event) => event.snapshot),
    );
  const config = yield* client[W.serverGetConfig]({});
  const provider = config.providers.find((entry) => entry.instanceId === "meerkat");
  check(provider?.status === "ready", "Meerkat provider was not ready.");
  phase = "create-fixture";
  const createdAt = DateTime.formatIso(DateTime.nowUnsafe());
  yield* client[O.dispatchCommand]({
    type: "project.create",
    commandId: CommandId.make(NodeCrypto.randomUUID()),
    projectId,
    title: "Meerkat native steering proof",
    workspaceRoot: projectPath,
    createdAt,
  });
  yield* client[O.dispatchCommand]({
    type: "thread.create",
    commandId: CommandId.make(NodeCrypto.randomUUID()),
    threadId,
    projectId,
    title: "Steer during a real tool",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt,
  });
  const subscribed = yield* Deferred.make<void>();
  const shellSubscribed = yield* Deferred.make<void>();
  const toolStarted = yield* Deferred.make<OrchestrationThreadActivity>();
  yield* client[O.subscribeThread]({ threadId }).pipe(
    Stream.runForEach((item) => {
      if (item.kind === "snapshot") return Deferred.succeed(subscribed, undefined);
      if (item.kind !== "event" || item.event.type !== "thread.activity-appended")
        return Effect.void;
      const activity = item.event.payload.activity;
      activities.push(activity);
      return activity.kind === "tool.started"
        ? Deferred.succeed(toolStarted, activity)
        : Effect.void;
    }),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* client[O.subscribeShell]({ requestCompletionMarker: true }).pipe(
    Stream.runForEach((item) => {
      if (item.kind === "synchronized") return Deferred.succeed(shellSubscribed, undefined);
      if (item.kind !== "thread-upserted" || item.thread.id !== threadId) return Effect.void;
      shellStates.push({
        turnId: item.thread.latestTurn?.turnId ?? null,
        state: item.thread.latestTurn?.state ?? null,
        activeTurnId: item.thread.session?.activeTurnId ?? null,
      });
      return Effect.void;
    }),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* Deferred.await(subscribed);
  yield* Deferred.await(shellSubscribed);
  phase = "initial-dispatch";
  const firstReceipt = yield* client[O.dispatchCommand]({
    type: "thread.turn.start",
    commandId: CommandId.make(NodeCrypto.randomUUID()),
    threadId,
    message: {
      messageId: firstMessageId,
      role: "user",
      attachments: [],
      text: `This is an integration test in a disposable directory. First call shell with exactly ${heldCommand}. Once it finishes, make a SEPARATE shell call with exactly echo ORIGINAL_ACTION | tee ${forbidden}. After the final shell call, reply with exactly its stdout, whichever action was ultimately chosen. This final-response rule still applies if a later correction changes the action. The two commands must be separate tool calls, with the second after the first result. Do not combine them. Do not delegate or use other tools.`,
    },
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    handlingMode: "queue",
    createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
  });
  phase = "wait-for-real-tool";
  const firstTool = yield* Deferred.await(toolStarted).pipe(Effect.timeout("60 seconds"));
  const firstToolPayload = payload(firstTool);
  check(Boolean(firstToolPayload.toolCallId), "First tool lacks runtime tool identity.");
  check(
    firstToolPayload.data?.command === heldCommand,
    "First running tool is not the expected held shell command.",
  );
  // ToolCallRequested precedes process execution. The sentinel independently
  // proves the shell has begun before we send the correction.
  yield* Effect.gen(function* () {
    for (;;) {
      const ready = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(projectPath, readyMarker), "utf8").catch(() => null),
      );
      if (ready === "TOOL_READY") return;
      yield* Effect.sleep("100 millis");
    }
  }).pipe(Effect.timeout("10 seconds"));
  evidence.toolExecutionObservedAt = DateTime.formatIso(DateTime.nowUnsafe());
  const active = yield* read();
  check(
    active.thread.latestTurn?.state === "running",
    "No active turn when steering was submitted.",
  );
  check(
    !activities.some(
      (activity) =>
        activity.kind === "tool.completed" &&
        payload(activity).toolCallId === firstToolPayload.toolCallId,
    ),
    "Held tool completed before steering dispatch.",
  );
  const readyStat = yield* Effect.promise(() =>
    NodeFSP.stat(NodePath.join(projectPath, readyMarker)),
  );
  check(
    DateTime.toEpochMillis(DateTime.nowUnsafe()) - readyStat.mtimeMs < 10_000,
    "Too much time elapsed after the shell ready marker to prove execution overlap.",
  );
  evidence.firstRunId = active.thread.latestTurn?.turnId;
  evidence.firstToolCallId = firstToolPayload.toolCallId;
  evidence.steerSubmittedAt = DateTime.formatIso(DateTime.nowUnsafe());
  phase = "steering-dispatch";
  const steerReceipt = yield* client[O.dispatchCommand]({
    type: "thread.turn.start",
    commandId: CommandId.make(NodeCrypto.randomUUID()),
    threadId,
    message: {
      messageId: steerMessageId,
      role: "user",
      attachments: [],
      text: `Steering correction while your first shell tool is running: CANCEL the planned original action. Never create ${forbidden} and do not execute echo ORIGINAL_ACTION. After the current sleep finishes, instead run exactly one shell call with ${correctedCommand}. Then reply with exactly ${expected}. Do not repeat the sleep, do not delegate, and do not run any other shell commands.`,
    },
    // The active session owns provider/model identity during steering.
    runtimeMode: "full-access",
    interactionMode: "default",
    handlingMode: "steer",
    createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
  });
  evidence.firstReceiptSequence = firstReceipt.sequence;
  evidence.steerReceiptSequence = steerReceipt.sequence;
  yield* Console.log("Steering was dispatched while the real shell tool was active.");
  phase = "wait-for-steered-completion";
  const finished = yield* Effect.gen(function* () {
    for (;;) {
      const snapshot = yield* read();
      const thread = snapshot.thread;
      const failure = thread.activities.find(
        (activity) => activity.kind === "provider.turn.start.failed",
      );
      check(!failure, "Steering command was rejected by the provider.");
      check(thread.session?.status !== "error", "Provider session entered an error state.");
      const hasResult = thread.messages.some(
        (message) => message.role === "assistant" && message.text.trim() === expected,
      );
      if (
        hasResult &&
        thread.latestTurn?.state === "completed" &&
        thread.session?.activeTurnId == null
      )
        return snapshot;
      yield* Effect.sleep("500 millis");
    }
  }).pipe(Effect.timeout("3 minutes"));
  phase = "verify-effects-and-history";
  const contents = yield* Effect.promise(() =>
    NodeFSP.readFile(NodePath.join(projectPath, marker), "utf8"),
  );
  check(
    contents === `${expected}\n`,
    "Steered action was missing, divergent, or executed more than once.",
  );
  const forbiddenExists = yield* Effect.promise(() =>
    NodeFSP.access(NodePath.join(projectPath, forbidden)).then(
      () => true,
      () => false,
    ),
  );
  check(!forbiddenExists, "The replaced original action still executed.");
  const thread = finished.thread;
  check(
    thread.latestTurn?.turnId === evidence.firstRunId,
    "Steering lost its original application run identity.",
  );
  check(
    thread.messages.filter((message) => message.id === firstMessageId).length === 1,
    "Original user input was duplicated or lost.",
  );
  check(
    thread.messages.filter((message) => message.id === steerMessageId).length === 1,
    "Steering user input was duplicated or lost.",
  );
  check(
    thread.messages.filter(
      (message) => message.role === "assistant" && message.text.trim() === expected,
    ).length === 1,
    "Steering produced duplicate final assistant output.",
  );
  const toolStarts = thread.activities.filter((activity) => activity.kind === "tool.started");
  const toolEnds = thread.activities.filter((activity) => activity.kind === "tool.completed");
  const startIds = toolStarts.map((activity) => payload(activity).toolCallId);
  const endIds = toolEnds.map((activity) => payload(activity).toolCallId);
  check(
    toolStarts.length === 2 && toolEnds.length === 2,
    "Expected exactly the held tool and corrected tool lifecycles.",
  );
  check(
    [...startIds, ...endIds].every((id) => typeof id === "string" && id.trim().length > 0) &&
      new Set(startIds).size === 2 &&
      new Set(endIds).size === 2 &&
      startIds.every((id) => endIds.includes(id)),
    "Tools were duplicated or lack matching runtime identities.",
  );
  for (const command of [heldCommand, correctedCommand]) {
    check(
      toolStarts.filter((activity) => payload(activity).data?.command === command).length === 1 &&
        toolEnds.filter((activity) => payload(activity).data?.command === command).length === 1,
      "A tool command differed from the exact prescribed action.",
    );
  }
  check(
    toolEnds.every((activity) => payload(activity).status === "completed"),
    "A shell tool failed.",
  );
  return {
    ...evidence,
    status: "passed",
    finishedAt: DateTime.formatIso(DateTime.nowUnsafe()),
    finalRunId: thread.latestTurn?.turnId,
    finalState: thread.latestTurn?.state,
    toolExecutionObservedBeforeSteering: true,
    heldCommand,
    correctedCommand,
    revisedActionExecutedOnce: true,
    originalActionAbsent: true,
    distinctToolIds: startIds,
    initialUserMessageCount: 1,
    steeringUserMessageCount: 1,
    correctedAssistantMessageCount: 1,
    shellStates,
  };
}).pipe(Effect.provide(protocol), Effect.scoped, Effect.timeout("5 minutes"));

try {
  const result = await Effect.runPromise(run);
  const reportPath = `${home}/steering-report.json`;
  await NodeFSP.writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await Effect.runPromise(Console.log({ status: result.status, threadId, reportPath }));
} catch {
  const reportPath = `${home}/steering-failure-${nonce}.json`;
  await NodeFSP.writeFile(
    reportPath,
    `${JSON.stringify({ ...evidence, status: "failed", phase, activities, shellStates }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await Effect.runPromise(
    Console.error(`Steering proof failed during ${phase}; private evidence: ${reportPath}`),
  );
  process.exitCode = 1;
}

#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - manual integration proof owns local evidence files and a Node WebSocket client.
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  MessageId,
  ThreadId,
  ProviderInstanceId,
  ORCHESTRATION_WS_METHODS as O,
  WS_METHODS as W,
  WsRpcGroup,
  type OrchestrationThreadActivity,
  type TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import * as Console from "effect/Console";
import * as Schema from "effect/Schema";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

// Run checkpoint, restart the owned server, then run recover. Credentials are
// read from private prototype files and never included in evidence or errors.
const home = process.env.MEERKAT_PROTOTYPE_HOME;
if (!home) throw new Error("Set MEERKAT_PROTOTYPE_HOME.");
const mode = process.argv[2];
if (!["checkpoint", "recover", "cancel"].includes(mode ?? ""))
  throw new Error("Use checkpoint, recover, or cancel.");
const server = JSON.parse(await NodeFSP.readFile(`${home}/server-process.json`, "utf8"));
const auth = JSON.parse(await NodeFSP.readFile(`${home}/smoke-auth.json`, "utf8"));
const previous = JSON.parse(await NodeFSP.readFile(`${home}/client-smoke-report.json`, "utf8"));
const threadId = ThreadId.make(previous.threadId);
const url = new URL("/ws", server.url);
url.protocol = "ws:";
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
const signature = (messages: ReadonlyArray<{ id: string; role: string; text: string }>) =>
  JSON.stringify(messages.map(({ id, role, text }) => ({ id, role, text })));
const decodeCheckpoint = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      serverPid: Schema.Number,
      messages: Schema.String,
      state: Schema.Literals(["completed", "interrupted"]),
    }),
  ),
);
const decodeActivityPayload = Schema.decodeUnknownSync(
  Schema.Struct({
    toolCallId: Schema.optional(Schema.String),
    data: Schema.optional(Schema.Struct({ command: Schema.optional(Schema.String) })),
  }),
);
const payload = (activity: OrchestrationThreadActivity) => decodeActivityPayload(activity.payload);

const run = Effect.gen(function* () {
  const client = yield* RpcClient.make(WsRpcGroup);
  const read = () =>
    client[O.subscribeThread]({ threadId }).pipe(
      Stream.filter((event) => event.kind === "snapshot"),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
      Effect.map((event) => event.snapshot),
    );
  const initial = yield* read();
  if (mode === "checkpoint") {
    check(
      initial.thread.latestTurn?.state === "completed" ||
        initial.thread.latestTurn?.state === "interrupted",
      "Recovery checkpoint requires a completed or interrupted turn.",
    );
    return {
      mode,
      serverPid: server.pid,
      threadId,
      messages: signature(initial.thread.messages),
      state: initial.thread.latestTurn?.state,
    };
  }
  if (mode === "cancel") {
    check(initial.thread.session?.activeTurnId == null, "A previous run is still active.");
    const subscribed = yield* Deferred.make<void>();
    const shellSubscribed = yield* Deferred.make<void>();
    const toolStarted = yield* Deferred.make<OrchestrationThreadActivity>();
    const terminal = yield* Deferred.make<{ turnId: TurnId; state: string }>();
    const priorTurn = initial.thread.latestTurn?.turnId;
    const nonce = NodeCrypto.randomUUID();
    const marker = `cancel-proof-${nonce}.txt`;
    const readyMarker = `cancel-tool-ready-${nonce}.txt`;
    const heldCommand = `printf CANCEL_TOOL_READY > ${readyMarker}; sleep 15`;
    const activities: OrchestrationThreadActivity[] = [];
    let cancelledRunId: TurnId | undefined;
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
        const turn = item.thread.latestTurn;
        return turn && turn.turnId === cancelledRunId && turn.state !== "running"
          ? Deferred.succeed(terminal, { turnId: turn.turnId, state: turn.state })
          : Effect.void;
      }),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* Deferred.await(subscribed);
    yield* Deferred.await(shellSubscribed);
    yield* client[O.dispatchCommand]({
      type: "thread.turn.start",
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      threadId,
      message: {
        messageId: MessageId.make(NodeCrypto.randomUUID()),
        role: "user",
        attachments: [],
        text: `This is a cancellation integration test in a disposable directory. First call shell with exactly ${heldCommand}. After that command finishes, call shell again with exactly printf SHOULD_NOT_RUN > ${marker}. These must be separate tool calls, with the second after the first result. Do not combine them or write the second file in the first call. Do not delegate or use other tools.`,
      },
      modelSelection: { instanceId: ProviderInstanceId.make("meerkat"), model: previous.model },
      runtimeMode: "full-access",
      interactionMode: "default",
      handlingMode: "queue",
      createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
    });
    const firstTool = yield* Deferred.await(toolStarted).pipe(Effect.timeout("60 seconds"));
    const firstToolPayload = payload(firstTool);
    check(
      Boolean(firstToolPayload.toolCallId?.trim()),
      "Running tool lacks a runtime tool identity.",
    );
    check(
      firstToolPayload.data?.command === heldCommand,
      "Running tool is not the exact held shell command.",
    );
    // ToolCallRequested precedes shell execution. Observe the command's own
    // sentinel before submitting cancellation during the bounded sleep window.
    yield* Effect.gen(function* () {
      for (;;) {
        const ready = yield* Effect.promise(() =>
          NodeFSP.readFile(`${previous.projectPath}/${readyMarker}`, "utf8").catch(() => null),
        );
        if (ready === "CANCEL_TOOL_READY") return;
        yield* Effect.sleep("100 millis");
      }
    }).pipe(Effect.timeout("10 seconds"));
    const toolExecutionObservedAt = DateTime.formatIso(DateTime.nowUnsafe());
    const active = yield* read();
    const activeTurn = active.thread.latestTurn;
    if (!activeTurn || activeTurn.state !== "running")
      throw new Error("Run was not active before cancellation.");
    cancelledRunId = activeTurn.turnId;
    check(
      cancelledRunId !== priorTurn &&
        active.thread.session?.activeTurnId === cancelledRunId &&
        firstTool.turnId === cancelledRunId,
      "Running tool and active session do not share the new application run identity.",
    );
    check(
      !activities.some(
        (activity) =>
          activity.kind === "tool.completed" &&
          payload(activity).toolCallId === firstToolPayload.toolCallId,
      ),
      "Held tool completed before cancellation dispatch.",
    );
    const readyStat = yield* Effect.promise(() =>
      NodeFSP.stat(`${previous.projectPath}/${readyMarker}`),
    );
    check(
      DateTime.toEpochMillis(DateTime.nowUnsafe()) - readyStat.mtimeMs < 10_000,
      "Too much time elapsed after shell readiness to prove cancellation during execution.",
    );
    const cancellationSubmittedAt = DateTime.formatIso(DateTime.nowUnsafe());
    yield* client[O.dispatchCommand]({
      type: "thread.turn.interrupt",
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      threadId,
      turnId: cancelledRunId,
      createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
    });
    const terminalState = yield* Deferred.await(terminal).pipe(Effect.timeout("60 seconds"));
    check(
      terminalState.turnId === cancelledRunId && terminalState.state === "interrupted",
      "Cancellation did not project as interrupted.",
    );
    const finished = yield* read();
    check(
      finished.thread.latestTurn?.turnId === cancelledRunId &&
        finished.thread.latestTurn.state === "interrupted",
      "Cancelled turn did not remain interrupted.",
    );
    check(
      finished.thread.session?.activeTurnId == null,
      "Cancelled turn retained an active turn binding.",
    );
    const toolStarts = finished.thread.activities.filter(
      (activity) => activity.turnId === cancelledRunId && activity.kind === "tool.started",
    );
    check(
      toolStarts.length === 1 &&
        payload(toolStarts[0]!).toolCallId === firstToolPayload.toolCallId &&
        payload(toolStarts[0]!).data?.command === heldCommand,
      "Cancellation lost the held tool identity or allowed an unexpected next tool.",
    );
    const exists = yield* Effect.promise(() =>
      NodeFSP.access(`${previous.projectPath}/${marker}`).then(
        () => true,
        () => false,
      ),
    );
    check(!exists, "Work after cancellation executed.");
    return {
      mode,
      status: "passed",
      threadId,
      cancelledRunId,
      runtimeToolId: firstToolPayload.toolCallId,
      heldCommand,
      toolExecutionObservedAt,
      cancellationSubmittedAt,
      toolExecutionObservedBeforeCancellation: true,
      runtimeTerminalProjected: "interrupted",
      unexpectedToolStarts: 0,
      followupToolDidNotExecute: true,
    };
  }
  const checkpoint = decodeCheckpoint(
    yield* Effect.promise(() => NodeFSP.readFile(`${home}/recovery-checkpoint.json`, "utf8")),
  );
  check(server.pid !== checkpoint.serverPid, "Server process was not restarted.");
  check(
    signature(initial.thread.messages) === checkpoint.messages,
    "Persisted transcript changed across server restart.",
  );
  check(
    initial.thread.latestTurn?.state === checkpoint.state,
    "Persisted runtime turn state changed across server restart.",
  );
  const expected = initial.thread.messages
    .find((message) => message.role === "assistant" && message.text.includes("MEERKAT_T3_OK_"))
    ?.text.trim();
  check(Boolean(expected), "No original sentinel in history.");
  const ready = yield* Deferred.make<void>();
  const done = yield* Deferred.make<string>();
  const previousTurnId = initial.thread.latestTurn?.turnId;
  yield* client[O.subscribeShell]({ requestCompletionMarker: true }).pipe(
    Stream.runForEach((event) => {
      if (event.kind === "synchronized") return Deferred.succeed(ready, undefined);
      if (event.kind !== "thread-upserted" || event.thread.id !== threadId) return Effect.void;
      if (event.thread.session?.status === "error")
        return Deferred.succeed(done, event.thread.session.lastError ?? "error");
      const turn = event.thread.latestTurn;
      return turn && turn.turnId !== previousTurnId && turn.state !== "running"
        ? Deferred.succeed(done, turn.state)
        : Effect.void;
    }),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* Deferred.await(ready);
  yield* client[O.dispatchCommand]({
    type: "thread.turn.start",
    commandId: CommandId.make(NodeCrypto.randomUUID()),
    threadId,
    message: {
      messageId: MessageId.make(NodeCrypto.randomUUID()),
      role: "user",
      text: "Without using any tools, reply with exactly the MEERKAT_T3_OK token from your previous response. Do not include any other text.",
      attachments: [],
    },
    modelSelection: { instanceId: ProviderInstanceId.make("meerkat"), model: previous.model },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
  });
  check((yield* Deferred.await(done)) === "completed", "Follow-up after restart did not complete.");
  const recovered = yield* read();
  const assistant = recovered.thread.messages.filter((message) => message.role === "assistant");
  check(
    assistant.at(-1)?.text.trim() === expected,
    "Runtime memory did not recover the exact prior sentinel.",
  );
  yield* client[W.vcsInit]({ cwd: previous.projectPath });
  const git = yield* client[W.vcsRefreshStatus]({ cwd: previous.projectPath });
  check(
    git.isRepo && git.workingTree.files.some((file) => file.path === "smoke.txt"),
    "T3 Git status missed the real tool change.",
  );
  const terminalId = `proof-${NodeCrypto.randomUUID()}`;
  const attached = yield* Deferred.make<void>();
  const output = yield* Deferred.make<void>();
  let text = "";
  yield* client[W.terminalAttach]({ threadId, terminalId, cwd: previous.projectPath }).pipe(
    Stream.runForEach((event) => {
      if (event.type === "snapshot") return Deferred.succeed(attached, undefined);
      if (event.type === "output") {
        text += event.data;
        if (text.includes("MEERKAT_PTY_OK")) return Deferred.succeed(output, undefined);
      }
      return Effect.void;
    }),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* Deferred.await(attached);
  yield* client[W.terminalWrite]({
    threadId,
    terminalId,
    data: "printf 'MEERKAT_%s\\n' 'PTY_OK'\n",
  });
  yield* Deferred.await(output).pipe(Effect.timeout("15 seconds"));
  yield* client[W.terminalClose]({ threadId, terminalId });
  return {
    mode,
    status: "passed",
    threadId,
    serverPid: server.pid,
    previousServerPid: checkpoint.serverPid,
    persistedTranscriptIdentical: true,
    runtimeMemoryRecovered: true,
    assistantMessages: assistant.length,
    gitRecognizedToolChange: true,
    realPtyOutput: true,
  };
}).pipe(Effect.provide(protocol), Effect.scoped, Effect.timeout("3 minutes"));
try {
  const result = await Effect.runPromise(run);
  const path = `${home}/${mode === "checkpoint" ? "recovery-checkpoint" : mode === "cancel" ? "cancellation-report" : "recovery-report"}.json`;
  await NodeFSP.writeFile(path, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await Effect.runPromise(
    Console.log({ ...result, ...("messages" in result ? { messages: "recorded" } : {}), path }),
  );
} catch (error) {
  await Effect.runPromise(
    Console.error(
      `Recovery smoke failed: ${error instanceof Error ? error.message : "unknown error"}`,
    ),
  );
  process.exitCode = 1;
}

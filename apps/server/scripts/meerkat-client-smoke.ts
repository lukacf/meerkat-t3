#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - this manual smoke owns a disposable project and uses a real Node WebSocket client.

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeCrypto from "node:crypto";
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
  WsRpcGroup,
  type OrchestrationThread,
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

/**
 * Runs against an already-started isolated prototype server. It never starts a
 * server or opens a browser. Credentials remain in the environment and are not
 * written to the report. A repeated command receipt is not a crash-replay test.
 *
 * Required: MEERKAT_SMOKE_URL, MEERKAT_SMOKE_MODEL, and either
 * MEERKAT_SMOKE_TOKEN, T3CODE_DEV_AUTH_TOKEN, or MEERKAT_SMOKE_COOKIE.
 * Optional: MEERKAT_SMOKE_ROOT, MEERKAT_SMOKE_REPORT.
 */
class MeerkatClientSmokeError extends Schema.TaggedError<MeerkatClientSmokeError>()(
  "MeerkatClientSmokeError",
  { detail: Schema.String },
) {}

const required = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) throw new MeerkatClientSmokeError({ detail: `Set ${key}.` });
  return value;
};

const wsUrl = new URL(required("MEERKAT_SMOKE_URL"));
wsUrl.protocol = wsUrl.protocol === "https:" || wsUrl.protocol === "wss:" ? "wss:" : "ws:";
wsUrl.pathname = "/ws";
wsUrl.search = "";
wsUrl.hash = "";
const model = required("MEERKAT_SMOKE_MODEL");
const devToken = process.env.T3CODE_DEV_AUTH_TOKEN;
const bearerToken = process.env.MEERKAT_SMOKE_TOKEN;
const cookie =
  process.env.MEERKAT_SMOKE_COOKIE ??
  (devToken
    ? `t3_dev_session_${NodeCrypto.createHash("sha256").update(devToken).digest("hex")}=${devToken}`
    : undefined);
if (!cookie && !bearerToken) {
  throw new MeerkatClientSmokeError({
    detail: "Set MEERKAT_SMOKE_TOKEN, T3CODE_DEV_AUTH_TOKEN, or MEERKAT_SMOKE_COOKIE.",
  });
}

const root = NodePath.resolve(process.env.MEERKAT_SMOKE_ROOT ?? NodeOS.tmpdir());
await NodeFSP.mkdir(root, { recursive: true });
const projectPath = await NodeFSP.mkdtemp(NodePath.join(root, "meerkat-client-smoke-"));
const suffix = NodePath.basename(projectPath).replaceAll("_", "-");
const projectId = ProjectId.make(`project-${suffix}`);
const threadId = ThreadId.make(`thread-${suffix}`);
const messageId = MessageId.make(`message-${suffix}`);
const commandId = CommandId.make(`turn-${suffix}`);
const token = `MEERKAT_T3_OK_${suffix}`;
const filePath = NodePath.join(projectPath, "smoke.txt");
const modelSelection = { instanceId: ProviderInstanceId.make("meerkat"), model };
const events: Array<{ type: string; sequence: number }> = [];

const protocol = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(
    Socket.layerWebSocket(wsUrl.toString()).pipe(
      Layer.provide(
        Layer.succeed(
          Socket.WebSocketConstructor,
          (url, protocols) =>
            new NodeSocket.NodeWS.WebSocket(url, protocols as string | string[] | undefined, {
              headers: bearerToken ? { authorization: `Bearer ${bearerToken}` } : { cookie },
            }) as unknown as globalThis.WebSocket,
        ),
      ),
    ),
  ),
  Layer.provide(RpcSerialization.layerJson),
);

const run = Effect.gen(function* () {
  const firstConnection = yield* Effect.scoped(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(WsRpcGroup);
      const config = yield* client[WS_METHODS.serverGetConfig]({});
      const provider = config.providers.find((candidate) => candidate.instanceId === "meerkat");
      if (provider?.status !== "ready" || !provider.models.some((entry) => entry.slug === model)) {
        return yield* new MeerkatClientSmokeError({
          detail: `Meerkat is not ready with the requested model: ${provider?.message ?? provider?.status ?? "missing"}.`,
        });
      }
      const createdAt = DateTime.formatIso(DateTime.nowUnsafe());
      yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
        type: "project.create",
        commandId: CommandId.make(`create-project-${suffix}`),
        projectId,
        title: "Meerkat client smoke",
        workspaceRoot: projectPath,
        createdAt,
      });
      yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
        type: "thread.create",
        commandId: CommandId.make(`create-thread-${suffix}`),
        threadId,
        projectId,
        title: "Real runtime and client reconnect",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });

      const subscribed = yield* Deferred.make<void>();
      const terminal = yield* Deferred.make<string>();
      yield* client[ORCHESTRATION_WS_METHODS.subscribeShell]({
        requestCompletionMarker: true,
      }).pipe(
        Stream.runForEach((item) => {
          if (item.kind === "synchronized") return Deferred.succeed(subscribed, undefined);
          if (item.kind !== "thread-upserted" || item.thread.id !== threadId) return Effect.void;
          const turn = item.thread.latestTurn;
          if (turn !== null && turn.state !== "running") {
            return Deferred.succeed(terminal, turn.state);
          }
          if (item.thread.session?.status === "error") {
            return Deferred.succeed(terminal, `error: ${item.thread.session.lastError}`);
          }
          return Effect.void;
        }),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId }).pipe(
        Stream.runForEach((item) =>
          Effect.sync(() => {
            if (item.kind === "event") {
              events.push({ type: item.event.type, sequence: item.event.sequence });
            }
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Deferred.await(subscribed);
      const command = {
        type: "thread.turn.start" as const,
        commandId,
        threadId,
        message: {
          messageId,
          role: "user" as const,
          text: `This is a small integration test in a disposable directory. Use a shell tool exactly once to append the single line ${token} to smoke.txt in the current working directory. Do not read or modify any other files. Then reply exactly ${token}.`,
          attachments: [],
        },
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
      };
      const receipt = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](command);
      const duplicateReceipt = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](command);
      if (receipt.sequence !== duplicateReceipt.sequence) {
        return yield* new MeerkatClientSmokeError({
          detail: "Duplicate command receipt changed sequence.",
        });
      }
      yield* Console.log(
        `Dispatched real Meerkat turn ${threadId}. Waiting for terminal runtime projection.`,
      );
      const state = yield* Deferred.await(terminal).pipe(Effect.timeout("4 minutes"));
      if (state !== "completed") {
        return yield* new MeerkatClientSmokeError({ detail: `Turn finished as ${state}.` });
      }
      return { receiptSequence: receipt.sequence, state };
    }).pipe(Effect.provide(protocol)),
  );

  // A new scope constructs a fresh socket. Read only: never resend the turn.
  const persisted = yield* Effect.scoped(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(WsRpcGroup);
      const snapshot = yield* client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId }).pipe(
        Stream.filter((item) => item.kind === "snapshot"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      return snapshot.snapshot;
    }).pipe(Effect.provide(protocol)),
  );
  const thread: OrchestrationThread = persisted.thread;
  const userMessages = thread.messages.filter((message) => message.id === messageId);
  const assistantMessages = thread.messages.filter((message) => message.role === "assistant");
  const toolActivities = thread.activities.filter((activity) => activity.kind.startsWith("tool."));
  if (
    userMessages.length !== 1 ||
    !assistantMessages.some((message) => message.text.trim() === token)
  ) {
    return yield* new MeerkatClientSmokeError({
      detail: "Reconnected history is missing or duplicates the expected messages.",
    });
  }
  if (thread.latestTurn?.state !== "completed" || toolActivities.length === 0) {
    return yield* new MeerkatClientSmokeError({
      detail: "Reconnected history has no completed turn or tool activity.",
    });
  }
  const contents = yield* Effect.tryPromise({
    try: () => NodeFSP.readFile(filePath, "utf8"),
    catch: (cause) =>
      new MeerkatClientSmokeError({ detail: `Could not read smoke file: ${String(cause)}` }),
  });
  if (contents.trim() !== token || contents.trim().split(/\r?\n/).length !== 1) {
    return yield* new MeerkatClientSmokeError({
      detail: "The real tool append was missing or happened more than once.",
    });
  }
  return {
    status: "passed",
    projectPath,
    threadId,
    model,
    ...firstConnection,
    snapshotSequence: persisted.snapshotSequence,
    assistantMessages: assistantMessages.length,
    toolActivities: toolActivities.length,
    toolExecutedOnce: true,
    clientReconnectRecoveredHistory: true,
    repeatedCommandReceiptWasDeduplicated: true,
    serverRestartTested: false,
    runtimeCrashReplayTested: false,
    events,
  };
}).pipe(Effect.timeout("5 minutes"));

const report = await Effect.runPromise(run).catch((error: unknown) => {
  // Socket errors contain request headers. Never inspect/log the error object.
  process.stderr.write(
    `Meerkat smoke failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exit(1);
});
const reportPath = process.env.MEERKAT_SMOKE_REPORT ?? NodePath.join(projectPath, "report.json");
await NodeFSP.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
await Effect.runPromise(Console.log({ ...report, reportPath, events: report.events.length }));

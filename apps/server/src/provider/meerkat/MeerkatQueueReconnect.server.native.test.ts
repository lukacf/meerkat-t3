// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - this opt-in integration owns real child processes, loopback HTTP and bounded failure deadlines.
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  CommandId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ServerSettings,
  WS_METHODS,
  WsRpcGroup,
  type MeerkatAgentActivity,
  MeerkatAgentControlReceipt,
} from "@t3tools/contracts";
import {
  assertMeerkatBundleBuild,
  validateMeerkatHealth,
  verifyMeerkatRuntime,
} from "@t3tools/shared/meerkatRuntime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as Socket from "effect/unstable/socket/Socket";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { describe, expect, it } from "@effect/vitest";

import { createMeerkatGatewayClient } from "./MeerkatGatewayClient.ts";
import {
  fixtureTimeoutMs,
  ownedServer,
  ownedServerShutdownBudget,
} from "./MeerkatWorkflow.server.native.support.ts";

const serverEntry = process.env.T3CODE_TEST_MEERKAT_SERVER_ENTRY;
const serverExecutable = process.env.T3CODE_TEST_MEERKAT_SERVER_EXECUTABLE;
const runtimeDirectory = process.env.T3CODE_TEST_MEERKAT_RUNTIME_DIR;
const model = "openai:gpt-5.4-mini";
const fixtureKey = "queue-reconnect-fixture-key";
const firstText = "FIRST_QUEUE_RECONNECT";
const secondText = "SECOND_QUEUE_RECONNECT";
const continuedText = "CONTINUE_AFTER_SERVER_RESTART";
const replies = ["FIRST_COMPLETE", "SECOND_COMPLETE"];
const continuedReply = "RESTART_CONTINUATION_COMPLETE";
type Client = RpcClient.FromGroup<typeof WsRpcGroup, RpcClientError>;

async function bounded<A>(work: Promise<A>, stage: string, timeoutMs = 30_000): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Deadline waiting for ${stage}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const decodeProviderInput = Schema.decodeUnknownSync(
  Schema.Struct({
    model: Schema.String,
    input: Schema.Array(Schema.Unknown),
  }),
);
const decodeUserInput = Schema.decodeUnknownOption(
  Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Union([
      Schema.String,
      Schema.Array(Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String })),
    ]),
  }),
);
const decodeRuntimeInfo = Schema.decodeUnknownSync(
  Schema.Struct({ host: Schema.Struct({ realmId: Schema.String }) }),
);
const decodeShutdownHealth = Schema.decodeUnknownSync(
  Schema.Struct({ shutdownHorizonMs: Schema.Number }),
);
const decodeNativeReceipt = Schema.decodeUnknownSync(
  Schema.Struct({ receipt: Schema.Struct({ interaction_id: Schema.String }) }),
);
const decodeAssistant = Schema.decodeUnknownOption(
  Schema.Struct({
    role: Schema.Literal("block_assistant"),
    assistant_message_id: Schema.String,
    blocks: Schema.Array(
      Schema.Struct({
        block_type: Schema.String,
        data: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  }),
);
const decodeSavedUser = Schema.decodeUnknownOption(
  Schema.Struct({ role: Schema.Literal("user"), content: Schema.String }),
);
const decodeCompletionPayload = Schema.decodeUnknownSync(
  Schema.Struct({ assistant_message_id: Schema.String, result: Schema.String }),
);
const decodeStoredQueueItem = Schema.decodeUnknownSync(
  Schema.Struct({
    item_id: Schema.String,
    request_id: Schema.String,
    status: Schema.Literal("completed"),
    dispatch_session_id: Schema.String,
    dispatch_agent_ref: Schema.String,
    receipt_json: Schema.String,
  }),
);
const decodeSettings = Schema.decodeSync(ServerSettings);
const encodeSettings = Schema.encodeSync(Schema.fromJsonString(ServerSettings));
const decodeStoredReceipt = Schema.decodeSync(Schema.fromJsonString(MeerkatAgentControlReceipt));
const encodeObservationDiagnostic = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function latestUserInput(input: readonly unknown[]) {
  for (const item of input.toReversed()) {
    const decoded = decodeUserInput(item);
    if (decoded._tag === "Some") {
      return typeof decoded.value.content === "string"
        ? decoded.value.content
        : decoded.value.content.map((part) => part.text).join("");
    }
  }
  throw new Error("Responses request has no user input");
}

function controlledProvider() {
  const requests: string[] = [];
  const errors: unknown[] = [];
  const entered = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
  const release = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
  const provider = NodeHttp.createServer(async (request, response) => {
    try {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/responses");
      expect(request.headers.authorization).toBe(`Bearer ${fixtureKey}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = decodeProviderInput(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      expect(payload.model).toBe("gpt-5.4-mini");
      const text = latestUserInput(payload.input);
      const index = requests.length;
      requests.push(text);
      if (index > 2) throw new Error("Duplicate work reached the model fixture");
      expect(text).toBe([firstText, secondText, continuedText][index]);
      if (index === 2) {
        const context = JSON.stringify(payload.input);
        for (const prior of [firstText, secondText, ...replies]) expect(context).toContain(prior);
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ type: "response.created", response: { id: `response_${index}` } })}\n\n`,
      );
      response.flushHeaders();
      entered[index]!.resolve();
      await release[index]!.promise;
      const item = {
        type: "message",
        id: `message_${index}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: [...replies, continuedReply][index] }],
      };
      response.end(
        [
          { type: "response.output_item.added", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: `response_${index}`,
              status: "completed",
              output: [item],
              usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
            },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
      );
    } catch (error) {
      errors.push(error);
      for (const waiting of entered) waiting.reject(error);
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Queue reconnect fixture failed" } }));
    }
  });
  // Both barriers exist before any request; failures can reject either one first.
  for (const waiting of entered) void waiting.promise.catch(() => undefined);
  return { provider, requests, errors, entered, release };
}

async function availablePort() {
  const reservation = NodeNet.createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("No reserved loopback port");
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function isolatedEnvironment(root: string, runtime: string): NodeJS.ProcessEnv {
  // Native credential discovery sees only the disposable home and explicit fake binding.
  return {
    PATH: [NodePath.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(
      NodePath.delimiter,
    ),
    HOME: NodePath.join(root, "home"),
    USERPROFILE: NodePath.join(root, "home"),
    TMPDIR: NodePath.join(root, "tmp"),
    TMP: NodePath.join(root, "tmp"),
    TEMP: NodePath.join(root, "tmp"),
    LANG: "C.UTF-8",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    MEERKAT_RUNTIME_DIR: runtime,
    MEERKAT_NODE_PATH: process.execPath,
    MEERKAT_RECONNECT_FIXTURE_KEY: fixtureKey,
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_OTEL_SDK_DISABLED: "true",
  };
}

const withClient = Effect.fnUntraced(function* <A, E>(
  origin: string,
  bearer: string,
  use: (client: Client) => Effect.Effect<A, E, Scope.Scope>,
) {
  const closed: Promise<void>[] = [];
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(origin.replace("http:", "ws:") + "/ws").pipe(
        Layer.provide(
          Layer.succeed(Socket.WebSocketConstructor, (url, protocols) => {
            const socket = new NodeSocket.NodeWS.WebSocket(
              url,
              protocols as string | string[] | undefined,
              { headers: { authorization: `Bearer ${bearer}` } },
            );
            closed.push(new Promise<void>((resolve) => socket.once("close", () => resolve())));
            return socket as unknown as globalThis.WebSocket;
          }),
        ),
      ),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(WsRpcGroup);
      return yield* use(client);
    }).pipe(Effect.provide(protocol), Effect.timeout("90 seconds")),
  ).pipe(
    Effect.ensuring(
      Effect.promise(() => bounded(Promise.all(closed), "actual client WebSocket close")),
    ),
  );
});

const watch = Effect.fnUntraced(function* <A, E>(stream: Stream.Stream<A, E>) {
  let index = 0;
  const observed: { index: number; value: A }[] = [];
  let failure: unknown;
  const listeners = new Set<() => void>();
  yield* stream.pipe(
    Stream.runForEach((value) =>
      Effect.sync(() => {
        observed.push({ index: ++index, value });
        if (observed.length > 32) observed.shift();
        for (const listener of listeners) listener();
      }),
    ),
    Effect.catch((error) =>
      Effect.sync(() => {
        failure = error;
        for (const listener of listeners) listener();
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  return {
    index: () => index,
    waitFor: (predicate: (value: A) => boolean, stage: string, afterIndex = 0) =>
      Effect.tryPromise(async () => {
        const waiting = Promise.withResolvers<A>();
        const check = () => {
          if (failure !== undefined) waiting.reject(failure);
          else {
            const match = observed.find(
              (entry) => entry.index > afterIndex && predicate(entry.value),
            );
            if (match) waiting.resolve(match.value);
          }
        };
        listeners.add(check);
        check();
        try {
          return await bounded(waiting.promise, stage);
        } catch (cause) {
          throw new Error(`${stage}: ${encodeObservationDiagnostic(observed).slice(-8_000)}`, {
            cause,
          });
        } finally {
          listeners.delete(check);
        }
      }),
  };
});

function historyEvidence(
  activity: MeerkatAgentActivity,
  sessionId: string,
  interactionIds: readonly string[],
  expectedUsers: readonly string[] = [firstText, secondText],
  expectedReplies: readonly string[] = replies,
) {
  expect(activity.agent?.record.session_id).toBe(sessionId);
  // Live activity uses canonical frames; a cold saved conversation supplies the
  // transcript envelope. Both representations carry the same native messages.
  if (activity.transcript) expect(activity.transcript.sessionId).toBe(sessionId);
  const messages =
    activity.transcript?.messages ??
    activity.timeline.frames.flatMap((frame) => {
      if (frame.source.kind !== "session_history") return [];
      expect(frame.session_id).toBe(sessionId);
      const payload = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
        frame.payload,
      );
      return Object.hasOwn(payload, "message") ? [{ message: payload.message }] : [];
    });
  const users = messages.flatMap(({ message }) => {
    const user = decodeSavedUser(message);
    return user._tag === "Some" ? [user.value.content] : [];
  });
  expect(users).toEqual(expectedUsers);
  const assistants = messages.flatMap(({ message }) => {
    const assistant = decodeAssistant(message);
    return assistant._tag === "Some" ? [assistant.value] : [];
  });
  const contents = assistants.map((assistant) =>
    assistant.blocks
      .flatMap((block) =>
        ["text", "transcript"].includes(block.block_type) && typeof block.data.text === "string"
          ? [block.data.text]
          : [],
      )
      .join(""),
  );
  expect(contents).toEqual(expectedReplies);
  const ids = assistants.map((assistant) => assistant.assistant_message_id);
  expect(new Set(ids).size).toBe(expectedReplies.length);
  for (const [index, interactionId] of interactionIds.entries()) {
    const frame = activity.timeline.frames.find(
      (candidate) =>
        candidate.kind === "interaction_complete" &&
        candidate.interaction_id === interactionId &&
        candidate.source.kind !== "session_history",
    );
    expect(frame, `Missing native completion for ${interactionId}`).toBeDefined();
    expect(frame?.session_id).toBe(sessionId);
    const payload = decodeCompletionPayload(frame?.payload);
    expect(payload.assistant_message_id).toBe(ids[index]);
    expect(payload.result).toBe(expectedReplies[index]);
  }
  return { users, ids, contents };
}

function interactionId(receipt: MeerkatAgentControlReceipt) {
  expect(receipt.status).toBe("accepted");
  return decodeNativeReceipt(receipt.receipt).receipt.interaction_id;
}

async function prepareFixture(root: string, runtime: string, providerPort: number) {
  const projectPath = NodePath.join(root, "project");
  const baseDir = NodePath.join(root, "t3-home");
  const nativeRoot = NodePath.join(root, "native");
  const env = isolatedEnvironment(root, runtime);
  for (const directory of [
    projectPath,
    NodePath.join(baseDir, "userdata"),
    NodePath.join(root, "evidence"),
    nativeRoot,
    env.HOME!,
    env.TMPDIR!,
  ]) {
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const manifest = await verifyMeerkatRuntime(runtime);
  const configRoot = NodePath.join(
    nativeRoot,
    "projects",
    NodeCrypto.createHash("sha256").update(projectPath).digest("hex"),
  );
  const gateway = createMeerkatGatewayClient({
    binaryPath: NodePath.join(runtime, manifest.binary),
    cwd: projectPath,
    env,
  });
  let realm: string;
  let shutdownHorizonMs: number;
  try {
    const health = await gateway.request("system.v1.health");
    const actual = validateMeerkatHealth(health, await gateway.request("system.v1.capabilities"));
    assertMeerkatBundleBuild(actual, manifest);
    shutdownHorizonMs = decodeShutdownHealth(health).shutdownHorizonMs;
    ownedServerShutdownBudget(shutdownHorizonMs);
    realm = decodeRuntimeInfo(
      await gateway.request("system.v1.projectRuntimeInfo", { projectPath, stateRoot: configRoot }),
    ).host.realmId;
  } finally {
    await gateway.close();
  }
  if (!/^[a-z0-9-]+$/.test(realm))
    throw new Error("Unsupported realm path returned by native gateway");
  const configDirectory = NodePath.join(configRoot, realm);
  await NodeFSP.mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await NodeFSP.writeFile(
    NodePath.join(configDirectory, "config.toml"),
    `[realm.${realm}]
default_binding = "fixture"
[realm.${realm}.backend.fixture]
provider = "openai"
backend_kind = "openai_api"
base_url = "http://127.0.0.1:${providerPort}"
[realm.${realm}.auth.fixture]
provider = "openai"
auth_method = "api_key"
source = { kind = "env", env = "MEERKAT_RECONNECT_FIXTURE_KEY" }
[realm.${realm}.binding.fixture]
backend_profile = "fixture"
auth_profile = "fixture"
provider_default = true
[model_fallback]
enabled = false
`,
    { mode: 0o600 },
  );
  const donors = ["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"];
  const selection = { instanceId: "meerkat", model };
  const settings = decodeSettings({
    providers: Object.fromEntries(donors.map((driver) => [driver, { enabled: false }])),
    providerInstances: {
      ...Object.fromEntries(donors.map((driver) => [driver, { driver, enabled: false }])),
      meerkat: {
        driver: "meerkat",
        enabled: true,
        config: {
          gatewayBinaryPath: "meerkat-desktop-stdio",
          stateRoot: nativeRoot,
          projectPath,
          workspacePolicy: "selected-model-only",
        },
      },
    },
    enableProviderUpdateChecks: false,
    enableAgentBrowserAccess: false,
    enableAgentDeviceAccess: false,
    textGenerationModelSelection: selection,
    sourceControlWriterModelSelection: selection,
  });
  await NodeFSP.writeFile(
    NodePath.join(baseDir, "userdata", "settings.json"),
    encodeSettings(settings),
    { mode: 0o600 },
  );
  return { projectPath, baseDir, env, manifest, shutdownHorizonMs };
}

const exchangeToken = Effect.fnUntraced(
  function* (origin: string, credential: string) {
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(`${origin}/oauth/token`).pipe(
        HttpClientRequest.bodyUrlParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: credential,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
          scope:
            "orchestration:read orchestration:operate terminal:operate review:write relay:read access:read access:write relay:write",
          client_label: "Queue reconnect fixture",
        }),
      ),
    );
    expect(response.status).toBe(200);
    return (yield* HttpClientResponse.schemaBodyJson(AuthAccessTokenResult)(response)).access_token;
  },
  Effect.provide(NodeHttpClient.layerUndici),
  Effect.scoped,
  Effect.timeout("15 seconds"),
);

describe.skipIf(!serverEntry || !runtimeDirectory)(
  "actual T3 server queued work across client reconnects",
  () => {
    it.live(
      "finishes queued work without clients and preserves completion, dedupe and read state across server restart",
      () =>
        Effect.gen(function* () {
          if (!serverEntry || !runtimeDirectory)
            throw new Error("Supply prebuilt server and packaged native runtime paths");
          if (!NodePath.isAbsolute(serverEntry) || !NodePath.isAbsolute(runtimeDirectory))
            throw new Error("Integration artifact paths must be absolute");
          // A packaged server entry is inside app.asar and is resolved by
          // Electron's Node runtime rather than the external test process.
          if (serverExecutable) {
            if (!NodePath.isAbsolute(serverExecutable))
              throw new Error("Packaged server executable must be absolute");
            yield* Effect.promise(() => NodeFSP.access(serverExecutable));
          } else yield* Effect.promise(() => NodeFSP.access(serverEntry));
          const root = yield* Effect.promise(async () =>
            NodeFSP.realpath(
              await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-queue-reconnect-")),
            ),
          );
          yield* Effect.promise(() => NodeFSP.chmod(root, 0o700));
          const fixture = controlledProvider();
          let server: ReturnType<typeof ownedServer> | undefined;
          const servers: ReturnType<typeof ownedServer>[] = [];
          yield* Effect.addFinalizer((exit) =>
            Effect.promise(async () => {
              for (const held of fixture.release) held.resolve();
              let cleanupComplete = false;
              try {
                for (const owned of servers.toReversed()) await owned.close();
                cleanupComplete = true;
              } finally {
                if (cleanupComplete) {
                  fixture.provider.closeAllConnections();
                  if (fixture.provider.listening)
                    await new Promise<void>((resolve, reject) =>
                      fixture.provider.close((error) => (error ? reject(error) : resolve())),
                    );
                }
                const evidence = NodePath.join(root, "evidence");
                await NodeFSP.mkdir(evidence, { recursive: true, mode: 0o700 });
                await NodeFSP.writeFile(
                  NodePath.join(evidence, "queue-reconnect-acceptance.json"),
                  encodeObservationDiagnostic({
                    passed: Exit.isSuccess(exit) && cleanupComplete,
                    cleanupComplete,
                    providerErrors: fixture.errors,
                    requests: fixture.requests,
                    shutdown: servers.map((owned) => ({
                      pid: owned.child.pid,
                      code: owned.child.exitCode,
                      signal: owned.child.signalCode,
                      ...owned.shutdownObservation(),
                    })),
                  }),
                  { mode: 0o600 },
                );
              }
            }).pipe(
              Effect.ensuring(Effect.logInfo(`Queue reconnect evidence retained at ${root}`)),
              Effect.ensuring(
                Effect.suspend(() =>
                  server?.diagnostics.length
                    ? Effect.log("Background worker diagnostics", server.diagnostics)
                    : Effect.void,
                ),
              ),
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
            throw new Error("Provider fixture has no TCP address");
          const prepared = yield* Effect.promise(() =>
            prepareFixture(root, runtimeDirectory, address.port),
          ).pipe(Effect.uninterruptible);
          const port = yield* Effect.promise(availablePort);
          const origin = `http://127.0.0.1:${port}`;
          server = ownedServer(
            serverEntry,
            prepared.projectPath,
            prepared.baseDir,
            port,
            prepared.env,
            prepared.shutdownHorizonMs,
            NodePath.join(root, "evidence/server-first-diagnostics.json"),
          );
          servers.push(server);
          const ready = server.ready;
          const bearer = yield* exchangeToken(
            origin,
            yield* Effect.promise(() => bounded(ready, "owned T3 readiness", 60_000)),
          );
          const projectId = ProjectId.make("queue-reconnect-project");
          const instanceId = ProviderInstanceId.make("meerkat");

          const first = yield* withClient(origin, bearer, (client) =>
            Effect.gen(function* () {
              const config = yield* client[WS_METHODS.serverGetConfig]({});
              expect(
                config.providers
                  .filter((provider) => provider.enabled)
                  .map((provider) => provider.instanceId),
              ).toEqual([instanceId]);
              const provider = config.providers.find(
                (candidate) => candidate.instanceId === instanceId,
              );
              expect(provider?.status, provider?.message).toBe("ready");
              expect(provider?.models.some((candidate) => candidate.slug === model)).toBe(true);
              expect(provider?.version).toBe(
                `${prepared.manifest.build.meerkatVersion} / MobKit ${prepared.manifest.build.mobkitVersion}`,
              );
              yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "project.create",
                commandId: CommandId.make("queue-reconnect-create-project"),
                projectId,
                title: "Queued work reconnect",
                workspaceRoot: prepared.projectPath,
                createdAt: DateTime.formatIso(yield* DateTime.now),
              });
              const agent = yield* client[WS_METHODS.meerkatProjectAgentCreate]({
                projectId,
                instanceId,
                requestId: "queue-reconnect-create-agent",
                label: "Reconnect reviewer",
                role: "reviewer",
                instructions: "Reply to the user's message without tools or peer messages.",
                model,
              });
              expect(agent.connectionStatus, agent.error ?? undefined).toBe("connected");
              if (!agent.agentRef)
                throw new Error("Connected project agent has no native reference");
              const target = { projectId, instanceId, agentRef: agent.agentRef };
              const team = yield* client[WS_METHODS.meerkatProjectTeam]({ projectId });
              const nativeAgent = team.providers
                .flatMap((entry) => entry.agents)
                .find((entry) => entry.agentRef === target.agentRef);
              const sessionId = nativeAgent?.record.session_id;
              if (!sessionId) throw new Error("Connected project agent has no native session");
              const queue = yield* watch(client[WS_METHODS.meerkatAgentQueueSubscribe](target));
              const attention = yield* watch(
                client[WS_METHODS.meerkatAttentionSubscribe]({ projectId }),
              );
              yield* queue.waitFor(
                (event) => event.kind === "synchronized",
                "initial queue synchronization",
              );
              yield* attention.waitFor(
                (event) => event.kind === "synchronized",
                "initial attention synchronization",
              );
              yield* attention.waitFor(
                (event) => event.kind === "snapshot" && event.snapshot.observedAt !== null,
                "persisted attention baseline",
              );
              const receipt = yield* client[WS_METHODS.meerkatAgentSend]({
                ...target,
                requestId: "queue-reconnect-first",
                text: firstText,
                handlingMode: "queue",
              });
              yield* Effect.promise(() =>
                bounded(fixture.entered[0]!.promise, "held first model request"),
              );
              const enqueue = {
                ...target,
                requestId: "queue-reconnect-second",
                payload: { text: secondText },
              };
              const admitted = yield* client[WS_METHODS.meerkatAgentQueueEnqueue](enqueue);
              expect(admitted.items).toHaveLength(1);
              expect(admitted.items[0]?.status).toBe("queued");
              expect(admitted.items[0]?.requestId).toBe(enqueue.requestId);
              yield* queue.waitFor(
                (event) =>
                  event.kind === "snapshot" &&
                  event.snapshot.revision >= admitted.revision &&
                  event.snapshot.items.some((item) => item.id === admitted.items[0]!.id),
                "committed queue admission",
              );
              return {
                target,
                sessionId,
                agentId: agent.agentId,
                enqueue,
                admitted,
                firstInteractionId: interactionId(receipt),
              };
            }),
          );

          // withClient resolves only after A's actual socket close. No client exists
          // when the independent server worker admits the queued model request.
          fixture.release[0]!.resolve();
          yield* Effect.promise(() =>
            bounded(fixture.entered[1]!.promise, "server dispatch without connected clients"),
          );
          fixture.release[1]!.resolve();

          const second = yield* withClient(origin, bearer, (client) =>
            Effect.gen(function* () {
              const queue = yield* watch(
                client[WS_METHODS.meerkatAgentQueueSubscribe](first.target),
              );
              const attention = yield* watch(
                client[WS_METHODS.meerkatAttentionSubscribe]({ projectId }),
              );
              yield* queue.waitFor(
                (event) => event.kind === "synchronized",
                "reconnected queue synchronization",
              );
              yield* attention.waitFor(
                (event) => event.kind === "synchronized",
                "reconnected attention synchronization",
              );
              yield* queue.waitFor(
                (event) =>
                  event.kind === "snapshot" &&
                  event.snapshot.revision > first.admitted.revision &&
                  event.snapshot.items.length === 0,
                "committed queue completion",
              );
              const stored = yield* Effect.sync(() => {
                const database = new NodeSqlite.DatabaseSync(
                  NodePath.join(prepared.baseDir, "userdata", "state.sqlite"),
                  { readOnly: true },
                );
                try {
                  return decodeStoredQueueItem(
                    database
                      .prepare(
                        "SELECT item_id,request_id,status,dispatch_session_id,dispatch_agent_ref,receipt_json FROM meerkat_agent_queue_items WHERE item_id=?",
                      )
                      .get(first.admitted.items[0]!.id),
                  );
                } finally {
                  database.close();
                }
              });
              expect(stored.request_id).toBe(first.enqueue.requestId);
              expect(stored.dispatch_session_id).toBe(first.sessionId);
              expect(stored.dispatch_agent_ref).toBe(first.target.agentRef);
              const secondInteractionId = interactionId(decodeStoredReceipt(stored.receipt_json));
              const interactions = [first.firstInteractionId, secondInteractionId];
              expect(new Set(interactions).size).toBe(2);
              const completion = yield* attention.waitFor(
                (event) =>
                  event.kind === "snapshot" &&
                  event.snapshot.items.some(
                    (item) =>
                      item.kind === "completion" &&
                      item.agentRef === first.target.agentRef &&
                      item.sessionId === first.sessionId &&
                      item.detail === replies[1] &&
                      item.unread,
                  ),
                "persisted unread second completion",
              );
              if (completion.kind !== "snapshot") throw new Error("Expected an attention snapshot");
              const item = completion.snapshot.items.find(
                (candidate) =>
                  candidate.kind === "completion" &&
                  candidate.agentRef === first.target.agentRef &&
                  candidate.sessionId === first.sessionId &&
                  candidate.detail === replies[1],
              );
              if (!item) throw new Error("Exact completion attention item disappeared");
              expect(item.projectAgentId).toBe(first.agentId);
              expect(item.coordinator).toBe(false);
              expect(item.completionStatus).toBe("completed");
              const evidence = historyEvidence(
                yield* client[WS_METHODS.meerkatAgentActivity]({ ...first.target, limit: 100 }),
                first.sessionId,
                interactions,
              );
              expect(fixture.requests).toEqual([firstText, secondText]);
              const duplicate = yield* client[WS_METHODS.meerkatAgentQueueEnqueue](first.enqueue);
              expect(duplicate.items).toEqual([]);
              // Two subsequent drain publications put the second pass after this
              // receipt, even if the first pass was already in flight at admission.
              yield* queue.waitFor(
                (event) => event.kind === "snapshot" && event.source === "observation",
                "first post-dedupe queue drain",
                queue.index(),
              );
              yield* queue.waitFor(
                (event) => event.kind === "snapshot" && event.source === "observation",
                "subsequent post-dedupe queue drain",
                queue.index(),
              );
              expect(fixture.requests).toEqual([firstText, secondText]);
              expect(
                historyEvidence(
                  yield* client[WS_METHODS.meerkatAgentActivity]({ ...first.target, limit: 100 }),
                  first.sessionId,
                  interactions,
                ),
              ).toEqual(evidence);
              yield* client[WS_METHODS.meerkatAttentionRead]({ projectId, itemIds: [item.id] });
              return { item, evidence, interactions };
            }),
          );

          yield* withClient(origin, bearer, (client) =>
            Effect.gen(function* () {
              const attention = yield* watch(
                client[WS_METHODS.meerkatAttentionSubscribe]({
                  projectId,
                  itemId: second.item.id,
                }),
              );
              yield* attention.waitFor(
                (event) => event.kind === "synchronized",
                "third client attention synchronization",
              );
              const persisted = yield* attention.waitFor(
                (event) => event.kind === "snapshot" && event.source === "initial",
                "fresh SQL read marker snapshot",
              );
              if (persisted.kind !== "snapshot")
                throw new Error("Expected an initial attention snapshot");
              expect(persisted.snapshot.items).toHaveLength(1);
              expect(persisted.snapshot.items[0]).toMatchObject({
                id: second.item.id,
                sessionId: first.sessionId,
                agentRef: first.target.agentRef,
                unread: false,
              });
              expect(
                historyEvidence(
                  yield* client[WS_METHODS.meerkatAgentActivity]({ ...first.target, limit: 100 }),
                  first.sessionId,
                  second.interactions,
                ),
              ).toEqual(second.evidence);
              expect(fixture.requests).toEqual([firstText, secondText]);
              expect(fixture.errors).toEqual([]);
            }),
          );

          // Reopen the same private T3 database and native profile in a wholly
          // new server process. History inspection must not admit more work.
          const previousPid = server.child.pid;
          const stopped = yield* Effect.promise(() => server!.close());
          // Effect's CLI runtime reports a clean signal-only interruption as
          // 130 after scoped teardown, rather than normal-completion exit 0.
          expect(stopped).toEqual({ code: 130, signal: null });
          server = ownedServer(
            serverEntry,
            prepared.projectPath,
            prepared.baseDir,
            port,
            prepared.env,
            prepared.shutdownHorizonMs,
            NodePath.join(root, "evidence/server-restarted-diagnostics.json"),
          );
          servers.push(server);
          expect(server.child.pid).not.toBe(previousPid);
          const restartedReady = server.ready;
          const restartedBearer = yield* exchangeToken(
            origin,
            yield* Effect.promise(() => bounded(restartedReady, "restarted T3 readiness", 60_000)),
          );
          yield* withClient(origin, restartedBearer, (client) =>
            Effect.gen(function* () {
              const attention = yield* client[WS_METHODS.meerkatAttention]({
                projectId,
                itemId: second.item.id,
              });
              expect(attention.items).toHaveLength(1);
              expect(attention.items[0]).toMatchObject({
                id: second.item.id,
                sessionId: first.sessionId,
                agentRef: first.target.agentRef,
                unread: false,
              });
              const cold = yield* client[WS_METHODS.meerkatAgentActivity]({
                ...first.target,
                limit: 100,
              });
              expect(cold.transcript?.sessionId).toBe(first.sessionId);
              expect(historyEvidence(cold, first.sessionId, [])).toEqual(second.evidence);
              const duplicate = yield* client[WS_METHODS.meerkatAgentQueueEnqueue](first.enqueue);
              expect(duplicate.items).toEqual([]);
              const queue = yield* watch(
                client[WS_METHODS.meerkatAgentQueueSubscribe](first.target),
              );
              yield* queue.waitFor(
                (event) => event.kind === "snapshot" && event.source === "observation",
                "queue worker pass after server restart",
              );
              expect(fixture.requests).toEqual([firstText, secondText]);
              expect(fixture.errors).toEqual([]);
              const reconnected = yield* client[WS_METHODS.meerkatProjectAgentLifecycle]({
                projectId,
                agentId: first.agentId,
                action: "connect",
              });
              expect(reconnected.agentRef).toBe(first.target.agentRef);
              expect(reconnected.connectionStatus).toBe("connected");
              const continuation = yield* client[WS_METHODS.meerkatAgentSend]({
                ...first.target,
                requestId: "queue-reconnect-after-restart",
                text: continuedText,
                handlingMode: "queue",
              });
              expect(continuation.status).toBe("accepted");
              yield* Effect.promise(() =>
                bounded(fixture.entered[2]!.promise, "new model work after full server restart"),
              );
              fixture.release[2]!.resolve();
              const completions = yield* watch(
                client[WS_METHODS.meerkatAttentionSubscribe]({ projectId }),
              );
              yield* completions
                .waitFor(
                  (event) =>
                    event.kind === "snapshot" &&
                    event.snapshot.items.some(
                      (item) =>
                        item.kind === "completion" &&
                        item.sessionId === first.sessionId &&
                        item.detail === continuedReply &&
                        item.unread,
                    ),
                  "same-session completion after server restart",
                )
                .pipe(
                  Effect.catch((cause) =>
                    Effect.gen(function* () {
                      const team = yield* client[WS_METHODS.meerkatProjectTeam]({ projectId });
                      const activity = yield* client[WS_METHODS.meerkatAgentActivity]({
                        ...first.target,
                        limit: 100,
                      });
                      const rows = yield* Effect.sync(() => {
                        const db = new NodeSqlite.DatabaseSync(
                          NodePath.join(prepared.baseDir, "userdata", "state.sqlite"),
                          { readOnly: true },
                        );
                        try {
                          return db
                            .prepare(
                              "SELECT id,session_id,item_json,active,read_at FROM meerkat_attention",
                            )
                            .all();
                        } finally {
                          db.close();
                        }
                      });
                      const diagnostic = yield* Schema.encodeEffect(
                        Schema.fromJsonString(Schema.Unknown),
                      )({ team, activity, rows, continuation, first, second });
                      yield* Effect.promise(() =>
                        NodeFSP.writeFile(
                          NodePath.join(root, "restart-continuation-diagnostic.json"),
                          diagnostic,
                          { mode: 0o600 },
                        ),
                      );
                      return yield* cause;
                    }),
                  ),
                );
              const continued = historyEvidence(
                yield* client[WS_METHODS.meerkatAgentActivity]({ ...first.target, limit: 100 }),
                first.sessionId,
                [],
                [firstText, secondText, continuedText],
                [...replies, continuedReply],
              );
              expect(continued.ids.slice(0, 2)).toEqual(second.evidence.ids);
              expect(fixture.requests).toEqual([firstText, secondText, continuedText]);
              expect(fixture.errors).toEqual([]);
            }),
          );
        }).pipe(Effect.timeout(180_000), Effect.scoped),
      { timeout: fixtureTimeoutMs(180_000, 2) + 10_000 },
    );
  },
);

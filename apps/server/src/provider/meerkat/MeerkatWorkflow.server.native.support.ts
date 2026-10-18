// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - this opt-in integration owns real child processes, loopback HTTP and bounded failure deadlines.
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  ServerSettings,
  WsRpcGroup,
  type MeerkatTeamAgent,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import {
  assertMeerkatBundleBuild,
  MEERKAT_REQUIRED_METHODS,
  validateMeerkatHealth,
  verifyMeerkatRuntime,
} from "@t3tools/shared/meerkatRuntime";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as Socket from "effect/unstable/socket/Socket";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { expect } from "@effect/vitest";

import { createMeerkatGatewayClient } from "./MeerkatGatewayClient.ts";
import { makeMeerkatTeamReader } from "./MeerkatTeamReader.ts";

/** Deleted threads stay hidden in T3; inspect retained native history without loading a runtime. */
export const readRetainedNativeHistory = Effect.fnUntraced(
  function* (input: {
    binaryPath: string;
    projectPath: string;
    nativeRoot: string;
    stateRoot?: string;
    instanceId: ProviderInstanceId;
    env: NodeJS.ProcessEnv;
    agents: readonly MeerkatTeamAgent[];
  }) {
    const gateway = yield* Effect.acquireRelease(
      Effect.sync(() =>
        createMeerkatGatewayClient({
          binaryPath: input.binaryPath,
          cwd: input.projectPath,
          env: input.env,
        }),
      ),
      (client) => Effect.promise(() => client.close()),
    );
    // Learn this pinned binary's shutdown horizon before opening retained history.
    const health = yield* Effect.promise(() => gateway.request("system.v1.health"));
    ownedServerShutdownBudget(decodeShutdownHealth(health).shutdownHorizonMs);
    const reader = makeMeerkatTeamReader({
      client: gateway,
      path: yield* Path.Path,
      stateRoot: input.nativeRoot,
      instanceId: input.instanceId,
    });
    return yield* Effect.forEach(input.agents, (agent) =>
      reader.history!({
        projectPath: input.projectPath,
        ...(input.stateRoot ? { stateRoot: input.stateRoot } : {}),
        mobId: agent.mobId,
        identity: agent.record.identity,
        record: agent.record,
        limit: 200,
      }),
    );
  },
  Effect.scoped,
  Effect.provide(Path.layer),
);

export const workflowModel = "openai:gpt-5.6-sol";
export const workflowKey = "workflow-fixture-key";
const serverExecutable = process.env.T3CODE_TEST_MEERKAT_SERVER_EXECUTABLE;
type Client = RpcClient.FromGroup<typeof WsRpcGroup, RpcClientError>;

export async function bounded<A>(work: Promise<A>, stage: string, timeoutMs = 30_000): Promise<A> {
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

const maximumNativeShutdownHorizonMs = 360_000;
const gatewayShutdownFloorMs = 342_000;
const gatewayShutdownMarginMs = 15_000;
const serverShutdownMarginMs = 30_000;

export function ownedServerShutdownBudget(nativeShutdownHorizonMs: number): number {
  if (
    !Number.isSafeInteger(nativeShutdownHorizonMs) ||
    nativeShutdownHorizonMs < 1 ||
    nativeShutdownHorizonMs > maximumNativeShutdownHorizonMs
  )
    throw new Error("The pinned native shutdown horizon is missing or exceeds the fixture budget");
  // Match the production gateway's native horizon plus margin, then leave the
  // server time to finish its remaining finalizers. Current 0.9.2: 397 seconds.
  return (
    Math.max(gatewayShutdownFloorMs, nativeShutdownHorizonMs + gatewayShutdownMarginMs) +
    serverShutdownMarginMs
  );
}

// A preflight phase has at most three 60s requests, then the native close
// horizon, its 15s margin, and the production client's 5s escalation settlement.
const nativeProbeSettlementMs = 3 * 60_000 + maximumNativeShutdownHorizonMs + 15_000 + 5_000;

/** Reserve owned servers and one in-progress native probe before disposing its provider. */
export function fixtureTimeoutMs(
  workMs: number,
  serverCount = 1,
  includeNativeProbe = true,
): number {
  return (
    workMs +
    serverCount * ownedServerShutdownBudget(maximumNativeShutdownHorizonMs) +
    (includeNativeProbe ? nativeProbeSettlementMs : 0)
  );
}

type OwnedServerExit = { code: number | null; signal: NodeJS.Signals | null };
type OwnedServerProcess = Pick<
  NodeChildProcess.ChildProcess,
  "pid" | "exitCode" | "signalCode" | "kill"
>;

/** Expiry is a failed cleanup observation, never permission to kill native descendants. */
export async function closeOwnedServer(
  child: OwnedServerProcess,
  exited: Promise<OwnedServerExit>,
  shutdownTimeoutMs: number,
  onTerminationRequested: () => void,
): Promise<OwnedServerExit> {
  if (
    !Number.isSafeInteger(shutdownTimeoutMs) ||
    shutdownTimeoutMs < 1 ||
    shutdownTimeoutMs > 420_000
  )
    throw new Error("Owned server shutdown budget must be bounded to at most seven minutes");
  let requestedTermination = false;
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    if (child.kill("SIGTERM")) {
      requestedTermination = true;
      onTerminationRequested();
    }
    await bounded(exited, `owned T3 server shutdown (PID ${child.pid})`, shutdownTimeoutMs);
  }
  const stopped = await exited;
  // Effect runMain returns 130 for this owner's requested interruption. A signal
  // or an unrelated failure exit cannot establish an orderly fixture shutdown.
  if (
    stopped.signal !== null ||
    (stopped.code !== 0 && !(requestedTermination && stopped.code === 130))
  )
    throw new Error(
      `Owned T3 server PID ${child.pid} exited without orderly cleanup (${stopped.code ?? stopped.signal})`,
    );
  return stopped;
}

const decodeRuntimeInfo = Schema.decodeUnknownSync(
  Schema.Struct({ host: Schema.Struct({ realmId: Schema.String }) }),
);
const decodeSettings = Schema.decodeSync(ServerSettings);
const encodeSettings = Schema.encodeSync(Schema.fromJsonString(ServerSettings));
const encodeObservationDiagnostic = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export async function availablePort() {
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
    MEERKAT_WORKFLOW_FIXTURE_KEY: workflowKey,
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_OTEL_SDK_DISABLED: "true",
    T3CODE_LOG_LEVEL: "Debug",
    T3CODE_TRACE_MIN_LEVEL: "Debug",
    T3CODE_TRACE_FILE: NodePath.join(root, "evidence", "server.trace.ndjson"),
    T3CODE_TRACE_MAX_BYTES: "2097152",
    T3CODE_TRACE_MAX_FILES: "2",
    T3CODE_TRACE_BATCH_WINDOW_MS: "100",
  };
}

export function ownedServer(
  entry: string,
  projectPath: string,
  baseDir: string,
  port: number,
  env: NodeJS.ProcessEnv,
  nativeShutdownHorizonMs: number,
  diagnosticPath: string,
  executable = serverExecutable,
) {
  const shutdownTimeoutMs = ownedServerShutdownBudget(nativeShutdownHorizonMs);
  const ready = Promise.withResolvers<string>();
  const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  const child = NodeChildProcess.spawn(
    executable ?? process.execPath,
    [
      entry,
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      baseDir,
      "--no-browser",
    ],
    {
      cwd: projectPath,
      env: executable ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    },
  );
  let output = "";
  let startupCredential: string | undefined;
  let started = false;
  let stderr = "";
  let stdout = "";
  let requestedShutdownSignal: "SIGTERM" | null = null;
  let shutdownTimedOut = false;
  let closePromise: Promise<OwnedServerExit> | undefined;
  const redact = (value: string) => {
    let sanitized = value
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
      .replace(/(?:^|\n)Token:[^\r\n]*/g, "\nToken: [redacted]")
      .replace(/([?&](?:token|credential|code)=)[^\s&#"']+/gi, "$1[redacted]");
    if (startupCredential) sanitized = sanitized.replaceAll(startupCredential, "[redacted]");
    return sanitized;
  };
  const diagnostics: string[] = [];
  const collectDiagnostic = (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (/Native (attention|agent queue)/.test(line)) {
        diagnostics.push(line.replace(/Bearer\s+\S+/g, "Bearer [redacted]"));
        if (diagnostics.length > 10) diagnostics.shift();
      }
    }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    collectDiagnostic(chunk);
    if (started) {
      stdout = (stdout + chunk).slice(-131_072);
      return;
    }
    output = (output + chunk).slice(-65_536);
    const origin = /(?:^|\n)Connection string: ([^\r\n]+)/.exec(output)?.[1];
    const token = /(?:^|\n)Token: ([^\r\n]+)/.exec(output)?.[1];
    if (origin && token && output.includes("T3 Code server is ready.")) {
      if (origin !== `http://127.0.0.1:${port}`)
        ready.reject(new Error("Owned server reported an unexpected origin"));
      else {
        startupCredential = token;
        started = true;
        ready.resolve(token);
      }
      output = "";
    }
  });
  // Startup output contains one-time credentials and QR data. Never publish it.
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    collectDiagnostic(chunk);
    stderr = (stderr + chunk).slice(-131_072);
  });
  child.once("error", (error) => {
    ready.reject(error);
    exited.resolve({ code: null, signal: null });
  });
  child.once("exit", (code, signal) => {
    exited.resolve({ code, signal });
    ready.reject(new Error(`Owned T3 server exited (${code ?? signal})`));
  });
  void ready.promise.catch(() => undefined);
  return {
    child,
    diagnostics,
    ready: ready.promise,
    shutdownObservation: () => ({
      requestedSignal: requestedShutdownSignal,
      forced: false,
      timedOut: shutdownTimedOut,
      budgetMs: shutdownTimeoutMs,
    }),
    close() {
      closePromise ??= (async () => {
        output = "";
        try {
          return await closeOwnedServer(child, exited.promise, shutdownTimeoutMs, () => {
            requestedShutdownSignal = "SIGTERM";
          });
        } catch (error) {
          shutdownTimedOut = child.exitCode === null && child.signalCode === null;
          throw new Error(
            `Owned T3 server cleanup unresolved; PID ${child.pid}; diagnostics: ${diagnosticPath}`,
            { cause: error },
          );
        } finally {
          await NodeFSP.writeFile(
            diagnosticPath,
            encodeObservationDiagnostic({
              pid: child.pid,
              code: child.exitCode,
              signal: child.signalCode,
              requestedShutdownSignal,
              forcedShutdown: false,
              shutdownTimedOut,
              shutdownTimeoutMs,
              nativeShutdownHorizonMs,
              stdout: redact(stdout),
              stderr: redact(stderr),
            }),
            { mode: 0o600 },
          );
          stdout = "";
          stderr = "";
          startupCredential = undefined;
        }
      })();
      return closePromise;
    },
  };
}

export const withClient = Effect.fnUntraced(function* <A, E>(
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
    }).pipe(Effect.provide(protocol), Effect.timeout("180 seconds")),
  ).pipe(
    Effect.ensuring(
      Effect.promise(() => bounded(Promise.all(closed), "actual client WebSocket close")),
    ),
  );
});

class FixtureObservationError extends Data.TaggedError("FixtureObservationError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export const watch = Effect.fnUntraced(function* <A, E>(
  stream: Stream.Stream<A, E>,
  failureOf?: (value: A) => Error | undefined,
) {
  let index = 0;
  const observed: { index: number; value: A }[] = [];
  let failure: unknown;
  const listeners = new Set<() => void>();
  yield* stream.pipe(
    Stream.runForEach((value) =>
      Effect.sync(() => {
        observed.push({ index: ++index, value });
        if (observed.length > 32) observed.shift();
        failure ??= failureOf?.(value);
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
    waitFor: (
      predicate: (value: A) => boolean,
      stage: string,
      afterIndex = 0,
      timeoutMs = 30_000,
    ) =>
      Effect.tryPromise({
        try: async () => {
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
            return await bounded(waiting.promise, stage, timeoutMs);
          } finally {
            listeners.delete(check);
          }
        },
        catch: (cause) =>
          new FixtureObservationError({
            message: `${stage}: ${encodeObservationDiagnostic(observed).slice(-8_000)}`,
            cause,
          }),
      }),
  };
});

export type FixtureHealthContract = "current" | "pre-account-auth-0.8.51-0.8.46";

const decodeHistoricalHealth = Schema.decodeUnknownSync(
  Schema.Struct({
    ok: Schema.Literal(true),
    runtime: Schema.Literal("mobkit"),
    build: Schema.Struct({
      gatewayVersion: Schema.String,
      meerkatVersion: Schema.Literal("0.8.51"),
      mobkitVersion: Schema.Literal("0.8.46"),
      cargoLockSha256: Schema.String,
      platform: Schema.String,
      arch: Schema.String,
    }),
  }),
);
const decodeHistoricalCapabilities = Schema.decodeUnknownSync(
  Schema.Struct({
    contractVersion: Schema.Literal("pure-mobkit-runtime-v1"),
    methods: Schema.Array(Schema.String),
  }),
);
const decodeShutdownHealth = Schema.decodeUnknownSync(
  Schema.Struct({ shutdownHorizonMs: Schema.Number }),
);

/** The predecessor package is tested against its own API, never today's added account methods. */
export function validateFixtureHealth(
  health: unknown,
  capabilities: unknown,
  contract: FixtureHealthContract = "current",
) {
  if (contract === "current") return validateMeerkatHealth(health, capabilities);
  const historical = decodeHistoricalHealth(health);
  const advertised = decodeHistoricalCapabilities(capabilities);
  if (
    !/^[a-f0-9]{64}$/.test(historical.build.cargoLockSha256) ||
    !historical.build.gatewayVersion ||
    !historical.build.platform ||
    !historical.build.arch
  )
    throw new Error("The predecessor gateway has an invalid build identity");
  const laterAccountMethods = new Set<string>([
    "auth.v1.check",
    "auth.v1.configure",
    "auth.v1.deviceStart",
    "auth.v1.devicePoll",
    "auth.v1.delete",
    "auth.v1.default",
  ]);
  const missing = MEERKAT_REQUIRED_METHODS.filter(
    (method) => !laterAccountMethods.has(method) && !advertised.methods.includes(method),
  );
  if (missing.length > 0)
    throw new Error(
      `The predecessor gateway is missing required historical methods: ${missing.join(", ")}`,
    );
  return historical.build;
}

export async function prepareFixture(
  root: string,
  runtime: string,
  providerPort: number,
  environmentOverrides: NodeJS.ProcessEnv = {},
  healthContract: FixtureHealthContract = "current",
) {
  const projectPath = NodePath.join(root, "project");
  const baseDir = NodePath.join(root, "t3-home");
  const nativeRoot = NodePath.join(root, "native");
  const evidenceRoot = NodePath.join(root, "evidence");
  const env = { ...isolatedEnvironment(root, runtime), ...environmentOverrides };
  for (const directory of [
    projectPath,
    NodePath.join(baseDir, "userdata"),
    nativeRoot,
    evidenceRoot,
    env.HOME!,
    env.TMPDIR!,
  ]) {
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await NodeFSP.writeFile(env.T3CODE_TRACE_FILE!, "", { mode: 0o600 });
  const manifest = await verifyMeerkatRuntime(runtime);
  const { shutdownHorizonMs } = await configureWorkspace(
    projectPath,
    nativeRoot,
    runtime,
    providerPort,
    env,
    healthContract,
  );
  const donors = ["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"];
  const selection = { instanceId: "meerkat", model: workflowModel };
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
  return { projectPath, baseDir, nativeRoot, evidenceRoot, env, manifest, shutdownHorizonMs };
}

export const exchangeToken = Effect.fnUntraced(
  function* (
    origin: string,
    credential: string,
    scopes = "orchestration:read orchestration:operate terminal:operate review:write relay:read access:read access:write relay:write",
  ) {
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(`${origin}/oauth/token`).pipe(
        HttpClientRequest.bodyUrlParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: credential,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
          scope: scopes,
          client_label: "Native workflow fixture",
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

/** Read a package's own cleanup contract without loading or changing its retained profile. */
export async function readFixtureShutdownHorizon(
  runtime: string,
  projectPath: string,
  env: NodeJS.ProcessEnv,
) {
  const manifest = await verifyMeerkatRuntime(runtime);
  const gateway = createMeerkatGatewayClient({
    binaryPath: NodePath.join(runtime, manifest.binary),
    cwd: projectPath,
    env,
  });
  try {
    const health = await gateway.request("system.v1.health");
    assertMeerkatBundleBuild(
      validateMeerkatHealth(health, await gateway.request("system.v1.capabilities")),
      manifest,
    );
    const { shutdownHorizonMs } = decodeShutdownHealth(health);
    ownedServerShutdownBudget(shutdownHorizonMs);
    return shutdownHorizonMs;
  } finally {
    await gateway.close();
  }
}

export async function configureWorkspace(
  projectPath: string,
  nativeRoot: string,
  runtime: string,
  providerPort: number,
  env: NodeJS.ProcessEnv,
  healthContract: FixtureHealthContract = "current",
) {
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
    const actual = validateFixtureHealth(
      health,
      await gateway.request("system.v1.capabilities"),
      healthContract,
    );
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
source = { kind = "env", env = "MEERKAT_WORKFLOW_FIXTURE_KEY" }
[realm.${realm}.binding.fixture]
backend_profile = "fixture"
auth_profile = "fixture"
provider_default = true
[model_fallback]
enabled = false
`,
    { mode: 0o600 },
  );
  return { shutdownHorizonMs };
}

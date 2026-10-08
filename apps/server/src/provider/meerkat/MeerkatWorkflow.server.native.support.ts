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
  validateMeerkatHealth,
  verifyMeerkatRuntime,
} from "@t3tools/shared/meerkatRuntime";
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
          shutdownTimeoutMs: 15_000,
        }),
      ),
      (client) => Effect.promise(() => client.close()),
    );
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
  diagnosticPath: string,
  executable = serverExecutable,
) {
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
    async close() {
      output = "";
      try {
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          try {
            await bounded(exited.promise, "owned T3 server shutdown");
          } catch (error) {
            child.kill("SIGKILL");
            await bounded(exited.promise, "owned T3 server forced exit", 5_000);
            throw error;
          }
        }
        return await exited.promise;
      } finally {
        await NodeFSP.writeFile(
          diagnosticPath,
          encodeObservationDiagnostic({
            pid: child.pid,
            code: child.exitCode,
            signal: child.signalCode,
            stdout: redact(stdout),
            stderr: redact(stderr),
          }),
          { mode: 0o600 },
        );
        stdout = "";
        stderr = "";
        startupCredential = undefined;
      }
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

export async function prepareFixture(
  root: string,
  runtime: string,
  providerPort: number,
  environmentOverrides: NodeJS.ProcessEnv = {},
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
  await configureWorkspace(projectPath, nativeRoot, runtime, providerPort, env);
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
  return { projectPath, baseDir, nativeRoot, evidenceRoot, env, manifest };
}

export const exchangeToken = Effect.fnUntraced(
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

export async function configureWorkspace(
  projectPath: string,
  nativeRoot: string,
  runtime: string,
  providerPort: number,
  env: NodeJS.ProcessEnv,
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
    shutdownTimeoutMs: 15_000,
  });
  let realm: string;
  try {
    const actual = validateMeerkatHealth(
      await gateway.request("system.v1.health"),
      await gateway.request("system.v1.capabilities"),
    );
    assertMeerkatBundleBuild(actual, manifest);
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
}

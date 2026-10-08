#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - this opt-in fixture owns real desktop children, loopback fixtures and failure deadlines.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  CommandId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  ProjectId,
  ProviderInstanceId,
  ServerSettings,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import {
  assertMeerkatBundleBuild,
  validateMeerkatHealth,
  verifyMeerkatRuntime,
} from "@t3tools/shared/meerkatRuntime";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as Socket from "effect/unstable/socket/Socket";
import { createMeerkatGatewayClient } from "../src/provider/meerkat/MeerkatGatewayClient.ts";
import { PersistedServerRuntimeState } from "../src/serverRuntimeState.ts";
import { watchFile } from "./meerkat-native-fixture-watch.ts";
import {
  createOwnershipProvider,
  exercisePreviewOwnership,
} from "./meerkat-native-preview-ownership.ts";

/**
 * Root-owned, opt-in acceptance through the packaged desktop's real native
 * coordinator and built-in preview tools. Only the model and the private page
 * are fixtures. No direct preview RPC, IPC, CDP or browser client is used.
 *
 * Supply absolute T3CODE_TEST_MEERKAT_DESKTOP_EXECUTABLE,
 * T3CODE_TEST_MEERKAT_SERVER_ENTRY and T3CODE_TEST_MEERKAT_RUNTIME_DIR paths from
 * one extracted package. The process remains alive after its passed report,
 * keeping the real app, page and private profile available for inspection.
 * SIGINT/SIGTERM tears down only children captured here; state is retained.
 * T3CODE_TEST_MEERKAT_PREVIEW_HOST_REPLACEMENT=1 runs only the bounded
 * replacement follow-up after the base proof. Its evidence file gives the
 * root operator a five-minute gate to reload the real desktop through CUA.
 */
const model = "openai:gpt-5.6-sol";
const fixtureKey = "native-preview-fixture-key";
const finalText = "NATIVE_PREVIEW_ACCEPTANCE_COMPLETE";
const canvasCase = process.env.T3CODE_TEST_MEERKAT_PREVIEW_CANVAS ?? "light";
const ownershipMode = process.env.T3CODE_TEST_MEERKAT_PREVIEW_OWNERSHIP === "1";
const hostReplacementMode = process.env.T3CODE_TEST_MEERKAT_PREVIEW_HOST_REPLACEMENT === "1";
NodeAssert.ok(["light", "dark", "author"].includes(canvasCase), "Unknown preview canvas case");
const toolsRequired = [
  "preview_status",
  "preview_open",
  "preview_navigate",
  "preview_snapshot",
  "preview_type",
  "preview_click",
] as const;
type Client = RpcClient.FromGroup<typeof WsRpcGroup, RpcClientError>;

function requiredPath(name: string) {
  const value = process.env[name];
  if (!value || !NodePath.isAbsolute(value)) throw new Error(`Supply absolute ${name}`);
  return value;
}
async function bounded<A>(work: Promise<A>, stage: string, timeoutMs = 60_000): Promise<A> {
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
const record = Schema.Record(Schema.String, Schema.Unknown);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeObject = Schema.decodeUnknownOption(record);
const decodeRequest = Schema.decodeUnknownSync(
  Schema.Struct({
    model: Schema.String,
    input: Schema.Array(Schema.Unknown),
    tools: Schema.Array(
      Schema.Struct({ type: Schema.String, name: Schema.optional(Schema.String) }),
    ),
  }),
);
const part = Schema.Union([
  Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("input_image"), image_url: Schema.String }),
]);
const decodeOutput = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("function_call_output"),
    call_id: Schema.String,
    output: Schema.Union([Schema.String, Schema.Array(part)]),
  }),
);
const decodeStatus = Schema.decodeUnknownSync(PreviewAutomationStatus);
const decodeSnapshot = Schema.decodeUnknownOption(
  Schema.Struct({
    ...PreviewAutomationSnapshot.fields,
    // The MCP text budget may omit the full tree while retaining semantic locators.
    accessibilityTree: Schema.optional(Schema.Unknown),
    screenshot: Schema.Struct({
      mimeType: Schema.Literal("image/png"),
      width: Schema.Int,
      height: Schema.Int,
    }),
    screenshotPath: Schema.String,
  }),
);
const decodeRuntime = Schema.decodeUnknownSync(Schema.fromJsonString(PersistedServerRuntimeState));
const decodeRealm = Schema.decodeUnknownSync(
  Schema.Struct({
    host: Schema.Struct({ realmId: Schema.String, stateRoot: Schema.String }),
  }),
);
const decodeHostSpan = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("effect-span"),
    name: Schema.Literal("PreviewAutomationBroker.acquireConnection"),
    exit: Schema.TaggedStruct("Success", {}),
  }),
);
const decodeToolActivity = Schema.decodeUnknownSync(
  Schema.Struct({
    toolCallId: Schema.String,
    status: Schema.String,
    title: Schema.String,
  }),
);
const decodeSettings = Schema.decodeSync(ServerSettings);
const encodeSettings = Schema.encodeSync(Schema.fromJsonString(ServerSettings));

async function listen(server: NodeHttp.Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback port");
  return address.port;
}
async function availablePort() {
  const reservation = NodeNet.createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing reserved loopback port");
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
async function closeHttp(server: NodeHttp.Server | undefined) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
function pageFixture() {
  const canvasHead =
    canvasCase === "dark"
      ? '<meta name="color-scheme" content="dark">'
      : canvasCase === "author"
        ? "<style>html{background:#326478;color:white}</style>"
        : "";
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>Browser acceptance fixture</title><style>body{font:20px system-ui;padding:48px;max-width:640px;margin:auto}label,input,button{display:block;margin:18px 0}input,button{font:inherit;padding:12px}.swatches{display:flex;width:320px;height:100px}.red{background:#e22;width:50%}.blue{background:#24e;width:50%}output{font-weight:bold}</style></head><body><h1>Browser acceptance fixture</h1><p id="witness">DOM_READY_42</p><label for="name">Display name</label><input id="name" autocomplete="off"><button id="apply">Apply</button><output id="result">Waiting</output><div class="swatches" aria-label="Red left, blue right"><div class="red"></div><div class="blue"></div></div><script>document.querySelector('#apply').onclick=()=>{const value=document.querySelector('#name').value;document.querySelector('#result').textContent='Applied: '+value;console.log('FIXTURE_APPLIED',value);};</script></body></html>`;
  return NodeHttp.createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/") {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      .end(
        page
          .replace("</head>", `${canvasHead}</head>`)
          .replace(
            '<div class="swatches"',
            ownershipMode
              ? '<output id="application-count">Applied count: 0</output><div class="swatches"'
              : '<div class="swatches"',
          )
          .replace(
            "console.log('FIXTURE_APPLIED',value);",
            ownershipMode
              ? "const count=document.querySelector('#application-count');count.dataset.count=String(Number(count.dataset.count||0)+1);count.textContent='Applied count: '+count.dataset.count;console.log('FIXTURE_APPLIED',value);"
              : "console.log('FIXTURE_APPLIED',value);",
          ),
      );
  });
}

function ownedChild(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
) {
  const child = NodeChildProcess.spawn(executable, [...args], {
    env,
    cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  let output = "";
  let errorOutput = "";
  let forced = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output = (output + chunk).slice(-65_536);
  });
  // Keep bounded process output in memory. Persist only sanitized diagnostics;
  // the pairing command's raw stdout is used privately to obtain its credential.
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    errorOutput = (errorOutput + chunk).slice(-65_536);
  });
  child.once("error", exited.reject);
  child.once("exit", (code, signal) => exited.resolve({ code, signal }));
  void exited.promise.catch(() => undefined);
  return {
    child,
    exited: exited.promise,
    output: () => output,
    diagnostics: () => ({
      stdout: sanitizeDiagnosticOutput(output),
      stderr: sanitizeDiagnosticOutput(errorOutput),
      signals: diagnosticSignals(output + "\n" + errorOutput),
    }),
    termination: () => ({
      pid: child.pid,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      forced,
    }),
    discardOutput: () => {
      output = "";
    },
    async close() {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        try {
          await bounded(exited.promise, "owned child shutdown", 30_000);
        } catch (error) {
          forced = true;
          child.kill("SIGKILL");
          await bounded(exited.promise, "owned child forced shutdown", 5_000);
          throw error;
        }
      }
    },
  };
}

function sanitizeDiagnosticOutput(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => {
      // Redact whole lines with credential vocabulary, including structured
      // request headers. The fixture never retains raw pairing diagnostics.
      if (/auth|credential|bearer|token|cookie|secret|password|pairing|api[_-]?key/i.test(line)) {
        return "[redacted credential-related diagnostic line]";
      }
      return line
        .replace(/((?:https?|wss?):\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, "$1[redacted parameters]")
        .replace(/[A-Za-z0-9_+/=-]{32,}/g, "[redacted long value]")
        .slice(0, 4_096);
    })
    .join("\n");
}

function diagnosticSignals(output: string): string[] {
  // Preserve useful categories even when the diagnostic line mentions auth
  // and is therefore withheld in full from the saved text.
  const signals: readonly (readonly [string, RegExp])[] = [
    ["cors-policy", /cors policy|access-control-allow-origin/i],
    ["renderer-startup-failed", /failed to start|could not load/i],
    ["uncaught-exception", /uncaught|unhandled rejection/i],
    ["react-error", /minified react error|invalid hook|react.*error/i],
    ["missing-service", /service not found|service.*missing/i],
    ["chunk-load-failed", /dynamically imported module|loading chunk|preloaderror/i],
    ["indexeddb-error", /indexeddb.*error|indexeddb.*failed/i],
    ["connection-refused", /err_connection_refused|econnrefused/i],
  ];
  return signals.filter(([, pattern]) => pattern.test(output)).map(([name]) => name);
}

function controlledProvider(root: string, baseDir: string, pageUrl: string) {
  let requestCount = 0,
    tabId: string | undefined,
    hostConnectionId: string | undefined;
  let validationStage = "waiting for first native model request";
  let blocker: string | undefined;
  let validationFailure: { type: string; operator?: string } | undefined;
  const finished = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<never>();
  void finished.promise.catch(() => undefined);
  void failed.promise.catch(() => undefined);
  const evidence: {
    tool: string;
    callId: string;
    png?: { path: string; sourcePath: string; sha256: string; width: number; height: number };
  }[] = [];
  const ownership =
    ownershipMode || hostReplacementMode
      ? createOwnershipProvider(root, baseDir, pageUrl, () => ({ tabId, hostConnectionId }))
      : undefined;
  const sequence = [
    "preview_status",
    "preview_open",
    "preview_navigate",
    "preview_snapshot",
    "preview_type",
    "preview_click",
    "preview_snapshot",
  ] as const;
  const callId = (index: number) => `call_native_preview_${index}`;
  const fail = (message: string): never => {
    throw new Error(message);
  };
  function outputFor(input: readonly unknown[], index: number) {
    const matches = input.flatMap((value) => {
      const decoded = decodeOutput(value);
      return decoded._tag === "Some" && decoded.value.call_id === callId(index)
        ? [decoded.value]
        : [];
    });
    NodeAssert.equal(matches.length, 1, "Expected one output for the exact preceding preview call");
    const output = matches[0]!.output;
    const parts =
      typeof output === "string" ? [{ type: "input_text" as const, text: output }] : output;
    const objects = parts.flatMap((value) => {
      if (value.type !== "input_text") return [];
      try {
        const object = decodeObject(decodeJson(value.text));
        return object._tag === "Some" ? [object.value] : [];
      } catch {
        return [];
      }
    });
    if (
      objects.some(
        (value) => value.isError === true || value.is_error === true || value.error !== undefined,
      )
    )
      fail("Actual preview tool returned an error");
    return { parts, objects };
  }
  async function validateOutput(input: readonly unknown[], index: number) {
    const result = outputFor(input, index);
    const tool = sequence[index]!;
    const entry: (typeof evidence)[number] = { tool, callId: callId(index) };
    if (index <= 2) {
      const value =
        result.objects.find((object) => "available" in object) ??
        fail("Preview status metadata missing");
      const status = decodeStatus(value);
      if (index === 0) {
        if (!status.hostConnectionId)
          blocker = "The real desktop preview host has no connection witness.";
        NodeAssert.ok(status.hostConnectionId, "Actual desktop preview host unavailable");
        hostConnectionId = status.hostConnectionId;
      } else {
        NodeAssert.ok(status.available, "Actual preview tab unavailable");
        NodeAssert.ok(status.tabId, "Actual preview tab ID missing");
        if (index === 1) tabId = status.tabId;
        else {
          NodeAssert.equal(status.tabId, tabId);
          NodeAssert.equal(status.url, pageUrl);
          NodeAssert.equal(status.title, "Browser acceptance fixture");
          NodeAssert.equal(status.loading, false);
        }
      }
    } else if (tool === "preview_snapshot") {
      await NodeFSP.writeFile(
        NodePath.join(root, "evidence", `snapshot-metadata-${index}.json`),
        JSON.stringify(
          {
            objects: result.objects,
            text: result.parts.filter((value) => value.type === "input_text"),
            imageCount: result.parts.filter((value) => value.type === "input_image").length,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      const snapshots = result.objects.flatMap((value) => {
        const decoded = decodeSnapshot(value);
        return decoded._tag === "Some" ? [decoded.value] : [];
      });
      NodeAssert.equal(snapshots.length, 1, "Exactly one real snapshot metadata block required");
      const snapshot = snapshots[0]!;
      if (snapshot.accessibilityTree === undefined) {
        NodeAssert.ok(
          result.parts.some(
            (part) =>
              part.type === "input_text" && part.text.includes("Omitted: accessibilityTree"),
          ),
          "A bounded accessibility tree requires the actual MCP omission notice",
        );
      }
      NodeAssert.equal(snapshot.url, pageUrl);
      NodeAssert.equal(snapshot.title, "Browser acceptance fixture");
      NodeAssert.equal(snapshot.loading, false);
      NodeAssert.ok(snapshot.visibleText.includes("DOM_READY_42"));
      NodeAssert.ok(snapshot.interactiveElements.some((element) => element.selector === "#name"));
      NodeAssert.ok(snapshot.interactiveElements.some((element) => element.selector === "#apply"));
      if (index === 6) {
        NodeAssert.ok(snapshot.visibleText.includes("Applied: coordinator-check"));
        for (const action of ["type", "click"])
          NodeAssert.ok(
            snapshot.actionTimeline.some(
              (event) => event.action === action && event.status === "succeeded",
            ),
          );
        NodeAssert.ok(
          snapshot.consoleEntries.some(
            (event) =>
              event.text.includes("FIXTURE_APPLIED") && event.text.includes("coordinator-check"),
          ),
        );
      }
      const images = result.parts.filter((value) => value.type === "input_image");
      NodeAssert.equal(images.length, 1, "Actual snapshot PNG must reach the native model");
      const uri = images[0]!.image_url;
      NodeAssert.ok(uri.startsWith("data:image/png;base64,"));
      const bytes = Buffer.from(uri.slice("data:image/png;base64,".length), "base64");
      NodeAssert.ok(bytes.length > 24);
      NodeAssert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      NodeAssert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR");
      const width = bytes.readUInt32BE(16),
        height = bytes.readUInt32BE(20);
      NodeAssert.ok(width > 0 && height > 0);
      NodeAssert.equal(width, snapshot.screenshot.width);
      NodeAssert.equal(height, snapshot.screenshot.height);
      const artifactRoot = await NodeFSP.realpath(
        NodePath.join(baseDir, "userdata", "browser-artifacts"),
      );
      const sourcePath = await NodeFSP.realpath(snapshot.screenshotPath);
      const relative = NodePath.relative(artifactRoot, sourcePath);
      NodeAssert.ok(
        relative.length > 0 && !relative.startsWith("..") && !NodePath.isAbsolute(relative),
        "Snapshot file escaped private browser artifacts",
      );
      const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      NodeAssert.equal(
        NodeCrypto.createHash("sha256")
          .update(await NodeFSP.readFile(sourcePath))
          .digest("hex"),
        sha256,
      );
      const path = NodePath.join(root, "evidence", `model-received-${index}.png`);
      await NodeFSP.writeFile(path, bytes, { mode: 0o600 });
      entry.png = { path, sourcePath, sha256, width, height };
    } else {
      NodeAssert.equal(result.objects.length, 1, "Successful preview action metadata required");
      NodeAssert.ok(
        Object.keys(result.objects[0]!).every((key) => key === "toolIcon"),
        "Unexpected preview action result",
      );
    }
    evidence.push(entry);
  }
  const provider = NodeHttp.createServer(async (request, response) => {
    try {
      NodeAssert.equal(request.method, "POST");
      NodeAssert.equal(request.url, "/v1/responses");
      NodeAssert.equal(request.headers.authorization, `Bearer ${fixtureKey}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = decodeRequest(decodeJson(Buffer.concat(chunks).toString("utf8")));
      NodeAssert.equal(payload.model, model.slice("openai:".length));
      if (ownership && (await ownership.handle(payload, response))) return;
      for (const tool of toolsRequired) {
        if (
          !payload.tools.some(
            (candidate) => candidate.type === "function" && candidate.name === tool,
          )
        ) {
          blocker = `The native model catalog does not contain ${tool}.`;
          throw new Error(blocker);
        }
      }
      const index = requestCount++;
      validationStage =
        index > 0
          ? `result ${index}: ${sequence[index - 1] ?? "unexpected call"}`
          : "native preview tool catalog";
      NodeAssert.ok(index <= sequence.length, "Unexpected extra model request");
      if (index > 0) await validateOutput(payload.input, index - 1);
      else
        NodeAssert.equal(
          payload.input.filter((value) => decodeOutput(value)._tag === "Some").length,
          0,
        );
      const args: Readonly<Record<string, unknown>> =
        index === 0
          ? {}
          : index === 1
            ? { open: true, reuseExistingTab: true }
            : index === 2
              ? { tabId, url: pageUrl, readiness: "load", timeoutMs: 15_000 }
              : index === 3 || index === 6
                ? { tabId, includeImage: true, save: true }
                : index === 4
                  ? {
                      tabId,
                      locator: "#name",
                      text: "coordinator-check",
                      clear: true,
                      timeoutMs: 15_000,
                    }
                  : { tabId, locator: "#apply", timeoutMs: 15_000 };
      const item =
        index < sequence.length
          ? {
              type: "function_call",
              id: `fc_preview_${index}`,
              call_id: callId(index),
              name: sequence[index],
              arguments: JSON.stringify(args),
              status: "completed",
            }
          : {
              type: "message",
              id: "msg_preview_final",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: finalText }],
            };
      response.writeHead(200, { "content-type": "text/event-stream" });
      const events = [
        { type: "response.created", response: { id: `resp_preview_${index}` } },
        { type: "response.output_item.added", output_index: 0, item },
        ...(index < sequence.length
          ? [
              {
                type: "response.function_call_arguments.done",
                item_id: item.id,
                call_id: callId(index),
                name: sequence[index],
                arguments: JSON.stringify(args),
              },
            ]
          : []),
        {
          type: "response.completed",
          response: {
            id: `resp_preview_${index}`,
            status: "completed",
            output: [item],
            usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
          },
        },
      ];
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      if (index === sequence.length) {
        validationStage = "all native preview results validated";
        finished.resolve();
      }
    } catch (error) {
      validationFailure = {
        type: error instanceof Error ? error.name : "unknown",
        ...(error instanceof NodeAssert.AssertionError ? { operator: error.operator } : {}),
      };
      failed.reject(error);
      finished.reject(error);
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "Native preview fixture validation failed" } }),
      );
    }
  });
  return {
    provider,
    finished: finished.promise,
    failed: failed.promise,
    evidence,
    ownership,
    status: () => ({
      requests: requestCount,
      validatedTools: evidence.length,
      validationStage,
      validationFailure,
      blocker,
      tabId,
      hostConnectionId,
      ...(ownership ? { ownership: ownership.status() } : {}),
    }),
  };
}

function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: [NodePath.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(
      NodePath.delimiter,
    ),
    HOME: NodePath.join(root, "home"),
    USERPROFILE: NodePath.join(root, "home"),
    SHELL: "/bin/sh",
    TMPDIR: NodePath.join(root, "tmp"),
    TMP: NodePath.join(root, "tmp"),
    TEMP: NodePath.join(root, "tmp"),
    XDG_CONFIG_HOME: NodePath.join(root, "home", ".config"),
    XDG_DATA_HOME: NodePath.join(root, "home", ".local", "share"),
    LANG: "en_US.UTF-8",
    MEERKAT_PREVIEW_FIXTURE_KEY: fixtureKey,
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_OTEL_SDK_DISABLED: "true",
    T3CODE_TRACE_TIMING_ENABLED: "true",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    // Display transport is needed on Linux. No provider or shell credentials are inherited.
    ...Object.fromEntries(
      ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].flatMap(
        (key) => (process.env[key] ? [[key, process.env[key]]] : []),
      ),
    ),
  };
}
async function configurePreviewWorkspace(
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
    env: { ...env, MEERKAT_NODE_PATH: process.execPath },
    shutdownTimeoutMs: 15_000,
  });
  let realm: ReturnType<typeof decodeRealm>;
  try {
    assertMeerkatBundleBuild(
      validateMeerkatHealth(
        await gateway.request("system.v1.health"),
        await gateway.request("system.v1.capabilities"),
      ),
      manifest,
    );
    realm = decodeRealm(
      await gateway.request("system.v1.projectRuntimeInfo", {
        projectPath,
        executionPath: projectPath,
        stateRoot: configRoot,
      }),
    );
  } finally {
    await gateway.close();
  }
  NodeAssert.equal(realm.host.stateRoot, configRoot);
  NodeAssert.match(realm.host.realmId, /^[a-z0-9-]+$/);
  const configDirectory = NodePath.join(configRoot, realm.host.realmId);
  await NodeFSP.mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await NodeFSP.writeFile(
    NodePath.join(configDirectory, "config.toml"),
    `[realm.${realm.host.realmId}]
default_binding = "preview_fixture"
[realm.${realm.host.realmId}.backend.preview_fixture]
provider = "openai"
backend_kind = "openai_api"
base_url = "http://127.0.0.1:${providerPort}"
[realm.${realm.host.realmId}.auth.preview_fixture]
provider = "openai"
auth_method = "api_key"
source = { kind = "env", env = "MEERKAT_PREVIEW_FIXTURE_KEY" }
[realm.${realm.host.realmId}.binding.preview_fixture]
backend_profile = "preview_fixture"
auth_profile = "preview_fixture"
provider_default = true
[model_fallback]
enabled = false
`,
    { mode: 0o600 },
  );
  return manifest;
}
async function prepare(root: string, runtime: string, providerPort: number) {
  const projectPath = NodePath.join(root, "project"),
    baseDir = NodePath.join(root, "t3-home"),
    nativeRoot = NodePath.join(root, "native");
  const env = isolatedEnvironment(root);
  for (const directory of [
    projectPath,
    nativeRoot,
    NodePath.join(baseDir, "userdata", "logs"),
    NodePath.join(root, "desktop"),
    NodePath.join(root, "evidence"),
    env.HOME!,
    env.TMPDIR!,
  ])
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  if (ownershipMode) {
    // A real linked worktree is needed for the negative sharing assertion.
    for (const args of [
      ["init", "--initial-branch=main"],
      ["config", "user.name", "Preview fixture"],
      ["config", "user.email", "preview@example.invalid"],
      ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Preview fixture"],
    ]) {
      const git = ownedChild(
        "/usr/bin/git",
        args,
        {
          ...env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: NodePath.join(root, "absent-gitconfig"),
          GIT_TERMINAL_PROMPT: "0",
        },
        projectPath,
      );
      try {
        NodeAssert.equal((await bounded(git.exited, "isolated Git fixture setup")).code, 0);
      } finally {
        await git.close();
      }
    }
  }
  const manifest = await configurePreviewWorkspace(
    projectPath,
    nativeRoot,
    runtime,
    providerPort,
    env,
  );
  const donors = ["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"];
  const selection = { instanceId: "meerkat", model };
  await NodeFSP.writeFile(
    NodePath.join(baseDir, "userdata", "settings.json"),
    encodeSettings(
      decodeSettings({
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
        enableAgentBrowserAccess: true,
        enableAgentDeviceAccess: false,
        textGenerationModelSelection: selection,
        sourceControlWriterModelSelection: selection,
      }),
    ),
    { mode: 0o600 },
  );
  return {
    projectPath,
    baseDir,
    env,
    manifest,
    configureWorkspace: async (workspacePath: string) => {
      await configurePreviewWorkspace(workspacePath, nativeRoot, runtime, providerPort, env);
    },
  };
}

const withClient = Effect.fnUntraced(function* <A, E>(
  origin: string,
  bearer: string,
  use: (client: Client) => Effect.Effect<A, E, Scope.Scope>,
  timeoutMs = 180_000,
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
            closed.push(new Promise<void>((resolve) => socket.once("close", resolve)));
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
    }).pipe(Effect.provide(protocol), Effect.timeout(timeoutMs)),
  ).pipe(
    Effect.ensuring(Effect.promise(() => bounded(Promise.all(closed), "actual WebSocket close"))),
  );
});
const exchangeToken = Effect.fnUntraced(
  function* (origin: string, credential: string) {
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(`${origin}/oauth/token`).pipe(
        HttpClientRequest.bodyUrlParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: credential,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
          client_label: "Native preview acceptance",
          client_device_type: "bot",
        }),
      ),
    );
    NodeAssert.equal(response.status, 200);
    return (yield* HttpClientResponse.schemaBodyJson(AuthAccessTokenResult)(response)).access_token;
  },
  Effect.provide(NodeHttpClient.layerUndici),
  Effect.scoped,
  Effect.timeout("15 seconds"),
);

const exercise = Effect.fnUntraced(function* (
  origin: string,
  bearer: string,
  projectPath: string,
  pageUrl: string,
  provider: ReturnType<typeof controlledProvider>,
  configureWorkspace: (workspacePath: string) => Promise<void>,
  root: string,
) {
  const suffix = NodeCrypto.randomUUID();
  const projectId = ProjectId.make(`preview-project-${suffix}`),
    threadId = ThreadId.make(`preview-thread-${suffix}`),
    messageId = MessageId.make(`preview-message-${suffix}`);
  const instanceId = ProviderInstanceId.make("meerkat"),
    modelSelection = { instanceId, model };
  const initial = yield* withClient(origin, bearer, (client) =>
    Effect.gen(function* () {
      const config = yield* client[WS_METHODS.serverGetConfig]({});
      NodeAssert.equal(config.providers.filter((provider) => provider.enabled).length, 1);
      const meerkat = config.providers.find((provider) => provider.instanceId === instanceId);
      NodeAssert.equal(meerkat?.status, "ready");
      NodeAssert.ok(meerkat?.models.some((candidate) => candidate.slug === model));
      const createdAt = DateTime.formatIso(DateTime.nowUnsafe());
      yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
        type: "project.create",
        commandId: CommandId.make(`project-${suffix}`),
        projectId,
        title: "Native preview acceptance",
        workspaceRoot: projectPath,
        createdAt,
      });
      yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
        type: "thread.create",
        commandId: CommandId.make(`thread-${suffix}`),
        threadId,
        projectId,
        title: "Native preview fixture",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      const synchronized = yield* Deferred.make<void>();
      const terminal = yield* Deferred.make<string>();
      yield* client[ORCHESTRATION_WS_METHODS.subscribeShell]({
        requestCompletionMarker: true,
      }).pipe(
        Stream.runForEach((item) => {
          if (item.kind === "synchronized") return Deferred.succeed(synchronized, undefined);
          if (item.kind !== "thread-upserted" || item.thread.id !== threadId) return Effect.void;
          if (item.thread.latestTurn !== null && item.thread.latestTurn.state !== "running")
            return Deferred.succeed(terminal, item.thread.latestTurn.state);
          if (item.thread.session?.status === "error") return Deferred.succeed(terminal, "error");
          return Effect.void;
        }),
        Effect.forkScoped({ startImmediately: true }),
      );
      const subscribed = yield* Deferred.make<void>();
      yield* client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId }).pipe(
        Stream.runForEach((item) =>
          item.kind === "snapshot" ? Deferred.succeed(subscribed, undefined) : Effect.void,
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Deferred.await(synchronized);
      yield* Deferred.await(subscribed);
      const receipt = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
        type: "thread.turn.start",
        commandId: CommandId.make(`turn-${suffix}`),
        threadId,
        message: {
          messageId,
          role: "user",
          attachments: [],
          text: `NATIVE_PREVIEW_ACCEPTANCE. Use only the built-in preview tools on ${pageUrl}. Inspect, type coordinator-check into Display name, apply it, inspect the result, and finish. Do not call shell, file, network or other tools.`,
        },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
      });
      const state = yield* Deferred.await(terminal);
      NodeAssert.equal(state, "completed");
      yield* Effect.promise(() => bounded(provider.finished, "all real preview tool results"));
      const grant = yield* client[WS_METHODS.meerkatBrowserStatus]({
        projectId,
        instanceId,
        threadId,
      });
      NodeAssert.equal(grant.enabled, true);
      NodeAssert.ok(grant.sessionId && grant.hostSessionId);
      NodeAssert.equal(grant.hostThreadId, threadId);
      for (const tool of toolsRequired) NodeAssert.ok(grant.tools?.includes(tool));
      return { receiptSequence: receipt.sequence, grant };
    }),
  );
  const persisted = yield* withClient(origin, bearer, (client) =>
    Effect.gen(function* () {
      const snapshot = yield* client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId }).pipe(
        Stream.filter((item) => item.kind === "snapshot"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      const grant = yield* client[WS_METHODS.meerkatBrowserStatus]({
        projectId,
        instanceId,
        threadId,
      });
      NodeAssert.deepEqual(grant, initial.grant);
      return snapshot.snapshot;
    }),
  );
  const thread = persisted.thread;
  NodeAssert.equal(thread.latestTurn?.state, "completed");
  NodeAssert.equal(thread.messages.filter((message) => message.id === messageId).length, 1);
  NodeAssert.deepEqual(
    thread.messages
      .filter((message) => message.role === "assistant")
      .map((message) => ({
        text: message.text,
        turnId: message.turnId,
        streaming: message.streaming,
      })),
    [{ text: finalText, turnId: thread.latestTurn?.turnId, streaming: false }],
  );
  const completed = thread.activities
    .filter((activity) => activity.kind === "tool.completed")
    .map((activity) => ({ ...decodeToolActivity(activity.payload), turnId: activity.turnId }));
  NodeAssert.equal(completed.length, provider.evidence.length);
  for (const step of provider.evidence) {
    const matching = completed.filter((activity) =>
      activity.toolCallId.endsWith(`:tool:${step.callId}`),
    );
    NodeAssert.equal(matching.length, 1, `Missing exact committed ${step.tool} activity`);
    NodeAssert.equal(matching[0]!.status, "completed");
    NodeAssert.equal(matching[0]!.title, step.tool);
    NodeAssert.equal(matching[0]!.turnId, thread.latestTurn?.turnId);
  }
  NodeAssert.equal(provider.status().requests, 8);
  const ownership = provider.ownership
    ? yield* withClient(
        origin,
        bearer,
        (client) =>
          exercisePreviewOwnership(client, {
            projectId,
            threadId,
            projectPath,
            model,
            provider: provider.ownership!,
            coordinatorGrant: initial.grant,
            configureWorkspace,
            ...(hostReplacementMode
              ? {
                  hostReplacement: async (identity) => {
                    const gatePath = NodePath.join(root, "evidence", "host-replacement-gate.json");
                    const resumePath = NodePath.join(
                      root,
                      "evidence",
                      "host-replacement-resume.json",
                    );
                    const nonce = NodeCrypto.randomUUID();
                    const gate = watchFile(resumePath, (text) => {
                      const resumed = Schema.decodeSync(
                        Schema.fromJsonString(
                          Schema.Struct({
                            nonce: Schema.Literal(nonce),
                            action: Schema.Literal("desktop-renderer-reloaded"),
                          }),
                        ),
                      )(text);
                      return resumed;
                    });
                    const checkpoint = {
                      status: "awaiting-root-cua-reload",
                      ...identity,
                      nonce,
                      resumePath,
                      timeoutMs: 300_000,
                      instruction:
                        "Use CUA to reload the owned packaged desktop renderer. After it reconnects, atomically write the resume object to resumePath. Do not revoke, reshare, restart the native runtime, or register a fake preview host.",
                      resume: { nonce, action: "desktop-renderer-reloaded" },
                    };
                    try {
                      await NodeFSP.writeFile(
                        gatePath,
                        JSON.stringify(checkpoint, null, 2) + "\n",
                        { mode: 0o600 },
                      );
                      process.stdout.write(JSON.stringify({ ...checkpoint, gatePath }) + "\n");
                      await bounded(gate.promise, "root CUA desktop renderer reload", 300_000);
                      await NodeFSP.writeFile(
                        gatePath,
                        JSON.stringify(
                          { ...checkpoint, status: "resumed-awaiting-native-proof" },
                          null,
                          2,
                        ) + "\n",
                        { mode: 0o600 },
                      );
                    } finally {
                      gate.close();
                    }
                    return { gatePath, resumePath };
                  },
                }
              : {}),
          }),
        hostReplacementMode ? 480_000 : 180_000,
      )
    : undefined;
  return {
    projectId,
    threadId,
    snapshotSequence: persisted.snapshotSequence,
    ...initial,
    tools: provider.evidence,
    provider: provider.status(),
    shellVisualAcceptance: false,
    canvasCase,
    ...(ownership ? { ownership } : {}),
  };
});

let root: string | undefined;
let app: ReturnType<typeof ownedChild> | undefined;
let pair: ReturnType<typeof ownedChild> | undefined;
let page: NodeHttp.Server | undefined;
let provider: ReturnType<typeof controlledProvider> | undefined;
let serverPid: number | undefined;
const watchers: { close: () => void }[] = [];
const interrupted = Promise.withResolvers<void>();
const acceptanceAbort = new AbortController();
const interruptedStartup = interrupted.promise.then(() => {
  throw new Error("Owned acceptance interrupted");
});
void interruptedStartup.catch(() => undefined);
const onSignal = () => {
  interrupted.resolve();
  acceptanceAbort.abort();
};
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);
let stage = "artifact paths";
async function persistAppDiagnostics() {
  if (!root || !app) return;
  const diagnostics = app.diagnostics();
  await NodeFSP.writeFile(
    NodePath.join(root, "desktop-diagnostics.json"),
    JSON.stringify(
      {
        stage,
        fixturePid: process.pid,
        desktop: app.termination(),
        serverPid,
        descendantCleanup: "not-observed",
        ...diagnostics,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
}
try {
  const executable = await NodeFSP.realpath(requiredPath("T3CODE_TEST_MEERKAT_DESKTOP_EXECUTABLE"));
  const runtime = await NodeFSP.realpath(requiredPath("T3CODE_TEST_MEERKAT_RUNTIME_DIR"));
  const suppliedEntry = NodePath.normalize(requiredPath("T3CODE_TEST_MEERKAT_SERVER_ENTRY"));
  const resources =
    HostProcessPlatform.defaultValue() === "darwin"
      ? NodePath.resolve(executable, "..", "..", "Resources")
      : NodePath.join(NodePath.dirname(executable), "resources");
  NodeAssert.equal(runtime, await NodeFSP.realpath(NodePath.join(resources, "meerkat-runtime")));
  const archive = HostProcessPlatform.defaultValue() === "win32" ? "server.asar" : "app.asar";
  // Node cannot realpath paths inside an asar. Resolve the real archive and
  // retain the exact in-archive suffix, including macOS /tmp aliases.
  const suppliedArchive = NodePath.resolve(suppliedEntry, "..", "..", "..", "..");
  const entrySuffix = NodePath.join("apps", "server", "dist", "bin.mjs");
  NodeAssert.equal(NodePath.relative(suppliedArchive, suppliedEntry), entrySuffix);
  const packageArchive = await NodeFSP.realpath(NodePath.join(resources, archive));
  NodeAssert.equal(await NodeFSP.realpath(suppliedArchive), packageArchive);
  const entry = NodePath.join(packageArchive, entrySuffix);
  // The desktop control socket uses TMPDIR plus its own socket filename.
  // macOS's per-user /var/folders root makes that exceed sockaddr_un.sun_path.
  // Keep an owned private directory under the short system temporary root.
  const fixtureTempRoot =
    HostProcessPlatform.defaultValue() === "darwin" ? "/private/tmp" : NodeOS.tmpdir();
  root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(fixtureTempRoot, "t3-preview-")),
  );
  await NodeFSP.chmod(root, 0o700);
  page = pageFixture();
  const pageUrl = `http://127.0.0.1:${await listen(page)}/`;
  provider = controlledProvider(root, NodePath.join(root, "t3-home"), pageUrl);
  stage = "isolated native configuration";
  const prepared = await prepare(root, runtime, await listen(provider.provider));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  NodeAssert.notEqual(port, 52258);
  const descriptor = watchFile(
    NodePath.join(prepared.baseDir, "userdata", "server-runtime.json"),
    (text) => {
      const state = decodeRuntime(text);
      NodeAssert.equal(state.origin, origin);
      NodeAssert.equal(state.port, port);
      NodeAssert.equal(state.host, "127.0.0.1");
      return state;
    },
  );
  const host = watchFile(
    NodePath.join(prepared.baseDir, "userdata", "logs", "server.trace.ndjson"),
    (text) => {
      for (const line of text.split("\n").slice(0, -1)) {
        try {
          if (decodeHostSpan(decodeJson(line))._tag === "Some") return true;
        } catch {
          /* A pending append may be partial. */
        }
      }
      return undefined;
    },
  );
  watchers.push(descriptor, host);
  const env = {
    ...prepared.env,
    T3CODE_HOME: prepared.baseDir,
    T3CODE_DESKTOP_USER_DATA_DIR: NodePath.join(root, "desktop"),
    T3CODE_PORT: String(port),
  };
  if (HostProcessPlatform.defaultValue() === "darwin") {
    const socket = NodePath.join(
      prepared.env.TMPDIR!,
      `t3code-${process.getuid?.() ?? "ffffffffffff"}`,
      `${"f".repeat(24)}.sock`,
    );
    NodeAssert.ok(Buffer.byteLength(socket) < 104, "Owned macOS socket path exceeds its limit");
  }
  app = ownedChild(executable, [], { ...env, ELECTRON_ENABLE_LOGGING: "1" }, prepared.projectPath);
  process.stdout.write(
    JSON.stringify({
      status: "started",
      root,
      fixturePid: process.pid,
      desktopPid: app.child.pid,
      pageUrl,
      origin,
    }) + "\n",
  );
  const exitedEarly = app.exited.then(() => {
    throw new Error("Owned desktop exited before acceptance");
  });
  void exitedEarly.catch(() => undefined);
  stage = "packaged backend descriptor";
  const server = await bounded(
    Promise.race([descriptor.promise, exitedEarly, interruptedStartup]),
    stage,
  );
  serverPid = server.pid;
  descriptor.close();
  stage = "real desktop preview host registration";
  await bounded(Promise.race([host.promise, exitedEarly, interruptedStartup]), stage);
  host.close();
  await persistAppDiagnostics();
  stage = "public pairing";
  pair = ownedChild(
    executable,
    [entry, "pair", "--base-dir", prepared.baseDir, "--label", "Native preview acceptance"],
    { ...env, ELECTRON_RUN_AS_NODE: "1" },
    prepared.projectPath,
  );
  NodeAssert.equal((await bounded(Promise.race([pair.exited, interruptedStartup]), stage)).code, 0);
  const pairingOutput = pair.output();
  NodeAssert.ok(pairingOutput.includes(`(${origin}).`));
  const token = /(?:^|\n)Token: ([^\r\n]+)/.exec(pairingOutput)?.[1];
  NodeAssert.ok(token, "Public pair command returned no token");
  pair.discardOutput();
  const bearer = await Effect.runPromise(exchangeToken(origin, token));
  stage = "native preview tools and committed reconnect history";
  const accepted = await Promise.race([
    Effect.runPromise(
      exercise(
        origin,
        bearer,
        prepared.projectPath,
        pageUrl,
        provider,
        prepared.configureWorkspace,
        root,
      ),
      { signal: acceptanceAbort.signal },
    ),
    provider.failed,
    exitedEarly,
  ]);
  const report = {
    status: "passed",
    root,
    fixturePid: process.pid,
    desktopPid: app.child.pid,
    serverPid: server.pid,
    origin,
    pageUrl,
    model,
    manifest: prepared.manifest,
    ...accepted,
  };
  await NodeFSP.writeFile(
    NodePath.join(root, "evidence", "acceptance.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  process.stdout.write(JSON.stringify(report) + "\n");
  stage = "retained app for inspection";
  await Promise.race([interrupted.promise, app.exited, provider.failed]);
} catch (error) {
  // RPC errors can contain private request data. Only retain an owned fixture
  // deadline message; stage and assertion operator identify all other failures.
  const deadline =
    error instanceof Error
      ? /Deadline waiting for [^\r\n]{1,240}/.exec(error.message)?.[0]
      : undefined;
  const report = {
    status:
      provider?.status().blocker || stage === "real desktop preview host registration"
        ? "blocked"
        : "failed",
    stage,
    provider: provider?.status(),
    root,
    failureType: error instanceof Error ? error.name : "unknown",
    ...(deadline ? { failureMessage: sanitizeDiagnosticOutput(deadline) } : {}),
    ...(error instanceof NodeAssert.AssertionError
      ? {
          assertion: sanitizeDiagnosticOutput(error.message).slice(0, 500),
          operator: error.operator,
        }
      : {}),
    desktopPid: app?.child.pid,
    serverPid,
    fixturePid: process.pid,
  };
  if (root)
    await NodeFSP.writeFile(
      NodePath.join(root, "failure.json"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
  process.stderr.write(JSON.stringify(report) + "\n");
  process.exitCode = 1;
} finally {
  acceptanceAbort.abort();
  for (const watcher of watchers) watcher.close();
  const cleanup = await Promise.allSettled([
    pair?.close(),
    app?.close(),
    closeHttp(provider?.provider),
    closeHttp(page),
  ]);
  await persistAppDiagnostics();
  if (cleanup.some((result) => result.status === "rejected")) {
    process.stderr.write(
      JSON.stringify({
        status: "cleanup-failed",
        root,
        desktopPid: app?.child.pid,
        serverPid,
        fixturePid: process.pid,
        desktop: app?.termination(),
        descendantCleanup: "not-observed",
      }) + "\n",
    );
    process.exitCode = 1;
  }
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
}

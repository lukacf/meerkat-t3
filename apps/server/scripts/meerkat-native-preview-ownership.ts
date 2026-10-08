// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - opt-in fixture assertions and bounded model-response gates only.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import type * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import {
  CommandId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type MeerkatBrowserGrant,
  type MeerkatMediaTarget,
  type ProjectId,
  type WsRpcGroup,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { RpcClient } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

type Client = RpcClient.FromGroup<typeof WsRpcGroup, RpcClientError>;
class PreviewOwnershipError extends Schema.TaggedError<PreviewOwnershipError>()(
  "PreviewOwnershipError",
  {
    phase: Schema.String,
    reason: Schema.Literals([
      "deadline",
      "native-session-error",
      "subscription-failed",
      "subscription-ended",
    ]),
    message: Schema.String,
  },
) {}
type Request = {
  input: readonly unknown[];
  tools: readonly { type: string; name?: string | undefined }[];
};
const instanceId = ProviderInstanceId.make("meerkat");
const workerMobId = "preview-ownership-workers";
const workerMemberId = "preview-ownership-worker";
const decodeUser = Schema.decodeUnknownOption(
  Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Union([
      Schema.String,
      Schema.Array(Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String })),
    ]),
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
const decodeObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeIdentityTuple = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeStatus = Schema.decodeUnknownSync(PreviewAutomationStatus);
const decodeSnapshot = Schema.decodeUnknownOption(
  Schema.Struct({
    ...PreviewAutomationSnapshot.fields,
    accessibilityTree: Schema.optional(Schema.Unknown),
    screenshot: Schema.Struct({
      mimeType: Schema.Literal("image/png"),
      width: Schema.Int,
      height: Schema.Int,
    }),
    screenshotPath: Schema.String,
  }),
);
async function bounded<A>(promise: Promise<A>, label: string, timeoutMs = 45_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Deadline waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
type ScenarioKind = "interact" | "inspect" | "observe" | "replacement" | "deny" | "spawn" | "ready";
type Step = { tool: string; args: Readonly<Record<string, unknown>> };

/** The only controlled boundary is the model. All returned tools run natively. */
export function createOwnershipProvider(
  root: string,
  baseDir: string,
  pageUrl: string,
  host: () => { tabId: string | undefined; hostConnectionId: string | undefined },
) {
  const scenarios = new Map<
    string,
    {
      kind: ScenarioKind;
      marker: string;
      final: string;
      text: string;
      step: number;
      holdTimeoutMs: number;
      held: ReturnType<typeof Promise.withResolvers<void>>;
      release: ReturnType<typeof Promise.withResolvers<void>>;
    }
  >();
  const evidence: {
    scenario: string;
    tool: string;
    callId: string;
    denied?: boolean;
    hostConnectionId?: string;
    png?: { path: string; sourcePath: string; sha256: string; width: number; height: number };
  }[] = [];
  let requests = 0;
  let stage = "ownership not started";
  let phase = "ownership not started";
  const startedAtMs = DateTime.toEpochMillis(DateTime.nowUnsafe());
  const phases: { phase: string; at: string; elapsedMs: number }[] = [];
  let missingToolCatalog: { expected: string; functionNames: string[] } | undefined;
  const checkpoint = async (nextPhase: string) => {
    const now = DateTime.nowUnsafe();
    if (nextPhase !== phase || phases.length === 0) {
      phases.push({
        phase: nextPhase,
        at: DateTime.formatIso(now),
        elapsedMs: DateTime.toEpochMillis(now) - startedAtMs,
      });
      if (phases.length > 128) phases.shift();
    }
    phase = nextPhase;
    await NodeFSP.writeFile(
      NodePath.join(root, "evidence", "ownership-progress.json"),
      JSON.stringify(
        { phase, stage, requests, phases, tools: evidence, missingToolCatalog },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  };
  const arm = (key: string, kind: ScenarioKind, text = "", holdTimeoutMs = 45_000) => {
    NodeAssert.ok(!scenarios.has(key), "Ownership scenario must have a fresh identity");
    const scenario = {
      kind,
      marker: `__PREVIEW_OWNERSHIP_${key}__`,
      final: `PREVIEW_OWNERSHIP_${key}_COMPLETE`,
      text,
      step: 0,
      holdTimeoutMs,
      held: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    scenarios.set(key, scenario);
    return scenario;
  };
  const steps = (scenario: ReturnType<typeof arm>): readonly Step[] => {
    const { tabId } = host();
    if (scenario.kind === "ready") return [];
    if (scenario.kind === "spawn")
      return [
        {
          tool: "mob_create",
          args: {
            definition: {
              id: workerMobId,
              profiles: {
                worker: {
                  model: "gpt-5.6-sol",
                  provider: "openai",
                  runtime_mode: "autonomous_host",
                  tools: { builtins: true, shell: false, comms: true },
                },
              },
            },
          },
        },
        {
          tool: "mob_spawn_member",
          args: {
            mob_id: workerMobId,
            member_id: workerMemberId,
            profile: "worker",
            initial_message: scenarios.get("worker_ready")!.marker,
            runtime_mode: "autonomous_host",
            auto_wire_parent: false,
          },
        },
      ];
    NodeAssert.ok(tabId, "Base proof must establish an actual preview tab first");
    if (scenario.kind === "deny")
      return [{ tool: "preview_click", args: { tabId, locator: "#apply", timeoutMs: 15_000 } }];
    return [
      { tool: "preview_status", args: { tabId } },
      { tool: "preview_snapshot", args: { tabId, includeImage: true, save: true } },
      ...(scenario.kind === "interact"
        ? [
            {
              tool: "preview_type",
              args: {
                tabId,
                locator: "#name",
                text: scenario.text,
                clear: true,
                timeoutMs: 15_000,
              },
            },
            { tool: "preview_click", args: { tabId, locator: "#apply", timeoutMs: 15_000 } },
            { tool: "preview_snapshot", args: { tabId, includeImage: true, save: true } },
          ]
        : []),
    ];
  };
  const callId = (key: string, step: number) => `call_preview_ownership_${key}_${step}`;
  async function validate(key: string, input: readonly unknown[], index: number) {
    const scenario = scenarios.get(key)!;
    const step = steps(scenario)[index]!;
    const outputs = input.flatMap((value) => {
      const result = decodeOutput(value);
      return Option.isSome(result) && result.value.call_id === callId(key, index)
        ? [result.value.output]
        : [];
    });
    NodeAssert.equal(outputs.length, 1, "Expected the exact native tool's one returned output");
    const output = outputs[0]!;
    const parts =
      typeof output === "string" ? [{ type: "input_text" as const, text: output }] : output;
    const text = parts
      .flatMap((value) => (value.type === "input_text" ? [value.text] : []))
      .join("\n");
    const objects = parts.flatMap((value) => {
      if (value.type !== "input_text") return [];
      try {
        const object = decodeObject(decodeJson(value.text));
        return Option.isSome(object) ? [object.value] : [];
      } catch {
        return [];
      }
    });
    const entry: (typeof evidence)[number] = {
      scenario: key,
      tool: step.tool,
      callId: callId(key, index),
    };
    if (scenario.kind === "deny") {
      NodeAssert.match(
        text,
        /Browser access is not granted to this native session|[Tt]ool.*(?:not found|not present in the catalog|unavailable|not available|not permitted|denied by execution policy)|[Uu]nknown tool/,
      );
      NodeAssert.ok(!objects.some((object) => "available" in object || "visibleText" in object));
      entry.denied = true;
    } else {
      NodeAssert.ok(
        !objects.some(
          (object) =>
            object.error !== undefined || object.isError === true || object.is_error === true,
        ),
        "Native tool returned an error",
      );
      if (step.tool === "preview_status") {
        const status = decodeStatus(objects.find((object) => "available" in object));
        NodeAssert.equal(status.available, true);
        NodeAssert.equal(status.tabId, host().tabId);
        NodeAssert.ok(status.hostConnectionId, "The actual desktop must return its broker witness");
        if (scenario.kind === "replacement")
          NodeAssert.notEqual(
            status.hostConnectionId,
            host().hostConnectionId,
            "A renderer reload must establish a different actual desktop host connection",
          );
        else NodeAssert.equal(status.hostConnectionId, host().hostConnectionId);
        entry.hostConnectionId = status.hostConnectionId;
        NodeAssert.equal(status.url, pageUrl);
      } else if (step.tool === "preview_snapshot") {
        const snapshots = objects.flatMap((object) => {
          const decoded = decodeSnapshot(object);
          return Option.isSome(decoded) ? [decoded.value] : [];
        });
        NodeAssert.equal(snapshots.length, 1);
        const snapshot = snapshots[0]!;
        NodeAssert.equal(snapshot.url, pageUrl);
        NodeAssert.equal(snapshot.title, "Browser acceptance fixture");
        NodeAssert.equal(snapshot.loading, false);
        NodeAssert.ok(snapshot.visibleText.includes("DOM_READY_42"));
        NodeAssert.ok(snapshot.interactiveElements.some((element) => element.selector === "#name"));
        NodeAssert.ok(
          snapshot.interactiveElements.some((element) => element.selector === "#apply"),
        );
        if (snapshot.accessibilityTree === undefined)
          NodeAssert.ok(text.includes("Omitted: accessibilityTree"));
        if (scenario.kind === "inspect" || index === 4)
          NodeAssert.ok(snapshot.visibleText.includes(`Applied: ${scenario.text}`));
        if (scenario.kind === "inspect")
          NodeAssert.ok(
            snapshot.visibleText.includes("Applied count: 3"),
            "Denied clicks must not mutate the real page",
          );
        if (index === 4)
          NodeAssert.ok(
            snapshot.consoleEntries.some(
              (event) =>
                event.text.includes("FIXTURE_APPLIED") && event.text.includes(scenario.text),
            ),
          );
        const images = parts.filter((value) => value.type === "input_image");
        NodeAssert.equal(images.length, 1, "Actual preview image must reach this native session");
        const uri = images[0]!.image_url;
        NodeAssert.ok(uri.startsWith("data:image/png;base64,"));
        const bytes = Buffer.from(uri.slice("data:image/png;base64,".length), "base64");
        NodeAssert.ok(bytes.length > 24);
        NodeAssert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        NodeAssert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR");
        const width = bytes.readUInt32BE(16),
          height = bytes.readUInt32BE(20);
        NodeAssert.equal(width, snapshot.screenshot.width);
        NodeAssert.equal(height, snapshot.screenshot.height);
        NodeAssert.ok(width > 0 && height > 0);
        const artifactRoot = await NodeFSP.realpath(
          NodePath.join(baseDir, "userdata", "browser-artifacts"),
        );
        const sourcePath = await NodeFSP.realpath(snapshot.screenshotPath);
        const relative = NodePath.relative(artifactRoot, sourcePath);
        NodeAssert.ok(
          relative.length > 0 && !relative.startsWith("..") && !NodePath.isAbsolute(relative),
        );
        const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
        NodeAssert.equal(
          NodeCrypto.createHash("sha256")
            .update(await NodeFSP.readFile(sourcePath))
            .digest("hex"),
          sha256,
        );
        const path = NodePath.join(root, "evidence", `ownership-${key}-${index}.png`);
        await NodeFSP.writeFile(path, bytes, { mode: 0o600 });
        await NodeFSP.writeFile(
          NodePath.join(root, "evidence", `ownership-${key}-${index}.json`),
          JSON.stringify(snapshot, null, 2) + "\n",
          { mode: 0o600 },
        );
        entry.png = { path, sourcePath, sha256, width, height };
      } else if (step.tool === "mob_create") {
        NodeAssert.ok(objects.some((object) => object.mob_id === workerMobId));
      } else if (step.tool.startsWith("preview_")) {
        NodeAssert.equal(objects.length, 1);
        NodeAssert.ok(Object.keys(objects[0]!).every((key) => key === "toolIcon"));
      }
    }
    evidence.push(entry);
    await checkpoint(phase);
  }
  async function handle(payload: Request, response: NodeHttp.ServerResponse) {
    const users = payload.input.flatMap((value) => {
      const decoded = decodeUser(value);
      return Option.isSome(decoded)
        ? [
            typeof decoded.value.content === "string"
              ? decoded.value.content
              : decoded.value.content.map((part) => part.text).join(""),
          ]
        : [];
    });
    const marker = users
      .toReversed()
      .map((text) => /__PREVIEW_OWNERSHIP_([a-z_]+)__/.exec(text)?.[1])
      .find((key) => key !== undefined);
    if (!marker) return false;
    const scenario = scenarios.get(marker);
    NodeAssert.ok(scenario, "Model request references an unarmed ownership scenario");
    const sequence = steps(scenario);
    const index = scenario.step++;
    requests++;
    stage = `${marker}:${index}`;
    NodeAssert.ok(index <= sequence.length, "Unexpected extra ownership model request");
    if (index > 0) await validate(marker, payload.input, index - 1);
    if (index < sequence.length) {
      const step = sequence[index]!;
      if (!payload.tools.some((tool) => tool.type === "function" && tool.name === step.tool)) {
        missingToolCatalog = {
          expected: step.tool,
          functionNames: payload.tools.flatMap((tool) =>
            tool.type === "function" && tool.name ? [tool.name] : [],
          ),
        };
        await checkpoint(`${marker}: missing native tool`);
      }
      NodeAssert.ok(
        payload.tools.some((tool) => tool.type === "function" && tool.name === step.tool),
        `Native tool catalog is missing ${step.tool}`,
      );
      if (scenario.kind === "deny") {
        scenario.held.resolve();
        await bounded(
          scenario.release.promise,
          `${marker} policy mutation before tool dispatch`,
          scenario.holdTimeoutMs,
        );
      }
    }
    const id = `preview_ownership_${marker}_${index}`;
    const item =
      index < sequence.length
        ? {
            type: "function_call",
            id: `fc_${id}`,
            call_id: callId(marker, index),
            name: sequence[index]!.tool,
            arguments: JSON.stringify(sequence[index]!.args),
            status: "completed",
          }
        : {
            type: "message",
            id: `msg_${id}`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: scenario.final }],
          };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      [
        { type: "response.created", response: { id } },
        { type: "response.output_item.added", output_index: 0, item },
        ...("call_id" in item
          ? [
              {
                type: "response.function_call_arguments.done",
                item_id: item.id,
                call_id: item.call_id,
                name: item.name,
                arguments: item.arguments,
              },
            ]
          : []),
        {
          type: "response.completed",
          response: {
            id,
            status: "completed",
            output: [item],
            usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
          },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    );
    return true;
  }
  return {
    arm,
    checkpoint,
    handle,
    evidence,
    status: () => ({
      requests,
      stage,
      phase,
      elapsedMs: DateTime.toEpochMillis(DateTime.nowUnsafe()) - startedAtMs,
      validatedTools: evidence.length,
    }),
  };
}

export const exercisePreviewOwnership = Effect.fnUntraced(function* (
  client: Client,
  input: {
    projectId: ProjectId;
    threadId: ThreadId;
    projectPath: string;
    model: string;
    provider: ReturnType<typeof createOwnershipProvider>;
    coordinatorGrant: typeof MeerkatBrowserGrant.Type;
    configureWorkspace: (workspacePath: string) => Promise<void>;
    hostReplacement?: (checkpoint: {
      projectId: ProjectId;
      threadId: ThreadId;
      agentRef: string;
      sessionId: string;
      oldHostConnectionId: string;
    }) => Promise<{ gatePath: string; resumePath: string }>;
  },
) {
  const { projectId, threadId, provider } = input;
  const checkpoint = (phase: string) => Effect.promise(() => provider.checkpoint(phase));
  const boundedPhase = Effect.fnUntraced(function* <A, E, R>(
    phase: string,
    operation: Effect.Effect<A, E, R>,
  ) {
    yield* checkpoint(phase);
    const result = yield* operation.pipe(
      Effect.timeoutOrElse({
        duration: "45 seconds",
        orElse: () =>
          Effect.fail(
            new PreviewOwnershipError({
              phase,
              reason: "deadline",
              message: `Deadline waiting for ${phase}`,
            }),
          ),
      }),
    );
    yield* checkpoint(`${phase}: completed`);
    return result;
  });
  const modelSelection = { instanceId, model: input.model };
  const target = (agentRef: string): MeerkatMediaTarget => ({ projectId, instanceId, agentRef });
  const attention = new Map<string, string | null>();
  const listeners = new Set<() => void>();
  const synchronized = yield* Deferred.make<void>();
  yield* client[WS_METHODS.meerkatAttentionSubscribe]({ projectId }).pipe(
    Stream.runForEach((item) => {
      if (item.kind === "synchronized") return Deferred.succeed(synchronized, undefined);
      return Effect.sync(() => {
        for (const entry of item.snapshot.items)
          if (entry.kind === "completion" && entry.agentRef)
            attention.set(`${entry.agentRef}:${entry.detail}`, entry.completionStatus);
        for (const listener of listeners) listener();
      });
    }),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* boundedPhase("attention: initial subscription", Deferred.await(synchronized));
  const waitAgent = (agentRef: string, final: string) =>
    Effect.promise(async () => {
      const waiting = Promise.withResolvers<void>();
      const check = () => {
        const status = attention.get(`${agentRef}:${final}`);
        if (status === "completed") waiting.resolve();
        else if (status === "failed") waiting.reject(new Error("Native ownership turn failed"));
      };
      listeners.add(check);
      check();
      try {
        await bounded(waiting.promise, `canonical completion ${final}`);
      } finally {
        listeners.delete(check);
      }
    });
  const sendAgent = (agentRef: string, scenario: ReturnType<typeof provider.arm>) =>
    client[WS_METHODS.meerkatAgentSend]({
      projectId,
      instanceId,
      agentRef,
      requestId: scenario.marker,
      text: scenario.marker,
      handlingMode: "queue",
    }).pipe(
      Effect.tap((receipt) => Effect.sync(() => NodeAssert.equal(receipt.status, "accepted"))),
    );
  const runAgent = Effect.fnUntraced(function* (
    agentRef: string,
    sessionId: string | undefined,
    key: string,
    kind: ScenarioKind,
    text = "",
    priorFinals: readonly string[] = [],
  ) {
    NodeAssert.ok(sessionId, "The browser grant must identify this agent's native session");
    const scenario = provider.arm(key, kind, text);
    yield* checkpoint(`${key}: sending queued native browser task`);
    yield* sendAgent(agentRef, scenario);
    yield* checkpoint(`${key}: waiting for canonical native completion`);
    yield* waitAgent(agentRef, scenario.final);
    yield* checkpoint(`${key}: verifying exact saved conversation`);
    // Live activity is a console window. Search supplies the native revision
    // for reading committed messages from this exact granted session.
    const search = yield* client[WS_METHODS.meerkatSearchConversations]({
      query: scenario.final,
    });
    NodeAssert.equal(search.unavailable, 0);
    NodeAssert.equal(search.nextCursor, undefined);
    const matches = search.matches.filter(
      (match) =>
        match.projectId === projectId &&
        match.instanceId === instanceId &&
        match.agentRef === agentRef &&
        match.message?.sessionId === sessionId,
    );
    NodeAssert.equal(matches.length, 1, "Expected one exact agent and session history match");
    const message = matches[0]!.message!;
    NodeAssert.equal(message.source, "assistant");
    NodeAssert.ok(message.snippet.includes(scenario.final));
    const history = yield* client[WS_METHODS.meerkatAgentActivity]({
      ...target(agentRef),
      agentRef,
      limit: 100,
      transcriptRevision: message.storeRevision,
    });
    NodeAssert.equal(history.transcript?.sessionId, sessionId);
    NodeAssert.equal(history.transcript?.storeRevision, message.storeRevision);
    NodeAssert.equal(history.transcript?.exhausted, true);
    NodeAssert.ok(
      history.transcript?.messages.some((message) =>
        JSON.stringify(message.message).includes(scenario.final),
      ),
      "Canonical native history must contain this exact completed turn",
    );
    for (const initialFinal of priorFinals)
      NodeAssert.ok(
        history.transcript?.messages.some((message) =>
          JSON.stringify(message.message).includes(initialFinal),
        ),
        "The same native session must retain its earlier completed turns",
      );
    return scenario;
  });
  const runThread = Effect.fnUntraced(function* (
    id: ThreadId,
    scenario: ReturnType<typeof provider.arm>,
  ) {
    const completed = yield* Deferred.make<void, PreviewOwnershipError>();
    const subscribed = yield* Deferred.make<void, PreviewOwnershipError>();
    yield* client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId: id }).pipe(
      Stream.runForEach((item) =>
        Effect.gen(function* () {
          const session =
            item.kind === "snapshot"
              ? item.snapshot.thread.session
              : item.kind === "event" && item.event.type === "thread.session-set"
                ? item.event.payload.session
                : undefined;
          if (session?.status === "error") {
            yield* checkpoint(`${scenario.marker}: native thread entered error state`);
            const error = new PreviewOwnershipError({
              phase: scenario.marker,
              reason: "native-session-error",
              message: "Native ownership thread entered error state",
            });
            yield* Deferred.fail(subscribed, error);
            yield* Deferred.fail(completed, error);
            return;
          }
          if (item.kind === "snapshot") yield* Deferred.succeed(subscribed, undefined);
          const found =
            item.kind === "snapshot"
              ? item.snapshot.thread.messages.some(
                  (message) =>
                    message.role === "assistant" &&
                    message.text === scenario.final &&
                    !message.streaming,
                )
              : item.kind === "event" &&
                item.event.type === "thread.message-sent" &&
                item.event.payload.role === "assistant" &&
                item.event.payload.text === scenario.final &&
                !item.event.payload.streaming;
          if (found) yield* Deferred.succeed(completed, undefined);
        }),
      ),
      Effect.exit,
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const error = new PreviewOwnershipError({
            phase: scenario.marker,
            reason: Exit.isFailure(exit) ? "subscription-failed" : "subscription-ended",
            message: Exit.isFailure(exit)
              ? "Native ownership thread subscription failed"
              : "Native ownership thread subscription ended before completion",
          });
          // Completed deferreds stay settled; pending waits fail without exposing RPC payloads.
          yield* Deferred.fail(subscribed, error);
          yield* Deferred.fail(completed, error);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* boundedPhase(`${scenario.marker}: initial thread snapshot`, Deferred.await(subscribed));
    yield* boundedPhase(
      `${scenario.marker}: turn start receipt`,
      client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
        type: "thread.turn.start",
        commandId: CommandId.make(scenario.marker),
        threadId: id,
        message: {
          messageId: MessageId.make(scenario.marker),
          role: "user",
          text: scenario.marker,
          attachments: [],
        },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
      }),
    );
    yield* boundedPhase(`${scenario.marker}: native thread completion`, Deferred.await(completed));
  });
  const specialist = yield* client[WS_METHODS.meerkatProjectAgentCreate]({
    accessMode: "full-access",
    projectId,
    instanceId,
    requestId: "preview-ownership-specialist",
    label: "Preview specialist",
    role: "browser-reviewer",
    instructions:
      "Use only the explicitly shared fixture browser when requested. Never call other tools or external pages.",
    model: input.model,
  });
  NodeAssert.equal(specialist.connectionStatus, "connected");
  NodeAssert.ok(specialist.agentRef);
  const specialistRef = specialist.agentRef;
  const share = (agentRef: string) =>
    client[WS_METHODS.meerkatBrowserGrant]({
      ...target(agentRef),
      hostThreadId: threadId,
      enabled: true,
    }).pipe(
      Effect.tap((grant) =>
        Effect.sync(() => {
          NodeAssert.equal(grant.enabled, true, grant.message);
          NodeAssert.ok(grant.sessionId);
          NodeAssert.equal(grant.hostThreadId, threadId);
          NodeAssert.equal(grant.hostSessionId, input.coordinatorGrant.hostSessionId);
        }),
      ),
    );
  const specialistGrant = yield* share(specialistRef);
  NodeAssert.notEqual(specialistGrant.sessionId, input.coordinatorGrant.sessionId);
  if (input.hostReplacement) {
    const sessionId = specialistGrant.sessionId;
    NodeAssert.ok(sessionId);
    const before = yield* runAgent(specialistRef, sessionId, "replacement_before", "observe");
    const oldHostConnectionId = provider.evidence.find(
      (entry) => entry.scenario === "replacement_before" && entry.tool === "preview_status",
    )?.hostConnectionId;
    NodeAssert.ok(oldHostConnectionId);
    const stale = provider.arm("replacement_stale", "deny", "", 345_000);
    yield* boundedPhase(
      "replacement: waiting for granted native tool offer",
      sendAgent(specialistRef, stale).pipe(
        Effect.andThen(Effect.promise(() => stale.held.promise)),
      ),
    );
    yield* checkpoint("replacement: awaiting root CUA renderer reload");
    const manualReload = yield* Effect.promise(() =>
      input.hostReplacement!({
        projectId,
        threadId,
        agentRef: specialistRef,
        sessionId,
        oldHostConnectionId,
      }),
    );
    const expired = yield* boundedPhase(
      "replacement: checking stale native grant before tool dispatch",
      client[WS_METHODS.meerkatBrowserStatus](target(specialistRef)),
    );
    NodeAssert.equal(expired.enabled, false, "A replaced desktop must invalidate the old grant");
    NodeAssert.equal(expired.reason, "no-host");
    NodeAssert.equal(expired.sessionId, sessionId);
    // Never release the held click until the real grant has independently expired.
    stale.release.resolve();
    yield* boundedPhase(
      "replacement: waiting for stale native tool refusal",
      waitAgent(specialistRef, stale.final),
    );
    NodeAssert.ok(
      provider.evidence.some(
        (entry) =>
          entry.scenario === "replacement_stale" && entry.tool === "preview_click" && entry.denied,
      ),
    );
    const stillExpired = yield* boundedPhase(
      "replacement: checking refusal did not restore authority",
      client[WS_METHODS.meerkatBrowserStatus](target(specialistRef)),
    );
    NodeAssert.equal(stillExpired.enabled, false);
    const reshared = yield* boundedPhase(
      "replacement: explicitly sharing again",
      share(specialistRef),
    );
    NodeAssert.equal(reshared.sessionId, sessionId);
    NodeAssert.ok(
      reshared.grantRevision !== undefined &&
        specialistGrant.grantRevision !== undefined &&
        reshared.grantRevision > specialistGrant.grantRevision,
      "Explicit reshare must issue a newer grant for the same native session",
    );
    yield* boundedPhase(
      "replacement: real snapshot after explicit reshare",
      runAgent(specialistRef, sessionId, "replacement_after", "replacement", "", [
        before.final,
        stale.final,
      ]),
    );
    const newHostConnectionId = provider.evidence.find(
      (entry) => entry.scenario === "replacement_after" && entry.tool === "preview_status",
    )?.hostConnectionId;
    NodeAssert.ok(newHostConnectionId && newHostConnectionId !== oldHostConnectionId);
    yield* checkpoint("replacement: passed");
    return {
      specialist: { agentRef: specialistRef, grant: specialistGrant },
      hostReplacement: {
        status: "passed",
        ...manualReload,
        sessionId,
        oldHostConnectionId,
        newHostConnectionId,
        staleGrant: expired,
        staleNativeClickDenied: true,
        reshared,
        sameSessionHistoryVerified: true,
        actualSnapshotVerified: true,
      },
      tools: provider.evidence,
      provider: provider.status(),
    };
  }
  yield* runAgent(
    specialistRef,
    specialistGrant.sessionId,
    "specialist",
    "interact",
    "specialist-check",
  );

  const ready = provider.arm("worker_ready", "ready");
  yield* checkpoint("worker: native creation and initialization");
  yield* runThread(threadId, provider.arm("spawn_worker", "spawn"));
  yield* checkpoint("worker: discovering exact owned native session");
  const team = yield* client[WS_METHODS.meerkatProjectTeam]({ projectId });
  const workers = team.providers
    .flatMap((entry) => entry.agents)
    .filter(
      (agent) => agent.threadId === threadId && agent.record.labels.source_mob_id === workerMobId,
    );
  NodeAssert.equal(
    workers.length,
    1,
    "Real tool-created child must be exposed under its owning thread",
  );
  const worker = workers[0]!;
  NodeAssert.equal(worker.availability, "live");
  NodeAssert.ok(worker.record.session_id);
  // The offscreen initialization is native run-start work, with no fabricated
  // console interaction. Its receipt must independently notify exactly once.
  yield* checkpoint("worker: waiting for native initialization completion attention");
  yield* waitAgent(worker.agentRef, ready.final);
  yield* checkpoint("worker: checking native initialization receipt identity");
  const initializedTeam = yield* client[WS_METHODS.meerkatProjectTeam]({ projectId });
  const initializedWorker = initializedTeam.providers
    .flatMap((entry) => entry.agents)
    .find((agent) => agent.agentRef === worker.agentRef);
  NodeAssert.equal(initializedWorker?.record.session_id, worker.record.session_id);
  const initialization = initializedWorker?.work?.latestCompletion;
  NodeAssert.ok(initialization && "kind" in initialization);
  NodeAssert.equal(initialization.kind, "runtime_input");
  NodeAssert.equal(initialization.sessionId, worker.record.session_id);
  NodeAssert.equal(initialization.status, "completed");
  NodeAssert.ok(initialization.inputId);
  NodeAssert.ok(initialization.runId);
  NodeAssert.equal("interactionId" in initialization, false);
  const initializationAttentionId = NodeCrypto.createHash("sha256")
    .update(
      encodeIdentityTuple([
        "completion",
        projectId,
        instanceId,
        worker.agentRef,
        worker.record.session_id,
        "runtime_input",
        initialization.inputId,
        initialization.runId,
      ]),
    )
    .digest("hex");
  yield* checkpoint("worker: checking exactly one unread initialization notification");
  const initialAttention = yield* client[WS_METHODS.meerkatAttention]({ projectId });
  const initializationEntries = initialAttention.items.filter(
    (entry) => entry.agentRef === worker.agentRef && entry.kind === "completion",
  );
  NodeAssert.equal(initializationEntries.length, 1);
  NodeAssert.equal(initializationEntries[0]!.id, initializationAttentionId);
  NodeAssert.equal(initializationEntries[0]!.sessionId, worker.record.session_id);
  NodeAssert.equal(initializationEntries[0]!.unread, true);
  NodeAssert.equal(initializationEntries[0]!.detail, ready.final);
  yield* checkpoint("worker: marking initialization notification read");
  yield* client[WS_METHODS.meerkatAttentionRead]({
    projectId,
    itemIds: [initializationAttentionId],
  });
  yield* checkpoint("worker: checking reopened inbox excludes read initialization");
  const reopened = yield* client[WS_METHODS.meerkatAttentionSubscribe]({ projectId }).pipe(
    Stream.filter((item) => item.kind === "snapshot"),
    Stream.runHead,
  );
  NodeAssert.ok(Option.isSome(reopened));
  NodeAssert.equal(reopened.value.kind, "snapshot");
  const reopenedEntries = reopened.value.snapshot.items.filter(
    (entry) => entry.agentRef === worker.agentRef && entry.kind === "completion",
  );
  NodeAssert.equal(reopenedEntries.length, 0);
  yield* checkpoint("worker: checking exact initialization notification remains read");
  const retainedInitialization = yield* client[WS_METHODS.meerkatAttention]({
    projectId,
    itemId: initializationAttentionId,
  });
  NodeAssert.equal(retainedInitialization.items.length, 1);
  NodeAssert.equal(retainedInitialization.items[0]!.id, initializationAttentionId);
  NodeAssert.equal(retainedInitialization.items[0]!.sessionId, worker.record.session_id);
  NodeAssert.equal(retainedInitialization.items[0]!.detail, ready.final);
  NodeAssert.equal(retainedInitialization.items[0]!.unread, false);
  yield* checkpoint("worker: sharing the coordinator browser");
  const workerGrant = yield* share(worker.agentRef);
  NodeAssert.equal(workerGrant.sessionId, worker.record.session_id);
  NodeAssert.equal(
    new Set([input.coordinatorGrant.sessionId, specialistGrant.sessionId, workerGrant.sessionId])
      .size,
    3,
  );
  const workerBrowserTask = yield* runAgent(
    worker.agentRef,
    workerGrant.sessionId,
    "worker",
    "interact",
    "worker-check",
    [ready.final],
  );
  yield* checkpoint("worker: checking subsequent console completion identity");
  const browserTeam = yield* client[WS_METHODS.meerkatProjectTeam]({ projectId });
  const browserCompletion = browserTeam.providers
    .flatMap((entry) => entry.agents)
    .find((agent) => agent.agentRef === worker.agentRef)?.work?.latestCompletion;
  NodeAssert.ok(browserCompletion && "interactionId" in browserCompletion);
  NodeAssert.equal(browserCompletion.status, "completed");
  const browserAttentionId = NodeCrypto.createHash("sha256")
    .update(
      encodeIdentityTuple([
        "completion",
        projectId,
        instanceId,
        worker.agentRef,
        worker.record.session_id,
        browserCompletion.interactionId,
      ]),
    )
    .digest("hex");
  yield* checkpoint("worker: checking exactly one new unread console notification");
  const browserAttention = yield* client[WS_METHODS.meerkatAttention]({ projectId });
  const workerCompletions = browserAttention.items.filter(
    (entry) => entry.agentRef === worker.agentRef && entry.kind === "completion",
  );
  NodeAssert.equal(
    workerCompletions.length,
    1,
    "Only the new unread console completion belongs in the default inbox",
  );
  const browserEntry = workerCompletions.find((entry) => entry.detail === workerBrowserTask.final);
  NodeAssert.ok(browserEntry);
  NodeAssert.equal(browserEntry.id, browserAttentionId);
  NodeAssert.notEqual(browserEntry.id, initializationAttentionId);
  NodeAssert.equal(browserEntry.sessionId, worker.record.session_id);
  NodeAssert.equal(browserEntry.unread, true);
  yield* checkpoint("worker: checking prior initialization read state after console completion");
  const initializationAfterConsole = yield* client[WS_METHODS.meerkatAttention]({
    projectId,
    itemId: initializationAttentionId,
  });
  NodeAssert.equal(initializationAfterConsole.items.length, 1);
  NodeAssert.equal(initializationAfterConsole.items[0]!.id, initializationAttentionId);
  NodeAssert.equal(initializationAfterConsole.items[0]!.sessionId, worker.record.session_id);
  NodeAssert.equal(initializationAfterConsole.items[0]!.detail, ready.final);
  NodeAssert.equal(initializationAfterConsole.items[0]!.unread, false);

  const revocations: { agentRef: string; sessionId: string | undefined; denied: boolean }[] = [];
  for (const [key, agentRef] of [
    ["specialist_revoke", specialistRef],
    ["worker_revoke", worker.agentRef],
  ] as const) {
    const scenario = provider.arm(key, "deny");
    yield* checkpoint(`${key}: waiting for granted native model request`);
    yield* sendAgent(agentRef, scenario);
    yield* Effect.promise(() => bounded(scenario.held.promise, `${key} native model request`));
    const revoked = yield* client[WS_METHODS.meerkatBrowserGrant]({
      ...target(agentRef),
      enabled: false,
    });
    NodeAssert.equal(revoked.enabled, false);
    NodeAssert.equal(
      (yield* client[WS_METHODS.meerkatBrowserStatus](target(agentRef))).enabled,
      false,
    );
    scenario.release.resolve();
    yield* checkpoint(`${key}: waiting for denied native call completion`);
    yield* waitAgent(agentRef, scenario.final);
    NodeAssert.ok(provider.evidence.some((entry) => entry.scenario === key && entry.denied));
    const shared = yield* share(agentRef);
    revocations.push({ agentRef, sessionId: shared.sessionId, denied: true });
  }

  const disabled = provider.arm("settings_disabled", "deny");
  yield* checkpoint("settings: waiting for granted native model request");
  yield* sendAgent(specialistRef, disabled);
  yield* Effect.promise(() =>
    bounded(disabled.held.promise, "granted specialist model request before settings change"),
  );
  const changed = yield* client[WS_METHODS.serverUpdateSettings]({
    patch: { projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: false } } },
  });
  NodeAssert.equal(changed.projectSettingsOverrides[projectId]?.enableAgentBrowserAccess, false);
  for (const agentRef of [specialistRef, worker.agentRef])
    NodeAssert.equal(
      (yield* client[WS_METHODS.meerkatBrowserStatus](target(agentRef))).reason,
      "disabled",
    );
  disabled.release.resolve();
  yield* checkpoint("settings: waiting for denied native call completion");
  yield* waitAgent(specialistRef, disabled.final);
  NodeAssert.ok(
    provider.evidence.some((entry) => entry.scenario === "settings_disabled" && entry.denied),
  );
  yield* client[WS_METHODS.serverUpdateSettings]({
    patch: { projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: true } } },
  });
  yield* share(specialistRef);
  yield* runAgent(specialistRef, specialistGrant.sessionId, "reenabled", "inspect", "worker-check");

  const otherThread = ThreadId.make(`preview-other-worktree-${NodeCrypto.randomUUID()}`);
  const other = yield* boundedPhase(
    "workspace: creating distinct native worktree",
    client[WS_METHODS.vcsCreateWorktree]({
      cwd: input.projectPath,
      refName: "main",
      newRefName: "preview-other-worktree",
      path: NodePath.join(NodePath.dirname(input.projectPath), "other-worktree"),
    }),
  );
  yield* boundedPhase(
    "workspace: configuring isolated native provider",
    Effect.promise(() => input.configureWorkspace(other.worktree.path)),
  );
  yield* boundedPhase(
    "workspace: creating distinct thread",
    client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
      type: "thread.create",
      commandId: CommandId.make(`create-${otherThread}`),
      threadId: otherThread,
      projectId,
      title: "Other browser worktree",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: other.worktree.refName,
      worktreePath: other.worktree.path,
      createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
    }),
  );
  yield* runThread(otherThread, provider.arm("other_worktree", "ready"));
  const wrongWorkspace = yield* boundedPhase(
    "workspace: rejecting foreign browser ownership",
    client[WS_METHODS.meerkatBrowserGrant]({
      ...target(specialistRef),
      hostThreadId: otherThread,
      enabled: true,
    }),
  );
  NodeAssert.equal(wrongWorkspace.enabled, false);
  NodeAssert.equal(wrongWorkspace.reason, "wrong-workspace");
  const stillShared = yield* boundedPhase(
    "workspace: checking original browser ownership",
    client[WS_METHODS.meerkatBrowserStatus](target(specialistRef)),
  );
  NodeAssert.equal(stillShared.enabled, true);
  NodeAssert.equal(stillShared.hostThreadId, threadId);
  NodeAssert.equal(stillShared.sessionId, specialistGrant.sessionId);
  yield* runAgent(
    specialistRef,
    specialistGrant.sessionId,
    "after_wrong_workspace",
    "inspect",
    "worker-check",
  );
  return {
    specialist: { agentRef: specialistRef, grant: specialistGrant },
    worker: {
      agentRef: worker.agentRef,
      sourceMobId: workerMobId,
      grant: workerGrant,
      initialization: {
        ...initialization,
        attentionId: initializationAttentionId,
        readAfterReopen: true,
      },
      browserCompletion: { ...browserCompletion, attentionId: browserEntry.id },
    },
    revocations,
    settingsDisableDenied: true,
    reenabledNativeSnapshot: true,
    wrongWorkspace: { threadId: otherThread, worktree: other.worktree, grant: wrongWorkspace },
    hostReplacement: "not-exercised",
    webOnlyNoHost: "not-exercised",
    tools: provider.evidence,
    provider: provider.status(),
  };
});

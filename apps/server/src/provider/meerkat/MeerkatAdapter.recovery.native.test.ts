// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - this opt-in test owns a native child, private storage and bounded loopback barriers.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionService } from "../../orchestration/Services/ProviderRuntimeIngestion.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeMeerkatAdapter } from "../Layers/MeerkatAdapter.ts";
import { ProviderSessionDirectoryLive } from "../Layers/ProviderSessionDirectory.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  createMeerkatGatewayClient,
  MeerkatGatewayTransportError,
  type MeerkatGatewayClient,
} from "./MeerkatGatewayClient.ts";
import { makeMeerkatTeamReader } from "./MeerkatTeamReader.ts";
import { makeMeerkatThreadRecoveryService } from "./MeerkatThreadRecoveryService.ts";

const binaryPath = process.env.T3CODE_TEST_MEERKAT_BINARY;
const firstInput = "RECOVERY_FIRST: run the one fixture shell operation and report its result.";
const nextInput = "RECOVERY_NEXT: remember the first result and reply without tools.";
const firstReply = "RECOVERY_FIRST_COMPLETE";
const nextReply = "RECOVERY_NEXT_COMPLETE";
const fixtureKey = "recovery-fixture-key";
const decodeProviderInput = Schema.decodeUnknownSync(
  Schema.Struct({ model: Schema.String, input: Schema.Array(Schema.Unknown) }),
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
const decodeCursor = Schema.decodeUnknownSync(
  Schema.Struct({
    version: Schema.Literal(1),
    threadId: Schema.String,
    mobId: Schema.String,
    projectPath: Schema.String,
    stateRoot: Schema.String,
    lastRunId: Schema.optional(Schema.String),
  }),
);
const decodeReceipt = Schema.decodeUnknownSync(Schema.Struct({ runId: Schema.String }));
const decodeMarker = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(1), runId: Schema.String })),
);
const decodeDeliveryPage = Schema.decodeUnknownSync(
  Schema.Struct({
    events: Schema.Array(
      Schema.Struct({ event_id: Schema.String, kind: Schema.String, run_id: Schema.String }),
    ),
  }),
);

async function bounded<A>(work: Promise<A>, stage: string): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Deadline waiting for ${stage}`)), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function latestUserInput(input: readonly unknown[]) {
  for (const item of input.toReversed()) {
    const decoded = decodeUserInput(item);
    if (Option.isSome(decoded)) {
      return typeof decoded.value.content === "string"
        ? decoded.value.content
        : decoded.value.content.map((part) => part.text).join("");
    }
  }
  throw new Error("The provider request has no user input");
}

function emitResponse(response: NodeHttp.ServerResponse, serial: number, item: object) {
  response.end(
    [
      { type: "response.output_item.added", output_index: 0, item },
      ...(serial === 0
        ? [{ ...item, type: "response.function_call_arguments.done", item_id: "fc_recovery" }]
        : []),
      {
        type: "response.completed",
        response: {
          id: `response_recovery_${serial}`,
          status: "completed",
          output: [item],
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
  );
}

// Runs only against a caller-supplied staged gateway. The sole admission fault
// drops a real successful response at the client boundary; native work continues.
describe.skipIf(!binaryPath)("native Meerkat adapter recovery", () => {
  it.live(
    "reconnects a lost admission reply, ingests replayed output once and accepts one distinct next input",
    () =>
      Effect.gen(function* () {
        if (!binaryPath) throw new Error("Native test executable was not supplied");
        const root = yield* Effect.promise(async () =>
          NodeFSP.realpath(
            await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "meerkat-adapter-recovery-")),
          ),
        );
        const projectPath = NodePath.join(root, "project");
        const providerStateRoot = NodePath.join(root, "native");
        const effectFile = NodePath.join(projectPath, "recovery-effect.txt");
        const adapterScope = yield* Scope.make("sequential");
        const releaseTool = Promise.withResolvers<void>();
        const releaseFinal = Promise.withResolvers<void>();
        const toolFinished = Promise.withResolvers<void>();
        const subscribed = Promise.withResolvers<void>();
        const sessionCommitted = Promise.withResolvers<void>();
        const firstStarted = Promise.withResolvers<ProviderRuntimeEvent>();
        const firstOutputCommitted = Promise.withResolvers<ProviderRuntimeEvent>();
        const firstTerminalCommitted = Promise.withResolvers<void>();
        const firstOutputAcknowledged = Promise.withResolvers<void>();
        const nextTerminalCommitted = Promise.withResolvers<void>();
        const providerRequests: string[] = [];
        const providerErrors: unknown[] = [];
        const calls: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = [];
        const processed: ProviderRuntimeEvent[] = [];
        let lostRunId: string | undefined;
        let allowOutputAcknowledgement = false;
        let native: MeerkatGatewayClient | undefined;
        const provider = NodeHttp.createServer(async (request, response) => {
          try {
            expect(request.url).toBe("/v1/responses");
            expect(request.headers.authorization).toBe(`Bearer ${fixtureKey}`);
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const payload = decodeProviderInput(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            expect(payload.model).toBe("gpt-5.6-sol");
            const input = latestUserInput(payload.input);
            const serial = providerRequests.length;
            providerRequests.push(input);
            if (serial > 2)
              throw new Error("Unexpected extra model request or duplicate execution");
            expect(input).toBe(serial < 2 ? firstInput : nextInput);
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(
              `data: ${JSON.stringify({ type: "response.created", response: { id: `response_recovery_${serial}` } })}\n\n`,
            );
            response.flushHeaders();
            if (serial === 0) {
              await bounded(releaseTool.promise, "release of the fixture shell operation");
              emitResponse(response, serial, {
                type: "function_call",
                id: "fc_recovery",
                call_id: "call_recovery",
                name: "shell",
                arguments: JSON.stringify({
                  command:
                    "printf '%s\\n' RECOVERY_EFFECT >> recovery-effect.txt; printf '%s' RECOVERY_TOOL_DONE",
                  timeout_secs: 10,
                }),
                status: "completed",
              });
              return;
            }
            if (serial === 1) {
              expect(JSON.stringify(payload.input)).toContain("RECOVERY_TOOL_DONE");
              expect(await NodeFSP.readFile(effectFile, "utf8")).toBe("RECOVERY_EFFECT\n");
              toolFinished.resolve();
              await bounded(releaseFinal.promise, "release of the first final answer");
            } else {
              expect(JSON.stringify(payload.input)).toContain(firstReply);
            }
            emitResponse(response, serial, {
              type: "message",
              id: `message_recovery_${serial}`,
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: serial === 1 ? firstReply : nextReply }],
            });
          } catch (cause) {
            providerErrors.push(cause);
            response.end();
          }
        });
        try {
          yield* Effect.promise(() =>
            Promise.all(
              [projectPath, NodePath.join(root, "home"), NodePath.join(root, "tmp")].map((path) =>
                NodeFSP.mkdir(path),
              ),
            ),
          );
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                provider.once("error", reject);
                provider.listen(0, "127.0.0.1", resolve);
              }),
          );
          const address = provider.address();
          if (!address || typeof address === "string")
            throw new Error("Fixture has no TCP address");
          native = createMeerkatGatewayClient({
            binaryPath,
            cwd: projectPath,
            env: {
              PATH: "/usr/bin:/bin",
              HOME: NodePath.join(root, "home"),
              TMPDIR: NodePath.join(root, "tmp"),
              LANG: "C.UTF-8",
              RUST_LOG: "error",
              MEERKAT_RECOVERY_FIXTURE_KEY: fixtureKey,
            },
            requestTimeoutMs: 15_000,
            shutdownTimeoutMs: 15_000,
          });
          const gateway = native;
          const faultClient: MeerkatGatewayClient = {
            ...gateway,
            request: async (method, params = {}, options) => {
              calls.push({ method, params });
              const result = await gateway.request(method, params, options);
              if (method === "mobs.v1.turnStart" && lostRunId === undefined) {
                lostRunId = decodeReceipt(result).runId;
                expect(lostRunId).toBe(params.runId);
                throw new MeerkatGatewayTransportError(
                  "fixture_lost_reply",
                  "Admission reply lost",
                  true,
                );
              }
              return result;
            },
          };
          const instanceId = ProviderInstanceId.make("meerkat-recovery-native");
          const threadId = ThreadId.make("recovery-native-thread");
          const projectId = ProjectId.make("recovery-native-project");
          const modelSelection = { instanceId, model: "openai:gpt-5.6-sol" };
          const adapter = yield* makeMeerkatAdapter({
            client: faultClient,
            instanceId,
            stateRoot: providerStateRoot,
            defaultCwd: projectPath,
            enabled: true,
            prepareWorkspace: async (workspacePath, stateRoot) => {
              expect(workspacePath).toBe(projectPath);
              let hash = 0xcbf29ce484222325n;
              for (const byte of Buffer.from(projectPath)) {
                hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
              }
              const realm = `ws-${hash.toString(16).padStart(16, "0")}`;
              const configDir = NodePath.join(stateRoot, realm);
              await NodeFSP.mkdir(configDir, { recursive: true });
              await NodeFSP.writeFile(
                NodePath.join(configDir, "config.toml"),
                `[realm.${realm}]
default_binding = "fixture"
[realm.${realm}.backend.fixture]
provider = "openai"
backend_kind = "openai_api"
base_url = "http://127.0.0.1:${address.port}"
[realm.${realm}.auth.fixture]
provider = "openai"
auth_method = "api_key"
source = { kind = "env", env = "MEERKAT_RECOVERY_FIXTURE_KEY" }
[realm.${realm}.binding.fixture]
backend_profile = "fixture"
auth_profile = "fixture"
provider_default = true
[model_fallback]
enabled = false
`,
              );
            },
          }).pipe(Scope.provide(adapterScope));
          const bridge = yield* PubSub.unbounded<ProviderRuntimeEvent>();
          yield* Stream.runForEach(adapter.streamEvents, (event) =>
            PubSub.publish(bridge, event),
          ).pipe(Effect.forkScoped({ startImmediately: true }), Scope.provide(adapterScope));
          const providerLayer = Layer.mock(ProviderService)({
            streamEvents: Stream.fromPubSub(bridge),
            // Ingestion starts before this fixture creates any persisted bindings.
            // Layer.mock fills omitted optional methods with throwing placeholders.
            observePersistedSessions: () => Effect.void,
            subscribeEvents: PubSub.subscribe(bridge).pipe(
              Effect.map((subscription) => {
                subscribed.resolve();
                return Stream.fromSubscription(subscription);
              }),
            ),
            listSessions: adapter.listSessions,
            stopObservingSession: adapter.stopObservingSession!,
            acknowledgeEvent: (event) =>
              Effect.gen(function* () {
                processed.push(event);
                if (event.type === "session.started") sessionCommitted.resolve();
                if (event.type === "turn.started") firstStarted.resolve(event);
                if (
                  event.type === "item.completed" &&
                  event.payload.itemType === "assistant_message" &&
                  event.payload.authoritativeText === firstReply
                ) {
                  firstOutputCommitted.resolve(event);
                  if (!allowOutputAcknowledgement) return;
                  yield* adapter.acknowledgeEvent!(event.eventId);
                  firstOutputAcknowledged.resolve();
                  return;
                }
                yield* adapter.acknowledgeEvent!(event.eventId);
                if (event.type === "turn.completed") {
                  if (event.turnId === lostRunId) firstTerminalCommitted.resolve();
                  else nextTerminalCommitted.resolve();
                }
              }),
          });
          const instance: ProviderInstance = {
            instanceId,
            driverKind: ProviderDriverKind.make("meerkat"),
            continuationIdentity: {
              driverKind: ProviderDriverKind.make("meerkat"),
              continuationKey: instanceId,
            },
            displayName: "Recovery fixture",
            enabled: true,
            adapter,
            meerkatTeam: makeMeerkatTeamReader({
              client: faultClient,
              path: yield* Path.Path,
              stateRoot: providerStateRoot,
              instanceId,
            }),
            meerkatControls: { request: faultClient.request },
            get snapshot(): never {
              throw new Error("Catalog is outside this test");
            },
            get textGeneration(): never {
              throw new Error("Auxiliary generation is outside this test");
            },
          };
          const registry = Layer.mock(ProviderInstanceRegistry)({
            getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
          });
          const persistence = makeSqlitePersistenceLive(NodePath.join(root, "state.sqlite"));
          const orchestration = OrchestrationEngineLive.pipe(
            Layer.provide(OrchestrationProjectionSnapshotQueryLive),
            Layer.provide(OrchestrationProjectionPipelineLive),
            Layer.provide(OrchestrationEventStoreLive),
            Layer.provide(OrchestrationCommandReceiptRepositoryLive),
            Layer.provide(RepositoryIdentityResolver.layer),
            Layer.provide(persistence),
          );
          const projection = OrchestrationProjectionSnapshotQueryLive.pipe(
            Layer.provide(RepositoryIdentityResolver.layer),
            Layer.provide(persistence),
          );
          const directoryLayer = ProviderSessionDirectoryLive.pipe(
            Layer.provide(ProviderSessionRuntime.layer),
            Layer.provide(persistence),
          );
          const runtimeLayer = ProviderRuntimeIngestionLive.pipe(
            Layer.provideMerge(orchestration),
            Layer.provideMerge(projection),
            Layer.provideMerge(directoryLayer),
            Layer.provideMerge(ThreadBackgroundLiveness.layer),
            Layer.provideMerge(ThreadPlanProgress.layer),
            Layer.provideMerge(persistence),
            Layer.provideMerge(providerLayer),
            Layer.provideMerge(registry),
            Layer.provideMerge(ServerSettingsService.layerTest()),
            Layer.provide(
              Layer.mock(CheckpointStore.CheckpointStore)({
                isGitRepository: () => Effect.succeed(false),
              }),
            ),
            Layer.provideMerge(ServerConfig.layerTest(projectPath, NodePath.join(root, "server"))),
            Layer.provideMerge(NodeServices.layer),
          );
          yield* Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService;
            const query = yield* ProjectionSnapshotQuery;
            const directory = yield* ProviderSessionDirectory;
            const ingestion = yield* ProviderRuntimeIngestionService;
            const recovery = yield* makeMeerkatThreadRecoveryService();
            yield* ingestion.start();
            yield* Effect.promise(() => bounded(subscribed.promise, "ingestion subscription"));
            const now = DateTime.formatIso(DateTime.nowUnsafe());
            yield* engine.dispatch({
              type: "project.create",
              commandId: CommandId.make("create-project"),
              projectId,
              title: "Recovery fixture",
              workspaceRoot: projectPath,
              defaultModelSelection: modelSelection,
              createdAt: now,
            });
            yield* engine.dispatch({
              type: "thread.create",
              commandId: CommandId.make("create-thread"),
              projectId,
              threadId,
              title: "Recovery fixture",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: now,
            });
            const initial = yield* adapter.startSession({
              threadId,
              cwd: projectPath,
              runtimeMode: "full-access",
              modelSelection,
            });
            const cursor = decodeCursor(initial.resumeCursor);
            yield* Effect.promise(() =>
              bounded(sessionCommitted.promise, "initial session SQL commit"),
            );
            yield* directory.upsert({
              threadId,
              provider: ProviderDriverKind.make("meerkat"),
              providerInstanceId: instanceId,
              resumeCursor: cursor,
              status: "running",
              runtimeMode: "full-access",
              runtimePayload: { modelSelection },
            });
            const appendRequest = (text: string, serial: number) =>
              engine.dispatch({
                type: "thread.turn.start",
                commandId: CommandId.make(`request-${serial}`),
                threadId,
                message: {
                  messageId: MessageId.make(`user-${serial}`),
                  role: "user",
                  text,
                  attachments: [],
                },
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
              });
            yield* appendRequest(firstInput, 1);
            const lost = yield* adapter
              .sendTurn({ threadId, input: firstInput, modelSelection })
              .pipe(Effect.result);
            expect(lost._tag).toBe("Failure");
            expect(lostRunId).toBeTypeOf("string");
            const originalRun = lostRunId!;
            expect(
              (yield* Effect.promise(() =>
                bounded(firstStarted.promise, "original run SQL admission"),
              )).turnId,
            ).toBe(originalRun);
            const markerPath = NodePath.join(
              cursor.stateRoot,
              "t3-dispatch",
              `${cursor.mobId}.json`,
            );
            expect(
              decodeMarker(yield* Effect.promise(() => NodeFSP.readFile(markerPath, "utf8"))).runId,
            ).toBe(originalRun);
            // New work remains fenced until the consumer explicitly reconciles this admission.
            expect(
              yield* adapter.sendTurn({ threadId, input: "MUST_NOT_REPLAY" }).pipe(Effect.result),
            ).toMatchObject({
              _tag: "Failure",
              failure: {
                _tag: "ProviderAdapterValidationError",
                provider: "meerkat",
                operation: "sendTurn",
                issue: "Meerkat runtime state is uncertain. This turn will not be replayed.",
              },
            });
            releaseTool.resolve();
            yield* Effect.promise(() =>
              bounded(toolFinished.promise, "actual shell effect and provider tool result"),
            );
            yield* ingestion.drain;
            const target = { projectId, threadId, instanceId };
            expect(yield* recovery.status(target)).toMatchObject({
              status: "running",
              runId: originalRun,
              canRecover: false,
            });
            expect(yield* recovery.reconnect({ ...target, runId: originalRun })).toEqual({
              runId: originalRun,
              reconnected: true,
              status: "running",
            });
            expect(calls.filter((call) => call.method === "mobs.v1.turnStart")).toHaveLength(1);
            expect(
              calls.some((call) =>
                ["mobs.v1.recoverThread", "mobs.v1.forceCancel", "mobs.v1.destroy"].includes(
                  call.method,
                ),
              ),
            ).toBe(false);
            releaseFinal.resolve();
            const originalOutput = yield* Effect.promise(() =>
              bounded(firstOutputCommitted.promise, "first output SQL commit"),
            );
            yield* Effect.promise(() =>
              bounded(firstTerminalCommitted.promise, "first terminal SQL commit"),
            );
            yield* ingestion.drain;
            const nativeTarget = {
              projectPath,
              stateRoot: cursor.stateRoot,
              threadId,
              mobId: cursor.mobId,
            };
            expect(
              decodeDeliveryPage(
                yield* Effect.promise(() =>
                  gateway.request("mobs.v1.threadDeliveries", nativeTarget),
                ),
              ).events,
            ).toContainEqual({
              event_id: originalOutput.eventId,
              kind: "run.output.complete",
              run_id: originalRun,
            });
            const beforeReplay = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
            expect(
              beforeReplay.messages
                .filter((message) => message.role === "assistant")
                .map((message) => message.text),
            ).toEqual([firstReply]);
            allowOutputAcknowledgement = true;
            yield* Effect.promise(() =>
              bounded(
                firstOutputAcknowledged.promise,
                "replayed output persistence and native acknowledgement",
              ),
            );
            yield* ingestion.drain;
            expect(
              processed.filter((event) => event.eventId === originalOutput.eventId).length,
            ).toBeGreaterThanOrEqual(2);
            const afterReplay = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
            expect(afterReplay.messages).toEqual(beforeReplay.messages);
            expect(
              decodeDeliveryPage(
                yield* Effect.promise(() =>
                  gateway.request("mobs.v1.threadDeliveries", nativeTarget),
                ),
              ).events,
            ).toEqual([]);
            expect(
              yield* Effect.promise(() =>
                gateway.request("mobs.v1.runStatus", { ...nativeTarget, runId: originalRun }),
              ),
            ).toMatchObject({
              runId: originalRun,
              threadId,
              mobId: cursor.mobId,
              status: "completed",
            });
            yield* appendRequest(nextInput, 2);
            const next = yield* adapter.sendTurn({ threadId, input: nextInput, modelSelection });
            expect(next.turnId).not.toBe(originalRun);
            expect(decodeCursor(next.resumeCursor).mobId).toBe(cursor.mobId);
            yield* Effect.promise(() =>
              bounded(nextTerminalCommitted.promise, "next input terminal SQL commit"),
            );
            yield* ingestion.drain;
            const final = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
            expect(
              final.messages
                .filter((message) => message.role === "assistant")
                .map((message) => ({
                  text: message.text,
                  turnId: message.turnId,
                  streaming: message.streaming,
                })),
            ).toEqual([
              { text: firstReply, turnId: originalRun, streaming: false },
              { text: nextReply, turnId: next.turnId, streaming: false },
            ]);
            expect(providerRequests).toEqual([firstInput, firstInput, nextInput]);
            expect(
              calls
                .filter((call) => call.method === "mobs.v1.turnStart")
                .map((call) => call.params.runId),
            ).toEqual([originalRun, next.turnId]);
            expect(yield* Effect.promise(() => NodeFSP.readFile(effectFile, "utf8"))).toBe(
              "RECOVERY_EFFECT\n",
            );
            expect(providerErrors).toEqual([]);
          }).pipe(Effect.provide(runtimeLayer), Effect.scoped);
        } finally {
          releaseTool.resolve();
          releaseFinal.resolve();
          yield* Scope.close(adapterScope, Exit.void);
          yield* Effect.promise(async () => {
            try {
              await native?.close();
            } finally {
              provider.closeAllConnections();
              await new Promise<void>((resolve) => provider.close(() => resolve()));
              await NodeFSP.rm(root, { recursive: true, force: true });
            }
          });
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    90_000,
  );
});

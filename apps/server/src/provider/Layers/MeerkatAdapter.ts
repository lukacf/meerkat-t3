import { resolveMeerkatProviderParams } from "../meerkat/MeerkatModelOptions.ts";
import * as NodeCrypto from "node:crypto";
import { extractMeerkatSkillSelections } from "@t3tools/shared/meerkatSkills";

import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  SkillResolutionPayload,
  TurnId,
  type ProviderInstanceId,
  type ModelSelection,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  MeerkatGatewayRpcError,
  type MeerkatGatewayClient,
  type MeerkatGatewayEvent,
} from "../meerkat/MeerkatGatewayClient.ts";
import { configureMeerkatThreadBrowser } from "../meerkat/MeerkatBrowser.ts";
import { prepareMeerkatContent } from "../meerkat/MeerkatMedia.ts";
import {
  meerkatExecutionModeError,
  validateMeerkatAccessMode,
} from "../meerkat/MeerkatExecutionModes.ts";
import { makeMeerkatFollowupObserver } from "../meerkat/MeerkatFollowupObserver.ts";
import { makeMeerkatDeliveryObserver } from "../meerkat/MeerkatDeliveryObserver.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("meerkat");
const decodeSkillResolution = Schema.decodeUnknownOption(SkillResolutionPayload);
// Validate transport provenance, but retain the original envelope and native
// payload. The Rust failure enum is not mirrored in the adapter.
const decodeSkillEnvelopeProvenance = Schema.decodeUnknownOption(
  Schema.Struct({
    event_id: Schema.String,
    source: Schema.Struct({ type: Schema.Literal("session"), session_id: Schema.String }),
    seq: Schema.Number,
    timestamp_ms: Schema.Number,
    payload: Schema.Record(Schema.String, Schema.Unknown),
  }),
);
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const ResumeCursor = Schema.Struct({
  version: Schema.Literal(1),
  threadId: Schema.String,
  mobId: Schema.String,
  projectPath: Schema.String,
  stateRoot: Schema.String,
  lastRunId: Schema.optional(Schema.String),
});
type ResumeCursor = typeof ResumeCursor.Type;
const DispatchMarker = Schema.Struct({
  version: Schema.Literal(1),
  runId: Schema.optional(Schema.String),
});
const DispatchMarkerJson = Schema.fromJsonString(DispatchMarker);
const encodeDispatchMarker = Schema.encodeSync(DispatchMarkerJson);
const decodeDispatchMarker = Schema.decodeUnknownEffect(DispatchMarkerJson);

const RunResult = Schema.Struct({ runId: Schema.String });
const SteerResult = Schema.Struct({
  runId: Schema.String,
  mode: Schema.Literal("steering_submitted"),
  handlingMode: Schema.Literal("steer"),
  status: Schema.Literal("running"),
  runtimeReceipt: Schema.Struct({
    identity: Schema.Literal("ingress"),
    handling_mode: Schema.Literal("steer"),
  }),
});
const RunStatus = Schema.Struct({ status: Schema.String });
const ExactRunStatus = Schema.Struct({
  status: Schema.String,
  runId: Schema.String,
  threadId: Schema.String,
  mobId: Schema.String,
});
const CancelResult = Schema.Struct({
  runtimeCancelled: Schema.Boolean,
  cancellationRequested: Schema.optional(Schema.Boolean),
});
const DisposalResult = Schema.Struct({ cleanupCompleted: Schema.Literal(true) });
const Timeline = Schema.Struct({
  timeline: Schema.Struct({ frames: Schema.Array(Schema.Unknown) }),
});

export function meerkatProjectStateRoot(
  path: Path.Path,
  root: string,
  projectPath: string,
): string {
  return path.join(
    root,
    "projects",
    NodeCrypto.createHash("sha256").update(projectPath).digest("hex"),
  );
}

export function decodeMeerkatModel(model: string): { provider: string; model: string } {
  const separator = model.indexOf(":");
  if (separator < 1 || separator === model.length - 1) {
    throw new Error("Choose a provider-qualified model from the Meerkat catalog.");
  }
  return { provider: model.slice(0, separator), model: model.slice(separator + 1) };
}

interface SessionContext {
  session: ProviderSession;
  cursor: ResumeCursor;
  pending: boolean;
  uncertain: boolean;
  stopping: boolean;
  modelOptions?: ModelSelection["options"];
  readonly terminalRuns: Set<string>;
  readonly assistantItems: Map<string, { id: string; complete: boolean }>;
}

export interface MeerkatAdapterOptions {
  readonly client: MeerkatGatewayClient;
  readonly instanceId: ProviderInstanceId;
  readonly stateRoot: string;
  readonly defaultCwd: string;

  readonly enabled: boolean;
  readonly createRunId?: () => string;
  readonly attachmentsDir?: string;
  readonly prepareWorkspace?: (projectPath: string, stateRoot: string) => Promise<void>;
}

export const makeMeerkatAdapter = Effect.fn("makeMeerkatAdapter")(function* (
  options: MeerkatAdapterOptions,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const sessions = new Map<ThreadId, SessionContext>();
  const recoveries = new Map<ThreadId, string>();
  const starting = new Set<ThreadId>();
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(events));
  const publish = (event: ProviderRuntimeEvent) => PubSub.publishUnsafe(events, event);
  const stamp = (threadId: ThreadId, event?: MeerkatGatewayEvent) => ({
    provider: PROVIDER,
    providerInstanceId: options.instanceId,
    threadId,
    eventId: EventId.make(event?.event_id ?? NodeCrypto.randomUUID()),
    createdAt: event?.timestamp ?? DateTime.formatIso(DateTime.nowUnsafe()),
    ...(event?.run_id
      ? { turnId: TurnId.make(event.run_id), providerRefs: { providerTurnId: event.run_id } }
      : {}),
  });
  const validation = (operation: string, issue: string) =>
    new ProviderAdapterValidationError({ provider: PROVIDER, operation, issue });
  const rpc = (method: string, params: Readonly<Record<string, unknown>>) =>
    Effect.tryPromise({
      try: () =>
        options.client.request(
          method,
          params,
          method === "mobs.v1.turnStart"
            ? { timeoutMs: 330_000 }
            : method === "mobs.v1.destroy"
              ? { timeoutMs: 660_000 }
              : undefined,
        ),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
  const contextFor = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };
  const paramsFor = (context: SessionContext) => ({
    threadId: context.session.threadId,
    projectPath: context.cursor.projectPath,
    executionPath: context.cursor.projectPath,
    executionMode: "local",
    stateRoot: context.cursor.stateRoot,
    configStateRoot: context.cursor.stateRoot,
    mobId: context.cursor.mobId,
    agentIdentity: "ingress",
  });
  const decode = <S extends Schema.Top>(schema: S, value: unknown, operation: string) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError((cause) => validation(operation, cause.message)),
    );

  const dispatchPath = (cursor: ResumeCursor) =>
    path.join(cursor.stateRoot, "t3-dispatch", `${cursor.mobId}.json`);
  const persistenceError = (cause: { readonly message: string }) =>
    validation("dispatchJournal", cause.message);
  const writeDispatch = Effect.fn("MeerkatAdapter.writeDispatch")(function* (
    cursor: ResumeCursor,
    runId?: string,
  ) {
    const target = dispatchPath(cursor);
    const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
    yield* fs
      .makeDirectory(path.dirname(target), { recursive: true })
      .pipe(Effect.mapError(persistenceError));
    yield* fs
      .writeFileString(temporary, encodeDispatchMarker({ version: 1, ...(runId ? { runId } : {}) }))
      .pipe(Effect.mapError(persistenceError));
    yield* Effect.scoped(fs.open(temporary).pipe(Effect.flatMap((file) => file.sync))).pipe(
      Effect.mapError(persistenceError),
    );
    yield* fs.rename(temporary, target).pipe(Effect.mapError(persistenceError));
    yield* Effect.scoped(
      fs.open(path.dirname(target)).pipe(Effect.flatMap((file) => file.sync)),
    ).pipe(Effect.mapError(persistenceError));
  });
  const clearDispatch = (cursor: ResumeCursor) =>
    fs.remove(dispatchPath(cursor), { force: true }).pipe(Effect.mapError(persistenceError));

  const followups = makeMeerkatFollowupObserver({
    instanceId: options.instanceId,
    read: (params) => rpc("mobs.v1.threadFollowups", { ...params }),
    publish,
  });
  yield* Effect.forkScoped(
    Effect.forever(followups.poll().pipe(Effect.andThen(Effect.sleep("1 second")))),
  );
  yield* Effect.addFinalizer(() => Effect.sync(followups.clear));
  const observeSession = Effect.fn("MeerkatAdapter.observeSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly resumeCursor: unknown;
  }) {
    if (!options.enabled) return;
    const cursor = yield* decode(ResumeCursor, input.resumeCursor, "observeSession");
    if (
      cursor.threadId !== input.threadId ||
      cursor.stateRoot !== meerkatProjectStateRoot(path, options.stateRoot, cursor.projectPath)
    )
      return yield* validation(
        "observeSession",
        "Meerkat history ownership does not match the persisted binding.",
      );
    followups.observe({ ...cursor, threadId: input.threadId });
    deliveries.observe({ ...cursor, threadId: input.threadId });
  });

  const handleGatewayEvent = (event: MeerkatGatewayEvent, replay = false) => {
    if (!event.thread_id) return;
    const threadId = event.thread_id as ThreadId;
    const context = sessions.get(threadId);
    if (!event.run_id || (!replay && (!context || context.terminalRuns.has(event.run_id)))) return;
    const base = stamp(threadId, event);
    const payload = event.payload;
    const text = (key: string) =>
      typeof payload[key] === "string" ? (payload[key] as string) : undefined;
    const runId = event.run_id;
    if (!replay && context?.session.activeTurnId && context.session.activeTurnId !== runId) return;
    if (event.kind === "skills.resolved" || event.kind === "skills.resolution-failed") {
      const resolution = decodeSkillResolution(payload);
      const envelope = Option.flatMap(resolution, (receipt) =>
        decodeSkillEnvelopeProvenance(receipt.nativeEvent),
      );
      if (
        Option.isNone(resolution) ||
        Option.isNone(envelope) ||
        resolution.value.nativeDeliveryId !== event.event_id ||
        resolution.value.nativeSessionId !== envelope.value.source.session_id ||
        resolution.value.nativeSourceEventId !== `evt-agent-${envelope.value.event_id}` ||
        event.event_id !==
          `meerkat-output:${runId}:${resolution.value.nativeSessionId}:${resolution.value.nativeSourceEventId}` ||
        Date.parse(event.timestamp) !== envelope.value.timestamp_ms ||
        envelope.value.payload.type !==
          (event.kind === "skills.resolved" ? "skills_resolved" : "skill_resolution_failed")
      ) {
        publish({
          ...base,
          eventId: EventId.make(`${event.event_id}:invalid-skill-receipt`),
          type: "runtime.warning",
          payload: {
            message:
              "Meerkat skill resolution receipt could not be read. Saved activity will retry.",
          },
        });
        return;
      }
      if (context) deliveries.track(base.eventId, { ...context.cursor, threadId });
      publish({ ...base, type: event.kind, payload: resolution.value });
      return;
    }
    if (event.kind === "run.started") {
      if (!context) return;
      context.cursor = { ...context.cursor, lastRunId: runId };
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: TurnId.make(runId),
        resumeCursor: context.cursor,
        updatedAt: event.timestamp,
      };
      publish({
        ...base,
        type: "turn.started",
        payload: text("appliedModel") ? { model: text("appliedModel") } : {},
      });
      return;
    }
    if (event.kind === "run.output.delta" || event.kind === "run.output.complete") {
      const previous = context?.assistantItems.get(runId);
      const itemId = RuntimeItemId.make(
        text("nativeSegmentId")
          ? `${runId}:assistant:${text("nativeSegmentId")}`
          : previous && !previous.complete
            ? previous.id
            : `${runId}:assistant:${event.event_id}`,
      );
      const complete = event.kind === "run.output.complete";
      context?.assistantItems.set(runId, { id: itemId, complete });
      if (complete) {
        if (context) deliveries.track(base.eventId, { ...context.cursor, threadId });
        publish({
          ...base,
          itemId,
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            authoritativeText: text("text") ?? "",
          },
        });
      } else {
        publish({
          ...base,
          itemId,
          type: "content.delta",
          payload: {
            streamKind: "assistant_text",
            delta: text("textDelta") ?? "",
          },
        });
      }
      return;
    }
    if (event.kind === "thinking.delta" || event.kind === "thinking.summary") {
      const delta = text(event.kind === "thinking.delta" ? "textDelta" : "text");
      if (delta && event.kind === "thinking.delta")
        publish({
          ...base,
          itemId: RuntimeItemId.make(`${runId}:reasoning`),
          type: "content.delta",
          payload: { streamKind: "reasoning_text", delta },
        });
      if (event.kind === "thinking.summary")
        publish({
          ...base,
          itemId: RuntimeItemId.make(`${runId}:reasoning`),
          type: "item.completed",
          payload: {
            itemType: "reasoning",
            status: "completed",
            ...(delta ? { detail: delta } : {}),
          },
        });
      return;
    }
    if (event.kind.startsWith("tool.")) {
      const toolId = text("toolId");
      if (!toolId) {
        publish({
          ...base,
          type: "runtime.warning",
          payload: {
            message: "Meerkat emitted a tool event without runtime identity.",
            detail: payload,
          },
        });
        return;
      }
      const command = event.kind.startsWith("tool.command.");
      const started = event.kind.endsWith("started") || payload.toolPhase === "started";
      const status = text("status")?.toLowerCase();
      const failed =
        payload.isError === true ||
        payload.is_error === true ||
        (typeof payload.exitCode === "number" && payload.exitCode !== 0) ||
        payload.timedOut === true ||
        status === "error" ||
        status === "failed";
      publish({
        ...base,
        itemId: RuntimeItemId.make(`${runId}:tool:${toolId}`),
        type: started ? "item.started" : "item.completed",
        payload: {
          itemType: command ? "command_execution" : "dynamic_tool_call",
          status: started ? "inProgress" : failed ? "failed" : "completed",
          title: text("title") ?? text("toolName") ?? "Meerkat tool",
          ...((text("output") ?? text("text")) ? { detail: text("output") ?? text("text") } : {}),
          data: payload,
        },
      });
      return;
    }
    if (["run.completed", "run.failed", "run.cancelled"].includes(event.kind)) {
      if (context) {
        deliveries.track(base.eventId, { ...context.cursor, threadId });
        context.terminalRuns.add(runId);
        context.assistantItems.delete(runId);
        if (context.terminalRuns.size > 128)
          context.terminalRuns.delete(context.terminalRuns.values().next().value!);
        if (!context.session.activeTurnId || context.session.activeTurnId === runId) {
          const { activeTurnId: _activeTurnId, ...rest } = context.session;
          context.session = { ...rest, status: "ready", updatedAt: event.timestamp };
        }
      }
      publish({
        ...base,
        type: "turn.completed",
        payload: {
          state:
            event.kind === "run.completed"
              ? "completed"
              : event.kind === "run.cancelled"
                ? "cancelled"
                : "failed",
          ...(text("message") ? { errorMessage: text("message") } : {}),
        },
      });
    }
  };
  const deliveries = makeMeerkatDeliveryObserver({
    request: rpc,
    publish: (event) => handleGatewayEvent(event, true),
    health: (target, error) =>
      publish({
        ...stamp(target.threadId),
        type: "runtime.warning",
        payload: {
          message: error
            ? "Conversation sync needs attention. Saved output will retry automatically."
            : "Conversation sync is available.",
          detail: {
            kind: "meerkat.delivery.health",
            status: error ? "error" : "ready",
            ...(error ? { error } : {}),
          },
        },
      }),
  });
  const unsubscribe = options.client.subscribe(handleGatewayEvent);
  yield* Effect.forkScoped(
    Effect.forever(deliveries.poll().pipe(Effect.andThen(Effect.sleep("1 second")))),
  );
  yield* Effect.addFinalizer(() => Effect.sync(deliveries.clear));
  const removeCloseListener = options.client.onClose((error) => {
    for (const [threadId, context] of sessions) {
      context.uncertain = context.pending || context.session.activeTurnId !== undefined;
      context.session = { ...context.session, status: "error", lastError: error.message };
      publish({
        ...stamp(threadId),
        type: "session.exited",
        payload: { reason: error.message, recoverable: !context.uncertain, exitKind: "error" },
      });
    }
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unsubscribe();
      removeCloseListener();
    }),
  );

  const stopSession = Effect.fn("MeerkatAdapter.stopSession")(function* (threadId: ThreadId) {
    if (recoveries.has(threadId) || starting.has(threadId))
      return yield* validation("stopSession", "Session recovery or connection is in progress.");
    const context = sessions.get(threadId);
    if (!context) return;
    if (context.stopping)
      return yield* validation("stopSession", "Native cleanup is already in progress.");
    context.stopping = true;
    yield* Effect.gen(function* () {
      yield* decode(
        DisposalResult,
        yield* rpc("mobs.v1.destroy", paramsFor(context)),
        "stopSession",
      );
      // The native receipt confirms execution has stopped; retained native
      // history and the resume cursor belong to the durable conversation.
      sessions.delete(threadId);
      // Keep passive output delivery until the durable thread is deleted.
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          context.stopping = false;
        }),
      ),
    );
  });

  const startSession = (input: ProviderSessionStartInput, recovering = false) =>
    Effect.gen(function* () {
      if ((!recovering && recoveries.has(input.threadId)) || starting.has(input.threadId))
        return yield* validation("startSession", "Session recovery or connection is in progress.");
      starting.add(input.threadId);
      return yield* Effect.gen(function* () {
        if (!options.enabled) return yield* validation("startSession", "Meerkat is disabled.");
        const modeError = meerkatExecutionModeError(input);
        if (modeError) return yield* validation("startSession", modeError);
        const existing = sessions.get(input.threadId);
        if (existing && input.runtimeMode !== existing.session.runtimeMode)
          return yield* validation(
            "startSession",
            "This conversation keeps its original native access mode. Start a new conversation to choose a different mode.",
          );
        if (existing?.stopping)
          return yield* validation("startSession", "Native cleanup is still in progress.");
        if (existing) return existing.session;
        const projectPath = path.resolve(input.cwd ?? options.defaultCwd);
        const stateRoot = meerkatProjectStateRoot(path, options.stateRoot, projectPath);
        const expected: ResumeCursor = {
          version: 1,
          threadId: input.threadId,
          mobId: `t3-${NodeCrypto.createHash("sha256").update(`${options.instanceId}:${input.threadId}`).digest("hex")}`,
          projectPath,
          stateRoot,
        };
        let cursor =
          input.resumeCursor === undefined
            ? expected
            : yield* decode(ResumeCursor, input.resumeCursor, "startSession");
        if (
          cursor.threadId !== expected.threadId ||
          cursor.mobId !== expected.mobId ||
          cursor.projectPath !== expected.projectPath ||
          cursor.stateRoot !== expected.stateRoot
        )
          return yield* validation(
            "startSession",
            "Meerkat resume identity does not match this instance, thread, and workspace.",
          );
        const markerPath = dispatchPath(cursor);
        if (yield* fs.exists(markerPath).pipe(Effect.mapError(persistenceError))) {
          const marker = yield* fs
            .readFileString(markerPath)
            .pipe(
              Effect.mapError(persistenceError),
              Effect.flatMap(decodeDispatchMarker),
              Effect.mapError(persistenceError),
            );
          if (!marker.runId)
            return yield* validation(
              "startSession",
              "The previous Meerkat dispatch has an unknown outcome. It will not be replayed.",
            );
          cursor = { ...cursor, lastRunId: marker.runId };
        }
        let reattachRunning = false;
        if (cursor.lastRunId) {
          const status = yield* decode(
            RunStatus,
            yield* rpc("mobs.v1.runStatus", {
              projectPath,
              stateRoot,
              threadId: input.threadId,
              mobId: cursor.mobId,
              runId: cursor.lastRunId,
            }),
            "startSession",
          );
          reattachRunning = status.status === "running";
          if (!["completed", "failed", "cancelled", "recovered", "running"].includes(status.status))
            return yield* validation(
              "startSession",
              "The previous Meerkat run has no terminal receipt. Reconnect to its runtime before starting another turn; it will not be replayed.",
            );
        }
        const model = input.modelSelection
          ? yield* Effect.try({
              try: () => decodeMeerkatModel(input.modelSelection!.model),
              catch: (cause) => validation("startSession", String(cause)),
            })
          : undefined;
        if (!reattachRunning && options.prepareWorkspace) {
          yield* Effect.tryPromise({
            try: () => options.prepareWorkspace!(projectPath, stateRoot),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "startSession",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          });
        }
        const nativeMode = reattachRunning
          ? yield* rpc("mobs.v1.snapshot", {
              projectPath,
              stateRoot,
              mobId: cursor.mobId,
            })
          : yield* rpc("mobs.v1.createThreadMob", {
              includeNativeWorkers: true,
              accessMode: input.runtimeMode,
              threadId: input.threadId,
              projectPath,
              executionPath: projectPath,
              stateRoot,
              configStateRoot: stateRoot,
              mobId: cursor.mobId,
              title: input.title ?? "Meerkat task",
              ...(model ? { model: model.model } : {}),
            });
        yield* Effect.try({
          try: () => validateMeerkatAccessMode(input.runtimeMode, nativeMode),
          catch: (cause) =>
            validation("startSession", cause instanceof Error ? cause.message : String(cause)),
        });
        const now = DateTime.formatIso(DateTime.nowUnsafe());
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: options.instanceId,
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          status: reattachRunning ? "running" : "ready",
          ...(reattachRunning && cursor.lastRunId
            ? { activeTurnId: TurnId.make(cursor.lastRunId) }
            : {}),
          cwd: projectPath,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          resumeCursor: cursor,
          createdAt: now,
          updatedAt: now,
        };
        sessions.set(input.threadId, {
          session,
          cursor,
          pending: false,
          uncertain: false,
          stopping: false,
          ...(input.modelSelection?.options ? { modelOptions: input.modelSelection.options } : {}),
          terminalRuns: new Set(),
          assistantItems: new Map(),
        });
        yield* observeSession({ threadId: input.threadId, resumeCursor: cursor });
        // Explicit recovery settles the previous turn before projecting readiness.
        if (!recovering) {
          publish({
            ...stamp(input.threadId),
            type: "session.started",
            payload: { resume: cursor },
          });
          publish({
            ...stamp(input.threadId),
            type: "session.state.changed",
            payload: { state: reattachRunning ? "running" : "ready" },
          });
        }
        return session;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            starting.delete(input.threadId);
          }),
        ),
      );
    });

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: PROVIDER,
    observeSession,
    stopObservingSession: (threadId) =>
      Effect.sync(() => {
        followups.forget(threadId);
        deliveries.forget(threadId);
      }),
    acknowledgeEvent: (eventId) =>
      deliveries
        .acknowledge(eventId)
        .pipe(Effect.andThen(Effect.sync(() => followups.acknowledge(eventId)))),
    capabilities: {
      sessionModelSwitch: "in-session",
      supportsConversationRollback: false,
      promptlessTurnContinuation: false,
    },
    startSession: (input) => startSession(input),
    sendTurn: (input) =>
      Effect.gen(function* () {
        const context = yield* contextFor(input.threadId);
        if (context.stopping)
          return yield* validation("sendTurn", "Native cleanup is still in progress.");
        if (context.uncertain || context.session.status === "error")
          return yield* validation(
            "sendTurn",
            "Meerkat runtime state is uncertain. This turn will not be replayed.",
          );
        if (input.interactionMode === "plan")
          return yield* validation(
            "sendTurn",
            "Meerkat plan mode is not supported in this prototype.",
          );
        if (!input.input?.trim() && !input.attachments?.length)
          return yield* validation("sendTurn", "A prompt or image is required.");
        if (context.pending)
          return yield* validation(
            "sendTurn",
            "A Meerkat send is still awaiting its runtime receipt.",
          );
        const steering = input.handlingMode === "steer";
        const activeRunId = context.session.activeTurnId;
        if (
          steering &&
          (!activeRunId ||
            (input.steeringTurnId !== undefined && input.steeringTurnId !== activeRunId))
        )
          return yield* validation(
            "sendTurn",
            "The run ended before steering. Send this message as a new turn.",
          );
        if (!steering && activeRunId)
          return yield* validation(
            "sendTurn",
            "Meerkat is busy. Queue this message or use steering.",
          );
        if (steering && input.modelSelection) {
          const optionKey = (options: ModelSelection["options"]) =>
            JSON.stringify(
              [...(options ?? [])]
                .filter((option) => option.id !== "prompt_cache_enabled")
                .sort((left, right) => left.id.localeCompare(right.id)),
            );
          if (
            input.modelSelection.instanceId !== options.instanceId ||
            input.modelSelection.model !== context.session.model ||
            optionKey(input.modelSelection.options) !== optionKey(context.modelOptions)
          )
            return yield* validation(
              "sendTurn",
              "Steering keeps the active model and options. Apply model changes on the next turn.",
            );
        }
        const selection = input.modelSelection?.model ?? context.session.model;
        const { skillReferences } = yield* Effect.try({
          try: () => extractMeerkatSkillSelections(input.skillSelectionText ?? input.input ?? ""),
          catch: (cause) => validation("sendTurn", String(cause)),
        });
        if (steering && skillReferences.length)
          return yield* validation(
            "sendTurn",
            "Skills start with a new turn. Send this as a new message or queue it for later.",
          );
        if (!selection) return yield* validation("sendTurn", "Choose a Meerkat model first.");
        const identity = yield* Effect.try({
          try: () => decodeMeerkatModel(selection),
          catch: (cause) => validation("sendTurn", String(cause)),
        });
        if (recoveries.has(input.threadId) || sessions.get(input.threadId) !== context)
          return yield* validation(
            "sendTurn",
            "Session recovery is in progress. Refresh before sending.",
          );
        context.pending = true;
        const { content, providerParams } = yield* Effect.gen(function* () {
          const providerParams = steering
            ? undefined
            : yield* Effect.tryPromise({
                try: (signal) =>
                  resolveMeerkatProviderParams({
                    client: options.client,
                    projectPath: context.cursor.projectPath,
                    configStateRoot: context.cursor.stateRoot,
                    ...identity,
                    options: input.modelSelection
                      ? input.modelSelection.options
                      : context.modelOptions,
                    signal,
                  }),
                catch: (cause) => validation("sendTurn", String(cause)),
              });
          yield* Effect.tryPromise({
            try: () =>
              configureMeerkatThreadBrowser(options.client, input.threadId, paramsFor(context)),
            catch: (cause) =>
              new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "Browser access could not be synchronized with the current T3 session.",
                cause,
              }),
          });
          const content = yield* Effect.tryPromise({
            try: () =>
              prepareMeerkatContent({
                text: input.input,
                attachments: input.attachments,
                attachmentsDir: options.attachmentsDir,
                scope: paramsFor(context),
                client: options.client,
                readFile: (file) => Effect.runPromise(fs.readFile(file)),
              }),
            catch: (cause) =>
              new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: cause instanceof Error ? cause.message : String(cause),
              }),
          });
          return { content, providerParams };
        }).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              context.pending = false;
            }),
          ),
        );
        // The operation identity reaches durable storage before native I/O.
        // Steering retains its existing unknown-delivery fence until acknowledged.
        const requestedRunId = steering
          ? undefined
          : (options.createRunId ?? NodeCrypto.randomUUID)();
        yield* writeDispatch(context.cursor, requestedRunId).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              context.pending = false;
            }),
          ),
        );
        const started = yield* Effect.gen(function* () {
          const result = yield* rpc("mobs.v1.turnStart", {
            ...paramsFor(context),
            input: content,
            ...(skillReferences.length ? { skillReferences } : {}),
            ...(steering
              ? { handlingMode: "steer", expectedRunId: activeRunId }
              : {
                  handlingMode: "queue",
                  runId: requestedRunId,
                  ...identity,
                  providerParams: providerParams ?? null,
                }),
          });
          const receipt = steering
            ? yield* decode(SteerResult, result, "sendTurn")
            : yield* decode(RunResult, result, "sendTurn");
          if (!steering && receipt.runId !== requestedRunId)
            return yield* validation(
              "sendTurn",
              "Meerkat returned a different operation identity. Delivery remains uncertain and will not be replayed.",
            );
          if (steering && receipt.runId !== activeRunId)
            return yield* validation(
              "sendTurn",
              "Meerkat returned an unexpected steering run. Its outcome is uncertain; it will not be replayed.",
            );
          yield* writeDispatch(context.cursor, receipt.runId);
          return receipt;
        }).pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              const definiteRejection =
                isProviderAdapterRequestError(error) &&
                error.cause instanceof MeerkatGatewayRpcError &&
                ["INVALID_PARAMS", "NOT_FOUND", "CONFLICT"].includes(error.cause.typedCode);
              context.uncertain = !definiteRejection;
              if (definiteRejection) {
                // A rejected steer must retain the original run's crash marker.
                yield* (
                  activeRunId
                    ? writeDispatch(context.cursor, activeRunId)
                    : clearDispatch(context.cursor)
                ).pipe(
                  Effect.tapError(() =>
                    Effect.sync(() => {
                      context.uncertain = true;
                    }),
                  ),
                );
              }
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              context.pending = false;
            }),
          ),
        );
        context.pending = false;
        context.cursor = { ...context.cursor, lastRunId: started.runId };
        if (!steering && input.modelSelection) context.modelOptions = input.modelSelection.options;
        context.session = {
          ...context.session,
          model: selection,
          resumeCursor: context.cursor,
          ...(!context.terminalRuns.has(started.runId)
            ? { status: "running", activeTurnId: TurnId.make(started.runId) }
            : {}),
        };
        if (!steering)
          followups.refreshAfterTurnAdmission({ ...context.cursor, threadId: input.threadId });
        return {
          threadId: input.threadId,
          turnId: TurnId.make(started.runId),
          resumeCursor: context.cursor,
        };
      }),
    interruptTurn: (threadId, turnId) =>
      Effect.gen(function* () {
        if (recoveries.has(threadId) || starting.has(threadId))
          return yield* validation(
            "interruptTurn",
            "Session recovery or connection is in progress.",
          );
        const context = yield* contextFor(threadId);
        const result = yield* decode(
          CancelResult,
          yield* rpc("mobs.v1.forceCancel", {
            ...paramsFor(context),
            ...(turnId ? { runId: turnId } : {}),
          }),
          "interruptTurn",
        );
        if (!result.runtimeCancelled && !result.cancellationRequested)
          return yield* validation(
            "interruptTurn",
            "Meerkat did not confirm runtime cancellation.",
          );
      }),
    respondToRequest: () =>
      Effect.fail(
        validation(
          "respondToRequest",
          "Meerkat approval requests are not supported in this prototype.",
        ),
      ),
    respondToUserInput: () =>
      Effect.fail(
        validation(
          "respondToUserInput",
          "Meerkat user-input requests are not supported in this prototype.",
        ),
      ),
    stopSession,
    withSessionRecovery: (threadId, runId, effect) =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (
          recoveries.has(threadId) ||
          starting.has(threadId) ||
          context?.pending ||
          context?.stopping ||
          (context?.session.activeTurnId && context.session.activeTurnId !== runId)
        )
          return yield* validation(
            "withSessionRecovery",
            "Another operation owns this thread. Refresh before continuing.",
          );
        recoveries.set(threadId, runId);
        return yield* effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              recoveries.delete(threadId);
            }),
          ),
        );
      }),
    reconnectSession: (input) =>
      Effect.gen(function* () {
        if (recoveries.get(input.threadId) !== input.expectedRunId)
          return yield* validation(
            "reconnectSession",
            "Reconnect requires the exact session recovery gate.",
          );
        const context = sessions.get(input.threadId);
        const cursor = yield* decode(ResumeCursor, input.resumeCursor, "reconnectSession");
        const projectPath = path.resolve(input.cwd ?? options.defaultCwd);
        const stateRoot = meerkatProjectStateRoot(path, options.stateRoot, projectPath);
        const mobId = `t3-${NodeCrypto.createHash("sha256").update(`${options.instanceId}:${input.threadId}`).digest("hex")}`;
        if (
          cursor.threadId !== input.threadId ||
          cursor.projectPath !== projectPath ||
          cursor.stateRoot !== stateRoot ||
          cursor.mobId !== mobId ||
          (context &&
            (context.cursor.mobId !== mobId ||
              context.cursor.projectPath !== projectPath ||
              context.session.runtimeMode !== input.runtimeMode))
        )
          return yield* validation(
            "reconnectSession",
            "The saved connection no longer belongs to this thread and workspace.",
          );
        const checkOperation = Effect.gen(function* () {
          const exists = yield* fs
            .exists(dispatchPath(cursor))
            .pipe(Effect.mapError(persistenceError));
          const marker = exists
            ? yield* fs
                .readFileString(dispatchPath(cursor))
                .pipe(Effect.flatMap(decodeDispatchMarker), Effect.mapError(persistenceError))
            : undefined;
          if ((marker ? marker.runId : cursor.lastRunId) !== input.expectedRunId)
            return yield* validation(
              "reconnectSession",
              "The saved operation changed. Refresh before reconnecting.",
            );
          const current = sessions.get(input.threadId);
          if (
            current !== context ||
            current?.pending ||
            current?.stopping ||
            (current?.session.activeTurnId && current.session.activeTurnId !== input.expectedRunId)
          )
            return yield* validation("reconnectSession", "A newer operation owns this thread.");
        });
        yield* checkOperation;
        const status = yield* decode(
          ExactRunStatus,
          yield* rpc("mobs.v1.runStatus", {
            projectPath,
            stateRoot,
            mobId,
            threadId: input.threadId,
            runId: input.expectedRunId,
          }),
          "reconnectSession",
        );
        if (
          status.runId !== input.expectedRunId ||
          status.threadId !== input.threadId ||
          status.mobId !== mobId ||
          !["running", "completed", "failed", "cancelled"].includes(status.status)
        )
          return yield* validation(
            "reconnectSession",
            "The original operation cannot be safely reconnected.",
          );
        yield* checkOperation;
        sessions.delete(input.threadId);
        return yield* startSession(
          { ...input, resumeCursor: { ...cursor, lastRunId: input.expectedRunId } },
          true,
        );
      }),
    releaseRecoveredSession: (threadId, runId) =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (!context) return;
        if (
          context.pending ||
          context.stopping ||
          (context.session.activeTurnId && context.session.activeTurnId !== runId)
        )
          return yield* validation(
            "releaseRecoveredSession",
            "A newer or pending operation owns this thread. Refresh before recovery.",
          );
        const markerExists = yield* fs
          .exists(dispatchPath(context.cursor))
          .pipe(Effect.mapError(persistenceError));
        const marker = markerExists
          ? yield* fs
              .readFileString(dispatchPath(context.cursor))
              .pipe(Effect.flatMap(decodeDispatchMarker), Effect.mapError(persistenceError))
          : undefined;
        if ((marker ? marker.runId : context.cursor.lastRunId) !== runId)
          return yield* validation(
            "releaseRecoveredSession",
            "The recovery receipt does not match the current operation.",
          );
        const status = yield* decode(
          ExactRunStatus,
          yield* rpc("mobs.v1.runStatus", { ...paramsFor(context), runId }),
          "releaseRecoveredSession",
        );
        if (
          status.status !== "recovered" ||
          status.runId !== runId ||
          status.threadId !== threadId ||
          status.mobId !== context.cursor.mobId
        )
          return yield* validation(
            "releaseRecoveredSession",
            "Native cleanup has not been acknowledged for this operation.",
          );
        if (
          sessions.get(threadId) !== context ||
          context.pending ||
          context.stopping ||
          (context.session.activeTurnId && context.session.activeTurnId !== runId)
        )
          return yield* validation(
            "releaseRecoveredSession",
            "The thread changed while recovery was being checked.",
          );
        sessions.delete(threadId);
      }),
    listSessions: () => Effect.sync(() => [...sessions.values()].map((context) => context.session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread: (threadId) =>
      Effect.gen(function* () {
        const context = yield* contextFor(threadId);
        const response = yield* decode(
          Timeline,
          yield* rpc("mobs.v1.consoleTimeline", {
            ...paramsFor(context),
            identity: "ingress",
            limit: 1000,
          }),
          "readThread",
        );
        return {
          threadId,
          turns: [
            {
              id: TurnId.make(context.cursor.lastRunId ?? `${threadId}:history`),
              items: response.timeline.frames,
            },
          ],
        };
      }),
    rollbackThread: () =>
      Effect.fail(validation("rollbackThread", "Meerkat conversation rollback is not supported.")),
    stopAll: () =>
      Effect.gen(function* () {
        yield* Effect.forEach([...sessions.keys()], stopSession, { concurrency: 4, discard: true });
        followups.clear();
      }),
    streamEvents: Stream.fromPubSub(events),
  };
  return adapter;
});

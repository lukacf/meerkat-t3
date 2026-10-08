import {
  ConsoleIdentityRecord,
  ConsoleFrame,
  ConsoleTimelineWindowPage,
  MeerkatAgentHistory,
  MeerkatConversationSearchMessage,
  type ModelSelection,
  type MeerkatImageRef,
  MeerkatAgentWork,
  type MeerkatProjectAgentAccessMode,
  type ProviderOptionSelections,
  type ProviderInstanceId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { extractMeerkatConsoleSkillSelections } from "@t3tools/shared/meerkatSkills";
import { meerkatProviderParams, resolveMeerkatProviderParams } from "./MeerkatModelOptions.ts";
import { nativeWorkCompletion } from "./MeerkatWork.ts";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ProviderDriverError } from "../Errors.ts";
import { decodeMeerkatModel, meerkatProjectStateRoot } from "../Layers/MeerkatAdapter.ts";
import { MeerkatGatewayRpcError, type MeerkatGatewayClient } from "./MeerkatGatewayClient.ts";

const TeamSnapshot = Schema.Struct({
  observation: Schema.Literal("loaded_runtimes"),
  loaded: Schema.Boolean,
  mobs: Schema.Array(
    Schema.Struct({
      mobId: Schema.String,
      kind: Schema.String,
      label: Schema.String,
      accessMode: Schema.optional(
        Schema.Literals(["read-only", "full-access", "approval-required"]),
      ),
      consoleStatus: Schema.Literals(["ready", "unavailable", "error"]),
      error: Schema.optional(Schema.String),
      identities: Schema.Array(ConsoleIdentityRecord),
      stoppedCrewIds: Schema.optional(Schema.Array(Schema.String)),
      ownerBoundCrewIds: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});
export type MeerkatNativeTeamSnapshot = typeof TeamSnapshot.Type;
const NativeWork = Schema.Struct({
  busy: Schema.Boolean,
  interactionId: MeerkatAgentWork.fields.interactionId,
  nativeRunId: MeerkatAgentWork.fields.nativeRunId,
  latestCompletion: MeerkatAgentWork.fields.latestCompletion,
  model: MeerkatAgentWork.fields.model,
  modelProvider: MeerkatAgentWork.fields.modelProvider,
  reasoning: MeerkatAgentWork.fields.reasoning,
  objective: MeerkatAgentWork.fields.objective,
  outcome: MeerkatAgentWork.fields.outcome,
});

const TimelineResponse = Schema.Struct({
  mobId: Schema.String,
  identity: Schema.String,
  ...MeerkatAgentHistory.fields,
});
const NativeAcceptedReceipt = Schema.Struct({
  interaction_id: Schema.String,
  identity: Schema.String,
  conversation_id: Schema.optional(Schema.String),
  session_id: Schema.optional(Schema.String),
  input_frame_id: Schema.String,
  cursor: Schema.String,
  status: Schema.Literals([
    "accepted",
    "dispatching",
    "delivered",
    "completed",
    "delivery_failed",
    "redacted",
  ]),
});
const NativeConsoleReceipt = Schema.Struct({
  ...NativeAcceptedReceipt.fields,
  completion: Schema.optional(Schema.NullOr(ConsoleFrame)),
});
const NativeRuntimeReceipt = Schema.Struct({
  kind: Schema.Literal("runtime_input"),
  identity: Schema.String,
  sessionId: Schema.String,
  inputId: Schema.String,
  requestId: Schema.String,
  idempotencyKey: Schema.String,
  handling_mode: Schema.Literal("steer"),
  status: Schema.Literal("accepted"),
});
const NativeReceipt = Schema.Union([NativeRuntimeReceipt, NativeConsoleReceipt]);
export type MeerkatNativeReceipt = typeof NativeReceipt.Type;
const ReceiptResponse = Schema.Union([
  Schema.Struct({ mobId: Schema.String, identity: Schema.String, found: Schema.Literal(false) }),
  Schema.Struct({
    mobId: Schema.String,
    identity: Schema.String,
    found: Schema.Literal(true),
    receipt: Schema.Union([NativeRuntimeReceipt, NativeAcceptedReceipt]),
    completion: Schema.optional(Schema.NullOr(ConsoleFrame)),
  }),
]);

export interface MeerkatNativeAgentTarget {
  readonly projectPath: string;
  readonly stateRoot?: string;
  readonly mobId: string;
  readonly record: ConsoleIdentityRecord;
}
export interface MeerkatDomainDefinition {
  readonly projectPath: string;
  readonly stateRoot: string;
  readonly mobId: string;
  readonly identity: string;
  readonly label: string;
  readonly role: string;
  readonly instructions: string;
  readonly model: string;
  readonly options?: ProviderOptionSelections;
  readonly accessMode: MeerkatProjectAgentAccessMode;
}
export interface MeerkatActivityQuery {
  readonly projectPath: string;
  readonly stateRoot?: string;
  readonly mobId: string;
  readonly identity: string;
  readonly record?: ConsoleIdentityRecord;
  readonly limit: number;
  readonly before?: string;
  readonly after?: string;
  readonly mode?: "recent" | "since";
  readonly transcriptBefore?: number;
  readonly transcriptRevision?: string;
}
export type MeerkatNativeSendInput = MeerkatNativeAgentTarget & {
  readonly text: string;
  readonly skillSelectionText?: string;
  readonly images?: ReadonlyArray<MeerkatImageRef>;
  readonly handlingMode: "queue" | "steer";
  readonly requestId: string;
  readonly modelSelection?: ModelSelection;
};
export interface MeerkatPreparedSend {
  readonly dispatch: () => Effect.Effect<unknown, ProviderDriverError>;
}
export interface MeerkatTeamReader {
  readonly search?: (
    input: MeerkatNativeAgentTarget & { query: string },
  ) => Effect.Effect<MeerkatConversationSearchMessage | null, ProviderDriverError>;
  readonly proposalAvailable?: () => Effect.Effect<boolean, ProviderDriverError>;
  /** Private configuration identity used in opaque references across provider reconfiguration. */
  readonly stateRoot: string;
  readonly snapshot: (
    projectPath: string,
    stateRoot?: string,
  ) => Effect.Effect<MeerkatNativeTeamSnapshot, ProviderDriverError>;
  readonly activity: (
    input: MeerkatActivityQuery,
  ) => Effect.Effect<ConsoleTimelineWindowPage, ProviderDriverError>;
  readonly history?: (
    input: MeerkatActivityQuery,
  ) => Effect.Effect<MeerkatAgentHistory, ProviderDriverError>;
  readonly work?: (
    input: MeerkatNativeAgentTarget,
  ) => Effect.Effect<Omit<MeerkatAgentWork, "observedAt">, ProviderDriverError>;
  readonly connectDomain?: (
    input: MeerkatDomainDefinition,
  ) => Effect.Effect<unknown, ProviderDriverError>;
  readonly disconnectDomain?: (
    input: MeerkatDomainDefinition,
  ) => Effect.Effect<unknown, ProviderDriverError>;
  readonly send?: (input: MeerkatNativeSendInput) => Effect.Effect<unknown, ProviderDriverError>;
  /** Read-only preparation must succeed before claiming a new durable delivery. */
  readonly prepareSend?: (
    input: MeerkatNativeSendInput,
  ) => Effect.Effect<MeerkatPreparedSend, ProviderDriverError>;
  /** Exact persisted acceptance lookup. This never admits a runtime or replays delivery. */
  readonly receipt?: (
    input: MeerkatNativeAgentTarget & { requestId: string },
  ) => Effect.Effect<MeerkatNativeReceipt | undefined, ProviderDriverError>;
  readonly resume?: (
    input: MeerkatNativeAgentTarget,
  ) => Effect.Effect<unknown, ProviderDriverError>;
  readonly busy?: (input: MeerkatNativeAgentTarget) => Effect.Effect<boolean, ProviderDriverError>;
  readonly stop?: (
    input: MeerkatNativeAgentTarget & { nativeRunId: string },
  ) => Effect.Effect<unknown, ProviderDriverError>;
  readonly stopCrew?: (
    input: MeerkatNativeAgentTarget,
  ) => Effect.Effect<unknown, ProviderDriverError>;
  readonly topology?: (
    params: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, ProviderDriverError>;
  readonly wire?: (
    params: Readonly<Record<string, unknown>>,
    connected: boolean,
  ) => Effect.Effect<unknown, ProviderDriverError>;
}

/** Uses the owning driver's existing gateway; reading never prepares or restores a workspace. */
export function makeMeerkatTeamReader(options: {
  readonly client: MeerkatGatewayClient;
  readonly path: Path.Path;
  readonly stateRoot: string;
  readonly instanceId: ProviderInstanceId;
  readonly prepareWorkspace?: (projectPath: string, stateRoot: string) => Promise<void>;
}): MeerkatTeamReader {
  const error = (cause: unknown, detail?: string) =>
    new ProviderDriverError({
      driver: ProviderDriverKind.make("meerkat"),
      instanceId: options.instanceId,
      detail: detail ?? (cause instanceof Error ? cause.message : String(cause)),
      cause,
    });
  const params = (projectPath: string, stateRoot?: string) => ({
    projectPath,
    stateRoot: stateRoot ?? meerkatProjectStateRoot(options.path, options.stateRoot, projectPath),
  });
  const request = (method: string, input: Readonly<Record<string, unknown>>, timeoutMs = 60_000) =>
    Effect.tryPromise({
      try: (signal) => options.client.request(method, input, { signal, timeoutMs }),
      catch: (cause) => {
        if (
          (method === "mobs.v1.consoleResume" || method === "mobs.v1.consoleStopCrew") &&
          cause instanceof MeerkatGatewayRpcError &&
          typeof cause.details === "object" &&
          cause.details !== null &&
          "error" in cause.details &&
          typeof cause.details.error === "string" &&
          !cause.message.includes(cause.details.error)
        ) {
          return error(cause, `${cause.message}: ${cause.details.error}`);
        }
        return error(cause);
      },
    });
  const targetParams = (input: MeerkatNativeAgentTarget) => ({
    ...params(input.projectPath, input.stateRoot),
    mobId: input.mobId,
    expected: {
      identity: input.record.identity,
      runtimeKey: input.record.runtime_key,
      runtimeMemberId: input.record.runtime_member_id,
      sessionId: input.record.session_id ?? null,
      sourceMobId: input.record.labels.source_mob_id ?? null,
    },
  });
  const prepareSend = Effect.fn("MeerkatTeamReader.prepareSend")(function* (
    input: MeerkatNativeSendInput,
  ) {
    const { skillReferences } = yield* Effect.try({
      try: () =>
        extractMeerkatConsoleSkillSelections(
          input.skillSelectionText ?? input.text,
          input.handlingMode,
        ),
      catch: error,
    });
    const model =
      input.handlingMode === "queue" && input.modelSelection
        ? yield* Effect.try({
            try: () => decodeMeerkatModel(input.modelSelection!.model),
            catch: error,
          })
        : undefined;
    const providerParams = model
      ? yield* Effect.tryPromise({
          try: (signal) =>
            resolveMeerkatProviderParams({
              client: options.client,
              projectPath: input.projectPath,
              configStateRoot: meerkatProjectStateRoot(
                options.path,
                options.stateRoot,
                input.projectPath,
              ),
              ...model,
              options: input.modelSelection?.options,
              signal,
            }),
          catch: error,
        })
      : undefined;
    const nativeParams = {
      ...targetParams(input),
      content: input.images?.length
        ? [...(input.text.trim() ? [{ type: "text", text: input.text }] : []), ...input.images]
        : input.text,
      handlingMode: input.handlingMode,
      idempotencyKey: input.requestId,
      ...(skillReferences.length ? { skillReferences } : {}),
      ...(model ? { ...model, providerParams: providerParams ?? null } : {}),
    };
    return { dispatch: () => request("mobs.v1.consoleSend", nativeParams) };
  });
  const history = (method: string) =>
    Effect.fn("MeerkatTeamReader.history")(function* (input: MeerkatActivityQuery) {
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          options.client.request(
            method,
            {
              ...params(input.projectPath, input.stateRoot),
              mobId: input.mobId,
              identity: input.identity,
              ...(input.record
                ? { expected: targetParams({ ...input, record: input.record }).expected }
                : {}),
              mode: input.mode ?? "recent",
              limit: input.limit,
              ...(input.before ? { before: input.before } : {}),
              ...(input.after ? { after: input.after } : {}),
              ...(input.transcriptBefore !== undefined
                ? { transcriptBefore: input.transcriptBefore }
                : {}),
              ...(input.transcriptRevision ? { transcriptRevision: input.transcriptRevision } : {}),
            },
            { signal, timeoutMs: 15_000 },
          ),
        catch: error,
      }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(TimelineResponse)), Effect.mapError(error));
      if (response.mobId !== input.mobId || response.identity !== input.identity) {
        return yield* error(
          new Error("Meerkat returned activity for a different mob or identity."),
        );
      }
      if (input.transcriptRevision !== undefined && !response.transcript) {
        return yield* error(
          new Error("The saved transcript is unavailable. Refresh the conversation first."),
        );
      }
      if (
        response.transcript &&
        (response.transcript.sessionId !== input.record?.session_id ||
          (input.transcriptRevision !== undefined &&
            response.transcript.storeRevision !== input.transcriptRevision))
      ) {
        return yield* error(
          new Error("Meerkat returned a different saved session or transcript revision."),
        );
      }
      return {
        timeline: response.timeline,
        ...(response.transcript ? { transcript: response.transcript } : {}),
        ...(response.historyStatus ? { historyStatus: response.historyStatus } : {}),
      };
    });
  const timeline = (method: string) => (input: MeerkatActivityQuery) =>
    history(method)(input).pipe(Effect.map((response) => response.timeline));
  return {
    stateRoot: options.stateRoot,
    search: Effect.fn("MeerkatTeamReader.search")(function* (input) {
      const response = yield* request(
        "mobs.v1.consoleSearch",
        { ...targetParams(input), query: input.query },
        15_000,
      ).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({ match: Schema.NullOr(MeerkatConversationSearchMessage) }),
          ),
        ),
        Effect.mapError(error),
      );
      if (response.match && response.match.sessionId !== input.record.session_id)
        return yield* error(
          new Error("Meerkat returned a search match for a different saved session."),
        );
      return response.match;
    }),
    busy: (input) =>
      request("mobs.v1.consoleStatus", targetParams(input)).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ busy: Schema.Boolean }))),
        Effect.map((value) => value.busy),
        Effect.mapError(error),
      ),
    work: Effect.fn("MeerkatTeamReader.work")(function* (input) {
      const status = yield* request("mobs.v1.consoleStatus", targetParams(input), 15_000).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(NativeWork)),
        Effect.mapError(error),
      );
      if (
        status.latestCompletion &&
        "kind" in status.latestCompletion &&
        status.latestCompletion.sessionId !== input.record.session_id
      ) {
        return yield* error(new Error("Native completion belongs to a different session."));
      }
      const page = status.latestCompletion
        ? undefined
        : yield* timeline("mobs.v1.consoleTimeline")({
            ...input,
            identity: input.record.identity,
            limit: 100,
          }).pipe(Effect.catch(() => Effect.succeed(undefined)));
      const latestCompletion =
        status.latestCompletion ??
        (page ? nativeWorkCompletion(page.frames, input.record) : undefined);
      return {
        status: status.busy ? ("running" as const) : ("idle" as const),
        ...(latestCompletion ? { latestCompletion } : {}),
        ...(status.interactionId ? { interactionId: status.interactionId } : {}),
        ...(status.busy && status.nativeRunId ? { nativeRunId: status.nativeRunId } : {}),
        ...(status.model ? { model: status.model } : {}),
        ...(status.modelProvider ? { modelProvider: status.modelProvider } : {}),
        ...(status.reasoning ? { reasoning: status.reasoning } : {}),
        ...(status.objective ? { objective: status.objective } : {}),
        ...(status.outcome ? { outcome: status.outcome } : {}),
      };
    }),
    proposalAvailable: () =>
      request("system.v1.capabilities", {}).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({
              capabilities: Schema.Struct({
                projectAgentProposalTool: Schema.optional(Schema.Boolean),
              }),
            }),
          ),
        ),
        Effect.map((value) => value.capabilities.projectAgentProposalTool === true),
        Effect.mapError(error),
      ),
    snapshot: (projectPath, stateRoot) =>
      Effect.tryPromise({
        try: (signal) =>
          options.client.request("mobs.v1.teamSnapshot", params(projectPath, stateRoot), {
            signal,
            timeoutMs: 15_000,
          }),
        catch: error,
      }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(TeamSnapshot)), Effect.mapError(error)),
    connectDomain: Effect.fn("MeerkatTeamReader.connectDomain")(function* (input) {
      const model = yield* Effect.try({ try: () => decodeMeerkatModel(input.model), catch: error });
      // Native creation validates fresh sessions. Resume retains the durable model
      // and options, even if the original creation model has left the catalog.
      const providerParams = yield* Effect.try({
        try: () => meerkatProviderParams(input.options),
        catch: error,
      });
      const configStateRoot = meerkatProjectStateRoot(
        options.path,
        options.stateRoot,
        input.projectPath,
      );
      if (options.prepareWorkspace)
        yield* Effect.tryPromise({
          try: () => options.prepareWorkspace!(input.projectPath, configStateRoot),
          catch: error,
        });
      return yield* request("mobs.v1.createDomainMob", {
        ...params(input.projectPath, input.stateRoot),
        configStateRoot,
        executionPath: input.projectPath,
        executionMode: "local",
        mobId: input.mobId,
        agentIdentity: input.identity,
        label: input.label,
        role: input.role,
        instructions: input.instructions,
        ...model,
        providerParams: providerParams ?? null,
        accessMode: input.accessMode,
        includeNativeWorkers: true,
      });
    }),
    disconnectDomain: (input) =>
      request("mobs.v1.destroy", {
        ...params(input.projectPath, input.stateRoot),
        mobId: input.mobId,
      }),
    prepareSend,
    send: (input) => prepareSend(input).pipe(Effect.flatMap((prepared) => prepared.dispatch())),
    receipt: Effect.fn("MeerkatTeamReader.receipt")(function* (input) {
      if (!input.record.session_id)
        return yield* error(new Error("Receipt lookup needs its original native session."));
      const response = yield* request(
        "mobs.v1.consoleReceipt",
        {
          ...targetParams(input),
          idempotencyKey: input.requestId,
        },
        15_000,
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ReceiptResponse)), Effect.mapError(error));
      if (response.mobId !== input.mobId || response.identity !== input.record.identity)
        return yield* error(new Error("Meerkat returned a receipt for a different native target."));
      if (!response.found) return undefined;
      if ("kind" in response.receipt) {
        if (
          response.receipt.identity !== input.record.identity ||
          response.receipt.sessionId !== input.record.session_id ||
          response.receipt.requestId !== input.requestId ||
          !response.receipt.idempotencyKey.startsWith("meerkat-app:steer:v1:") ||
          response.completion != null
        )
          return yield* error(
            new Error(
              "Meerkat returned a steering receipt for a different native session or request.",
            ),
          );
        return response.receipt;
      }
      if (
        response.receipt.identity !== input.record.identity ||
        response.receipt.session_id !== input.record.session_id
      )
        return yield* error(
          new Error("Meerkat returned a receipt for a different native session."),
        );
      const completion = response.completion;
      if (
        completion &&
        (completion.identity !== input.record.identity ||
          completion.runtime_key !== input.record.runtime_key ||
          completion.interaction_id !== response.receipt.interaction_id ||
          (completion.session_id !== undefined &&
            completion.session_id !== input.record.session_id) ||
          !["interaction_complete", "interaction_failed"].includes(completion.kind) ||
          completion.source.kind === "session_history" ||
          !nativeWorkCompletion([completion], input.record))
      )
        return yield* error(
          new Error("Meerkat returned a completion for a different native interaction."),
        );
      return { ...response.receipt, ...(completion ? { completion } : {}) };
    }),
    resume: (input) => request("mobs.v1.consoleResume", targetParams(input)),
    stop: Effect.fn("MeerkatTeamReader.stop")(function* (input) {
      const response = yield* request("mobs.v1.consoleStop", {
        ...targetParams(input),
        nativeRunId: input.nativeRunId,
      }).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({
              mobId: Schema.String,
              identity: Schema.String,
              nativeRunId: Schema.String,
              accepted: Schema.Boolean,
              receipt: Schema.Unknown,
            }),
          ),
        ),
        Effect.mapError(error),
      );
      if (
        response.mobId !== input.mobId ||
        response.identity !== input.record.identity ||
        response.nativeRunId !== input.nativeRunId
      )
        return yield* error(new Error("Meerkat returned a Stop receipt for different work."));
      if (!response.accepted)
        return yield* error(
          new Error(
            "The selected native run is no longer stoppable. Refresh before stopping another turn.",
          ),
        );
      return response;
    }),
    stopCrew: (input) => request("mobs.v1.consoleStopCrew", targetParams(input)),
    topology: (input) => request("mobs.v1.topologyPair", input, 15_000),
    wire: (input, connected) =>
      request(connected ? "mobs.v1.peerLocal" : "mobs.v1.unpeerLocal", input),
    activity: timeline("mobs.v1.consoleTimeline"),
    history: history("mobs.v1.consoleHistory"),
  };
}

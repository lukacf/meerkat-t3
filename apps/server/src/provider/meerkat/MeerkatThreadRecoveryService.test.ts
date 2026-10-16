import * as NodeCrypto from "node:crypto";
import * as PlatformCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationSession,
  type OrchestrationCommand,
  type ProviderSession,
  type OrchestrationThreadShell,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { makeMeerkatAdapter, meerkatProjectStateRoot } from "../Layers/MeerkatAdapter.ts";
import { MeerkatGatewayTransportError, type MeerkatGatewayClient } from "./MeerkatGatewayClient.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../Services/ProviderSessionDirectory.ts";
import { makeMeerkatThreadRecoveryService } from "./MeerkatThreadRecoveryService.ts";
import { decideOrchestrationCommand } from "../../orchestration/decider.ts";
import { projectEvent } from "../../orchestration/projector.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("thread");
const instanceId = ProviderInstanceId.make("provider");
const input = { projectId, threadId, instanceId };
const layer = Layer.mergeAll(SqlitePersistenceMemory, Path.layer);
const harness = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Project','/project','[]','now','now')`;
  yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,worktree_path,created_at,updated_at) VALUES (${threadId},${projectId},'Thread','{}','/worktree','now','now')`;
  const cursor = {
    version: 1,
    threadId,
    mobId: `t3-${NodeCrypto.createHash("sha256").update(`${instanceId}:${threadId}`).digest("hex")}`,
    projectPath: "/worktree",
    stateRoot: meerkatProjectStateRoot(path, "/provider", "/worktree"),
    lastRunId: "previous-run",
  };
  let binding: ProviderRuntimeBinding | undefined = {
    threadId,
    provider: ProviderDriverKind.make("meerkat"),
    providerInstanceId: instanceId,
    resumeCursor: cursor,
    status: "error",
  };
  let projected: OrchestrationSession = {
    threadId,
    providerName: "meerkat",
    providerInstanceId: instanceId,
    status: "error",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: "Disconnected",
    updatedAt: "2026-09-28T12:00:00.000Z",
  };
  let projectedTurnState: "running" | "error" | "interrupted" = "error";
  let strictModel: OrchestrationReadModel | null = null;
  let duringReconnect: () => Effect.Effect<void> = () => Effect.void;
  const writes: ProviderRuntimeBinding[] = [];
  const commands: OrchestrationCommand[] = [];
  let onRelease = () => {};
  let onReconnect = () => {};
  let releaseFailed = false;
  let adapterReleased = false;
  let adapterGated = false;
  const releases: string[] = [];
  const reconnects: unknown[] = [];
  let marker: string | null = encodeJson({ version: 1, runId: "lost-run" });
  let native: Record<string, unknown> = {
    runId: "lost-run",
    threadId,
    mobId: cursor.mobId,
    status: "unknown",
    canRecover: true,
  };
  let receipt: unknown = {
    runId: "lost-run",
    recovered: true,
    cleanupCompleted: true,
    outcome: "unresolved",
  };
  let enabled = true;
  let nativeError: Error | null = null;
  let onRecover = () => {};
  let actualAdapter: ProviderAdapterShape<ProviderAdapterError> | undefined;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const paths: string[] = [];
  const instance: ProviderInstance = {
    instanceId,
    driverKind: ProviderDriverKind.make("meerkat"),
    continuationIdentity: {
      driverKind: ProviderDriverKind.make("meerkat"),
      continuationKey: instanceId,
    },
    displayName: "Native",
    get enabled() {
      return enabled;
    },
    meerkatTeam: {
      stateRoot: "/provider",
      snapshot: () => Effect.die("No roster admission"),
      activity: () => Effect.die("No transcript reads"),
    },
    meerkatControls: {
      request: async (method, params) => {
        calls.push({ method, params });
        if (nativeError) throw nativeError;
        if (method === "mobs.v1.runStatus") return native;
        if (method === "mobs.v1.recoverThread") {
          onRecover();
          return receipt;
        }
        throw Error(`Unexpected native method ${method}`);
      },
    },
    get adapter() {
      return (
        actualAdapter ??
        ({
          withSessionRecovery: <A, E, R>(
            _threadId: ThreadId,
            _runId: string,
            effect: Effect.Effect<A, E, R>,
          ) =>
            Effect.gen(function* () {
              adapterGated = true;
              return yield* effect.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    adapterGated = false;
                  }),
                ),
              );
            }),
          releaseRecoveredSession: (_threadId: ThreadId, runId: string) =>
            Effect.gen(function* () {
              expect(adapterGated).toBe(true);
              releases.push(runId);
              onRelease();
              if (releaseFailed)
                return yield* new ProviderAdapterValidationError({
                  provider: "meerkat",
                  operation: "releaseRecoveredSession",
                  issue: "Newer operation",
                });
              adapterReleased = true;
            }),
          reconnectSession: (params: unknown) =>
            Effect.gen(function* (): Effect.fn.Return<ProviderSession> {
              expect(adapterGated).toBe(true);
              reconnects.push(params);
              onReconnect();
              yield* duringReconnect();
              return {
                provider: ProviderDriverKind.make("meerkat"),
                providerInstanceId: instanceId,
                threadId,
                status: native.status === "running" ? "running" : "ready",
                runtimeMode: "full-access",
                resumeCursor: { ...cursor, lastRunId: "lost-run" },
                ...(native.status === "running" ? { activeTurnId: TurnId.make("lost-run") } : {}),
                createdAt: "2026-09-28T12:00:00.000Z",
                updatedAt: "2026-09-28T12:01:00.000Z",
              };
            }),
        } as unknown as ProviderAdapterShape<ProviderAdapterValidationError>)
      );
    },
    get snapshot(): never {
      throw Error("No provider catalog reads");
    },
    get textGeneration(): never {
      throw Error("No model calls");
    },
  };
  let registryInstance = instance;
  const registry = Layer.mock(ProviderInstanceRegistry)({
    getInstance: (id) => Effect.sync(() => (id === instanceId ? registryInstance : undefined)),
  });
  const directory = Layer.mock(ProviderSessionDirectory)({
    getBinding: () => Effect.sync(() => Option.fromUndefinedOr(binding)),
    upsert: (next) =>
      Effect.sync(() => {
        writes.push(next);
        binding = {
          ...binding,
          ...next,
          runtimePayload: {
            ...(typeof binding?.runtimePayload === "object" ? binding.runtimePayload : {}),
            ...(typeof next.runtimePayload === "object" ? next.runtimePayload : {}),
          },
        };
      }),
  });
  const projection = Layer.mock(ProjectionSnapshotQuery)({
    getThreadShellById: () =>
      Effect.sync(() =>
        Option.some(
          (strictModel?.threads[0] ?? {
            id: threadId,
            projectId,
            title: "Thread",
            updatedAt: "2026-09-28T12:00:00.000Z",
            runtimeMode: "full-access",
            modelSelection: {
              instanceId,
              model: "anthropic:claude-sonnet",
              options: { effort: "high" },
            },
            session: projected,
            latestTurn: { turnId: TurnId.make("lost-run"), state: projectedTurnState },
          }) as unknown as OrchestrationThreadShell,
        ),
      ),
  });
  const applyCommand = (command: OrchestrationCommand) =>
    Effect.gen(function* () {
      commands.push(command);
      if (strictModel) {
        let nextModel = strictModel;
        const decided = yield* decideOrchestrationCommand({ command, readModel: nextModel }).pipe(
          Effect.provide(PlatformCrypto.layer),
          Effect.orDie,
        );
        for (const event of Array.isArray(decided) ? decided : [decided]) {
          nextModel = yield* projectEvent(nextModel, {
            ...event,
            sequence: nextModel.snapshotSequence + 1,
          }).pipe(Effect.orDie);
        }
        strictModel = nextModel;
        projected = nextModel.threads[0]!.session!;
      } else if (command.type === "thread.session.set") projected = command.session;
      return { sequence: commands.length };
    });
  const engine = Layer.mock(OrchestrationEngineService)({
    dispatch: applyCommand,
  });
  const temporaryFiles = new Map<string, string>();
  const filesystem = FileSystem.layerNoop({
    exists: (p) =>
      Effect.sync(() => {
        paths.push(p);
        return temporaryFiles.has(p) || marker !== null;
      }),
    readFileString: (p) => Effect.sync(() => temporaryFiles.get(p) ?? marker ?? ""),
    makeDirectory: () => Effect.void,
    writeFileString: (p, value) =>
      Effect.sync(() => {
        temporaryFiles.set(p, value);
      }),
    rename: (from) =>
      Effect.sync(() => {
        marker = temporaryFiles.get(from) ?? null;
        temporaryFiles.delete(from);
      }),
    remove: (p) =>
      Effect.sync(() => {
        temporaryFiles.delete(p);
        marker = null;
      }),
    open: () =>
      Effect.succeed({
        [FileSystem.FileTypeId]: FileSystem.FileTypeId,
        sync: Effect.void,
        stat: Effect.die("unused stat"),
        seek: () => Effect.succeed(0n),
        read: () => Effect.succeed(0),
        readAlloc: () => Effect.succeedNone,
        truncate: () => Effect.void,
        write: (buffer) => Effect.succeed(buffer.length),
        writeAll: () => Effect.void,
      } satisfies FileSystem.File),
  });
  const service = yield* makeMeerkatThreadRecoveryService().pipe(
    Effect.provide(Layer.mergeAll(registry, directory, filesystem, projection, engine)),
  );
  return {
    service,
    filesystem,
    nativeRequest: instance.meerkatControls!.request,
    useAdapter: (adapter: ProviderAdapterShape<ProviderAdapterError>) => {
      actualAdapter = adapter;
    },
    replaceInstance: () => {
      registryInstance = Object.create(instance) as ProviderInstance;
    },
    sql,
    cursor,
    calls,
    paths,
    writes,
    commands,
    releases,
    reconnects,
    isReleased: () => adapterReleased,
    isGated: () => adapterGated,
    projected: () => projected,
    setProjected: (session: OrchestrationSession) => {
      projected = session;
    },
    setProjectedTurnState: (state: typeof projectedTurnState) => {
      projectedTurnState = state;
    },
    useStrictProjection: () => {
      const timestamp = projected.updatedAt;
      strictModel = {
        snapshotSequence: 0,
        projects: [],
        updatedAt: timestamp,
        threads: [
          {
            id: threadId,
            projectId,
            title: "Thread",
            modelSelection: { instanceId, model: "anthropic:claude-sonnet" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: "/worktree",
            pullRequests: [],
            latestTurn: {
              turnId: TurnId.make("lost-run"),
              state: projectedTurnState,
              requestedAt: timestamp,
              startedAt: timestamp,
              completedAt: projectedTurnState === "running" ? null : timestamp,
              assistantMessageId: null,
            },
            createdAt: timestamp,
            updatedAt: timestamp,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            deletedAt: null,
            messages: [],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
            session: projected,
          },
        ],
      };
    },
    latestTurn: () => strictModel?.threads[0]?.latestTurn,
    emitReadyDuringReconnect: (expectedTurnState: "error" | "interrupted") => {
      duringReconnect = () =>
        Effect.gen(function* () {
          expect(strictModel?.threads[0]?.latestTurn?.state).toBe(expectedTurnState);
          expect(binding?.status).toBe("stopped");
          yield* applyCommand({
            type: "thread.session.set",
            commandId: CommandId.make("adapter-ready-during-reattach"),
            threadId,
            session: { ...projected, status: "ready", activeTurnId: null, lastError: null },
            createdAt: projected.updatedAt,
          });
        });
    },
    onRelease: (fn: () => void) => {
      onRelease = fn;
    },
    onReconnect: (fn: () => void) => {
      onReconnect = fn;
    },
    failRelease: () => {
      releaseFailed = true;
    },
    setBinding: (value: typeof binding) => {
      binding = value;
    },
    getBinding: () => binding!,
    setMarker: (value: string | null) => {
      marker = value;
    },
    setNative: (value: Record<string, unknown>) => {
      native = { ...native, ...value };
    },
    setReceipt: (value: unknown) => {
      receipt = value;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setError: (value: Error) => {
      nativeError = value;
    },
    onRecover: (value: () => void) => {
      onRecover = value;
    },
  };
});

describe("Meerkat thread recovery", () => {
  it.effect(
    "a replacement adapter with the same provider id cannot inherit an in-flight recovery",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        h.onRelease(h.replaceInstance);
        expect(
          (yield* h.service.recover({ ...input, runId: "lost-run" }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(h.writes).toHaveLength(0);
        expect(h.commands).toHaveLength(0);
      }).pipe(Effect.provide(layer)),
  );
  it.effect("reconnect refuses a replacement adapter registered during native reattachment", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setNative({ status: "running" });
      h.onReconnect(h.replaceInstance);
      expect(
        (yield* h.service.reconnect({ ...input, runId: "lost-run" }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(h.writes).toHaveLength(0);
      expect(h.commands).toHaveLength(0);
    }).pipe(Effect.provide(layer)),
  );
  it.effect(
    "cleanup resets the real adapter and saved binding before one distinct fresh send",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        h.setMarker(null);
        h.onRecover(() => h.setNative({ status: "recovered", canRecover: false }));
        const nativeCalls: Array<{ method: string; params: Readonly<Record<string, unknown>> }> =
          [];
        let loseReply = true;
        const client: MeerkatGatewayClient = {
          pid: undefined,
          request: async (method, params = {}) => {
            nativeCalls.push({ method, params });
            if (method === "models.v1.catalog")
              return {
                catalog: { providers: [{ provider: "openai", models: [{ id: "gpt-test" }] }] },
              };
            if (method === "mobs.v1.runStatus") return h.nativeRequest(method, { ...params });
            if (method === "mobs.v1.turnStart") {
              if (loseReply)
                throw new MeerkatGatewayTransportError("disconnected", "Reply lost", true);
              return { runId: params.runId };
            }
            if (method === "mobs.v1.createThreadMob") return { accessMode: params.accessMode };
            if (method === "mobs.v1.threadFollowups")
              return { status: "unavailable", frames: [], exhausted: true };
            if (method === "mobs.v1.threadDeliveries") return { events: [] };
            return {};
          },
          subscribe: () => () => {},
          onClose: () => () => {},
          close: async () => {},
        };
        let serial = 0;
        const adapter = yield* makeMeerkatAdapter({
          client,
          instanceId,
          stateRoot: "/provider",
          defaultCwd: "/worktree",
          enabled: true,
          createRunId: () => (++serial === 1 ? "lost-run" : "fresh-run"),
        }).pipe(Effect.provide(h.filesystem));
        h.useAdapter(adapter);
        const start = {
          threadId,
          cwd: "/worktree",
          runtimeMode: "full-access" as const,
          modelSelection: { instanceId, model: "openai:gpt-test" },
        };
        const session = yield* adapter.startSession(start);
        h.setBinding({
          ...h.getBinding(),
          resumeCursor: session.resumeCursor,
          runtimeMode: start.runtimeMode,
          runtimePayload: { modelSelection: start.modelSelection, activeTurnId: null },
        });
        expect(
          (yield* adapter.sendTurn({ threadId, input: "do once" }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* adapter.sendTurn({ threadId, input: "must remain blocked" }).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        expect(nativeCalls.filter((call) => call.method === "mobs.v1.turnStart")).toHaveLength(1);
        yield* h.service.recover({ ...input, runId: "lost-run" });
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        expect(h.getBinding()).toMatchObject({
          status: "stopped",
          runtimePayload: { activeTurnId: null, modelSelection: start.modelSelection },
        });
        expect(h.projected()).toMatchObject({
          status: "stopped",
          activeTurnId: null,
          lastError: null,
        });
        // A lost service reply is reconciled through the same exact cleanup receipt.
        yield* h.service.recover({ ...input, runId: "lost-run" });
        expect(nativeCalls.filter((call) => call.method === "mobs.v1.turnStart")).toHaveLength(1);
        yield* adapter.startSession({ ...start, resumeCursor: h.getBinding().resumeCursor });
        loseReply = false;
        expect((yield* adapter.sendTurn({ threadId, input: "fresh input" })).turnId).toBe(
          "fresh-run",
        );
        expect(
          nativeCalls
            .filter((call) => call.method === "mobs.v1.turnStart")
            .map((call) => call.params.runId),
        ).toEqual(["lost-run", "fresh-run"]);
        expect(nativeCalls.some((call) => call.method === "mobs.v1.destroy")).toBe(false);
        expect(
          (yield* h.service.recover({ ...input, runId: "lost-run" }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect((yield* adapter.listSessions())[0]?.activeTurnId).toBe("fresh-run");
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );
  it.effect("uses the persisted worktree and marker operation instead of the older cursor", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      expect(yield* h.service.status(input)).toMatchObject({
        status: "interrupted",
        runId: "lost-run",
        canRecover: true,
      });
      expect(h.calls).toEqual([
        {
          method: "mobs.v1.runStatus",
          params: {
            projectPath: "/worktree",
            stateRoot: h.cursor.stateRoot,
            threadId,
            mobId: h.cursor.mobId,
            runId: "lost-run",
          },
        },
      ]);
      expect(h.paths).toEqual([`${h.cursor.stateRoot}/t3-dispatch/${h.cursor.mobId}.json`]);
    }).pipe(Effect.provide(layer)),
  );
  it.effect(
    "requires a fresh exact operation before explicit cleanup and returns its native receipt",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const receipt = yield* h.service.recover({ ...input, runId: "lost-run" });
        expect(receipt).toEqual({
          runId: "lost-run",
          recovered: true,
          cleanupCompleted: true,
          outcome: "unresolved",
        });
        expect(h.calls.map((c) => c.method)).toEqual([
          "mobs.v1.runStatus",
          "mobs.v1.recoverThread",
        ]);
        expect(h.calls[1]!.params).toEqual(h.calls[0]!.params);
      }).pipe(Effect.provide(layer)),
  );
  it.effect("does not stop a live operation or use cleanup as an implicit replay", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setNative({ status: "running" });
      expect(yield* h.service.status(input)).toMatchObject({
        status: "running",
        canRecover: false,
      });
      expect(
        (yield* h.service.recover({ ...input, runId: "lost-run" }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(h.calls.every((c) => c.method === "mobs.v1.runStatus")).toBe(true);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("withholds cleanup when native cannot prove tool containment after a crash", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setNative({ canRecover: false, recoveryReason: "Tool cleanup cannot be proven." });
      expect(yield* h.service.status(input)).toMatchObject({
        status: "unavailable",
        canRecover: false,
        message: "Tool cleanup cannot be proven.",
      });
      expect(
        (yield* h.service.recover({ ...input, runId: "lost-run" }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(h.calls.some((c) => c.method === "mobs.v1.recoverThread")).toBe(false);
    }).pipe(Effect.provide(layer)),
  );
  it.effect(
    "rejects foreign project, provider, cursor and native identity without clearing anything",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        expect(
          (yield* h.service
            .status({ ...input, projectId: ProjectId.make("foreign") })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        const binding = h.getBinding();
        h.setBinding({ ...binding, providerInstanceId: ProviderInstanceId.make("replacement") });
        expect((yield* h.service.status(input).pipe(Effect.result))._tag).toBe("Failure");
        h.setBinding({ ...binding, resumeCursor: { ...h.cursor, stateRoot: "/foreign" } });
        expect((yield* h.service.status(input).pipe(Effect.result))._tag).toBe("Failure");
        expect(h.calls).toHaveLength(0);
        h.setBinding(binding);
        h.setNative({ threadId: "other-thread" });
        expect((yield* h.service.status(input).pipe(Effect.result))._tag).toBe("Failure");
        expect(h.calls).toHaveLength(1);
      }).pipe(Effect.provide(layer)),
  );
  it.effect("refuses a stale clicked operation and malformed or legacy dispatch markers", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      expect(
        (yield* h.service.recover({ ...input, runId: "older-run" }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      h.setMarker(encodeJson({ version: 1 }));
      expect(yield* h.service.status(input)).toMatchObject({
        status: "unavailable",
        runId: null,
        canRecover: false,
      });
      h.setMarker("broken");
      expect((yield* h.service.status(input).pipe(Effect.result))._tag).toBe("Failure");
      expect(h.calls.map((c) => c.method)).toEqual(["mobs.v1.runStatus"]);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("reconciles lost cleanup replies using the same recovered operation", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setNative({ status: "recovered" });
      expect(yield* h.service.status(input)).toMatchObject({
        status: "recovered",
        canRecover: false,
      });
      expect(yield* h.service.recover({ ...input, runId: "lost-run" })).toMatchObject({
        cleanupCompleted: true,
        outcome: "unresolved",
      });
    }).pipe(Effect.provide(layer)),
  );
  it.effect(
    "does not confirm cleanup on a wrong receipt, connection failure or concurrent replacement",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        h.setReceipt({
          runId: "other-run",
          recovered: true,
          cleanupCompleted: true,
          outcome: "unresolved",
        });
        expect(
          (yield* h.service.recover({ ...input, runId: "lost-run" }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        h.setReceipt({
          runId: "lost-run",
          recovered: true,
          cleanupCompleted: true,
          outcome: "unresolved",
        });
        h.onRecover(() => h.setMarker(encodeJson({ version: 1, runId: "newer-run" })));
        expect(
          (yield* h.service.recover({ ...input, runId: "lost-run" }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        h.setError(Error("Gateway disconnected"));
        expect((yield* h.service.status(input).pipe(Effect.result))._tag).toBe("Failure");
      }).pipe(Effect.provide(layer)),
  );
  it.effect("preserves terminal and unstarted states without offering destructive cleanup", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setNative({ status: "completed" });
      expect(yield* h.service.status(input)).toMatchObject({
        status: "settled",
        canRecover: false,
      });
      h.setMarker(null);
      h.setBinding({ ...h.getBinding(), resumeCursor: { ...h.cursor, lastRunId: undefined } });
      expect(yield* h.service.status(input)).toMatchObject({ status: "none", canRecover: false });
      h.setBinding(undefined);
      expect(yield* h.service.status(input)).toMatchObject({ status: "none", canRecover: false });
    }).pipe(Effect.provide(layer)),
  );
});
it.effect(
  "acknowledged recovery releases the exact adapter and preserves saved configuration while clearing active work",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setBinding({
        ...h.getBinding(),
        runtimeMode: "full-access",
        runtimePayload: {
          modelSelection: { model: "saved-model", options: { effort: "high" } },
          activeTurnId: "lost-run",
          cwd: "/worktree",
        },
      });
      yield* h.service.recover({ ...input, runId: "lost-run" });
      expect(h.releases).toEqual(["lost-run"]);
      expect(h.isReleased()).toBe(true);
      expect(h.isGated()).toBe(false);
      expect(h.getBinding()).toMatchObject({
        status: "stopped",
        resumeCursor: h.cursor,
        runtimeMode: "full-access",
        runtimePayload: {
          modelSelection: { model: "saved-model", options: { effort: "high" } },
          activeTurnId: null,
          cwd: "/worktree",
        },
      });
      expect(h.projected()).toMatchObject({
        status: "stopped",
        activeTurnId: null,
        lastError: null,
        providerInstanceId: instanceId,
      });
      expect(h.commands[0]).toMatchObject({
        type: "thread.session.set",
        expectedCurrent: { status: "error", providerInstanceId: instanceId },
        expectedThreadUpdatedAt: "2026-09-28T12:00:00.000Z",
      });
    }).pipe(Effect.provide(layer)),
);
it.effect(
  "a replacement during adapter release cannot reset either persisted mapping or projection",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.onRelease(() => h.setMarker(encodeJson({ version: 1, runId: "newer-run" })));
      expect(
        (yield* h.service.recover({ ...input, runId: "lost-run" }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(h.writes).toHaveLength(0);
      expect(h.commands).toHaveLength(0);
      expect(h.isGated()).toBe(false);
    }).pipe(Effect.provide(layer)),
);
it.effect("a refused adapter release or replacement projected session prevents reset", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    h.failRelease();
    expect(
      (yield* h.service.recover({ ...input, runId: "lost-run" }).pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(h.writes).toHaveLength(0);
    expect(h.commands).toHaveLength(0);
    h.setProjected({ ...h.projected(), activeTurnId: TurnId.make("newer-run"), status: "running" });
    expect(
      (yield* h.service.recover({ ...input, runId: "lost-run" }).pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(h.calls.filter((c) => c.method === "mobs.v1.recoverThread")).toHaveLength(1);
  }).pipe(Effect.provide(layer)),
);
it.effect(
  "explicit reconnect reattaches the known live run without cleanup or turn submission",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setNative({ status: "running" });
      expect(yield* h.service.reconnect({ ...input, runId: "lost-run" })).toEqual({
        runId: "lost-run",
        reconnected: true,
        status: "running",
      });
      expect(h.reconnects).toEqual([
        {
          threadId,
          providerInstanceId: instanceId,
          provider: "meerkat",
          expectedRunId: "lost-run",
          cwd: "/worktree",
          title: "Thread",
          modelSelection: {
            instanceId,
            model: "anthropic:claude-sonnet",
            options: { effort: "high" },
          },
          resumeCursor: h.cursor,
          runtimeMode: "full-access",
        },
      ]);
      expect(h.calls.map((c) => c.method)).toEqual([
        "mobs.v1.runStatus",
        "mobs.v1.runStatus",
        "mobs.v1.runStatus",
      ]);
      expect(h.projected()).toMatchObject({
        status: "running",
        activeTurnId: "lost-run",
        lastError: null,
      });
      expect(h.getBinding()).toMatchObject({
        status: "running",
        resumeCursor: { lastRunId: "lost-run" },
        runtimePayload: { activeTurnId: "lost-run" },
      });
    }).pipe(Effect.provide(layer)),
);
it.effect(
  "reconnect makes failed or cancelled settled conversations usable without changing their receipts",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setNative({ status: "failed" });
      expect(yield* h.service.reconnect({ ...input, runId: "lost-run" })).toMatchObject({
        status: "ready",
      });
      expect(h.projected()).toMatchObject({ status: "ready", activeTurnId: null, lastError: null });
      expect(yield* h.service.status(input)).toMatchObject({
        status: "settled",
        runId: "lost-run",
      });
      h.setNative({ status: "cancelled" });
      h.setProjectedTurnState("interrupted");
      yield* h.service.reconnect({ ...input, runId: "lost-run" });
      expect(h.projected()).toMatchObject({ status: "ready", activeTurnId: null, lastError: null });
      expect(yield* h.service.status(input)).toMatchObject({
        status: "settled",
        runId: "lost-run",
      });
      expect(h.commands.map((command) => command.type)).toEqual([
        "thread.session.set",
        "thread.session.set",
      ]);
      expect(h.calls.every((c) => c.method === "mobs.v1.runStatus")).toBe(true);
    }).pipe(Effect.provide(layer)),
);
for (const [nativeStatus, terminalStatus] of [
  ["failed", "error"],
  ["cancelled", "interrupted"],
] as const) {
  it.effect(
    `reconnect settles an unprojected ${nativeStatus} turn before making its session ready`,
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        h.setNative({ status: nativeStatus });
        h.setProjectedTurnState("running");
        h.setProjected({
          ...h.projected(),
          status: "running",
          activeTurnId: TurnId.make("lost-run"),
        });
        h.useStrictProjection();
        h.emitReadyDuringReconnect(terminalStatus);
        const oldSession = h.projected();
        yield* h.service.reconnect({ ...input, runId: "lost-run" });
        const commands = h.commands.filter((command) => command.type === "thread.session.set");
        expect(commands.map((command) => command.session.status)).toEqual([
          terminalStatus,
          "ready",
          "ready",
        ]);
        expect(commands[0]?.expectedCurrent).toEqual(oldSession);
        expect(commands[2]?.expectedCurrent).toEqual(commands[1]?.session);
        expect(commands.every((command) => command.session.activeTurnId === null)).toBe(true);
        expect(h.projected()).toMatchObject({
          status: "ready",
          activeTurnId: null,
          lastError: null,
        });
        expect(h.latestTurn()).toMatchObject({ turnId: "lost-run", state: terminalStatus });
        expect(h.reconnects).toHaveLength(1);
        expect(h.calls.every((call) => call.method === "mobs.v1.runStatus")).toBe(true);
        expect(h.releases).toHaveLength(0);
      }).pipe(Effect.provide(layer)),
  );
  it.effect(`reconnect preserves a ${nativeStatus} outcome that arrives during reattachment`, () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setNative({ status: "running" });
      h.setProjectedTurnState("running");
      h.setProjected({
        ...h.projected(),
        status: "running",
        activeTurnId: TurnId.make("lost-run"),
      });
      h.useStrictProjection();
      h.onReconnect(() => h.setNative({ status: nativeStatus }));
      yield* h.service.reconnect({ ...input, runId: "lost-run" });
      const commands = h.commands.filter((command) => command.type === "thread.session.set");
      expect(commands.map((command) => command.session.status)).toEqual([terminalStatus, "ready"]);
      expect(commands[1]?.expectedCurrent).toEqual(commands[0]?.session);
      expect(h.projected()).toMatchObject({ status: "ready", activeTurnId: null, lastError: null });
      expect(h.latestTurn()).toMatchObject({ turnId: "lost-run", state: terminalStatus });
      expect(h.reconnects).toHaveLength(1);
      expect(h.releases).toHaveLength(0);
    }).pipe(Effect.provide(layer)),
  );
}
it.effect(
  "reconnect rejects unresolved work and replacement that occurs while the adapter awaits",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      expect(
        (yield* h.service.reconnect({ ...input, runId: "lost-run" }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(h.reconnects).toHaveLength(0);
      h.setNative({ status: "running" });
      h.onReconnect(() =>
        h.setBinding({
          ...h.getBinding(),
          providerInstanceId: ProviderInstanceId.make("replacement"),
        }),
      );
      expect(
        (yield* h.service.reconnect({ ...input, runId: "lost-run" }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(h.writes).toHaveLength(0);
      expect(h.commands).toHaveLength(0);
    }).pipe(Effect.provide(layer)),
);
it.effect("a saved model and its options take precedence during reconnect", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    h.setNative({ status: "running" });
    h.setBinding({
      ...h.getBinding(),
      runtimePayload: {
        modelSelection: {
          instanceId,
          model: "openai:gpt-5.4",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      },
    });
    yield* h.service.reconnect({ ...input, runId: "lost-run" });
    expect(h.reconnects[0]).toMatchObject({
      modelSelection: {
        instanceId,
        model: "openai:gpt-5.4",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
  }).pipe(Effect.provide(layer)),
);

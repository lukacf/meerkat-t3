import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  MeerkatGatewayRpcError,
  MeerkatGatewayTransportError,
  type MeerkatGatewayClient,
  type MeerkatGatewayEvent,
} from "../meerkat/MeerkatGatewayClient.ts";
import {
  decodeMeerkatModel,
  makeMeerkatAdapter,
  meerkatProjectStateRoot,
} from "./MeerkatAdapter.ts";

const instanceId = ProviderInstanceId.make("meerkat-test");
const threadId = ThreadId.make("thread-test");
const timestamp = "2026-09-25T15:00:00.000Z";
const decodeMarkerForTest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ runId: Schema.String })),
);

function skillReceipt(kind: "skills.resolved" | "skills.resolution-failed"): MeerkatGatewayEvent {
  const sourceEventId =
    kind === "skills.resolved"
      ? "b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64"
      : "97e07e7d-4641-43c6-b49d-a8827225fa24";
  const nativeSessionId = "native-session";
  const nativeSourceEventId = `evt-agent-${sourceEventId}`;
  const eventId = `meerkat-output:run-1:${nativeSessionId}:${nativeSourceEventId}`;
  const key = { source_uuid: "f9422cca-aa96-4f06-b9ba-a6550d1c811c", skill_name: "review" };
  return {
    event_id: eventId,
    kind,
    timestamp,
    trace_id: eventId,
    thread_id: threadId,
    run_id: "run-1",
    payload: {
      nativeSessionId,
      nativeSourceEventId,
      nativeDeliveryId: eventId,
      nativeEvent: {
        event_id: sourceEventId,
        source: { type: "session", session_id: nativeSessionId },
        seq: kind === "skills.resolved" ? 1 : 2,
        timestamp_ms: Date.parse(timestamp),
        payload:
          kind === "skills.resolved"
            ? { type: "skills_resolved", skills: [key], injection_bytes: 123 }
            : {
                type: "skill_resolution_failed",
                skill_key: key,
                reason: { reason_type: "not_found", key },
              },
      },
    },
  };
}

function fixture() {
  const calls: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = [];
  let listener: ((event: MeerkatGatewayEvent) => void) | undefined;
  let closeListener: ((error: MeerkatGatewayTransportError) => void) | undefined;
  let serial = 0;
  let turn: ((params: Readonly<Record<string, unknown>>) => Promise<unknown>) | undefined;
  let runStatus = "completed";
  let runIdentity: Record<string, unknown> = {};
  let inspectRun: (() => void) | undefined;
  let accessMode: unknown;
  let runtimeCancelled = true;
  let cancellationRequested = false;
  let followupPage: unknown = { status: "unavailable", frames: [], exhausted: true };
  let deliveryPage: ReadonlyArray<MeerkatGatewayEvent> = [];
  let dispose: (() => Promise<unknown>) | undefined;
  const emit = (kind: string, payload: Record<string, unknown> = {}, runId = "run-1") =>
    listener?.({
      event_id: `event-${serial++}`,
      kind,
      timestamp,
      trace_id: "trace-1",
      thread_id: threadId,
      run_id: runId,
      payload,
    });
  const client: MeerkatGatewayClient = {
    pid: undefined,
    request: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === "models.v1.catalog")
        return {
          catalog: {
            providers: [
              {
                provider: "openai",
                models: [
                  {
                    id: "gpt-test",
                    profile: {
                      params_schema: {
                        properties: {
                          reasoning_effort: { type: "string", enum: ["low", "high"] },
                          prompt_cache_enabled: { type: "boolean" },
                        },
                      },
                    },
                  },
                ],
              },
            ],
          },
        };
      if (method === "mobs.v1.turnStart")
        return turn ? turn(params) : { runId: params.runId ?? "run-1" };
      if (method === "mobs.v1.runStatus") {
        inspectRun?.();
        return {
          status: runStatus,
          runId: params.runId,
          threadId: params.threadId,
          mobId: params.mobId,
          ...runIdentity,
        };
      }
      if (method === "mobs.v1.createThreadMob") {
        accessMode ??= params.accessMode;
        return { accessMode };
      }
      if (method === "mobs.v1.snapshot") return { accessMode };
      if (method === "mobs.v1.forceCancel") return { runtimeCancelled, cancellationRequested };
      if (method === "mobs.v1.destroy") return dispose ? dispose() : { cleanupCompleted: true };
      if (method === "mobs.v1.threadFollowups") return followupPage;
      if (method === "mobs.v1.threadDeliveries") return { events: deliveryPage };
      if (method === "mobs.v1.acknowledgeThreadDelivery") {
        deliveryPage = deliveryPage.filter((event) => event.event_id !== params.eventId);
        return { acknowledged: true };
      }
      if (method === "mobs.v1.consoleTimeline")
        return { timeline: { frames: [{ kind: "message", text: "runtime history" }] } };
      return {};
    },
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    onClose: (fn) => {
      closeListener = fn;
      return () => {
        closeListener = undefined;
      };
    },
    close: async () => {},
  };
  return {
    client,
    calls,
    emit,
    emitEvent: (event: MeerkatGatewayEvent) => listener?.(event),
    close: (error: MeerkatGatewayTransportError) => closeListener?.(error),
    setTurn: (fn: typeof turn) => {
      turn = fn;
    },
    setDispose: (fn: typeof dispose) => {
      dispose = fn;
    },
    setRunStatus: (status: string) => {
      runStatus = status;
    },
    setRunIdentity: (identity: Record<string, unknown>) => {
      runIdentity = identity;
    },
    onInspectRun: (fn: () => void) => {
      inspectRun = fn;
    },
    setAccessMode: (mode: unknown) => {
      accessMode = mode;
    },
    setCancellationRequested: () => {
      runtimeCancelled = false;
      cancellationRequested = true;
    },
    setRuntimeCancelled: (value: boolean) => {
      runtimeCancelled = value;
    },
    setFollowupPage: (value: unknown) => {
      followupPage = value;
    },
    setDeliveryPage: (value: ReadonlyArray<MeerkatGatewayEvent>) => {
      deliveryPage = value;
    },
  };
}
const startInput = {
  threadId,
  runtimeMode: "full-access" as const,
  cwd: "/tmp/meerkat-project",
  modelSelection: { instanceId, model: "openai:gpt-test" },
};
const make = (
  client: MeerkatGatewayClient,
  prepareWorkspace?: (projectPath: string, stateRoot: string) => Promise<void>,
) =>
  makeMeerkatAdapter({
    createRunId: (() => {
      let serial = 0;
      return () => `run-${++serial}`;
    })(),
    client,
    instanceId,
    stateRoot: "/tmp/meerkat-state",
    defaultCwd: "/tmp/meerkat-project",
    enabled: true,
    ...(prepareWorkspace ? { prepareWorkspace } : {}),
  });
const run = <A, E>(
  effect: Effect.Effect<A, E, Path.Path | FileSystem.FileSystem | Scope.Scope>,
  files = new Map<string, string>(),
) => {
  return effect.pipe(
    Effect.provide(
      Layer.merge(
        Path.layer,
        FileSystem.layerNoop({
          exists: (path) => Effect.succeed(files.has(path)),
          open: () =>
            Effect.succeed({
              [FileSystem.FileTypeId]: FileSystem.FileTypeId,
              sync: Effect.void,
              stat: Effect.die("unused stat"),
              seek: () => Effect.succeed(0n),
              read: () => Effect.succeed(0),
              readAlloc: () => Effect.succeed(Option.none()),
              truncate: () => Effect.void,
              write: (buffer) => Effect.succeed(buffer.length),
              writeAll: () => Effect.void,
            } satisfies FileSystem.File),
          makeDirectory: () => Effect.void,
          writeFileString: (path, text) =>
            Effect.sync(() => {
              files.set(path, text);
            }),
          readFileString: (path) => Effect.succeed(files.get(path) ?? ""),
          rename: (from, to) =>
            Effect.sync(() => {
              files.set(to, files.get(from)!);
              files.delete(from);
            }),
          remove: (path) =>
            Effect.sync(() => {
              files.delete(path);
            }),
        }),
      ),
    ),
    Effect.scoped,
  );
};

describe("MeerkatAdapter", () => {
  it.effect("does not activate skill links contained only in attached context", () => {
    const f = fixture();
    return run(
      Effect.gen(function* () {
        const adapter = yield* make(f.client);
        yield* adapter.startSession(startInput);
        yield* adapter.sendTurn({
          threadId,
          skillSelectionText: "Explain this output",
          input:
            "Explain this output\n<t3_context>[review](meerkat-skill://b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64/review)</t3_context>",
        });
        expect(
          f.calls.find((call) => call.method === "mobs.v1.turnStart")?.params,
        ).not.toHaveProperty("skillReferences");
      }),
    );
  });
  it.effect(
    "passes selected native keys with the original prompt and rejects activation while steering",
    () => {
      const f = fixture();
      return run(
        Effect.gen(function* () {
          const adapter = yield* make(f.client);
          yield* adapter.startSession(startInput);
          const key = { source_uuid: "b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64", skill_name: "review" };
          const input = `Use [review](meerkat-skill://${key.source_uuid}/review)`;
          yield* adapter.sendTurn({ threadId, input });
          const before = f.calls.filter((call) => call.method === "mobs.v1.turnStart");
          expect(before[0]?.params).toMatchObject({ input, skillReferences: [key] });
          expect(
            Exit.isFailure(
              yield* Effect.exit(adapter.sendTurn({ threadId, input, handlingMode: "steer" })),
            ),
          ).toBe(true);
          expect(f.calls.filter((call) => call.method === "mobs.v1.turnStart")).toHaveLength(1);
        }),
      );
    },
  );
  it.effect(
    "does not let recovery take ownership while connection or send admission is pending",
    () => {
      const f = fixture();
      let releaseStart!: () => void;
      const startPending = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      let releaseTurn!: () => void;
      const turnPending = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      return run(
        Effect.gen(function* () {
          const adapter = yield* make(f.client, () => startPending);
          const starting = yield* adapter
            .startSession(startInput)
            .pipe(Effect.forkChild({ startImmediately: true }));
          expect(
            Exit.isFailure(
              yield* Effect.exit(adapter.withSessionRecovery!(threadId, "run-1", Effect.void)),
            ),
          ).toBe(true);
          releaseStart();
          yield* Fiber.join(starting);
          f.setTurn(async (params) => {
            await turnPending;
            return { runId: params.runId };
          });
          const sending = yield* adapter
            .sendTurn({ threadId, input: "pending" })
            .pipe(Effect.forkChild({ startImmediately: true }));
          expect(
            Exit.isFailure(
              yield* Effect.exit(adapter.withSessionRecovery!(threadId, "run-1", Effect.void)),
            ),
          ).toBe(true);
          releaseTurn();
          yield* Fiber.join(sending);
          expect(f.calls.filter((call) => call.method === "mobs.v1.turnStart")).toHaveLength(1);
        }),
      );
    },
  );

  it.effect("rejects foreign native receipts and a marker replaced during reconnect", () => {
    const f = fixture();
    const files = new Map<string, string>();
    f.setTurn(async () => {
      throw new MeerkatGatewayTransportError("disconnected", "Lost response", true);
    });
    return run(
      Effect.gen(function* () {
        const adapter = yield* make(f.client);
        const initial = yield* adapter.startSession(startInput);
        expect(
          Exit.isFailure(yield* Effect.exit(adapter.sendTurn({ threadId, input: "once" }))),
        ).toBe(true);
        f.setRunStatus("running");
        const reconnect = adapter.withSessionRecovery!(
          threadId,
          "run-1",
          adapter.reconnectSession!({
            ...startInput,
            resumeCursor: initial.resumeCursor,
            expectedRunId: "run-1",
          }),
        );
        f.setRunIdentity({ mobId: "foreign-mob" });
        expect(Exit.isFailure(yield* Effect.exit(reconnect))).toBe(true);
        f.setRunIdentity({});
        f.onInspectRun(() => {
          for (const key of files.keys()) files.set(key, '{"version":1,"runId":"replacement"}');
        });
        expect(Exit.isFailure(yield* Effect.exit(reconnect))).toBe(true);
        expect(f.calls.filter((call) => call.method === "mobs.v1.createThreadMob")).toHaveLength(1);
        expect(f.calls.filter((call) => call.method === "mobs.v1.turnStart")).toHaveLength(1);
        expect(yield* adapter.hasSession(threadId)).toBe(true);
      }),
      files,
    );
  });
  it.effect(
    "holds an exact recovery gate against sends, connects, stops and concurrent recovery",
    () => {
      const f = fixture();
      return run(
        Effect.gen(function* () {
          const adapter = yield* make(f.client);
          yield* adapter.startSession(startInput);
          yield* adapter.withSessionRecovery!(
            threadId,
            "run-1",
            Effect.gen(function* () {
              for (const operation of [
                adapter.sendTurn({ threadId, input: "must not dispatch" }),
                adapter.startSession(startInput),
                adapter.stopSession(threadId),
                adapter.interruptTurn(threadId),
                adapter.withSessionRecovery!(threadId, "run-2", Effect.void),
              ])
                expect(Exit.isFailure(yield* Effect.exit(operation))).toBe(true);
            }),
          );
          expect(
            f.calls.some((call) =>
              ["mobs.v1.turnStart", "mobs.v1.destroy", "mobs.v1.forceCancel"].includes(call.method),
            ),
          ).toBe(false);
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                adapter.withSessionRecovery!(
                  threadId,
                  "run-1",
                  Effect.fail("interrupted recovery"),
                ),
              ),
            ),
          ).toBe(true);
          const sent = yield* adapter.sendTurn({ threadId, input: "new input" });
          expect(sent.turnId).toBe("run-1");
          expect(
            Exit.isFailure(
              yield* Effect.exit(adapter.withSessionRecovery!(threadId, "older-run", Effect.void)),
            ),
          ).toBe(true);
        }),
      );
    },
  );

  it.effect(
    "explicit reconnect replaces an uncertain context with the original live run without replay",
    () => {
      const f = fixture();
      f.setTurn(async () => {
        throw new MeerkatGatewayTransportError("disconnected", "Lost reply", true);
      });
      return run(
        Effect.gen(function* () {
          const adapter = yield* make(f.client);
          const initial = yield* adapter.startSession(startInput);
          expect(
            Exit.isFailure(yield* Effect.exit(adapter.sendTurn({ threadId, input: "once" }))),
          ).toBe(true);
          f.setRunStatus("running");
          const reconnectInput = {
            ...startInput,
            resumeCursor: initial.resumeCursor,
            expectedRunId: "run-1",
          };
          expect(
            Exit.isFailure(yield* Effect.exit(adapter.reconnectSession!(reconnectInput))),
          ).toBe(true);
          const reconnected = yield* adapter.withSessionRecovery!(
            threadId,
            "run-1",
            adapter.reconnectSession!(reconnectInput),
          );
          expect(reconnected).toMatchObject({ status: "running", activeTurnId: "run-1" });
          expect(f.calls.filter((call) => call.method === "mobs.v1.createThreadMob")).toHaveLength(
            1,
          );
          expect(f.calls.filter((call) => call.method === "mobs.v1.turnStart")).toHaveLength(1);
          expect(f.calls.filter((call) => call.method === "mobs.v1.destroy")).toHaveLength(0);
          yield* adapter.interruptTurn(threadId, TurnId.make("run-1"));
          expect(
            f.calls.findLast((call) => call.method === "mobs.v1.forceCancel")?.params.runId,
          ).toBe("run-1");
          f.emit("run.completed", {}, "run-1");
          f.setTurn(undefined);
          const next = yield* adapter.sendTurn({ threadId, input: "fresh request" });
          expect(next.turnId).toBe("run-2");
        }),
      );
    },
  );

  it.effect(
    "terminal reconnect permits a distinct fresh turn and rejects stale or unconfirmed operations",
    () => {
      const f = fixture();
      const files = new Map<string, string>();
      f.setTurn(async () => {
        throw new MeerkatGatewayTransportError("disconnected", "Lost reply", true);
      });
      return run(
        Effect.gen(function* () {
          const adapter = yield* make(f.client);
          const initial = yield* adapter.startSession(startInput);
          expect(
            Exit.isFailure(yield* Effect.exit(adapter.sendTurn({ threadId, input: "once" }))),
          ).toBe(true);
          const reconnect = (expectedRunId: string) =>
            adapter.withSessionRecovery!(
              threadId,
              expectedRunId,
              adapter.reconnectSession!({
                ...startInput,
                resumeCursor: initial.resumeCursor,
                expectedRunId,
              }),
            );
          expect(Exit.isFailure(yield* Effect.exit(reconnect("wrong-run")))).toBe(true);
          f.setRunStatus("unknown");
          expect(Exit.isFailure(yield* Effect.exit(reconnect("run-1")))).toBe(true);
          const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
          yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(queue, event)).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          f.setRunStatus("completed");
          const ready = yield* reconnect("run-1");
          expect(ready.status).toBe("ready");
          // The service owns recovery lifecycle projection; native output still flows.
          const receipt = skillReceipt("skills.resolved");
          f.emitEvent(receipt);
          expect(yield* Queue.take(queue)).toMatchObject({
            type: receipt.kind,
            eventId: receipt.event_id,
          });
          expect(f.calls.filter((call) => call.method === "mobs.v1.turnStart")).toHaveLength(1);
          f.setTurn(undefined);
          expect((yield* adapter.sendTurn({ threadId, input: "fresh request" })).turnId).toBe(
            "run-2",
          );
          expect(Exit.isFailure(yield* Effect.exit(reconnect("run-1")))).toBe(true);
        }),
        files,
      );
    },
  );
  for (const access of ["read-only", "approval-required"] as const) {
    it.effect(
      `preserves native ${access} access across restoration and running reattachment`,
      () => {
        const f = fixture();
        return run(
          Effect.gen(function* () {
            const adapter = yield* make(f.client);
            const input = { ...startInput, runtimeMode: access };
            const session = yield* adapter.startSession(input);
            expect(session.runtimeMode).toBe(access);
            expect(
              f.calls.find((call) => call.method === "mobs.v1.createThreadMob")?.params.accessMode,
            ).toBe(access);
            expect(Exit.isFailure(yield* Effect.exit(adapter.startSession(startInput)))).toBe(true);
            yield* adapter.stopSession(threadId);
            const restored = yield* adapter.startSession({
              ...input,
              resumeCursor: session.resumeCursor,
            });
            expect(restored.runtimeMode).toBe(access);
            yield* adapter.stopSession(threadId);
            f.setRunStatus("running");
            const cursor = { ...(restored.resumeCursor as object), lastRunId: "native-running" };
            const running = yield* adapter.startSession({ ...input, resumeCursor: cursor });
            expect(running.runtimeMode).toBe(access);
            expect(running.activeTurnId).toBe("native-running");
            expect(
              f.calls.findLast((call) => call.method === "mobs.v1.snapshot")?.params.mobId,
            ).toBe((session.resumeCursor as { mobId: string }).mobId);
          }),
        );
      },
    );
  }

  for (const mode of ["full-access", "old-binary-missing-mode"] as const) {
    it.effect(`rejects read-only before session admission when native reports ${mode}`, () => {
      const f = fixture();
      f.setAccessMode(mode);
      return run(
        Effect.gen(function* () {
          const adapter = yield* make(f.client);
          const result = yield* Effect.exit(
            adapter.startSession({ ...startInput, runtimeMode: "read-only" }),
          );
          expect(Exit.isFailure(result)).toBe(true);
          expect(yield* adapter.listSessions()).toEqual([]);
          expect(f.calls.some((call) => call.method === "mobs.v1.turnStart")).toBe(false);
        }),
      );
    });
  }
  it.effect(
    "releases only the exact recovered context without destroying or replaying again",
    () => {
      const f = fixture();
      f.setTurn(async () => {
        throw new MeerkatGatewayTransportError("disconnected", "Lost response", true);
      });
      return run(
        Effect.gen(function* () {
          const adapter = yield* make(f.client);
          const session = yield* adapter.startSession(startInput);
          expect(
            Exit.isFailure(yield* Effect.exit(adapter.sendTurn({ threadId, input: "once" }))),
          ).toBe(true);
          f.setRunStatus("unknown");
          expect(
            Exit.isFailure(yield* Effect.exit(adapter.releaseRecoveredSession!(threadId, "run-1"))),
          ).toBe(true);
          f.setRunStatus("recovered");
          expect(
            Exit.isFailure(
              yield* Effect.exit(adapter.releaseRecoveredSession!(threadId, "wrong-run")),
            ),
          ).toBe(true);
          yield* adapter.releaseRecoveredSession!(threadId, "run-1");
          expect(yield* adapter.hasSession(threadId)).toBe(false);
          expect(f.calls.filter((call) => call.method === "mobs.v1.destroy")).toHaveLength(0);
          yield* adapter.startSession({ ...startInput, resumeCursor: session.resumeCursor });
          f.setTurn(undefined);
          const next = yield* adapter.sendTurn({ threadId, input: "new input" });
          expect(next.turnId).toBe("run-2");
          expect(f.calls.filter((call) => call.method === "mobs.v1.turnStart")).toHaveLength(2);
        }),
      );
    },
  );

  it.effect(
    "persists the caller operation before I/O and reconciles a lost response without replay",
    () => {
      const f = fixture();
      const files = new Map<string, string>();
      return run(
        Effect.gen(function* () {
          let dispatched: Readonly<Record<string, unknown>> | undefined;
          f.setTurn(async (params) => {
            dispatched = params;
            const marker = decodeMarkerForTest(
              files.get(`${params.stateRoot}/t3-dispatch/${params.mobId}.json`),
            );
            expect(marker.runId).toBe(params.runId);
            throw new MeerkatGatewayTransportError("disconnected", "Receipt lost", true);
          });
          const initial = yield* Effect.scoped(
            Effect.gen(function* () {
              const adapter = yield* make(f.client);
              const session = yield* adapter.startSession(startInput);
              expect(
                Exit.isFailure(
                  yield* Effect.exit(adapter.sendTurn({ threadId, input: "Do once" })),
                ),
              ).toBe(true);
              return session;
            }),
          );
          f.setRunStatus("running");
          const resumed = yield* make(f.client);
          const session = yield* resumed.startSession({
            ...startInput,
            resumeCursor: initial.resumeCursor,
          });
          expect(session).toMatchObject({ status: "running", activeTurnId: dispatched!.runId });
          expect(f.calls.filter((call) => call.method === "mobs.v1.createThreadMob")).toHaveLength(
            1,
          );
          expect(f.calls.filter((call) => call.method === "mobs.v1.turnStart")).toHaveLength(1);
          expect(
            f.calls.findLast((call) => call.method === "mobs.v1.runStatus")?.params,
          ).toMatchObject({ runId: dispatched!.runId, threadId, mobId: dispatched!.mobId });
          f.emit("run.completed", {}, String(dispatched!.runId));
          expect((yield* resumed.listSessions())[0]?.status).toBe("ready");
        }),
        files,
      );
    },
  );
  it.effect(
    "requires the native operation identity to match and resumes explicit recovered outcomes",
    () => {
      const f = fixture();
      f.setTurn(async () => ({ runId: "wrong-operation" }));
      return run(
        Effect.gen(function* () {
          const initial = yield* Effect.scoped(
            Effect.gen(function* () {
              const adapter = yield* make(f.client);
              const session = yield* adapter.startSession(startInput);
              expect(
                Exit.isFailure(yield* Effect.exit(adapter.sendTurn({ threadId, input: "once" }))),
              ).toBe(true);
              expect(
                Exit.isFailure(
                  yield* Effect.exit(adapter.sendTurn({ threadId, input: "duplicate" })),
                ),
              ).toBe(true);
              return session;
            }),
          );
          f.setRunStatus("recovered");
          const adapter = yield* make(f.client);
          const resumed = yield* adapter.startSession({
            ...startInput,
            resumeCursor: initial.resumeCursor,
          });
          expect(resumed.status).toBe("ready");
          expect(f.calls.filter((call) => call.method === "mobs.v1.turnStart")).toHaveLength(1);
          expect(
            f.calls.findLast((call) => call.method === "mobs.v1.runStatus")?.params.runId,
          ).toBe("run-1");
        }),
      );
    },
  );

  it.effect(
    "preserves native skill receipts before RunStarted without changing session lifecycle",
    () => {
      const f = fixture();
      return run(
        Effect.gen(function* () {
          const adapter = yield* make(f.client);
          yield* adapter.startSession(startInput);
          const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
          yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(queue, event)).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          const before = yield* adapter.listSessions();
          const resolved = skillReceipt("skills.resolved");
          f.emitEvent(resolved);
          expect(yield* Queue.take(queue)).toMatchObject({
            type: resolved.kind,
            eventId: resolved.event_id,
            turnId: resolved.run_id,
            payload: resolved.payload,
          });
          expect(yield* adapter.listSessions()).toEqual(before);
          f.emit("run.started");
          expect((yield* Queue.take(queue)).type).toBe("turn.started");
          const running = yield* adapter.listSessions();
          const failed = skillReceipt("skills.resolution-failed");
          f.emitEvent(failed);
          expect(yield* Queue.take(queue)).toMatchObject({
            type: failed.kind,
            eventId: failed.event_id,
            turnId: failed.run_id,
            payload: failed.payload,
          });
          expect(yield* adapter.listSessions()).toEqual(running);
          expect(running[0]).toMatchObject({ status: "running", activeTurnId: "run-1" });
          expect(
            f.calls.filter((call) => call.method === "mobs.v1.acknowledgeThreadDelivery"),
          ).toHaveLength(0);
          for (const receipt of [resolved, failed]) {
            yield* adapter.acknowledgeEvent!(EventId.make(receipt.event_id));
            expect(f.calls.at(-1)).toMatchObject({
              method: "mobs.v1.acknowledgeThreadDelivery",
              params: { eventId: receipt.event_id, threadId },
            });
          }
          f.emit("run.completed");
          expect((yield* Queue.take(queue)).type).toBe("turn.completed");
          expect((yield* adapter.listSessions())[0]).toMatchObject({ status: "ready" });
        }),
      );
    },
  );

  it.effect(
    "replays skill receipts on a cold adapter and refuses mismatched acknowledgement identity",
    () => {
      const f = fixture();
      return run(
        Effect.gen(function* () {
          const session = yield* Effect.scoped(
            Effect.gen(function* () {
              const first = yield* make(f.client);
              return yield* first.startSession(startInput);
            }),
          );
          const adapter = yield* make(f.client);
          yield* adapter.observeSession!({ threadId, resumeCursor: session.resumeCursor });
          const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
          yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(queue, event)).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          const resolved = skillReceipt("skills.resolved");
          const failed = skillReceipt("skills.resolution-failed");
          f.setDeliveryPage([resolved, failed]);
          yield* TestClock.adjust("1 second");
          for (const receipt of [resolved, failed]) {
            const output = yield* Queue.take(queue);
            expect(output).toMatchObject({
              type: receipt.kind,
              eventId: receipt.event_id,
              payload: receipt.payload,
            });
            expect(output).not.toHaveProperty("itemId");
            expect(output.payload).not.toHaveProperty("nativeSegmentId");
            yield* adapter.acknowledgeEvent!(output.eventId);
          }
          expect(yield* adapter.listSessions()).toEqual([]);
          expect(f.calls.filter((call) => call.method === "mobs.v1.turnStart")).toHaveLength(0);
          while ((yield* Queue.size(queue)) > 0) yield* Queue.take(queue);
          const invalid = { ...resolved, event_id: "foreign-delivery" };
          f.setDeliveryPage([invalid]);
          yield* TestClock.adjust("1 second");
          const warning = yield* Queue.take(queue);
          expect(warning).toMatchObject({
            type: "runtime.warning",
            eventId: "foreign-delivery:invalid-skill-receipt",
          });
          yield* adapter.acknowledgeEvent!(warning.eventId);
          expect(
            f.calls
              .filter((call) => call.method === "mobs.v1.acknowledgeThreadDelivery")
              .map((call) => call.params.eventId),
          ).toEqual([resolved.event_id, failed.event_id]);
          while ((yield* Queue.size(queue)) > 0) yield* Queue.take(queue);
          yield* TestClock.adjust("1 second");
          expect(yield* Queue.take(queue)).toEqual(warning);
          while ((yield* Queue.size(queue)) > 0) yield* Queue.take(queue);
          f.setDeliveryPage([{ ...resolved, payload: { ...resolved.payload, nativeEvent: {} } }]);
          yield* TestClock.adjust("1 second");
          const absentEnvelope = yield* Queue.take(queue);
          expect(absentEnvelope).toMatchObject({
            type: "runtime.warning",
            eventId: `${resolved.event_id}:invalid-skill-receipt`,
          });
          yield* adapter.acknowledgeEvent!(absentEnvelope.eventId);
          expect(
            f.calls
              .filter((call) => call.method === "mobs.v1.acknowledgeThreadDelivery")
              .map((call) => call.params.eventId),
          ).toEqual([resolved.event_id, failed.event_id]);
        }),
      );
    },
  );

  it.effect(
    "replays cold ordinary output with the original turn and item until persistence acknowledges it",
    () => {
      const f = fixture();
      return run(
        Effect.gen(function* () {
          const session = yield* Effect.scoped(
            Effect.gen(function* () {
              const first = yield* make(f.client);
              return yield* first.startSession(startInput);
            }),
          );
          const adapter = yield* make(f.client);
          yield* adapter.observeSession!({ threadId, resumeCursor: session.resumeCursor });
          const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
          yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(queue, event)).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          f.setDeliveryPage([
            {
              event_id: "stable-output",
              kind: "run.output.complete",
              timestamp,
              trace_id: "stable-output",
              thread_id: threadId,
              run_id: "original-run",
              payload: { text: "Recovered final", nativeSegmentId: "native-segment" },
            },
          ]);
          yield* TestClock.adjust("1 second");
          const output = yield* Queue.take(queue);
          expect(output).toMatchObject({
            eventId: "stable-output",
            turnId: "original-run",
            itemId: "original-run:assistant:native-segment",
            type: "item.completed",
            payload: { authoritativeText: "Recovered final" },
          });
          while ((yield* Queue.size(queue)) > 0) yield* Queue.take(queue);
          yield* TestClock.adjust("1 second");
          expect(yield* Queue.take(queue)).toEqual(output);
          expect(yield* adapter.listSessions()).toEqual([]);
          expect(f.calls.filter((call) => call.method === "mobs.v1.turnStart")).toHaveLength(0);
          expect(
            f.calls.filter((call) => call.method === "mobs.v1.acknowledgeThreadDelivery"),
          ).toHaveLength(0);
          yield* adapter.acknowledgeEvent!(output.eventId);
          expect(f.calls.at(-1)).toMatchObject({
            method: "mobs.v1.acknowledgeThreadDelivery",
            params: { eventId: "stable-output", threadId },
          });
          while ((yield* Queue.size(queue)) > 0) yield* Queue.take(queue);
          yield* TestClock.adjust("1 second");
          expect(yield* Queue.size(queue)).toBe(0);
        }),
      );
    },
  );
  for (const admission of ["ordinary", "rejected", "steering"] as const) {
    it.effect(
      `refreshes follow-up session ownership only on ordinary admission: ${admission}`,
      () => {
        const f = fixture();
        const page = (sessionId: string) => ({
          status: "ready",
          sessionId,
          frames: [
            {
              id: `native-${sessionId}`,
              cursor: "console:1",
              dedupe_key: `native-${sessionId}`,
              timestamp_ms: Date.parse(timestamp),
              runtime_key: "default",
              identity: "ingress",
              session_id: sessionId,
              kind: "interaction_complete",
              status: "completed",
              frame_version: 1,
              payload: { result: `Reply from ${sessionId}`, source_event_type: "run_completed" },
              source: { kind: "console_event" },
            },
          ],
          nextCursor: "console:1",
          exhausted: true,
        });
        return run(
          Effect.gen(function* () {
            const adapter = yield* make(f.client);
            yield* adapter.startSession(startInput);
            if (admission === "steering")
              yield* adapter.sendTurn({ threadId, input: "Start work" });
            const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
            yield* Stream.runForEach(adapter.streamEvents, (event) =>
              Queue.offer(queue, event),
            ).pipe(Effect.forkChild({ startImmediately: true }));
            f.setFollowupPage(page("old-session"));
            yield* TestClock.adjust("1 second");
            const oldEvent = yield* Queue.take(queue);
            expect(oldEvent.type).toBe("item.completed");
            // The polling loop may have retried the retained page already.
            // Consume those deliveries before testing the admission boundary.
            while ((yield* Queue.size(queue)) > 0) yield* Queue.take(queue);
            f.setFollowupPage(page("new-session"));
            if (admission === "rejected") {
              f.setTurn(async () => {
                throw new MeerkatGatewayRpcError({
                  message: "Rejected",
                  rpcCode: -1,
                  typedCode: "CONFLICT",
                });
              });
              expect(
                Exit.isFailure(yield* Effect.exit(adapter.sendTurn({ threadId, input: "Next" }))),
              ).toBe(true);
            } else if (admission === "steering") {
              f.setTurn(async () => ({
                runId: "run-1",
                mode: "steering_submitted",
                handlingMode: "steer",
                status: "running",
                runtimeReceipt: { identity: "ingress", handling_mode: "steer" },
              }));
              yield* adapter.sendTurn({ threadId, input: "Correction", handlingMode: "steer" });
            } else {
              yield* adapter.sendTurn({ threadId, input: "Next" });
            }
            yield* TestClock.adjust("1 second");
            const nextEvent = yield* Queue.take(queue);
            if (admission === "ordinary") {
              expect(nextEvent.eventId).not.toBe(oldEvent.eventId);
              expect(nextEvent.payload).toMatchObject({
                authoritativeText: "Reply from new-session",
              });
            } else {
              expect(nextEvent).toEqual(oldEvent);
            }
          }),
        );
      },
    );
  }

  it.effect("opts into native worker observation on first creation and restoration", () => {
    const f = fixture();
    return run(
      Effect.gen(function* () {
        const adapter = yield* make(f.client);
        const session = yield* adapter.startSession(startInput);
        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({ ...startInput, resumeCursor: session.resumeCursor });
        const creates = f.calls.filter((call) => call.method === "mobs.v1.createThreadMob");
        expect(creates).toHaveLength(2);
        expect(creates.every((call) => call.params.includeNativeWorkers === true)).toBe(true);
        expect(f.calls.some((call) => call.method === "mobs.v1.turnStart")).toBe(false);
      }),
    );
  });
  it.effect("prepares private workspace policy before admitting a new member", () => {
    const f = fixture();
    return run(
      Effect.gen(function* () {
        const adapter = yield* make(f.client, async (projectPath, stateRoot) => {
          expect(projectPath).toBe(startInput.cwd);
          expect(stateRoot).toContain("/tmp/meerkat-state/projects/");
          expect(f.calls.some((call) => call.method === "mobs.v1.createThreadMob")).toBe(false);
          f.calls.push({ method: "workspace-prepared", params: {} });
        });
        yield* adapter.startSession(startInput);
        expect(f.calls.map((call) => call.method)).toEqual([
          "workspace-prepared",
          "mobs.v1.createThreadMob",
        ]);
      }),
    );
  });

  it.effect("does not admit a member after workspace policy initialization fails", () => {
    const f = fixture();
    return run(
      Effect.gen(function* () {
        const adapter = yield* make(f.client, async () => {
          throw new Error("Private realm config is not writable");
        });
        const result = yield* Effect.exit(adapter.startSession(startInput));
        expect(Exit.isFailure(result)).toBe(true);
        expect(f.calls).toEqual([]);
        expect(yield* adapter.listSessions()).toEqual([]);
      }),
    );
  });

  it.effect(
    "binds before admission and streams deltas and authoritative final correction when events precede the response",
    () => {
      const f = fixture();
      f.setTurn(async () => {
        f.emit("run.started", { appliedModel: "gpt-test" });
        f.emit("run.output.delta", { textDelta: "wrong provisional text" });
        f.emit("run.output.complete", { text: "Authoritative final text" });
        f.emit("run.completed");
        return { runId: "run-1" };
      });
      return run(
        Effect.gen(function* () {
          const adapter = yield* make(f.client);
          yield* adapter.startSession(startInput);
          const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
          yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(queue, event)).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          const result = yield* adapter.sendTurn({ threadId, input: "Test" });
          const emitted = yield* Stream.fromQueue(queue).pipe(Stream.take(4), Stream.runCollect);
          expect(result.turnId).toBe("run-1");
          expect(emitted.map((event) => event.type)).toEqual([
            "turn.started",
            "content.delta",
            "item.completed",
            "turn.completed",
          ]);
          expect(
            (emitted[1] as Extract<ProviderRuntimeEvent, { type: "content.delta" }>).payload.delta,
          ).toBe("wrong provisional text");
          expect(
            (emitted[2] as Extract<ProviderRuntimeEvent, { type: "item.completed" }>).payload
              .authoritativeText,
          ).toBe("Authoritative final text");
          expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
          expect((yield* adapter.listSessions())[0]?.activeTurnId).toBeUndefined();
        }),
      );
    },
  );

  it.effect("preserves native tool identity and failure", () => {
    const f = fixture();
    return run(
      Effect.gen(function* () {
        const adapter = yield* make(f.client);
        yield* adapter.startSession(startInput);
        const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
        yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(queue, event)).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        f.emit("tool.command.started", {
          toolId: "tool-7",
          command: "false",
          title: "Run command",
        });
        f.emit("tool.command.finished", {
          toolId: "tool-7",
          command: "false",
          title: "Run command",
          output: "exit 1",
          isError: false,
          exitCode: 7,
          status: "Error",
        });
        const emitted = yield* Stream.fromQueue(queue).pipe(Stream.take(2), Stream.runCollect);
        expect(emitted[0]?.itemId).toBe("run-1:tool:tool-7");
        expect(emitted[1]?.itemId).toBe(emitted[0]?.itemId);
        expect(
          (emitted[1] as Extract<ProviderRuntimeEvent, { type: "item.completed" }>).payload.status,
        ).toBe("failed");
      }),
    );
  });

  it.effect("rejects unsupported modes and active sends without issuing a second mutation", () => {
    const f = fixture();
    return run(
      Effect.gen(function* () {
        const adapter = yield* make(f.client);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              adapter.startSession({ ...startInput, runtimeMode: "auto-accept-edits" }),
            ),
          ),
        ).toBe(true);
        expect(f.calls).toHaveLength(0);
        yield* adapter.startSession(startInput);
        yield* adapter.sendTurn({ threadId, input: "First" });
        expect(
          Exit.isFailure(yield* Effect.exit(adapter.sendTurn({ threadId, input: "Second" }))),
        ).toBe(true);
        expect(f.calls.filter((call) => call.method === "mobs.v1.turnStart")).toHaveLength(1);
        const turn = f.calls.find((call) => call.method === "mobs.v1.turnStart")!;
        expect(turn.params).toMatchObject({
          provider: "openai",
          model: "gpt-test",
          handlingMode: "queue",
        });
      }),
    );
  });

  for (const effort of ["low", "high"] as const) {
    it.effect(
      `delegates cache defaults while retaining ${effort} reasoning on an ordinary turn`,
      () => {
        const f = fixture();
        return run(
          Effect.gen(function* () {
            const adapter = yield* make(f.client);
            const selection = {
              ...startInput.modelSelection,
              options: [
                { id: "reasoning_effort", value: effort },
                { id: "prompt_cache_enabled", value: false },
              ],
            };
            yield* adapter.startSession({ ...startInput, modelSelection: selection });
            // Omitting a new selection preserves restored/session reasoning, while
            // the outbound cache policy cannot inherit the saved opt-out.
            yield* adapter.sendTurn({ threadId, input: "Review", handlingMode: "queue" });
            expect(
              f.calls.find((call) => call.method === "mobs.v1.turnStart")?.params,
            ).toMatchObject({
              provider: "openai",
              model: "gpt-test",
            });
            expect(
              f.calls.find((call) => call.method === "mobs.v1.turnStart")?.params.providerParams,
            ).toEqual({ reasoning_effort: effort });
            expect(f.calls.find((call) => call.method === "models.v1.catalog")?.params).toEqual({
              projectPath: startInput.cwd,
              configStateRoot: expect.stringContaining("/tmp/meerkat-state/projects/"),
            });
            expect(selection.options[1]?.value).toBe(false);
          }),
        );
      },
    );
  }

  it.effect(
    "rejects a missing model catalog before writing a dispatch or starting native work",
    () => {
      const f = fixture();
      const files = new Map<string, string>();
      const client: MeerkatGatewayClient = {
        ...f.client,
        request: (method, params, options) =>
          method === "models.v1.catalog"
            ? Promise.reject(new Error("Catalog unavailable"))
            : f.client.request(method, params, options),
      };
      return run(
        Effect.gen(function* () {
          const adapter = yield* make(client);
          yield* adapter.startSession(startInput);
          const result = yield* Effect.exit(adapter.sendTurn({ threadId, input: "Review" }));
          expect(Exit.isFailure(result)).toBe(true);
          expect([...files.keys()].some((key) => key.includes("t3-dispatch"))).toBe(false);
          expect(f.calls.some((call) => call.method === "mobs.v1.turnStart")).toBe(false);
        }),
        files,
      );
    },
  );

  it.effect(
    "submits native steering without model overrides and preserves the application run",
    () => {
      const f = fixture();
      return run(
        Effect.gen(function* () {
          const adapter = yield* make(f.client);
          yield* adapter.startSession({
            ...startInput,
            modelSelection: {
              ...startInput.modelSelection,
              options: [{ id: "prompt_cache_enabled", value: false }],
            },
          });
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                adapter.sendTurn({ threadId, input: "Idle steer", handlingMode: "steer" }),
              ),
            ),
          ).toBe(true);
          yield* adapter.sendTurn({ threadId, input: "First", handlingMode: "queue" });
          f.setTurn(async () => ({
            runId: "run-1",
            mode: "steering_submitted",
            handlingMode: "steer",
            status: "running",
            runtimeReceipt: { identity: "ingress", handling_mode: "steer" },
          }));
          const steered = yield* adapter.sendTurn({
            threadId,
            input: "Correction",
            handlingMode: "steer",
            steeringTurnId: TurnId.make("run-1"),
            modelSelection: startInput.modelSelection,
          });
          expect(steered.turnId).toBe("run-1");
          expect(f.calls.at(-1)?.params).toMatchObject({
            handlingMode: "steer",
            expectedRunId: "run-1",
            input: "Correction",
          });
          for (const key of ["provider", "model", "providerParams"])
            expect(f.calls.at(-1)?.params).not.toHaveProperty(key);
          expect(f.calls.filter((call) => call.method === "models.v1.catalog")).toHaveLength(1);
          expect((yield* adapter.listSessions())[0]).toMatchObject({
            status: "running",
            activeTurnId: "run-1",
          });
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                adapter.sendTurn({ threadId, input: "Queued", handlingMode: "queue" }),
              ),
            ),
          ).toBe(true);
          f.emit("run.completed");
          f.setTurn(async () => ({ runId: "run-2" }));
          expect(
            (yield* adapter.sendTurn({ threadId, input: "Next", handlingMode: "queue" })).turnId,
          ).toBe("run-2");
        }),
      );
    },
  );

  it.effect("rejects a pinned steering target after a successor run starts", () => {
    const f = fixture();
    return run(
      Effect.gen(function* () {
        const adapter = yield* make(f.client);
        yield* adapter.startSession(startInput);
        yield* adapter.sendTurn({ threadId, input: "First" });
        f.emit("run.completed");
        f.setTurn(async () => ({ runId: "run-2" }));
        yield* adapter.sendTurn({ threadId, input: "Successor" });
        const callsBefore = f.calls.length;
        const result = yield* Effect.exit(
          adapter.sendTurn({
            threadId,
            input: "Correction for the original run",
            handlingMode: "steer",
            steeringTurnId: TurnId.make("run-1"),
          }),
        );
        expect(Exit.isFailure(result)).toBe(true);
        expect(f.calls).toHaveLength(callsBefore);
        expect((yield* adapter.listSessions())[0]).toMatchObject({
          status: "running",
          activeTurnId: "run-2",
        });
      }),
    );
  });

  it.effect("rejects steering model and option changes before runtime mutation", () => {
    const f = fixture();
    return run(
      Effect.gen(function* () {
        const adapter = yield* make(f.client);
        yield* adapter.startSession(startInput);
        yield* adapter.sendTurn({ threadId, input: "First" });
        for (const selection of [
          { ...startInput.modelSelection, model: "anthropic:other" },
          { ...startInput.modelSelection, options: [{ id: "effort", value: "high" }] },
        ]) {
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                adapter.sendTurn({
                  threadId,
                  input: "Correction",
                  handlingMode: "steer",
                  modelSelection: selection,
                }),
              ),
            ),
          ).toBe(true);
        }
        expect(f.calls.filter((call) => call.method === "mobs.v1.turnStart")).toHaveLength(1);
      }),
    );
  });

  it.effect("does not resurrect a run whose terminal precedes the steering receipt", () => {
    const f = fixture();
    return run(
      Effect.gen(function* () {
        const adapter = yield* make(f.client);
        yield* adapter.startSession(startInput);
        yield* adapter.sendTurn({ threadId, input: "First" });
        f.setTurn(async () => {
          f.emit("run.output.complete", { text: "Corrected" });
          f.emit("run.completed");
          return {
            runId: "run-1",
            mode: "steering_submitted",
            handlingMode: "steer",
            status: "running",
            runtimeReceipt: { identity: "ingress", handling_mode: "steer" },
          };
        });
        const receipt = yield* adapter.sendTurn({
          threadId,
          input: "Correction",
          handlingMode: "steer",
        });
        expect(receipt.turnId).toBe("run-1");
        expect((yield* adapter.listSessions())[0]).toMatchObject({ status: "ready" });
        expect((yield* adapter.listSessions())[0]?.activeTurnId).toBeUndefined();
        yield* adapter.stopSession(threadId);
        expect(
          (yield* adapter.startSession({ ...startInput, resumeCursor: receipt.resumeCursor }))
            .status,
        ).toBe("ready");
      }),
    );
  });

  it.effect(
    "retains unknown steering even after the original run terminal and refuses replay",
    () => {
      const f = fixture();
      return run(
        Effect.gen(function* () {
          const adapter = yield* make(f.client);
          const original = yield* adapter.startSession(startInput);
          yield* adapter.sendTurn({ threadId, input: "First" });
          f.setTurn(async () => {
            f.emit("run.completed");
            throw new MeerkatGatewayTransportError("disconnected", "Steering response lost", true);
          });
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                adapter.sendTurn({ threadId, input: "Correction", handlingMode: "steer" }),
              ),
            ),
          ).toBe(true);
          f.emit("run.completed");
          expect(
            Exit.isFailure(yield* Effect.exit(adapter.sendTurn({ threadId, input: "No replay" }))),
          ).toBe(true);
          yield* adapter.stopSession(threadId);
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                adapter.startSession({ ...startInput, resumeCursor: original.resumeCursor }),
              ),
            ),
          ).toBe(true);
          expect(f.calls.filter((call) => call.method === "mobs.v1.turnStart")).toHaveLength(2);
        }),
      );
    },
  );

  it.effect("preserves the original run journal after definite steering rejection", () => {
    const f = fixture();
    return run(
      Effect.gen(function* () {
        const adapter = yield* make(f.client);
        const initial = yield* adapter.startSession(startInput);
        yield* adapter.sendTurn({ threadId, input: "First" });
        f.setTurn(async () => {
          throw new MeerkatGatewayRpcError({
            message: "Rejected before admission",
            rpcCode: -1,
            typedCode: "CONFLICT",
          });
        });
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              adapter.sendTurn({ threadId, input: "Correction", handlingMode: "steer" }),
            ),
          ),
        ).toBe(true);
        expect((yield* adapter.listSessions())[0]).toMatchObject({
          status: "running",
          activeTurnId: "run-1",
        });
        yield* adapter.stopSession(threadId);
        f.setRunStatus("unknown");
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              adapter.startSession({ ...startInput, resumeCursor: initial.resumeCursor }),
            ),
          ),
        ).toBe(true);
        expect(f.calls.findLast((call) => call.method === "mobs.v1.runStatus")?.params.runId).toBe(
          "run-1",
        );
      }),
    );
  });

  it.effect("treats mismatched steering receipts as unknown and retains their marker", () => {
    const f = fixture();
    return run(
      Effect.gen(function* () {
        const adapter = yield* make(f.client);
        const initial = yield* adapter.startSession(startInput);
        yield* adapter.sendTurn({ threadId, input: "First" });
        f.setTurn(async () => ({
          runId: "wrong-run",
          mode: "steering_submitted",
          handlingMode: "steer",
          status: "running",
          runtimeReceipt: { identity: "ingress", handling_mode: "steer" },
        }));
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              adapter.sendTurn({ threadId, input: "Correction", handlingMode: "steer" }),
            ),
          ),
        ).toBe(true);
        yield* adapter.stopSession(threadId);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              adapter.startSession({ ...startInput, resumeCursor: initial.resumeCursor }),
            ),
          ),
        ).toBe(true);
      }),
    );
  });

  it.effect(
    "disposes its native runtime while preserving terminal history and resume identity",
    () => {
      const f = fixture();
      return run(
        Effect.gen(function* () {
          const adapter = yield* make(f.client);
          yield* adapter.startSession(startInput);
          const turn = yield* adapter.sendTurn({ threadId, input: "First" });
          f.emit("run.completed");
          yield* adapter.stopSession(threadId);
          expect(yield* adapter.hasSession(threadId)).toBe(false);
          expect(f.calls.find((call) => call.method === "mobs.v1.destroy")?.params).toMatchObject({
            threadId,
            mobId: f.calls.find((call) => call.method === "mobs.v1.createThreadMob")?.params.mobId,
            agentIdentity: "ingress",
          });
          const restored = yield* adapter.startSession({
            ...startInput,
            resumeCursor: turn.resumeCursor,
          });
          expect(restored.status).toBe("ready");
          const snapshot = yield* adapter.readThread(threadId);
          expect(snapshot.turns[0]?.items).toEqual([{ kind: "message", text: "runtime history" }]);
        }),
      );
    },
  );

  it.effect("retains a session when native cleanup fails so disposal can be retried", () => {
    const f = fixture();
    return run(
      Effect.gen(function* () {
        const adapter = yield* make(f.client);
        yield* adapter.startSession(startInput);
        f.setDispose(async () => ({ cleanupCompleted: false }));
        expect(Exit.isFailure(yield* Effect.exit(adapter.stopSession(threadId)))).toBe(true);
        expect(yield* adapter.hasSession(threadId)).toBe(true);
        f.setDispose(async () => ({ cleanupCompleted: true }));
        yield* adapter.stopSession(threadId);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
      }),
    );
  });

  it.effect("blocks recovery from an unknown run receipt without replaying the prompt", () => {
    const f = fixture();
    return run(
      Effect.gen(function* () {
        const adapter = yield* make(f.client);
        yield* adapter.startSession(startInput);
        const turn = yield* adapter.sendTurn({ threadId, input: "First" });
        yield* adapter.stopSession(threadId);
        f.setRunStatus("unknown");
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              adapter.startSession({ ...startInput, resumeCursor: turn.resumeCursor }),
            ),
          ),
        ).toBe(true);
        expect(f.calls.filter((call) => call.method === "mobs.v1.turnStart")).toHaveLength(1);
        expect(f.calls.filter((call) => call.method === "mobs.v1.createThreadMob")).toHaveLength(1);
      }),
    );
  });

  it.effect("rejects a cursor from another workspace before touching its state", () => {
    const f = fixture();
    return run(
      Effect.gen(function* () {
        const adapter = yield* make(f.client);
        const session = yield* adapter.startSession(startInput);
        yield* adapter.stopSession(threadId);
        const count = f.calls.length;
        const result = yield* Effect.exit(
          adapter.startSession({
            ...startInput,
            cwd: "/tmp/other-project",
            resumeCursor: session.resumeCursor,
          }),
        );
        expect(Exit.isFailure(result)).toBe(true);
        expect(f.calls).toHaveLength(count);
      }),
    );
  });

  it.effect(
    "surfaces runtime cancellation failure and permits retry after a definite RPC rejection",
    () => {
      const f = fixture();
      f.setTurn(async () => {
        throw new MeerkatGatewayRpcError({
          message: "Rejected",
          rpcCode: -1,
          typedCode: "CONFLICT",
        });
      });
      return run(
        Effect.gen(function* () {
          const adapter = yield* make(f.client);
          yield* adapter.startSession(startInput);
          expect(
            Exit.isFailure(yield* Effect.exit(adapter.sendTurn({ threadId, input: "First" }))),
          ).toBe(true);
          f.setTurn(undefined);
          yield* adapter.sendTurn({ threadId, input: "Second" });
          f.setRuntimeCancelled(false);
          expect(Exit.isFailure(yield* Effect.exit(adapter.interruptTurn(threadId)))).toBe(true);
          expect((yield* adapter.listSessions())[0]?.status).toBe("running");
        }),
      );
    },
  );

  it.effect(
    "blocks a dispatch whose response was lost even when T3 retained the earlier cursor",
    () => {
      const f = fixture();
      f.setRunStatus("unknown");
      f.setTurn(async () => {
        throw new MeerkatGatewayTransportError("disconnected", "Response lost", true);
      });
      return run(
        Effect.gen(function* () {
          const adapter = yield* make(f.client);
          const initial = yield* adapter.startSession(startInput);
          expect(
            Exit.isFailure(yield* Effect.exit(adapter.sendTurn({ threadId, input: "Do once" }))),
          ).toBe(true);
          yield* adapter.stopSession(threadId);
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                adapter.startSession({ ...startInput, resumeCursor: initial.resumeCursor }),
              ),
            ),
          ).toBe(true);
          expect(f.calls.filter((call) => call.method === "mobs.v1.turnStart")).toHaveLength(1);
          expect(f.calls.filter((call) => call.method === "mobs.v1.createThreadMob")).toHaveLength(
            1,
          );
        }),
      );
    },
  );

  it.effect("waits for a terminal event after cancellation is requested", () => {
    const f = fixture();
    f.setCancellationRequested();
    return run(
      Effect.gen(function* () {
        const adapter = yield* make(f.client);
        yield* adapter.startSession(startInput);
        yield* adapter.sendTurn({ threadId, input: "Work" });
        yield* adapter.interruptTurn(threadId);
        expect((yield* adapter.listSessions())[0]?.status).toBe("running");
        f.emit("run.cancelled", { message: "Runtime cancellation confirmed" });
        expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
      }),
    );
  });
  it.effect("qualifies models and derives confined project state", () => {
    expect(decodeMeerkatModel("openai:account/model:v2")).toEqual({
      provider: "openai",
      model: "account/model:v2",
    });
    expect(() => decodeMeerkatModel("unqualified")).toThrow();
    return run(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = meerkatProjectStateRoot(path, "/tmp/state", "/tmp/project");
        expect(root.startsWith("/tmp/state/projects/")).toBe(true);
        expect(root).not.toContain("/tmp/project");
      }),
    );
  });
});

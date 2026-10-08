import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import {
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ConsoleIdentityRecord,
  type MeerkatCoordinatorSteer,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Config from "../../config.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import type { MeerkatTeamReader } from "./MeerkatTeamReader.ts";
import { makeMeerkatCoordinatorWorkService } from "./MeerkatCoordinatorWorkService.ts";
const projectId = ProjectId.make("project"),
  instanceId = ProviderInstanceId.make("native"),
  threadId = ThreadId.make("thread");
const target = { projectId, instanceId, threadId };
const control = { ...target, sessionId: "session", inputId: "input", nativeRunId: "run" };
const input: MeerkatCoordinatorSteer = {
  ...control,
  message: { messageId: MessageId.make("message"), text: "Focus on the parser", attachments: [] },
  createdAt: "2026-09-28T10:00:00.000Z",
};
const record: ConsoleIdentityRecord = {
  identity: "ingress",
  runtime_key: "default",
  runtime_member_id: "ingress",
  session_id: "session",
  display_name: "Coordinator",
  visibility: "addressable",
  addressable: true,
  health: "ready",
  labels: {},
};
const receipt = {
  kind: "runtime_input",
  identity: "ingress",
  sessionId: "session",
  inputId: "native-input",
  requestId: "coordinator-steer:thread:message",
  idempotencyKey: "native-key",
  status: "accepted",
};
const base = Layer.mergeAll(NodeServices.layer, SqlitePersistenceMemory);
const config = Config.layerTest("/workspace", { prefix: "coordinator-work-" }).pipe(
  Layer.provide(base),
);
const layers = Layer.mergeAll(base, config, WorkspacePaths.layer.pipe(Layer.provide(base)));
const harness = Effect.fnUntraced(function* () {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const commands: OrchestrationCommand[] = [];
  let enabled = true,
    loseReply = false,
    found = false,
    wrongSession = false,
    live = true,
    providerStateRoot = "/provider";
  let nativeReceipt: Record<string, unknown> = receipt;
  const reader = {
    get stateRoot() {
      return providerStateRoot;
    },
  } as MeerkatTeamReader;
  const instance = {
    instanceId,
    driverKind: ProviderDriverKind.make("meerkat"),
    get enabled() {
      return enabled;
    },
    meerkatTeam: reader,
    meerkatControls: {
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "mobs.v1.coordinatorWork")
          return {
            sessionId: wrongSession ? "replacement" : "session",
            busy: true,
            inputs: [{ inputId: "input", runId: "run", startedAt: null }],
          };
        if (method === "mobs.v1.coordinatorStop")
          return {
            accepted: true,
            sessionId: "session",
            inputId: params.inputId,
            nativeRunId: params.nativeRunId,
          };
        if (method === "mobs.v1.coordinatorSteerReceipt")
          return {
            found,
            ...(found
              ? {
                  receipt: wrongSession
                    ? { ...nativeReceipt, sessionId: "replacement" }
                    : nativeReceipt,
                }
              : {}),
          };
        if (method === "mobs.v1.coordinatorSteer") {
          if (loseReply) throw Error("response lost");
          return { receipt: nativeReceipt };
        }
        throw Error(`Unexpected ${method}`);
      },
    },
  } as ProviderInstance;
  const registry = Layer.mock(ProviderInstanceRegistry)({
    getInstance: () => Effect.succeed(instance),
  });
  const engine = Layer.mock(OrchestrationEngineService)({
    dispatch: (command) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }),
  });
  let targetReads = 0;
  const makeService = () =>
    makeMeerkatCoordinatorWorkService({
      interactionTarget: () => {
        targetReads++;
        if (!live) throw Error("No live roster may be resolved during cold receipt lookup");
        return Effect.succeed({
          projectPath: "/exact/worktree",
          stateRoot: "/exact/state",
          mobId: "mob",
          mobKind: "thread",
          threadId,
          ambiguous: false,
          record,
          reader,
        });
      },
    }).pipe(Effect.provide(Layer.merge(registry, engine)));
  const service = yield* makeService();
  return {
    makeService,
    targetReads: () => targetReads,
    setLive: (value: boolean) => {
      live = value;
    },
    setProviderRoot: (value: string) => {
      providerStateRoot = value;
    },
    service,
    calls,
    commands,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setLoss: (value: boolean) => {
      loseReply = value;
    },
    setFound: (value: boolean) => {
      found = value;
    },
    setWrongSession: () => {
      wrongSession = true;
    },
    setReceipt: (value: Record<string, unknown>) => {
      nativeReceipt = value;
    },
  };
});
it.effect("routes native activity and stop to the exact server-owned workspace and input", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    expect((yield* h.service.work(target)).busy).toBe(true);
    yield* h.service.stop(control);
    expect(h.calls[1]).toMatchObject({
      method: "mobs.v1.coordinatorStop",
      params: {
        projectPath: "/exact/worktree",
        stateRoot: "/exact/state",
        mobId: "mob",
        inputId: "input",
        nativeRunId: "run",
        expected: { sessionId: "session" },
      },
    });
    expect(h.commands).toEqual([]);
    h.setWrongSession();
    expect((yield* Effect.result(h.service.work(target)))._tag).toBe("Failure");
    h.setEnabled(false);
    expect((yield* Effect.result(h.service.stop(control)))._tag).toBe("Failure");
    expect(h.calls).toHaveLength(3);
  }).pipe(Effect.provide(layers), Effect.scoped),
);
it.effect("steers once and appends only a user message, without a synthetic application turn", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    expect((yield* h.service.steer(input)).status).toBe("accepted");
    expect((yield* h.service.steer(input)).status).toBe("accepted");
    expect(h.calls.map((c) => c.method)).toEqual(["mobs.v1.coordinatorSteer"]);
    expect(h.commands.map((c) => c.type)).toEqual(["thread.message.user.append"]);
    expect(
      (yield* Effect.result(
        h.service.steer({ ...input, message: { ...input.message, text: "Changed payload" } }),
      ))._tag,
    ).toBe("Failure");
  }).pipe(Effect.provide(layers), Effect.scoped),
);
it.effect("reconciles a lost acceptance by native receipt without resending work", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    h.setLoss(true);
    expect((yield* h.service.steer(input)).status).toBe("uncertain");
    expect((yield* h.service.steer(input)).status).toBe("uncertain");
    h.setFound(true);
    expect((yield* h.service.steer(input)).status).toBe("accepted");
    expect(h.calls.filter((c) => c.method === "mobs.v1.coordinatorSteer")).toHaveLength(1);
    expect(h.commands).toHaveLength(1);
  }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect(
  "reconciles the exact original request after service restart and roster unload without a second admission",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setLoss(true);
      expect((yield* h.service.steer(input)).status).toBe("uncertain");
      h.setLive(false);
      const restarted = yield* h.makeService();
      h.setFound(true);
      expect((yield* restarted.steer({ ...input, receiptOnly: true })).status).toBe("accepted");
      expect(h.targetReads()).toBe(1);
      expect(h.calls.map((call) => call.method)).toEqual([
        "mobs.v1.coordinatorSteer",
        "mobs.v1.coordinatorSteerReceipt",
      ]);
      expect(h.calls[1]?.params).toMatchObject({
        projectPath: "/exact/worktree",
        stateRoot: "/exact/state",
        mobId: "mob",
        idempotencyKey: "coordinator-steer:thread:message",
        expected: { sessionId: "session" },
      });
      expect(h.commands).toHaveLength(1);
    }).pipe(Effect.provide(layers), Effect.scoped),
);
it.effect(
  "receipt-only checks never submit missing requests or replay absent native acceptance",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setLive(false);
      expect((yield* h.service.steer({ ...input, receiptOnly: true })).status).toBe("uncertain");
      expect(h.targetReads()).toBe(0);
      expect(h.calls).toEqual([]);
      h.setLive(true);
      h.setLoss(true);
      yield* h.service.steer(input);
      h.setLive(false);
      expect((yield* h.service.steer({ ...input, receiptOnly: true })).status).toBe("uncertain");
      expect(h.calls.filter((call) => call.method === "mobs.v1.coordinatorSteer")).toHaveLength(1);
      expect(h.commands).toHaveLength(1);
    }).pipe(Effect.provide(layers), Effect.scoped),
);
it.effect(
  "cold checks reject changed payload, native target, provider storage and disabled connections",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setLoss(true);
      yield* h.service.steer(input);
      h.setLive(false);
      h.setFound(true);
      for (const changed of [
        { ...input, inputId: "new-input" },
        { ...input, sessionId: "replacement" },
        { ...input, message: { ...input.message, text: "Changed" } },
      ])
        expect(
          (yield* Effect.result(h.service.steer({ ...changed, receiptOnly: true })))._tag,
        ).toBe("Failure");
      h.setProviderRoot("/replacement-storage");
      expect((yield* Effect.result(h.service.steer({ ...input, receiptOnly: true })))._tag).toBe(
        "Failure",
      );
      h.setProviderRoot("/provider");
      h.setEnabled(false);
      expect((yield* Effect.result(h.service.steer({ ...input, receiptOnly: true })))._tag).toBe(
        "Failure",
      );
      expect(h.calls).toHaveLength(1);
    }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect("does not accept a mismatched native receipt or fall back to sending", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    h.setLoss(true);
    yield* h.service.steer(input);
    h.setLive(false);
    h.setFound(true);
    h.setWrongSession();
    expect((yield* Effect.result(h.service.steer({ ...input, receiptOnly: true })))._tag).toBe(
      "Failure",
    );
    expect(h.calls.filter((call) => call.method === "mobs.v1.coordinatorSteer")).toHaveLength(1);
  }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect("rejects receipts for another message or identity without another admission", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    h.setLoss(true);
    yield* h.service.steer(input);
    h.setLive(false);
    h.setFound(true);
    for (const changed of [
      { ...receipt, requestId: "another-request" },
      { ...receipt, identity: "another-agent" },
      { ...receipt, inputId: "" },
      { ...receipt, idempotencyKey: "" },
    ]) {
      h.setReceipt(changed);
      expect((yield* Effect.result(h.service.steer({ ...input, receiptOnly: true })))._tag).toBe(
        "Failure",
      );
    }
    expect(h.calls.filter((call) => call.method === "mobs.v1.coordinatorSteer")).toHaveLength(1);
    expect(h.commands).toHaveLength(1);
  }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect("recovers an earlier console receipt without migrating or resending that message", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    h.setLoss(true);
    yield* h.service.steer(input);
    h.setLive(false);
    h.setFound(true);
    const legacy = {
      identity: "ingress",
      session_id: "session",
      input_frame_id: "console-frame",
      interaction_id: "console-interaction",
      cursor: "1",
      status: "delivered",
    };
    h.setReceipt(legacy);
    expect((yield* h.service.steer({ ...input, receiptOnly: true })).receipt).toEqual(legacy);
    expect(h.calls.filter((call) => call.method === "mobs.v1.coordinatorSteer")).toHaveLength(1);
    expect(h.commands).toHaveLength(1);
  }).pipe(Effect.provide(layers), Effect.scoped),
);

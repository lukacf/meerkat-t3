import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  WS_METHODS,
  type ProviderInstanceConfig,
  type ServerConfig,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createServerEnvironmentAtoms,
  ProviderSettingsConflictError,
  ProviderSettingsUnsupportedError,
  type ProviderSettingsIntent,
} from "./server.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("provider-command-environment"),
  label: "Provider command environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const DRIVER = ProviderDriverKind.make("meerkat");
const A = ProviderInstanceId.make("meerkat_a");
const B = ProviderInstanceId.make("meerkat_b");
const C = ProviderInstanceId.make("meerkat_c");
const INSTANCE: ProviderInstanceConfig = { driver: DRIVER, enabled: true };
const INITIAL: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: { [A]: INSTANCE, [B]: INSTANCE, [C]: INSTANCE },
};

class SyntheticSettingsWriteError extends Schema.TaggedError<SyntheticSettingsWriteError>()(
  "SyntheticSettingsWriteError",
  {},
) {}

type Request =
  | { readonly method: "intent"; readonly input: ProviderSettingsIntent }
  | { readonly method: "settings"; readonly input: ServerSettingsPatch };

const makeHarness = Effect.fn("ServerProviderSettingsTest.makeHarness")(function* (
  options: {
    readonly capability?: boolean | "missing";
    readonly connected?: boolean;
    readonly beforeInitialConfig?: Effect.Effect<void>;
    readonly beforeReply?: (
      index: number,
      request: Request,
    ) => Effect.Effect<void, SyntheticSettingsWriteError | ProviderSettingsConflictError>;
  } = {},
) {
  const requests: Request[] = [];
  const events: string[] = [];
  const environmentsUsed: EnvironmentId[] = [];
  const capability = options.capability ?? true;
  const config = {
    settings: INITIAL,
    environment: {
      serverVersion: "0.0.1",
      capabilities: capability === "missing" ? {} : { providerSettingsIntents: capability },
    },
  } as ServerConfig;
  const acknowledged = { ...INITIAL, addProjectBaseDirectory: "/server-acknowledged" };
  const reply = (request: Request) =>
    Effect.gen(function* () {
      requests.push(request);
      const index = requests.length;
      events.push(`start:${index}:${request.method}`);
      yield* options.beforeReply?.(index, request) ?? Effect.void;
      events.push(`ack:${index}:${request.method}`);
      return acknowledged;
    });
  // No provider map composition belongs in the client. Fail if the command
  // attempts to fetch one instead of sending its intent to the server.
  const client = {
    [WS_METHODS.serverGetConfig]: () => Effect.die("Unexpected settings read"),
    [WS_METHODS.serverUpdateProviderSettings]: ({ intent }: { intent: ProviderSettingsIntent }) =>
      reply({ method: "intent", input: intent }),
    [WS_METHODS.serverUpdateSettings]: ({ patch }: { patch: ServerSettingsPatch }) =>
      reply({ method: "settings", input: patch }),
    [WS_METHODS.subscribeServerConfig]: () => Stream.never,
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: (options.beforeInitialConfig ?? Effect.void).pipe(Effect.as(config)),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected",
    }),
    session: yield* SubscriptionRef.make(
      options.connected === false ? Option.none<RpcSession>() : Option.some(session),
    ),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const environments = EnvironmentRegistry.of({
    run: (environmentId, effect) => {
      environmentsUsed.push(environmentId);
      return Effect.provideService(effect, EnvironmentSupervisor, supervisor);
    },
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry["Service"]);
  const cache = EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeedNone,
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry, environments),
      Layer.succeed(EnvironmentCacheStore, cache),
    ),
  );
  const atoms = createServerEnvironmentAtoms(runtime, {
    initialConfigValueAtom: () => Atom.make(config),
  });
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return {
    requests,
    events,
    acknowledged,
    environmentsUsed,
    replaceSessionCapability: (value: boolean) =>
      SubscriptionRef.set(
        supervisor.session,
        Option.some({
          ...session,
          client: value
            ? client
            : ({
                ...client,
                [WS_METHODS.serverUpdateProviderSettings]: () =>
                  Effect.die("Unexpected dispatch to replacement session"),
              } as WsRpcProtocolClient),
          initialConfig: Effect.succeed({
            ...config,
            environment: {
              ...config.environment,
              capabilities: { ...config.environment.capabilities, providerSettingsIntents: value },
            },
          }),
        }),
      ),
    run: (input: ProviderSettingsIntent) =>
      atoms.updateProviderSettings.run(registry, { environmentId: TARGET.environmentId, input }),
    updateSettings: (patch: ServerSettingsPatch) =>
      atoms.updateSettings.run(registry, { environmentId: TARGET.environmentId, input: { patch } }),
  };
});

const edit = (instanceId: ProviderInstanceId): ProviderSettingsIntent => ({
  kind: "edit",
  instanceId,
  driver: DRIVER,
  changes: {
    displayName: "New name",
    config: { set: { binaryPath: "/new/binary" }, remove: ["homePath"] },
  },
});

function failureOf(result: AsyncResult.AsyncResult<unknown, unknown>) {
  expect(AsyncResult.isFailure(result)).toBe(true);
  if (!AsyncResult.isFailure(result)) throw new Error("Expected a command failure");
  expect(Cause.hasDies(result.cause)).toBe(false);
  return Cause.squash(result.cause);
}

it.effect("sends only the requested intent and returns the server acknowledgement", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const intent = edit(A);
      const result = yield* Effect.promise(() => harness.run(intent));
      expect(AsyncResult.isSuccess(result)).toBe(true);
      if (AsyncResult.isSuccess(result)) expect(result.value).toEqual(harness.acknowledged);
      expect(harness.requests).toEqual([{ method: "intent", input: intent }]);
      expect(harness.environmentsUsed).toEqual([TARGET.environmentId]);
    }),
  ),
);

it.effect("waits for acknowledgement before dispatching a second provider intent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        beforeReply: (index) =>
          index === 1
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
      });
      let firstSettled = false;
      const first = harness.run(edit(A)).then((result) => {
        firstSettled = true;
        return result;
      });
      yield* Deferred.await(started);
      const second = harness.run(edit(B));
      expect(firstSettled).toBe(false);
      expect(harness.events).toEqual(["start:1:intent"]);
      yield* Deferred.succeed(release, undefined);
      const results = yield* Effect.promise(() => Promise.all([first, second]));
      expect(results.every(AsyncResult.isSuccess)).toBe(true);
      expect(harness.events).toEqual([
        "start:1:intent",
        "ack:1:intent",
        "start:2:intent",
        "ack:2:intent",
      ]);
      expect(harness.requests).toEqual([
        { method: "intent", input: edit(A) },
        { method: "intent", input: edit(B) },
      ]);
    }),
  ),
);

it.effect("orders provider intents with other settings writes in both directions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        beforeReply: (index) =>
          index === 1
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
      });
      const first = harness.updateSettings({ addProjectBaseDirectory: "/one" });
      yield* Deferred.await(started);
      const second = harness.run(edit(A));
      const third = harness.updateSettings({ addProjectBaseDirectory: "/two" });
      yield* Deferred.succeed(release, undefined);
      const results = yield* Effect.promise(() => Promise.all([first, second, third]));
      expect(results.every(AsyncResult.isSuccess)).toBe(true);
      expect(harness.events).toEqual([
        "start:1:settings",
        "ack:1:settings",
        "start:2:intent",
        "ack:2:intent",
        "start:3:settings",
        "ack:3:settings",
      ]);
    }),
  ),
);

for (const error of [
  new SyntheticSettingsWriteError({}),
  new ProviderSettingsConflictError({ instanceId: A, reason: "instance_missing" }),
]) {
  it.effect(`preserves ${error._tag}, drains later work, and allows the same intent to retry`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          beforeReply: (index) => (index === 1 ? Effect.fail(error) : Effect.void),
        });
        const intent = edit(A);
        const first = harness.run(intent);
        const later = harness.run(edit(B));
        const failed = yield* Effect.promise(() => first);
        expect(failureOf(failed)).toBe(error);
        expect(AsyncResult.isSuccess(yield* Effect.promise(() => later))).toBe(true);
        expect(AsyncResult.isSuccess(yield* Effect.promise(() => harness.run(intent)))).toBe(true);
        expect(harness.requests).toEqual([
          { method: "intent", input: intent },
          { method: "intent", input: edit(B) },
          { method: "intent", input: intent },
        ]);
      }),
    ),
  );
}

for (const capability of [false, "missing"] as const) {
  it.effect(`rejects ${capability} capability without falling back to whole-map updates`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ capability });
        const result = yield* Effect.promise(() => harness.run(edit(A)));
        expect(failureOf(result)).toBeInstanceOf(ProviderSettingsUnsupportedError);
        expect(harness.requests).toEqual([]);
      }),
    ),
  );
}

it.effect("checks the current connection capability instead of stale projected settings", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness({ capability: false });
      yield* harness.replaceSessionCapability(true);
      expect(AsyncResult.isSuccess(yield* Effect.promise(() => harness.run(edit(A))))).toBe(true);
      yield* harness.replaceSessionCapability(false);
      expect(failureOf(yield* Effect.promise(() => harness.run(edit(B))))).toBeInstanceOf(
        ProviderSettingsUnsupportedError,
      );
      expect(harness.requests).toHaveLength(1);
    }),
  ),
);

it.effect("reports a disconnected environment without attempting an RPC", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness({ connected: false });
      const result = yield* Effect.promise(() => harness.run(edit(A)));
      expect(failureOf(result)).toBeInstanceOf(EnvironmentRpcUnavailableError);
      expect(failureOf(result)).toMatchObject({ environmentId: TARGET.environmentId });
      expect(harness.requests).toEqual([]);
    }),
  ),
);

it.effect(
  "dispatches through the checked session when reconnection happens during initial config",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          beforeInitialConfig: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        });
        const saving = harness.run(edit(A));
        yield* Deferred.await(started);
        yield* harness.replaceSessionCapability(false);
        yield* Deferred.succeed(release, undefined);
        expect(AsyncResult.isSuccess(yield* Effect.promise(() => saving))).toBe(true);
        expect(harness.requests).toEqual([{ method: "intent", input: edit(A) }]);
        expect(failureOf(yield* Effect.promise(() => harness.run(edit(B))))).toBeInstanceOf(
          ProviderSettingsUnsupportedError,
        );
        expect(harness.requests).toHaveLength(1);
      }),
    ),
);

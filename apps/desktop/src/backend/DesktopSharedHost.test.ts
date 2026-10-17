import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopSharedHost from "./DesktopSharedHost.ts";

function harness(
  options: { enabled?: boolean; port?: number; available?: boolean; localEnabled?: boolean } = {},
) {
  const starts: string[] = [];
  const stops: string[] = [];
  const ports: number[] = [];
  const instances = new Map<
    DesktopBackendPool.BackendInstanceId,
    DesktopBackendPool.DesktopBackendInstance
  >();
  const layer = DesktopSharedHost.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        DesktopAppSettings.layerTest({
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          localEnvironmentEnabled: options.localEnabled ?? true,
          sharedHostEnabled: options.enabled ?? false,
          sharedHostPort: options.port ?? null,
        }),
        DesktopEnvironment.layer({
          dirname: "/fixture/apps/desktop/src",
          homeDirectory: "/fixture/home",
          platform: "darwin",
          processArch: "arm64",
          appVersion: "0.1.0",
          appPath: "/fixture/app",
          isPackaged: true,
          resourcesPath: "/fixture/resources",
          runningUnderArm64Translation: false,
        }).pipe(Layer.provide(Layer.merge(NodeServices.layer, DesktopConfig.layerTest({})))),
        Layer.mock(DesktopServerExposure.DesktopServerExposure, {
          backendConfig: Effect.succeed({
            port: 50000,
            bindHost: "0.0.0.0",
            httpBaseUrl: new URL("http://127.0.0.1:50000"),
            tailscaleServeEnabled: false,
            tailscaleServePort: 443,
          }),
        }),
        Layer.mock(NetService.NetService, {
          canListenOnHost: () => Effect.succeed(options.available ?? true),
        }),
        Layer.mock(DesktopBackendConfiguration.DesktopBackendConfiguration, {
          resolveSharedHost: (port) => {
            ports.push(port);
            return Effect.die("pool fixture does not spawn");
          },
        }),
        Layer.mock(DesktopBackendPool.DesktopBackendPool, {
          get: (id) => Effect.sync(() => Option.fromNullishOr(instances.get(id))),
          unregister: (id) =>
            Effect.sync(() => {
              if (instances.has(id)) stops.push(id);
              instances.delete(id);
            }),
          register: (spec) =>
            Effect.sync(() => {
              let running = false;
              const instance: DesktopBackendPool.DesktopBackendInstance = {
                id: spec.id,
                label: spec.label,
                start: Effect.sync(() => {
                  starts.push(spec.id);
                  running = true;
                }),
                stop: () => Effect.void,
                currentConfig: Effect.succeedNone,
                snapshot: Effect.sync(() => ({
                  ready: running,
                  desiredRunning: running,
                  activePid: running ? Option.some(2) : Option.none(),
                  restartAttempt: 0,
                  restartScheduled: false,
                })),
                waitForReady: () => Effect.succeed(running),
              };
              assert.isFalse(instances.has(spec.id));
              instances.set(spec.id, instance);
              return instance;
            }),
        }),
      ),
    ),
  );
  return { layer, starts, stops, ports };
}

describe("desktop shared host", () => {
  it.effect("explains a disabled local environment before startup reconciliation", () => {
    const h = harness({ enabled: true, port: 53005, localEnabled: false });
    return Effect.gen(function* () {
      const host = yield* DesktopSharedHost.DesktopSharedHost;
      const state = yield* host.state;
      assert.equal(state.status, "unavailable");
      assert.include(state.error!, "Enable this Mac's local environment");
      yield* host.reconcile;
      assert.equal((yield* host.state).status, "unavailable");
      assert.deepEqual(h.starts, []);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("does not launch a host without opt-in", () => {
    const h = harness();
    return Effect.gen(function* () {
      const host = yield* DesktopSharedHost.DesktopSharedHost;
      yield* host.reconcile;
      assert.equal((yield* host.state).status, "stopped");
      assert.deepEqual(h.starts, []);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("serializes repeated starts and stops only its own instance", () => {
    const h = harness();
    return Effect.gen(function* () {
      const host = yield* DesktopSharedHost.DesktopSharedHost;
      yield* Effect.all([host.setEnabled(true), host.setEnabled(true)], {
        concurrency: "unbounded",
      });
      assert.equal((yield* host.state).status, "running");
      assert.deepEqual(h.starts, [DesktopSharedHost.INSTANCE_ID]);
      assert.deepEqual(h.ports, [50001]);
      yield* host.setEnabled(false);
      assert.equal((yield* host.state).status, "stopped");
      assert.deepEqual(h.stops, [DesktopSharedHost.INSTANCE_ID]);
      yield* host.setEnabled(true);
      assert.deepEqual(h.ports, [50001, 50001]);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("restores the saved host port independently of the primary's address", () => {
    const h = harness({ enabled: true, port: 53005 });
    return Effect.gen(function* () {
      const host = yield* DesktopSharedHost.DesktopSharedHost;
      yield* host.reconcile;
      assert.deepEqual(h.ports, [53005]);
      assert.equal((yield* host.state).status, "running");
    }).pipe(Effect.provide(h.layer));
  });
  it.effect(
    "refuses an occupied saved port without moving the host or touching another process",
    () => {
      const h = harness({ enabled: true, port: 53005, available: false });
      return Effect.gen(function* () {
        const host = yield* DesktopSharedHost.DesktopSharedHost;
        yield* host.reconcile;
        assert.equal((yield* host.state).status, "unavailable");
        assert.include((yield* host.state).error!, "53005");
        assert.deepEqual(h.starts, []);
        assert.deepEqual(h.stops, []);
        assert.deepEqual(h.ports, []);
      }).pipe(Effect.provide(h.layer));
    },
  );
});

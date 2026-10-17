import { SHARED_LOCAL_ENVIRONMENT_ID, type DesktopSharedHostState } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";

export const INSTANCE_ID = DesktopBackendPool.BackendInstanceId(SHARED_LOCAL_ENVIRONMENT_ID);

export class DesktopSharedHost extends Context.Service<
  DesktopSharedHost,
  {
    readonly state: Effect.Effect<DesktopSharedHostState>;
    readonly reconcile: Effect.Effect<void>;
    readonly setEnabled: (
      enabled: boolean,
    ) => Effect.Effect<DesktopSharedHostState, DesktopAppSettings.DesktopSettingsWriteError>;
  }
>()("@t3tools/desktop/backend/DesktopSharedHost") {}

/** One opt-in, loopback-only host, supervised by the existing desktop process pool. */
export const layer = Layer.effect(
  DesktopSharedHost,
  Effect.gen(function* () {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
    const exposure = yield* DesktopServerExposure.DesktopServerExposure;
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const net = yield* NetService.NetService;
    const mutex = yield* Semaphore.make(1);
    const error = yield* Ref.make<string | null>(null);
    const stopping = yield* Ref.make(false);

    const state = Effect.gen(function* () {
      const current = yield* settings.get;
      const instance = yield* pool.get(INSTANCE_ID);
      const detail = yield* Ref.get(error);
      if (yield* Ref.get(stopping))
        return { enabled: current.sharedHostEnabled, status: "stopping" as const, error: detail };
      if (!current.sharedHostEnabled)
        return { enabled: false, status: "stopped" as const, error: detail };
      if (!current.localEnvironmentEnabled || environment.platform !== "darwin")
        return {
          enabled: true,
          status: "unavailable" as const,
          error: "Enable this Mac's local environment before starting a shared host.",
        };
      if (detail) return { enabled: true, status: "unavailable" as const, error: detail };
      if (Option.isNone(instance))
        return { enabled: true, status: "starting" as const, error: null };
      const snapshot = yield* instance.value.snapshot;
      return {
        enabled: true,
        status: snapshot.ready
          ? ("running" as const)
          : snapshot.desiredRunning || snapshot.restartScheduled
            ? ("starting" as const)
            : ("unavailable" as const),
        error:
          !snapshot.ready && !snapshot.desiredRunning && !snapshot.restartScheduled
            ? "The shared host stopped. Retry to reconnect to its saved workspace."
            : null,
      };
    });

    const reconcileBody = Effect.gen(function* () {
      const current = yield* settings.get;
      const existing = yield* pool.get(INSTANCE_ID);
      if (!current.sharedHostEnabled) {
        yield* Ref.set(stopping, true);
        yield* pool.unregister(INSTANCE_ID).pipe(Effect.ensuring(Ref.set(stopping, false)));
        yield* Ref.set(error, null);
        return;
      }
      if (!current.localEnvironmentEnabled || environment.platform !== "darwin") {
        yield* Ref.set(error, "Enable this Mac's local environment before starting a shared host.");
        return;
      }
      if (Option.isSome(existing)) {
        const snapshot = yield* existing.value.snapshot;
        if (!snapshot.ready && Option.isNone(snapshot.activePid) && !snapshot.restartScheduled) {
          yield* Ref.set(error, null);
          yield* existing.value.start;
        }
        return;
      }
      let port = current.sharedHostPort;
      if (port === null) {
        const primary = yield* exposure.backendConfig;
        const start = Math.max(1024, primary.port === 65535 ? 49152 : primary.port + 1);
        for (let candidate = start; candidate < Math.min(start + 128, 65536); candidate++) {
          if (yield* net.canListenOnHost(candidate, "127.0.0.1")) {
            port = candidate;
            break;
          }
        }
        if (port === null) {
          yield* Ref.set(
            error,
            "No local port is available for the shared host. Free a port and retry.",
          );
          return;
        }
        // Keep the address stable for saved local-task grants across app restarts.
        yield* settings.setSharedHost({ enabled: true, port });
      } else if (!(yield* net.canListenOnHost(port, "127.0.0.1"))) {
        yield* Ref.set(
          error,
          `The shared host's port ${port} is in use. Close the other listener and retry.`,
        );
        return;
      }
      yield* Ref.set(error, null);
      const instance = yield* pool.register({
        id: INSTANCE_ID,
        label: Effect.succeed("Shared specialists on this Mac"),
        configResolve: configuration.resolveSharedHost(port),
        onReady: () => Ref.set(error, null),
      });
      yield* instance.start;
    }).pipe(Effect.catch((cause) => Ref.set(error, cause.message)));

    return DesktopSharedHost.of({
      state,
      reconcile: reconcileBody.pipe(mutex.withPermit),
      setEnabled: (enabled) =>
        Effect.gen(function* () {
          const current = yield* settings.get;
          yield* settings.setSharedHost({ enabled, port: current.sharedHostPort });
          yield* reconcileBody;
          return yield* state;
        }).pipe(mutex.withPermit),
    });
  }),
);

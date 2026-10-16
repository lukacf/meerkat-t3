import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import * as ResetCreditCoordinator from "../Layers/resetCreditCoordinator.ts";
import * as ModelManifest from "../ModelManifest.ts";
import type { ProviderDriver } from "../ProviderDriver.ts";
import { ClaudeDriver } from "./ClaudeDriver.ts";
import { CodexDriver, type CodexDriverEnv } from "./CodexDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-donor-manifest-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(ResetCreditCoordinator.layerTest),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Driver checks must not make an HTTP request")),
    ),
  ),
);

it.layer(testLayer)("donor driver manifest refresh", (it) => {
  const testDriver = <Config extends { readonly homePath: string; readonly binaryPath: string }>(
    driver: ProviderDriver<Config, CodexDriverEnv>,
  ) => {
    for (const enabled of [false, true]) {
      it.effect(
        `${driver.driverKind}: ${enabled ? "enabled" : "disabled"} startup and refresh`,
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-driver-manifest-" });
            const refreshes = yield* Ref.make(0);
            const reads = yield* Ref.make(0);
            const startupProbe = yield* Deferred.make<void>();
            const processAttempts = yield* Ref.make(0);
            const manifest = ModelManifest.ModelManifest.of({
              current: Effect.gen(function* () {
                const count = yield* Ref.updateAndGet(reads, (value) => value + 1);
                // Initial classification reads once; the next read is the startup check.
                if (count >= 2) yield* Deferred.succeed(startupProbe, undefined);
                return ModelManifest.BUNDLED_MODEL_MANIFEST;
              }),
              refresh: Effect.die("Driver must use the background refresh boundary"),
              forceRefresh: Effect.die("Driver must not force a remote manifest refresh"),
              refreshInBackground: Ref.update(refreshes, (value) => value + 1),
            });
            const spawner = ChildProcessSpawner.make(() =>
              Ref.update(processAttempts, (value) => value + 1).pipe(
                Effect.andThen(
                  Effect.fail(
                    PlatformError.systemError({
                      _tag: "NotFound",
                      module: "ChildProcess",
                      method: "spawn",
                      description: "Fixture executable is unavailable",
                    }),
                  ),
                ),
              ),
            );
            const instance = yield* driver
              .create({
                instanceId: ProviderInstanceId.make(`${driver.driverKind}-manifest`),
                displayName: undefined,
                environment: [],
                enabled,
                config: {
                  ...driver.defaultConfig(),
                  homePath: path.join(root, "home"),
                  binaryPath: path.join(root, "missing-provider"),
                },
              })
              .pipe(
                Effect.provide(
                  Layer.mergeAll(
                    Layer.succeed(ModelManifest.ModelManifest, manifest),
                    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
                  ),
                ),
              );

            yield* Deferred.await(startupProbe);
            expect(yield* Ref.get(refreshes)).toBe(enabled ? 1 : 0);
            const snapshot = yield* instance.snapshot.refresh;
            expect(snapshot.enabled).toBe(enabled);
            expect(yield* Ref.get(refreshes)).toBe(enabled ? 2 : 0);
            expect(yield* Ref.get(processAttempts)).toBe(enabled ? 2 : 0);
          }).pipe(Effect.scoped),
      );
    }
  };
  testDriver(CodexDriver);
  testDriver(ClaudeDriver);
});

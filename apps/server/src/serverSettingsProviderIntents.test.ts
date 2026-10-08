import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSettingsConflictError,
  ProviderSettingsIntent,
  ServerSettings,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import * as Settings from "./serverSettings.ts";

const isProviderSettingsConflict = Schema.is(ProviderSettingsConflictError);
const A = ProviderInstanceId.make("custom_a");
const B = ProviderInstanceId.make("custom_b");
const DRIVER = ProviderDriverKind.make("fork");
const decodeIntent = Schema.decodeUnknownEffect(ProviderSettingsIntent);
const decodeDisk = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings));

const makeHarness = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let gate = false;
  let fail = false;
  const gatedFs = FileSystem.FileSystem.of({
    ...fs,
    rename: (from, to) =>
      Effect.gen(function* () {
        if (to.endsWith("/settings.json")) {
          if (gate) {
            gate = false;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
          if (fail)
            return yield* PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "rename",
              description: "Synthetic settings write failure.",
            });
        }
        return yield* fs.rename(from, to);
      }),
  });
  const layer = Settings.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3-provider-intents-" })),
    ),
    Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, gatedFs)),
  );
  return {
    layer,
    entered,
    release,
    gate: () => {
      gate = true;
    },
    fail: (value: boolean) => {
      fail = value;
    },
  };
});

const seed = Effect.gen(function* () {
  const service = yield* Settings.ServerSettingsService;
  yield* service.updateSettings({
    providerInstances: {
      [A]: {
        driver: DRIVER,
        enabled: true,
        config: { keep: { opaque: true }, obsolete: true },
        environment: [{ name: "SYNTHETIC_KEY", value: "synthetic-private-value", sensitive: true }],
      },
      [B]: { driver: DRIVER, enabled: true, config: ["opaque-sibling"] },
    },
  });
  return service;
});
const intent = Effect.fnUntraced(function* (
  service: Settings.ServerSettingsService["Service"],
  input: unknown,
) {
  return yield* service.updateProviderSettings(yield* decodeIntent(input));
});
const readDisk = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  return yield* fs.readFileString(config.settingsPath).pipe(Effect.flatMap(decodeDisk));
});

it.layer(NodeServices.layer)("atomic provider settings intents", (it) => {
  it.effect(
    "composes independent edits after the first write and preserves secret refs and siblings",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* Effect.gen(function* () {
          const service = yield* seed;
          h.gate();
          const first = yield* intent(service, {
            kind: "edit",
            instanceId: A,
            driver: DRIVER,
            changes: { displayName: "First", config: { set: { first: 1 } } },
          }).pipe(Effect.forkChild);
          yield* Deferred.await(h.entered);
          const secondStarted = yield* Deferred.make<void>();
          const second = yield* Deferred.succeed(secondStarted, undefined).pipe(
            Effect.andThen(
              intent(service, {
                kind: "edit",
                instanceId: A,
                driver: DRIVER,
                changes: {
                  accentColor: "blue",
                  config: { set: { second: 2 }, remove: ["obsolete"] },
                },
              }),
            ),
            Effect.forkChild,
          );
          yield* Deferred.await(secondStarted);
          yield* Deferred.succeed(h.release, undefined);
          yield* Fiber.join(first);
          const result = yield* Fiber.join(second);
          assert.deepInclude(result.providerInstances[A], {
            displayName: "First",
            accentColor: "blue",
            config: { keep: { opaque: true }, first: 1, second: 2 },
          });
          assert.equal(
            result.providerInstances[A]?.environment?.[0]?.value,
            "synthetic-private-value",
          );
          assert.deepEqual(result.providerInstances[B]?.config, ["opaque-sibling"]);
          const disk = yield* readDisk;
          assert.deepEqual(disk.providerInstances[A]?.config, result.providerInstances[A]?.config);
          assert.equal(disk.providerInstances[A]?.environment?.[0]?.value, "");
          assert.isTrue(disk.providerInstances[A]?.environment?.[0]?.valueRedacted);
        }).pipe(Effect.ensuring(Deferred.succeed(h.release, undefined)), Effect.provide(h.layer));
      }),
  );

  it.effect(
    "does not resurrect an instance when an independent edit follows its in-flight deletion",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* Effect.gen(function* () {
          const service = yield* seed;
          h.gate();
          const deletion = yield* intent(service, { kind: "delete", instanceId: A }).pipe(
            Effect.forkChild,
          );
          yield* Deferred.await(h.entered);
          const started = yield* Deferred.make<void>();
          const edit = yield* Deferred.succeed(started, undefined).pipe(
            Effect.andThen(
              intent(service, {
                kind: "edit",
                instanceId: A,
                driver: DRIVER,
                changes: { enabled: false },
              }),
            ),
            Effect.result,
            Effect.forkChild,
          );
          yield* Deferred.await(started);
          yield* Deferred.succeed(h.release, undefined);
          yield* Fiber.join(deletion);
          const result = yield* Fiber.join(edit);
          assert.isTrue(
            result._tag === "Failure" &&
              isProviderSettingsConflict(result.failure) &&
              result.failure.reason === "instance_missing",
          );
          const later = yield* intent(service, {
            kind: "edit",
            instanceId: B,
            driver: DRIVER,
            changes: { displayName: "Still editable" },
          });
          assert.notProperty(later.providerInstances, A);
          assert.equal(later.providerInstances[B]?.displayName, "Still editable");
          assert.notProperty((yield* readDisk).providerInstances, A);
        }).pipe(Effect.ensuring(Deferred.succeed(h.release, undefined)), Effect.provide(h.layer));
      }),
  );

  it.effect("admits exactly one of two independent adds with the same ID", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* seed;
        const id = ProviderInstanceId.make("new_instance");
        h.gate();
        const first = yield* intent(service, {
          kind: "add",
          instanceId: id,
          instance: { driver: DRIVER, displayName: "First" },
        }).pipe(Effect.forkChild);
        yield* Deferred.await(h.entered);
        const started = yield* Deferred.make<void>();
        const second = yield* Deferred.succeed(started, undefined).pipe(
          Effect.andThen(
            intent(service, {
              kind: "add",
              instanceId: id,
              instance: { driver: DRIVER, displayName: "Second" },
            }),
          ),
          Effect.result,
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        yield* Deferred.succeed(h.release, undefined);
        yield* Fiber.join(first);
        const result = yield* Fiber.join(second);
        assert.isTrue(
          result._tag === "Failure" &&
            isProviderSettingsConflict(result.failure) &&
            result.failure.reason === "instance_exists",
        );
        assert.equal((yield* readDisk).providerInstances[id]?.displayName, "First");
      }).pipe(Effect.ensuring(Deferred.succeed(h.release, undefined)), Effect.provide(h.layer));
    }),
  );

  it.effect(
    "rolls back a failed filesystem write and allows the next intent to use current state",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* Effect.gen(function* () {
          const service = yield* seed;
          const before = yield* readDisk;
          h.fail(true);
          const failed = yield* intent(service, {
            kind: "edit",
            instanceId: A,
            driver: DRIVER,
            changes: {
              displayName: "Not saved",
              environment: [
                { name: "SYNTHETIC_KEY", value: "synthetic-replacement", sensitive: true },
              ],
            },
          }).pipe(Effect.result);
          assert.isTrue(failed._tag === "Failure");
          assert.deepEqual(yield* readDisk, before);
          const current = yield* service.getSettings;
          assert.isUndefined(current.providerInstances[A]?.displayName);
          assert.equal(
            current.providerInstances[A]?.environment?.[0]?.value,
            "synthetic-private-value",
          );
          h.fail(false);
          const retry = yield* intent(service, {
            kind: "edit",
            instanceId: A,
            driver: DRIVER,
            changes: { displayName: "Saved" },
          });
          assert.equal(retry.providerInstances[A]?.displayName, "Saved");
          assert.equal(
            retry.providerInstances[A]?.environment?.[0]?.value,
            "synthetic-private-value",
          );
        }).pipe(Effect.provide(h.layer));
      }),
  );

  it.effect("publishes committed cache state before releasing an interrupted writer's lock", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* seed;
        h.gate();
        const first = yield* intent(service, {
          kind: "edit",
          instanceId: A,
          driver: DRIVER,
          changes: { displayName: "Committed" },
        }).pipe(Effect.forkChild);
        yield* Deferred.await(h.entered);
        const interrupted = yield* Fiber.interrupt(first).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(h.release, undefined);
        yield* Fiber.join(interrupted);
        const firstExit = yield* Fiber.await(first);
        assert.isTrue(Exit.isFailure(firstExit) && Cause.hasInterrupts(firstExit.cause));
        const next = yield* intent(service, {
          kind: "edit",
          instanceId: A,
          driver: DRIVER,
          changes: { accentColor: "green" },
        });
        assert.equal(next.providerInstances[A]?.displayName, "Committed");
        assert.equal((yield* readDisk).providerInstances[A]?.displayName, "Committed");
      }).pipe(Effect.ensuring(Deferred.succeed(h.release, undefined)), Effect.provide(h.layer));
    }),
  );
});

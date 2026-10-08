import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsError,
  type ProviderInstanceConfigMap,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderInstanceRegistryMutator } from "../Services/ProviderInstanceRegistryMutator.ts";
import { ProviderInstanceSettingsReconciler } from "../Services/ProviderInstanceSettingsReconciler.ts";
import { ProviderInstanceSettingsReconcilerLive } from "./ProviderInstanceRegistryHydration.ts";

const fixtureId = ProviderInstanceId.make("fixture");

const settings = (revision: number): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    [fixtureId]: { driver: ProviderDriverKind.make("fixture"), config: { revision } },
  },
});

const testLayer = (
  getSettings: ServerSettingsService["Service"]["getSettings"],
  changes: PubSub.PubSub<ServerSettings>,
  reconcile: ProviderInstanceRegistryMutator["Service"]["reconcile"],
) =>
  ProviderInstanceSettingsReconcilerLive.pipe(
    Layer.provide(
      Layer.succeed(ServerSettingsService, {
        start: Effect.void,
        ready: Effect.void,
        getSettings,
        updateProviderSettings: () => Effect.die("Unexpected provider settings mutation"),
        updateSettings: () => Effect.die("Unexpected settings mutation"),
        streamChanges: Stream.fromPubSub(changes),
        subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
      }),
    ),
    Layer.provide(Layer.succeed(ProviderInstanceRegistryMutator, { reconcile })),
  );

describe("provider settings reconciliation", () => {
  it.effect("awaits application of the currently saved settings before returning", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(settings(1));
      const changes = yield* PubSub.unbounded<ServerSettings>();
      const started = yield* Deferred.make<ProviderInstanceConfigMap>();
      const release = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const reconcile = (config: ProviderInstanceConfigMap) =>
        Deferred.succeed(started, config).pipe(Effect.andThen(Deferred.await(release)));

      yield* Effect.gen(function* () {
        const service = yield* ProviderInstanceSettingsReconciler;
        // Saving settings need not wait for the asynchronous change subscriber.
        yield* Ref.set(current, settings(2));
        const refresh = yield* service.reconcileCurrentSettings.pipe(
          Effect.andThen(Deferred.succeed(finished, undefined)),
          Effect.forkChild,
        );
        const applied = yield* Deferred.await(started);
        expect(applied[fixtureId]?.config).toEqual({ revision: 2 });
        expect(yield* Deferred.isDone(finished)).toBe(false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(refresh);
        expect(yield* Deferred.isDone(finished)).toBe(true);
      }).pipe(Effect.provide(testLayer(Ref.get(current), changes, reconcile)));
    }),
  );

  it.effect("reads current settings when an older change notification is consumed", () =>
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<ServerSettings>();
      const applied = yield* Deferred.make<ProviderInstanceConfigMap>();
      yield* Effect.gen(function* () {
        yield* ProviderInstanceSettingsReconciler;
        yield* PubSub.publish(changes, settings(1));
        const config = yield* Deferred.await(applied);
        expect(config[fixtureId]?.config).toEqual({ revision: 2 });
      }).pipe(
        Effect.provide(
          testLayer(Effect.succeed(settings(2)), changes, (config) =>
            Deferred.succeed(applied, config).pipe(Effect.asVoid),
          ),
        ),
      );
    }),
  );

  it.effect("propagates settings read failures without reconciling a fallback configuration", () =>
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<ServerSettings>();
      const error = new ServerSettingsError({
        settingsPath: "fixture-settings.json",
        operation: "read-secret",
        cause: "fixture secret unavailable",
      });
      yield* Effect.gen(function* () {
        const service = yield* ProviderInstanceSettingsReconciler;
        expect(yield* service.reconcileCurrentSettings.pipe(Effect.flip)).toBe(error);
      }).pipe(
        Effect.provide(
          testLayer(Effect.fail(error), changes, () =>
            Effect.die("Failed settings must not replace live instances"),
          ),
        ),
      );
    }),
  );
});

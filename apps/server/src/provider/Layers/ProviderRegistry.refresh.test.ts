import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ModelManifest from "../ModelManifest.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { ProviderRegistryLive } from "./ProviderRegistry.ts";

const instanceId = ProviderInstanceId.make("codex");
const driverKind = ProviderDriverKind.make("codex");
const provider: ServerProvider = {
  instanceId,
  driver: driverKind,
  status: "ready",
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  checkedAt: "2026-10-04T10:00:00.000Z",
  version: "1.0.0",
  models: [],
  slashCommands: [],
  skills: [],
};

const instance = (refresh: Effect.Effect<ServerProvider>): ProviderInstance => ({
  instanceId,
  driverKind,
  continuationIdentity: { driverKind, continuationKey: "fixture" },
  displayName: undefined,
  enabled: true,
  snapshot: {
    resolveMaintenance: () =>
      Effect.succeed(
        makeManualOnlyProviderMaintenanceCapabilities({ provider: driverKind, packageName: null }),
      ),
    getSnapshot: Effect.succeed(provider),
    refresh,
    streamChanges: Stream.empty,
    applyUsageLimits: () => Effect.void,
  },
  adapter: {} as ProviderInstance["adapter"],
  textGeneration: {} as ProviderInstance["textGeneration"],
});

const testLayer = (
  instances: Ref.Ref<ReadonlyArray<ProviderInstance>>,
  unavailable: Ref.Ref<ReadonlyArray<ServerProvider>>,
) =>
  ProviderRegistryLive.pipe(
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry, {
        getInstance: (id) =>
          Ref.get(instances).pipe(
            Effect.map((current) => current.find((item) => item.instanceId === id)),
          ),
        listInstances: Ref.get(instances),
        listUnavailable: Ref.get(unavailable),
        // Hold the notification consumer behind the refresh RPC. This models
        // the ordering gap without scheduler sleeps or real provider processes.
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
      }),
    ),
    Layer.provide(ModelManifest.layerTest),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-provider-refresh-current-" }),
    ),
    Layer.provide(NodeServices.layer),
  );

describe("provider refresh after settings reconciliation", () => {
  for (const target of ["instance", "kind", "all"] as const) {
    it.effect(
      `refreshes the replacement driver before change notifications arrive (${target})`,
      () =>
        Effect.gen(function* () {
          const refreshes: string[] = [];
          const old = instance(
            Effect.sync(() => {
              refreshes.push("old");
              return provider;
            }),
          );
          const nextProvider = { ...provider, checkedAt: "2026-10-04T10:01:00.000Z" };
          const replacement = instance(
            Effect.sync(() => {
              refreshes.push("new");
              return nextProvider;
            }),
          );
          const current = yield* Ref.make<ReadonlyArray<ProviderInstance>>([old]);
          const unavailable = yield* Ref.make<ReadonlyArray<ServerProvider>>([]);
          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry;
            yield* Ref.set(current, [replacement]);
            const refreshed = yield* target === "instance"
              ? registry.refreshInstance(instanceId)
              : registry.refresh(target === "kind" ? driverKind : undefined);
            expect(refreshes).toEqual(["new"]);
            expect(refreshed[0]?.checkedAt).toBe(nextProvider.checkedAt);
          }).pipe(Effect.provide(testLayer(current, unavailable)));
        }),
    );
  }

  it.effect(
    "returns an unavailable or removed instance instead of its retired ready snapshot",
    () =>
      Effect.gen(function* () {
        const current = yield* Ref.make<ReadonlyArray<ProviderInstance>>([
          instance(Effect.die("Retired instance must not be refreshed")),
        ]);
        const unavailable = yield* Ref.make<ReadonlyArray<ServerProvider>>([]);
        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry;
          yield* Ref.set(current, []);
          yield* Ref.set(unavailable, [
            {
              ...provider,
              status: "error",
              installed: false,
              auth: { status: "unknown" },
              unavailableReason: "The replacement configuration is invalid.",
            },
          ]);
          const refreshed = yield* registry.refreshInstance(instanceId);
          expect(refreshed).toHaveLength(1);
          expect(refreshed[0]?.status).toBe("error");
          expect(refreshed[0]?.installed).toBe(false);
          yield* Ref.set(unavailable, []);
          expect(yield* registry.refreshInstance(instanceId)).toEqual([]);
        }).pipe(Effect.provide(testLayer(current, unavailable)));
      }),
  );
});

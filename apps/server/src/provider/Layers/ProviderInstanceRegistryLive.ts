/**
 * ProviderInstanceRegistryLive — runtime implementation of
 * `ProviderInstanceRegistry` plus its sibling mutator.
 *
 * Materializes every entry in a `ProviderInstanceConfigMap`:
 *
 *   - When the entry's `driver` matches a registered driver, the registry
 *     decodes the opaque `config` envelope through `driver.configSchema`
 *     and calls `driver.create()` inside a fresh child scope. The
 *     resulting `ProviderInstance` is stored keyed by instance id,
 *     alongside its scope so the entry can be torn down independently.
 *   - When the entry's `driver` is unknown to this build (fork, rollback,
 *     in-flight PR branch), the registry emits an `"unavailable"` shadow
 *     `ServerProvider` snapshot instead of failing. This is what makes
 *     downgrades and fork-hopping safe per the
 *     `forward/backward compatibility invariant` in
 *     `packages/contracts/src/providerInstance.ts`.
 *   - When the entry's config fails schema decode, the registry logs and
 *     emits a shadow snapshot with the schema detail — same bucket as an
 *     unknown driver.
 *
 * Unlike the pre-Slice-D layer, the registry now holds mutable state
 * (`Ref`s + `PubSub`) and exposes an internal mutator
 * (`ProviderInstanceRegistryMutator`) whose `reconcile` method diffs a
 * fresh config map against the live state, tearing down removed instances
 * and building new ones without disturbing unaffected instances.
 *
 * Every live instance runs inside its own child `Scope`. The registry's
 * own scope owns all child scopes via finalizers, so closing the registry
 * tears independent instances down concurrently; closing a single instance
 * (via `reconcile` removing it) leaves the rest untouched.
 *
 * @module provider/Layers/ProviderInstanceRegistryLive
 */
import {
  providerInstanceConfigEnabledFlag,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { buildUnavailableProviderSnapshot } from "../unavailableProviderSnapshot.ts";
import {
  ProviderInstanceRegistry,
  type ProviderInstanceRegistryShape,
} from "../Services/ProviderInstanceRegistry.ts";
import {
  ProviderInstanceRegistryMutator,
  type ProviderInstanceRegistryMutatorShape,
} from "../Services/ProviderInstanceRegistryMutator.ts";
import type { AnyProviderDriver, ProviderInstance } from "../ProviderDriver.ts";

/**
 * Live registry entry: the materialized `ProviderInstance` + the fresh
 * child scope its `create` effect ran in + the original `entry` envelope
 * so `reconcile` can cheaply detect "no-op" updates.
 */
interface LiveEntry {
  readonly instance: ProviderInstance;
  readonly scope: Scope.Closeable;
  readonly entry: ProviderInstanceConfig;
}

interface FailedDisposal {
  readonly cause: Cause.Cause<never>;
  readonly snapshot: ServerProvider;
}

type BuiltEntry =
  | { readonly kind: "live"; readonly live: LiveEntry }
  | { readonly kind: "unavailable"; readonly snapshot: ServerProvider };

/**
 * Internal state shared between the public registry service and the
 * mutator service. Both services are thin shells around these refs.
 */
interface RegistryState {
  readonly entries: Ref.Ref<ReadonlyMap<ProviderInstanceId, LiveEntry>>;
  readonly unavailable: Ref.Ref<ReadonlyMap<ProviderInstanceId, ServerProvider>>;
  // Scope.close is idempotent even after failure. Keep that failure independently
  // of settings so removing and readding an id cannot imply successful cleanup.
  readonly failedDisposals: Map<ProviderInstanceId, FailedDisposal>;
  readonly changes: PubSub.PubSub<void>;
}

/**
 * Structural equality on `ProviderInstanceConfig` envelopes. Used by
 * `reconcile` to skip rebuilds when settings arrive unchanged. Config
 * payloads are opaque `unknown` at the envelope layer; `Equal.equals`
 * falls back to structural equality for plain records, which matches how
 * the schema decode output is constructed.
 */
const entryEqual = (a: ProviderInstanceConfig, b: ProviderInstanceConfig): boolean =>
  Equal.equals(a, b);

/**
 * Resolve an entry's enabled state. An explicit false on either the
 * envelope or the raw config blob wins (most restrictive) — old settings
 * files can carry both flags with conflicting values, and a user's disable
 * must never be silently undone. Otherwise the envelope flag wins, then the
 * decoded config's flag (which carries the driver schema's default for
 * built-ins and forks alike), then enabled by default.
 */
const resolveEntryEnabled = (entry: ProviderInstanceConfig, typedConfig: unknown): boolean => {
  const rawConfigEnabled = providerInstanceConfigEnabledFlag(entry.config);
  if (entry.enabled === false || rawConfigEnabled === false) {
    return false;
  }
  return entry.enabled ?? providerInstanceConfigEnabledFlag(typedConfig) ?? true;
};

/**
 * Build one entry and hand its ownership to the registry before honoring
 * interruption. Partial acquisitions are closed and their disposal recorded.
 */
const buildEntry = <R>(input: {
  readonly driversById: ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>;
  readonly parentScope: Scope.Scope;
  readonly instanceId: ProviderInstanceId;
  readonly rawInstanceId: string;
  readonly entry: ProviderInstanceConfig;
  readonly state: RegistryState;
  readonly onBuilt: (result: BuiltEntry) => Effect.Effect<void>;
}): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const { driversById, parentScope, instanceId, rawInstanceId, entry, state, onBuilt } = input;
    const driver = driversById.get(entry.driver);
    if (!driver) {
      return yield* onBuilt({
        kind: "unavailable" as const,
        snapshot: yield* buildUnavailableProviderSnapshot({
          driverKind: entry.driver,
          instanceId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          reason: `Driver '${entry.driver}' is not registered in this build.`,
        }),
      });
    }

    const decoder = Schema.decodeUnknownEffect(driver.configSchema);
    const decodeResult = yield* decoder(entry.config ?? driver.defaultConfig()).pipe(Effect.result);
    if (decodeResult._tag === "Failure") {
      const issue = decodeResult.failure;
      const detail = issue.message ?? String(issue);
      yield* Effect.logError("Failed to decode provider instance config", {
        instanceId: rawInstanceId,
        driver: entry.driver,
        detail,
      });
      return yield* onBuilt({
        kind: "unavailable" as const,
        snapshot: yield* buildUnavailableProviderSnapshot({
          driverKind: entry.driver,
          instanceId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          reason: `Invalid config for instance '${rawInstanceId}': ${detail}`,
        }),
      });
    }

    const typedConfig = decodeResult.success;
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const childScope = yield* Scope.fork(parentScope);
        // Only acquisition is interruptible; cleanup and the ownership handoff
        // are not. Keep the full cause so mixed failures retain cancellation.
        const created = yield* restore(
          Effect.suspend(() =>
            driver.create({
              instanceId,
              displayName: entry.displayName,
              accentColor: entry.accentColor,
              environment: entry.environment ?? [],
              enabled: resolveEntryEnabled(entry, typedConfig),
              config: typedConfig,
            }),
          ).pipe(Effect.provideService(Scope.Scope, childScope)),
        ).pipe(Effect.exit);
        if (Exit.isSuccess(created)) {
          yield* onBuilt({
            kind: "live",
            live: { instance: created.value, scope: childScope, entry },
          });
          return;
        }

        const closed = yield* Scope.close(childScope, Exit.void).pipe(Effect.exit);
        const failure = created.cause.reasons.find(Cause.isFailReason);
        const detail =
          failure !== undefined
            ? failure.error.detail
            : Cause.hasInterruptsOnly(created.cause)
              ? "Creation was interrupted."
              : "Creation failed unexpectedly; see server logs for details.";
        const reason = Exit.isFailure(closed)
          ? "Provider shutdown failed after incomplete creation. Automatic replacement is blocked for this server session; see server logs for cleanup details."
          : `Driver '${entry.driver}' failed to create instance: ${detail}`;
        let snapshot = yield* buildUnavailableProviderSnapshot({
          driverKind: entry.driver,
          instanceId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          reason,
        });
        if (Exit.isFailure(closed)) {
          const previous = (yield* Ref.get(state.unavailable)).get(instanceId);
          snapshot = {
            ...snapshot,
            status: "error",
            ...(previous?.driver === entry.driver
              ? { installed: previous.installed, version: previous.version }
              : {}),
            setup: { canAuthenticate: false, canInstall: false },
            supportsTextGeneration: false,
          };
          state.failedDisposals.set(instanceId, { cause: closed.cause, snapshot });
          yield* Effect.logError(
            "Provider instance shutdown failed",
            { instanceId, driver: entry.driver },
            closed.cause,
          );
        }
        yield* onBuilt({ kind: "unavailable", snapshot });
        if (failure !== undefined) {
          yield* Effect.logError("Failed to create provider instance", {
            instanceId: rawInstanceId,
            driver: entry.driver,
            detail,
          });
        }
        const fatalReasons = created.cause.reasons.filter(
          (reason): reason is Cause.Die | Cause.Interrupt => !Cause.isFailReason(reason),
        );
        if (fatalReasons.length > 0) {
          return yield* Effect.failCause(Cause.fromReasons<never>(fatalReasons));
        }
      }),
    );
  });

/**
 * Reconcile-only implementation of the mutator. Exposed to the hydration
 * layer; never called directly by the rest of the server.
 */
const makeReconcile = <R>(input: {
  readonly state: RegistryState;
  readonly driversById: ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>;
  readonly parentScope: Scope.Scope;
}): ((configMap: ProviderInstanceConfigMap) => Effect.Effect<void, never, R>) => {
  const { state, driversById, parentScope } = input;
  return Effect.fnUntraced(function* (configMap: ProviderInstanceConfigMap) {
    const previousEntries = yield* Ref.get(state.entries);
    const previousUnavailable = yield* Ref.get(state.unavailable);
    const nextRaw = Object.entries(configMap);
    const nextKeys = new Set<ProviderInstanceId>(
      nextRaw.map(([raw]) => ProviderInstanceId.make(raw)),
    );

    const closing = [...previousEntries].filter(([instanceId, live]) => {
      const nextEntry = configMap[instanceId];
      return nextEntry === undefined || !entryEqual(live.entry, nextEntry);
    });

    if (closing.length > 0) {
      // Detach before finalizers run so new calls cannot route to a closing
      // instance. Record and publish every outcome before honoring cancellation:
      // a second Scope.close cannot recover a failed first close's result.
      yield* Effect.gen(function* () {
        const remainingEntries = new Map(previousEntries);
        const closingSnapshots = new Map<ProviderInstanceId, ServerProvider>();
        const unavailable = new Map([...previousUnavailable].filter(([id]) => nextKeys.has(id)));
        for (const [instanceId, live] of closing) {
          remainingEntries.delete(instanceId);
          const previousSnapshot = yield* live.instance.snapshot.getSnapshot;
          const snapshot: ServerProvider = {
            ...(yield* buildUnavailableProviderSnapshot({
              driverKind: live.instance.driverKind,
              instanceId,
              displayName: live.instance.displayName,
              accentColor: live.instance.accentColor,
              reason: "Provider is unavailable while settings are being applied.",
            })),
            installed: previousSnapshot.installed,
            version: previousSnapshot.version,
            status: "warning",
            setup: { canAuthenticate: false, canInstall: false },
            supportsTextGeneration: false,
          };
          closingSnapshots.set(instanceId, snapshot);
          if (nextKeys.has(instanceId)) unavailable.set(instanceId, snapshot);
        }
        yield* Ref.set(state.entries, remainingEntries);
        yield* Ref.set(state.unavailable, new Map(unavailable));
        yield* PubSub.publish(state.changes, undefined);

        let unavailableChanged = false;
        for (const [instanceId, live] of closing) {
          const closed = yield* Scope.close(live.scope, Exit.void).pipe(Effect.exit);
          if (Exit.isSuccess(closed)) continue;
          const reason =
            "Provider shutdown failed. Automatic replacement is blocked for this server session; see server logs for cleanup details.";
          const snapshot: ServerProvider = {
            ...closingSnapshots.get(instanceId)!,
            status: "error",
            message: reason,
            unavailableReason: reason,
          };
          state.failedDisposals.set(instanceId, { cause: closed.cause, snapshot });
          if (nextKeys.has(instanceId)) {
            unavailable.set(instanceId, snapshot);
            unavailableChanged = true;
          }
          yield* Effect.logError(
            "Provider instance shutdown failed",
            { instanceId, driver: live.instance.driverKind },
            closed.cause,
          );
        }
        yield* Ref.set(state.unavailable, new Map(unavailable));
        if (unavailableChanged) yield* PubSub.publish(state.changes, undefined);
      }).pipe(Effect.uninterruptible);
    }

    // Do not mask potentially slow driver creation. Disposal outcomes and
    // routing state are already committed if creation is interrupted.
    const currentEntries = yield* Ref.get(state.entries);
    const currentUnavailable = yield* Ref.get(state.unavailable);
    const builtEntries = new Map<ProviderInstanceId, LiveEntry>();
    const builtUnavailable = new Map<ProviderInstanceId, ServerProvider>();
    const pendingEntries = new Map(currentEntries);
    const pendingUnavailable = new Map(currentUnavailable);
    let creationChanged = false;

    yield* Effect.gen(function* () {
      for (const [rawInstanceId, entry] of nextRaw) {
        const instanceId = ProviderInstanceId.make(rawInstanceId);
        const failedDisposal = state.failedDisposals.get(instanceId);
        if (failedDisposal !== undefined) {
          builtUnavailable.set(instanceId, failedDisposal.snapshot);
          continue;
        }

        const existing = currentEntries.get(instanceId);
        if (existing !== undefined) {
          // No-op update: keep the existing live entry and scope.
          builtEntries.set(instanceId, existing);
          continue;
        }

        yield* buildEntry({
          driversById,
          parentScope,
          instanceId,
          rawInstanceId,
          entry,
          state,
          onBuilt: (result) =>
            Effect.gen(function* () {
              if (result.kind === "live") {
                builtEntries.set(instanceId, result.live);
                pendingEntries.set(instanceId, result.live);
                pendingUnavailable.delete(instanceId);
                creationChanged = true;
              } else {
                builtUnavailable.set(instanceId, result.snapshot);
                pendingUnavailable.set(instanceId, result.snapshot);
                creationChanged ||= !Equal.equals(
                  currentUnavailable.get(instanceId),
                  result.snapshot,
                );
              }
              // Commit this acquisition before another driver can fail or suspend.
              yield* Ref.set(state.entries, new Map(pendingEntries));
              yield* Ref.set(state.unavailable, new Map(pendingUnavailable));
            }).pipe(Effect.uninterruptible),
        });
      }
      const currentOrder = [...currentEntries.keys()];
      const entriesChanged =
        builtEntries.size !== currentEntries.size ||
        [...builtEntries].some(
          ([id, live], index) => currentOrder[index] !== id || currentEntries.get(id) !== live,
        );
      const unavailableChanged =
        builtUnavailable.size !== currentUnavailable.size ||
        [...builtUnavailable].some(([id, snapshot]) => {
          const prev = currentUnavailable.get(id);
          return prev === undefined || !Equal.equals(prev, snapshot);
        });

      yield* Effect.gen(function* () {
        yield* Ref.set(state.entries, builtEntries);
        yield* Ref.set(state.unavailable, builtUnavailable);
        if (entriesChanged || unavailableChanged) {
          yield* PubSub.publish(state.changes, undefined);
        }
        creationChanged = false;
      }).pipe(Effect.uninterruptible);
    }).pipe(
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit) || !creationChanged) return Effect.void;
        // A failed batch still exposes earlier successes and settled cleanup.
        return PubSub.publish(state.changes, undefined).pipe(Effect.asVoid);
      }),
    );
  });
};

/**
 * Build the registry's runtime state from a concrete configMap. Returns a
 * record containing:
 *
 *   - `registry`: the read-only `ProviderInstanceRegistryShape` to expose
 *     under `ProviderInstanceRegistry`.
 *   - `mutator`: the `ProviderInstanceRegistryMutatorShape` to expose
 *     under `ProviderInstanceRegistryMutator`.
 *   - `reconcile`: the raw reconcile function, provided for convenience so
 *     boot-time layers can hydrate an initial map before publishing the
 *     services.
 *
 * The scope that this effect runs in owns every per-instance child scope
 * created during `reconcile`. Closing that scope closes every live
 * instance.
 */
export const makeProviderInstanceRegistry = <R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
}): Effect.Effect<
  {
    readonly registry: ProviderInstanceRegistryShape;
    readonly mutator: ProviderInstanceRegistryMutatorShape;
  },
  never,
  R | Scope.Scope
> =>
  Effect.gen(function* () {
    const driversById = new Map<ProviderDriverKind, AnyProviderDriver<R>>(
      input.drivers.map((driver) => [driver.driverKind, driver]),
    );

    // Capture the driver R context at construction time so `reconcile`
    // can be invoked later without re-providing driver dependencies.
    // The service tag's declared `reconcile: Effect<void>` hides R from
    // consumers — we materialize that here.
    const driverContext = yield* Effect.context<R>();

    const entries = yield* Ref.make<ReadonlyMap<ProviderInstanceId, LiveEntry>>(new Map());
    const unavailable = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ServerProvider>>(new Map());
    const changes = yield* PubSub.unbounded<void>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
    // Instances do not depend on one another. Begin their bounded shutdowns
    // together so the backend waits for the longest cleanup, not their sum.
    // Each instance's child scope still runs its own finalizers sequentially.
    // Capture this scope here so later reconciliation retains registry ownership.
    const parentScope = yield* Scope.fork(yield* Scope.Scope, "parallel");

    const state: RegistryState = { entries, unavailable, changes, failedDisposals: new Map() };
    const reconcileLock = yield* Semaphore.make(1);
    const reconcileWithR = makeReconcile({ state, driversById, parentScope });
    const reconcile: ProviderInstanceRegistryMutatorShape["reconcile"] = (configMap) =>
      reconcileWithR(configMap).pipe(
        Effect.provideContext(driverContext),
        reconcileLock.withPermits(1),
      );

    // Hydrate the initial configMap synchronously so callers can read
    // `listInstances` immediately after this effect completes.
    yield* reconcile(input.configMap);

    const registry: ProviderInstanceRegistryShape = {
      getInstance: (id) => Ref.get(entries).pipe(Effect.map((map) => map.get(id)?.instance)),
      listInstances: Ref.get(entries).pipe(
        Effect.map(
          (map) =>
            Array.from(map.values(), (live) => live.instance) as ReadonlyArray<ProviderInstance>,
        ),
      ),
      listUnavailable: Ref.get(unavailable).pipe(
        Effect.map((map) => Array.from(map.values()) as ReadonlyArray<ServerProvider>),
      ),
      // Getters: each read constructs a fresh Stream / Effect descriptor
      // so multiple consumers don't share a single already-started
      // Channel or subscription. Matches the pattern `ProviderRegistry`
      // uses for its own `streamChanges`.
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
      // Synchronous subscribe — callers that need to consume changes
      // from a forked fibre must acquire the subscription in their own
      // fibre first (via `yield* registry.subscribeChanges`) and only
      // then fork a consumer loop on `Stream.fromSubscription(...)` /
      // `PubSub.take(...)`. See the shape docs for the race this avoids.
      get subscribeChanges() {
        return PubSub.subscribe(changes);
      },
    };

    const mutator: ProviderInstanceRegistryMutatorShape = { reconcile };

    return { registry, mutator };
  });

/**
 * Layer variant that also exposes the mutator tag. Consumed by
 * `ProviderInstanceRegistryHydrationLive` to reconcile on settings
 * changes. Tests that exercise the mutator directly can pair this Layer
 * with a test-local `ServerSettingsService`.
 */
export const ProviderInstanceRegistryMutableLayer = <R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
}): Layer.Layer<ProviderInstanceRegistry | ProviderInstanceRegistryMutator, never, R> =>
  Layer.effectContext(
    makeProviderInstanceRegistry(input).pipe(
      Effect.map(({ registry, mutator }) =>
        Context.make(ProviderInstanceRegistry, registry).pipe(
          Context.add(ProviderInstanceRegistryMutator, mutator),
        ),
      ),
    ),
  ) as Layer.Layer<ProviderInstanceRegistry | ProviderInstanceRegistryMutator, never, R>;

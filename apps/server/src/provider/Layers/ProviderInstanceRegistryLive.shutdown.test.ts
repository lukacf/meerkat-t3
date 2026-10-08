import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type {
  ProviderDriver,
  ProviderDriverCreateInput,
  ProviderInstance,
} from "../ProviderDriver.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";

const driverKind = ProviderDriverKind.make("shutdown-fixture");
const configSchema = Schema.Struct({ revision: Schema.Number });
const config = (revision: number): ProviderInstanceConfig => ({
  driver: driverKind,
  config: { revision },
});
const id = ProviderInstanceId.make;
const unexpected = () => Effect.die("Unexpected provider operation in registry shutdown test");

const makeDriver = (input: {
  readonly events: Array<string>;
  readonly close: (instanceId: string, revision: number) => Effect.Effect<void>;
  readonly acquired?: (
    instanceId: string,
    revision: number,
  ) => Effect.Effect<void, ProviderDriverError>;
}): ProviderDriver<typeof configSchema.Type> => ({
  driverKind,
  metadata: { displayName: "Shutdown fixture" },
  configSchema,
  defaultConfig: () => ({ revision: 1 }),
  create: Effect.fnUntraced(function* (
    creation: ProviderDriverCreateInput<typeof configSchema.Type>,
  ) {
    const {
      instanceId,
      config: { revision },
    } = creation;
    input.events.push(`create:${instanceId}:${revision}`);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        input.events.push(`close:${instanceId}:${revision}`);
        yield* input.close(instanceId, revision);
      }),
    );
    yield* input.acquired?.(instanceId, revision) ?? Effect.void;
    const snapshot: ServerProvider = {
      instanceId,
      driver: driverKind,
      displayName: creation.displayName ?? instanceId,
      enabled: true,
      installed: instanceId !== "removed-failure",
      version: "1.2.3",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-09-29T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    };
    return {
      instanceId,
      driverKind,
      continuationIdentity: { driverKind, continuationKey: instanceId },
      displayName: creation.displayName,
      enabled: creation.enabled,
      snapshot: {
        resolveMaintenance: unexpected,
        getSnapshot: Effect.succeed(snapshot),
        refresh: Effect.succeed(snapshot),
        streamChanges: Stream.empty,
        applyUsageLimits: unexpected,
      },
      adapter: {
        provider: driverKind,
        capabilities: { sessionModelSwitch: "unsupported" },
        startSession: unexpected,
        sendTurn: unexpected,
        interruptTurn: unexpected,
        respondToRequest: unexpected,
        respondToUserInput: unexpected,
        stopSession: unexpected,
        listSessions: unexpected,
        hasSession: unexpected,
        readThread: unexpected,
        rollbackThread: unexpected,
        stopAll: unexpected,
        streamEvents: Stream.empty,
      },
      textGeneration: {
        generateCommitMessage: unexpected,
        generatePrContent: unexpected,
        generateBranchName: unexpected,
        generateThreadTitle: unexpected,
      },
    } satisfies ProviderInstance;
  }),
});

describe("ProviderInstanceRegistry reconfiguration shutdown", () => {
  it.effect("starts independent provider cleanups together and awaits every result", () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<string>();
      const releaseFirst = yield* Deferred.make<void>();
      const releaseSecond = yield* Deferred.make<void>();
      const cleanupFailure = new Error("second provider cleanup failed");
      const events: Array<string> = [];
      const driver = makeDriver({
        events,
        close: (instanceId) =>
          Effect.gen(function* () {
            yield* Queue.offer(started, instanceId);
            yield* Deferred.await(instanceId === "first" ? releaseFirst : releaseSecond);
            events.push(`finished:${instanceId}`);
            if (instanceId === "second") return yield* Effect.die(cleanupFailure);
          }),
      });
      const scope = yield* Scope.fork(yield* Scope.Scope);
      yield* makeProviderInstanceRegistry({
        drivers: [driver],
        configMap: { [id("first")]: config(1), [id("second")]: config(1) },
      }).pipe(Effect.provideService(Scope.Scope, scope));
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.exit, Effect.forkChild);
      // Both providers must enter cleanup before either gate is released.
      expect((yield* Queue.takeN(started, 2)).toSorted()).toEqual(["first", "second"]);
      expect(closing.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(releaseSecond, undefined);
      yield* Deferred.succeed(releaseFirst, undefined);
      const outcome = yield* Fiber.join(closing);
      expect(events.filter((event) => event.startsWith("finished:")).toSorted()).toEqual([
        "finished:first",
        "finished:second",
      ]);
      expect(Exit.isFailure(outcome)).toBe(true);
      if (Exit.isFailure(outcome)) {
        expect(
          outcome.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect),
        ).toEqual([cleanupFailure]);
      }
    }).pipe(Effect.scoped),
  );

  it.effect(
    "retains earlier replacements and failed acquisition cleanup without retrying them",
    () =>
      Effect.gen(function* () {
        const events: Array<string> = [];
        const driver = makeDriver({
          events,
          acquired: (instanceId, revision) =>
            instanceId === "b" && revision === 2
              ? Effect.fail(
                  new ProviderDriverError({
                    driver: driverKind,
                    instanceId,
                    detail: "fixture acquisition failed",
                  }),
                )
              : Effect.void,
          close: (instanceId, revision) =>
            instanceId === "b" && revision === 2
              ? Effect.die(new Error("partial acquisition cleanup failed"))
              : Effect.void,
        });
        const scope = yield* Scope.fork(yield* Scope.Scope);
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [driver],
          configMap: { [id("a")]: config(1), [id("b")]: config(1), [id("c")]: config(1) },
        }).pipe(Effect.provideService(Scope.Scope, scope));
        const next = { [id("a")]: config(2), [id("b")]: config(2), [id("c")]: config(2) };

        yield* mutator.reconcile(next);
        const a = yield* registry.getInstance(id("a"));
        expect(a).toBeDefined();
        expect((yield* registry.listInstances).map((instance) => instance.instanceId)).toEqual([
          "a",
          "c",
        ]);
        const unavailable = yield* registry.listUnavailable;
        expect(unavailable).toEqual([
          expect.objectContaining({
            instanceId: "b",
            status: "error",
            installed: true,
            version: "1.2.3",
            setup: { canAuthenticate: false, canInstall: false },
          }),
        ]);
        expect(unavailable[0]?.unavailableReason).toContain(
          "shutdown failed after incomplete creation",
        );
        yield* mutator.reconcile(next);
        expect(yield* registry.getInstance(id("a"))).toBe(a);
        expect((yield* registry.listUnavailable)[0]).toBe(unavailable[0]);
        expect(events).toEqual([
          "create:a:1",
          "create:b:1",
          "create:c:1",
          "close:a:1",
          "close:b:1",
          "close:c:1",
          "create:a:2",
          "create:b:2",
          "close:b:2",
          "create:c:2",
        ]);
        yield* Scope.close(scope, Exit.void);
        expect(events.filter((event) => event.startsWith("close:"))).toEqual([
          "close:a:1",
          "close:b:1",
          "close:c:1",
          "close:b:2",
          "close:c:2",
          "close:a:2",
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("retries a clean failed acquisition and continues unrelated siblings", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      let bAttempts = 0;
      const driver = makeDriver({
        events,
        acquired: (instanceId) =>
          Effect.gen(function* () {
            if (instanceId === "b" && ++bAttempts === 1) {
              return yield* Effect.fail(
                new ProviderDriverError({
                  driver: driverKind,
                  instanceId,
                  detail: "repairable config",
                }),
              );
            }
          }),
        close: () => Effect.void,
      });
      const scope = yield* Scope.fork(yield* Scope.Scope);
      const { registry, mutator } = yield* makeProviderInstanceRegistry({
        drivers: [driver],
        configMap: {},
      }).pipe(Effect.provideService(Scope.Scope, scope));
      const next = { [id("a")]: config(1), [id("b")]: config(1), [id("c")]: config(1) };
      yield* mutator.reconcile(next);
      const a = yield* registry.getInstance(id("a"));
      expect((yield* registry.listInstances).map((instance) => instance.instanceId)).toEqual([
        "a",
        "c",
      ]);
      expect((yield* registry.listUnavailable)[0]?.unavailableReason).toContain(
        "repairable config",
      );
      yield* mutator.reconcile(next);
      expect(yield* registry.getInstance(id("a"))).toBe(a);
      expect((yield* registry.listInstances).map((instance) => instance.instanceId)).toEqual([
        "a",
        "b",
        "c",
      ]);
      expect(yield* registry.listUnavailable).toEqual([]);
      expect(events).toEqual(["create:a:1", "create:b:1", "close:b:1", "create:c:1", "create:b:1"]);
      yield* Scope.close(scope, Exit.void);
      expect(events).toEqual([
        "create:a:1",
        "create:b:1",
        "close:b:1",
        "create:c:1",
        "create:b:1",
        "close:b:1",
        "close:c:1",
        "close:a:1",
      ]);
    }).pipe(Effect.scoped),
  );

  for (const cleanupFails of [false, true]) {
    it.effect(
      `settles interrupted partial creation with ${cleanupFails ? "failed" : "clean"} cleanup`,
      () =>
        Effect.gen(function* () {
          const acquired = yield* Deferred.make<void>();
          const cleanupStarted = yield* Deferred.make<void>();
          const allowCleanup = yield* Deferred.make<void>();
          const events: Array<string> = [];
          let bAttempts = 0;
          const driver = makeDriver({
            events,
            acquired: (instanceId, revision) =>
              Effect.gen(function* () {
                if (instanceId === "b" && revision === 2 && ++bAttempts === 1) {
                  yield* Deferred.succeed(acquired, undefined);
                  return yield* Effect.never;
                }
              }),
            close: (instanceId, revision) =>
              Effect.gen(function* () {
                if (instanceId === "b" && revision === 2 && bAttempts === 1) {
                  yield* Deferred.succeed(cleanupStarted, undefined);
                  yield* Deferred.await(allowCleanup);
                  if (cleanupFails)
                    return yield* Effect.die(new Error("interrupted acquisition cleanup failed"));
                }
              }),
          });
          const scope = yield* Scope.fork(yield* Scope.Scope);
          const { registry, mutator } = yield* makeProviderInstanceRegistry({
            drivers: [driver],
            configMap: { [id("a")]: config(1), [id("b")]: config(1), [id("c")]: config(1) },
          }).pipe(Effect.provideService(Scope.Scope, scope));
          const changes = yield* registry.subscribeChanges;
          const next = { [id("a")]: config(2), [id("b")]: config(2), [id("c")]: config(2) };
          const reconcile = yield* mutator.reconcile(next).pipe(Effect.forkChild);
          yield* Deferred.await(acquired);
          const a = yield* registry.getInstance(id("a"));
          const bDuringCreation = yield* registry.getInstance(id("b"));
          const interrupted = yield* Fiber.interrupt(reconcile).pipe(Effect.forkChild);
          yield* Deferred.await(cleanupStarted);
          const outcomeDuringCleanup = interrupted.pollUnsafe();
          yield* Deferred.succeed(allowCleanup, undefined);
          yield* Fiber.join(interrupted);
          expect(a).toBeDefined();
          expect(bDuringCreation).toBeUndefined();
          expect(outcomeDuringCleanup).toBeUndefined();
          const outcome = yield* Fiber.await(reconcile);
          expect(Exit.isFailure(outcome)).toBe(true);
          if (Exit.isFailure(outcome)) expect(Cause.hasInterrupts(outcome.cause)).toBe(true);
          expect(yield* registry.getInstance(id("a"))).toBe(a);
          expect(
            (yield* registry.listUnavailable).find((snapshot) => snapshot.instanceId === "b")
              ?.unavailableReason,
          ).toContain(
            cleanupFails ? "shutdown failed after incomplete creation" : "Creation was interrupted",
          );
          expect(yield* PubSub.takeUpTo(changes, 10)).toHaveLength(2);
          expect(events).toEqual([
            "create:a:1",
            "create:b:1",
            "create:c:1",
            "close:a:1",
            "close:b:1",
            "close:c:1",
            "create:a:2",
            "create:b:2",
            "close:b:2",
          ]);
          yield* mutator.reconcile(next);
          expect(yield* registry.getInstance(id("a"))).toBe(a);
          expect((yield* registry.listInstances).map((instance) => instance.instanceId)).toEqual(
            cleanupFails ? ["a", "c"] : ["a", "b", "c"],
          );
          expect(events.filter((event) => event === "create:a:2")).toHaveLength(1);
          expect(events.filter((event) => event === "create:b:2")).toHaveLength(
            cleanupFails ? 1 : 2,
          );
          expect(events.filter((event) => event === "create:c:2")).toHaveLength(1);
          yield* Scope.close(scope, Exit.void);
          expect(events.filter((event) => event === "close:a:2")).toHaveLength(1);
          expect(events.filter((event) => event === "close:b:2")).toHaveLength(
            cleanupFails ? 1 : 2,
          );
          expect(events.filter((event) => event === "close:c:2")).toHaveLength(1);
        }).pipe(Effect.scoped),
    );
  }

  it.effect(
    "preserves a creation defect after cleanup and retains earlier registered instances",
    () =>
      Effect.gen(function* () {
        const events: Array<string> = [];
        const defect = new Error("creation defect");
        const driver = makeDriver({
          events,
          acquired: (instanceId) => (instanceId === "b" ? Effect.die(defect) : Effect.void),
          close: (instanceId) =>
            instanceId === "b" ? Effect.die(new Error("defect cleanup failed")) : Effect.void,
        });
        const scope = yield* Scope.fork(yield* Scope.Scope);
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [driver],
          configMap: {},
        }).pipe(Effect.provideService(Scope.Scope, scope));
        const next = { [id("a")]: config(1), [id("b")]: config(1), [id("c")]: config(1) };
        const outcome = yield* mutator.reconcile(next).pipe(Effect.exit);
        expect(Exit.isFailure(outcome)).toBe(true);
        if (Exit.isFailure(outcome)) {
          expect(
            outcome.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect),
          ).toEqual([defect]);
        }
        const a = yield* registry.getInstance(id("a"));
        expect(a).toBeDefined();
        expect((yield* registry.listUnavailable)[0]?.unavailableReason).toContain(
          "shutdown failed after incomplete creation",
        );
        yield* mutator.reconcile(next);
        expect(yield* registry.getInstance(id("a"))).toBe(a);
        expect((yield* registry.listInstances).map((instance) => instance.instanceId)).toEqual([
          "a",
          "c",
        ]);
        yield* Scope.close(scope, Exit.void);
        expect(events).toEqual([
          "create:a:1",
          "create:b:1",
          "close:b:1",
          "create:c:1",
          "close:c:1",
          "close:a:1",
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "settles siblings and retains failed disposal across settings removal and readdition",
    () =>
      Effect.gen(function* () {
        const events: Array<string> = [];
        const replacementError = new Error("replacement cleanup failed");
        const removalError = new Error("removed instance cleanup failed");
        const logs: Array<{ message: unknown; cause: Cause.Cause<unknown> }> = [];
        const logger = Logger.make<unknown, void>(({ message, cause }) => {
          logs.push({ message, cause });
        });
        yield* Effect.gen(function* () {
          const driver = makeDriver({
            events,
            close: (instanceId, revision) => {
              if (instanceId === "failed" && revision === 1) return Effect.die(replacementError);
              if (instanceId === "removed-failure") return Effect.die(removalError);
              return Effect.void;
            },
          });
          const scope = yield* Scope.make();
          const { registry, mutator } = yield* makeProviderInstanceRegistry({
            drivers: [driver],
            configMap: {
              [id("failed")]: config(1),
              [id("healthy")]: config(1),
              [id("keep")]: config(1),
              [id("removed-failure")]: config(1),
              [id("removed")]: config(1),
            },
          }).pipe(Effect.provideService(Scope.Scope, scope));
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const changes = yield* registry.subscribeChanges;
          const keep = yield* registry.getInstance(id("keep"));
          const next = {
            [id("failed")]: config(2),
            [id("healthy")]: config(2),
            [id("keep")]: config(1),
            [id("added")]: config(1),
          };

          yield* mutator.reconcile(next);
          expect(events).toEqual([
            "create:failed:1",
            "create:healthy:1",
            "create:keep:1",
            "create:removed-failure:1",
            "create:removed:1",
            "close:failed:1",
            "close:healthy:1",
            "close:removed-failure:1",
            "close:removed:1",
            "create:healthy:2",
            "create:added:1",
          ]);
          expect((yield* registry.listInstances).map((instance) => instance.instanceId)).toEqual([
            "healthy",
            "keep",
            "added",
          ]);
          expect(yield* registry.getInstance(id("keep"))).toBe(keep);
          expect(yield* registry.getInstance(id("failed"))).toBeUndefined();
          expect(yield* registry.getInstance(id("removed-failure"))).toBeUndefined();
          expect(yield* registry.getInstance(id("removed"))).toBeUndefined();
          const unavailable = yield* registry.listUnavailable;
          expect(unavailable).toHaveLength(1);
          expect(unavailable[0]).toMatchObject({
            instanceId: "failed",
            driver: driverKind,
            installed: true,
            version: "1.2.3",
            enabled: false,
            status: "error",
            availability: "unavailable",
            models: [],
            setup: { canAuthenticate: false, canInstall: false },
          });
          expect(unavailable[0]?.unavailableReason).toContain("Provider shutdown failed");
          expect(yield* PubSub.takeUpTo(changes, 10)).toHaveLength(3);

          yield* mutator.reconcile({
            [id("failed")]: config(2),
            [id("healthy")]: config(2),
            [id("keep")]: config(1),
            [id("added")]: config(1),
          });
          expect((yield* registry.listUnavailable)[0]).toBe(unavailable[0]);
          expect(yield* PubSub.takeUpTo(changes, 10)).toEqual([]);

          const expanded = { ...next, [id("unrelated")]: config(1) };
          yield* mutator.reconcile(expanded);
          expect((yield* registry.listUnavailable)[0]).toBe(unavailable[0]);
          expect(yield* PubSub.takeUpTo(changes, 10)).toHaveLength(1);
          yield* mutator.reconcile({
            [id("healthy")]: config(2),
            [id("keep")]: config(1),
            [id("added")]: config(1),
            [id("unrelated")]: config(1),
          });
          expect(yield* registry.listUnavailable).toEqual([]);
          expect(yield* PubSub.takeUpTo(changes, 10)).toHaveLength(1);

          const readded = {
            ...expanded,
            [id("failed")]: config(3),
            [id("removed-failure")]: config(2),
          };
          yield* mutator.reconcile(readded);
          expect(yield* registry.getInstance(id("failed"))).toBeUndefined();
          expect(yield* registry.getInstance(id("removed-failure"))).toBeUndefined();
          expect(yield* registry.listUnavailable).toEqual([
            unavailable[0],
            expect.objectContaining({
              instanceId: "removed-failure",
              installed: false,
              status: "error",
            }),
          ]);
          expect(yield* PubSub.takeUpTo(changes, 10)).toHaveLength(1);
          yield* mutator.reconcile(readded);
          expect(yield* PubSub.takeUpTo(changes, 10)).toEqual([]);
          expect(events).toEqual([
            "create:failed:1",
            "create:healthy:1",
            "create:keep:1",
            "create:removed-failure:1",
            "create:removed:1",
            "close:failed:1",
            "close:healthy:1",
            "close:removed-failure:1",
            "close:removed:1",
            "create:healthy:2",
            "create:added:1",
            "create:unrelated:1",
          ]);
          expect(logs.map(({ message }) => message)).toEqual([
            ["Provider instance shutdown failed", { instanceId: "failed", driver: driverKind }],
            [
              "Provider instance shutdown failed",
              { instanceId: "removed-failure", driver: driverKind },
            ],
          ]);
          expect(
            logs.flatMap(({ cause }) =>
              cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect),
            ),
          ).toEqual([replacementError, removalError]);

          expect(Exit.isSuccess(yield* Scope.close(scope, Exit.void).pipe(Effect.exit))).toBe(true);
          expect(events.filter((event) => event === "close:failed:1")).toHaveLength(1);
          expect(events.filter((event) => event === "close:removed-failure:1")).toHaveLength(1);
          expect(events.filter((event) => event === "close:healthy:2")).toHaveLength(1);
          expect(events.filter((event) => event === "close:keep:1")).toHaveLength(1);
          expect(events.filter((event) => event === "close:added:1")).toHaveLength(1);
          expect(events.filter((event) => event === "close:unrelated:1")).toHaveLength(1);
        }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "fences routing and retains all close outcomes when reconciliation is interrupted",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const events: Array<string> = [];
        const driver = makeDriver({
          events,
          close: (instanceId, revision) =>
            instanceId === "failed" && revision === 1
              ? Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  return yield* Effect.die(new Error("delayed cleanup failed"));
                })
              : Effect.void,
        });
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [driver],
          configMap: {
            [id("failed")]: config(1),
            [id("healthy")]: config(1),
            [id("keep")]: config(1),
          },
        });
        const changes = yield* registry.subscribeChanges;
        const next = {
          [id("failed")]: config(2),
          [id("healthy")]: config(2),
          [id("keep")]: config(1),
        };
        const reconcile = yield* mutator.reconcile(next).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const interrupt = yield* Effect.gen(function* () {
          expect(yield* registry.getInstance(id("failed"))).toBeUndefined();
          expect(yield* registry.getInstance(id("healthy"))).toBeUndefined();
          expect((yield* registry.listInstances).map((instance) => instance.instanceId)).toEqual([
            "keep",
          ]);
          expect((yield* registry.listUnavailable).map((snapshot) => snapshot.status)).toEqual([
            "warning",
            "warning",
          ]);
          expect(yield* PubSub.takeUpTo(changes, 10)).toHaveLength(1);
          return yield* Fiber.interrupt(reconcile).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        yield* Fiber.join(interrupt);
        expect(Exit.isFailure(yield* Fiber.await(reconcile))).toBe(true);
        expect(events).toEqual([
          "create:failed:1",
          "create:healthy:1",
          "create:keep:1",
          "close:failed:1",
          "close:healthy:1",
        ]);
        expect((yield* registry.listUnavailable)[0]).toMatchObject({
          instanceId: "failed",
          status: "error",
        });
        expect(yield* PubSub.takeUpTo(changes, 10)).toHaveLength(1);

        yield* mutator.reconcile(next);
        expect((yield* registry.listInstances).map((instance) => instance.instanceId)).toEqual([
          "healthy",
          "keep",
        ]);
        expect((yield* registry.listUnavailable).map((snapshot) => snapshot.instanceId)).toEqual([
          "failed",
        ]);
        expect(events.at(-1)).toBe("create:healthy:2");
        expect(events.filter((event) => event === "close:failed:1")).toHaveLength(1);
        expect(events.filter((event) => event.startsWith("create:failed:"))).toEqual([
          "create:failed:1",
        ]);
        expect(yield* PubSub.takeUpTo(changes, 10)).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect("serializes overlapping reconciliations without duplicate replacement", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const events: Array<string> = [];
      const driver = makeDriver({
        events,
        close: (_instanceId, revision) =>
          revision === 1
            ? Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              })
            : Effect.void,
      });
      const { registry, mutator } = yield* makeProviderInstanceRegistry({
        drivers: [driver],
        configMap: { [id("healthy")]: config(1) },
      });
      const changes = yield* registry.subscribeChanges;
      const first = yield* mutator.reconcile({ [id("healthy")]: config(2) }).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const second = yield* mutator
        .reconcile({ [id("healthy")]: config(2) })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(events).toEqual(["create:healthy:1", "close:healthy:1", "create:healthy:2"]);
      expect((yield* registry.listInstances).map((instance) => instance.instanceId)).toEqual([
        "healthy",
      ]);
      expect(yield* registry.listUnavailable).toEqual([]);
      expect(yield* PubSub.takeUpTo(changes, 10)).toHaveLength(2);
    }).pipe(Effect.scoped),
  );
});

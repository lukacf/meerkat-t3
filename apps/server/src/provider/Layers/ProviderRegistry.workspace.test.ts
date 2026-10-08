import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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

const instanceId = ProviderInstanceId.make("meerkat-project-accounts");
const driver = ProviderDriverKind.make("meerkat");
const machine: ServerProvider = {
  instanceId,
  driver,
  status: "warning",
  enabled: true,
  installed: true,
  auth: { status: "unauthenticated", label: "Default project account" },
  checkedAt: "2026-10-04T10:00:00.000Z",
  version: "0.8.50",
  supportsWorkspaceReadiness: true,
  models: [],
  slashCommands: [{ name: "global-command" }],
  skills: [],
};
const workspace = (name: string, connected: boolean): ServerProvider => ({
  ...machine,
  status: connected ? "ready" : "warning",
  auth: { status: connected ? "authenticated" : "unauthenticated", label: name },
  ...(connected ? {} : { message: `Connect ${name}.` }),
  models: [
    {
      slug: `openai:${name}`,
      name,
      credentialState: connected ? "connected" : "needs_auth",
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [{ name }],
});
const instance = (
  snapshotForCwd: NonNullable<ProviderInstance["snapshotForCwd"]>,
  snapshot = machine,
): ProviderInstance => ({
  instanceId: snapshot.instanceId,
  driverKind: snapshot.driver,
  continuationIdentity: { driverKind: snapshot.driver, continuationKey: snapshot.instanceId },
  displayName: undefined,
  enabled: true,
  snapshot: {
    resolveMaintenance: () =>
      Effect.succeed(
        makeManualOnlyProviderMaintenanceCapabilities({
          provider: snapshot.driver,
          packageName: null,
        }),
      ),
    getSnapshot: Effect.succeed(snapshot),
    refresh: Effect.succeed(snapshot),
    streamChanges: Stream.empty,
    applyUsageLimits: () => Effect.void,
  },
  snapshotForCwd,
  adapter: {} as ProviderInstance["adapter"],
  textGeneration: {} as ProviderInstance["textGeneration"],
});
const testLayer = (instances: ReadonlyArray<ProviderInstance>) =>
  ProviderRegistryLive.pipe(
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry, {
        getInstance: (id) => Effect.succeed(instances.find((item) => item.instanceId === id)),
        listInstances: Effect.succeed(instances),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
      }),
    ),
    Layer.provide(ModelManifest.layerTest),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-readiness-" })),
    Layer.provide(NodeServices.layer),
  );

describe("workspace account and model readiness", () => {
  it.effect("replaces a legacy skills-only row when the provider supports scoped readiness", () => {
    let calls = 0;
    const legacy = {
      ...machine,
      workspaceSnapshots: [
        { cwd: "/project-b", checkedAt: machine.checkedAt, slashCommands: [], skills: [] },
      ],
    };
    return Effect.gen(function* () {
      const registry = yield* ProviderRegistry;
      const result = yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/project-b" });
      expect(calls).toBe(1);
      expect(result[0]?.workspaceSnapshots?.[0]?.readiness?.auth.status).toBe("authenticated");
    }).pipe(
      Effect.provide(
        testLayer([
          instance(
            () =>
              Effect.sync(() => {
                calls += 1;
                return workspace("scoped", true);
              }),
            legacy,
          ),
        ]),
      ),
    );
  });

  it.effect("keeps different project accounts and catalogs out of the default snapshot", () => {
    const projects = {
      "/project-a": workspace("model-a", false),
      "/project-b": workspace("model-b", true),
    };
    const calls: string[] = [];
    return Effect.gen(function* () {
      const registry = yield* ProviderRegistry;
      for (const cwd of Object.keys(projects))
        yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd });
      const current = (yield* registry.getProviders)[0]!;
      expect(current.auth).toEqual(machine.auth);
      expect(current.models).toEqual(machine.models);
      expect(current.slashCommands).toEqual(machine.slashCommands);
      expect(current.installed).toBe(true);
      expect(
        current.workspaceSnapshots?.map((row) => ({ cwd: row.cwd, ...row.readiness })),
      ).toEqual([
        {
          cwd: "/project-a",
          status: "warning",
          auth: projects["/project-a"].auth,
          models: projects["/project-a"].models,
          message: "Connect model-a.",
        },
        {
          cwd: "/project-b",
          status: "ready",
          auth: projects["/project-b"].auth,
          models: projects["/project-b"].models,
        },
      ]);
      yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/project-b" });
      expect(calls).toEqual(["/project-a", "/project-b"]);
    }).pipe(
      Effect.provide(
        testLayer([
          instance((cwd) =>
            Effect.sync(() => {
              calls.push(cwd);
              return projects[cwd as keyof typeof projects];
            }),
          ),
        ]),
      ),
    );
  });

  it.effect(
    "invalidates inherited scopes on repeated auth changes and replaces the full catalog",
    () =>
      Effect.gen(function* () {
        const state = yield* Ref.make(workspace("signed-out", false));
        const otherId = ProviderInstanceId.make("other-account");
        const other = { ...machine, instanceId: otherId };
        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry;
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/project-a" });
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/project-b" });
          yield* registry.refreshWorkspaceSnapshot({ instanceId: otherId, cwd: "/project-b" });
          const otherBefore = (yield* registry.getProviders).find((p) => p.instanceId === otherId);
          for (const [name, connected] of [
            ["signed-in", true],
            ["signed-out-again", false],
            ["signed-in-again", true],
          ] as const) {
            const fresh = workspace(name, connected);
            yield* Ref.set(state, fresh);
            const providers = yield* registry.refreshWorkspaceSnapshot({
              instanceId,
              cwd: "/project-b",
              invalidate: true,
            });
            const current = providers.find((p) => p.instanceId === instanceId)!;
            expect(current.workspaceSnapshots?.map((row) => row.cwd)).toEqual(["/project-b"]);
            expect(current.workspaceSnapshots?.[0]?.readiness?.models).toEqual(fresh.models);
            expect(current.workspaceSnapshots?.[0]?.readiness?.auth).toEqual(fresh.auth);
            expect(current.workspaceSnapshots?.[0]?.readiness?.message).toBe(fresh.message);
            expect(current.auth).toEqual(machine.auth);
            expect(providers.find((p) => p.instanceId === otherId)).toEqual(otherBefore);
            yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/project-a" });
            const rechecked = (yield* registry.getProviders).find(
              (p) => p.instanceId === instanceId,
            )!;
            expect(
              rechecked.workspaceSnapshots?.find((row) => row.cwd === "/project-a")?.readiness
                ?.auth,
            ).toEqual(fresh.auth);
          }
        }).pipe(
          Effect.provide(
            testLayer([
              instance(() => Ref.get(state)),
              instance(
                () => Effect.succeed({ ...workspace("other", true), instanceId: otherId }),
                other,
              ),
            ]),
          ),
        );
      }),
  );

  it.effect("fences pre-auth probes and their finalizers while a new probe is pending", () =>
    Effect.gen(function* () {
      const oldStarted = yield* Deferred.make<void>();
      const releaseOld = yield* Deferred.make<void>();
      const freshStarted = yield* Deferred.make<void>();
      const releaseFresh = yield* Deferred.make<void>();
      const calls = yield* Ref.make(0);
      const native = instance(() =>
        Effect.gen(function* () {
          const count = yield* Ref.updateAndGet(calls, (n) => n + 1);
          if (count === 1) {
            yield* Deferred.succeed(oldStarted, undefined);
            yield* Deferred.await(releaseOld);
            return workspace("pre-auth", false);
          }
          yield* Deferred.succeed(freshStarted, undefined);
          yield* Deferred.await(releaseFresh);
          return workspace("post-auth", true);
        }),
      );
      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry;
        const old = yield* registry
          .refreshWorkspaceSnapshot({ instanceId, cwd: "/project-b" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(oldStarted);
        const fresh = yield* registry
          .refreshWorkspaceSnapshot({ instanceId, cwd: "/project-b", invalidate: true })
          .pipe(Effect.forkChild);
        yield* Deferred.await(freshStarted);
        expect((yield* registry.getProviders)[0]?.workspaceSnapshots).toEqual([]);
        yield* Deferred.succeed(releaseOld, undefined);
        yield* Fiber.join(old);
        expect((yield* registry.getProviders)[0]?.workspaceSnapshots).toEqual([]);
        yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/project-b" });
        expect(yield* Ref.get(calls)).toBe(2);
        yield* Deferred.succeed(releaseFresh, undefined);
        yield* Fiber.join(fresh);
        expect(
          (yield* registry.getProviders)[0]?.workspaceSnapshots?.[0]?.readiness?.models[0]?.slug,
        ).toBe("openai:post-auth");
      }).pipe(Effect.provide(testLayer([native])));
    }),
  );

  it.effect("explicit refresh clears scoped caches, while ordinary refresh preserves them", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(workspace("before-refresh", false));
      const otherId = ProviderInstanceId.make("unrelated-instance");
      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry;
        yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/project-b" });
        yield* registry.refreshWorkspaceSnapshot({ instanceId: otherId, cwd: "/project-b" });
        const before = yield* registry.getProviders;
        yield* Ref.set(state, workspace("after-refresh", true));
        const background = yield* registry.refreshInstance(instanceId);
        expect(background).toEqual(before);
        const targeted = yield* registry.refreshInstance(instanceId, {
          invalidateWorkspaces: true,
        });
        expect(targeted.find((p) => p.instanceId === instanceId)?.workspaceSnapshots).toEqual([]);
        expect(targeted.find((p) => p.instanceId === otherId)).toEqual(
          before.find((p) => p.instanceId === otherId),
        );
        const rechecked = yield* registry.refreshWorkspaceSnapshot({
          instanceId,
          cwd: "/project-b",
        });
        expect(
          rechecked.find((p) => p.instanceId === instanceId)?.workspaceSnapshots?.[0]?.readiness
            ?.models[0]?.slug,
        ).toBe("openai:after-refresh");
        const all = yield* registry.refresh(undefined, { invalidateWorkspaces: true });
        expect(all.map((p) => p.workspaceSnapshots)).toEqual([[], []]);
      }).pipe(
        Effect.provide(
          testLayer([
            instance(() => Ref.get(state)),
            instance(() => Effect.succeed({ ...workspace("other", true), instanceId: otherId }), {
              ...machine,
              instanceId: otherId,
            }),
          ]),
        ),
      );
    }),
  );

  it.effect("explicit refresh also fences a pending pre-refresh workspace result", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry;
        const old = yield* registry
          .refreshWorkspaceSnapshot({ instanceId, cwd: "/project-b" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* registry.refreshInstance(instanceId, { invalidateWorkspaces: true });
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(old);
        expect((yield* registry.getProviders)[0]?.workspaceSnapshots).toEqual([]);
      }).pipe(
        Effect.provide(
          testLayer([
            instance(() =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(workspace("stale", true)),
              ),
            ),
          ]),
        ),
      );
    }),
  );

  it.effect("does not resurrect another workspace from an older in-flight account check", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const native = instance((cwd) =>
        cwd === "/project-a"
          ? Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(workspace("old-a", true)),
            )
          : Effect.succeed(workspace("new-b", false)),
      );
      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry;
        const old = yield* registry
          .refreshWorkspaceSnapshot({ instanceId, cwd: "/project-a" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* registry.refreshWorkspaceSnapshot({
          instanceId,
          cwd: "/project-b",
          invalidate: true,
        });
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(old);
        expect(
          (yield* registry.getProviders)[0]?.workspaceSnapshots?.map((row) => row.cwd),
        ).toEqual(["/project-b"]);
      }).pipe(Effect.provide(testLayer([native])));
    }),
  );

  it.effect("publishes failed scoped readiness and permits an explicit retry", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make<ServerProvider>({
        ...machine,
        status: "error",
        auth: { status: "unknown" },
        models: [],
        message: "Native project account check failed.",
      });
      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry;
        const failed = yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/project-b" });
        expect(failed[0]?.workspaceSnapshots?.[0]?.readiness).toEqual({
          status: "error",
          auth: { status: "unknown" },
          models: [],
          message: "Native project account check failed.",
        });
        yield* Ref.set(state, workspace("recovered", true));
        const recovered = yield* registry.refreshWorkspaceSnapshot({
          instanceId,
          cwd: "/project-b",
        });
        expect(recovered[0]?.workspaceSnapshots?.[0]?.readiness?.status).toBe("ready");
        expect(recovered[0]?.workspaceSnapshots?.[0]?.readiness?.message).toBeUndefined();
      }).pipe(Effect.provide(testLayer([instance(() => Ref.get(state))])));
    }),
  );
});

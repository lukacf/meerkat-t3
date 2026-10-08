// @effect-diagnostics globalFetchInEffect:off - Exercises the owned loopback callback with fake native responses.
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type MeerkatAuthFlow,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { meerkatProjectStateRoot } from "../Layers/MeerkatAdapter.ts";
import { createMeerkatAuthFlows } from "./MeerkatAuthFlows.ts";
import { makeMeerkatControlsService } from "./MeerkatControlsService.ts";
import { WorkspacePaths, WorkspaceRootNotExistsError } from "../../workspace/WorkspacePaths.ts";

const instanceId = ProviderInstanceId.make("project-auth-instance");
const projectId = ProjectId.make("project-b");
const threadId = ThreadId.make("account-thread");
const threadTarget = { threadId, expectedCwd: "/worktrees/thread-b" };
const threadScope = { projectId, instanceId, threadTarget };
const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};
const harness = Effect.fnUntraced(function* (
  options: {
    liveFlows?: boolean;
    beforeNativeRequest?: (method: string, params: Record<string, unknown>) => Promise<void>;
  } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Project B','/project-b','[]','now','now')`;
  yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,worktree_path,created_at,updated_at) VALUES (${threadId},${projectId},'Thread B','{}',${threadTarget.expectedCwd},'now','now')`;
  let status: MeerkatAuthFlow["status"] = "connected";
  let failLogout = false;
  let failRefresh = false;
  let redirectUri = "";
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const refreshes: Array<Record<string, unknown>> = [];
  const flowScopes: string[] = [];
  const stateRoot = "/configured-native-root";
  let directoryExists = true;
  let enabled = true;
  let bindingId = "work";
  let profileId = "work";
  let realmId = "project-b-realm";
  const makeInstance = (): ProviderInstance => ({
    instanceId,
    driverKind: ProviderDriverKind.make("meerkat"),
    continuationIdentity: {
      driverKind: ProviderDriverKind.make("meerkat"),
      continuationKey: instanceId,
    },
    displayName: undefined,
    get enabled() {
      return enabled;
    },
    meerkatTeam: {
      stateRoot,
      snapshot: () => Effect.die("Auth must not load agents"),
      activity: () => Effect.die("Auth must not read conversations"),
    },
    meerkatControls: {
      request: async (method, params) => {
        calls.push({ method, params });
        await options.beforeNativeRequest?.(method, params);
        if (method === "auth.v1.status")
          return {
            connections: [
              {
                provider: "openai",
                displayName: "OpenAI",
                realmId,
                bindingId,
                profileId,
                source: "oauth",
                state: "connected",
                supportsInteractiveLogin: true,
              },
            ],
          };
        if (method === "auth.v1.logout") {
          if (failLogout) throw new Error("Native logout failed.");
          return {};
        }
        if (method === "auth.v1.loginStart") {
          redirectUri = String(params.redirectUri);
          return { authorizeUrl: "https://auth.example/start", state: "native-state" };
        }
        if (method === "auth.v1.loginComplete") return {};
        throw new Error(`Unexpected native method: ${method}`);
      },
    },
    get adapter(): never {
      throw new Error("Auth must not start work");
    },
    get snapshot(): never {
      throw new Error("Projection refresh belongs to ProviderRegistry");
    },
    get textGeneration(): never {
      throw new Error("Auth must not generate text");
    },
  });
  let instance = makeInstance();
  const flows = createMeerkatAuthFlows();
  const logoutStarted = deferred<void>();
  const runLogout: typeof flows.runLogout = (scope, provider, operation) =>
    flows.runLogout(scope, provider, () => {
      logoutStarted.resolve(undefined);
      return operation();
    });
  const view = (scope: string): MeerkatAuthFlow => {
    flowScopes.push(scope);
    return { flowId: "owned-flow", authorizeUrl: null, status, message: null };
  };
  const service = yield* makeMeerkatControlsService(
    { interactionTarget: () => Effect.die("Auth must not resolve an agent") },
    options.liveFlows
      ? { ...flows, runLogout }
      : {
          ...flows,
          status: (_id: string | undefined, _owner: string, scope: string) => view(scope),
          complete: async (_id: string | undefined, _owner: string, scope: string) => view(scope),
        },
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry)({
          getInstance: (id) => Effect.sync(() => (id === instanceId ? instance : undefined)),
        }),
        Layer.mock(WorkspacePaths)({
          normalizeWorkspaceRoot: (cwd) =>
            directoryExists
              ? Effect.succeed(cwd)
              : Effect.fail(
                  new WorkspaceRootNotExistsError({
                    workspaceRoot: cwd,
                    normalizedWorkspaceRoot: cwd,
                  }),
                ),
        }),
        Layer.mock(ProviderRegistry)({
          refreshWorkspaceSnapshot: (input) =>
            Effect.sync(() => {
              refreshes.push({ operation: "workspace", ...input });
              if (failRefresh) throw new Error("Projection unavailable");
              return [];
            }),
          refreshInstance: (id) =>
            Effect.sync(() => {
              refreshes.push({ operation: "default", instanceId: id });
              return [];
            }),
        }),
      ),
    ),
  );
  return {
    service,
    calls,
    refreshes,
    flowScopes,
    logoutStarted: logoutStarted.promise,
    callbackUrl: () => `${redirectUri}?state=native-state&code=good`,
    dispose: () => flows.dispose(),
    expectedRoot: meerkatProjectStateRoot(path, stateRoot, "/project-b"),
    expectedThreadRoot: meerkatProjectStateRoot(path, stateRoot, threadTarget.expectedCwd),
    setDirectoryExists: (value: boolean) => {
      directoryExists = value;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    replaceInstance: () => {
      instance = makeInstance();
    },
    setBinding: (value: { bindingId?: string; profileId?: string; realmId?: string }) => {
      bindingId = value.bindingId ?? bindingId;
      profileId = value.profileId ?? profileId;
      realmId = value.realmId ?? realmId;
    },
    setStatus: (value: MeerkatAuthFlow["status"]) => {
      status = value;
    },
    failLogout: () => {
      failLogout = true;
    },
    failRefresh: () => {
      failRefresh = true;
    },
  };
});

describe("Meerkat project account projection refresh", () => {
  it.effect(
    "resolves an existing thread checkout without a native session and refreshes that scope",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const overview = yield* h.service.authStatus(threadScope);
        expect(overview.workspace).toEqual({ projectId, threadId, cwd: threadTarget.expectedCwd });
        expect(overview.connections[0]?.bindingId).toBe("work");
        expect(h.calls).toEqual([
          {
            method: "auth.v1.status",
            params: { projectPath: threadTarget.expectedCwd, stateRoot: h.expectedThreadRoot },
          },
        ]);
        const result = yield* h.service.authAction(
          { ...threadScope, provider: "openai", action: "logout" },
          "owner",
        );
        expect(result.status).toBe("disconnected");
        expect(h.calls.at(-1)).toEqual({
          method: "auth.v1.logout",
          params: {
            projectPath: threadTarget.expectedCwd,
            stateRoot: h.expectedThreadRoot,
            provider: "openai",
          },
        });
        expect(h.refreshes).toEqual([
          { operation: "workspace", instanceId, cwd: threadTarget.expectedCwd, invalidate: true },
          { operation: "default", instanceId },
        ]);
      }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  it.effect("uses the registered root only when the owning thread has no worktree", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_threads SET worktree_path=NULL WHERE thread_id=${threadId}`;
      const overview = yield* h.service.authStatus({
        ...threadScope,
        threadTarget: { threadId, expectedCwd: "/project-b" },
      });
      expect(overview.workspace).toEqual({ projectId, threadId, cwd: "/project-b" });
      expect(h.calls[0]?.params).toEqual({ projectPath: "/project-b", stateRoot: h.expectedRoot });
    }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  it.effect(
    "rejects stale, missing, foreign and disabled targets before native account access",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        for (const input of [
          { ...threadScope, threadTarget: { ...threadTarget, expectedCwd: "/project-b" } },
          { ...threadScope, threadTarget: { ...threadTarget, expectedCwd: "worktrees/thread-b" } },
          { ...threadScope, threadTarget: { ...threadTarget, threadId: ThreadId.make("missing") } },
          { ...threadScope, instanceId: ProviderInstanceId.make("missing") },
          { ...threadScope, projectId: ProjectId.make("missing") },
        ]) {
          expect((yield* Effect.result(h.service.authStatus(input)))._tag).toBe("Failure");
          expect(
            (yield* Effect.result(
              h.service.authAction({ ...input, provider: "openai", action: "logout" }, "owner"),
            ))._tag,
          ).toBe("Failure");
        }
        h.setDirectoryExists(false);
        expect((yield* Effect.result(h.service.authStatus(threadScope)))._tag).toBe("Failure");
        h.setDirectoryExists(true);
        h.setEnabled(false);
        expect((yield* Effect.result(h.service.authStatus(threadScope)))._tag).toBe("Failure");
        h.setEnabled(true);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('another-project','Another','/another-project','[]','now','now')`;
        yield* sql`UPDATE projection_threads SET project_id='another-project' WHERE thread_id=${threadId}`;
        expect((yield* Effect.result(h.service.authStatus(threadScope)))._tag).toBe("Failure");
        yield* sql`UPDATE projection_threads SET project_id=${projectId},archived_at='now' WHERE thread_id=${threadId}`;
        expect((yield* Effect.result(h.service.authStatus(threadScope)))._tag).toBe("Failure");
        yield* sql`UPDATE projection_threads SET archived_at=NULL,deleted_at='now' WHERE thread_id=${threadId}`;
        expect((yield* Effect.result(h.service.authStatus(threadScope)))._tag).toBe("Failure");
        expect(h.calls).toEqual([]);
        expect(h.refreshes).toEqual([]);
      }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  it.effect("completes a thread sign-in once and publishes only its original checkout", () =>
    Effect.gen(function* () {
      const h = yield* Effect.acquireRelease(harness({ liveFlows: true }), (h) =>
        Effect.sync(h.dispose),
      );
      const flow = yield* h.service.authAction(
        { ...threadScope, provider: "openai", action: "start" },
        "owner",
      );
      const input = {
        ...threadScope,
        provider: "openai" as const,
        action: "complete" as const,
        flowId: flow.flowId!,
        callbackUrl: h.callbackUrl(),
      };
      expect((yield* h.service.authAction(input, "owner")).status).toBe("connected");
      expect((yield* h.service.authAction(input, "owner")).status).toBe("connected");
      expect(h.calls.filter(({ method }) => method === "auth.v1.loginComplete")).toEqual([
        {
          method: "auth.v1.loginComplete",
          params: {
            projectPath: threadTarget.expectedCwd,
            stateRoot: h.expectedThreadRoot,
            provider: "openai",
            redirectUri: new URL(h.callbackUrl()).origin + "/oauth/callback",
            state: "native-state",
            code: "good",
          },
        },
      ]);
      expect(
        h.refreshes
          .filter((entry) => entry.operation === "workspace")
          .every((entry) => entry.cwd === threadTarget.expectedCwd),
      ).toBe(true);
      expect(h.refreshes.length).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  it.effect("does not observe an old flow as a replacement provider's successful sign-in", () =>
    Effect.gen(function* () {
      const h = yield* Effect.acquireRelease(harness({ liveFlows: true }), (h) =>
        Effect.sync(h.dispose),
      );
      const flow = yield* h.service.authAction(
        { ...threadScope, provider: "openai", action: "start" },
        "owner",
      );
      yield* h.service.authAction(
        {
          ...threadScope,
          provider: "openai",
          action: "complete",
          flowId: flow.flowId!,
          callbackUrl: h.callbackUrl(),
        },
        "owner",
      );
      const calls = h.calls.length;
      const refreshes = h.refreshes.length;
      h.replaceInstance();
      const result = yield* Effect.result(
        h.service.authAction(
          { ...threadScope, provider: "openai", action: "status", flowId: flow.flowId! },
          "owner",
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(h.calls).toHaveLength(calls);
      expect(h.refreshes).toHaveLength(refreshes);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  it.effect("signing out cancels another thread's pending sign-in for the same checkout", () =>
    Effect.gen(function* () {
      const h = yield* Effect.acquireRelease(harness({ liveFlows: true }), (h) =>
        Effect.sync(h.dispose),
      );
      const siblingId = ThreadId.make("sibling-account-thread");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,worktree_path,created_at,updated_at) VALUES (${siblingId},${projectId},'Sibling','{}',${threadTarget.expectedCwd},'now','now')`;
      const siblingScope = {
        ...threadScope,
        threadTarget: { ...threadTarget, threadId: siblingId },
      };
      yield* h.service.authAction(
        { ...threadScope, provider: "openai", action: "start" },
        "owner-a",
      );
      const siblingFlow = yield* h.service.authAction(
        { ...siblingScope, provider: "openai", action: "start" },
        "owner-b",
      );
      const callbackUrl = h.callbackUrl();
      expect(
        (yield* h.service.authAction(
          { ...threadScope, provider: "openai", action: "logout" },
          "owner-a",
        )).status,
      ).toBe("disconnected");
      const result = yield* Effect.result(
        h.service.authAction(
          {
            ...siblingScope,
            provider: "openai",
            action: "complete",
            flowId: siblingFlow.flowId!,
            callbackUrl,
          },
          "owner-b",
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(h.calls.filter(({ method }) => method === "auth.v1.loginComplete")).toEqual([]);
      expect(h.calls.filter(({ method }) => method === "auth.v1.logout")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  for (const phase of ["auth.v1.status", "auth.v1.loginStart"] as const) {
    it.effect(
      `cancels a sibling sign-in while ${phase} is pending and discards its late result`,
      () =>
        Effect.gen(function* () {
          const entered = deferred<void>();
          const release = yield* Effect.acquireRelease(
            Effect.sync(() => deferred<void>()),
            (gate) => Effect.sync(() => gate.resolve(undefined)),
          );
          let held = false;
          const h = yield* Effect.acquireRelease(
            harness({
              liveFlows: true,
              beforeNativeRequest: async (method) => {
                if (method !== phase || held) return;
                held = true;
                entered.resolve(undefined);
                await release.promise;
              },
            }),
            (h) => Effect.sync(h.dispose),
          );
          const siblingId = ThreadId.make("pending-account-thread");
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,worktree_path,created_at,updated_at) VALUES (${siblingId},${projectId},'Sibling','{}',${threadTarget.expectedCwd},'now','now')`;
          const siblingScope = {
            ...threadScope,
            threadTarget: { ...threadTarget, threadId: siblingId },
          };
          const starting = yield* h.service
            .authAction({ ...siblingScope, provider: "openai", action: "start" }, "owner-b")
            .pipe(Effect.result, Effect.forkChild);
          yield* Effect.promise(() => entered.promise);
          const signingOut = yield* h.service
            .authAction({ ...threadScope, provider: "openai", action: "logout" }, "owner-a")
            .pipe(Effect.forkChild);
          // Native account requests share the checkout lease. Observe the logout
          // reservation before releasing the older native request holding that lease.
          yield* Effect.promise(() => h.logoutStarted);
          yield* Effect.sync(() => release.resolve(undefined));
          const startResult = yield* Fiber.join(starting);
          expect(startResult._tag).toBe("Failure");
          if (startResult._tag === "Failure")
            expect(startResult.failure.message).toContain("cancelled");
          expect((yield* Fiber.join(signingOut)).status).toBe("disconnected");
          expect(h.calls.filter(({ method }) => method === "auth.v1.loginStart")).toHaveLength(
            phase === "auth.v1.loginStart" ? 1 : 0,
          );
          expect(h.calls.filter(({ method }) => method === "auth.v1.loginComplete")).toEqual([]);
          expect(h.calls.filter(({ method }) => method === "auth.v1.logout")).toEqual([
            {
              method: "auth.v1.logout",
              params: {
                projectPath: threadTarget.expectedCwd,
                stateRoot: h.expectedThreadRoot,
                provider: "openai",
              },
            },
          ]);
          expect(h.refreshes).toEqual([
            { operation: "workspace", instanceId, cwd: threadTarget.expectedCwd, invalidate: true },
            { operation: "default", instanceId },
          ]);
          expect(
            (yield* h.service.authAction(
              { ...siblingScope, provider: "openai", action: "start" },
              "owner-b",
            )).status,
          ).toBe("waiting");
        }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
    );
  }

  it.effect(
    "blocks sibling sign-in until native logout settles without blocking another checkout",
    () =>
      Effect.gen(function* () {
        const entered = deferred<void>();
        const release = yield* Effect.acquireRelease(
          Effect.sync(() => deferred<void>()),
          (gate) => Effect.sync(() => gate.resolve(undefined)),
        );
        const h = yield* Effect.acquireRelease(
          harness({
            liveFlows: true,
            beforeNativeRequest: async (method) => {
              if (method !== "auth.v1.logout") return;
              entered.resolve(undefined);
              await release.promise;
            },
          }),
          (h) => Effect.sync(h.dispose),
        );
        const siblingId = ThreadId.make("logout-account-thread");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,worktree_path,created_at,updated_at) VALUES (${siblingId},${projectId},'Sibling','{}',${threadTarget.expectedCwd},'now','now')`;
        const siblingScope = {
          ...threadScope,
          threadTarget: { ...threadTarget, threadId: siblingId },
        };
        const signingOut = yield* h.service
          .authAction({ ...threadScope, provider: "openai", action: "logout" }, "owner-a")
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => entered.promise);
        const rejectedStart = yield* Effect.result(
          h.service.authAction({ ...siblingScope, provider: "openai", action: "start" }, "owner-b"),
        );
        expect(rejectedStart._tag).toBe("Failure");
        if (rejectedStart._tag === "Failure")
          expect(rejectedStart.failure.message).toContain("Sign-out is in progress");
        const rejectedLogout = yield* Effect.result(
          h.service.authAction(
            { ...siblingScope, provider: "openai", action: "logout" },
            "owner-b",
          ),
        );
        expect(rejectedLogout._tag).toBe("Failure");
        if (rejectedLogout._tag === "Failure")
          expect(rejectedLogout.failure.message).toContain("already in progress");
        expect(h.calls.map(({ method }) => method)).toEqual(["auth.v1.status", "auth.v1.logout"]);
        const otherCheckout = yield* h.service.authAction(
          { projectId, instanceId, provider: "openai", action: "start" },
          "owner-b",
        );
        expect(otherCheckout.status).toBe("waiting");
        expect(h.calls.at(-1)).toEqual({
          method: "auth.v1.loginStart",
          params: {
            projectPath: "/project-b",
            stateRoot: h.expectedRoot,
            provider: "openai",
            redirectUri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/),
          },
        });
        yield* Effect.sync(() => release.resolve(undefined));
        expect((yield* Fiber.join(signingOut)).status).toBe("disconnected");
        expect(
          (yield* h.service.authAction(
            { ...siblingScope, provider: "openai", action: "start" },
            "owner-b",
          )).status,
        ).toBe("waiting");
        expect(h.calls.filter(({ method }) => method === "auth.v1.logout")).toHaveLength(1);
        expect(h.calls.filter(({ method }) => method === "auth.v1.loginComplete")).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  for (const change of [
    "checkout",
    "deleted-thread",
    "missing-directory",
    "provider-instance",
    "binding",
    "profile",
    "realm",
  ] as const) {
    it.effect(`rejects a browser callback after its ${change} changes`, () =>
      Effect.gen(function* () {
        const h = yield* Effect.acquireRelease(harness({ liveFlows: true }), (h) =>
          Effect.sync(h.dispose),
        );
        yield* h.service.authAction(
          { ...threadScope, provider: "openai", action: "start" },
          "owner",
        );
        const sql = yield* SqlClient.SqlClient;
        if (change === "checkout")
          yield* sql`UPDATE projection_threads SET worktree_path='/other-checkout' WHERE thread_id=${threadId}`;
        if (change === "deleted-thread")
          yield* sql`UPDATE projection_threads SET deleted_at='now' WHERE thread_id=${threadId}`;
        if (change === "missing-directory") h.setDirectoryExists(false);
        if (change === "provider-instance") h.replaceInstance();
        if (change === "binding") h.setBinding({ bindingId: "replacement" });
        if (change === "profile") h.setBinding({ profileId: "replacement" });
        if (change === "realm") h.setBinding({ realmId: "replacement" });
        const response = yield* Effect.promise(() => fetch(h.callbackUrl()));
        expect(response.status).toBe(400);
        expect(yield* Effect.promise(() => response.text())).toContain("not completed");
        expect(h.calls.filter(({ method }) => method === "auth.v1.loginComplete")).toEqual([]);
        expect(h.refreshes).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
    );
  }

  it.effect(
    "publishes the original project readiness from the loopback callback without client polling",
    () =>
      Effect.gen(function* () {
        const h = yield* Effect.acquireRelease(harness({ liveFlows: true }), (h) =>
          Effect.sync(h.dispose),
        );
        const flow = yield* h.service.authAction(
          { projectId, instanceId, provider: "openai", action: "start" },
          "client-owner",
        );
        expect(flow.status).toBe("waiting");
        expect(h.refreshes).toEqual([]);
        const response = yield* Effect.promise(() => fetch(h.callbackUrl()));
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.text())).toContain("Signed in.");
        expect(h.refreshes).toEqual([
          { operation: "workspace", instanceId, cwd: "/project-b", invalidate: true },
          { operation: "default", instanceId },
        ]);
        expect(h.calls.map(({ method }) => method)).toEqual([
          "auth.v1.status",
          "auth.v1.loginStart",
          "auth.v1.status",
          "auth.v1.loginComplete",
        ]);
        expect(h.calls.at(-1)?.params).toEqual({
          projectPath: "/project-b",
          stateRoot: h.expectedRoot,
          provider: "openai",
          redirectUri: new URL(h.callbackUrl()).origin + "/oauth/callback",
          state: "native-state",
          code: "good",
        });
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  it.effect("invalidates scoped discovery on completion, callback observation, and logout", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      for (const action of ["complete", "logout", "status"] as const) {
        const result = yield* h.service.authAction(
          {
            projectId,
            instanceId,
            provider: "openai",
            action,
            flowId: "owned-flow",
            callbackUrl: "http://localhost/callback",
          },
          "client-owner",
        );
        expect(result.status).toBe(action === "logout" ? "disconnected" : "connected");
      }
      expect(h.refreshes).toEqual(
        Array.from({ length: 3 }, () => [
          { operation: "workspace", instanceId, cwd: "/project-b", invalidate: true },
          { operation: "default", instanceId },
        ]).flat(),
      );
      expect(h.flowScopes).toEqual([
        expect.stringMatching(new RegExp(`^${instanceId}:${h.expectedRoot}:instance:[0-9]+$`)),
        h.flowScopes[0],
      ]);
      expect(h.calls).toEqual([
        {
          method: "auth.v1.status",
          params: { projectPath: "/project-b", stateRoot: h.expectedRoot },
        },
        {
          method: "auth.v1.logout",
          params: { projectPath: "/project-b", stateRoot: h.expectedRoot, provider: "openai" },
        },
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  it.effect("does not publish successful account refresh for waiting or failed auth", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      for (const status of ["waiting", "failed", "cancelled"] as const) {
        h.setStatus(status);
        yield* h.service.authAction(
          { projectId, instanceId, provider: "openai", action: "status", flowId: "owned-flow" },
          "client-owner",
        );
      }
      h.failLogout();
      const result = yield* h.service
        .authAction({ projectId, instanceId, provider: "openai", action: "logout" }, "client-owner")
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(h.refreshes).toEqual([]);
    }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  it.effect("preserves native account receipts when the fallback projection refresh fails", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.failRefresh();
      for (const action of ["status", "logout"] as const) {
        const result = yield* h.service.authAction(
          { projectId, instanceId, provider: "openai", action, flowId: "owned-flow" },
          "client-owner",
        );
        expect(result.status).toBe(action === "logout" ? "disconnected" : "connected");
      }
      expect(h.refreshes).toEqual([
        { operation: "workspace", instanceId, cwd: "/project-b", invalidate: true },
        { operation: "workspace", instanceId, cwd: "/project-b", invalidate: true },
      ]);
      expect(h.calls.filter(({ method }) => method === "auth.v1.logout")).toHaveLength(1);
    }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );
});

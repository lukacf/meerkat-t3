// @effect-diagnostics globalFetchInEffect:off - Exercises the owned loopback callback with fake native responses.
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type MeerkatAuthFlow,
  type MeerkatAuthConnection,
  type MeerkatAuthMethod,
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
const accountIdentity = { realmId: "project-b-realm", bindingId: "work", profileId: "work" };
const threadScope = { projectId, instanceId, threadTarget, ...accountIdentity };
const browserMethod: MeerkatAuthMethod = {
  id: "openai-chatgpt",
  provider: "openai",
  displayName: "ChatGPT",
  authMethod: "managed_chatgpt_oauth",
  backendKind: "openai",
  flow: "browser",
  callback: { redirectHost: "localhost", path: "/auth/callback", ports: [0] },
  description: "Fixture browser sign-in",
  fields: [],
};
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
    connections?: ReadonlyArray<MeerkatAuthConnection>;
    methods?: ReadonlyArray<MeerkatAuthMethod>;
    configureError?: string;
    actionReceipt?: unknown;
    defaultActivation?: MeerkatAuthFlow["defaultActivation"];
    credentialsSaved?: boolean;
    configureState?: MeerkatAuthConnection["state"];
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
            methods: options.methods ?? [browserMethod],
            connections: options.connections ?? [
              {
                ...accountIdentity,
                provider: "openai",
                displayName: "OpenAI",
                realmId,
                bindingId,
                profileId,
                source: "oauth",
                state: "connected",
                supportsInteractiveLogin: true,
                supportsRemoval: true,
                authMethod: browserMethod.authMethod,
                backendKind: browserMethod.backendKind,
              },
            ],
          };
        if (method === "auth.v1.configure") {
          if (options.configureError) throw new Error(options.configureError);
          return {
            ...(options.defaultActivation ? { defaultActivation: options.defaultActivation } : {}),
            ...(options.credentialsSaved !== undefined
              ? { credentialsSaved: options.credentialsSaved }
              : {}),
            connection: {
              provider: "openai",
              displayName: "OpenAI",
              ...accountIdentity,
              source: "managed_store",
              state: options.configureState ?? "connected",
              supportsInteractiveLogin: false,
              authMethod: "api_key",
              editable: true,
            },
          };
        }
        if (method === "auth.v1.delete") return options.actionReceipt ?? { deleted: true };
        if (method === "auth.v1.check") return options.actionReceipt;
        if (method === "auth.v1.default") return options.actionReceipt ?? { updated: true };
        if (method === "auth.v1.logout") {
          if (failLogout) throw new Error("Native logout failed.");
          return options.actionReceipt ?? { cleared: true };
        }
        if (method === "auth.v1.loginStart") {
          redirectUri = String(params.redirectUri);
          return { authorizeUrl: "https://auth.example/start", state: "native-state" };
        }
        if (method === "auth.v1.loginComplete")
          return options.defaultActivation ? { defaultActivation: options.defaultActivation } : {};
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
          refreshInstance: (id, options) =>
            Effect.sync(() => {
              refreshes.push({ operation: "default", instanceId: id, ...options });
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
  const savedAccount: MeerkatAuthConnection = {
    ...accountIdentity,
    provider: "openai",
    displayName: "ChatGPT",
    source: "managed_store",
    state: "unknown",
    credentialObservation: "not_observed",
    supportsInteractiveLogin: true,
    editable: true,
  };
  it.effect(
    "checks a saved account only on explicit request and refreshes its exact checkout",
    () =>
      Effect.gen(function* () {
        const checked = {
          ...savedAccount,
          state: "connected" as const,
          credentialObservation: null,
        };
        const h = yield* harness({
          connections: [savedAccount],
          actionReceipt: { checked: true, connection: checked },
        });
        const overview = yield* h.service.authStatus(threadScope);
        expect(overview.connections[0]?.credentialObservation).toBe("not_observed");
        expect(h.calls.map(({ method }) => method)).toEqual(["auth.v1.status"]);
        const result = yield* h.service.authAction(
          { ...threadScope, provider: "openai", action: "check" },
          "owner",
        );
        expect(result).toMatchObject({ status: "connected", flowId: null, connection: checked });
        expect(h.calls.at(-1)).toEqual({
          method: "auth.v1.check",
          params: {
            provider: "openai",
            ...accountIdentity,
            projectPath: threadTarget.expectedCwd,
            stateRoot: h.expectedThreadRoot,
          },
        });
        expect(h.calls.map(({ method }) => method)).toEqual([
          "auth.v1.status",
          "auth.v1.status",
          "auth.v1.check",
        ]);
        expect(h.refreshes).toEqual([
          { operation: "workspace", instanceId, cwd: threadTarget.expectedCwd, invalidate: true },
          { operation: "default", instanceId },
        ]);
        expect(h.flowScopes).toEqual([]);
      }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  it.effect("keeps an unverified credential check unknown without starting OAuth", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        connections: [savedAccount],
        actionReceipt: {
          checked: true,
          connection: { ...savedAccount, credentialObservation: "pending" },
        },
      });
      const result = yield* h.service.authAction(
        { instanceId, ...accountIdentity, provider: "openai", action: "check" },
        "owner",
      );
      expect(result.status).toBe("disconnected");
      expect(result.connection?.state).toBe("unknown");
      expect(result.connection?.credentialObservation).toBe("pending");
      expect(h.calls.map(({ method }) => method)).toEqual(["auth.v1.status", "auth.v1.check"]);
      expect(h.refreshes).toEqual([
        { operation: "default", instanceId, invalidateWorkspaces: true },
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  it.effect.each(["negative", "other-account"])(
    "rejects a %s credential check receipt",
    (receipt) =>
      Effect.gen(function* () {
        const h = yield* harness({
          connections: [savedAccount],
          actionReceipt: {
            checked: receipt !== "negative",
            connection: {
              ...savedAccount,
              profileId: receipt === "other-account" ? "other" : savedAccount.profileId,
            },
          },
        });
        const result = yield* Effect.result(
          h.service.authAction(
            { instanceId, ...accountIdentity, provider: "openai", action: "check" },
            "owner",
          ),
        );
        expect(result._tag).toBe("Failure");
        expect(h.refreshes).toEqual([]);
      }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

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
          { ...threadScope, ...accountIdentity, provider: "openai", action: "logout" },
          "owner",
        );
        expect(result.status).toBe("disconnected");
        expect(h.calls.at(-1)).toEqual({
          method: "auth.v1.logout",
          params: {
            projectPath: threadTarget.expectedCwd,
            stateRoot: h.expectedThreadRoot,
            ...accountIdentity,
            provider: "openai",
            realmId: "project-b-realm",
            bindingId: "work",
            profileId: "work",
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
              h.service.authAction(
                { ...input, ...accountIdentity, provider: "openai", action: "logout" },
                "owner",
              ),
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
        { ...threadScope, ...accountIdentity, provider: "openai", action: "start" },
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
            ...accountIdentity,
            provider: "openai",
            realmId: "project-b-realm",
            bindingId: "work",
            profileId: "work",
            redirectUri: new URL(h.callbackUrl()).origin + "/auth/callback",
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
        { ...threadScope, ...accountIdentity, provider: "openai", action: "start" },
        "owner",
      );
      yield* h.service.authAction(
        {
          ...threadScope,
          ...accountIdentity,
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
          {
            ...threadScope,
            ...accountIdentity,
            provider: "openai",
            action: "status",
            flowId: flow.flowId!,
          },
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
        { ...threadScope, ...accountIdentity, provider: "openai", action: "start" },
        "owner-a",
      );
      const siblingFlow = yield* h.service.authAction(
        { ...siblingScope, ...accountIdentity, provider: "openai", action: "start" },
        "owner-b",
      );
      const callbackUrl = h.callbackUrl();
      expect(
        (yield* h.service.authAction(
          { ...threadScope, ...accountIdentity, provider: "openai", action: "logout" },
          "owner-a",
        )).status,
      ).toBe("disconnected");
      const result = yield* Effect.result(
        h.service.authAction(
          {
            ...siblingScope,
            ...accountIdentity,
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
            .authAction(
              { ...siblingScope, ...accountIdentity, provider: "openai", action: "start" },
              "owner-b",
            )
            .pipe(Effect.result, Effect.forkChild);
          yield* Effect.promise(() => entered.promise);
          const signingOut = yield* h.service
            .authAction(
              { ...threadScope, ...accountIdentity, provider: "openai", action: "logout" },
              "owner-a",
            )
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
                ...accountIdentity,
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
              { ...siblingScope, ...accountIdentity, provider: "openai", action: "start" },
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
          .authAction(
            { ...threadScope, ...accountIdentity, provider: "openai", action: "logout" },
            "owner-a",
          )
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => entered.promise);
        const rejectedStart = yield* Effect.result(
          h.service.authAction(
            { ...siblingScope, ...accountIdentity, provider: "openai", action: "start" },
            "owner-b",
          ),
        );
        expect(rejectedStart._tag).toBe("Failure");
        if (rejectedStart._tag === "Failure")
          expect(rejectedStart.failure.message).toContain("Sign-out is in progress");
        const rejectedLogout = yield* Effect.result(
          h.service.authAction(
            { ...siblingScope, ...accountIdentity, provider: "openai", action: "logout" },
            "owner-b",
          ),
        );
        expect(rejectedLogout._tag).toBe("Failure");
        if (rejectedLogout._tag === "Failure")
          expect(rejectedLogout.failure.message).toContain("already in progress");
        expect(h.calls.map(({ method }) => method)).toEqual(["auth.v1.status", "auth.v1.logout"]);
        const otherCheckout = yield* h.service.authAction(
          { projectId, instanceId, ...accountIdentity, provider: "openai", action: "start" },
          "owner-b",
        );
        expect(otherCheckout.status).toBe("waiting");
        expect(h.calls.at(-1)).toEqual({
          method: "auth.v1.loginStart",
          params: {
            projectPath: "/project-b",
            stateRoot: h.expectedRoot,
            ...accountIdentity,
            provider: "openai",
            realmId: "project-b-realm",
            bindingId: "work",
            profileId: "work",
            redirectUri: expect.stringMatching(/^http:\/\/localhost:\d+\/auth\/callback$/),
          },
        });
        yield* Effect.sync(() => release.resolve(undefined));
        expect((yield* Fiber.join(signingOut)).status).toBe("disconnected");
        expect(
          (yield* h.service.authAction(
            { ...siblingScope, ...accountIdentity, provider: "openai", action: "start" },
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
          { ...threadScope, ...accountIdentity, provider: "openai", action: "start" },
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
          { projectId, instanceId, ...accountIdentity, provider: "openai", action: "start" },
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
          ...accountIdentity,
          provider: "openai",
          realmId: "project-b-realm",
          bindingId: "work",
          profileId: "work",
          redirectUri: new URL(h.callbackUrl()).origin + "/auth/callback",
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
            ...accountIdentity,
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
        expect.stringMatching(new RegExp(`^${instanceId}:${h.expectedRoot}:instance:[0-9]+:.*$`)),
        h.flowScopes[0],
      ]);
      expect(h.calls).toEqual([
        {
          method: "auth.v1.status",
          params: { projectPath: "/project-b", stateRoot: h.expectedRoot },
        },
        {
          method: "auth.v1.logout",
          params: {
            projectPath: "/project-b",
            stateRoot: h.expectedRoot,
            ...accountIdentity,
            provider: "openai",
          },
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
          {
            projectId,
            instanceId,
            ...accountIdentity,
            provider: "openai",
            action: "status",
            flowId: "owned-flow",
          },
          "client-owner",
        );
      }
      h.failLogout();
      const result = yield* h.service
        .authAction(
          { projectId, instanceId, ...accountIdentity, provider: "openai", action: "logout" },
          "client-owner",
        )
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
          {
            projectId,
            instanceId,
            ...accountIdentity,
            provider: "openai",
            action,
            flowId: "owned-flow",
          },
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

const apiKeyMethod = {
  id: "openai-api-key",
  provider: "openai",
  displayName: "OpenAI API key",
  authMethod: "api_key",
  backendKind: "openai_api",
  flow: "secret" as const,
  description: "Use an API key",
  fields: [],
};

describe("Native account settings", () => {
  for (const status of ["updated", "needs_selection"] as const) {
    it.effect(
      `preserves saved credentials and ${status} defaults when verification is unavailable`,
      () =>
        Effect.gen(function* () {
          const defaultActivation = { status, providers: status === "updated" ? ["openai"] : [] };
          const h = yield* harness({
            methods: [apiKeyMethod],
            defaultActivation,
            credentialsSaved: true,
            configureState: "unknown",
          });
          const result = yield* h.service.authAction(
            {
              instanceId,
              provider: "openai",
              action: "configure",
              methodId: apiKeyMethod.id,
              secret: "fixture-key",
            },
            "owner",
          );
          expect(result).toMatchObject({
            status: "disconnected",
            credentialsSaved: true,
            defaultActivation,
            connection: { ...accountIdentity, state: "unknown" },
          });
          expect(result.message).toBe(
            "Credentials saved. Refresh account status to check the connection.",
          );
          expect(result.connection?.isDefault).toBeUndefined();
          expect(h.calls.map(({ method }) => method)).toEqual([
            "auth.v1.status",
            "auth.v1.configure",
          ]);
          expect(h.refreshes).toEqual([
            { operation: "default", instanceId, invalidateWorkspaces: true },
          ]);
        }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
    );
  }

  for (const status of ["updated", "unchanged", "needs_selection"] as const) {
    it.effect(`preserves ${status} activation after saved credentials and browser sign-in`, () =>
      Effect.gen(function* () {
        const defaultActivation = { status, providers: status === "updated" ? ["openai"] : [] };
        const h = yield* Effect.acquireRelease(
          harness({ liveFlows: true, methods: [apiKeyMethod, browserMethod], defaultActivation }),
          (h) => Effect.sync(h.dispose),
        );
        // Creation and replacement use the same native activation receipt.
        for (const identity of [{}, accountIdentity]) {
          const configured = yield* h.service.authAction(
            {
              instanceId,
              ...identity,
              provider: "openai",
              action: "configure",
              methodId: apiKeyMethod.id,
              secret: "fixture-key",
            },
            "owner",
          );
          expect(configured.status).toBe("connected");
          expect(configured.defaultActivation).toEqual(defaultActivation);
          if (status === "needs_selection")
            expect(configured.message).toContain("Choose a default");
        }
        const scope = { instanceId, ...accountIdentity, provider: "openai" };
        const flow = yield* h.service.authAction({ ...scope, action: "start" }, "owner");
        const connected = yield* h.service.authAction(
          { ...scope, action: "complete", flowId: flow.flowId!, callbackUrl: h.callbackUrl() },
          "owner",
        );
        expect(connected.status).toBe("connected");
        expect(connected.defaultActivation).toEqual(defaultActivation);
        if (status === "needs_selection") expect(connected.message).toContain("Choose a default");
        expect(
          yield* h.service.authAction(
            { ...scope, action: "status", flowId: flow.flowId! },
            "owner",
          ),
        ).toEqual(connected);
        expect(h.refreshes.length).toBeGreaterThanOrEqual(4);
        expect(h.refreshes.every((refresh) => refresh.invalidateWorkspaces === true)).toBe(true);
        expect(h.calls.some(({ method }) => method === "auth.v1.default")).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
    );
  }

  it.effect("preserves native secret labels and deployment fields for cloud credentials", () =>
    Effect.gen(function* () {
      const method: MeerkatAuthMethod = {
        id: "bedrock-bearer",
        provider: "anthropic",
        displayName: "Amazon Bedrock",
        authMethod: "bedrock_bearer",
        backendKind: "bedrock",
        flow: "secret",
        description: "Connect with a bearer token",
        secretLabel: "Bearer token",
        fields: [
          { key: "endpoint", label: "Endpoint", required: true, secret: false },
          { key: "model", label: "Model", required: true, secret: false },
        ],
      };
      const h = yield* harness({ methods: [method] });
      expect((yield* h.service.authStatus({ instanceId })).methods?.[0]?.secretLabel).toBe(
        "Bearer token",
      );
      const fields = { endpoint: "https://cloud.fixture.example", model: "fixture-deployment" };
      const missing = yield* Effect.result(
        h.service.authAction(
          {
            instanceId,
            provider: method.provider,
            action: "configure",
            methodId: method.id,
            fields,
          },
          "owner",
        ),
      );
      expect(missing._tag).toBe("Failure");
      if (missing._tag === "Failure")
        expect(missing.failure.message).toBe("Bearer token is required to save this account.");
      yield* h.service.authAction(
        {
          instanceId,
          provider: method.provider,
          action: "configure",
          methodId: method.id,
          fields,
          secret: "fixture-bearer",
        },
        "owner",
      );
      expect(h.calls.at(-1)).toEqual({
        method: "auth.v1.configure",
        params: {
          methodId: method.id,
          fields,
          secret: "fixture-bearer",
        },
      });
    }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  it.effect(
    "permits exact secret replacement in its checkout but rejects scoped account creation",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({
          methods: [apiKeyMethod],
          connections: [
            {
              provider: "openai",
              displayName: "OpenAI",
              ...accountIdentity,
              source: "managed_store",
              state: "connected",
              editable: true,
              supportsSecretUpdate: true,
              supportsInteractiveLogin: false,
            },
          ],
        });
        yield* h.service.authAction(
          {
            ...threadScope,
            provider: "openai",
            action: "configure",
            methodId: apiKeyMethod.id,
            secret: "replacement-fixture",
          },
          "owner",
        );
        expect(h.calls.at(-1)).toEqual({
          method: "auth.v1.configure",
          params: {
            projectPath: threadTarget.expectedCwd,
            stateRoot: h.expectedThreadRoot,
            methodId: apiKeyMethod.id,
            ...accountIdentity,
            fields: {},
            secret: "replacement-fixture",
          },
        });
        expect(
          (yield* Effect.result(
            h.service.authAction(
              {
                instanceId,
                projectId,
                provider: "openai",
                action: "configure",
                methodId: apiKeyMethod.id,
                secret: "new-fixture",
              },
              "owner",
            ),
          ))._tag,
        ).toBe("Failure");
      }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  it.effect("preserves safe endpoint fields on exact credential replacement", () =>
    Effect.gen(function* () {
      const method = {
        ...apiKeyMethod,
        fields: [{ key: "endpoint", label: "Endpoint", required: true, secret: false }],
      };
      const h = yield* harness({
        methods: [method],
        connections: [
          {
            provider: "openai",
            displayName: "OpenAI",
            ...accountIdentity,
            source: "managed_store",
            state: "connected",
            editable: true,
            supportsSecretUpdate: true,
            supportsInteractiveLogin: false,
            fields: { endpoint: "https://fixture.example" },
          },
        ],
      });
      const overview = yield* h.service.authStatus({ instanceId });
      expect(overview.connections[0]?.fields).toEqual({ endpoint: "https://fixture.example" });
      yield* h.service.authAction(
        {
          instanceId,
          provider: "openai",
          action: "configure",
          ...accountIdentity,
          methodId: method.id,
          secret: "replacement-fixture",
        },
        "owner",
      );
      expect(h.calls.at(-1)).toEqual({
        method: "auth.v1.configure",
        params: {
          methodId: method.id,
          ...accountIdentity,
          fields: {},
          secret: "replacement-fixture",
        },
      });
    }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  it.effect("rejects negative native receipts instead of reporting account success", () =>
    Effect.gen(function* () {
      const h = yield* harness({ actionReceipt: { cleared: false, updated: false } });
      for (const action of ["logout", "delete", "default"] as const) {
        expect(
          (yield* Effect.result(
            h.service.authAction(
              { instanceId, provider: "openai", ...accountIdentity, action },
              "owner",
            ),
          ))._tag,
        ).toBe("Failure");
      }
      expect(h.refreshes).toEqual([]);
    }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  it.effect("does not report account removal from a credential-only logout receipt", () =>
    Effect.gen(function* () {
      const h = yield* harness({ actionReceipt: { cleared: true, state: "needs_auth" } });
      const result = yield* Effect.result(
        h.service.authAction(
          { instanceId, provider: "openai", ...accountIdentity, action: "delete" },
          "owner",
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(h.calls.at(-1)?.method).toBe("auth.v1.delete");
      expect(h.refreshes).toEqual([]);
    }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  it.effect("refuses browser sign-in without the native callback contract", () =>
    Effect.gen(function* () {
      const { callback: _callback, ...legacyMethod } = browserMethod;
      const h = yield* harness({ methods: [legacyMethod] });
      try {
        const result = yield* Effect.result(
          h.service.authAction(
            { instanceId, provider: "openai", ...accountIdentity, action: "start" },
            "owner",
          ),
        );
        expect(result._tag).toBe("Failure");
        expect(h.calls.some((call) => call.method === "auth.v1.loginStart")).toBe(false);
      } finally {
        h.dispose();
      }
    }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  it.effect.each([undefined, false])(
    "requires native removal capability before deleting an account (%s)",
    (supportsRemoval) =>
      Effect.gen(function* () {
        const h = yield* harness({
          connections: [
            {
              ...accountIdentity,
              provider: "openai",
              displayName: "OpenAI",
              source: "managed_store",
              state: "needs_auth",
              supportsInteractiveLogin: true,
              editable: true,
              ...(supportsRemoval === undefined ? {} : { supportsRemoval }),
            },
          ],
        });
        const result = yield* Effect.result(
          h.service.authAction(
            { instanceId, provider: "openai", ...accountIdentity, action: "delete" },
            "owner",
          ),
        );
        expect(result._tag).toBe("Failure");
        expect(h.calls.some((call) => call.method === "auth.v1.delete")).toBe(false);
      }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  it.effect("lists and configures accounts without creating or selecting a project", () =>
    Effect.gen(function* () {
      const h = yield* harness({ methods: [apiKeyMethod] });
      const overview = yield* h.service.authStatus({ instanceId });
      expect(overview.workspace).toBeUndefined();
      expect(overview.methods).toEqual([apiKeyMethod]);
      expect(h.calls[0]).toEqual({ method: "auth.v1.status", params: {} });
      const configured = yield* h.service.authAction(
        {
          instanceId,
          provider: "openai",
          action: "configure",
          methodId: apiKeyMethod.id,
          secret: "fixture-key",
        },
        "owner",
      );
      expect(configured.connection?.bindingId).toBe("work");
      expect(h.calls.at(-1)).toEqual({
        method: "auth.v1.configure",
        params: {
          methodId: apiKeyMethod.id,
          fields: {},
          secret: "fixture-key",
        },
      });
      expect(h.refreshes).toEqual([
        { operation: "default", instanceId, invalidateWorkspaces: true },
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  it.effect("invalidates cached project models when a global account changes", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      for (const action of ["default", "delete", "logout"] as const) {
        yield* h.service.authAction(
          { instanceId, provider: "openai", ...accountIdentity, action },
          "owner",
        );
      }
      expect(h.refreshes).toEqual([
        { operation: "default", instanceId, invalidateWorkspaces: true },
        { operation: "default", instanceId, invalidateWorkspaces: true },
        { operation: "default", instanceId, invalidateWorkspaces: true },
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  it.effect(
    "rejects a conversation without its project and actions without complete identity",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        expect(
          (yield* Effect.result(h.service.authStatus({ instanceId, threadTarget })))._tag,
        ).toBe("Failure");
        for (const identity of [
          {},
          { realmId: "global" },
          { realmId: "global", bindingId: "work" },
        ]) {
          expect(
            (yield* Effect.result(
              h.service.authAction(
                { instanceId, provider: "openai", action: "logout", ...identity },
                "owner",
              ),
            ))._tag,
          ).toBe("Failure");
        }
        expect(h.calls).toEqual([]);
      }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  it.effect("targets one account when the provider has several bindings", () =>
    Effect.gen(function* () {
      const base = {
        provider: "openai",
        displayName: "OpenAI",
        realmId: "global",
        source: "managed_store",
        state: "connected" as const,
        supportsInteractiveLogin: true,
        editable: true,
      };
      const h = yield* harness({
        connections: [
          { ...base, bindingId: "personal", profileId: "personal" },
          { ...base, bindingId: "work", profileId: "work" },
        ],
      });
      yield* h.service.authAction(
        {
          instanceId,
          provider: "openai",
          action: "logout",
          realmId: "global",
          bindingId: "work",
          profileId: "work",
        },
        "owner",
      );
      expect(h.calls.at(-1)).toEqual({
        method: "auth.v1.logout",
        params: {
          provider: "openai",
          realmId: "global",
          bindingId: "work",
          profileId: "work",
        },
      });
    }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );

  it.effect("refuses host-managed edits and redacts rejected credential values", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        methods: [apiKeyMethod],
        configureError: "Invalid fixture-secret",
        connections: [
          {
            provider: "openai",
            displayName: "OpenAI",
            ...accountIdentity,
            source: "env",
            state: "connected",
            supportsInteractiveLogin: false,
            editable: false,
          },
        ],
      });
      expect(
        (yield* Effect.result(
          h.service.authAction(
            { instanceId, provider: "openai", action: "delete", ...accountIdentity },
            "owner",
          ),
        ))._tag,
      ).toBe("Failure");
      const failure = yield* Effect.result(
        h.service.authAction(
          {
            instanceId,
            provider: "openai",
            action: "configure",
            methodId: apiKeyMethod.id,
            secret: "fixture-secret",
          },
          "owner",
        ),
      );
      expect(failure._tag).toBe("Failure");
      if (failure._tag === "Failure") expect(failure.failure.message).toBe("Invalid [redacted]");
      expect(h.calls.some((call) => call.method === "auth.v1.delete")).toBe(false);
    }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, Path.layer))),
  );
});

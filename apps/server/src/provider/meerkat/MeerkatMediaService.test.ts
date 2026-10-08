import { afterEach, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MeerkatTeamError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ConsoleIdentityRecord,
  type MeerkatTeamAgent,
  type MeerkatBrowserGrant,
  DEFAULT_SERVER_SETTINGS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  clearAllMcpProviderSessions,
  setMcpProviderSession,
} from "../../mcp/McpProviderSession.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { makeMeerkatMediaService } from "./MeerkatMediaService.ts";
import { makeMeerkatObservedAgents } from "./MeerkatObservedAgents.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import type { MeerkatTeamReader } from "./MeerkatTeamReader.ts";
const projectId = ProjectId.make("project"),
  instanceId = ProviderInstanceId.make("native"),
  threadId = ThreadId.make("browser-thread");
const record: ConsoleIdentityRecord = {
  identity: "worker",
  display_name: "Worker",
  runtime_key: "default",
  runtime_member_id: "member",
  session_id: "session",
  visibility: "addressable",
  addressable: true,
  health: "ready",
  labels: { source_mob_id: "child" },
};
const agent: MeerkatTeamAgent = {
  agentRef: "exact-agent",
  mobId: "root",
  mobLabel: "Root",
  mobKind: "domain",
  scopeLabel: "Project",
  record,
};
const blob = { blobId: `sha256:${"a".repeat(64)}`, mediaType: "image/png" as const, size: 8 };
const testLayer = Layer.mergeAll(SqlitePersistenceMemory, Path.layer);
afterEach(clearAllMcpProviderSessions);
const harness = Effect.fnUntraced(function* () {
  const calls: { method: string; params: unknown }[] = [];
  let providerStateRoot = "/provider-state",
    liveReads = 0;
  let browserAllowed = true;
  let browserResponse: typeof MeerkatBrowserGrant.Type = {
    enabled: true,
    sessionId: "session",
    hostThreadId: threadId,
    hostSessionId: "issued-a",
    tools: ["preview_open"],
  };
  let onGrant = () => {};
  let liveRecord = record;
  const reader: MeerkatTeamReader = {
    get stateRoot() {
      return providerStateRoot;
    },
    snapshot: () => Effect.die("No runtime observation expected"),
    activity: () => Effect.die("No timeline read expected"),
  };
  const instance: ProviderInstance = {
    instanceId,
    driverKind: ProviderDriverKind.make("meerkat"),
    continuationIdentity: {
      driverKind: ProviderDriverKind.make("meerkat"),
      continuationKey: instanceId,
    },
    displayName: "Native",
    enabled: true,
    meerkatTeam: reader,
    meerkatMedia: {
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "mobs.v1.browserConfigure") onGrant();
        return method === "mobs.v1.imageRead"
          ? { mobId: "root", blob, dataBase64: "image" }
          : browserResponse;
      },
    },
    get adapter(): never {
      throw Error("No adapter admission");
    },
    get snapshot(): never {
      throw Error("No catalog");
    },
    get textGeneration(): never {
      throw Error("No model calls");
    },
  };
  const service = yield* makeMeerkatMediaService({
    interactionTarget: (input) =>
      Effect.suspend(() => {
        liveReads++;
        return input.projectId === projectId &&
          input.instanceId === instanceId &&
          (input.agentRef === agent.agentRef || input.threadId === threadId)
          ? Effect.succeed({
              reader,
              projectPath: "/project",
              stateRoot: "/native-scope",
              mobId: "root",
              mobKind: "domain",
              record: liveRecord,
              ambiguous: false,
            })
          : Effect.fail(
              new MeerkatTeamError({
                operation: "agent-control",
                projectId: input.projectId,
                message: "Unowned target",
              }),
            );
      }),
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry)({
          getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
        }),
        Layer.mock(ServerSettingsService)({
          getSettings: Effect.sync(() => ({
            ...DEFAULT_SERVER_SETTINGS,
            enableAgentBrowserAccess: browserAllowed,
          })),
        }),
        Layer.mock(ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("local")),
        }),
      ),
    ),
  );
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Project','/project','[]','now','now')`;
  const observed = yield* makeMeerkatObservedAgents;
  yield* observed.save({
    projectId,
    instanceId,
    providerStateRoot,
    projectPath: "/project",
    stateRoot: "/native-scope",
    agent,
    observedAt: "2026-09-26T00:00:00Z",
  });
  return {
    service,
    calls,
    sql,
    setBrowserAllowed: (value: boolean) => {
      browserAllowed = value;
    },
    setBrowserResponse: (value: typeof browserResponse) => {
      browserResponse = value;
    },
    onGrant: (fn: () => void) => {
      onGrant = fn;
    },
    setRecord: (value: ConsoleIdentityRecord) => {
      liveRecord = value;
    },
    browserThread: (workspace: string | null = null) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,worktree_path,created_at,updated_at) VALUES (${threadId},${projectId},'Browser','{}',${workspace},'now','now')`;
        yield* sql`INSERT INTO provider_session_runtime (thread_id,provider_name,provider_instance_id,adapter_key,status,last_seen_at) VALUES (${threadId},'meerkat',${instanceId},'meerkat','running','now')`;
      }),
    setProviderRoot: (value: string) => {
      providerStateRoot = value;
    },
    liveReads: () => liveReads,
  };
});
it.effect("reads saved images without runtime admission and refuses a changed provider", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const value = yield* h.service.imageRead({
      projectId,
      instanceId,
      agentRef: agent.agentRef,
      blobId: blob.blobId,
    });
    expect(value.blob).toEqual(blob);
    expect(h.liveReads()).toBe(0);
    expect(h.calls).toEqual([
      {
        method: "mobs.v1.imageRead",
        params: {
          projectPath: "/project",
          stateRoot: "/native-scope",
          mobId: "root",
          blobId: blob.blobId,
        },
      },
    ]);
    h.setProviderRoot("/replacement-provider");
    const rejected = yield* h.service
      .imageRead({ projectId, instanceId, agentRef: agent.agentRef, blobId: blob.blobId })
      .pipe(Effect.result);
    expect(rejected._tag).toBe("Failure");
    expect(h.calls).toHaveLength(1);
  }).pipe(Effect.provide(testLayer)),
);
it.effect("refuses cross-project image references before calling native storage", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const rejected = yield* h.service
      .imageRead({
        projectId: ProjectId.make("foreign"),
        instanceId,
        agentRef: agent.agentRef,
        blobId: blob.blobId,
      })
      .pipe(Effect.result);
    expect(rejected._tag).toBe("Failure");
    expect(h.calls).toHaveLength(0);
  }).pipe(Effect.provide(testLayer)),
);
it.effect("browser status requires the exact live T3 credential session", () =>
  Effect.gen(function* () {
    const h = yield* harness(),
      input = { projectId, instanceId, agentRef: agent.agentRef };
    expect((yield* h.service.browserStatus(input)).enabled).toBe(false);
    const config = {
      environmentId: EnvironmentId.make("local"),
      threadId,
      providerSessionId: "issued-a",
      providerInstanceId: instanceId,
      endpoint: "http://127.0.0.1:1234/mcp",
      authorizationHeader: "Bearer test",
      capabilities: new Set(["preview"]),
    };
    setMcpProviderSession(config);
    expect((yield* h.service.browserStatus(input)).enabled).toBe(true);
    setMcpProviderSession({ ...config, providerSessionId: "issued-b" });
    expect((yield* h.service.browserStatus(input)).enabled).toBe(false);
    expect(h.calls.every((call) => call.method === "mobs.v1.browserStatus")).toBe(true);
  }).pipe(Effect.provide(testLayer)),
);

const browserCredential = {
  environmentId: EnvironmentId.make("local"),
  threadId,
  providerSessionId: "issued-a",
  providerInstanceId: instanceId,
  endpoint: "http://127.0.0.1:1234/mcp",
  authorizationHeader: "Bearer test",
  capabilities: new Set(["preview"]),
};
const browserInput = {
  projectId,
  instanceId,
  agentRef: agent.agentRef,
  hostThreadId: threadId,
  enabled: true,
};
it.effect("grants only the exact native incarnation in the browser thread checkout", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.browserThread();
    setMcpProviderSession(browserCredential);
    expect((yield* h.service.browserGrant(browserInput)).enabled).toBe(true);
    expect(h.calls[0]).toEqual({
      method: "mobs.v1.browserConfigure",
      params: {
        projectPath: "/project",
        stateRoot: "/native-scope",
        mobId: "root",
        expected: {
          identity: "worker",
          runtimeKey: "default",
          runtimeMemberId: "member",
          sessionId: "session",
          sourceMobId: "child",
        },
        enabled: true,
        hostThreadId: threadId,
        hostSessionId: "issued-a",
        endpoint: browserCredential.endpoint,
        authorizationHeader: browserCredential.authorizationHeader,
      },
    });
    expect(h.liveReads()).toBe(2);
  }).pipe(Effect.provide(testLayer)),
);
it.effect("blocks cross-worktree sharing before forwarding browser credentials", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.browserThread("/different-worktree");
    setMcpProviderSession(browserCredential);
    expect((yield* h.service.browserGrant(browserInput)).reason).toBe("wrong-workspace");
    expect(h.calls).toHaveLength(0);
  }).pipe(Effect.provide(testLayer)),
);
it.effect(
  "reports disabled and remote-session states without granting and still permits revocation",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.browserThread();
      h.setBrowserAllowed(false);
      setMcpProviderSession(browserCredential);
      expect((yield* h.service.browserGrant(browserInput)).reason).toBe("disabled");
      expect((yield* h.service.browserStatus(browserInput)).reason).toBe("disabled");
      expect(h.calls).toHaveLength(0);
      yield* h.service.browserGrant({ ...browserInput, enabled: false });
      expect(h.calls).toHaveLength(1);
      h.setBrowserAllowed(true);
      setMcpProviderSession({ ...browserCredential, environmentId: EnvironmentId.make("remote") });
      expect((yield* h.service.browserGrant(browserInput)).reason).toBe("no-session");
      expect(h.calls).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
);
it.effect("propagates host unavailability and fences a credential replacement during grant", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.browserThread();
    setMcpProviderSession(browserCredential);
    h.setBrowserResponse({ enabled: false, reason: "no-host", message: "Open the desktop app." });
    expect((yield* h.service.browserGrant(browserInput)).reason).toBe("no-host");
    h.setBrowserResponse({ enabled: true, grantRevision: 7 });
    h.onGrant(() =>
      setMcpProviderSession({ ...browserCredential, providerSessionId: "replacement" }),
    );
    expect((yield* h.service.browserGrant(browserInput).pipe(Effect.result))._tag).toBe("Failure");
    expect(h.calls.at(-1)?.params).toMatchObject({ enabled: false, expectedGrantRevision: 7 });
  }).pipe(Effect.provide(testLayer)),
);
it.effect("includes the exact coordinator witness for thread browser grants", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.browserThread();
    setMcpProviderSession(browserCredential);
    h.setRecord({ ...record, identity: "coordinator", runtime_member_id: "ingress", labels: {} });
    yield* h.service.browserGrant({ projectId, instanceId, threadId, enabled: true });
    expect(h.calls[0]?.params).toMatchObject({
      expected: {
        identity: "coordinator",
        runtimeMemberId: "ingress",
        sessionId: "session",
        sourceMobId: null,
      },
    });
  }).pipe(Effect.provide(testLayer)),
);

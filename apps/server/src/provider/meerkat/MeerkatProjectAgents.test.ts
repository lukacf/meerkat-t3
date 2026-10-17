// @effect-diagnostics nodeBuiltinImport:off - isolated realpath and symlink fixtures test ownership boundaries.
import { describe, expect, it } from "@effect/vitest";
import {
  ComposerContextId,
  type ConsoleIdentityRecord,
  type ConsoleFrame,
  type ConsoleTimelineWindowPage,
  type MeerkatPeerEndpoint,
  type MeerkatAgentWork,
  MeerkatTeamError,
  ProjectId,
  type ProjectCloneSnapshot,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectCloneTracker } from "../../project/ProjectCloneTracker.ts";
import { ProviderDriverError } from "../Errors.ts";
import { meerkatProjectStateRoot } from "../Layers/MeerkatAdapter.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { makeMeerkatTeamService } from "./MeerkatTeamService.ts";
import { MeerkatGatewayRpcError } from "./MeerkatGatewayClient.ts";
import { agentFingerprint, makeMeerkatProjectAgentStore } from "./MeerkatProjectAgentStore.ts";
import { makeMeerkatAgentQueueService } from "./MeerkatAgentQueueService.ts";
import type {
  MeerkatDomainDefinition,
  MeerkatNativeTeamSnapshot,
  MeerkatTeamReader,
  MeerkatNativeReceipt,
} from "./MeerkatTeamReader.ts";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";

const projectId = ProjectId.make("agents-project");
const otherProjectId = ProjectId.make("other-project");
const instanceId = ProviderInstanceId.make("meerkat-agents");
const model = "anthropic:claude-haiku-4-5";
const cold: MeerkatNativeTeamSnapshot = { observation: "loaded_runtimes", loaded: false, mobs: [] };
const encodeTeamError = Schema.encodeEffect(MeerkatTeamError);
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const id of [projectId, otherProjectId])
    yield* sql`INSERT INTO projection_projects
    (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${id},${id},${`/workspace/${id}`},'[]','now','now')`;
});
const harness = Effect.fnUntraced(function* (workspaceReadiness = true) {
  const clones = new Map<ProjectId, ProjectCloneSnapshot>();
  const native = new Map<string, MeerkatNativeTeamSnapshot>();
  const creates: MeerkatDomainDefinition[] = [];
  const sends: unknown[] = [];
  const preparations: unknown[] = [];
  let preparation: Effect.Effect<void, ProviderDriverError> = Effect.void;
  const stops: unknown[] = [];
  const reads: string[] = [];
  const activities: unknown[] = [];
  const receipts = new Map<string, MeerkatNativeReceipt>();
  const receiptReads: Array<Parameters<NonNullable<MeerkatTeamReader["receipt"]>>[0]> = [];
  const wires: Array<{ params: Readonly<Record<string, unknown>>; connected: boolean }> = [];
  const revisions: Array<Record<string, unknown>> = [];
  let failRevision = false;
  const edges = new Map<string, { actual: boolean; suppressed: boolean; desired?: boolean }>();
  let revision = 1;
  let rejectWire = false;
  let wireCause: Error | undefined;
  let failSend = false;
  let failConnect = false;
  let busy = false;
  let busyUnavailable = false;
  let workCompletion: MeerkatAgentWork["latestCompletion"];
  let onWorkRead: (() => void) | undefined;
  let root = "/provider-state";
  let proposalAvailable = true;
  let catalogAvailable = true;
  let catalogReads = 0;
  let defaultCatalogReads = 0;
  let catalogPreparation: Effect.Effect<void, ProviderDriverError> = Effect.void;
  const workspaceCatalogReads: string[] = [];
  const workspaceCatalogs = new Map<string, ServerProvider>();
  const catalog: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("meerkat"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-04T00:00:00.000Z",
    models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
    skills: [],
    slashCommands: [],
    ...(workspaceReadiness ? { supportsWorkspaceReadiness: true } : {}),
  };
  let activityPage:
    | ((input: Parameters<MeerkatTeamReader["activity"]>[0]) => ConsoleTimelineWindowPage)
    | undefined;
  const frames: ConsoleFrame[] = [];
  const reader: MeerkatTeamReader = {
    work: () =>
      Effect.sync(() => {
        onWorkRead?.();
        return {
          status: busy ? ("running" as const) : ("idle" as const),
          ...(workCompletion ? { latestCompletion: workCompletion } : {}),
        };
      }),
    busy: () =>
      Effect.gen(function* () {
        if (busyUnavailable)
          return yield* new ProviderDriverError({
            driver: ProviderDriverKind.make("meerkat"),
            instanceId,
            detail: "Native run status unavailable",
          });
        return busy;
      }),
    proposalAvailable: () => Effect.sync(() => proposalAvailable),
    get stateRoot() {
      return root;
    },
    snapshot: (project, state) =>
      Effect.sync(() => {
        reads.push(state ?? project);
        return native.get(state ?? project) ?? cold;
      }),
    activity: (input) =>
      Effect.sync(() => {
        activities.push(input);
        return activityPage?.(input) ?? { frames, exhausted: true };
      }),
    connectDomain: (input) =>
      Effect.gen(function* () {
        if (failConnect)
          return yield* new ProviderDriverError({
            driver: ProviderDriverKind.make("meerkat"),
            instanceId,
            detail: "Cannot restore native domain",
          });
        creates.push(input);
        const record: ConsoleIdentityRecord = {
          identity: input.identity,
          display_name: input.label,
          runtime_key: "default",
          runtime_member_id: "runtime-member",
          session_id: "stable-session",
          visibility: "addressable",
          addressable: true,
          health: "ready",
          labels: {},
        };
        native.set(input.stateRoot, {
          observation: "loaded_runtimes",
          loaded: true,
          mobs: [
            {
              mobId: input.mobId,
              kind: "domain",
              label: input.label,
              accessMode: input.accessMode,
              consoleStatus: "ready",
              identities: [record],
            },
          ],
        });
        return { mob: { mobId: input.mobId } };
      }),
    disconnectDomain: (input) =>
      Effect.sync(() => {
        native.delete(input.stateRoot);
        return { destroyed: true };
      }),
    prepareSend: (input) =>
      Effect.gen(function* () {
        preparations.push(input);
        yield* preparation;
        return { dispatch: () => reader.send!(input) };
      }),
    send: (input) =>
      Effect.gen(function* () {
        sends.push(input);
        if (failSend)
          return yield* new ProviderDriverError({
            driver: ProviderDriverKind.make("meerkat"),
            instanceId,
            detail: "Transport timeout",
          });
        busy = true;
        return {
          receipt: {
            input_frame_id: "frame-accepted",
            interaction_id: `study-${sends.length}`,
            status: "accepted",
          },
        };
      }),
    receipt: (input) =>
      Effect.sync(() => {
        receiptReads.push(input);
        return receipts.get(input.requestId);
      }),
    stop: (input) =>
      Effect.sync(() => {
        stops.push(input);
        return { accepted: true };
      }),
    topology: (params) =>
      Effect.sync(() => ({
        snapshot: {
          authority_revisions: {
            [String(params.sourceMobId)]: revision,
            [String(params.targetMobId)]: revision,
          },
          edges: edges.has(String(params.targetMobId))
            ? [
                {
                  edge: {
                    a: {
                      authority: params.sourceMobId,
                      identity: params.sourceAgentIdentity ?? "ingress",
                    },
                    b: { authority: params.targetMobId, identity: params.targetAgentIdentity },
                  },
                  ...edges.get(String(params.targetMobId)),
                },
              ]
            : [],
        },
      })),
    wire: (params, connected) =>
      Effect.gen(function* () {
        wires.push({ params, connected });
        if (rejectWire)
          return yield* new ProviderDriverError({
            driver: ProviderDriverKind.make("meerkat"),
            instanceId,
            detail: "Native policy rejected connection",
            ...(wireCause ? { cause: wireCause } : {}),
          });
        edges.set(String(params.targetMobId), { actual: connected, suppressed: !connected });
        revision++;
        return { receipt: "applied" };
      }),
  };
  const provider: ProviderInstance = {
    instanceId,
    driverKind: ProviderDriverKind.make("meerkat"),
    enabled: true,
    displayName: "Meerkat",
    continuationIdentity: {
      driverKind: ProviderDriverKind.make("meerkat"),
      continuationKey: "meerkat",
    },
    meerkatTeam: reader,
    meerkatControls: {
      request: async (method, params) => {
        if (method !== "mobs.v1.domainRevise") throw new Error(`Unexpected method ${method}`);
        if (busy || failRevision)
          throw new Error("Native responsibility revision is unavailable at this boundary.");
        revisions.push(params);
        return { applied: true, revisionId: params.revisionId };
      },
    },
    get adapter(): never {
      throw new Error("Agent controls cannot run a thread adapter.");
    },
    get textGeneration(): never {
      throw new Error("No generation from project-agent creation.");
    },
    ...(workspaceReadiness
      ? {
          snapshotForCwd: (cwd: string) =>
            Effect.gen(function* () {
              catalogReads++;
              workspaceCatalogReads.push(cwd);
              yield* catalogPreparation;
              if (!catalogAvailable)
                return yield* new ProviderDriverError({
                  driver: ProviderDriverKind.make("meerkat"),
                  instanceId,
                  detail: "The workspace catalog is unavailable.",
                });
              return workspaceCatalogs.get(cwd) ?? catalog;
            }),
        }
      : {}),
    snapshot: {
      getSnapshot: Effect.sync(() => {
        catalogReads++;
        defaultCatalogReads++;
        if (!catalogAvailable) throw new Error("The provider catalog is unavailable.");
        return catalog;
      }),
    } as ProviderInstance["snapshot"],
  };
  const layer = Layer.mock(ProviderInstanceRegistry)({
    listInstances: Effect.succeed([provider]),
    listUnavailable: Effect.succeed([]),
  });
  const make = makeMeerkatTeamService.pipe(
    Effect.provide(
      Layer.mergeAll(
        layer,
        Layer.mock(ProjectCloneTracker)({
          get: (id) => Effect.sync(() => clones.get(id) ?? null),
        }),
      ),
    ),
  );
  return {
    service: yield* make,
    reopen: make,
    clones,
    native,
    creates,
    sends,
    preparations,
    setPreparation: (effect: typeof preparation) => {
      preparation = effect;
    },
    stops,
    reads,
    activities,
    receipts,
    receiptReads,
    catalog,
    workspaceCatalogs,
    workspaceCatalogReads,
    get defaultCatalogReads() {
      return defaultCatalogReads;
    },
    setCatalogPreparation: (value: typeof catalogPreparation) => {
      catalogPreparation = value;
    },
    get catalogReads() {
      return catalogReads;
    },
    setCatalogAvailable: (value: boolean) => {
      catalogAvailable = value;
    },
    frames,
    revisions,
    setFailRevision: (value: boolean) => {
      failRevision = value;
    },
    setActivityPage: (value: typeof activityPage) => {
      activityPage = value;
    },
    setBusy: (value: boolean) => {
      busy = value;
    },
    setWorkCompletion: (value: typeof workCompletion) => {
      workCompletion = value;
    },
    setWorkRead: (value: typeof onWorkRead) => {
      onWorkRead = value;
    },
    setBusyUnavailable: (value: boolean) => {
      busyUnavailable = value;
    },
    setProposalAvailable: (value: boolean) => {
      proposalAvailable = value;
    },
    wires,
    edges,
    setRejectWire: (value: boolean, cause?: Error) => {
      rejectWire = value;
      wireCause = cause;
    },
    setFailConnect: (value: boolean) => {
      failConnect = value;
    },
    setFailSend: (value: boolean) => {
      failSend = value;
    },
    setRoot: (value: string) => {
      root = value;
    },
  };
});
const createInput = {
  projectId,
  instanceId,
  requestId: "create-architect",
  label: "Architect",
  role: "architect",
  instructions: "Study the architecture and advise on design.",
  model,
};
const testLayer = Layer.mergeAll(SqlitePersistenceMemory, Path.layer);
const seedThread = Effect.fnUntraced(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_threads
    (thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at)
    VALUES (${threadId},${projectId},'Thread','{"instanceId":"meerkat-agents","model":"anthropic:claude-haiku-4-5"}','full-access','default','now','now')`;
});

describe("Meerkat persistent project agents", () => {
  it.effect("applies saved reasoning at creation and reconnect without a synthetic turn", () =>
    Effect.gen(function* () {
      yield* seed;
      const h = yield* harness();
      const options = [{ id: "effort", value: "high" }];
      h.workspaceCatalogs.set(`/workspace/${projectId}`, {
        ...h.catalog,
        models: [
          {
            slug: model,
            name: model,
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                {
                  id: "effort",
                  label: "Reasoning level",
                  type: "select",
                  options: [
                    { id: "high", label: "High" },
                    { id: "low", label: "Low" },
                  ],
                },
              ],
            },
          },
        ],
      });
      const input = { ...createInput, options };
      const agent = yield* h.service.projectAgentCreate(input);
      expect(agent.options).toEqual(options);
      expect(h.creates[0]).toMatchObject({ model, options });
      expect(h.sends).toEqual([]);
      h.setCatalogAvailable(false);
      expect((yield* h.service.projectAgentCreate(input)).agentId).toBe(agent.agentId);
      expect(h.catalogReads).toBe(1);
      expect(h.creates).toHaveLength(1);
      const changed = yield* Effect.flip(
        h.service.projectAgentCreate({
          ...input,
          options: [{ id: "effort", value: "low" }],
        }),
      );
      expect(changed.message).toContain("different agent settings");
      const reopened = yield* h.reopen;
      expect((yield* reopened.projectAgents({ projectId })).agents[0]?.options).toEqual(options);
      yield* reopened.projectAgentLifecycle({
        projectId,
        agentId: agent.agentId,
        action: "disconnect",
      });
      const restored = yield* reopened.projectAgentLifecycle({
        projectId,
        agentId: agent.agentId,
        action: "connect",
      });
      expect(restored.options).toEqual(options);
      expect(restored.agentRef).toBe(agent.agentRef);
      expect(h.creates[1]).toEqual(h.creates[0]);
      expect(h.sends).toEqual([]);
      expect(h.catalogReads).toBe(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("canonicalizes creation option order and preserves legacy request fingerprints", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* makeMeerkatProjectAgentStore;
      const input = {
        ...createInput,
        options: [
          { id: "prompt_cache_enabled", value: false },
          { id: "effort", value: "high" },
        ],
      };
      const created = yield* store.create(input, "/provider-state");
      const retry = yield* store.create(
        { ...input, options: input.options.toReversed() },
        "/provider-state",
      );
      expect(retry.created).toBe(false);
      expect(retry.row.options_json).toBe(
        '[{"id":"effort","value":"high"},{"id":"prompt_cache_enabled","value":false}]',
      );
      expect(retry.row.request_fingerprint).toBe(created.row.request_fingerprint);
      expect(
        (yield* Effect.flip(store.create({ ...input, options: [] }, "/provider-state"))).message,
      ).toContain("different agent settings");
      expect(
        (yield* Effect.flip(store.create({ ...createInput }, "/provider-state"))).message,
      ).toContain("different agent settings");

      const legacy = yield* store.create(
        { ...createInput, requestId: "legacy" },
        "/provider-state",
      );
      expect(legacy.row.options_json).toBeNull();
      expect(legacy.row.request_fingerprint).toBe(
        agentFingerprint([
          createInput.label,
          createInput.role,
          createInput.instructions,
          model,
          "read-only",
        ]),
      );
      expect(
        (yield* store.create({ ...createInput, requestId: "legacy" }, "/provider-state")).created,
      ).toBe(false);
      const explicitDefault = yield* store.create(
        { ...createInput, requestId: "default", options: [] },
        "/provider-state",
      );
      expect(explicitDefault.row.options_json).toBe("[]");
      expect(explicitDefault.row.request_fingerprint).not.toBe(legacy.row.request_fingerprint);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "rejects invalid or ambiguous creation options before storing or starting an agent",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const store = yield* makeMeerkatProjectAgentStore;
        h.workspaceCatalogs.set(`/workspace/${projectId}`, {
          ...h.catalog,
          models: [
            {
              slug: model,
              name: model,
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "effort",
                    label: "Reasoning level",
                    type: "select",
                    options: [{ id: "high", label: "High" }],
                  },
                ],
              },
            },
          ],
        });
        for (const options of [
          [{ id: "effort", value: "unsupported" }],
          [{ id: "reasoning_effort", value: "high" }],
          [{ id: "effort", value: true }],
          [
            { id: "effort", value: "high" },
            { id: "effort", value: "high" },
          ],
        ]) {
          const result = yield* Effect.result(
            h.service.projectAgentCreate({ ...createInput, options }),
          );
          expect(result._tag).toBe("Failure");
          expect(yield* store.list(projectId)).toEqual([]);
          expect(h.creates).toEqual([]);
        }
        const fixed = yield* h.service.projectAgentCreate({
          ...createInput,
          options: [{ id: "effort", value: "high" }],
        });
        expect(fixed.connectionStatus).toBe("connected");
        expect(h.creates).toHaveLength(1);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "uses project B's catalog for creation and explicit sends without reading the default catalog",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const projectPath = `/workspace/${otherProjectId}`;
        const selected = "openai:project-b-model";
        h.workspaceCatalogs.set(projectPath, {
          ...h.catalog,
          models: [{ slug: selected, name: "B model", isCustom: true, capabilities: null }],
        });
        const creation = { ...createInput, projectId: otherProjectId, model: selected };
        const agent = yield* h.service.projectAgentCreate(creation);
        const input = {
          projectId: otherProjectId,
          instanceId,
          agentRef: agent.agentRef!,
          requestId: "project-b-send",
          handlingMode: "queue" as const,
          text: "Review B",
          modelSelection: { instanceId, model: selected },
        };
        const receipt = yield* h.service.agentSend(input);
        expect(receipt.status).toBe("accepted");
        expect(h.creates[0]?.projectPath).toBe(projectPath);
        expect(h.sends[0]).toMatchObject({ projectPath, modelSelection: input.modelSelection });
        expect(h.workspaceCatalogReads).toEqual([projectPath, projectPath]);
        expect(h.workspaceCatalogReads).not.toContain(h.creates[0]!.stateRoot);
        expect(h.defaultCatalogReads).toBe(0);
        h.setCatalogAvailable(false);
        expect((yield* h.service.projectAgentCreate(creation)).agentId).toBe(agent.agentId);
        expect(yield* h.service.agentSend(input)).toEqual(receipt);
        expect(h.workspaceCatalogReads).toHaveLength(2);
        expect(h.creates).toHaveLength(1);
        expect(h.sends).toHaveLength(1);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "rejects a default-only model before creating an agent or claiming a new delivery",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const store = yield* makeMeerkatProjectAgentStore;
        const projectPath = `/workspace/${projectId}`;
        h.workspaceCatalogs.set(projectPath, { ...h.catalog, models: [] });
        expect((yield* Effect.flip(h.service.projectAgentCreate(createInput))).message).toContain(
          "this workspace's current Meerkat catalog",
        );
        expect(yield* store.list(projectId)).toHaveLength(0);
        expect(h.creates).toHaveLength(0);
        h.workspaceCatalogs.delete(projectPath);
        const agent = yield* h.service.projectAgentCreate(createInput);
        h.workspaceCatalogs.set(projectPath, { ...h.catalog, models: [] });
        const input = {
          projectId,
          instanceId,
          agentRef: agent.agentRef!,
          requestId: "no-workspace-model",
          text: "Review",
          handlingMode: "queue" as const,
          modelSelection: { instanceId, model },
        };
        expect((yield* Effect.flip(h.service.agentSend(input))).message).toContain(
          "this workspace's current Meerkat catalog",
        );
        expect(yield* store.delivery(projectId, instanceId, input.requestId)).toBeUndefined();
        expect(h.preparations).toHaveLength(0);
        expect(h.sends).toHaveLength(0);
        h.workspaceCatalogs.delete(projectPath);
        expect((yield* h.service.agentSend(input)).status).toBe("accepted");
        expect(h.sends).toHaveLength(1);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("uses an owning thread's worktree catalog for worker model overrides", () =>
    Effect.gen(function* () {
      yield* seed;
      const h = yield* harness();
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("worktree-owner");
      const worktree = "/worktrees/independent-account";
      const selected = "openai:worktree-model";
      yield* seedThread(threadId);
      yield* sql`UPDATE projection_threads SET worktree_path = ${worktree} WHERE thread_id = ${threadId}`;
      yield* sql`INSERT INTO provider_session_runtime
        (thread_id,provider_name,provider_instance_id,adapter_key,status,last_seen_at)
        VALUES (${threadId},'meerkat',${instanceId},'meerkat','ready','now')`;
      h.native.set(worktree, {
        observation: "loaded_runtimes",
        loaded: true,
        mobs: [
          {
            mobId: `t3-${NodeCrypto.createHash("sha256").update(`${instanceId}:${threadId}`).digest("hex")}`,
            kind: "thread",
            label: "Worktree",
            consoleStatus: "ready",
            identities: [
              {
                identity: "reviewer",
                display_name: "Reviewer",
                runtime_key: "default",
                runtime_member_id: "worker",
                session_id: "worktree-session",
                visibility: "addressable",
                addressable: true,
                health: "ready",
                labels: { source_mob_id: "worker-crew" },
              },
            ],
          },
        ],
      });
      h.workspaceCatalogs.set(worktree, {
        ...h.catalog,
        models: [{ slug: selected, name: selected, isCustom: true, capabilities: null }],
      });
      const team = yield* h.service.projectTeam({ projectId });
      const agent = team.providers[0]!.agents.find((agent) => agent.threadId === threadId)!;
      const input = {
        projectId,
        instanceId,
        agentRef: agent.agentRef,
        requestId: "worktree-model",
        text: "Review",
        handlingMode: "queue" as const,
        modelSelection: { instanceId, model: selected },
      };
      expect((yield* h.service.agentSend(input)).status).toBe("accepted");
      expect(h.sends[0]).toMatchObject({
        projectPath: worktree,
        modelSelection: input.modelSelection,
      });
      expect(h.workspaceCatalogReads).toEqual([worktree]);
      expect(
        (yield* Effect.flip(
          h.service.agentSend({
            ...input,
            requestId: "root-only-model",
            modelSelection: { instanceId, model },
          }),
        )).message,
      ).toContain("this workspace's current Meerkat catalog");
      expect(h.sends).toHaveLength(1);
      expect(h.defaultCatalogReads).toBe(0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "keeps legacy provider catalog validation when scoped readiness is not advertised",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness(false);
        expect((yield* h.service.projectAgentCreate(createInput)).connectionStatus).toBe(
          "connected",
        );
        expect(h.defaultCatalogReads).toBe(1);
        expect(h.workspaceCatalogReads).toEqual([]);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "rejects missing scoped credentials before new creation or send admission, while preserving current-session controls",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const store = yield* makeMeerkatProjectAgentStore;
        const agent = yield* h.service.projectAgentCreate(createInput);
        const projectPath = `/workspace/${projectId}`;
        for (const credentialState of ["needs_auth", "reauth_required"] as const) {
          h.workspaceCatalogs.set(projectPath, {
            ...h.catalog,
            models: [{ ...h.catalog.models[0]!, credentialState }],
          });
          expect(
            (yield* Effect.flip(
              h.service.projectAgentCreate({
                ...createInput,
                requestId: `create-${credentialState}`,
              }),
            )).message,
          ).toContain("Connect this model's account for this workspace");
          const input = {
            projectId,
            instanceId,
            agentRef: agent.agentRef!,
            requestId: credentialState,
            text: "Review",
            handlingMode: "queue" as const,
            modelSelection: { instanceId, model },
          };
          expect((yield* Effect.flip(h.service.agentSend(input))).message).toContain(
            "Connect this model's account for this workspace",
          );
          expect(yield* store.delivery(projectId, instanceId, input.requestId)).toBeUndefined();
        }
        expect(yield* store.list(projectId)).toHaveLength(1);
        expect(h.sends).toHaveLength(0);
        h.workspaceCatalogs.set(projectPath, { ...h.catalog, status: "error" });
        const refused = {
          projectId,
          instanceId,
          agentRef: agent.agentRef!,
          requestId: "scoped-check-failed",
          text: "Review",
          handlingMode: "queue" as const,
          modelSelection: { instanceId, model },
        };
        expect((yield* Effect.flip(h.service.agentSend(refused))).message).toContain(
          "Could not check this workspace",
        );
        expect(yield* store.delivery(projectId, instanceId, refused.requestId)).toBeUndefined();
        h.setCatalogAvailable(false);
        const reads = h.workspaceCatalogReads.length;
        expect(
          (yield* h.service.agentSend({
            projectId,
            instanceId,
            agentRef: agent.agentRef!,
            requestId: "current-session-steer",
            text: "Keep the current direction",
            handlingMode: "steer",
          })).status,
        ).toBe("accepted");
        expect(
          (yield* h.service.agentStop({
            projectId,
            instanceId,
            agentRef: agent.agentRef!,
            nativeRunId: "current-run",
          })).status,
        ).toBe("accepted");
        expect(h.workspaceCatalogReads).toHaveLength(reads);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps scoped account validation per model when another account is unavailable", () =>
    Effect.gen(function* () {
      yield* seed;
      const h = yield* harness();
      const projectPath = `/workspace/${projectId}`;
      h.workspaceCatalogs.set(projectPath, { ...h.catalog, auth: { status: "unauthenticated" } });
      expect((yield* Effect.flip(h.service.projectAgentCreate(createInput))).message).toContain(
        "Connect this model's account for this workspace",
      );
      h.workspaceCatalogs.set(projectPath, {
        ...h.catalog,
        auth: { status: "unauthenticated" },
        models: [{ ...h.catalog.models[0]!, credentialState: "host_managed" }],
      });
      expect((yield* h.service.projectAgentCreate(createInput)).connectionStatus).toBe("connected");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "allows Stop during a new creation's workspace check and rejects a changed project before storing it",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const sql = yield* SqlClient.SqlClient;
        const store = yield* makeMeerkatProjectAgentStore;
        const agent = yield* h.service.projectAgentCreate(createInput);
        const started = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        h.setCatalogPreparation(
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(released))),
        );
        const creation = yield* h.service
          .projectAgentCreate({
            ...createInput,
            projectId: otherProjectId,
            requestId: "pending-scoped-create",
          })
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(started);
        expect(
          (yield* h.service.agentStop({
            projectId,
            instanceId,
            agentRef: agent.agentRef!,
            nativeRunId: "exact-run",
          })).status,
        ).toBe("accepted");
        yield* sql`UPDATE projection_projects SET workspace_root = '/workspace/replaced' WHERE project_id = ${otherProjectId}`;
        yield* Deferred.succeed(released, undefined);
        const result = yield* Fiber.join(creation);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure.message).toContain("project or provider changed");
        expect(yield* store.list(otherProjectId)).toHaveLength(0);
        expect(h.creates).toHaveLength(1);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("persists explicit specialist access and preserves it across reconnects", () =>
    Effect.gen(function* () {
      yield* seed;
      const h = yield* harness();
      const inspect = yield* h.service.projectAgentCreate(createInput);
      const full = yield* h.service.projectAgentCreate({
        ...createInput,
        requestId: "full-access-specialist",
        accessMode: "full-access",
      });
      const collaborate = yield* h.service.projectAgentCreate({
        ...createInput,
        requestId: "collaborating-specialist",
        accessMode: "read-and-collaborate",
      });
      expect(inspect.accessMode).toBe("read-only");
      expect(full.accessMode).toBe("full-access");
      expect(collaborate.accessMode).toBe("read-and-collaborate");
      expect(h.creates.map((item) => item.accessMode)).toEqual([
        "read-only",
        "full-access",
        "read-and-collaborate",
      ]);
      const legacyRetry = yield* h.service.projectAgentCreate({
        ...createInput,
        requestId: "full-access-specialist",
      });
      expect(legacyRetry.agentId).toBe(full.agentId);
      expect(legacyRetry.accessMode).toBe("full-access");
      const changed = yield* Effect.flip(
        h.service.projectAgentCreate({
          ...createInput,
          accessMode: "full-access",
        }),
      );
      expect(changed.message).toContain("different agent settings");
      expect(h.creates).toHaveLength(3);
      const reopened = yield* h.reopen;
      for (const agent of [inspect, full, collaborate]) {
        yield* reopened.projectAgentLifecycle({
          projectId,
          agentId: agent.agentId,
          action: "disconnect",
        });
        const restored = yield* reopened.projectAgentLifecycle({
          projectId,
          agentId: agent.agentId,
          action: "connect",
        });
        expect(restored.accessMode).toBe(agent.accessMode);
        expect(restored.agentRef).toBe(agent.agentRef);
      }
      const stored = yield* reopened.projectAgents({ projectId });
      expect(stored.agents.map((item) => [item.agentId, item.accessMode])).toEqual(
        expect.arrayContaining([
          [inspect.agentId, "read-only"],
          [full.agentId, "full-access"],
          [collaborate.agentId, "read-and-collaborate"],
        ]),
      );
      expect(h.creates.slice(3).map((item) => item.accessMode)).toEqual([
        "read-only",
        "full-access",
        "read-and-collaborate",
      ]);
    }).pipe(Effect.provide(testLayer)),
  );
  it.effect(
    "retains native connection diagnostics in server traces without changing wire errors",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        yield* h.service.projectAgentCreate(createInput);
        const threadId = ThreadId.make("failed-native-connection");
        yield* seedThread(threadId);
        const sourceMobId = `t3-${NodeCrypto.createHash("sha256").update(`${instanceId}:${threadId}`).digest("hex")}`;
        h.native.set(`/workspace/${projectId}`, {
          observation: "loaded_runtimes",
          loaded: true,
          mobs: [
            {
              mobId: sourceMobId,
              label: "Thread",
              kind: "thread",
              consoleStatus: "ready",
              identities: [],
            },
          ],
        });
        h.setRejectWire(
          true,
          new MeerkatGatewayRpcError({
            message: "MobKit topology mutation was rejected",
            rpcCode: -32003,
            typedCode: "policyDenied",
            details: { error: "topology actuator failed: missing member comms runtime" },
          }),
        );
        const error = yield* Effect.flip(
          h.service.applyThreadConnections({ projectId, threadId, instanceId }, true),
        );
        expect(Cause.pretty(Cause.fail(error))).toContain("missing member comms runtime");
        expect(yield* encodeTeamError(error)).toEqual({
          _tag: "MeerkatTeamError",
          projectId,
          operation: "agent-connections",
          message:
            "Provider driver 'meerkat' failed to create instance 'meerkat-agents': Native policy rejected connection",
        });
      }).pipe(Effect.provide(testLayer)),
  );
  it.effect(
    "connects thread peers and keeps same-project agent edges in the existing selection authority",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const agent = yield* h.service.projectAgentCreate(createInput);
        const firstId = ThreadId.make("peer-first");
        const secondId = ThreadId.make("peer-second");
        yield* seedThread(firstId);
        yield* seedThread(secondId);
        const source: MeerkatPeerEndpoint = {
          kind: "thread",
          projectId,
          instanceId,
          threadId: firstId,
        };
        const target: MeerkatPeerEndpoint = {
          kind: "thread",
          projectId,
          instanceId,
          threadId: secondId,
        };
        const stateRoot = h.creates[0]!.stateRoot;
        const record = h.native.get(stateRoot)!.mobs[0]!.identities[0]!;
        const mobs = [firstId, secondId].map((id) => ({
          mobId: `t3-${NodeCrypto.createHash("sha256").update(`${instanceId}:${id}`).digest("hex")}`,
          kind: "thread",
          label: id,
          consoleStatus: "ready" as const,
          identities: [{ ...record, identity: "ingress", session_id: id }],
        }));
        const path = yield* Path.Path;
        const canonicalState = meerkatProjectStateRoot(
          path,
          "/provider-state",
          `/workspace/${projectId}`,
        );
        h.native.set(canonicalState, { observation: "loaded_runtimes", loaded: true, mobs });
        h.native.set(`/workspace/${projectId}`, {
          observation: "loaded_runtimes",
          loaded: true,
          mobs,
        });
        const connected = yield* h.service.peerConnectionSet({
          source,
          target,
          connected: true,
          requestId: "threads",
        });
        expect(
          connected.connections.some(
            (edge) =>
              edge.source.kind === "thread" &&
              edge.target.kind === "thread" &&
              edge.status === "connected",
          ),
        ).toBe(true);
        const domain: MeerkatPeerEndpoint = {
          kind: "project-agent",
          projectId,
          instanceId,
          agentId: agent.agentId,
        };
        yield* h.service.peerConnectionSet({
          source,
          target: domain,
          connected: false,
          requestId: "solo",
        });
        expect((yield* h.service.threadConnections(source)).desiredAgentIds).toEqual([]);
        yield* h.service.peerConnectionSet({
          source: domain,
          target: source,
          connected: true,
          requestId: "include",
        });
        expect((yield* h.service.threadConnections(source)).desiredAgentIds).toEqual([
          agent.agentId,
        ]);
        const sql = yield* SqlClient.SqlClient;
        expect((yield* sql`SELECT * FROM meerkat_peer_connections`).length).toBe(1);
        yield* sql`UPDATE projection_threads SET deleted_at = 'deleted' WHERE thread_id = ${secondId}`;
        yield* h.service.applyThreadConnections(source);
        const afterDeletion = yield* h.service.peerConnections({ endpoint: source });
        expect(
          afterDeletion.connections.find(
            (connection) => connection.edgeId === connected.connections[0]?.edgeId,
          ),
        ).toMatchObject({ desired: false, status: "disconnected", error: null });
        expect(h.sends).toHaveLength(0);
      }).pipe(Effect.provide(testLayer)),
  );
  it.effect(
    "persists symmetric domain peers and restores only desired native edges on explicit reconnect",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const a = yield* h.service.projectAgentCreate(createInput);
        const b = yield* h.service.projectAgentCreate({
          ...createInput,
          requestId: "b",
          role: "reviewer",
        });
        const source: MeerkatPeerEndpoint = {
          kind: "project-agent",
          projectId,
          instanceId,
          agentId: a.agentId,
        };
        const target: MeerkatPeerEndpoint = {
          kind: "project-agent",
          projectId,
          instanceId,
          agentId: b.agentId,
        };
        const input = { source, target, connected: true, requestId: "peer-ab" };
        h.native.clear();
        expect((yield* h.service.peerConnections({ endpoint: source })).connections).toEqual([]);
        expect(h.creates).toHaveLength(2);
        const connected = yield* h.service.peerConnectionSet(input);
        expect(h.creates).toHaveLength(4);
        expect(connected.connections).toHaveLength(1);
        expect(connected.connections[0]).toMatchObject({
          desired: true,
          status: "connected",
          error: null,
        });
        expect(h.wires).toHaveLength(1);
        expect(h.wires[0]?.params).toMatchObject({
          sourceAgentIdentity: expect.any(String),
          targetAgentIdentity: expect.any(String),
          expectedRevisions: expect.any(Object),
          action: "connect",
        });
        const reopened = yield* h.reopen;
        const reverse = yield* reopened.peerConnections({ endpoint: target });
        expect(reverse.connections[0]?.edgeId).toBe(connected.connections[0]?.edgeId);
        yield* reopened.peerConnectionSet({ ...input, source: target, target: source });
        expect(h.wires).toHaveLength(1);
        h.edges.clear();
        expect((yield* reopened.peerConnections({ endpoint: source })).connections[0]?.status).toBe(
          "disconnected",
        );
        expect(h.wires).toHaveLength(1);
        yield* reopened.projectAgentLifecycle({ projectId, agentId: a.agentId, action: "connect" });
        expect(h.wires).toHaveLength(2);
        const disconnected = yield* reopened.peerConnectionSet({
          ...input,
          source: target,
          target: source,
          connected: false,
          requestId: "disconnect",
        });
        expect(disconnected.connections[0]).toMatchObject({
          desired: false,
          status: "disconnected",
        });
        yield* reopened.projectAgentLifecycle({ projectId, agentId: b.agentId, action: "connect" });
        expect(h.wires).toHaveLength(3);
        for (const [key] of h.edges)
          h.edges.set(key, { actual: false, desired: true, suppressed: false });
        yield* reopened.peerConnectionSet({
          ...input,
          connected: false,
          requestId: "remove-native-demand",
        });
        expect(h.wires).toHaveLength(4);
        expect(h.wires[3]?.connected).toBe(false);
        h.native.clear();
        h.setFailConnect(true);
        const failedRestore = yield* reopened.peerConnectionSet({ ...input, requestId: "restore" });
        expect(failedRestore.connections[0]).toMatchObject({
          desired: true,
          status: "error",
          error: "Cannot restore native domain",
        });
        expect(
          (yield* reopened.peerConnections({ endpoint: source })).connections[0],
        ).toMatchObject({
          desired: true,
          status: "error",
          error: "Cannot restore native domain",
        });
        h.setFailConnect(false);
        const retryRestore = yield* reopened.peerConnectionSet({
          ...input,
          requestId: "restore-retry",
        });
        expect(retryRestore.connections[0]).toMatchObject({ desired: true, status: "connected" });
        expect(h.sends).toHaveLength(0);
        expect(
          (yield* Effect.flip(reopened.peerConnectionSet({ ...input, target: source }))).message,
        ).toContain("two different");
        expect(
          (yield* Effect.flip(
            reopened.peerConnectionSet({
              ...input,
              target: { ...target, instanceId: ProviderInstanceId.make("other") },
            }),
          )).message,
        ).toContain("same Meerkat provider");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "supports cross-project peers, reports native failures, and stages unloaded threads without model work",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const a = yield* h.service.projectAgentCreate(createInput);
        const b = yield* h.service.projectAgentCreate({
          ...createInput,
          projectId: otherProjectId,
          requestId: "cross",
          role: "reviewer",
        });
        const source: MeerkatPeerEndpoint = {
          kind: "project-agent",
          projectId,
          instanceId,
          agentId: a.agentId,
        };
        const target: MeerkatPeerEndpoint = {
          kind: "project-agent",
          projectId: otherProjectId,
          instanceId,
          agentId: b.agentId,
        };
        h.setRejectWire(true);
        const failed = yield* h.service.peerConnectionSet({
          source,
          target,
          connected: true,
          requestId: "cross-peer",
        });
        expect(failed.connections[0]?.desired).toBe(true);
        expect(failed.connections[0]?.status).toBe("error");
        expect(failed.connections[0]?.error).toContain("Native policy rejected");
        expect(
          (yield* h.service.peerConnections({ endpoint: source })).connections[0]?.status,
        ).toBe("error");
        h.setRejectWire(false);
        const applied = yield* h.service.peerConnectionSet({
          source: target,
          target: source,
          connected: true,
          requestId: "retry-cross",
        });
        expect(applied.connections[0]?.status).toBe("connected");
        const threadId = ThreadId.make("unloaded-peer");
        yield* seedThread(threadId);
        const thread: MeerkatPeerEndpoint = { kind: "thread", projectId, instanceId, threadId };
        const staged = yield* h.service.peerConnectionSet({
          source: thread,
          target,
          connected: true,
          requestId: "thread-cross",
        });
        expect(staged.connections.some((edge) => edge.desired && edge.status === "unloaded")).toBe(
          true,
        );
        expect(h.sends).toHaveLength(0);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_projects SET deleted_at = 'deleted' WHERE project_id = ${otherProjectId}`;
        yield* h.service.projectAgentLifecycle({
          projectId,
          agentId: a.agentId,
          action: "connect",
        });
        const afterDelete = yield* h.service.peerConnections({ endpoint: source });
        expect(afterDelete.connections[0]).toMatchObject({
          desired: false,
          status: "disconnected",
        });
        yield* h.service.peerConnectionSet({
          source,
          target,
          connected: false,
          requestId: "remove-deleted",
        });
        const current = (yield* h.service.projectTeam({ projectId })).projectAgents.find(
          (item) => item.agentId === a.agentId,
        )!;
        expect(
          (yield* h.service.agentSend({
            projectId,
            instanceId,
            agentRef: current.agentRef!,
            requestId: "survivor-message",
            text: "Continue",
            handlingMode: "queue",
          })).status,
        ).toBe("accepted");
        expect(
          (yield* Effect.flip(
            h.service.peerConnectionSet({
              source,
              target: { ...target, projectId },
              connected: true,
              requestId: "foreign",
            }),
          )).message,
        ).toContain("not found");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("blocks persisted cross-project peer restoration until the target clone is ready", () =>
    Effect.gen(function* () {
      yield* seed;
      const h = yield* harness();
      const agent = yield* h.service.projectAgentCreate({
        ...createInput,
        projectId: otherProjectId,
      });
      const threadId = ThreadId.make("clone-peer-source");
      yield* seedThread(threadId);
      const source: MeerkatPeerEndpoint = { kind: "thread", projectId, instanceId, threadId };
      const target: MeerkatPeerEndpoint = {
        kind: "project-agent",
        projectId: otherProjectId,
        instanceId,
        agentId: agent.agentId,
      };
      yield* h.service.peerConnectionSet({ source, target, connected: true, requestId: "saved" });
      const definition = h.creates[0]!;
      const record = h.native.get(definition.stateRoot)!.mobs[0]!.identities[0]!;
      const nativeThread: MeerkatNativeTeamSnapshot = {
        observation: "loaded_runtimes",
        loaded: true,
        mobs: [
          {
            mobId: `t3-${NodeCrypto.createHash("sha256").update(`${instanceId}:${threadId}`).digest("hex")}`,
            kind: "thread",
            label: "Source",
            consoleStatus: "ready",
            identities: [{ ...record, identity: "ingress", session_id: threadId }],
          },
        ],
      };
      const path = yield* Path.Path;
      h.native.set(`/workspace/${projectId}`, nativeThread);
      h.native.set(
        meerkatProjectStateRoot(path, "/provider-state", `/workspace/${projectId}`),
        nativeThread,
      );
      h.native.delete(definition.stateRoot);
      const failedClone: ProjectCloneSnapshot = {
        projectId: otherProjectId,
        remoteUrl: "/fixture/source.git",
        destinationPath: `/workspace/${otherProjectId}`,
        repository: null,
        phase: "failed",
        stage: "connecting",
        percent: null,
        detail: null,
        error: "Clone interrupted by restart",
        startedAt: "2026-10-04T00:00:00.000Z",
        endedAt: null,
        sequence: 0,
      };
      h.clones.set(otherProjectId, failedClone);
      const reopened = yield* h.reopen;
      const error = yield* reopened.applyThreadConnections(source, true).pipe(Effect.flip);
      expect(error.message).toContain("The repository was not cloned");
      expect(h.creates).toHaveLength(1);
      expect(h.wires).toHaveLength(0);
      expect((yield* reopened.peerConnections({ endpoint: source })).connections[0]).toMatchObject({
        desired: true,
        status: "error",
        error: expect.stringContaining("The repository was not cloned"),
      });

      h.clones.delete(otherProjectId);
      yield* reopened.applyThreadConnections(source, true);
      expect(h.creates).toHaveLength(2);
      expect(h.wires).toHaveLength(1);
      h.clones.set(otherProjectId, failedClone);
      yield* reopened.peerConnectionSet({
        source,
        target,
        connected: false,
        requestId: "disconnect-unfinished",
      });
      expect(h.creates).toHaveLength(2);
      expect(h.wires.at(-1)?.connected).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "persists independent project agents, joins duplicate creation, and reconnects only explicitly after restart",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const agent = yield* h.service.projectAgentCreate(createInput);
        expect(agent.connectionStatus).toBe("connected");
        expect(agent.agentRef).toBeTruthy();
        expect(h.creates).toHaveLength(1);
        expect(h.creates[0]?.stateRoot).toContain("/provider-state/project-agents/");
        expect(h.sends).toHaveLength(0);
        expect((yield* h.service.projectAgentCreate(createInput)).agentId).toBe(agent.agentId);
        expect(h.creates).toHaveLength(1);
        expect(
          (yield* Effect.flip(
            h.service.projectAgentCreate({ ...createInput, instructions: "Changed instructions" }),
          )).message,
        ).toContain("different agent settings");
        h.native.clear();
        const reopened = yield* h.reopen;
        const disconnected = yield* reopened.projectTeam({ projectId });
        expect(disconnected.projectAgents[0]?.connectionStatus).toBe("unloaded");
        expect(h.creates).toHaveLength(1);
        const restored = yield* reopened.projectAgentLifecycle({
          projectId,
          agentId: agent.agentId,
          action: "connect",
        });
        expect(restored.connectionStatus).toBe("connected");
        expect(h.creates[1]?.mobId).toBe(h.creates[0]?.mobId);
        expect(h.creates[1]?.stateRoot).toBe(h.creates[0]?.stateRoot);
        expect(
          (yield* reopened.projectTeam({ projectId: otherProjectId })).projectAgents,
        ).toHaveLength(0);
        expect(
          (yield* Effect.flip(
            reopened.projectAgentUpdate({
              projectId: otherProjectId,
              agentId: agent.agentId,
              label: "Intruder",
            }),
          )).message,
        ).toContain("not found");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "archive/unarchive and disconnect preserve definitions and deny old control references",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const agent = yield* h.service.projectAgentCreate(createInput);
        const archived = yield* h.service.projectAgentLifecycle({
          projectId,
          agentId: agent.agentId,
          action: "archive",
        });
        expect(archived.archived).toBe(true);
        expect(archived.enabled).toBe(false);
        expect(
          (yield* Effect.flip(
            h.service.agentSend({
              projectId,
              instanceId,
              agentRef: agent.agentRef!,
              requestId: "archived",
              text: "No",
              handlingMode: "queue",
            }),
          )).message,
        ).toContain("current project roster");
        expect(h.sends).toHaveLength(0);
        const unarchived = yield* h.service.projectAgentLifecycle({
          projectId,
          agentId: agent.agentId,
          action: "unarchive",
        });
        expect(unarchived.archived).toBe(false);
        expect(unarchived.enabled).toBe(false);
        yield* h.service.projectAgentLifecycle({
          projectId,
          agentId: agent.agentId,
          action: "connect",
        });
        const renamed = yield* h.service.projectAgentUpdate({
          projectId,
          agentId: agent.agentId,
          label: "System architect",
        });
        expect(renamed.label).toBe("System architect");
        expect(renamed.instructions).toBe(createInput.instructions);
        h.setRoot("/different-provider-root");
        expect((yield* h.service.projectTeam({ projectId })).projectAgents[0]?.error).toContain(
          "storage changed",
        );
        expect(
          (yield* Effect.flip(
            h.service.projectAgentLifecycle({
              projectId,
              agentId: agent.agentId,
              action: "connect",
            }),
          )).message,
        ).toContain("storage changed");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "rejects steering and malformed skill selections before target reads, peers or delivery claims",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const agent = yield* h.service.projectAgentCreate(createInput);
        const readsBefore = h.reads.length;
        const wiresBefore = h.wires.length;
        const sendsBefore = h.sends.length;
        for (const [handlingMode, text, message] of [
          [
            "steer",
            "Use [review](meerkat-skill://b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64/review)",
            "Skills start with a new turn",
          ],
          ["queue", "Use [review](meerkat-skill://missing/review)", "selection is invalid"],
        ] as const) {
          const refused = yield* Effect.flip(
            h.service.agentSend({
              projectId,
              instanceId,
              agentRef: agent.agentRef!,
              requestId: `skill-${handlingMode}`,
              text,
              handlingMode,
            }),
          );
          expect(refused.message).toContain(message);
        }
        expect(h.reads).toHaveLength(readsBefore);
        expect(h.wires).toHaveLength(wiresBefore);
        expect(h.sends).toHaveLength(sendsBefore);
        const sql = yield* SqlClient.SqlClient;
        expect(
          yield* sql`SELECT * FROM meerkat_agent_delivery_receipts WHERE request_id IN ('skill-queue','skill-steer')`,
        ).toHaveLength(0);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "sends exact selected-skill requests once across reopen and refuses a changed source on retry",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const agent = yield* h.service.projectAgentCreate(createInput);
        const text =
          "日本語: [review](meerkat-skill://b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64/review)";
        const input = {
          projectId,
          instanceId,
          agentRef: agent.agentRef!,
          requestId: "skill-turn",
          text,
          handlingMode: "queue" as const,
        };
        const receipt = yield* h.service.agentSend(input);
        expect(receipt.status).toBe("accepted");
        expect(h.sends).toHaveLength(1);
        expect(h.sends[0]).toMatchObject({
          text,
          skillSelectionText: text,
          requestId: input.requestId,
          record: { session_id: "stable-session", identity: h.creates[0]!.identity },
        });
        const reopened = yield* h.reopen;
        expect(yield* reopened.agentSend(input)).toEqual(receipt);
        expect(
          (yield* Effect.result(
            reopened.agentSend({
              ...input,
              text: text.replace(
                "b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64",
                "4fa3e1a2-5b6c-47d8-9012-3456789abcde",
              ),
            }),
          ))._tag,
        ).toBe("Failure");
        expect(h.sends).toHaveLength(1);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "keeps malformed queued selections editable and dispatches the corrected skill selection once",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const agent = yield* h.service.projectAgentCreate(createInput);
        const target = { projectId, instanceId, agentRef: agent.agentRef! };
        const queue = yield* makeMeerkatAgentQueueService(h.service, {
          questions: () => Effect.succeed({ requests: [] }),
        });
        const text = "Use [review](meerkat-skill://missing/review)";
        yield* queue.enqueue({ ...target, requestId: "skill-queued", payload: { text } });
        yield* queue.runOnce;
        let state = yield* queue.list(target);
        expect(state.items[0]?.status).toBe("failed");
        expect(state.items[0]?.payload.text).toBe(text);
        expect(state.items[0]?.error).toContain("selection is invalid");
        expect(h.sends).toHaveLength(0);
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT * FROM meerkat_agent_delivery_receipts`).toHaveLength(0);
        const selectedText =
          "Use [review](meerkat-skill://b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64/review)";
        state = yield* queue.edit({
          ...target,
          itemId: state.items[0]!.id,
          expectedRevision: state.revision,
          payload: { text: selectedText },
        });
        state = yield* queue.retry({
          ...target,
          itemId: state.items[0]!.id,
          expectedRevision: state.revision,
        });
        expect(state.items[0]?.status).toBe("queued");
        yield* queue.runOnce;
        expect(h.sends).toHaveLength(1);
        expect(h.sends[0]).toMatchObject({ text: selectedText, skillSelectionText: selectedText });
        expect((yield* queue.list(target)).items[0]?.status).toBe("accepted");
        yield* queue.runOnce;
        expect(h.sends).toHaveLength(1);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("projects referenced typed context into native text and delivery identity", () =>
    Effect.gen(function* () {
      yield* seed;
      const h = yield* harness();
      const agent = yield* h.service.projectAgentCreate(createInput);
      const input = {
        projectId,
        instanceId,
        agentRef: agent.agentRef!,
        requestId: "context-native",
        text: "Explain [tests](t3-context://v1/terminal/test-output)",
        handlingMode: "queue" as const,
        context: {
          version: 1 as const,
          records: [
            {
              version: 1 as const,
              kind: "terminal" as const,
              contextId: ComposerContextId.make("test-output"),
              label: "tests",
              terminalId: "shell-a",
              terminalLabel: "tests",
              lineStart: 1,
              lineEnd: 2,
              text: "FAIL\nexpected 42",
            },
          ],
        },
      };
      yield* h.service.agentSend(input);
      expect(h.sends[0]).toMatchObject({ text: expect.stringContaining("expected 42") });
      expect(h.sends[0]).toMatchObject({ text: expect.not.stringContaining("t3-context://") });
      expect(
        (yield* h.service
          .agentSend({
            ...input,
            context: {
              ...input.context,
              records: [{ ...input.context.records[0]!, text: "Different evidence" }],
            },
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(h.sends).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "keeps failed model preparation unclaimed and permits retry with the original request ID",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const store = yield* makeMeerkatProjectAgentStore;
        const agent = yield* h.service.projectAgentCreate(createInput);
        const input = {
          projectId,
          instanceId,
          agentRef: agent.agentRef!,
          requestId: "prepare-failed",
          text: "Review",
          handlingMode: "queue" as const,
          modelSelection: { instanceId, model },
        };
        h.setPreparation(
          Effect.fail(
            new ProviderDriverError({
              driver: ProviderDriverKind.make("meerkat"),
              instanceId,
              detail: "Catalog unavailable",
            }),
          ),
        );
        expect((yield* Effect.flip(h.service.agentSend(input))).message).toContain(
          "Catalog unavailable",
        );
        expect(yield* store.delivery(projectId, instanceId, input.requestId)).toBeUndefined();
        expect(h.sends).toHaveLength(0);
        h.setPreparation(Effect.void);
        expect((yield* h.service.agentSend(input)).status).toBe("accepted");
        expect(h.sends).toHaveLength(1);
        expect(h.preparations).toHaveLength(2);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("returns existing receipts without repeating model admission or preparation", () =>
    Effect.gen(function* () {
      yield* seed;
      const h = yield* harness();
      const agent = yield* h.service.projectAgentCreate(createInput);
      const input = {
        projectId,
        instanceId,
        agentRef: agent.agentRef!,
        requestId: "already-admitted",
        text: "Review",
        handlingMode: "queue" as const,
        modelSelection: { instanceId, model },
      };
      const accepted = yield* h.service.agentSend(input);
      h.setFailSend(true);
      const uncertainInput = { ...input, requestId: "admitted-without-receipt" };
      const uncertain = yield* h.service.agentSend(uncertainInput);
      const catalogReads = h.catalogReads;
      const preparations = h.preparations.length;
      h.setCatalogAvailable(false);
      h.setPreparation(
        Effect.fail(
          new ProviderDriverError({
            driver: ProviderDriverKind.make("meerkat"),
            instanceId,
            detail: "Must not prepare an old admission",
          }),
        ),
      );
      expect(yield* h.service.agentSend(input)).toEqual(accepted);
      expect(yield* h.service.agentSend(uncertainInput)).toEqual(uncertain);
      expect(h.catalogReads).toBe(catalogReads);
      expect(h.preparations).toHaveLength(preparations);
      expect(h.sends).toHaveLength(2);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("allows Stop while read-only model preparation is pending", () =>
    Effect.gen(function* () {
      yield* seed;
      const h = yield* harness();
      const agent = yield* h.service.projectAgentCreate(createInput);
      const preparing = yield* Deferred.make<void>();
      const continuePreparation = yield* Deferred.make<void>();
      h.setPreparation(
        Deferred.succeed(preparing, undefined).pipe(
          Effect.andThen(Deferred.await(continuePreparation)),
        ),
      );
      const send = yield* h.service
        .agentSend({
          projectId,
          instanceId,
          agentRef: agent.agentRef!,
          requestId: "prepare-wait",
          text: "Review",
          handlingMode: "queue",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(preparing);
      expect(
        (yield* h.service.agentStop({
          projectId,
          instanceId,
          agentRef: agent.agentRef!,
          nativeRunId: "exact-run",
        })).status,
      ).toBe("accepted");
      expect(h.sends).toHaveLength(0);
      yield* Deferred.succeed(continuePreparation, undefined);
      expect((yield* Fiber.join(send)).status).toBe("accepted");
      expect(h.sends).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("revalidates the native target after preparation and before a delivery claim", () =>
    Effect.gen(function* () {
      yield* seed;
      const h = yield* harness();
      const store = yield* makeMeerkatProjectAgentStore;
      const agent = yield* h.service.projectAgentCreate(createInput);
      h.setPreparation(Effect.sync(() => h.native.clear()));
      const input = {
        projectId,
        instanceId,
        agentRef: agent.agentRef!,
        requestId: "target-changed",
        text: "Review",
        handlingMode: "queue" as const,
      };
      expect((yield* h.service.agentSend(input).pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* store.delivery(projectId, instanceId, input.requestId)).toBeUndefined();
      expect(h.sends).toHaveLength(0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "commits caller authorization with the first claim and never reapplies it to uncertain delivery",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const agent = yield* h.service.projectAgentCreate(createInput);
        const input = {
          projectId,
          instanceId,
          agentRef: agent.agentRef!,
          requestId: "guarded-admission",
          text: "Review",
          handlingMode: "queue" as const,
        };
        const sql = yield* SqlClient.SqlClient;
        const denied = {
          check: Effect.gen(function* () {
            yield* sql`INSERT INTO shared_workspace(singleton, definition_json) VALUES (1, '{}')`;
            return yield* new MeerkatTeamError({
              projectId,
              operation: "agent-control",
              message: "Access revoked",
            });
          }),
        };
        expect(
          (yield* h.service.agentSendWithAdmission(input, denied).pipe(Effect.flip)).message,
        ).toBe("Access revoked");
        expect(yield* sql`SELECT * FROM meerkat_agent_delivery_receipts`).toEqual([]);
        expect(yield* sql`SELECT * FROM shared_workspace`).toEqual([]);
        expect(h.sends).toHaveLength(0);
        h.setFailSend(true);
        expect(
          (yield* h.service.agentSendWithAdmission(input, {
            check:
              sql`INSERT INTO shared_workspace(singleton, definition_json) VALUES (1, '{}')`.pipe(
                Effect.asVoid,
              ),
          })).status,
        ).toBe("uncertain");
        expect(yield* sql`SELECT * FROM shared_workspace`).toHaveLength(1);
        expect(yield* sql`SELECT * FROM meerkat_agent_delivery_receipts`).toHaveLength(1);
        const reopened = yield* h.reopen;
        expect((yield* reopened.agentSendWithAdmission(input, denied)).status).toBe("uncertain");
        expect(h.sends).toHaveLength(1);
        let missing = 0;
        yield* reopened.agentDeliveryReconcile(
          input,
          Effect.sync(() => {
            missing++;
          }),
        );
        expect(missing).toBe(0);
        yield* reopened.agentDeliveryReconcile(
          { ...input, requestId: "not-claimed" },
          Effect.sync(() => {
            missing++;
          }),
        );
        expect(missing).toBe(1);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("checks the required native policy again after preparation before claiming", () =>
    Effect.gen(function* () {
      yield* seed;
      const h = yield* harness();
      const agent = yield* h.service.projectAgentCreate({
        ...createInput,
        accessMode: "repository-read-only",
      });
      h.setPreparation(
        Effect.sync(() => {
          for (const [key, state] of h.native)
            h.native.set(key, {
              ...state,
              mobs: state.mobs.map((mob) => ({ ...mob, accessMode: "full-access" })),
            });
        }),
      );
      const input = {
        projectId,
        instanceId,
        agentRef: agent.agentRef!,
        requestId: "policy-changed",
        text: "Review",
        handlingMode: "queue" as const,
      };
      expect(
        (yield* h.service
          .agentSendWithAdmission(input, { accessMode: "repository-read-only", check: Effect.void })
          .pipe(Effect.flip)).message,
      ).toContain("required observed execution policy");
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT * FROM meerkat_agent_delivery_receipts`).toEqual([]);
      expect(h.sends).toHaveLength(0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("claims concurrent preparations of the same immutable request only once", () =>
    Effect.gen(function* () {
      yield* seed;
      const h = yield* harness();
      const agent = yield* h.service.projectAgentCreate(createInput);
      const bothPrepared = yield* Deferred.make<void>();
      let prepared = 0;
      h.setPreparation(
        Effect.gen(function* () {
          prepared += 1;
          if (prepared === 2) yield* Deferred.succeed(bothPrepared, undefined);
          yield* Deferred.await(bothPrepared);
        }),
      );
      const input = {
        projectId,
        instanceId,
        agentRef: agent.agentRef!,
        requestId: "same-prepared-request",
        text: "Review",
        handlingMode: "queue" as const,
      };
      const [first, second] = yield* Effect.all(
        [h.service.agentSend(input), h.service.agentSend(input)],
        { concurrency: 2 },
      );
      expect(first?.status).toBe("accepted");
      expect(second).toEqual(first);
      expect(h.preparations).toHaveLength(2);
      expect(h.sends).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "returns durable native delivery receipts without replaying duplicate or uncertain requests",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const agent = yield* h.service.projectAgentCreate(createInput);
        const input = {
          projectId,
          instanceId,
          agentRef: agent.agentRef!,
          requestId: "send-one",
          text: "Inspect the design",
          handlingMode: "steer" as const,
        };
        const receipt = yield* h.service.agentSend(input);
        expect(receipt.status).toBe("accepted");
        expect(yield* h.service.agentSend(input)).toEqual(receipt);
        expect(h.sends).toHaveLength(1);
        expect(
          (yield* Effect.flip(h.service.agentSend({ ...input, text: "Different" }))).message,
        ).toContain("different content");
        h.setFailSend(true);
        const uncertain = yield* h.service.agentSend({ ...input, requestId: "timeout" });
        expect(uncertain.status).toBe("uncertain");
        h.setFailSend(false);
        const reopened = yield* h.reopen;
        expect(yield* reopened.agentSend({ ...input, requestId: "timeout" })).toEqual(uncertain);
        expect(h.sends).toHaveLength(2);
        expect(
          (yield* h.service.agentStop({
            projectId,
            instanceId,
            agentRef: agent.agentRef!,
            nativeRunId: "observed-run",
          })).status,
        ).toBe("accepted");
        expect(h.stops).toHaveLength(1);
        expect(
          (yield* Effect.flip(
            h.service.agentSend({ ...input, projectId: otherProjectId, requestId: "foreign" }),
          )).message,
        ).toContain("current project roster");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "reconciles lost acceptance from the original cold session without a catalog or another send",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const agent = yield* h.service.projectAgentCreate(createInput);
        const input = {
          projectId,
          instanceId,
          agentRef: agent.agentRef!,
          requestId: "lost-receipt",
          text: "Review the change",
          handlingMode: "queue" as const,
          modelSelection: { instanceId, model },
        };
        h.setFailSend(true);
        expect((yield* h.service.agentSend(input)).status).toBe("uncertain");
        const sends = h.sends.length;
        const creates = h.creates.length;
        const snapshots = h.reads.length;
        const catalogReads = h.catalogReads;
        h.setCatalogAvailable(false);
        h.native.clear();
        const reopened = yield* h.reopen;
        expect((yield* reopened.agentDeliveryReconcile(input))?.status).toBe("uncertain");
        const original = h.receiptReads[0]!;
        expect(original.record.session_id).toBe("stable-session");
        h.receipts.set(input.requestId, {
          identity: original.record.identity,
          session_id: "stable-session",
          input_frame_id: "persisted-input",
          interaction_id: "persisted-interaction",
          cursor: "17",
          status: "delivered",
        });
        const receipt = yield* reopened.agentDeliveryReconcile(input);
        expect(receipt).toMatchObject({
          status: "accepted",
          receipt: { receipt: { interaction_id: "persisted-interaction" } },
        });
        expect(yield* reopened.agentDeliveryReconcile(input)).toEqual(receipt);
        expect(h.sends).toHaveLength(sends);
        expect(h.creates).toHaveLength(creates);
        expect(h.reads).toHaveLength(snapshots);
        expect(h.catalogReads).toBe(catalogReads);
        expect(
          h.receiptReads.map((lookup) => [lookup.requestId, lookup.record.session_id]),
        ).toEqual(Array.from({ length: 3 }, () => [input.requestId, "stable-session"]));
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not claim or dispatch a missing direct-message receipt", () =>
    Effect.gen(function* () {
      yield* seed;
      const h = yield* harness();
      h.setCatalogAvailable(false);
      const input = {
        projectId,
        instanceId,
        agentRef: "original-session",
        requestId: "unrecorded-attempt",
        text: "Review the change",
        handlingMode: "queue" as const,
        modelSelection: { instanceId, model: "openai:removed-model" },
      };
      for (let attempt = 0; attempt < 2; attempt++)
        expect(yield* h.service.agentDeliveryReconcile(input)).toBeUndefined();
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT * FROM meerkat_agent_delivery_receipts`).toHaveLength(0);
      expect(h.sends).toHaveLength(0);
      expect(h.creates).toHaveLength(0);
      expect(h.reads).toHaveLength(0);
      expect(h.receiptReads).toHaveLength(0);
      expect(h.catalogReads).toBe(0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "recovers a durable queue acknowledgement through the real team adapter with its UI closed",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const agent = yield* h.service.projectAgentCreate(createInput);
        const target = { projectId, instanceId, agentRef: agent.agentRef! };
        const controls = { questions: () => Effect.succeed({ requests: [] }) };
        const queue = yield* makeMeerkatAgentQueueService(h.service, controls);
        yield* queue.enqueue({ ...target, requestId: "first", payload: { text: "Review first" } });
        yield* queue.enqueue({
          ...target,
          requestId: "second",
          payload: { text: "Review second" },
        });
        h.setFailSend(true);
        yield* queue.runOnce;
        expect((yield* queue.list(target)).items[0]?.status).toBe("uncertain");
        const send = h.sends[0] as Parameters<NonNullable<MeerkatTeamReader["send"]>>[0];
        h.receipts.set(send.requestId, {
          identity: send.record.identity,
          session_id: send.record.session_id,
          input_frame_id: "input-original",
          interaction_id: "interaction-original",
          cursor: "11",
          status: "delivered",
        });
        const background = yield* makeMeerkatAgentQueueService(yield* h.reopen, controls);
        yield* background.recoverInterrupted;
        yield* background.runOnce;
        expect((yield* background.list(target)).items[0]?.status).toBe("accepted");
        yield* background.runOnce;
        expect(h.sends).toHaveLength(1);
        h.frames.push({
          id: "complete",
          cursor: "12",
          dedupe_key: "complete-key",
          timestamp_ms: 12,
          runtime_key: send.record.runtime_key,
          identity: send.record.identity,
          session_id: send.record.session_id,
          interaction_id: "interaction-original",
          kind: "interaction_complete",
          status: "completed",
          frame_version: 1,
          payload: {},
          source: { kind: "console_event" },
        });
        h.setFailSend(false);
        yield* background.runOnce;
        yield* background.runOnce;
        expect(h.sends).toHaveLength(2);
        expect((h.sends[1] as { text: string }).text).toBe("Review second");
        expect(
          h.receiptReads.map((lookup) => [lookup.requestId, lookup.record.session_id]),
        ).toEqual(Array.from({ length: 3 }, () => [send.requestId, send.record.session_id]));
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "makes a crash before the native delivery claim explicitly retryable without a resend",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const agent = yield* h.service.projectAgentCreate(createInput);
        const target = { projectId, instanceId, agentRef: agent.agentRef! };
        const controls = { questions: () => Effect.succeed({ requests: [] }) };
        const queue = yield* makeMeerkatAgentQueueService(h.service, controls);
        const added = yield* queue.enqueue({
          ...target,
          requestId: "pre-claim-crash",
          payload: { text: "Review" },
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE meerkat_agent_queue_items SET status='dispatching',dispatch_agent_ref=${target.agentRef},dispatch_session_id='stable-session' WHERE item_id=${added.items[0]!.id}`;
        const restarted = yield* makeMeerkatAgentQueueService(yield* h.reopen, controls);
        yield* restarted.recoverInterrupted;
        yield* restarted.runOnce;
        const failed = yield* restarted.list(target);
        expect(failed.items[0]?.status).toBe("failed");
        expect(failed.items[0]?.error).toContain("before native delivery was claimed");
        expect(h.sends).toHaveLength(0);
        expect(h.receiptReads).toHaveLength(0);
        yield* restarted.retry({
          ...target,
          itemId: failed.items[0]!.id,
          expectedRevision: failed.revision,
        });
        yield* restarted.runOnce;
        expect(h.sends).toHaveLength(1);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "keeps failed native delivery fenced and rejects changed payload, scope or provider storage",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const agent = yield* h.service.projectAgentCreate(createInput);
        const input = {
          projectId,
          instanceId,
          agentRef: agent.agentRef!,
          requestId: "failed-receipt",
          text: "Review",
          handlingMode: "queue" as const,
        };
        h.setFailSend(true);
        yield* h.service.agentSend(input);
        expect(
          yield* h.service.agentDeliveryReconcile({ ...input, projectId: otherProjectId }),
        ).toBeUndefined();
        expect(
          yield* h.service.agentDeliveryReconcile({
            ...input,
            instanceId: ProviderInstanceId.make("another-provider"),
          }),
        ).toBeUndefined();
        expect(
          yield* h.service.agentDeliveryReconcile({ ...input, requestId: "never-dispatched" }),
        ).toBeUndefined();
        for (const patch of [
          { text: "Changed" },
          { agentRef: "replacement-agent" },
          { handlingMode: "steer" as const },
          { modelSelection: { instanceId, model } },
          {
            images: [
              {
                type: "image" as const,
                source: "blob" as const,
                blob_id: `sha256:${"a".repeat(64)}`,
                media_type: "image/png" as const,
              },
            ],
          },
        ])
          expect(
            (yield* Effect.flip(h.service.agentDeliveryReconcile({ ...input, ...patch }))).message,
          ).toContain("original agent session and message");
        expect(h.receiptReads).toHaveLength(0);
        yield* h.service.agentDeliveryReconcile(input);
        h.receipts.set(input.requestId, {
          identity: h.receiptReads[0]!.record.identity,
          session_id: "stable-session",
          input_frame_id: "failed-input",
          interaction_id: "failed-interaction",
          cursor: "18",
          status: "delivery_failed",
        });
        const failed = yield* h.service.agentDeliveryReconcile(input);
        expect(failed?.status).toBe("uncertain");
        expect(failed?.message).toContain("delivery_failed");
        h.setRoot("/reconfigured-provider");
        expect((yield* Effect.flip(h.service.agentDeliveryReconcile(input))).message).toContain(
          "original agent session and provider storage",
        );
        expect(h.sends).toHaveLength(1);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "recovers previous-session accepted and uncertain receipts without sending into its replacement",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const agent = yield* h.service.projectAgentCreate(createInput);
        const input = {
          projectId,
          instanceId,
          agentRef: agent.agentRef!,
          requestId: "previous-accepted",
          text: "Inspect the design",
          handlingMode: "queue" as const,
        };
        const accepted = yield* h.service.agentSend(input);
        h.setFailSend(true);
        const uncertain = yield* h.service.agentSend({ ...input, requestId: "previous-uncertain" });
        h.setFailSend(false);
        const definition = h.creates[0]!;
        const native = h.native.get(definition.stateRoot)!;
        h.native.set(definition.stateRoot, {
          ...native,
          mobs: native.mobs.map((mob) => ({
            ...mob,
            identities: mob.identities.map((member) => ({
              ...member,
              session_id: "replacement-session",
            })),
          })),
        });
        const reopened = yield* h.reopen;
        const replacement = (yield* reopened.projectTeam({ projectId })).projectAgents[0]!;
        expect(replacement.agentRef).not.toBe(agent.agentRef);
        const recovered = yield* reopened.agentSend({ ...input, agentRef: replacement.agentRef! });
        expect(recovered).toMatchObject({ status: "accepted", receipt: accepted.receipt });
        expect(recovered.message).toContain("previous agent session");
        const unresolved = yield* reopened.agentSend({
          ...input,
          agentRef: replacement.agentRef!,
          requestId: "previous-uncertain",
        });
        expect(unresolved).toMatchObject({ status: "uncertain", receipt: uncertain.receipt });
        expect(unresolved.message).toContain("previous agent session remains uncertain");
        for (const patch of [{ text: "Different" }, { handlingMode: "steer" as const }])
          expect(
            (yield* Effect.flip(
              reopened.agentSend({ ...input, ...patch, agentRef: replacement.agentRef! }),
            )).message,
          ).toContain("different content or target");
        const other = yield* reopened.projectAgentCreate({
          ...createInput,
          requestId: "other",
          role: "other",
        });
        expect(
          (yield* Effect.flip(reopened.agentSend({ ...input, agentRef: other.agentRef! }))).message,
        ).toContain("different content or target");
        const previousRuntime = h.native.get(definition.stateRoot)!;
        h.native.set(definition.stateRoot, {
          ...previousRuntime,
          mobs: previousRuntime.mobs.map((mob) => ({
            ...mob,
            identities: mob.identities.map((member) => ({
              ...member,
              runtime_key: "another-runtime",
            })),
          })),
        });
        const otherRuntime = (yield* reopened.projectTeam({ projectId })).projectAgents[0]!;
        expect(
          (yield* Effect.flip(reopened.agentSend({ ...input, agentRef: otherRuntime.agentRef! })))
            .message,
        ).toContain("different content or target");
        h.native.set(definition.stateRoot, previousRuntime);
        expect(h.sends).toHaveLength(2);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE meerkat_agent_delivery_receipts SET stable_fingerprint = NULL WHERE request_id = ${input.requestId}`;
        expect(
          (yield* Effect.flip(reopened.agentSend({ ...input, agentRef: replacement.agentRef! })))
            .message,
        ).toContain("earlier agent session whose identity cannot be verified");
        expect(h.sends).toHaveLength(2);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "persists staged solo or agent selections before atomic thread creation and enforces reserved ownership",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const agent = yield* h.service.projectAgentCreate(createInput);
        const input = { projectId, instanceId, threadId: ThreadId.make("reserved-thread") };
        const defaults = yield* h.service.threadConnections(input);
        expect(defaults.explicit).toBe(false);
        expect(defaults.desiredAgentIds).toEqual([agent.agentId]);
        const staged = yield* h.service.threadConnectionsSet({
          ...input,
          requestId: "selection",
          agentIds: [],
        });
        expect(staged.desiredAgentIds).toEqual([]);
        expect(staged.explicit).toBe(true);
        const reopened = yield* h.reopen;
        expect((yield* reopened.threadConnections(input)).desiredAgentIds).toEqual([]);
        expect(
          (yield* Effect.flip(
            reopened.threadConnectionsSet({
              ...input,
              projectId: otherProjectId,
              requestId: "foreign",
              agentIds: [],
            }),
          )).message,
        ).toContain("another project");
        expect(
          (yield* Effect.flip(
            reopened.threadConnectionsSet({
              ...input,
              requestId: "unknown",
              agentIds: ["foreign-agent"],
            }),
          )).message,
        ).toContain("belonging");
        const before = h.reads.length;
        yield* reopened.projectAgents({ projectId });
        expect(h.reads).toHaveLength(before);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "applies native connections before a turn, freezes defaults, and reconnects suppressed edges",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const agent = yield* h.service.projectAgentCreate(createInput);
        const threadId = ThreadId.make("native-thread");
        const input = { projectId, threadId, instanceId };
        yield* seedThread(threadId);
        const sourceMobId = `t3-${NodeCrypto.createHash("sha256").update(`${instanceId}:${threadId}`).digest("hex")}`;
        h.native.set(`/workspace/${projectId}`, {
          observation: "loaded_runtimes",
          loaded: true,
          mobs: [
            {
              mobId: sourceMobId,
              label: "Thread",
              kind: "thread",
              consoleStatus: "ready",
              identities: [],
            },
          ],
        });
        expect((yield* h.service.threadConnections(input)).connections[0]?.status).toBe(
          "disconnected",
        );
        h.native.delete(h.creates[0]!.stateRoot);
        yield* h.service.applyThreadConnections(input, true);
        expect(h.creates).toHaveLength(2);
        expect(h.wires[0]).toMatchObject({
          connected: true,
          params: {
            sourceMobId,
            targetMobId: h.creates[0]!.mobId,
            targetStateRoot: h.creates[0]!.stateRoot,
            action: "connect",
            expectedRevisions: { [sourceMobId]: 1, [h.creates[0]!.mobId]: 1 },
          },
        });
        expect((yield* h.service.threadConnections(input)).connections[0]?.status).toBe(
          "connected",
        );
        yield* h.service.projectAgentCreate({
          ...createInput,
          requestId: "reviewer",
          role: "reviewer",
          label: "Reviewer",
        });
        expect((yield* h.service.threadConnections(input)).desiredAgentIds).toEqual([
          agent.agentId,
        ]);
        yield* h.service.threadConnectionsSet({ ...input, agentIds: [], requestId: "solo" });
        expect(h.wires[1]?.connected).toBe(false);
        yield* h.service.threadConnectionsSet({
          ...input,
          agentIds: [agent.agentId],
          requestId: "return",
        });
        expect(h.wires[2]?.params.action).toBe("reconnect");
        yield* h.service.applyThreadConnections(input, true);
        expect(h.wires).toHaveLength(3);
        h.native.delete(`/workspace/${projectId}`);
        expect(
          (yield* Effect.flip(h.service.applyThreadConnections(input, true))).message,
        ).toContain("native thread is unavailable");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "keeps canonical controls scoped to native incarnations and activity in the domain root",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const agent = yield* h.service.projectAgentCreate(createInput);
        yield* h.service.agentActivity({
          projectId,
          instanceId,
          agentRef: agent.agentRef!,
          before: "console:42",
        });
        expect(h.activities[0]).toMatchObject({
          stateRoot: h.creates[0]!.stateRoot,
          mobId: h.creates[0]!.mobId,
          before: "console:42",
        });
        const native = h.native.get(h.creates[0]!.stateRoot)!;
        const record = native.mobs[0]!.identities[0]!;
        h.native.set(h.creates[0]!.stateRoot, {
          ...native,
          mobs: [{ ...native.mobs[0]!, identities: [{ ...record, session_id: "replacement" }] }],
        });
        expect(
          (yield* Effect.flip(
            h.service.agentSend({
              projectId,
              instanceId,
              agentRef: agent.agentRef!,
              text: "stale",
              handlingMode: "queue",
              requestId: "stale",
            }),
          )).message,
        ).toContain("current project roster");
        h.native.set(`/workspace/${projectId}`, {
          observation: "loaded_runtimes",
          loaded: true,
          mobs: [
            {
              mobId: "thread-root",
              kind: "thread",
              label: "Thread",
              consoleStatus: "ready",
              identities: [
                { ...record, identity: "ingress", runtime_member_id: "ingress" },
                { ...record, identity: "worker", runtime_member_id: "native-worker" },
              ],
            },
          ],
        });
        const team = yield* h.service.projectTeam({ projectId });
        const coordinator = team.providers[0]!.agents.find(
          (entry) => entry.record.identity === "ingress",
        )!;
        const worker = team.providers[0]!.agents.find(
          (entry) => entry.record.identity === "worker",
        )!;
        expect(
          (yield* Effect.flip(
            h.service.agentStop({
              projectId,
              instanceId,
              agentRef: coordinator.agentRef,
              nativeRunId: "observed-run",
            }),
          )).message,
        ).toContain("thread conversation");
        yield* h.service.agentSend({
          projectId,
          instanceId,
          agentRef: worker.agentRef,
          text: "Inspect",
          handlingMode: "steer",
          requestId: "worker",
        });
        expect(h.sends).toHaveLength(1);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("joins concurrent duplicate creation across separate service facades", () =>
    Effect.gen(function* () {
      yield* seed;
      const h = yield* harness();
      const second = yield* h.reopen;
      const result = yield* Effect.all(
        [h.service.projectAgentCreate(createInput), second.projectAgentCreate(createInput)],
        { concurrency: "unbounded" },
      );
      expect(result[0]?.agentId).toBe(result[1]?.agentId);
      expect(result.every((agent) => agent.connectionStatus === "connected")).toBe(true);
      expect(h.creates).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "retains desired intent after native connection rejection without claiming a physical edge",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        const agent = yield* h.service.projectAgentCreate(createInput);
        const threadId = ThreadId.make("rejected-thread");
        yield* seedThread(threadId);
        const mobId = `t3-${NodeCrypto.createHash("sha256").update(`${instanceId}:${threadId}`).digest("hex")}`;
        h.native.set(`/workspace/${projectId}`, {
          observation: "loaded_runtimes",
          loaded: true,
          mobs: [
            { mobId, label: "Thread", kind: "thread", consoleStatus: "ready", identities: [] },
          ],
        });
        h.setRejectWire(true);
        const input = { projectId, threadId, instanceId };
        expect(
          (yield* Effect.flip(
            h.service.threadConnectionsSet({
              ...input,
              agentIds: [agent.agentId],
              requestId: "denied",
            }),
          )).message,
        ).toContain("Native policy rejected");
        const observed = yield* h.service.threadConnections(input);
        expect(observed.desiredAgentIds).toEqual([agent.agentId]);
        expect(observed.connections[0]?.status).toBe("disconnected");
        expect(h.sends).toHaveLength(0);
      }).pipe(Effect.provide(testLayer)),
  );
});

const encodeFixtureJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const proposalThread = ThreadId.make("proposal-source");
const proposalPayload = (paths: readonly string[] = ["src", "tests", "docs"]) => ({
  title: "Repository specialists",
  summary: "Three focused project domains",
  agents: ["core", "quality", "guides"].map((role, index) => ({
    id: role,
    label: role === "core" ? "Core" : role === "quality" ? "Quality" : "Guides",
    role,
    focus: `Study the ${role} domain`,
    charter: `Own the ${role} boundaries and preserve the repository's verified invariants.`,
    recommended: index === 0,
    ownership_paths: [paths[index]!],
  })),
});
const proposalWorkspace = Effect.fnUntraced(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-proposal-test-"))),
    (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
  );
  for (const name of ["src", "tests", "docs"])
    yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, name)));
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE projection_projects SET workspace_root=${root} WHERE project_id=${projectId}`;
  return root;
});
const bindProposalThread = Effect.gen(function* () {
  yield* seedThread(proposalThread);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO provider_session_runtime
  (thread_id,provider_name,provider_instance_id,adapter_key,status,last_seen_at)
  VALUES (${proposalThread},'meerkat',${instanceId},'meerkat','stopped','now')`;
});
const nativeProposal = Effect.fnUntraced(function* (input: {
  sequence?: number;
  toolId?: string;
  pending?: boolean;
  failed?: boolean;
  payload?: unknown;
  omitArguments?: boolean;
  runId?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const sequence = input.sequence ?? 1;
  const toolId = input.toolId ?? "proposal-call";
  const payload = yield* encodeFixtureJson({
    toolCallId: `${input.runId ?? "run"}:tool:${toolId}`,
    status: input.pending ? "inProgress" : input.failed ? "failed" : "completed",
    data: {
      toolId,
      toolName: "mcp__project_proposal__ui_project_agent_proposal",
      ...(input.omitArguments ? {} : { toolArguments: input.payload ?? proposalPayload() }),
      isError: input.failed ?? false,
      toolResult: { isError: input.failed ?? false },
    },
  });
  yield* sql`INSERT INTO projection_thread_activities
  (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,sequence,created_at)
  VALUES (${`proposal-event-${sequence}`},${proposalThread},NULL,'tool',${input.pending ? "tool.started" : "tool.completed"},'Proposal',${payload},${sequence},'now')`;
});
const studyFrame = (interactionId: string, kind = "interaction_complete"): ConsoleFrame => ({
  id: `${interactionId}:${kind}`,
  cursor: "1",
  dedupe_key: `${interactionId}:${kind}`,
  timestamp_ms: 1,
  runtime_key: "default",
  identity: "core",
  interaction_id: interactionId,
  kind,
  status: kind === "interaction_started" ? "accepted" : "completed",
  frame_version: 1,
  payload: { result: "Domain Brief grounded in src" },
  source: { kind: "console_event" },
});
const selectedProposal = {
  projectId,
  sourceThreadId: proposalThread,
  proposalId: "proposal-call",
  candidateIds: ["core"],
};

describe("Meerkat native project proposals", () => {
  it.effect(
    "prepares generated shared specialists with repository-only policy and preserves it on retry",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* proposalWorkspace();
        yield* bindProposalThread;
        yield* nativeProposal({});
        const h = yield* harness();
        const input = { ...selectedProposal, accessMode: "repository-read-only" as const };
        const first = yield* h.service.projectProposalCreate(input);
        const agent = first.results[0]!.agent!;
        expect(first.results[0]?.error).toBeNull();
        expect(agent.accessMode).toBe("repository-read-only");
        expect(h.creates[0]?.accessMode).toBe("repository-read-only");
        expect(h.creates[0]?.instructions).toContain("attributed requests in the shared workspace");
        expect(h.sends).toHaveLength(1);
        const reopened = yield* h.reopen;
        const retry = yield* reopened.projectProposalCreate(input);
        expect(retry.results[0]?.agent).toMatchObject({
          agentId: agent.agentId,
          accessMode: "repository-read-only",
        });
        expect(h.creates).toHaveLength(1);
        expect(h.sends).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "shared proposals leave differently permitted local roles and their assignments untouched",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* proposalWorkspace();
        yield* bindProposalThread;
        yield* nativeProposal({});
        const h = yield* harness();
        const first = yield* h.service.projectProposalCreate({
          ...selectedProposal,
          accessMode: "read-and-collaborate",
        });
        const original = first.results[0]!.agent!;
        const payload = proposalPayload();
        payload.agents[0]!.charter = "A changed shared responsibility";
        yield* nativeProposal({ sequence: 2, toolId: "shared-proposal", payload });
        const rejected = yield* h.service.projectProposalCreate({
          ...selectedProposal,
          proposalId: "shared-proposal",
          accessMode: "repository-read-only",
        });
        expect(rejected.results[0]?.error).toContain("existing local agent");
        expect(rejected.results[0]?.agent).toBeNull();
        const observed = (yield* h.service.projectTeam({ projectId })).projectAgents[0]!;
        expect(observed).toMatchObject({
          agentId: original.agentId,
          accessMode: original.accessMode,
          charter: original.charter,
        });
        expect(h.revisions).toEqual([]);
        expect(h.creates).toHaveLength(1);
        expect(h.sends).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps published specialist changes in shared composition history", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* proposalWorkspace();
      yield* bindProposalThread;
      yield* nativeProposal({});
      const h = yield* harness();
      const first = yield* h.service.projectProposalCreate({
        ...selectedProposal,
        accessMode: "repository-read-only",
      });
      const original = first.results[0]!.agent!;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO shared_specialists
        (specialist_id,request_id,fingerprint,native_project_id,native_instance_id,native_agent_id,definition_json)
        VALUES ('shared-core','register-core','fingerprint',${projectId},${instanceId},${original.agentId},'{}')`;
      const payload = proposalPayload();
      payload.agents[0]!.charter = "A changed shared responsibility";
      yield* nativeProposal({ sequence: 2, toolId: "shared-proposal", payload });
      const rejected = yield* h.service.projectProposalCreate({
        ...selectedProposal,
        proposalId: "shared-proposal",
        accessMode: "repository-read-only",
      });
      expect(rejected.results[0]?.error).toContain("shared composition history");
      const observed = (yield* h.service.projectTeam({ projectId })).projectAgents[0]!;
      expect(observed).toMatchObject({ agentId: original.agentId, charter: original.charter });
      expect(h.revisions).toEqual([]);
      expect(h.creates).toHaveLength(1);
      expect(h.sends).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "inherits scoped source reasoning once and preserves admitted creation across picker changes",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const workspace = yield* proposalWorkspace();
        yield* bindProposalThread;
        yield* nativeProposal({});
        const h = yield* harness();
        const sql = yield* SqlClient.SqlClient;
        const selectedModel = "openai:workspace-only-model";
        const options = [{ id: "reasoning_effort", value: "high" }];
        const selection = yield* encodeFixtureJson({ instanceId, model: selectedModel, options });
        yield* sql`UPDATE projection_threads SET model_selection_json=${selection} WHERE thread_id=${proposalThread}`;
        h.workspaceCatalogs.set(workspace, {
          ...h.catalog,
          models: [
            {
              slug: selectedModel,
              name: selectedModel,
              isCustom: true,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "reasoning_effort",
                    label: "Reasoning level",
                    type: "select",
                    options: [{ id: "high", label: "High" }],
                  },
                ],
              },
            },
          ],
        });
        h.setFailConnect(true);
        const first = yield* h.service.projectProposalCreate(selectedProposal);
        const admitted = first.results[0]!.agent!;
        expect(first.results[0]?.error).not.toBeNull();
        expect(admitted).toMatchObject({ model: selectedModel, options });
        expect(h.workspaceCatalogReads).toEqual([workspace]);
        expect(h.defaultCatalogReads).toBe(0);
        expect(h.sends).toEqual([]);

        const changed = yield* encodeFixtureJson({
          instanceId,
          model: "openai:new-picker-model",
          options: [],
        });
        yield* sql`UPDATE projection_threads SET model_selection_json=${changed} WHERE thread_id=${proposalThread}`;
        h.setCatalogAvailable(false);
        h.setFailConnect(false);
        const reopened = yield* h.reopen;
        const retried = yield* reopened.projectProposalCreate(selectedProposal);
        expect(retried.results[0]?.error).toBeNull();
        expect(retried.results[0]?.agent).toMatchObject({
          agentId: admitted.agentId,
          model: selectedModel,
          options,
        });
        expect(h.creates).toHaveLength(1);
        expect(h.creates[0]).toMatchObject({ model: selectedModel, options });
        expect(h.sends).toHaveLength(1);
        expect(h.catalogReads).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "does not inherit options from a draft selection that differs from the bound proposal model",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const workspace = yield* proposalWorkspace();
        yield* bindProposalThread;
        yield* nativeProposal({});
        const h = yield* harness();
        const sql = yield* SqlClient.SqlClient;
        const boundModel = "openai:bound-model";
        const runtime = yield* encodeFixtureJson({
          model: boundModel,
          modelSelection: {
            instanceId: "other-instance",
            model: boundModel,
            options: [{ id: "reasoning_effort", value: "high" }],
          },
        });
        const draft = yield* encodeFixtureJson({
          instanceId,
          model,
          options: [{ id: "effort", value: "high" }],
        });
        yield* sql`UPDATE provider_session_runtime SET runtime_payload_json=${runtime} WHERE thread_id=${proposalThread}`;
        yield* sql`UPDATE projection_threads SET model_selection_json=${draft} WHERE thread_id=${proposalThread}`;
        h.workspaceCatalogs.set(workspace, {
          ...h.catalog,
          models: [{ slug: boundModel, name: boundModel, isCustom: true, capabilities: null }],
        });
        const created = yield* h.service.projectProposalCreate(selectedProposal);
        expect(created.results[0]?.error).toBeNull();
        expect(created.results[0]?.agent?.model).toBe(boundModel);
        expect(created.results[0]?.agent).not.toHaveProperty("options");
        expect(h.creates[0]).not.toHaveProperty("options");
        expect(h.defaultCatalogReads).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "rejects proposal reasoning unavailable in its workspace before claiming creation",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const workspace = yield* proposalWorkspace();
        yield* bindProposalThread;
        yield* nativeProposal({});
        const h = yield* harness();
        const store = yield* makeMeerkatProjectAgentStore;
        const sql = yield* SqlClient.SqlClient;
        const selection = yield* encodeFixtureJson({
          instanceId,
          model,
          options: [{ id: "effort", value: "high" }],
        });
        yield* sql`UPDATE projection_threads SET model_selection_json=${selection} WHERE thread_id=${proposalThread}`;
        h.workspaceCatalogs.set(workspace, h.catalog);
        const result = yield* h.service.projectProposalCreate(selectedProposal);
        expect(result.results[0]?.error).toContain("this workspace's current Meerkat model");
        expect(yield* store.list(projectId)).toEqual([]);
        expect(h.creates).toEqual([]);
        expect(h.sends).toEqual([]);
        expect(h.defaultCatalogReads).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "checks real availability before setup, reserves Solo, and ignores archived setup bindings",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const h = yield* harness();
        expect(yield* h.service.projectProposal({ projectId, instanceId })).toMatchObject({
          available: true,
          sourceThreadId: null,
          isSourceThreadPersisted: false,
        });
        h.setProposalAvailable(false);
        expect((yield* h.service.projectProposal({ projectId, instanceId })).available).toBe(false);
        h.setProposalAvailable(true);
        yield* h.service.projectProposalSetup({
          projectId,
          instanceId,
          sourceThreadId: proposalThread,
        });
        expect(yield* h.service.projectProposal({ projectId })).toMatchObject({
          isSetupThread: true,
          isSourceThreadPersisted: false,
        });
        const sql = yield* SqlClient.SqlClient;
        const reserved =
          yield* sql`SELECT agent_ids_json FROM meerkat_thread_connections WHERE thread_id=${proposalThread}`;
        expect(reserved[0]?.agent_ids_json).toBe("[]");
        yield* bindProposalThread;
        expect(yield* h.service.projectProposal({ projectId })).toMatchObject({
          isSetupThread: true,
          isSourceThreadPersisted: true,
        });
        yield* sql`UPDATE projection_threads SET archived_at='archived' WHERE thread_id=${proposalThread}`;
        expect(yield* h.service.projectProposal({ projectId, instanceId })).toMatchObject({
          available: true,
          sourceThreadId: null,
          isSetupThread: false,
        });
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "uses only same-project successful native calls and invalidates a proposal when a newer call starts or fails",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* bindProposalThread;
        const h = yield* harness();
        yield* nativeProposal({});
        expect(
          (yield* h.service.projectProposal({ projectId, sourceThreadId: proposalThread })).proposal
            ?.proposalId,
        ).toBe("proposal-call");
        expect(
          (yield* Effect.flip(
            h.service.projectProposal({
              projectId: otherProjectId,
              sourceThreadId: proposalThread,
            }),
          )).message,
        ).toContain("active conversation");
        yield* nativeProposal({ sequence: 2, toolId: "new-call", pending: true });
        expect(
          (yield* h.service.projectProposal({ projectId, sourceThreadId: proposalThread })).status,
        ).toBe("pending");
        yield* nativeProposal({ sequence: 3 });
        expect(
          (yield* h.service.projectProposal({ projectId, sourceThreadId: proposalThread })).status,
        ).toBe("pending");
        yield* nativeProposal({ sequence: 4, toolId: "new-call", failed: true });
        expect(
          (yield* h.service.projectProposal({ projectId, sourceThreadId: proposalThread })).status,
        ).toBe("invalid");
        expect(
          (yield* Effect.flip(h.service.projectProposalCreate(selectedProposal))).message,
        ).toContain("latest successful");
        expect(h.creates).toHaveLength(0);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "creates the selected canonical assignment once and waits for that exact native study interaction",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* proposalWorkspace();
        yield* bindProposalThread;
        yield* nativeProposal({});
        const h = yield* harness();
        h.frames.push(studyFrame("study-1", "interaction_started"));
        const first = yield* h.service.projectProposalCreate(selectedProposal);
        const agent = first.results[0]!.agent!;
        expect(first.results[0]?.error).toBeNull();
        expect(agent.preparation?.status).toBe("studying");
        expect(agent.ownershipPaths).toEqual(["src"]);
        expect(h.sends).toHaveLength(1);
        const second = yield* h.service.projectProposalCreate(selectedProposal);
        expect(second.results[0]?.agent?.agentId).toBe(agent.agentId);
        expect(h.sends).toHaveLength(1);
        h.frames.push(studyFrame("another-interaction"));
        expect(
          (yield* h.service.projectTeam({ projectId })).projectAgents[0]?.preparation?.status,
        ).toBe("studying");
        h.frames.push(studyFrame("study-1"));
        expect(
          (yield* h.service.projectTeam({ projectId })).projectAgents[0]?.preparation?.status,
        ).toBe("ready");
        yield* h.service.projectAgentPrepare({ projectId, agentId: agent.agentId, retry: true });
        expect(h.sends).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "recovers a study terminal beyond recent history before retry and persists its completion",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* proposalWorkspace();
        yield* bindProposalThread;
        yield* nativeProposal({});
        const h = yield* harness();
        const created = yield* h.service.projectProposalCreate(selectedProposal);
        const agentId = created.results[0]!.agent!.agentId;
        h.setBusy(false);
        const laterFrames = Array.from({ length: 100 }, (_, index) => studyFrame(`later-${index}`));
        const calls: Array<string | undefined> = [];
        h.setActivityPage((input) => {
          calls.push(input.mode === "since" ? (input.after ?? "start") : "recent");
          if (input.mode !== "since")
            return {
              frames: laterFrames,
              exhausted: true,
              next_cursor: "opaque-latest",
              latest_cursor: "opaque-frontier",
            };
          expect(input.before).toBe("opaque-frontier");
          if (!input.after)
            return {
              frames: [studyFrame("unrelated")],
              exhausted: false,
              next_cursor: "opaque-older",
            };
          expect(input.after).toBe("opaque-older");
          return {
            frames: [studyFrame("study-1")],
            exhausted: false,
            next_cursor: "opaque-middle",
          };
        });
        const reopened = yield* h.reopen;
        const recovered = yield* reopened.projectAgentPrepare({ projectId, agentId, retry: true });
        expect(recovered.preparation?.status).toBe("ready");
        expect(recovered.preparation?.attempt).toBe(1);
        expect(calls).toEqual(["recent", "start", "opaque-older"]);
        const refreshed = yield* reopened.projectTeam({ projectId });
        expect(refreshed.projectAgents[0]?.preparation?.status).toBe("ready");
        expect(calls).toHaveLength(3);
        expect(h.sends).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "settles a study from its exact native work receipt when console completion has not projected",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* proposalWorkspace();
        yield* bindProposalThread;
        yield* nativeProposal({});
        const h = yield* harness();
        const created = yield* h.service.projectProposalCreate(selectedProposal);
        const agent = created.results[0]!.agent!;
        const saved = agent.preparation!;
        expect(saved.interactionId).toBe("study-1");
        h.setBusy(false);
        h.receipts.set(saved.requestId, {
          interaction_id: saved.interactionId!,
          identity: "core",
          session_id: "stable-session",
          input_frame_id: saved.inputFrameId!,
          cursor: "console:1",
          status: "delivered",
        });
        h.setWorkCompletion({
          interactionId: saved.interactionId!,
          status: "completed",
          timestampMs: 2,
        });
        // The old console projection cannot finish paginating. Exact native
        // finalization still settles the same request without replaying it.
        h.setActivityPage(() => ({ frames: [], exhausted: false, next_cursor: "stuck" }));
        const reopened = yield* h.reopen;
        const ready = yield* reopened.projectAgentPrepare({
          projectId,
          agentId: agent.agentId,
          retry: true,
        });
        expect(ready.preparation).toMatchObject({
          status: "ready",
          attempt: saved.attempt,
          requestId: saved.requestId,
          interactionId: saved.interactionId,
          inputFrameId: saved.inputFrameId,
          error: null,
        });
        expect(h.receiptReads.at(-1)?.requestId).toBe(saved.requestId);
        expect(h.sends).toHaveLength(1);
        h.receipts.clear();
        h.setWorkCompletion(undefined);
        const again = yield* h.reopen;
        expect(
          (yield* again.projectTeam({ projectId })).projectAgents[0]?.preparation?.status,
        ).toBe("ready");
        expect(h.sends).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "rechecks exact study completion when native work becomes idle after the history frontier",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* proposalWorkspace();
        yield* bindProposalThread;
        yield* nativeProposal({});
        const h = yield* harness();
        const created = yield* h.service.projectProposalCreate(selectedProposal);
        const saved = created.results[0]!.agent!.preparation!;
        h.receipts.set(saved.requestId, {
          interaction_id: saved.interactionId!,
          identity: "core",
          session_id: "stable-session",
          input_frame_id: saved.inputFrameId!,
          cursor: "console:1",
          status: "delivered",
        });
        h.frames.push(studyFrame("previous-study"));
        h.setWorkCompletion({
          interactionId: "previous-study",
          status: "completed",
          timestampMs: 1,
        });
        h.setActivityPage(() => ({
          frames: [...h.frames],
          exhausted: true,
          latest_cursor: h.frames.at(-1)!.cursor,
        }));
        h.setBusy(false);
        h.setWorkRead(() => {
          // Native finalization lands after both pages and the acceptance read,
          // while the status observation still carries the previous completion.
          h.frames.push({
            ...studyFrame(saved.interactionId!),
            cursor: "console:2",
            timestamp_ms: 2,
          });
          h.setWorkRead(undefined);
        });
        const readsBefore = h.activities.length;
        const team = yield* h.service.projectTeam({ projectId });
        expect(team.projectAgents[0]?.preparation).toMatchObject({
          status: "ready",
          attempt: saved.attempt,
          requestId: saved.requestId,
          interactionId: saved.interactionId,
          inputFrameId: saved.inputFrameId,
          error: null,
        });
        expect(h.activities.length - readsBefore).toBe(3);
        expect(h.sends).toHaveLength(1);
        const reopened = yield* h.reopen;
        expect(
          (yield* reopened.projectTeam({ projectId })).projectAgents[0]?.preparation?.status,
        ).toBe("ready");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "does not borrow another study or runtime-input completion and preserves uncertain delivery",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* proposalWorkspace();
        yield* bindProposalThread;
        yield* nativeProposal({});
        const h = yield* harness();
        const created = yield* h.service.projectProposalCreate(selectedProposal);
        const saved = created.results[0]!.agent!.preparation!;
        const acceptance = {
          interaction_id: saved.interactionId!,
          identity: "core",
          session_id: "stable-session",
          input_frame_id: saved.inputFrameId!,
          cursor: "console:1",
          status: "delivered" as const,
        };
        h.setBusy(false);
        const uncertain = Effect.gen(function* () {
          expect(
            (yield* h.service.projectTeam({ projectId })).projectAgents[0]?.preparation,
          ).toMatchObject({
            status: "uncertain",
            requestId: saved.requestId,
            interactionId: saved.interactionId,
            inputFrameId: saved.inputFrameId,
            attempt: 1,
          });
          expect(h.sends).toHaveLength(1);
        });
        h.setWorkCompletion({
          interactionId: saved.interactionId!,
          status: "completed",
          timestampMs: 2,
        });
        yield* uncertain;
        for (const invalid of [
          { ...acceptance, interaction_id: "another-study" },
          { ...acceptance, input_frame_id: "another-input-frame" },
          { ...acceptance, identity: "another-agent" },
          { ...acceptance, session_id: "replacement-session" },
        ]) {
          h.receipts.set(saved.requestId, invalid);
          yield* uncertain;
        }
        h.receipts.set(saved.requestId, acceptance);
        h.setWorkCompletion({
          interactionId: "another-study",
          status: "completed",
          timestampMs: 2,
        });
        yield* uncertain;
        h.setWorkCompletion({
          kind: "runtime_input",
          sessionId: "stable-session",
          inputId: "another-input",
          runId: "another-run",
          status: "completed",
          timestampMs: 2,
        });
        yield* uncertain;
        h.setWorkCompletion({
          interactionId: saved.interactionId!,
          status: "failed",
          timestampMs: 2,
        });
        yield* uncertain;
        h.frames.push(studyFrame(saved.interactionId!, "interaction_failed"));
        expect(
          (yield* h.service.projectTeam({ projectId })).projectAgents[0]?.preparation,
        ).toMatchObject({
          status: "failed",
          requestId: saved.requestId,
          interactionId: saved.interactionId,
          attempt: 1,
        });
        expect(h.sends).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "waits for an exact failure report and preserves receipt cancellation before timeline projection",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* proposalWorkspace();
        yield* bindProposalThread;
        yield* nativeProposal({});
        const h = yield* harness();
        const created = yield* h.service.projectProposalCreate(selectedProposal);
        const agent = created.results[0]!.agent!;
        const saved = agent.preparation!;
        const acceptance = {
          interaction_id: saved.interactionId!,
          identity: "core",
          session_id: "stable-session",
          input_frame_id: saved.inputFrameId!,
          cursor: "console:1",
          status: "delivered" as const,
        };
        h.receipts.set(saved.requestId, acceptance);
        h.setBusy(false);
        h.setWorkCompletion({
          interactionId: saved.interactionId!,
          status: "failed",
          timestampMs: 2,
        });
        expect(
          (yield* h.service.projectTeam({ projectId })).projectAgents[0]?.preparation,
        ).toMatchObject({
          status: "uncertain",
          requestId: saved.requestId,
          interactionId: saved.interactionId,
          inputFrameId: saved.inputFrameId,
          attempt: 1,
        });
        const reopened = yield* h.reopen;
        expect(
          (yield* Effect.flip(
            reopened.projectAgentPrepare({
              projectId,
              agentId: agent.agentId,
              retry: true,
            }),
          )).message,
        ).toContain("failure report is not available");
        expect(h.sends).toHaveLength(1);
        const cancelled = {
          ...studyFrame(saved.interactionId!, "interaction_failed"),
          session_id: "stable-session",
          payload: { error_report: { class: "cancelled" }, error: "Run was cancelled" },
        };
        h.receipts.set(saved.requestId, {
          ...acceptance,
          completion: { ...cancelled, interaction_id: "another-study" },
        });
        expect(
          (yield* reopened.projectTeam({ projectId })).projectAgents[0]?.preparation?.status,
        ).toBe("uncertain");
        // The exact receipt can expose its typed terminal before the paginated
        // timeline does. Preserve that cancellation without inventing a failure.
        h.receipts.set(saved.requestId, { ...acceptance, completion: cancelled });
        expect(h.frames).toHaveLength(0);
        expect(
          (yield* reopened.projectTeam({ projectId })).projectAgents[0]?.preparation,
        ).toMatchObject({
          status: "interrupted",
          requestId: saved.requestId,
          interactionId: saved.interactionId,
          inputFrameId: saved.inputFrameId,
          attempt: 1,
          error: "Run was cancelled",
        });
        h.receipts.clear();
        h.setWorkCompletion(undefined);
        const again = yield* h.reopen;
        expect(
          (yield* again.projectTeam({ projectId })).projectAgents[0]?.preparation?.status,
        ).toBe("interrupted");
        expect(h.sends).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("does not retry a study when native history pagination cannot make progress", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* proposalWorkspace();
      yield* bindProposalThread;
      yield* nativeProposal({});
      const h = yield* harness();
      const created = yield* h.service.projectProposalCreate(selectedProposal);
      const agentId = created.results[0]!.agent!.agentId;
      h.setBusy(false);
      const cursors: Array<string | undefined> = [];
      h.setActivityPage((input) => {
        cursors.push(input.after);
        return { frames: [studyFrame("unrelated")], exhausted: false, next_cursor: "stuck-cursor" };
      });
      expect(
        (yield* Effect.flip(h.service.projectAgentPrepare({ projectId, agentId, retry: true })))
          .message,
      ).toContain("could not be checked completely");
      expect(cursors).toEqual([undefined, undefined, "stuck-cursor"]);
      expect(h.sends).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "prevents candidate injection, path escapes and partial failure from creating unrelated domains",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const root = yield* proposalWorkspace();
        yield* Effect.promise(() =>
          NodeFSP.symlink(NodeOS.tmpdir(), NodePath.join(root, "escape")),
        );
        yield* bindProposalThread;
        yield* nativeProposal({ payload: proposalPayload(["src", "missing", "escape"]) });
        const h = yield* harness();
        expect(
          (yield* Effect.flip(
            h.service.projectProposalCreate({ ...selectedProposal, candidateIds: ["injected"] }),
          )).message,
        ).toContain("current native proposal");
        const created = yield* h.service.projectProposalCreate({
          ...selectedProposal,
          candidateIds: ["core", "quality", "guides"],
        });
        expect(created.results[0]?.agent?.role).toBe("core");
        expect(created.results[1]?.error).toContain("ENOENT");
        expect(created.results[2]?.error).toContain("escapes the project");
        expect(h.creates).toHaveLength(1);
        expect((yield* h.service.projectAgents({ projectId })).agents).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "does not replay uncertain dispatch after reopening and requires explicit retry with a new attempt",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* proposalWorkspace();
        yield* bindProposalThread;
        yield* nativeProposal({});
        const h = yield* harness();
        h.setFailSend(true);
        const first = yield* h.service.projectProposalCreate(selectedProposal);
        const agent = first.results[0]!.agent!;
        expect(agent.preparation?.status).toBe("uncertain");
        expect(agent.preparation?.attempt).toBe(1);
        const reopened = yield* h.reopen;
        yield* reopened.projectProposalCreate(selectedProposal);
        yield* reopened.projectAgentPrepare({ projectId, agentId: agent.agentId });
        expect(h.sends).toHaveLength(1);
        h.setFailSend(false);
        h.frames.push(studyFrame("study-2", "interaction_started"));
        const retried = yield* reopened.projectAgentPrepare({
          projectId,
          agentId: agent.agentId,
          retry: true,
        });
        expect(retried.preparation?.attempt).toBe(2);
        expect(retried.preparation?.interactionId).toBe("study-2");
        expect(h.sends).toHaveLength(2);
        h.frames.push(studyFrame("study-1"));
        expect(
          (yield* reopened.projectTeam({ projectId })).projectAgents[0]?.preparation?.status,
        ).toBe("studying");
        h.frames.push(studyFrame("study-2", "interaction_failed"));
        expect(
          (yield* reopened.projectTeam({ projectId })).projectAgents[0]?.preparation?.status,
        ).toBe("failed");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "revises an existing specialist without replacing its identity and starts a fresh study",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* proposalWorkspace();
        yield* bindProposalThread;
        yield* nativeProposal({});
        const h = yield* harness();
        h.frames.push(studyFrame("study-1"));
        const first = yield* h.service.projectProposalCreate(selectedProposal);
        expect(first.results[0]?.agent?.preparation?.status).toBe("ready");
        const originalRef = first.results[0]?.agent?.agentRef;
        h.setBusy(false);
        const changed = proposalPayload();
        changed.agents[0]!.charter = "A different charter that must never inherit an old study.";
        yield* nativeProposal({ sequence: 2, toolId: "replacement-call", payload: changed });
        const result = yield* h.service.projectProposalCreate({
          ...selectedProposal,
          proposalId: "replacement-call",
        });
        expect(result.results[0]?.error).toBeNull();
        expect(result.results[0]?.agent?.agentId).toBe(first.results[0]?.agent?.agentId);
        expect(result.results[0]?.agent?.agentRef).toBe(originalRef);
        expect(result.results[0]?.agent?.revisionVersion).toBe(2);
        expect(result.results[0]?.agent?.charter).toBe(changed.agents[0]!.charter);
        expect(result.results[0]?.agent?.preparation?.status).toBe("studying");
        expect(result.results[0]?.agent?.preparation?.interactionId).toBe("study-2");
        expect(h.revisions).toHaveLength(1);
        expect(h.creates).toHaveLength(1);
        expect(h.sends).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

it.effect(
  "rejects an old proposal while its source is running and derives the actual bound model",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* bindProposalThread;
      yield* nativeProposal({});
      const h = yield* harness();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE provider_session_runtime SET runtime_payload_json='{"activeTurnId":"refreshing","model":"anthropic:claude-haiku-4-5"}' WHERE thread_id=${proposalThread}`;
      expect(
        (yield* h.service.projectProposal({ projectId, sourceThreadId: proposalThread })).status,
      ).toBe("pending");
      expect(
        (yield* Effect.flip(h.service.projectProposalCreate(selectedProposal))).message,
      ).toContain("latest successful");
      yield* sql`UPDATE provider_session_runtime SET runtime_payload_json='{"model":"anthropic:claude-haiku-4-5"}' WHERE thread_id=${proposalThread}`;
      yield* sql`UPDATE projection_threads SET model_selection_json='{"instanceId":"other-instance","model":"wrong-provider-model"}' WHERE thread_id=${proposalThread}`;
      expect(
        yield* h.service.projectProposal({ projectId, sourceThreadId: proposalThread }),
      ).toMatchObject({ status: "ready", instanceId, model });
      yield* sql`INSERT INTO projection_turns(thread_id,state,requested_at,checkpoint_files_json) VALUES (${proposalThread},'pending','now','[]')`;
      expect(
        (yield* h.service.projectProposal({ projectId, sourceThreadId: proposalThread })).status,
      ).toBe("pending");
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "joins native completion to only its own started arguments using the run-scoped tool identity",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* bindProposalThread;
      const h = yield* harness();
      yield* nativeProposal({ sequence: 1, pending: true });
      yield* nativeProposal({ sequence: 2, omitArguments: true });
      expect(
        (yield* h.service.projectProposal({ projectId, sourceThreadId: proposalThread })).proposal
          ?.agents[0]?.role,
      ).toBe("core");
      yield* nativeProposal({ sequence: 3, runId: "different-run", omitArguments: true });
      expect(
        (yield* h.service.projectProposal({ projectId, sourceThreadId: proposalThread })).status,
      ).toBe("invalid");
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "blocks preparation retry on native busy or unavailable status even when health says ready",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* proposalWorkspace();
      yield* bindProposalThread;
      yield* nativeProposal({});
      const h = yield* harness();
      h.setFailSend(true);
      const created = yield* h.service.projectProposalCreate(selectedProposal);
      const agentId = created.results[0]!.agent!.agentId;
      h.setBusy(true);
      expect(
        (yield* Effect.flip(h.service.projectAgentPrepare({ projectId, agentId, retry: true })))
          .message,
      ).toContain("still busy");
      expect(h.sends).toHaveLength(1);
      h.setBusy(false);
      h.setBusyUnavailable(true);
      expect(
        (yield* Effect.flip(h.service.projectAgentPrepare({ projectId, agentId, retry: true })))
          .message,
      ).toContain("status unavailable");
      expect(h.sends).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "returns the saved definition after a native connection failure so preparation can be retried",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* proposalWorkspace();
      yield* bindProposalThread;
      yield* nativeProposal({});
      const h = yield* harness();
      h.setFailConnect(true);
      const created = yield* h.service.projectProposalCreate(selectedProposal);
      expect(created.results[0]?.error).toContain("Cannot restore native domain");
      expect(created.results[0]?.agent?.role).toBe("core");
      expect(created.results[0]?.agent?.preparation).toBeNull();
      expect(h.sends).toHaveLength(0);
      h.setFailConnect(false);
      const retried = yield* h.service.projectProposalCreate(selectedProposal);
      expect(retried.results[0]?.agent?.agentId).toBe(created.results[0]?.agent?.agentId);
      expect(retried.results[0]?.agent?.preparation?.attempt).toBe(1);
      expect(h.sends).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("classifies native cancellation from its typed failure report as interrupted", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* proposalWorkspace();
    yield* bindProposalThread;
    yield* nativeProposal({});
    const h = yield* harness();
    const result = yield* h.service.projectProposalCreate(selectedProposal);
    expect(result.results[0]?.agent?.preparation?.status).toBe("studying");
    h.frames.push({
      ...studyFrame("study-1", "interaction_failed"),
      payload: { error_report: { class: "cancelled" }, error: "Run was cancelled" },
    });
    expect(
      (yield* h.service.projectTeam({ projectId })).projectAgents[0]?.preparation?.status,
    ).toBe("interrupted");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "archiving selected specialists detaches them and later thread sends do not restore paused agents",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const h = yield* harness();
      const first = yield* h.service.projectAgentCreate(createInput);
      const second = yield* h.service.projectAgentCreate({
        ...createInput,
        requestId: "second",
        role: "reviewer",
        label: "Reviewer",
      });
      const third = yield* h.service.projectAgentCreate({
        ...createInput,
        requestId: "third",
        role: "builder",
        label: "Builder",
      });
      const threadId = ThreadId.make("archive-selected-thread");
      const input = { projectId, threadId, instanceId };
      yield* seedThread(threadId);
      const sourceMobId = `t3-${NodeCrypto.createHash("sha256").update(`${instanceId}:${threadId}`).digest("hex")}`;
      const record = h.native.get(h.creates[0]!.stateRoot)!.mobs[0]!.identities[0]!;
      const snapshot: MeerkatNativeTeamSnapshot = {
        observation: "loaded_runtimes",
        loaded: true,
        mobs: [
          {
            mobId: sourceMobId,
            label: "Thread",
            kind: "thread",
            consoleStatus: "ready",
            identities: [{ ...record, identity: "ingress" }],
          },
        ],
      };
      const path = yield* Path.Path;
      h.native.set(`/workspace/${projectId}`, snapshot);
      h.native.set(
        meerkatProjectStateRoot(path, "/provider-state", `/workspace/${projectId}`),
        snapshot,
      );
      yield* h.service.applyThreadConnections(input, true);
      expect((yield* h.service.threadConnections(input)).desiredAgentIds.toSorted()).toEqual(
        [first.agentId, second.agentId, third.agentId].toSorted(),
      );
      yield* h.service.peerConnectionSet({
        source: { kind: "project-agent", projectId, instanceId, agentId: first.agentId },
        target: { kind: "project-agent", projectId, instanceId, agentId: second.agentId },
        connected: true,
        requestId: "domain-pair",
      });
      for (const agent of [first, second])
        yield* h.service.projectAgentLifecycle({
          projectId,
          agentId: agent.agentId,
          action: "archive",
        });
      yield* h.service.projectAgentLifecycle({
        projectId,
        agentId: third.agentId,
        action: "disconnect",
      });
      const paused = yield* h.service.threadConnections(input);
      expect(paused.desiredAgentIds).toEqual([third.agentId]);
      expect(paused.connections[0]?.error).toContain("Paused");
      yield* h.service.threadConnectionsSet({
        ...input,
        agentIds: [third.agentId],
        requestId: "retain-paused",
      });
      const creates = h.creates.length;
      const reopened = yield* h.reopen;
      yield* reopened.applyThreadConnections(input, true);
      expect(h.creates).toHaveLength(creates);
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT desired FROM meerkat_peer_connections`).toEqual([{ desired: 0 }]);
      yield* reopened.projectAgentLifecycle({
        projectId,
        agentId: first.agentId,
        action: "unarchive",
      });
      expect((yield* reopened.threadConnections(input)).desiredAgentIds).toEqual([third.agentId]);
      const team = yield* reopened.projectTeam({ projectId });
      expect(
        team.projectAgents.find((agent) => agent.agentId === first.agentId)?.instructions,
      ).toBe(createInput.instructions);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "stages a busy responsibility revision, preserves state on native failure, and applies the same revision once idle",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* proposalWorkspace();
      yield* bindProposalThread;
      yield* nativeProposal({});
      const h = yield* harness();
      const first = (yield* h.service.projectProposalCreate({
        ...selectedProposal,
        accessMode: "full-access",
      })).results[0]!.agent!;
      expect(first.accessMode).toBe("full-access");
      const revision = {
        requestId: "revise-core",
        instructions: "Own the updated core boundaries and inspect current files before advice.",
        focus: "Updated core",
        charter: "Own core and tests",
        ownershipPaths: ["src", "tests"],
      };
      const pending = yield* h.service.projectAgentUpdate({
        projectId,
        agentId: first.agentId,
        revision,
      });
      expect(pending.instructions).toBe(first.instructions);
      expect(pending.pendingRevision?.instructions).toBe(revision.instructions);
      expect(pending.pendingRevision?.error).toContain("current work");
      expect(h.revisions).toHaveLength(0);
      h.setBusy(false);
      h.setFailRevision(true);
      const rejected = yield* h.service.projectAgentUpdate({
        projectId,
        agentId: first.agentId,
        applyPending: true,
      });
      expect(rejected.instructions).toBe(first.instructions);
      expect(rejected.pendingRevision?.revisionId).toBe(pending.pendingRevision?.revisionId);
      const reopened = yield* h.reopen;
      h.setFailRevision(false);
      const applied = yield* reopened.projectAgentUpdate({
        projectId,
        agentId: first.agentId,
        applyPending: true,
      });
      expect(applied.pendingRevision).toBeNull();
      expect(applied.instructions).toBe(revision.instructions);
      expect(applied.agentId).toBe(first.agentId);
      expect(applied.agentRef).toBe(first.agentRef);
      expect(applied.accessMode).toBe("full-access");
      expect(applied.preparation?.interactionId).toBe("study-2");
      expect(applied.revisionVersion).toBe(2);
      expect(h.creates).toHaveLength(1);
      expect(h.revisions).toHaveLength(1);
      const replay = yield* reopened.projectAgentUpdate({
        projectId,
        agentId: first.agentId,
        revision,
      });
      expect(replay.revisionVersion).toBe(2);
      expect(h.revisions).toHaveLength(1);
      expect(h.sends).toHaveLength(2);
      expect(h.revisions[0]?.instructions).toContain("Current project responsibility");
      expect(h.revisions[0]?.instructions).toContain("inspect the relevant current working files");
      const store = yield* makeMeerkatProjectAgentStore;
      yield* store.savePreparation(projectId, first.agentId, {
        ...first.preparation!,
        status: "ready",
      });
      expect(
        (yield* reopened.projectTeam({ projectId })).projectAgents[0]?.preparation?.interactionId,
      ).toBe("study-2");
      const sql = yield* SqlClient.SqlClient;
      expect(
        (yield* sql`SELECT * FROM meerkat_project_agent_revisions WHERE agent_id=${first.agentId}`)
          .length,
      ).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "refreshes a ready study with content evidence that changes for dirty working files and retains prior studies",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const root = yield* proposalWorkspace();
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "src", "core.ts"), "export const version = 1;\n"),
      );
      yield* bindProposalThread;
      yield* nativeProposal({});
      const h = yield* harness();
      h.frames.push(studyFrame("study-1"));
      const first = (yield* h.service.projectProposalCreate(selectedProposal)).results[0]!.agent!;
      expect(first.preparation?.status).toBe("ready");
      expect(first.preparation?.evidence?.fileCount).toBe(1);
      h.setBusy(false);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "src", "core.ts"), "export const version = 2;\n"),
      );
      const refreshed = yield* h.service.projectAgentPrepare({
        projectId,
        agentId: first.agentId,
        refresh: true,
      });
      expect(refreshed.preparation?.status).toBe("studying");
      expect(refreshed.preparation?.evidence?.contentFingerprint).not.toBe(
        first.preparation?.evidence?.contentFingerprint,
      );
      expect(refreshed.preparation?.interactionId).toBe("study-2");
      expect(refreshed.preparation?.attempt).toBe(2);
      expect(h.creates).toHaveLength(1);
      const sql = yield* SqlClient.SqlClient;
      expect(
        (yield* sql`SELECT * FROM meerkat_project_agent_studies WHERE agent_id=${first.agentId}`)
          .length,
      ).toBe(2);
      h.frames.push(studyFrame("study-2"));
      expect(
        (yield* h.service.projectTeam({ projectId })).projectAgents[0]?.preparation?.status,
      ).toBe("ready");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "revises shared responsibilities through native activation without studying the host checkout",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* proposalWorkspace();
      const h = yield* harness();
      const first = yield* h.service.projectAgentCreate({
        ...createInput,
        accessMode: "repository-read-only",
      });
      const input = {
        projectId,
        agentId: first.agentId,
        requestId: "shared-revision",
        instructions: "Use immutable revisions in the shared API project.",
      };
      h.setBusy(true);
      const pending = yield* h.service.projectAgentReviseShared(input);
      expect(pending.applied).toBe(false);
      expect(h.revisions).toHaveLength(0);
      expect(h.sends).toHaveLength(0);
      expect(h.preparations).toHaveLength(0);
      h.setBusy(false);
      const reopened = yield* h.reopen;
      const applied = yield* reopened.projectAgentReviseShared(input);
      expect(applied).toMatchObject({ applied: true, revisionId: pending.revisionId });
      expect(h.revisions).toHaveLength(1);
      expect(h.revisions[0]?.instructions).toContain(input.instructions);
      expect(h.revisions[0]?.instructions).not.toContain(
        "inspect the relevant current working files",
      );
      expect(h.sends).toHaveLength(0);
      expect(h.preparations).toHaveLength(0);
      expect(yield* reopened.projectAgentReviseShared(input)).toEqual(applied);
      expect(h.revisions).toHaveLength(1);
      const changed = yield* reopened
        .projectAgentReviseShared({ ...input, instructions: "A different immutable request" })
        .pipe(Effect.flip);
      expect(changed.message).toContain("different responsibilities");
      const sql = yield* SqlClient.SqlClient;
      expect(
        yield* sql`SELECT * FROM meerkat_project_agent_revisions WHERE agent_id=${first.agentId} AND revision_id=${applied.revisionId}`,
      ).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

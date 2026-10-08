// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { MEERKAT_REQUIRED_METHODS } from "@t3tools/shared/meerkatRuntime";
import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import {
  ProfileRestoreReview,
  RESTORE_REVIEW_MESSAGE,
  type RestoreReviewService,
} from "../../restoreReview.ts";
import { MeerkatCheckpointStoreService } from "../meerkat/MeerkatCheckpointStore.ts";
import { meerkatProjectStateRoot } from "../Layers/MeerkatAdapter.ts";
import * as GatewayClient from "../meerkat/MeerkatGatewayClient.ts";
import {
  MeerkatDriver,
  MeerkatDriverConfig,
  projectMeerkatModels,
  projectMeerkatSkills,
} from "./MeerkatDriver.ts";

const decodeConfig = Schema.decodeUnknownSync(MeerkatDriverConfig);

describe("MeerkatDriver restored-profile boundary", () => {
  effectIt.effect(
    "rejects new native work before transport and preserves receipt, history, and stop",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "meerkat-driver-restore-")),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
        );
        const calls: string[] = [];
        const stub = vi.spyOn(GatewayClient, "createMeerkatGatewayClient").mockReturnValue({
          pid: undefined,
          request: async (method) => {
            calls.push(method);
            return {};
          },
          subscribe: () => () => {},
          onClose: () => () => {},
          close: async () => {},
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => stub.mockRestore()));
        const restoreHold: RestoreReviewService = {
          held: true,
          status: () => ({
            status: "restart-required",
            restoreId: "restore",
            restoredAt: null,
            backupCreatedAt: null,
            message: RESTORE_REVIEW_MESSAGE,
          }),
          consent: async () => {
            throw new Error("Unused consent");
          },
        };
        yield* Effect.gen(function* () {
          const instance = yield* MeerkatDriver.create({
            instanceId: ProviderInstanceId.make("restore-test"),
            displayName: "Restore test",
            environment: [],
            enabled: false,
            config: { gatewayBinaryPath: "unused-mocked-gateway", projectPath: root },
          });
          for (const method of [
            "mobs.v1.consoleSend",
            "mobs.v1.consoleResume",
            "mobs.v1.createThreadMob",
            "mobs.v1.turnStart",
            "mobs.v1.createDomainMob",
            "mobs.v1.peerLocal",
            "mobs.v1.recoverThread",
            "questions.v1.answer",
            "approvals.v1.respond",
            "text.v1.generate",
            "future.v1.work",
          ]) {
            yield* Effect.promise(() =>
              expect(instance.meerkatControls!.request(method, {})).rejects.toMatchObject({
                kind: "restore_review_required",
                outcomeUnknown: false,
              }),
            );
          }
          expect(calls).toEqual([]);
          const passive = [
            "models.v1.catalog",
            "mobs.v1.teamSnapshot",
            "mobs.v1.consoleHistory",
            "mobs.v1.consoleReceipt",
            "mobs.v1.consoleStop",
            "mobs.v1.coordinatorStop",
          ];
          for (const method of passive)
            yield* Effect.promise(() => instance.meerkatControls!.request(method, {}));
          expect(calls).toEqual(passive);
        }).pipe(
          Effect.provideService(ProfileRestoreReview, restoreHold),
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(MeerkatCheckpointStoreService)({}),
              ServerConfig.layerTest(root, root).pipe(Layer.provideMerge(NodeServices.layer)),
            ),
          ),
        );
      }).pipe(Effect.scoped),
  );
});

describe("MeerkatDriver shutdown", () => {
  for (const fails of [false, true]) {
    effectIt.effect(`retains cleanup outcome and diagnostics when failure=${fails}`, () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "meerkat-driver-close-")),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
        );
        const details = { cleanupCompleted: false, errors: ["native drain failed for fixture"] };
        const error = new GatewayClient.MeerkatGatewayTransportError(
          "cleanup_failed",
          "Meerkat native cleanup did not complete.",
          false,
          details,
        );
        const close = vi.fn(async () => {
          if (fails) throw error;
        });
        const stub = vi.spyOn(GatewayClient, "createMeerkatGatewayClient").mockReturnValue({
          pid: undefined,
          request: vi.fn(async () => ({})),
          subscribe: () => () => {},
          onClose: () => () => {},
          close,
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => stub.mockRestore()));
        const messages: Array<unknown> = [];
        const logger = Logger.make<unknown, void>(({ message }) => {
          messages.push(message);
        });
        let siblingCloses = 0;
        const result = yield* Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              siblingCloses += 1;
            }),
          );
          yield* MeerkatDriver.create({
            instanceId: ProviderInstanceId.make("meerkat-close-test"),
            displayName: "Meerkat cleanup test",
            environment: [],
            enabled: false,
            config: { gatewayBinaryPath: "unused-mocked-gateway", projectPath: root },
          });
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(MeerkatCheckpointStoreService)({}),
              ServerConfig.layerTest(root, root).pipe(Layer.provideMerge(NodeServices.layer)),
              Logger.layer([logger], { mergeWithExisting: false }),
            ),
          ),
          Effect.exit,
        );
        expect(close).toHaveBeenCalledTimes(1);
        expect(siblingCloses).toBe(1);
        if (fails) {
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            expect(
              result.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect),
            ).toContain(error);
          }
          expect(messages).toEqual([
            [
              "Meerkat gateway shutdown failed",
              {
                instanceId: "meerkat-close-test",
                driver: "meerkat",
                failures: [{ kind: "cleanup_failed", outcomeUnknown: false, details }],
              },
            ],
          ]);
        } else {
          expect(Exit.isSuccess(result)).toBe(true);
          expect(messages).toEqual([]);
        }
      }).pipe(Effect.scoped),
    );
  }
});

describe("MeerkatDriver catalog", () => {
  const nativeCatalog = {
    catalog: {
      providers: [
        {
          provider: "anthropic",
          default_model_id: "claude-opus-5-5",
          models: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }],
        },
        {
          provider: "openai",
          default_model_id: "gpt-6-astra",
          models: [
            { id: "gpt-5.6", display_name: "GPT-5.6 Sol" },
            { id: "gpt-5.6-sol", display_name: "GPT-5.6 Sol" },
            { id: "gpt-6-astra", display_name: "GPT-6 Astra" },
          ],
        },
        {
          provider: "self_hosted",
          default_model_id: "local-model",
          models: [{ id: "local-model", display_name: "Local model", tier: "custom" }],
        },
      ],
    },
  };
  const connection = (
    provider: string,
    state: "connected" | "needs_auth" | "reauth_required" | "host_managed",
  ) => ({
    provider,
    displayName: provider,
    realmId: "env_default",
    bindingId: "default",
    profileId: "default",
    source: "env",
    state,
    supportsInteractiveLogin: false,
  });

  for (const failDefault of [false, true])
    effectIt.effect(
      `discovers project accounts independently when default project fails=${failDefault}`,
      () =>
        Effect.gen(function* () {
          const root = yield* Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "meerkat-project-auth-")),
          );
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
          );
          const projectA = NodePath.join(root, "project-a");
          const projectB = NodePath.join(root, "project-b");
          const stateRoot = NodePath.join(root, "native-state");
          const scopedCalls: Array<{
            method: string;
            projectPath: unknown;
            configStateRoot: unknown;
          }> = [];
          const stub = vi.spyOn(GatewayClient, "createMeerkatGatewayClient").mockReturnValue({
            pid: undefined,
            request: async (method, params) => {
              if (method === "system.v1.health")
                return {
                  ok: true,
                  runtime: "mobkit",
                  build: {
                    gatewayVersion: "0.1.0",
                    meerkatVersion: "0.8.50",
                    mobkitVersion: "0.8.50",
                    cargoLockSha256: "a".repeat(64),
                    platform: "macos",
                    arch: "aarch64",
                  },
                };
              if (method === "system.v1.capabilities")
                return {
                  contractVersion: "pure-mobkit-runtime-v1",
                  methods: MEERKAT_REQUIRED_METHODS,
                };
              scopedCalls.push({
                method,
                projectPath: params?.projectPath,
                configStateRoot: params?.configStateRoot,
              });
              const model =
                params?.projectPath === projectA ? "project-a-model" : "project-b-model";
              if (failDefault && method === "models.v1.catalog" && params?.projectPath === projectA)
                throw new Error("Project A configuration is invalid.");
              if (method === "models.v1.catalog")
                return {
                  catalog: {
                    providers: [
                      { provider: "openai", default_model_id: model, models: [{ id: model }] },
                    ],
                  },
                };
              if (method === "skills.v1.list") return { skills: [] };
              if (method === "auth.v1.status")
                return {
                  connections: [
                    connection(
                      "openai",
                      params?.projectPath === projectA ? "needs_auth" : "connected",
                    ),
                  ],
                };
              throw new Error(`Unexpected native method: ${method}`);
            },
            subscribe: () => () => {},
            onClose: () => () => {},
            close: async () => {},
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => stub.mockRestore()));
          yield* Effect.gen(function* () {
            const path = yield* Path.Path;
            const instance = yield* MeerkatDriver.create({
              instanceId: ProviderInstanceId.make("project-auth-test"),
              displayName: undefined,
              environment: [],
              enabled: true,
              config: {
                gatewayBinaryPath: "unused-mocked-gateway",
                projectPath: projectA,
                stateRoot,
              },
            });
            const defaultSnapshot = yield* instance.snapshot.getSnapshot;
            const projectSnapshot = yield* instance.snapshotForCwd!(projectB);
            expect(defaultSnapshot.supportsWorkspaceReadiness).toBe(true);
            expect(defaultSnapshot.supportsThreadAuthScope).toBe(true);
            expect(defaultSnapshot.installed).toBe(true);
            expect(defaultSnapshot.version).toBe("0.8.50 / MobKit 0.8.50");
            expect(defaultSnapshot.status).toBe(failDefault ? "error" : "warning");
            expect(defaultSnapshot.auth.status).toBe(failDefault ? "unknown" : "unauthenticated");
            expect(
              defaultSnapshot.models.map((model) => [model.slug, model.credentialState]),
            ).toEqual(failDefault ? [] : [["openai:project-a-model", "needs_auth"]]);
            expect(projectSnapshot.auth.status).toBe("authenticated");
            expect(
              projectSnapshot.models.map((model) => [model.slug, model.credentialState]),
            ).toEqual([["openai:project-b-model", "connected"]]);
            expect(yield* instance.snapshot.getSnapshot).toEqual(defaultSnapshot);
            expect(scopedCalls).toEqual(
              [projectA, projectB].flatMap((projectPath) =>
                (failDefault && projectPath === projectA
                  ? ["models.v1.catalog"]
                  : ["models.v1.catalog", "skills.v1.list", "auth.v1.status"]
                ).map((method) => ({
                  method,
                  projectPath,
                  configStateRoot: meerkatProjectStateRoot(path, stateRoot, projectPath),
                })),
              ),
            );
          }).pipe(
            Effect.provide(
              Layer.merge(
                Layer.mock(MeerkatCheckpointStoreService)({}),
                ServerConfig.layerTest(root, root).pipe(Layer.provideMerge(NodeServices.layer)),
              ),
            ),
          );
        }).pipe(Effect.scoped),
    );

  it("preserves native source identity for skills with the same name", () => {
    const result = projectMeerkatSkills({
      skills: ["b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64", "4fa3e1a2-5b6c-47d8-9012-3456789abcde"].map(
        (source) => ({
          key: { source_uuid: source, skill_name: "review" },
          name: "review",
          description: "Review code",
          scope: "project",
          sourceName: source,
        }),
      ),
    });
    expect(result.map((skill) => skill.path)).toEqual([
      "meerkat-skill://b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64/review",
      "meerkat-skill://4fa3e1a2-5b6c-47d8-9012-3456789abcde/review",
    ]);
  });
  for (const { fail, needsAuth, held } of [
    { fail: false, needsAuth: false, held: false },
    { fail: true, needsAuth: false, held: false },
    { fail: false, needsAuth: true, held: false },
    { fail: false, needsAuth: false, held: true },
    { fail: false, needsAuth: true, held: true },
  ]) {
    effectIt.effect(
      `reads discovery with policy failure=${fail}, missing credentials=${needsAuth}, restore held=${held}`,
      () =>
        Effect.gen(function* () {
          const root = yield* Effect.promise(async () =>
            NodeFSP.realpath(
              await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "meerkat-driver-policy-")),
            ),
          );
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
          );
          const request = vi.fn<GatewayClient.MeerkatGatewayClient["request"]>(
            async (method, params) => {
              if (method === "system.v1.projectRuntimeInfo") {
                if (fail) throw new Error("Private workspace preparation denied");
                const stateRoot = String(params?.stateRoot);
                await NodeFSP.mkdir(stateRoot, { recursive: true });
                return { host: { placement: "local", stateRoot, realmId: "ws-native-driver" } };
              }
              if (method === "models.v1.catalog") {
                const policyFile = NodePath.join(
                  String(params?.configStateRoot),
                  "ws-native-driver",
                  "config.toml",
                );
                if (held) {
                  await expect(NodeFSP.readFile(policyFile, "utf8")).rejects.toMatchObject({
                    code: "ENOENT",
                  });
                } else {
                  expect(await NodeFSP.readFile(policyFile, "utf8")).toBe(
                    "[model_fallback]\nenabled = false\n",
                  );
                }
                return nativeCatalog;
              }
              if (method === "system.v1.health")
                return {
                  ok: true,
                  runtime: "mobkit",
                  build: {
                    gatewayVersion: "0.1.0",
                    meerkatVersion: "0.8.42",
                    mobkitVersion: "0.8.42",
                    cargoLockSha256: "a".repeat(64),
                    platform: "macos",
                    arch: "aarch64",
                  },
                };
              if (method === "system.v1.capabilities")
                return {
                  contractVersion: "pure-mobkit-runtime-v1",
                  methods: MEERKAT_REQUIRED_METHODS,
                };
              if (method === "skills.v1.list")
                return {
                  skills: [
                    {
                      key: { source_uuid: "source", skill_name: "local-proof" },
                      name: "Native skill",
                      description: "Configured skill",
                      scope: "project",
                      sourceName: "project",
                    },
                  ],
                };
              if (method === "auth.v1.status")
                return {
                  connections: [
                    connection("anthropic", "needs_auth"),
                    connection("openai", needsAuth ? "needs_auth" : "connected"),
                  ],
                };
              return {};
            },
          );
          const stub = vi.spyOn(GatewayClient, "createMeerkatGatewayClient").mockReturnValue({
            pid: undefined,
            request,
            subscribe: () => () => {},
            onClose: () => () => {},
            close: async () => {},
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => stub.mockRestore()));
          const snapshot = yield* Effect.gen(function* () {
            const instance = yield* MeerkatDriver.create({
              instanceId: ProviderInstanceId.make("meerkat-policy-test"),
              displayName: "Meerkat policy test",
              environment: [],
              enabled: true,
              config: {
                gatewayBinaryPath: "unused-mocked-gateway",
                projectPath: root,
                stateRoot: NodePath.join(root, "state"),
                workspacePolicy: "selected-model-only",
              },
            });
            return yield* instance.snapshot.getSnapshot;
          }).pipe(
            Effect.provideService(
              ProfileRestoreReview,
              held
                ? {
                    held: true,
                    status: () => ({
                      status: "required",
                      restoreId: "restore",
                      restoredAt: null,
                      backupCreatedAt: null,
                      message: RESTORE_REVIEW_MESSAGE,
                    }),
                    consent: async () => {
                      throw new Error("Unused consent");
                    },
                  }
                : undefined,
            ),
            Effect.provide(
              Layer.merge(
                Layer.mock(MeerkatCheckpointStoreService)({}),
                ServerConfig.layerTest(root, root).pipe(Layer.provideMerge(NodeServices.layer)),
              ),
            ),
          );
          expect(snapshot.status).toBe(fail ? "error" : needsAuth ? "warning" : "ready");
          if (!fail) {
            expect(snapshot.skills[0]?.name).toBe("Native skill");
            expect(
              snapshot.models.filter((model) => model.isDefault).map((model) => model.slug),
            ).toEqual(
              needsAuth
                ? ["anthropic:claude-opus-5-5", "openai:gpt-6-astra", "self_hosted:local-model"]
                : ["openai:gpt-6-astra"],
            );
          }
          if (needsAuth) {
            expect(snapshot.auth.status).toBe("unauthenticated");
            expect(snapshot.auth.label).toBe("Connect a model account in Settings > Providers");
            expect(snapshot.message).toContain("API key");
            expect(snapshot.message).toContain("OAuth profiles");
          }
          expect(request.mock.calls.map(([method]) => method)).toEqual(
            fail
              ? ["system.v1.health", "system.v1.capabilities", "system.v1.projectRuntimeInfo"]
              : [
                  "system.v1.health",
                  "system.v1.capabilities",
                  ...(held ? [] : ["system.v1.projectRuntimeInfo"]),
                  "models.v1.catalog",
                  "skills.v1.list",
                  "auth.v1.status",
                ],
          );
        }).pipe(Effect.scoped),
    );
  }

  it("keeps native aliases selectable and distinguishes their labels by exact identity", () => {
    const models = projectMeerkatModels(nativeCatalog);
    expect(models.map((model) => [model.slug, model.name])).toEqual([
      ["anthropic:claude-opus-5-5", "Claude Opus 5.5"],
      ["openai:gpt-5.6", "[openai:gpt-5.6] GPT-5.6 Sol"],
      ["openai:gpt-5.6-sol", "[openai:gpt-5.6-sol] GPT-5.6 Sol"],
      ["openai:gpt-6-astra", "GPT-6 Astra"],
      ["self_hosted:local-model", "Local model"],
    ]);
  });

  it("prefers a connected provider's published default without removing any model", () => {
    const unchanged = projectMeerkatModels(nativeCatalog);
    const connected = projectMeerkatModels(nativeCatalog, {
      connections: [connection("anthropic", "reauth_required"), connection("openai", "connected")],
    });
    expect(connected.filter((model) => model.isDefault).map((model) => model.slug)).toEqual([
      "openai:gpt-6-astra",
    ]);
    expect(
      connected.map(({ credentialState, ...model }) => ({ ...model, isDefault: false })),
    ).toEqual(unchanged.map(({ credentialState, ...model }) => ({ ...model, isDefault: false })));
  });

  it("preserves catalog defaults for absent, host-managed, and unmatched auth", () => {
    const unchanged = projectMeerkatModels(nativeCatalog);
    for (const connections of [
      [],
      [connection("self_hosted", "host_managed")],
      [connection("openai", "needs_auth")],
      [connection("not-in-catalog", "connected")],
    ]) {
      expect(
        projectMeerkatModels(nativeCatalog, { connections }).map(
          ({ credentialState, ...model }) => model,
        ),
      ).toEqual(unchanged.map(({ credentialState, ...model }) => model));
    }
    const noPublishedDefault = {
      catalog: {
        providers: nativeCatalog.catalog.providers.map((provider) =>
          provider.provider === "openai" ? { ...provider, default_model_id: "absent" } : provider,
        ),
      },
    };
    expect(
      projectMeerkatModels(noPublishedDefault, {
        connections: [connection("openai", "connected")],
      }).map(({ credentialState, ...model }) => model),
    ).toEqual(
      projectMeerkatModels(noPublishedDefault).map(({ credentialState, ...model }) => model),
    );
  });

  it("reports credentials for each underlying provider without blocking another usable binding", () => {
    const models = projectMeerkatModels(nativeCatalog, {
      connections: [
        connection("anthropic", "needs_auth"),
        connection("openai", "reauth_required"),
        connection("openai", "connected"),
        connection("self_hosted", "host_managed"),
      ],
    });
    expect(
      models
        .filter((model) => model.subProvider === "anthropic")
        .every((model) => model.credentialState === "needs_auth"),
    ).toBe(true);
    expect(
      models
        .filter((model) => model.subProvider === "openai")
        .every((model) => model.credentialState === "connected"),
    ).toBe(true);
    expect(models.find((model) => model.subProvider === "self_hosted")?.credentialState).toBe(
      "host_managed",
    );
    expect(
      projectMeerkatModels(nativeCatalog).every((model) => model.credentialState === "unknown"),
    ).toBe(true);
  });

  it("disambiguates equal display names across native providers without merging them", () => {
    expect(
      projectMeerkatModels({
        catalog: {
          providers: ["openai", "self_hosted"].map((provider) => ({
            provider,
            models: [{ id: "shared", display_name: "Shared model" }],
          })),
        },
      }).map((model) => [model.slug, model.name, model.shortName]),
    ).toEqual([
      ["openai:shared", "[openai:shared] Shared model", "Shared model"],
      ["self_hosted:shared", "[self_hosted:shared] Shared model", "Shared model"],
    ]);
  });

  it("uses the runtime catalog and keeps equal model ids from distinct providers separate", () => {
    expect(
      projectMeerkatModels({
        catalog: {
          providers: [
            {
              provider: "openai",
              default_model_id: "shared-model",
              models: [{ id: "shared-model", display_name: "Native model" }],
            },
            {
              provider: "anthropic",
              default_model_id: "other",
              models: [{ id: "shared-model", display_name: "Custom model", tier: "custom" }],
            },
          ],
        },
      }),
    ).toEqual([
      {
        slug: "openai:shared-model",
        name: "Native model",
        shortName: "Native model",
        subProvider: "openai",
        credentialState: "unknown",
        isDefault: true,
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "anthropic:shared-model",
        name: "Custom model",
        shortName: "Custom model",
        subProvider: "anthropic",
        credentialState: "unknown",
        isDefault: false,
        isCustom: true,
        capabilities: null,
      },
    ]);
  });
  it("rejects malformed catalog entries instead of inventing a fallback model", () => {
    expect(() =>
      projectMeerkatModels({
        catalog: { providers: [{ provider: "openai", models: [{ name: "unknown" }] }] },
      }),
    ).toThrow();
  });
  it("decodes configured gateway paths and uses a local executable default", () => {
    expect(decodeConfig({})).toEqual({
      gatewayBinaryPath: "meerkat-desktop-stdio",
    });
    expect(
      decodeConfig({
        gatewayBinaryPath: "/isolated/gateway",
        stateRoot: "/isolated/state",
        projectPath: "/workspace",
      }).gatewayBinaryPath,
    ).toBe("/isolated/gateway");
    expect(decodeConfig({ workspacePolicy: "selected-model-only" }).workspacePolicy).toBe(
      "selected-model-only",
    );
    expect(() => decodeConfig({ workspacePolicy: "automatic-fallback" })).toThrow();
  });
});

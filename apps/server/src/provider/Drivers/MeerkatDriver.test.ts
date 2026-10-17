// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { MEERKAT_REQUIRED_METHODS } from "@t3tools/shared/meerkatRuntime";
import { ProviderInstanceId, type MeerkatAuthConnection } from "@t3tools/contracts";
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
import { SharedToolHost } from "../../shared/SharedToolHost.ts";
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
  for (const withSharedHost of [false, true])
    effectIt.effect(
      `rejects new native work and preserves passive inspection with shared host=${withSharedHost}`,
      () =>
        Effect.gen(function* () {
          const root = yield* Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "meerkat-driver-restore-")),
          );
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
          );
          const calls: string[] = [];
          const sharedConfiguration = {
            url: "http://127.0.0.1:1234/native-tool",
            token: "fixture-private-host-token",
            actions: ["projects.list"],
          };
          const configured: unknown[] = [];
          const stub = vi.spyOn(GatewayClient, "createMeerkatGatewayClient").mockReturnValue({
            pid: undefined,
            request: async (method, params) => {
              calls.push(method);
              if (method === "sharedTools.v1.configure") configured.push(params);
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
              "sharedTools.v1.configure",
              "future.v1.work",
            ]) {
              yield* Effect.promise(() =>
                expect(instance.meerkatControls!.request(method, {})).rejects.toMatchObject({
                  kind: "restore_review_required",
                  outcomeUnknown: false,
                }),
              );
            }
            const setup = withSharedHost ? ["sharedTools.v1.configure"] : [];
            expect(calls).toEqual(setup);
            expect(configured).toEqual(withSharedHost ? [sharedConfiguration] : []);
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
            expect(calls).toEqual([...setup, ...passive]);
          }).pipe(
            Effect.provideService(ProfileRestoreReview, restoreHold),
            Effect.provideService(
              SharedToolHost,
              withSharedHost
                ? {
                    configuration: sharedConfiguration,
                    install: () => () => {},
                  }
                : undefined,
            ),
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
  const connection = (provider: string, state: MeerkatAuthConnection["state"]) => ({
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

  for (const { states, expectedAuth } of [
    { states: ["unknown"], expectedAuth: "unknown" },
    { states: ["unknown", "needs_auth"], expectedAuth: "unknown" },
    { states: ["needs_auth"], expectedAuth: "unauthenticated" },
    { states: ["reauth_required"], expectedAuth: "unauthenticated" },
  ] as const) {
    effectIt.effect(`projects saved account states ${states.join(", ")} as ${expectedAuth}`, () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "meerkat-saved-account-status-")),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
        );
        const stub = vi.spyOn(GatewayClient, "createMeerkatGatewayClient").mockReturnValue({
          pid: undefined,
          request: async (method) => {
            if (method === "system.v1.health")
              return {
                ok: true,
                runtime: "mobkit",
                build: {
                  gatewayVersion: "0.1.0",
                  meerkatVersion: "0.8.52",
                  mobkitVersion: "0.8.49",
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
            if (method === "models.v1.catalog") return nativeCatalog;
            if (method === "skills.v1.list") return { skills: [] };
            if (method === "auth.v1.status")
              return {
                connections: states.map((state, index) => ({
                  ...connection(index === 0 ? "openai" : "anthropic", state),
                  realmId: "global",
                  bindingId: `saved-${index}`,
                  profileId: `saved-${index}`,
                  source: "managed_store",
                  isDefault: true,
                  models: [],
                })),
              };
            throw new Error(`Unexpected native method: ${method}`);
          },
          subscribe: () => () => {},
          onClose: () => () => {},
          close: async () => {},
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => stub.mockRestore()));
        yield* Effect.gen(function* () {
          const instance = yield* MeerkatDriver.create({
            instanceId: ProviderInstanceId.make("saved-account-status-test"),
            displayName: undefined,
            environment: [],
            enabled: true,
            config: { gatewayBinaryPath: "unused-mocked-gateway", projectPath: root },
          });
          const snapshot = yield* instance.snapshot.getSnapshot;
          expect(snapshot.installed).toBe(true);
          expect(snapshot.status).toBe("warning");
          expect(snapshot.auth.status).toBe(expectedAuth);
          expect(snapshot.models.some((model) => model.credentialState === "connected")).toBe(
            false,
          );
          expect(snapshot.models.some((model) => model.subProvider === "openai")).toBe(false);
          if (expectedAuth === "unknown") {
            expect(snapshot.auth.label).toBe("Model account status is unverified");
            expect(snapshot.message).toBe(
              "Choose Check account in Settings > Providers to unlock saved credentials.",
            );
          } else {
            expect(snapshot.auth.label).toBe("Connect a model account in Settings > Providers");
            expect(snapshot.message).toBe(
              "Open Settings > Providers to sign in or add an API key.",
            );
          }
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
  }

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
  for (const { fail, needsAuth, held, accounts } of [
    { fail: false, needsAuth: false, held: false, accounts: "configured" },
    { fail: true, needsAuth: false, held: false, accounts: "configured" },
    { fail: false, needsAuth: true, held: false, accounts: "configured" },
    { fail: false, needsAuth: false, held: true, accounts: "configured" },
    { fail: false, needsAuth: true, held: true, accounts: "configured" },
    { fail: false, needsAuth: true, held: false, accounts: "empty" },
    { fail: false, needsAuth: false, held: false, accounts: "host" },
  ]) {
    effectIt.effect(
      `reads discovery with policy failure=${fail}, missing credentials=${needsAuth}, restore held=${held}, accounts=${accounts}`,
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
                  connections:
                    accounts === "empty"
                      ? []
                      : accounts === "host"
                        ? [connection("openai", "host_managed")]
                        : [
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
          expect(snapshot.status).toBe(
            fail ? "error" : needsAuth || accounts === "host" ? "warning" : "ready",
          );
          if (!fail) {
            expect(snapshot.skills[0]?.name).toBe("Native skill");
            expect(
              snapshot.models.filter((model) => model.isDefault).map((model) => model.slug),
            ).toEqual(
              needsAuth || accounts === "host"
                ? ["anthropic:claude-opus-5-5", "openai:gpt-6-astra", "self_hosted:local-model"]
                : ["openai:gpt-6-astra"],
            );
          }
          if (needsAuth) {
            expect(snapshot.auth.status).toBe("unauthenticated");
            expect(snapshot.auth.label).toBe("Connect a model account in Settings > Providers");
            expect(snapshot.message).toContain("API key");
            expect(snapshot.message).toContain("sign in");
          }
          if (accounts === "empty" || accounts === "host") {
            expect(snapshot.models.every((model) => model.credentialState !== "connected")).toBe(
              true,
            );
            if (accounts === "host") {
              expect(snapshot.auth.status).toBe("unknown");
              expect(snapshot.auth.label).toBe("Host-managed model access is unverified");
              expect(snapshot.message).toContain("Check host-managed credentials");
            }
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

  it("keeps native aliases selectable without putting routing identifiers in human names", () => {
    const models = projectMeerkatModels(nativeCatalog);
    expect(models.map((model) => [model.slug, model.name])).toEqual([
      ["anthropic:claude-opus-5-5", "Claude Opus 5.5"],
      ["openai:gpt-5.6", "GPT-5.6 Sol"],
      ["openai:gpt-5.6-sol", "GPT-5.6 Sol"],
      ["openai:gpt-6-astra", "GPT-6 Astra"],
      ["self_hosted:local-model", "Local model"],
    ]);
  });

  it("passes recognized native tiers without inferring recommendations from defaults or names", () => {
    const models = projectMeerkatModels({
      catalog: {
        providers: [
          {
            provider: "openai",
            default_model_id: "unknown-tier",
            models: [
              { id: "recommended-model", tier: "recommended" },
              { id: "supported-model", tier: "supported" },
              { id: "custom-model", tier: "custom" },
              { id: "unknown-tier", display_name: "Recommended", tier: "premium" },
              { id: "no-tier" },
            ],
          },
        ],
      },
    });
    expect(models.map((model) => model.catalogTier)).toEqual([
      "recommended",
      "supported",
      "custom",
      undefined,
      undefined,
    ]);
    expect(models[3]).not.toHaveProperty("catalogTier");
    expect(models[4]).not.toHaveProperty("catalogTier");
  });

  it("labels native Copilot offerings with the connected account while retaining exact execution routes", () => {
    const offerings = [
      { provider: "anthropic", id: "claude-fable-5", display_name: "Claude Fable 5" },
      { provider: "openai", id: "gpt-6-astra", display_name: "GPT-6 Astra" },
      { provider: "gemini", id: "gemini-3.5-pro", display_name: "Gemini 3.5 Pro" },
    ];
    const models = projectMeerkatModels(
      {
        catalog: {
          providers: offerings.map((offering) => ({
            provider: offering.provider,
            models: [{ id: offering.id, display_name: offering.display_name }],
          })),
        },
      },
      {
        methods: [
          {
            id: "github-copilot",
            provider: "copilot",
            displayName: "GitHub Copilot",
            authMethod: "github_copilot_oauth",
            backendKind: "copilot",
            flow: "device",
            description: "Sign in",
            fields: [],
          },
        ],
        connections: offerings.flatMap((offering) => [
          {
            ...connection(offering.provider, "connected"),
            displayName: `GitHub Copilot (${offering.provider})`,
            authMethod: "github_copilot_oauth",
            backendKind: "copilot",
            bindingId: `copilot-${offering.provider}`,
            accountLabel: "King",
            isDefault: true,
            modelsVerified: true,
            models: [
              {
                id: offering.id,
                displayName: offering.display_name,
                tier: "supported",
                recommended: false,
              },
            ],
          },
          {
            ...connection(offering.provider, "connected"),
            displayName: "Different account",
            accountLabel: "Personal",
            isDefault: false,
          },
        ]),
      },
    );
    expect(
      models.map(({ slug, name, accountLabel, subProvider }) => ({
        slug,
        name,
        accountLabel,
        subProvider,
      })),
    ).toEqual(
      offerings.map((offering) => ({
        slug: `${offering.provider}:${offering.id}`,
        name: offering.display_name,
        accountLabel: "GitHub Copilot · King",
        subProvider: offering.provider,
      })),
    );
    expect(models.every((model) => model.credentialState === "connected")).toBe(true);
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
      connected.map(
        ({ credentialState: _credentialState, accountLabel: _accountLabel, ...model }) => ({
          ...model,
          isDefault: false,
        }),
      ),
    ).toEqual(
      unchanged.map(
        ({ credentialState: _credentialState, accountLabel: _accountLabel, ...model }) => ({
          ...model,
          isDefault: false,
        }),
      ),
    );
  });

  it("uses connected account model catalogs and the native default account", () => {
    const models = projectMeerkatModels(nativeCatalog, {
      connections: [
        { ...connection("anthropic", "connected"), models: [], modelsVerified: false },
        {
          ...connection("openai", "connected"),
          isDefault: true,
          modelsVerified: true,
          models: [
            { id: "gpt-6-astra", displayName: "GPT-6 Astra", tier: "flagship", recommended: true },
          ],
        },
      ],
    });
    expect(
      models.filter((model) => model.credentialState === "connected").map((model) => model.slug),
    ).toEqual(["openai:gpt-6-astra"]);
    expect(models.filter((model) => model.isDefault).map((model) => model.slug)).toEqual([
      "openai:gpt-6-astra",
    ]);
    expect(models.some((model) => model.slug === "self_hosted:local-model")).toBe(true);
  });

  it("exposes only the executing default binding and changes catalogs when that account changes", () => {
    const account = (bindingId: string, isDefault: boolean, model: string) => ({
      ...connection("openai", "connected"),
      bindingId,
      profileId: bindingId,
      isDefault,
      models: [{ id: model, displayName: model, tier: "standard", recommended: true }],
    });
    for (const defaultBinding of ["api", "copilot"] as const) {
      const models = projectMeerkatModels(nativeCatalog, {
        connections: [
          account("api", defaultBinding === "api", "gpt-6-astra"),
          account("copilot", defaultBinding === "copilot", "gpt-5.6-sol"),
        ],
      });
      expect(
        models
          .filter((model) => model.subProvider === "openai")
          .map((model) => [model.slug, model.credentialState]),
      ).toEqual([
        [defaultBinding === "api" ? "openai:gpt-6-astra" : "openai:gpt-5.6-sol", "connected"],
      ]);
    }
    const disconnectedDefault = projectMeerkatModels(nativeCatalog, {
      connections: [
        { ...account("api", true, "gpt-6-astra"), state: "needs_auth" },
        account("copilot", false, "gpt-5.6-sol"),
      ],
    });
    expect(disconnectedDefault.some((model) => model.subProvider === "openai")).toBe(false);
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
          ({ credentialState: _credentialState, accountLabel: _accountLabel, ...model }) => model,
        ),
      ).toEqual(
        unchanged.map(
          ({ credentialState: _credentialState, accountLabel: _accountLabel, ...model }) => model,
        ),
      );
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
      }).map(
        ({ credentialState: _credentialState, accountLabel: _accountLabel, ...model }) => model,
      ),
    ).toEqual(
      projectMeerkatModels(noPublishedDefault).map(
        ({ credentialState: _credentialState, accountLabel: _accountLabel, ...model }) => model,
      ),
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

  it("preserves equal display names and distinct routing identities without merging them", () => {
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
      ["openai:shared", "Shared model", "Shared model"],
      ["self_hosted:shared", "Shared model", "Shared model"],
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
        catalogTier: "custom",
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

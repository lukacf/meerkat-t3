// @effect-diagnostics nodeBuiltinImport:off - native runtime paths are resolved at the provider boundary.
import * as NodeURL from "node:url";
import { meerkatSkillHref } from "@t3tools/shared/meerkatSkills";
import {
  assertMeerkatBundleBuild,
  resolveMeerkatRuntime,
  validateMeerkatHealth,
} from "@t3tools/shared/meerkatRuntime";
import {
  ProviderDriverKind,
  MeerkatAuthOverview,
  TrimmedNonEmptyString,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import {
  ProfileRestoreReview,
  nativeMethodAllowedDuringRestoreReview,
} from "../../restoreReview.ts";
import { ProviderDriverError } from "../Errors.ts";
import { meerkatProjectStateRoot, makeMeerkatAdapter } from "../Layers/MeerkatAdapter.ts";
import {
  createMeerkatGatewayClient,
  MeerkatGatewayTransportError,
} from "../meerkat/MeerkatGatewayClient.ts";
import { makeMeerkatTextGeneration } from "../meerkat/MeerkatTextGeneration.ts";
import { makeMeerkatTeamReader } from "../meerkat/MeerkatTeamReader.ts";
import { projectMeerkatCapabilities } from "../meerkat/MeerkatModelOptions.ts";
import {
  createMeerkatWorkspacePreparer,
  MeerkatWorkspacePolicy,
} from "../meerkat/MeerkatWorkspacePolicy.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

export const MEERKAT_DRIVER_KIND = ProviderDriverKind.make("meerkat");

export const MeerkatDriverConfig = Schema.Struct({
  gatewayBinaryPath: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed("meerkat-desktop-stdio")),
  ),
  stateRoot: Schema.optional(TrimmedNonEmptyString),
  projectPath: Schema.optional(TrimmedNonEmptyString),
  workspacePolicy: Schema.optional(MeerkatWorkspacePolicy),
});
export type MeerkatDriverConfig = typeof MeerkatDriverConfig.Type;

const CatalogResponse = Schema.Struct({
  catalog: Schema.Struct({
    providers: Schema.Array(
      Schema.Struct({
        provider: TrimmedNonEmptyString,
        default_model_id: Schema.optional(Schema.NullOr(Schema.String)),
        models: Schema.Array(
          Schema.Struct({
            id: TrimmedNonEmptyString,
            display_name: Schema.optional(Schema.String),
            tier: Schema.optional(Schema.String),
            profile: Schema.optional(
              Schema.NullOr(Schema.Struct({ params_schema: Schema.Unknown })),
            ),
          }),
        ),
      }),
    ),
  }),
});

const decodeAuthOverview = Schema.decodeUnknownSync(MeerkatAuthOverview);
const decodeCatalogResponse = Schema.decodeUnknownSync(CatalogResponse);

/** Provider qualification preserves distinct configured providers with the same model id. */
export function projectMeerkatModels(
  value: unknown,
  auth?: typeof MeerkatAuthOverview.Type,
): ReadonlyArray<ServerProviderModel> {
  const response = decodeCatalogResponse(value);
  // The runtime resolves provider:model through the native default binding.
  // A different connected account cannot make that binding's models usable.
  const accountProviders = new Set(
    auth?.connections
      .filter((connection) => connection.isDefault !== undefined)
      .map((connection) => connection.provider),
  );
  const activeConnections =
    auth?.connections.filter(
      (connection) => !accountProviders.has(connection.provider) || connection.isDefault === true,
    ) ?? [];
  const accountModels = new Map<string, Set<string>>();
  for (const provider of accountProviders) accountModels.set(provider, new Set());
  for (const connection of activeConnections) {
    if (connection.state !== "connected" || connection.models === undefined) continue;
    const supported = accountModels.get(connection.provider) ?? new Set<string>();
    for (const model of connection.models) supported.add(model.id);
    accountModels.set(connection.provider, supported);
  }
  const connected = new Set(
    activeConnections
      .filter((connection) => connection.state === "connected")
      .map((connection) => connection.provider),
  );
  // Prefer an authenticated provider's native default for new selections. Unknown
  // or host-managed auth does not establish availability; preserve the catalog
  // defaults when no connected provider has a published default in this catalog.
  const defaultAccount = activeConnections.find(
    (connection) => connection.isDefault && connection.state === "connected",
  );
  const preferredProvider =
    defaultAccount?.provider ??
    response.catalog.providers.find(
      (provider) =>
        connected.has(provider.provider) &&
        provider.models.some((model) => model.id === provider.default_model_id),
    )?.provider;
  const accountLabels = new Map<string, Set<string>>();
  for (const connection of activeConnections) {
    const methods =
      auth?.methods?.filter(
        (method) =>
          method.backendKind === connection.backendKind &&
          method.authMethod === connection.authMethod,
      ) ?? [];
    const method =
      methods.find((method) => method.provider === connection.provider) ??
      (methods.length === 1 ? methods[0] : undefined);
    const service = method?.displayName ?? connection.displayName;
    const account = connection.accountLabel?.trim();
    const labels = accountLabels.get(connection.provider) ?? new Set<string>();
    labels.add(account && account !== service ? `${service} · ${account}` : service);
    accountLabels.set(connection.provider, labels);
  }
  return response.catalog.providers.flatMap((provider) =>
    provider.models
      .filter(
        (model) =>
          !accountModels.has(provider.provider) ||
          accountModels.get(provider.provider)!.has(model.id),
      )
      .map((model) => {
        const slug = `${provider.provider}:${model.id}`;
        const name = model.display_name?.trim() || model.id;
        return {
          slug,
          name,
          shortName: name,
          subProvider: provider.provider,
          ...(accountLabels.get(provider.provider)?.size === 1
            ? { accountLabel: [...accountLabels.get(provider.provider)!][0]! }
            : {}),
          ...(model.tier === "recommended" || model.tier === "supported" || model.tier === "custom"
            ? { catalogTier: model.tier }
            : {}),
          credentialState: (() => {
            const states =
              activeConnections
                .filter((connection) => connection.provider === provider.provider)
                .map((connection) => connection.state) ?? [];
            // Multiple bindings may serve one provider. Do not let an unused,
            // expired binding hide a usable or host-managed one.
            return states.includes("connected")
              ? ("connected" as const)
              : states.includes("host_managed")
                ? ("host_managed" as const)
                : states.includes("reauth_required")
                  ? ("reauth_required" as const)
                  : states.includes("needs_auth")
                    ? ("needs_auth" as const)
                    : ("unknown" as const);
          })(),
          isCustom: model.tier === "custom",
          isDefault:
            model.id === provider.default_model_id &&
            (preferredProvider === undefined || provider.provider === preferredProvider),
          capabilities: projectMeerkatCapabilities(provider.provider, model.profile?.params_schema),
        };
      }),
  );
}

const SkillsResponse = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      key: Schema.Struct({ source_uuid: TrimmedNonEmptyString, skill_name: TrimmedNonEmptyString }),
      name: TrimmedNonEmptyString,
      description: Schema.String,
      scope: Schema.String,
      sourceName: Schema.String,
    }),
  ),
});
const decodeSkills = Schema.decodeUnknownSync(SkillsResponse);

export function projectMeerkatSkills(value: unknown): ReadonlyArray<ServerProviderSkill> {
  return decodeSkills(value).skills.map((skill) => ({
    name: skill.name,
    displayName: `${skill.name} (${skill.sourceName || skill.key.source_uuid.slice(0, 8)})`,
    ...(skill.description.trim() ? { description: skill.description.trim() } : {}),
    path: meerkatSkillHref(skill.key),
    scope: skill.scope,
    enabled: true,
  }));
}

export type MeerkatDriverEnv = ServerConfig | Path.Path | FileSystem.FileSystem;

export const MeerkatDriver: ProviderDriver<MeerkatDriverConfig, MeerkatDriverEnv> = {
  driverKind: MEERKAT_DRIVER_KIND,
  metadata: { displayName: "Model accounts", supportsMultipleInstances: false },
  configSchema: MeerkatDriverConfig,
  defaultConfig: () => ({ gatewayBinaryPath: "meerkat-desktop-stdio" }),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const path = yield* Path.Path;
      const projectPath = config.projectPath ?? serverConfig.cwd;
      const stateRoot = config.stateRoot ?? path.join(serverConfig.stateDir, "meerkat", instanceId);
      if (!path.isAbsolute(stateRoot)) {
        return yield* new ProviderDriverError({
          driver: MEERKAT_DRIVER_KIND,
          instanceId,
          detail: "Meerkat stateRoot must be an absolute NodePath.",
        });
      }
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: MEERKAT_DRIVER_KIND,
        instanceId,
      });
      const changes = yield* PubSub.unbounded<ServerProvider>();
      yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
      const runtime = yield* Effect.tryPromise({
        try: () =>
          resolveMeerkatRuntime({
            configuredBinary: config.gatewayBinaryPath,
            env: {
              ...mergeProviderInstanceEnvironment(environment),
              MEERKAT_APP_QUESTIONS: "1",
            },
            // Bundling flattens this module into dist/. Desktop supplies its unpacked resources path.
            bundledDirectory: NodeURL.fileURLToPath(new URL("./meerkat-runtime", import.meta.url)),
          }),
        catch: (cause) =>
          new ProviderDriverError({
            driver: MEERKAT_DRIVER_KIND,
            instanceId,
            detail: String(cause),
            cause,
          }),
      });
      const restoreReview = yield* ProfileRestoreReview;
      const nativeClient = createMeerkatGatewayClient({
        binaryPath: runtime.binaryPath,
        cwd: projectPath,
        env: runtime.env,
      });
      const client: typeof nativeClient = {
        ...nativeClient,
        request: (method, params, requestOptions) =>
          restoreReview?.held && !nativeMethodAllowedDuringRestoreReview(method)
            ? Promise.reject(
                new MeerkatGatewayTransportError(
                  "restore_review_required",
                  restoreReview.status().message,
                  false,
                ),
              )
            : nativeClient.request(method, params, requestOptions),
      };
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => client.close()).pipe(
          Effect.tapCause((cause) =>
            Effect.logError("Meerkat gateway shutdown failed", {
              instanceId,
              driver: MEERKAT_DRIVER_KIND,
              failures: cause.reasons.flatMap((reason) =>
                Cause.isDieReason(reason) && reason.defect instanceof MeerkatGatewayTransportError
                  ? [
                      {
                        kind: reason.defect.kind,
                        outcomeUnknown: reason.defect.outcomeUnknown,
                        details: reason.defect.details,
                      },
                    ]
                  : [],
              ),
            }),
          ),
        ),
      );
      const prepareWorkspace = createMeerkatWorkspacePreparer(client, config.workspacePolicy);
      const adapter = yield* makeMeerkatAdapter({
        client,
        instanceId,
        stateRoot,
        defaultCwd: projectPath,
        enabled,
        prepareWorkspace,
        attachmentsDir: serverConfig.attachmentsDir,
      });
      const baseSnapshot = (): ServerProvider => ({
        instanceId,
        driver: MEERKAT_DRIVER_KIND,
        displayName: displayName ?? "Model accounts",
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
        enabled,
        installed: false,
        version: null,
        status: enabled ? "warning" : "disabled",
        auth: { status: "unknown", label: "Checking accounts" },
        checkedAt: DateTime.formatIso(DateTime.nowUnsafe()),
        availability: "available",
        requiresNewThreadForModelChange: false,
        supportsConversationRollback: false,
        showInteractionModeToggle: false,
        supportsTextGeneration: true,
        supportsWorkspaceReadiness: true,
        supportsThreadAuthScope: true,
        setup: { canAuthenticate: false, canInstall: false },
        models: [],
        skills: [],
        slashCommands: [],
      });
      let current = baseSnapshot();
      const check = Effect.fn("MeerkatDriver.check")(function* (cwd: string) {
        if (!enabled) return baseSnapshot();
        let installation: Pick<ServerProvider, "installed" | "version"> | undefined;
        return yield* Effect.tryPromise({
          try: async () => {
            const identity = validateMeerkatHealth(
              await client.request("system.v1.health", {}),
              await client.request("system.v1.capabilities", {}),
            );
            if (runtime.manifest) assertMeerkatBundleBuild(identity, runtime.manifest);
            // A later project configuration failure does not undo successful
            // gateway discovery or prevent another project from being checked.
            installation = {
              installed: true,
              version: `${identity.meerkatVersion} / MobKit ${identity.mobkitVersion}`,
            };
            const configStateRoot = meerkatProjectStateRoot(path, stateRoot, cwd);
            if (!restoreReview?.held) await prepareWorkspace(cwd, configStateRoot);
            const catalog = await client.request("models.v1.catalog", {
              projectPath: cwd,
              configStateRoot,
            });
            const skills = projectMeerkatSkills(
              await client.request("skills.v1.list", { projectPath: cwd, configStateRoot }),
            );
            const auth = decodeAuthOverview(
              await client.request("auth.v1.status", { projectPath: cwd, configStateRoot }),
            );
            const connected = auth.connections.filter(
              (connection) => connection.state === "connected",
            );
            const unverifiedHost = auth.connections.some(
              (connection) => connection.state === "host_managed",
            );
            const unverifiedAccount = auth.connections.some(
              (connection) => connection.state === "unknown",
            );
            return {
              ...baseSnapshot(),
              auth: {
                status: connected.length
                  ? ("authenticated" as const)
                  : unverifiedHost || unverifiedAccount
                    ? ("unknown" as const)
                    : ("unauthenticated" as const),
                label: connected.length
                  ? connected.map((connection) => connection.displayName).join(", ")
                  : unverifiedAccount
                    ? "Model account status is unverified"
                    : unverifiedHost
                      ? "Host-managed model access is unverified"
                      : "Connect a model account in Settings > Providers",
              },
              installed: true,
              version: `${identity.meerkatVersion} / MobKit ${identity.mobkitVersion}`,
              status: connected.length ? ("ready" as const) : ("warning" as const),
              ...(!connected.length
                ? {
                    message: unverifiedAccount
                      ? "Choose Check account in Settings > Providers to unlock saved credentials."
                      : unverifiedHost
                        ? "Check host-managed credentials in Settings > Providers before using a model."
                        : "Open Settings > Providers to sign in or add an API key.",
                  }
                : {}),
              skills,
              models: projectMeerkatModels(catalog, auth),
            };
          },
          catch: (cause) =>
            new ProviderDriverError({
              driver: MEERKAT_DRIVER_KIND,
              instanceId,
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        }).pipe(
          Effect.catch((cause) =>
            Effect.succeed({
              ...baseSnapshot(),
              ...installation,
              status: "error" as const,
              message: cause instanceof Error ? cause.message : String(cause),
            }),
          ),
        );
      });
      const refresh = check(projectPath).pipe(
        Effect.tap((snapshot) => {
          current = snapshot;
          return PubSub.publish(changes, snapshot);
        }),
      );
      yield* refresh;
      const textGeneration = yield* makeMeerkatTextGeneration({
        client,
        instanceId,
        stateRoot,
        enabled,
        prepareWorkspace,
        attachmentsDir: serverConfig.attachmentsDir,
      });
      return {
        instanceId,
        driverKind: MEERKAT_DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        adapter,
        meerkatControls: {
          request: (method, params) =>
            client.request(
              method,
              params,
              method === "mobs.v1.recoverThread" ? { timeoutMs: 660_000 } : {},
            ),
        },
        meerkatMedia: { request: (method, params) => client.request(method, params) },
        meerkatTeam: makeMeerkatTeamReader({
          client,
          path,
          stateRoot,
          instanceId,
          prepareWorkspace,
        }),
        textGeneration,
        snapshotForCwd: check,
        snapshot: {
          getSnapshot: Effect.sync(() => current),
          refresh,
          streamChanges: Stream.fromPubSub(changes),
          applyUsageLimits: () => Effect.void,
          resolveMaintenance: () =>
            Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({
                provider: MEERKAT_DRIVER_KIND,
                packageName: null,
              }),
            ),
        },
      } satisfies ProviderInstance;
    }),
};

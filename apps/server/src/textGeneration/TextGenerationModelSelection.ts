import {
  isProviderAvailable,
  TextGenerationError,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  isModelSelectionProviderEnabled,
  resolveSourceControlWriterModelSelection,
  resolveTextGenerationModelSelection,
} from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";

import type { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";

const eligible = (provider: ServerProvider) =>
  provider.enabled && isProviderAvailable(provider) && provider.supportsTextGeneration !== false;

/** Saved choices stay exact; only an automatic native fallback needs a checkout catalog. */
export const resolveTextGenerationModelForCwd = Effect.fn("resolveTextGenerationModelForCwd")(
  function* (input: {
    readonly registry: Pick<
      ProviderRegistry["Service"],
      "getProviders" | "refreshWorkspaceSnapshot"
    >;
    readonly settings: ServerSettings;
    readonly cwd: string;
    readonly purpose: "general" | "source-control";
  }) {
    const { settings, registry } = input;
    const resolve = (providers?: ReadonlyArray<ServerProvider>) =>
      input.purpose === "source-control"
        ? resolveSourceControlWriterModelSelection(settings, providers)
        : resolveTextGenerationModelSelection(settings, providers);
    const preferred = resolve();
    const providers = yield* registry.getProviders;
    const configuredNative =
      settings.providerInstances[preferred.instanceId]?.driver === "meerkat" ||
      providers.some(
        (provider) => provider.instanceId === preferred.instanceId && provider.driver === "meerkat",
      );
    if (configuredNative && isModelSelectionProviderEnabled(settings, preferred)) return preferred;

    const initial = resolve(providers);
    if (
      (initial === preferred || initial === settings.textGenerationModelSelection) &&
      providers.some((provider) => eligible(provider) && provider.instanceId === initial.instanceId)
    )
      return initial;

    const nativeCandidates = providers.filter(
      (provider) =>
        eligible(provider) &&
        provider.driver === "meerkat" &&
        provider.supportsWorkspaceReadiness === true,
    );
    // Older drivers and donor providers retain their existing resolution policy.
    if (nativeCandidates.length === 0) return initial;
    for (const provider of nativeCandidates)
      yield* registry.refreshWorkspaceSnapshot({ instanceId: provider.instanceId, cwd: input.cwd });

    // Read after every refresh so an invalidated or replaced instance cannot
    // contribute the previous probe's default model.
    const latest = yield* registry.getProviders;
    const scoped = latest.map((provider) => {
      if (provider.driver !== "meerkat" || provider.supportsWorkspaceReadiness !== true)
        return provider;
      const readiness = provider.workspaceSnapshots?.find(
        (row) => row.cwd === input.cwd,
      )?.readiness;
      return {
        ...provider,
        models:
          readiness && readiness.status !== "error"
            ? readiness.models.filter(
                (model) =>
                  model.credentialState !== "needs_auth" &&
                  model.credentialState !== "reauth_required",
              )
            : [],
      };
    });
    const selection = resolve(scoped);
    if (
      scoped.some((provider) => eligible(provider) && provider.instanceId === selection.instanceId)
    )
      return selection;
    return yield* new TextGenerationError({
      operation: "resolveModelSelection",
      detail: `No writing model is available for ${input.cwd}. Open this checkout's Settings to connect an account and choose a text generation model.`,
    });
  },
);

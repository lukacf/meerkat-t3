import { it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect } from "vite-plus/test";

import { resolveTextGenerationModelForCwd } from "./TextGenerationModelSelection.ts";

const nativeId = ProviderInstanceId.make("meerkat-local");
const model = (
  slug: string,
  credentialState: NonNullable<ServerProviderModel["credentialState"]> = "connected",
) =>
  ({
    slug,
    name: slug,
    isDefault: true,
    isCustom: false,
    capabilities: null,
    credentialState,
  }) satisfies ServerProviderModel;
const defaultModel = model("openai:default-realm-model");
const checkoutModel = model("anthropic:checkout-model");
const native = (): ServerProvider => ({
  instanceId: nativeId,
  driver: ProviderDriverKind.make("meerkat"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-04T00:00:00.000Z",
  availability: "available",
  supportsTextGeneration: true,
  supportsWorkspaceReadiness: true,
  models: [defaultModel],
  skills: [],
  slashCommands: [],
});
const fallbackSettings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    [ProviderInstanceId.make("codex")]: {
      driver: ProviderDriverKind.make("codex"),
      enabled: false,
    },
    [nativeId]: { driver: ProviderDriverKind.make("meerkat"), enabled: true },
  },
};

function fixture(initial: ReadonlyArray<ServerProvider> = [native()]) {
  let providers = initial;
  const requests: Array<{ instanceId: ProviderInstanceId; cwd: string }> = [];
  let refreshed = initial;
  const registry = {
    getProviders: Effect.sync(() => providers),
    refreshWorkspaceSnapshot: (input: { instanceId: ProviderInstanceId; cwd: string }) =>
      Effect.sync(() => {
        requests.push(input);
        providers = refreshed;
        return providers;
      }),
  };
  return {
    registry,
    requests,
    setRefreshed: (value: ReadonlyArray<ServerProvider>) => {
      refreshed = value;
    },
  };
}

const scoped = (
  cwd: string,
  models: ReadonlyArray<ServerProviderModel> = [checkoutModel],
  status: "ready" | "error" = "ready",
): ServerProvider => ({
  ...native(),
  workspaceSnapshots: [
    {
      cwd,
      checkedAt: "2026-10-04T01:00:00.000Z",
      skills: [],
      slashCommands: [],
      readiness: { status, auth: { status: "authenticated" }, models },
    },
  ],
});

describe("checkout-scoped auxiliary model selection", () => {
  for (const purpose of ["general", "source-control"] as const) {
    it.effect(`uses the acted-on checkout's native fallback for ${purpose}`, () =>
      Effect.gen(function* () {
        const test = fixture();
        test.setRefreshed([scoped("/checkout-b")]);
        const selection = yield* resolveTextGenerationModelForCwd({
          registry: test.registry,
          settings: fallbackSettings,
          cwd: "/checkout-b",
          purpose,
        });
        expect(selection).toEqual(createModelSelection(nativeId, checkoutModel.slug));
        expect(test.requests).toEqual([{ instanceId: nativeId, cwd: "/checkout-b" }]);
        expect(fallbackSettings.textGenerationModelSelection).toEqual(
          DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
        );
      }),
    );
  }

  for (const outcome of ["missing", "wrong-cwd", "partial", "error", "needs-auth"] as const) {
    it.effect(`never borrows the global native default after ${outcome} checkout discovery`, () =>
      Effect.gen(function* () {
        const test = fixture();
        test.setRefreshed([
          outcome === "wrong-cwd"
            ? scoped("/checkout-a")
            : outcome === "partial"
              ? {
                  ...native(),
                  workspaceSnapshots: [
                    {
                      cwd: "/checkout-b",
                      checkedAt: native().checkedAt,
                      skills: [],
                      slashCommands: [],
                    },
                  ],
                }
              : outcome === "error"
                ? scoped("/checkout-b", [checkoutModel], "error")
                : outcome === "needs-auth"
                  ? scoped("/checkout-b", [model(checkoutModel.slug, "needs_auth")])
                  : native(),
        ]);
        const result = yield* resolveTextGenerationModelForCwd({
          registry: test.registry,
          settings: fallbackSettings,
          cwd: "/checkout-b",
          purpose: "source-control",
        }).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain("/checkout-b");
          expect(result.failure.message).toContain("Settings");
        }
      }),
    );
  }

  for (const purpose of ["general", "source-control"] as const) {
    it.effect(`preserves an unavailable explicit native model and reasoning for ${purpose}`, () =>
      Effect.gen(function* () {
        const saved = createModelSelection(nativeId, "openai:saved-unavailable", [
          { id: "reasoning_effort", value: "high" },
          { id: "prompt_cache_enabled", value: false },
        ]);
        // The instance is configured but discovery has not supplied a usable
        // snapshot. An explicit choice must not become another provider call.
        const test = fixture([]);
        const selection = yield* resolveTextGenerationModelForCwd({
          registry: test.registry,
          settings: {
            ...fallbackSettings,
            ...(purpose === "general"
              ? { textGenerationModelSelection: saved }
              : { sourceControlWriterModelSelection: saved }),
          },
          cwd: "/checkout-b",
          purpose,
        });
        expect(selection).toBe(saved);
        expect(selection.options).toEqual(saved.options);
        expect(test.requests).toEqual([]);
      }),
    );
  }

  it.effect("reads current registry authority after a refresh result was invalidated", () =>
    Effect.gen(function* () {
      const result = yield* resolveTextGenerationModelForCwd({
        registry: {
          getProviders: Effect.succeed([native()]),
          refreshWorkspaceSnapshot: () => Effect.succeed([scoped("/checkout-b")]),
        },
        settings: fallbackSettings,
        cwd: "/checkout-b",
        purpose: "general",
      }).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }),
  );

  it.effect("retains donor selection and reasoning without native probes", () =>
    Effect.gen(function* () {
      const donor = {
        ...native(),
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        supportsWorkspaceReadiness: false,
      };
      const test = fixture([donor, native()]);
      const saved = createModelSelection(donor.instanceId, "saved-donor-model", [
        { id: "reasoning_effort", value: "high" },
      ]);
      const selection = yield* resolveTextGenerationModelForCwd({
        registry: test.registry,
        settings: { ...DEFAULT_SERVER_SETTINGS, textGenerationModelSelection: saved },
        cwd: "/checkout-b",
        purpose: "general",
      });
      expect(selection).toBe(saved);
      expect(test.requests).toEqual([]);
    }),
  );
});

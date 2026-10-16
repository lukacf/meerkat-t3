import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  getOnboardingProviderState,
  isOnboardingModelAccessReady,
} from "./providerReadiness.logic";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("native"),
  driver: ProviderDriverKind.make("meerkat"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-09T00:00:00Z",
  models: [
    {
      slug: "claude-test",
      name: "Claude test",
      subProvider: "Anthropic",
      credentialState: "connected",
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
};

describe("onboarding model access", () => {
  it("requires a native model whose account is connected", () => {
    expect(isOnboardingModelAccessReady([provider])).toBe(true);
    expect(
      isOnboardingModelAccessReady([{ ...provider, driver: ProviderDriverKind.make("codex") }]),
    ).toBe(false);
    expect(isOnboardingModelAccessReady([{ ...provider, models: [] }])).toBe(false);
  });
  it.each(["needs_auth", "reauth_required", "unknown", "host_managed"] as const)(
    "does not treat a %s catalog entry as usable",
    (credentialState) => {
      expect(
        isOnboardingModelAccessReady([
          { ...provider, models: [{ ...provider.models[0]!, credentialState }] },
        ]),
      ).toBe(false);
    },
  );
  it.each([
    { enabled: false },
    { installed: false },
    { status: "disabled" as const },
    { status: "error" as const },
    { availability: "unavailable" as const },
    { auth: { status: "unauthenticated" as const } },
  ])(
    "does not continue from stale credentials when the native connection cannot run: %o",
    (change) => {
      expect(isOnboardingModelAccessReady([{ ...provider, ...change }])).toBe(false);
    },
  );
  it("waits for a native snapshot", () => {
    expect(isOnboardingModelAccessReady(undefined)).toBe(false);
    expect(isOnboardingModelAccessReady([])).toBe(false);
    expect(getOnboardingProviderState(undefined)).toBe("checking");
  });
});

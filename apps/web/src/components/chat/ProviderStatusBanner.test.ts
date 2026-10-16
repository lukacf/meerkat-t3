import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import {
  getProviderStatusBannerKey,
  getProviderStatusMessage,
  shouldShowProviderStatusBanner,
} from "./ProviderStatusBanner";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex-work"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-22T00:00:00Z",
  models: [],
  skills: [],
  slashCommands: [],
  compatibilityAdvisory: {
    status: "unsupported",
    message: "Unsupported version. Use 2.0.0.",
    recommendedVersion: "2.0.0",
    recommendedRange: null,
  },
};

describe("compatibility banners", () => {
  it("shows and dismisses a warning on a healthy provider, then clears it after policy relaxation", () => {
    expect(shouldShowProviderStatusBanner(provider, null)).toBe(true);
    expect(shouldShowProviderStatusBanner(provider, getProviderStatusBannerKey(provider))).toBe(
      false,
    );
    expect(
      shouldShowProviderStatusBanner(
        { ...provider, version: "1.0.1" },
        getProviderStatusBannerKey(provider),
      ),
    ).toBe(true);
    const relaxed: ServerProvider = {
      ...provider,
      compatibilityAdvisory: {
        ...provider.compatibilityAdvisory!,
        status: "supported",
        message: null,
      },
    };
    expect(getProviderStatusBannerKey(relaxed)).toBeNull();
    expect(getProviderStatusBannerKey({ ...provider, status: "disabled" })).toBeNull();
    expect(
      getProviderStatusBannerKey({
        ...provider,
        compatibilityAdvisory: { ...provider.compatibilityAdvisory!, status: "graceful" },
      }),
    ).toBeNull();
  });

  it("keeps authentication failures ahead of compatibility warnings even without a probe message", () => {
    const unauthenticated: ServerProvider = {
      ...provider,
      status: "error",
      auth: { status: "unauthenticated" },
    };
    expect(getProviderStatusMessage(unauthenticated)).toBe(
      "Sign in via the CLI to authenticate again.",
    );
    expect(getProviderStatusMessage({ ...unauthenticated, message: "Credentials expired" })).toBe(
      "Credentials expired",
    );
  });
});

describe("model access recovery", () => {
  const unavailable: ServerProvider = {
    ...provider,
    instanceId: ProviderInstanceId.make("meerkat"),
    driver: ProviderDriverKind.make("meerkat"),
    status: "error",
    auth: { status: "unknown" },
    message:
      "Provider driver 'meerkat' failed to create instance 'meerkat': Meerkat gateway request timed out: models.v1.catalog. Execution outcome is unknown.",
  };

  it("keeps a failed account check distinct from being signed out", () => {
    expect(getProviderStatusMessage(unavailable)).toBe(
      "Could not check model access. Open Settings > Providers to retry.",
    );
    expect(getProviderStatusMessage({ ...unavailable, auth: { status: "unauthenticated" } })).toBe(
      "Connect an account in Settings > Providers to use its models.",
    );
  });

  it("shows a new failure after dismissing an earlier one, despite sharing a recovery summary", () => {
    const changed = { ...unavailable, message: "Native model catalog could not be loaded." };
    expect(getProviderStatusMessage(changed)).toBe(getProviderStatusMessage(unavailable));
    expect(shouldShowProviderStatusBanner(changed, getProviderStatusBannerKey(unavailable))).toBe(
      true,
    );
  });
});

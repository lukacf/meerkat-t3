import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderSummary, getProviderVersionAdvisoryPresentation } from "./providerStatus";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", label: "ChatGPT" },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("getProviderSummary", () => {
  it("does not promise an active check or hidden Refresh action without operate permission", () => {
    const native = {
      ...provider,
      driver: ProviderDriverKind.make("meerkat"),
      auth: { status: "unknown" as const },
    };
    expect(getProviderSummary(native, true, "denied")).toEqual({
      headline: "Checkout account not checked",
      detail:
        "This connection cannot check the checkout's account or models. Reconnect with permission to operate this environment.",
    });
    expect(getProviderSummary(native, true, "pending").detail).toContain(
      "Waiting for connection permissions",
    );
    expect(getProviderSummary(native, false, "denied").headline).toBe("Available");
  });
  it("distinguishes a pending checkout probe from a missing account without hiding machine failures", () => {
    const native = { ...provider, driver: ProviderDriverKind.make("meerkat") };
    expect(getProviderSummary(native, true)).toMatchObject({
      headline: "Checking checkout account",
      detail: expect.stringContaining("Refresh provider status"),
    });
    expect(getProviderSummary({ ...native, enabled: false }, true).headline).toBe("Disabled");
    expect(getProviderSummary({ ...native, installed: false }, true).headline).toBe("Not found");
    expect(getProviderSummary({ ...native, auth: { status: "unauthenticated" } }).headline).toBe(
      "Not authenticated",
    );
  });
  it("describes native credentials as detected while keeping donor authentication status", () => {
    const native = { ...provider, driver: ProviderDriverKind.make("meerkat") };
    expect(getProviderSummary(native)).toEqual({
      headline: "Credentials detected · ChatGPT",
      detail: "Your first request will confirm access to the selected model.",
    });
    expect(getProviderSummary({ ...native, message: "Host-managed account." }).detail).toBe(
      "Host-managed account.",
    );
    expect(getProviderSummary(provider).headline).toBe("Authenticated · ChatGPT");
  });
  it("points native credential setup to the supported editor without masking auth diagnostics", () => {
    const native = {
      ...provider,
      driver: ProviderDriverKind.make("meerkat"),
      auth: { status: "unauthenticated" as const },
    };
    const summary = getProviderSummary({
      ...native,
      message:
        "Open project Connections to set up API-key credentials or sign in with a configured OAuth profile.",
    });
    expect(summary.detail).toContain("Credentials settings");
    expect(summary.detail).toContain("configured OAuth accounts");
    expect(getProviderSummary({ ...native, message: "The stored key was rejected." }).detail).toBe(
      "The stored key was rejected.",
    );
  });
  it("reports ready providers with unknown authentication as available", () => {
    expect(getProviderSummary({ ...provider, auth: { status: "unknown" } })).toEqual({
      headline: "Available",
      detail: null,
    });
  });

  it("does not hide a provider error behind a previous authenticated state", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "error",
        message: "The provider process failed to start.",
      }),
    ).toEqual({
      headline: "Unavailable",
      detail: "The provider process failed to start.",
    });
  });

  it("does not hide a provider warning behind an authenticated state", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "warning",
        message: "The provider version is unsupported.",
      }),
    ).toEqual({
      headline: "Needs attention",
      detail: "The provider version is unsupported.",
    });
  });

  it("keeps authentication failures actionable when their provider status is error", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Run codex login.",
      }),
    ).toEqual({
      headline: "Not authenticated",
      detail: "Run codex login.",
    });
  });

  it("treats a disabled provider status as disabled even before its enabled flag updates", () => {
    expect(getProviderSummary({ ...provider, status: "disabled" }).headline).toBe("Disabled");
  });
});

it("does not suggest copying a command that installs an incompatible latest version", () => {
  const advisory = {
    status: "behind_latest" as const,
    currentVersion: "1.0.0",
    latestVersion: "2.0.0",
    updateCommand: "npm install -g fixture@latest",
    canUpdate: true,
    checkedAt: provider.checkedAt,
    message: null,
  };
  const compatibility = {
    status: "supported" as const,
    latestVersionStatus: "broken" as const,
    message: null,
    recommendedRange: null,
    recommendedVersion: null,
  };
  expect(getProviderVersionAdvisoryPresentation(advisory, compatibility)).toBeNull();
  expect(
    getProviderVersionAdvisoryPresentation(advisory, { ...compatibility, status: "broken" }, false),
  ).toBeNull();
  expect(
    getProviderVersionAdvisoryPresentation(advisory, {
      ...compatibility,
      latestVersionStatus: "supported",
    }),
  ).not.toBeNull();
});

it("shows compatibility in the version popover even when the installed version is current", () => {
  const advisory = {
    status: "current" as const,
    currentVersion: "2.0.0",
    latestVersion: "2.0.0",
    updateCommand: "npm install -g fixture@latest",
    canUpdate: true,
    checkedAt: provider.checkedAt,
    message: null,
  };
  const compatibility = {
    status: "broken" as const,
    latestVersionStatus: "broken" as const,
    message: "This version drops turns. Use 1.9.0.",
    recommendedRange: null,
    recommendedVersion: "1.9.0",
  };
  expect(getProviderVersionAdvisoryPresentation(advisory, compatibility)).toEqual({
    title: "Known broken version",
    detail: compatibility.message,
    updateCommand: null,
    emphasis: "strong",
    targetVersion: "1.9.0",
  });
  expect(
    getProviderVersionAdvisoryPresentation(undefined, {
      ...compatibility,
      status: "graceful",
      recommendedVersion: null,
      recommendedRange: ">=2.1.0",
      message: null,
    }),
  ).toEqual({
    title: "Limited support",
    detail: "Use >=2.1.0 for full support.",
    updateCommand: null,
    emphasis: "normal",
    targetVersion: null,
  });
});

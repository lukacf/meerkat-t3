import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  canCheckProviderWorkspaceReadiness,
  hasProviderWorkspaceReadiness,
  resolveProviderWorkspaceReadiness,
} from "./providerWorkspaceReadiness.js";

const model: ServerProviderModel = {
  slug: "openai:example",
  name: "Example",
  isCustom: false,
  capabilities: null,
  credentialState: "connected",
};
const native: ServerProvider = {
  instanceId: ProviderInstanceId.make("native-work"),
  driver: ProviderDriverKind.make("meerkat"),
  installed: true,
  enabled: true,
  availability: "available",
  version: "0.8.50",
  status: "warning",
  auth: { status: "unauthenticated" },
  models: [{ ...model, credentialState: "needs_auth" }],
  checkedAt: "2026-10-04T10:00:00.000Z",
  skills: [],
  slashCommands: [],
  message: "Default project needs an account",
  supportsWorkspaceReadiness: true,
  workspaceSnapshots: [
    {
      cwd: "/projects/b",
      checkedAt: "2026-10-04T11:00:00.000Z",
      skills: [],
      slashCommands: [],
      readiness: { status: "ready", auth: { status: "authenticated" }, models: [model] },
    },
  ],
};

describe("workspace model readiness", () => {
  it("uses B's models and account instead of the default project's missing account", () => {
    const result = resolveProviderWorkspaceReadiness([native], "/projects/b");
    expect(result.pendingInstanceIds.size).toBe(0);
    expect(result.providers[0]).toMatchObject({
      instanceId: native.instanceId,
      models: [model],
      auth: { status: "authenticated" },
      status: "ready",
      installed: true,
      enabled: true,
      version: native.version,
    });
    expect(result.providers[0]?.message).toBeUndefined();
    expect(native.auth.status).toBe("unauthenticated");
  });

  it("does not authorize a missing account using a connected default project", () => {
    const provider = {
      ...native,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      models: [model],
      workspaceSnapshots: [
        {
          ...native.workspaceSnapshots![0]!,
          readiness: {
            status: "warning" as const,
            auth: { status: "unauthenticated" as const },
            models: [{ ...model, slug: "anthropic:other", credentialState: "needs_auth" as const }],
          },
        },
      ],
    };
    const scoped = resolveProviderWorkspaceReadiness([provider], "/projects/b").providers[0]!;
    expect(scoped.auth.status).toBe("unauthenticated");
    expect(scoped.models).toEqual(provider.workspaceSnapshots[0]!.readiness.models);
  });

  it.each([undefined, null, "/projects", "/projects/b/", "/projects/b/worktree"])(
    "waits for exact scope %s instead of borrowing a parent or nearby catalog",
    (cwd) => {
      const result = resolveProviderWorkspaceReadiness([native], cwd);
      expect(result.pendingInstanceIds.has(native.instanceId)).toBe(true);
      expect(result.providers[0]?.models).toEqual([]);
      expect(result.providers[0]?.auth.status).toBe("unknown");
      expect(hasProviderWorkspaceReadiness(native, cwd)).toBe(false);
    },
  );

  it("requires the readiness field even when the same cwd has a legacy skills snapshot", () => {
    const { readiness: _readiness, ...skillsOnly } = native.workspaceSnapshots![0]!;
    const result = resolveProviderWorkspaceReadiness(
      [{ ...native, workspaceSnapshots: [skillsOnly] }],
      "/projects/b",
    );
    expect(result.pendingInstanceIds.has(native.instanceId)).toBe(true);
  });

  it.each([
    { installed: false, status: "error" },
    { enabled: false },
    { status: "disabled" },
    { availability: "unavailable" },
  ] satisfies Partial<ServerProvider>[])(
    "does not advertise a pending workspace check for an ineligible machine %j",
    (overrides) => {
      const provider = { ...native, ...overrides, workspaceSnapshots: [] };
      expect(canCheckProviderWorkspaceReadiness(provider)).toBe(false);
      for (const cwd of [undefined, "/projects/b"]) {
        const result = resolveProviderWorkspaceReadiness([provider], cwd);
        expect(result.pendingInstanceIds.has(provider.instanceId)).toBe(false);
        expect(result.providers[0]).toMatchObject({
          status: provider.status,
          models: [],
          auth: { status: "unknown" },
        });
        expect(result.providers[0]?.message).toBeUndefined();
      }
    },
  );

  it("can check a healthy machine after the default project's metadata failed", () => {
    const provider = { ...native, status: "error" as const, workspaceSnapshots: [] };
    expect(canCheckProviderWorkspaceReadiness(provider)).toBe(true);
    expect(resolveProviderWorkspaceReadiness([provider], "/projects/b").pendingInstanceIds).toEqual(
      new Set([provider.instanceId]),
    );
  });

  it("keeps explicit scoped errors distinct from a missing check and preserves machine unavailability", () => {
    const provider = {
      ...native,
      installed: false,
      enabled: false,
      status: "disabled" as const,
      workspaceSnapshots: [
        {
          ...native.workspaceSnapshots![0]!,
          readiness: {
            status: "error" as const,
            auth: { status: "unknown" as const },
            models: [],
            message: "Scoped check failed",
          },
        },
      ],
    };
    const result = resolveProviderWorkspaceReadiness([provider], "/projects/b");
    expect(result.pendingInstanceIds.size).toBe(0);
    expect(result.providers[0]).toMatchObject({
      installed: false,
      enabled: false,
      status: "disabled",
      message: "Scoped check failed",
    });
  });

  it("leaves old servers and other drivers unchanged", () => {
    for (const provider of [
      { ...native, supportsWorkspaceReadiness: false },
      { ...native, supportsWorkspaceReadiness: undefined },
      { ...native, driver: ProviderDriverKind.make("codex") },
    ]) {
      const result = resolveProviderWorkspaceReadiness([provider], "/elsewhere");
      expect(result.providers[0]).toBe(provider);
      expect(result.pendingInstanceIds.size).toBe(0);
    }
  });

  it("does not share catalogs between provider instances with the same cwd", () => {
    const other = {
      ...native,
      instanceId: ProviderInstanceId.make("native-personal"),
      workspaceSnapshots: [],
    };
    const result = resolveProviderWorkspaceReadiness([native, other], "/projects/b");
    expect(result.providers[0]?.models).toEqual([model]);
    expect(result.providers[1]?.models).toEqual([]);
    expect([...result.pendingInstanceIds]).toEqual([other.instanceId]);
  });
});

import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderEnvironmentOptions,
  buildProviderSettingsEdit,
  classifyProviderEnvironmentAccess,
  isProviderSettingsEnvironmentAvailable,
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
  resolveSelectedProviderEnvironmentId,
  selectProviderSettingsRow,
  orderProviderSettingsRows,
} from "./ProviderSettingsPanel.logic";

const primaryId = EnvironmentId.make("primary");
const relayId = EnvironmentId.make("relay");
const sshId = EnvironmentId.make("ssh");

const environments = [
  { environmentId: sshId, label: "Zulu SSH" },
  { environmentId: relayId, label: "Alpha Relay" },
  { environmentId: primaryId, label: "This device" },
] as const;

describe("provider editor intents", () => {
  const instanceId = ProviderInstanceId.make("work");
  const previous = {
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    displayName: "Work",
    config: { binaryPath: "/old/codex", homePath: "/work", customModels: ["private-model"] },
    environment: [{ name: "API_KEY", value: "", valueRedacted: true, sensitive: true }],
  };

  it("captures one field without resending configuration or stored credentials", () => {
    expect(
      buildProviderSettingsEdit(instanceId, previous, { ...previous, enabled: false }),
    ).toEqual({
      kind: "edit",
      instanceId,
      driver: "codex",
      changes: { enabled: false },
    });
  });

  it("distinguishes clearing a field from replacing the config blob", () => {
    const { binaryPath: _removed, ...rest } = previous.config;
    const { displayName: _name, ...withoutName } = previous;
    expect(
      buildProviderSettingsEdit(instanceId, previous, {
        ...withoutName,
        config: { ...rest, homePath: "/new/work" },
      }),
    ).toEqual({
      kind: "edit",
      instanceId,
      driver: "codex",
      changes: {
        displayName: null,
        config: { set: { homePath: "/new/work" }, remove: ["binaryPath"] },
      },
    });
  });
});

describe("provider instance selection", () => {
  const codex = {
    instanceId: ProviderInstanceId.make("codex"),
    instance: { driver: ProviderDriverKind.make("codex"), enabled: false, config: {} },
  };
  const meerkat = {
    instanceId: ProviderInstanceId.make("meerkat"),
    instance: { driver: ProviderDriverKind.make("meerkat"), enabled: true, config: {} },
  };
  const custom = { ...meerkat, instanceId: ProviderInstanceId.make("custom") };
  const rows = [codex, meerkat, custom];
  it("puts enabled native instances first, preserving peer order and all configured alternatives", () => {
    const enabledCodex = {
      ...codex,
      instanceId: ProviderInstanceId.make("codex-enabled"),
      instance: { ...codex.instance, enabled: true },
    };
    const disabledNative = {
      ...custom,
      instance: { ...custom.instance, config: { enabled: false } },
    };
    const original = [codex, enabledCodex, disabledNative, meerkat, custom];
    expect(orderProviderSettingsRows(original)).toEqual([
      meerkat,
      custom,
      enabledCodex,
      codex,
      disabledNative,
    ]);
    expect(original).toEqual([codex, enabledCodex, disabledNative, meerkat, custom]);
    expect(selectProviderSettingsRow(orderProviderSettingsRows(original), codex.instanceId)).toBe(
      codex,
    );
  });
  it("opens the enabled runtime in a native profile without removing disabled providers", () => {
    expect(selectProviderSettingsRow(rows, null)).toBe(meerkat);
    expect(rows).toEqual([codex, meerkat, custom]);
  });
  it("preserves a valid explicit choice even when disabled or another provider becomes enabled", () => {
    expect(selectProviderSettingsRow(rows, codex.instanceId)).toBe(codex);
    expect(selectProviderSettingsRow(rows, custom.instanceId)).toBe(custom);
    expect(selectProviderSettingsRow(rows, meerkat.instanceId, meerkat.instanceId)).toBe(meerkat);
  });
  it("retains missing explicit target errors and chooses an enabled fallback after an ordinary deletion", () => {
    const deleted = ProviderInstanceId.make("deleted");
    expect(selectProviderSettingsRow(rows, deleted, deleted)).toBeNull();
    expect(selectProviderSettingsRow(rows, deleted)).toBe(meerkat);
    expect(selectProviderSettingsRow([codex], null)).toBe(codex);
    expect(selectProviderSettingsRow([], null)).toBeNull();
  });
  it("uses native driver defaults and legacy config disables before selecting a fallback", () => {
    const grok = {
      instanceId: ProviderInstanceId.make("grok"),
      instance: { driver: ProviderDriverKind.make("grok"), config: {} },
    };
    const legacyDisabled = {
      ...codex,
      instance: { ...codex.instance, enabled: true, config: { enabled: false } },
    };
    const defaultCodex = { ...codex, instance: { driver: codex.instance.driver, config: {} } };
    const explicitGrok = { ...grok, instance: { ...grok.instance, config: { enabled: true } } };
    expect(selectProviderSettingsRow([grok, legacyDisabled, meerkat], null)).toBe(meerkat);
    expect(selectProviderSettingsRow([grok, defaultCodex, meerkat], null)).toBe(defaultCodex);
    expect(selectProviderSettingsRow([explicitGrok, meerkat], null)).toBe(explicitGrok);
  });
});

describe("provider environment selection", () => {
  it("requires a connected environment with server config for searchable provider settings", () => {
    expect(
      isProviderSettingsEnvironmentAvailable({
        connectionPhase: "connected",
        hasServerConfig: true,
      }),
    ).toBe(true);
    expect(
      isProviderSettingsEnvironmentAvailable({
        connectionPhase: "reconnecting",
        hasServerConfig: true,
      }),
    ).toBe(false);
    expect(
      isProviderSettingsEnvironmentAvailable({
        connectionPhase: "connected",
        hasServerConfig: false,
      }),
    ).toBe(false);
  });

  it("sorts the primary environment first and the rest by label", () => {
    expect(
      buildProviderEnvironmentOptions(environments, primaryId).map(
        (environment) => environment.environmentId,
      ),
    ).toEqual([primaryId, relayId, sshId]);
  });

  it("keeps a valid selection, then falls back to primary or the first environment", () => {
    const options = buildProviderEnvironmentOptions(environments, primaryId);

    expect(resolveSelectedProviderEnvironmentId(options, sshId, primaryId)).toBe(sshId);
    expect(
      resolveSelectedProviderEnvironmentId(
        options.filter((environment) => environment.environmentId !== sshId),
        sshId,
        primaryId,
      ),
    ).toBe(primaryId);
    expect(resolveSelectedProviderEnvironmentId(options.slice(1), primaryId, primaryId)).toBe(
      relayId,
    );
    expect(resolveSelectedProviderEnvironmentId([], null, primaryId)).toBeNull();
  });
});

describe("provider environment access", () => {
  it("allows connected environments with config and operate access", () => {
    expect(
      classifyProviderEnvironmentAccess({
        connectionPhase: "connected",
        hasServerConfig: true,
        operateAccess: "granted",
      }),
    ).toEqual({ kind: "editable" });
  });

  it("waits for config before exposing controls", () => {
    expect(
      classifyProviderEnvironmentAccess({
        connectionPhase: "connected",
        hasServerConfig: false,
        operateAccess: "granted",
      }),
    ).toEqual({ kind: "loading", reason: "config" });
  });

  it("waits for unresolved operate access instead of assuming it is editable", () => {
    expect(
      classifyProviderEnvironmentAccess({
        connectionPhase: "connected",
        hasServerConfig: true,
        operateAccess: "pending",
      }),
    ).toEqual({ kind: "loading", reason: "permissions" });
  });

  it("represents known missing operate access as read only", () => {
    expect(
      classifyProviderEnvironmentAccess({
        connectionPhase: "connected",
        hasServerConfig: true,
        operateAccess: "denied",
      }),
    ).toEqual({ kind: "read-only" });
  });

  it.each(["available", "offline", "connecting", "reconnecting"] as const)(
    "keeps %s environments unavailable",
    (connectionPhase) => {
      expect(
        classifyProviderEnvironmentAccess({
          connectionPhase,
          hasServerConfig: true,
          operateAccess: "granted",
        }),
      ).toEqual({ kind: "unavailable" });
    },
  );

  it("separates connection errors from other unavailable states", () => {
    expect(
      classifyProviderEnvironmentAccess({
        connectionPhase: "error",
        hasServerConfig: true,
        operateAccess: "granted",
      }),
    ).toEqual({ kind: "error" });
  });
});

describe("primary operate access", () => {
  const authenticated = {
    authenticated: true as const,
    scopes: [AuthOrchestrationOperateScope],
  };

  it("keeps cached session data authoritative while SWR revalidates", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: authenticated,
        isPending: true,
        hasError: false,
      }),
    ).toBe("granted");
  });

  it("reports pending only before any session has resolved", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: null,
        isPending: true,
        hasError: false,
      }),
    ).toBe("pending");
  });

  it("treats a failed session fetch as a transport problem, not a denial", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: null,
        isPending: false,
        hasError: true,
      }),
    ).toBe("granted");
  });

  it("denies unauthenticated sessions and sessions without the operate scope", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: { authenticated: false },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: { authenticated: true, scopes: ["orchestration:read"] },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: null,
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
  });

  it("grants desktop bridge and remote environments without blocking on the primary session", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: true,
        session: null,
        isPending: true,
        hasError: false,
      }),
    ).toBe("granted");
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: false,
        hasDesktopBridge: false,
        session: null,
        isPending: true,
        hasError: false,
      }),
    ).toBe("granted");
  });
});

describe("remote operate access", () => {
  it("derives access from the environment session's granted scopes", () => {
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: [AuthOrchestrationOperateScope] },
        isPending: false,
        hasError: false,
      }),
    ).toBe("granted");
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: ["orchestration:read"] },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: false },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
  });

  it("reports pending before the first session resolve, then keeps cached data", () => {
    expect(resolveRemoteOperateAccess({ session: null, isPending: true, hasError: false })).toBe(
      "pending",
    );
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: [AuthOrchestrationOperateScope] },
        isPending: true,
        hasError: false,
      }),
    ).toBe("granted");
  });

  it("stays optimistic when the session fetch fails or an older server omits scopes", () => {
    // Transport failures and pre-scope-reporting servers are not permission
    // decisions; the environment RPC layer still rejects unauthorized writes.
    expect(resolveRemoteOperateAccess({ session: null, isPending: false, hasError: true })).toBe(
      "granted",
    );
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true },
        isPending: false,
        hasError: false,
      }),
    ).toBe("granted");
  });
});

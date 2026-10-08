import type { ReactElement } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import type { resolveSettingsProviderReadiness } from "./settingsProviderReadiness";

const scopeState = vi.hoisted(() => ({
  context: null as {
    scope: NonNullable<Parameters<typeof resolveSettingsProviderReadiness>[0]>;
    target: Parameters<typeof resolveSettingsProviderReadiness>[1];
    targets: NonNullable<Parameters<typeof resolveSettingsProviderReadiness>[1]>[];
  } | null,
}));
vi.mock("./SettingsScopeContext", () => ({ useOptionalSettingsScope: () => scopeState.context }));
vi.mock("./ProviderAccountContext", () => ({ useProviderAccountTarget: () => null }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("./SettingsWorkspaceReadiness", () => ({
  useSettingsWorkspaceAccess: () =>
    new Map(scopeState.context?.targets.map((target) => [target.environmentId, "granted"]) ?? []),
}));

const atoms = vi.hoisted(() => ({
  providers: null as ReadonlyArray<ServerProvider> | null,
  providersAtom: Symbol("providers"),
  refreshProviders: Symbol("refreshProviders"),
  updateProvider: Symbol("updateProvider"),
  updateProviderSettings: Symbol("updateProviderSettings"),
}));

const commands = vi.hoisted(() => ({
  refresh: vi.fn(),
  updateProvider: vi.fn(),
  updateProviderSettings: vi.fn(),
}));

const settingsState = vi.hoisted(() => ({
  value: null as UnifiedSettings | null,
  readEnvironmentIds: [] as EnvironmentId[],
  updateEnvironmentIds: [] as EnvironmentId[],
  updateSettings: vi.fn(),
  updateClientSettings: vi.fn(),
}));

const settingsSearchState = vi.hoisted(() => ({
  targetId: null as string | null,
  effects: [] as Array<() => void>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: (effect: () => void) => settingsSearchState.effects.push(effect),
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("./settingsLayout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settingsLayout")>();
  return {
    ...actual,
    useSettingsSearchTargetId: () => settingsSearchState.targetId,
  };
});

vi.mock("./SettingsScopeSentence", () => ({ SettingsScopeSentence: () => null }));
vi.mock("./MeerkatCredentialsEditor", () => ({ MeerkatCredentialsEditor: () => null }));
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => atoms.providers,
}));

vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: () => atoms.providersAtom,
    refreshProviders: atoms.refreshProviders,
    updateProvider: atoms.updateProvider,
    updateProviderSettings: atoms.updateProviderSettings,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) => {
    if (atom === atoms.refreshProviders) return commands.refresh;
    if (atom === atoms.updateProvider) return commands.updateProvider;
    if (atom === atoms.updateProviderSettings) return commands.updateProviderSettings;
    throw new Error("Unexpected provider command");
  },
}));

vi.mock("../../hooks/useSettings", () => ({
  useUpdateClientSettings: () => settingsState.updateClientSettings,
  useEnvironmentSettings: (environmentId: EnvironmentId) => {
    settingsState.readEnvironmentIds.push(environmentId);
    return settingsState.value;
  },
  useUpdateEnvironmentSettings: () => settingsState.updateSettings,
}));

vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
}));

vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({ data: null, hasError: false, isPending: true }),
}));

import { EnvironmentProviderSettings } from "./ProviderSettingsPanel";

const environmentId = EnvironmentId.make("remote-device");
const codexId = ProviderInstanceId.make("codex");
const customId = ProviderInstanceId.make("codex_work");

function provider(): ServerProvider {
  return {
    instanceId: codexId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-24T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "pnpm add -g @openai/codex@latest",
      canUpdate: true,
      checkedAt: "2026-07-24T12:00:00.000Z",
      message: "Update available.",
    },
  };
}

function renderPanel(options?: {
  readonly readOnly?: boolean;
  readonly targetInstanceId?: ProviderInstanceId;
}): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return EnvironmentProviderSettings({
    environmentId,
    environmentLabel: "Remote device",
    ...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options?.targetInstanceId === undefined
      ? {}
      : { targetInstanceId: options.targetInstanceId }),
  }) as ReactElement<Record<string, unknown>>;
}

function isRefreshButton(element: ReactElement<Record<string, unknown>>): boolean {
  const children = element.props.children;
  return (
    Array.isArray(children) &&
    children.some(
      (child) =>
        typeof child === "object" &&
        child !== null &&
        (child as ReactElement<Record<string, unknown>>).props?.className === "sr-only" &&
        (child as ReactElement<Record<string, unknown>>).props?.children ===
          "Refresh provider status",
    )
  );
}

function isAddProviderButton(element: ReactElement<Record<string, unknown>>): boolean {
  return element.props["aria-label"] === "Add provider";
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("EnvironmentProviderSettings routing", () => {
  beforeEach(() => {
    hooks.reset();
    scopeState.context = null;
    atoms.providers = null;
    settingsState.value = DEFAULT_UNIFIED_SETTINGS;
    settingsState.readEnvironmentIds = [];
    settingsState.updateEnvironmentIds = [];
    settingsState.updateSettings.mockReset();
    settingsState.updateClientSettings.mockReset();
    settingsSearchState.targetId = null;
    settingsSearchState.effects = [];
    commands.refresh.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.updateProvider.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.updateProviderSettings.mockReset().mockResolvedValue({ _tag: "Success" });
  });

  it("coalesces a nullable provider snapshot before rendering array-backed UI", () => {
    expect(() => renderPanel()).not.toThrow();
    expect(settingsState.readEnvironmentIds).toEqual([environmentId]);
  });

  it("shows B's native account and catalog while retaining environment-scoped provider edits", async () => {
    const nativeId = ProviderInstanceId.make("meerkat");
    const projectId = ProjectId.make("project-b");
    const target = { environmentId, projectId };
    scopeState.context = {
      scope: {
        kind: "checkout",
        members: [
          {
            id: projectId,
            environmentId,
            title: "B",
            workspaceRoot: "/projects/b",
            physicalProjectKey: "remote:/projects/b",
            environmentLabel: "Remote device",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-10-04T00:00:00.000Z",
            updatedAt: "2026-10-04T00:00:00.000Z",
          },
        ],
      },
      target,
      targets: [target],
    };
    const modelB = {
      slug: "openai:fixture-b",
      name: "Fixture B",
      isCustom: true,
      capabilities: null,
    };
    const native: ServerProvider = {
      ...provider(),
      instanceId: nativeId,
      driver: ProviderDriverKind.make("meerkat"),
      supportsWorkspaceReadiness: true,
      auth: { status: "unauthenticated" },
      models: [{ ...modelB, slug: "openai:fixture-a", name: "Fixture A" }],
      workspaceSnapshots: [
        {
          cwd: "/projects/b",
          checkedAt: provider().checkedAt,
          skills: [],
          slashCommands: [],
          readiness: {
            status: "ready",
            auth: { status: "authenticated", label: "B account" },
            models: [modelB],
          },
        },
      ],
    };
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [nativeId]: { driver: native.driver, enabled: true },
      },
    };
    atoms.providers = [native];
    let panel = renderPanel({ targetInstanceId: nativeId });
    const editor = visitElements(
      panel,
      (element) => element.props.instanceId === nativeId && element.props.mode === "editor",
    );
    expect(editor?.props.liveProvider).toMatchObject({
      auth: { status: "authenticated", label: "B account" },
      models: [modelB],
    });
    expect(editor?.props.workspaceReadinessPending).toBe(false);
    expect(native.auth.status).toBe("unauthenticated");
    if (!editor) throw new Error("Native provider editor missing");
    const update = editor.props.onUpdate as (next: {
      driver: typeof native.driver;
      enabled: boolean;
    }) => Promise<boolean>;
    commands.updateProviderSettings.mockResolvedValueOnce({ _tag: "Failure" });
    expect(await update({ driver: native.driver, enabled: false })).toBe(false);
    expect(await update({ driver: native.driver, enabled: false })).toBe(true);
    expect(settingsState.readEnvironmentIds).toEqual([environmentId]);
    expect(commands.updateProviderSettings).toHaveBeenCalledTimes(2);
    for (const [request] of commands.updateProviderSettings.mock.calls) {
      expect(request).toEqual({
        environmentId,
        input: {
          kind: "edit",
          instanceId: nativeId,
          driver: native.driver,
          changes: { enabled: false },
        },
      });
    }
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
    expect(commands.updateProvider).not.toHaveBeenCalled();

    atoms.providers = [{ ...native, workspaceSnapshots: [] }];
    panel = renderPanel({ targetInstanceId: nativeId });
    const pending = visitElements(
      panel,
      (element) => element.props.instanceId === nativeId && element.props.mode === "editor",
    );
    expect(pending?.props.liveProvider).toMatchObject({ auth: { status: "unknown" }, models: [] });
    expect(pending?.props.workspaceReadinessPending).toBe(true);
    const refresh = visitElements(panel, isRefreshButton)?.props.onClick as
      | (() => void)
      | undefined;
    refresh?.();
    await flushPromises();
    expect(commands.refresh).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { refreshModels: true },
    });
  });

  it("routes refresh and provider update commands to the selected environment", async () => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    const refreshButton = visitElements(panel, isRefreshButton);
    expect(refreshButton).not.toBeNull();
    (refreshButton?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.refresh).toHaveBeenCalledWith({
      environmentId,
      input: { refreshModels: true },
    });

    const providerCard = visitElements(
      panel,
      (element) =>
        element.props.instanceId === codexId && typeof element.props.onRunUpdate === "function",
    );
    expect(providerCard).not.toBeNull();
    (providerCard?.props.onRunUpdate as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.updateProvider).toHaveBeenCalledWith({
      environmentId,
      input: { provider: ProviderDriverKind.make("codex"), instanceId: codexId },
    });
    expect(commands.updateProviderSettings).not.toHaveBeenCalled();
  });

  it("opens the requested provider instance instead of the first provider", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
    };
    atoms.providers = [provider()];
    const panel = renderPanel({ targetInstanceId: customId });
    const editor = visitElements(panel, (element) => element.props.mode === "editor");
    expect(editor?.props.instanceId).toBe(customId);
  });

  it.each([
    ["onFavoriteModelsChange", { favorites: [{ provider: codexId, model: "chosen" }] }],
    [
      "onHiddenModelsChange",
      { providerModelPreferences: { [codexId]: { hiddenModels: ["chosen"], modelOrder: [] } } },
    ],
    [
      "onModelOrderChange",
      { providerModelPreferences: { [codexId]: { hiddenModels: [], modelOrder: ["chosen"] } } },
    ],
  ])("saves %s on this device without changing the selected server", (action, expected) => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    const editor = visitElements(
      panel,
      (element) => element.props.instanceId === codexId && element.props.mode === "editor",
    );
    expect(editor).not.toBeNull();
    if (!editor) throw new Error("Provider editor was not rendered");
    (editor.props[action] as (models: string[]) => void)(["chosen"]);
    expect(settingsState.updateClientSettings).toHaveBeenCalledExactlyOnceWith(expected);
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
    expect(commands.updateProviderSettings).not.toHaveBeenCalled();
  });

  it("does not substitute another account when the requested instance was removed", () => {
    atoms.providers = [provider()];
    const panel = renderPanel({ targetInstanceId: customId });
    expect(visitElements(panel, (element) => element.props.mode === "editor")).toBeNull();
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
    expect(commands.updateProviderSettings).not.toHaveBeenCalled();
  });

  it("blocks captured edits until the credential operation completes, then sends only changed fields", async () => {
    const nativeId = ProviderInstanceId.make("native");
    const nativeInstance = {
      driver: ProviderDriverKind.make("meerkat"),
      enabled: true,
      environment: [{ name: "OPENAI_API_KEY", value: "", sensitive: true, valueRedacted: true }],
    };
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codexId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
        [nativeId]: nativeInstance,
      },
    };
    atoms.providers = [provider()];
    let panel = renderPanel({ targetInstanceId: codexId });
    const donorEditor = visitElements(
      panel,
      (element) => element.props.instanceId === codexId && element.props.mode === "editor",
    );
    const reset = visitElements(
      donorEditor?.props.headerAction,
      (element) => typeof element.props.onClick === "function",
    );
    const nativeRow = visitElements(
      panel,
      (element) => element.props.instanceId === nativeId && element.props.mode === "list",
    );
    if (!nativeRow || !donorEditor || !reset) throw new Error("Expected provider controls");
    (nativeRow.props.onSelect as () => void)();
    panel = renderPanel();
    const nativeEditor = visitElements(
      panel,
      (element) => element.props.instanceId === nativeId && element.props.mode === "editor",
    );
    if (!nativeEditor) throw new Error("Expected native provider editor");
    const credentials = visitElements(
      nativeEditor?.props.credentials,
      (element) => typeof element.props.onActivityChange === "function",
    );
    expect(credentials).not.toBeNull();
    const activity = credentials!.props.onActivityChange as (pending: boolean) => void;
    activity(true);

    // These callbacks were captured before React rendered the disabled controls.
    expect(
      await (nativeEditor.props.onUpdate as (value: unknown) => Promise<boolean>)({
        ...nativeInstance,
        displayName: "Would overwrite the key",
      }),
    ).toBe(false);
    (nativeEditor.props.onDelete as () => void)();
    expect(
      await (donorEditor.props.onUpdate as (value: unknown) => Promise<boolean>)({
        driver: "codex",
        enabled: false,
      }),
    ).toBe(false);
    (reset.props.onClick as () => void)();
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
    expect(commands.updateProviderSettings).not.toHaveBeenCalled();

    panel = renderPanel();
    const pendingEditor = visitElements(
      panel,
      (element) => element.props.instanceId === nativeId && element.props.mode === "editor",
    );
    expect(pendingEditor?.props.instanceWritesPending).toBe(true);
    const pendingCredentials = visitElements(
      pendingEditor?.props.credentials,
      (element) => typeof element.props.onActivityChange === "function",
    );
    expect(pendingCredentials?.props.readOnly).toBe(true);

    const savedEnvironment = [
      ...nativeInstance.environment,
      { name: "ANTHROPIC_API_KEY", value: "", sensitive: true, valueRedacted: true },
    ];
    settingsState.value = {
      ...settingsState.value,
      providerInstances: {
        ...settingsState.value.providerInstances,
        [nativeId]: { ...nativeInstance, environment: savedEnvironment },
      },
    };
    activity(false);
    panel = renderPanel();
    const latestEditor = visitElements(
      panel,
      (element) => element.props.instanceId === nativeId && element.props.mode === "editor",
    );
    if (!latestEditor) throw new Error("Expected latest native provider editor");
    expect(
      await (latestEditor.props.onUpdate as (value: unknown) => Promise<boolean>)({
        ...nativeInstance,
        environment: savedEnvironment,
        displayName: "Updated name",
      }),
    ).toBe(true);
    expect(commands.updateProviderSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        kind: "edit",
        instanceId: nativeId,
        driver: nativeInstance.driver,
        changes: { displayName: "Updated name" },
      },
    });
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
  });

  it("keeps provider selection available while write controls are read only", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    };
    atoms.providers = [provider()];
    let panel = renderPanel({ readOnly: true });

    const inertWrapper = visitElements(panel, (element) => element.props.inert === true);
    expect(inertWrapper).not.toBeNull();

    const customRow = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "list",
    );
    expect(customRow?.props.readOnly).toBe(true);
    expect(customRow?.props.onSelect).toBeTypeOf("function");
    (customRow?.props.onSelect as (() => void) | undefined)?.();

    panel = renderPanel({ readOnly: true });
    const customEditor = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "editor",
    );
    expect(customEditor).not.toBeNull();

    const notice = visitElements(panel, (element) => element.props.title === "Limited permissions");
    expect(notice).not.toBeNull();

    expect(visitElements(panel, isRefreshButton)).toBeNull();
    expect(visitElements(panel, isAddProviderButton)).toBeNull();
  });

  it("keeps the editable layout interactive when not read only", () => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    expect(visitElements(panel, (element) => element.props.inert === true)).toBeNull();
    expect(
      visitElements(panel, (element) => element.props.title === "Limited permissions"),
    ).toBeNull();
    expect(visitElements(panel, isRefreshButton)).not.toBeNull();
    expect(visitElements(panel, isAddProviderButton)).not.toBeNull();
  });

  it("keeps Advanced visible when search targets the provider health interval", () => {
    let panel = renderPanel();
    expect(visitElements(panel, (element) => element.props.title === "Advanced")).not.toBeNull();
    expect(
      visitElements(panel, (element) => element.props.id === "provider-health-check-interval"),
    ).not.toBeNull();

    settingsSearchState.targetId = "provider-health-check-interval";
    panel = renderPanel();
    expect(visitElements(panel, (element) => element.props.title === "Advanced")).not.toBeNull();
    expect(
      visitElements(panel, (element) => element.props.id === "provider-health-check-interval"),
    ).not.toBeNull();
  });

  it("deletes and resets provider configuration without erasing shared preferences", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
        },
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
      providerModelPreferences: {
        [customId]: { hiddenModels: ["hidden"], modelOrder: ["model"] },
      },
      favorites: [{ provider: customId, model: "favorite" }],
    };
    let panel = renderPanel();
    const customRow = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "list",
    );
    (customRow?.props.onSelect as (() => void) | undefined)?.();
    panel = renderPanel();
    const customCard = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "editor",
    );
    expect(customCard).not.toBeNull();
    (customCard?.props.onDelete as (() => void) | undefined)?.();

    expect(commands.updateProviderSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { kind: "delete", instanceId: customId },
    });

    commands.updateProviderSettings.mockClear();
    const defaultRow = visitElements(
      panel,
      (element) => element.props.instanceId === codexId && element.props.mode === "list",
    );
    (defaultRow?.props.onSelect as (() => void) | undefined)?.();
    panel = renderPanel();
    const defaultCard = visitElements(
      panel,
      (element) => element.props.instanceId === codexId && element.props.mode === "editor",
    );
    const resetAction = defaultCard?.props.headerAction;
    const resetButton = visitElements(
      resetAction,
      (element) => typeof element.props.onClick === "function",
    );
    expect(resetButton).not.toBeNull();
    (resetButton?.props.onClick as (() => void) | undefined)?.();

    expect(commands.updateProviderSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { kind: "resetDefault", driver: "codex" },
    });
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
    expect(settingsState.updateClientSettings).not.toHaveBeenCalled();
  });
});

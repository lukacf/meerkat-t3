import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentPresentation } from "../../state/environments";

const state = vi.hoisted(() => ({
  environments: [] as EnvironmentPresentation[],
  primaryId: null as EnvironmentId | null,
  isReady: true,
  primarySession: { data: null as unknown, error: null as string | null, isPending: true },
  remoteSession: { data: null as unknown, hasError: false, isPending: true },
}));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments, isReady: state.isReady }),
  usePrimaryEnvironmentId: () => state.primaryId,
}));
vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => state.primarySession,
}));
vi.mock("../../state/session", () => ({ useEnvironmentSessionState: () => state.remoteSession }));
vi.mock("./ProviderAccountsPanel", () => ({
  ProviderAccountsPanel: (props: Record<string, unknown>) => (
    <section {...props} data-account-panel />
  ),
}));
vi.mock("./settingsLayout", () => ({ SettingsPageContainer: "div", SettingsSection: "div" }));
vi.mock("./settingsSearch", () => ({ searchableSetting: () => ({}) }));
vi.mock("./SettingsGroup", () => ({ SettingsGroup: "div" }));
vi.mock("./ExpandableText", () => ({
  ExpandableText: ({ text }: { text: string }) => <p>{text}</p>,
}));
vi.mock("../EnvironmentMachineIcon", () => ({ EnvironmentMachineIcon: "span" }));
vi.mock("../ConnectionStatusDot", () => ({
  ConnectionStatusDot: "span",
  connectionPhaseDotClassName: () => "",
  connectionPhasePingClassName: () => "",
}));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/toggle-group", () => ({ Toggle: "button", ToggleGroup: "fieldset" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "div",
  TooltipPopup: "div",
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
}));
vi.mock("../ui/empty", () => ({
  Empty: "div",
  EmptyContent: "div",
  EmptyDescription: "p",
  EmptyHeader: "div",
  EmptyMedia: "span",
  EmptyTitle: "h2",
}));

import { EnvironmentProviderSettings, ProviderSettingsPanel } from "./ProviderSettingsPanel";

const primaryId = EnvironmentId.make("primary-device");
const remoteId = EnvironmentId.make("remote-device");
const instanceId = ProviderInstanceId.make("meerkat-work");
const environment = (
  id: EnvironmentId,
  primary: boolean,
  phase = "connected",
): EnvironmentPresentation =>
  ({
    environmentId: id,
    label: primary ? "This device" : "Work server",
    displayUrl: null,
    relayManaged: false,
    entry: {
      target: primary
        ? { _tag: "PrimaryConnectionTarget", label: "This device" }
        : { _tag: "SshConnectionTarget", label: "Work server" },
    },
    connection: { phase, error: null, traceId: null },
    serverConfig: { environment: { platform: { machine: "server" } } },
  }) as EnvironmentPresentation;
let renderer: ReactTestRenderer | undefined;
const render = (target: Parameters<typeof ProviderSettingsPanel>[0] = {}) =>
  act(() => {
    renderer = create(<ProviderSettingsPanel {...target} />);
  });
const update = (target: Parameters<typeof ProviderSettingsPanel>[0] = {}) =>
  act(() => {
    renderer!.update(<ProviderSettingsPanel {...target} />);
  });
const panels = () =>
  renderer!.root.findAllByType("section").filter((node) => node.props["data-account-panel"]);
const text = () => JSON.stringify(renderer!.toJSON());
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.primaryId = primaryId;
  state.isReady = true;
  state.environments = [environment(primaryId, true), environment(remoteId, false)];
  state.primarySession = {
    data: { authenticated: true, scopes: [AuthOrchestrationOperateScope] },
    error: null,
    isPending: false,
  };
  state.remoteSession = {
    data: { authenticated: true, scopes: [AuthOrchestrationOperateScope] },
    hasError: false,
    isPending: false,
  };
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("Provider account environment routing", () => {
  it("passes exact environment, native instance and readonly status without runtime CRUD", () => {
    act(() => {
      renderer = create(
        <EnvironmentProviderSettings
          environmentId={remoteId}
          environmentLabel="Work server"
          targetInstanceId={instanceId}
          readOnly
        />,
      );
    });
    expect(panels()).toHaveLength(1);
    expect(panels()[0]!.props).toMatchObject({
      environmentId: remoteId,
      environmentLabel: "Work server",
      instanceId,
      readOnly: true,
    });
    expect(text()).not.toContain("Add provider");
    expect(text()).not.toContain("Codex");
  });

  it("opens explicit device accounts and does not reuse that instance when switching devices", () => {
    render({ environmentId: remoteId, instanceId });
    expect(panels()[0]!.props).toMatchObject({
      environmentId: remoteId,
      instanceId,
      readOnly: false,
    });
    act(() => renderer!.root.findByType("fieldset").props.onValueChange([primaryId]));
    expect(panels()[0]!.props.environmentId).toBe(primaryId);
    expect(panels()[0]!.props.instanceId).toBeUndefined();
  });

  it("never substitutes local accounts for an explicit missing device", () => {
    state.environments = [environment(primaryId, true)];
    render({ environmentId: remoteId, instanceId });
    expect(panels()).toHaveLength(0);
    expect(text()).toContain("Device unavailable");
  });

  it("keeps scoped settings on their device and hides device switching", () => {
    render({ environmentId: remoteId, instanceId, scoped: true });
    expect(panels()[0]!.props.environmentId).toBe(remoteId);
    expect(renderer!.root.findAllByType("fieldset")).toHaveLength(0);
  });

  it("does not render account actions while device permission is unresolved", () => {
    state.remoteSession = { data: null, hasError: false, isPending: true };
    render({ environmentId: remoteId });
    expect(panels()).toHaveLength(0);
    expect(text()).toContain("Checking what this session is allowed to change");
  });

  it("makes accounts readonly for an explicitly denied remote session", () => {
    state.remoteSession = {
      data: { authenticated: true, scopes: ["orchestration:read"] },
      hasError: false,
      isPending: false,
    };
    render({ environmentId: remoteId });
    expect(panels()[0]!.props.readOnly).toBe(true);
    state.remoteSession = {
      data: { authenticated: true, scopes: [AuthOrchestrationOperateScope] },
      hasError: false,
      isPending: true,
    };
    update({ environmentId: remoteId });
    expect(panels()[0]!.props.readOnly).toBe(false);
  });

  it("checks primary browser permissions instead of assuming desktop authority", () => {
    state.primarySession = {
      data: { authenticated: true, scopes: [] },
      error: null,
      isPending: false,
    };
    render();
    expect(panels()[0]!.props).toMatchObject({ environmentId: primaryId, readOnly: true });
    state.primarySession = { data: null, error: null, isPending: true };
    update();
    expect(panels()).toHaveLength(0);
  });

  it.each(["offline", "reconnecting", "error"])("hides credential UI for a %s device", (phase) => {
    state.environments = [environment(remoteId, false, phase)];
    render({ environmentId: remoteId });
    expect(panels()).toHaveLength(0);
  });

  it("waits for configuration before rendering a connected device", () => {
    state.environments = [{ ...environment(remoteId, false), serverConfig: null }];
    render({ environmentId: remoteId });
    expect(panels()).toHaveLength(0);
    expect(text()).toContain("configuration");
  });

  it("shows a useful empty state before any device is available", () => {
    state.environments = [];
    render();
    expect(panels()).toHaveLength(0);
    expect(text()).toContain("No connected devices");
  });
});

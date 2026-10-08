import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { act, StrictMode, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({ refresh: vi.fn(), update: vi.fn() }));
const providers = vi.hoisted(() => new Map<EnvironmentId, ReadonlyArray<ServerProvider>>());
const environmentA = EnvironmentId.make("computer-a");
const environmentB = EnvironmentId.make("computer-b");
const instanceId = ProviderInstanceId.make("meerkat");
const success = AsyncResult.success({ providers: [] });
const failure = AsyncResult.failure(Cause.fail({ detail: "synthetic-provider-secret" }));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (environmentId: EnvironmentId) => providers.get(environmentId),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: (id: EnvironmentId) => id,
    refreshProviders: "refresh",
    updateProvider: "update",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "refresh" | "update") => commands[command],
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: {
      [instanceId]: { driver: "meerkat", enabled: true },
    },
  }),
  useUpdateEnvironmentSettings: () => commands.update,
  useUpdateClientSettings: () => commands.update,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => [],
  usePrimaryEnvironmentId: () => environmentA,
}));
vi.mock("../../environments/primary", () => ({ usePrimarySessionState: () => null }));
vi.mock("../../state/session", () => ({ useEnvironmentSessionState: () => null }));
vi.mock("./useSettingsProviderReadiness", () => ({
  useSettingsProviderReadiness: (_id: EnvironmentId, value: ReadonlyArray<ServerProvider>) => ({
    providers: value,
    pendingInstanceIds: new Set(),
    cwd: null,
    projectScoped: false,
    operateAccess: "granted",
  }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsRow: () => null,
  PolicyTooltip: () => null,
  SettingResetButton: () => null,
  useRelativeTimeTick: () => undefined,
  useSettingsSearchTargetId: () => null,
}));
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() }, stackedThreadToast: vi.fn() }));
vi.mock("./ProviderInstanceCard", () => ({
  ProviderInstanceCard: ({ liveProvider }: { liveProvider?: ServerProvider }) => (
    <div>{liveProvider?.message}</div>
  ),
}));
vi.mock("./AddProviderInstanceDialog", () => ({ AddProviderInstanceDialog: () => null }));
vi.mock("./MeerkatCredentialsEditor", () => ({ MeerkatCredentialsEditor: () => null }));
vi.mock("../team/MeerkatProviderControls", () => ({ MeerkatProviderControls: () => null }));
vi.mock("./UsageProviderSettings", () => ({ UsageProviderSettings: () => null }));
vi.mock("./ProviderSetupSection", () => ({
  ProviderSetupSection: () => null,
  readAntigravityAuthMethod: () => undefined,
}));

import { EnvironmentProviderSettings } from "./ProviderSettingsPanel";

let renderer: ReactTestRenderer | undefined;
function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join("");
}
function refreshButton() {
  return renderer!.root
    .findAllByType("button")
    .find((node) => text(node).includes("Refresh provider status"))!;
}
function alerts() {
  return renderer!.root.findAllByProps({ role: "alert" }).map(text);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
async function render(environmentId = environmentA) {
  await act(async () => {
    const element = (
      <StrictMode>
        <EnvironmentProviderSettings
          environmentId={environmentId}
          environmentLabel={environmentId === environmentA ? "Computer A" : "Computer B"}
          targetInstanceId={instanceId}
        />
      </StrictMode>
    );
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}
async function refresh() {
  await act(async () => refreshButton().props.onClick());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  commands.refresh.mockReset().mockResolvedValue(success);
  commands.update.mockReset();
  providers.clear();
  for (const id of [environmentA, environmentB]) {
    providers.set(id, [
      {
        instanceId,
        driver: ProviderDriverKind.make("meerkat"),
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-04T00:00:00.000Z",
        models: [],
        slashCommands: [],
        skills: [],
        message: `Last known status for ${id}`,
      },
    ]);
  }
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("shows a safe scoped error, preserves cached status, and clears the error after a successful retry", async () => {
  commands.refresh.mockResolvedValueOnce(failure);
  await render();
  const cached = providers.get(environmentA);
  await refresh();
  expect(alerts()).toEqual([
    "Could not refresh provider status for Computer A. The displayed status may be out of date. Use Refresh provider status to try again.",
  ]);
  expect(text(renderer!.root)).not.toContain("synthetic-provider-secret");
  expect(text(renderer!.root)).toContain(`Last known status for ${environmentA}`);
  expect(providers.get(environmentA)).toBe(cached);
  expect(commands.update).not.toHaveBeenCalled();
  expect(refreshButton().props.disabled).toBe(false);

  const retry = deferred<typeof success>();
  commands.refresh.mockReturnValueOnce(retry.promise);
  await act(async () => {
    const click = refreshButton().props.onClick;
    click();
    click();
  });
  expect(commands.refresh).toHaveBeenCalledTimes(2);
  expect(commands.refresh).toHaveBeenLastCalledWith({
    environmentId: environmentA,
    input: { refreshModels: true },
  });
  expect(refreshButton().props.disabled).toBe(true);
  expect(alerts()).toHaveLength(1);
  await act(async () => retry.resolve(success));
  expect(alerts()).toEqual([]);
  expect(refreshButton().props.disabled).toBe(false);
});

it.each([success, failure])(
  "ignores a late previous-computer result while the current refresh is pending ($_tag)",
  async (oldResult) => {
    const first = deferred<typeof oldResult>();
    const second = deferred<typeof failure>();
    commands.refresh.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await render();
    await refresh();
    await render(environmentB);
    expect(refreshButton().props.disabled).toBe(false);
    expect(alerts()).toEqual([]);
    await refresh();
    await act(async () => first.resolve(oldResult));
    expect(refreshButton().props.disabled).toBe(true);
    expect(alerts()).toEqual([]);
    await act(async () => second.resolve(failure));
    expect(alerts()[0]).toContain("Computer B");
    expect(alerts()[0]).not.toContain("Computer A");
    expect(refreshButton().props.disabled).toBe(false);
  },
);

it("clears an old failure when changing computers without replaying it on return", async () => {
  commands.refresh.mockResolvedValueOnce(failure);
  await render();
  await refresh();
  expect(alerts()).toHaveLength(1);
  await render(environmentB);
  expect(alerts()).toEqual([]);
  await render(environmentA);
  expect(alerts()).toEqual([]);
  expect(commands.refresh).toHaveBeenCalledTimes(1);
});

it("does not announce interruption as a provider failure and permits retry", async () => {
  commands.refresh.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
  await render();
  await refresh();
  expect(alerts()).toEqual([]);
  expect(refreshButton().props.disabled).toBe(false);
  await refresh();
  expect(commands.refresh).toHaveBeenCalledTimes(2);
  expect(alerts()).toEqual([]);
});

it("does not restore an unmounted request's failure on a fresh panel for the same computer", async () => {
  const first = deferred<typeof failure>();
  commands.refresh.mockReturnValueOnce(first.promise);
  await render();
  await refresh();
  await act(async () => renderer!.unmount());
  renderer = undefined;
  await render();
  await refresh();
  await act(async () => first.resolve(failure));
  expect(alerts()).toEqual([]);
  expect(refreshButton().props.disabled).toBe(false);
});

import {
  EnvironmentId,
  SHARED_LOCAL_ENVIRONMENT_ID,
  type DesktopSharedHostState,
} from "@t3tools/contracts";
import { BearerConnectionTarget } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentPresentation } from "../../state/environments";

const state = vi.hoisted(() => ({ environments: [] as EnvironmentPresentation[], retry: vi.fn() }));
vi.mock("../../state/environments", () => ({ useEnvironments: () => state }));
vi.mock("../../connection/catalog", () => ({ environmentCatalog: { retryNow: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.retry }));
vi.mock("./SharedHostSettings", () => ({
  SharedHostSettings: () => <section>Workspace setup</section>,
}));
vi.mock("./settingsLayout", () => ({ SettingsSection: "section" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
import { LocalSharedHostSettings } from "./LocalSharedHostSettings";

const stopped: DesktopSharedHostState = { enabled: false, status: "stopped", error: null };
const running: DesktopSharedHostState = { enabled: true, status: "running", error: null };
let renderer: ReactTestRenderer | undefined;
const getState = vi.fn<() => Promise<DesktopSharedHostState>>();
const setEnabled = vi.fn<(enabled: boolean) => Promise<DesktopSharedHostState>>();
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((node) => node.children.includes(label))!;
const text = () => JSON.stringify(renderer!.toJSON());
function host(
  phase: EnvironmentPresentation["connection"]["phase"],
  id = "shared-host",
): EnvironmentPresentation {
  const environmentId = EnvironmentId.make(id);
  return {
    environmentId,
    label: "This Mac's shared host",
    displayUrl: null,
    relayManaged: false,
    serverConfig: null,
    connection: {
      phase,
      error: phase === "error" ? "The connection credential is unavailable." : null,
      traceId: null,
    },
    entry: {
      target: new BearerConnectionTarget({
        environmentId,
        label: "Shared host",
        connectionId: `local:${SHARED_LOCAL_ENVIRONMENT_ID}`,
      }),
      enabled: true,
      profile: Option.none(),
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  state.environments = [];
  state.retry.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  getState.mockReset().mockResolvedValue(stopped);
  setEnabled.mockReset().mockResolvedValue(running);
  vi.stubGlobal("window", {
    desktopBridge: { getSharedHostState: getState, setSharedHostEnabled: setEnabled },
  });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => {
    renderer = create(<LocalSharedHostSettings />);
  });
}

it("observes host state without opting in until the user starts it", async () => {
  await render();
  expect(getState).toHaveBeenCalledOnce();
  expect(setEnabled).not.toHaveBeenCalled();
  await act(async () => button("Host on this Mac").props.onClick());
  expect(setEnabled).toHaveBeenCalledExactlyOnceWith(true);
  expect(text()).toContain("Host running; connecting this app");
  setEnabled.mockResolvedValueOnce(stopped);
  await act(async () => button("Stop shared host").props.onClick());
  expect(setEnabled).toHaveBeenLastCalledWith(false);
  expect(text()).toContain("Stopped");
});

it("keeps applied host state while polling fails and exposes recovery without a second start", async () => {
  getState.mockResolvedValue(running);
  await render();
  getState.mockRejectedValueOnce(new Error("IPC unavailable"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(text()).toContain("Could not check the local shared host");
  expect(button("Stop shared host").props.disabled).toBe(false);
  expect(setEnabled).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(text()).not.toContain("Could not check the local shared host");
});

it("retries an unavailable host without treating a failed write as stopped", async () => {
  getState.mockResolvedValue({ enabled: true, status: "unavailable", error: "Port is in use." });
  await render();
  expect(text()).toContain("Port is in use.");
  await act(async () => button("Retry").props.onClick());
  expect(setEnabled).toHaveBeenCalledExactlyOnceWith(true);
  setEnabled.mockRejectedValueOnce(new Error("settings write failed"));
  await act(async () => button("Stop shared host").props.onClick());
  expect(text()).toContain("could not be applied");
  expect(text()).toContain("Host running; connecting this app");
  expect(button("Stop shared host")).toBeDefined();
});

it("keeps the host controllable while connection enrollment is pending", async () => {
  getState.mockResolvedValue(running);
  await render();
  expect(text()).toContain("Host running; connecting this app");
  expect(text()).toContain("If macOS shows a Keychain prompt");
  expect(text()).not.toContain("Workspace setup");
  expect(button("Stop shared host").props.disabled).toBe(false);
  expect(button("Retry connection")).toBeUndefined();
  await act(async () => {
    state.environments = [host("connected")];
    renderer!.update(<LocalSharedHostSettings />);
  });
  expect(text()).toContain("Workspace setup");
  expect(text()).not.toContain("Keychain prompt");
});

it("retries only this app's denied enrollment and keeps failures visible across host polls", async () => {
  getState.mockResolvedValue(running);
  state.environments = [host("error")];
  state.retry.mockResolvedValueOnce({ _tag: "Failure", cause: "secret must not render" });
  await render();
  expect(text()).toContain("connection needs attention");
  expect(text()).toContain("credential is unavailable");
  await act(async () => button("Retry connection").props.onClick());
  expect(state.retry).toHaveBeenCalledExactlyOnceWith(EnvironmentId.make("shared-host"));
  expect(setEnabled).not.toHaveBeenCalled();
  expect(text()).toContain("Check that macOS secure storage is available");
  expect(text()).not.toContain("secret must not render");
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(text()).toContain("Check that macOS secure storage is available");
  await act(async () => button("Retry connection").props.onClick());
  expect(state.retry).toHaveBeenCalledTimes(2);
  expect(text()).not.toContain("Check that macOS secure storage is available");
  expect(text()).not.toContain("Workspace setup");
});

it("does not apply a stale retry failure after the host identity changes", async () => {
  getState.mockResolvedValue(running);
  state.environments = [host("error")];
  let finish!: (value: unknown) => void;
  state.retry.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  await act(async () => button("Retry connection").props.onClick());
  expect(button("Retrying connection...").props.disabled).toBe(true);
  expect(button("Stop shared host").props.disabled).toBe(false);
  await act(async () => {
    state.environments = [host("error", "replacement-host")];
    renderer!.update(<LocalSharedHostSettings />);
  });
  await act(async () => finish({ _tag: "Failure", cause: "old failure" }));
  expect(text()).not.toContain("Check that macOS secure storage is available");
  expect(button("Retry connection").props.disabled).toBe(false);
  await act(async () => button("Retry connection").props.onClick());
  expect(state.retry).toHaveBeenLastCalledWith(EnvironmentId.make("replacement-host"));
  expect(setEnabled).not.toHaveBeenCalled();
});

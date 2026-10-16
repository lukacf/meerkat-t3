import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const environmentId = EnvironmentId.make("local");
const state = vi.hoisted(() => ({
  phase: "connected",
  access: "editable",
  exists: true,
  mounted: vi.fn(),
}));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: state.exists
      ? [
          {
            environmentId,
            label: "This Mac",
            connection: { phase: state.phase },
            serverConfig: {},
            entry: { target: { _tag: "PrimaryConnectionTarget" } },
          },
        ]
      : [],
  }),
}));
vi.mock("../../environments/primary", () => ({ usePrimarySessionState: vi.fn() }));
vi.mock("../../state/session", () => ({ useEnvironmentSessionState: vi.fn() }));
vi.mock("../settings/ProviderSettingsPanel.logic", () => ({
  classifyProviderEnvironmentAccess: () => ({ kind: state.access }),
  resolvePrimaryOperateAccess: vi.fn(),
  resolveRemoteOperateAccess: vi.fn(),
}));
vi.mock("../settings/ProviderAccountsPanel", () => ({
  ProviderAccountsPanel: () => {
    state.mounted();
    return <section>Provider accounts</section>;
  },
}));
import { OnboardingCredentials } from "./OnboardingCredentials";
let renderer: ReactTestRenderer | undefined;
async function render() {
  await act(async () => {
    renderer = create(
      <OnboardingCredentials
        environmentId={environmentId}
        onPendingChange={vi.fn()}
        onErrorChange={vi.fn()}
      />,
    );
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.phase = "connected";
  state.access = "editable";
  state.exists = true;
  state.mounted.mockReset();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
it("opens the native account surface for an authorized connected computer", async () => {
  await render();
  expect(state.mounted).toHaveBeenCalled();
});
it.each(["read-only", "disconnected", "pending"])(
  "does not mount credential controls for %s access",
  async (access) => {
    state.access = access;
    await render();
    expect(state.mounted).not.toHaveBeenCalled();
    expect(renderer!.root.findByProps({ role: "status" })).toBeDefined();
  },
);
it("does not resolve a missing computer to a different credential target", async () => {
  state.exists = false;
  await render();
  expect(state.mounted).not.toHaveBeenCalled();
  expect(renderer!.root.findByProps({ role: "status" }).children.join("")).toContain(
    "Reconnect this computer",
  );
});

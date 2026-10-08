import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, type MeerkatUsageSnapshot } from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  data: null as MeerkatUsageSnapshot | null,
  error: null as string | null,
  isPending: false,
  refresh: vi.fn(),
  requested: vi.fn(),
}));
vi.mock("../../state/meerkatControls", () => ({
  meerkatControlsEnvironment: { usageSnapshot: state.requested },
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => state }));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
import { NativeUsageCard } from "./NativeUsageSection";

const props = {
  environmentId: EnvironmentId.make("local"),
  instanceId: ProviderInstanceId.make("native"),
  label: "This Mac / Meerkat",
};
const snapshot: MeerkatUsageSnapshot = {
  instanceId: props.instanceId,
  observedAt: "2026-10-04T10:00:00.000Z",
  scope: "current-provider-storage",
  coverage: "complete",
  stores: 1,
  sessions: 3,
  totals: {
    inputTokens: 123456,
    outputTokens: 9876,
    cacheReadTokens: null,
    cacheCreationTokens: 0,
    reasoningTokens: null,
  },
  issues: [],
  exclusions: ["auxiliary-generation", "previous-provider-storage"],
};
let renderer: ReactTestRenderer | null = null;
const text = () => JSON.stringify(renderer?.toJSON());
const render = () =>
  act(() => {
    renderer = create(<NativeUsageCard {...props} />);
  });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.data = null;
  state.error = null;
  state.isPending = false;
  state.requested.mockReset();
  state.refresh.mockReset();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

it("loads a snapshot on demand and distinguishes missing counters from measured zero", async () => {
  render();
  expect(state.requested).not.toHaveBeenCalled();
  await act(async () => renderer!.root.findByType("button").props.onClick());
  expect(state.requested).toHaveBeenCalledWith({
    environmentId: props.environmentId,
    input: { instanceId: props.instanceId },
  });
  state.data = snapshot;
  act(() => renderer!.update(<NativeUsageCard {...props} />));
  expect(text()).toContain((123456).toLocaleString());
  expect(text()).toContain("Not reported");
  expect(text()).toContain('"0"');
  await act(async () => renderer!.root.findByType("button").props.onClick());
  expect(state.refresh).toHaveBeenCalledOnce();
});

it("does not turn incomplete coverage into a zero total", () => {
  state.data = {
    ...snapshot,
    coverage: "unavailable",
    totals: null,
    issues: [
      { code: "unreadable-store", store: null, message: "One retained store could not be read." },
    ],
  };
  render();
  expect(text()).toContain("No total is shown");
  expect(text()).toContain("Inspected");
  expect(text()).toContain("One retained store could not be read.");
  expect(renderer!.root.findAllByType("dl")).toHaveLength(0);
});

it("hides stale totals after a refresh fails and leaves retry available", () => {
  state.data = snapshot;
  state.error = "Connection lost";
  render();
  expect(text()).toContain("Usage is unavailable");
  expect(text()).not.toContain((123456).toLocaleString());
  expect(renderer!.root.findByType("button").props.disabled).toBe(false);
});

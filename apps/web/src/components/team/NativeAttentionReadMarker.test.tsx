import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  items: [] as any[],
  markRead: vi.fn(),
  refresh: vi.fn(),
  focused: false,
}));
vi.mock("../../state/meerkatAttention", () => ({
  useMeerkatAttention: () => ({ data: { items: state.items }, refresh: state.refresh }),
}));
vi.mock("../../state/meerkatControls", () => ({
  meerkatControlsEnvironment: { attentionRead: "read" },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.markRead }));
import { NativeAttentionReadMarker } from "./NativeAttentionReadMarker";
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => state.focused }),
  );
  state.focused = false;
  state.markRead.mockReset();
  state.refresh.mockReset();
  state.markRead.mockResolvedValue({ _tag: "Success" });
  state.items = [
    { id: "ours", instanceId: "provider", agentRef: "agent", sessionId: "session", unread: true },
    {
      id: "foreign-session",
      instanceId: "provider",
      agentRef: "agent",
      sessionId: "replacement",
      unread: true,
    },
  ];
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
it("marks only exact visible native activity read, without reading background or replacement sessions", async () => {
  await act(async () => {
    renderer = create(
      <NativeAttentionReadMarker
        environmentId={EnvironmentId.make("remote")}
        projectId={ProjectId.make("project")}
        instanceId={ProviderInstanceId.make("provider")}
        agentRef="agent"
        sessionId="session"
      />,
      { createNodeMock: () => ({ getClientRects: () => [1] }) },
    );
  });
  expect(state.markRead).not.toHaveBeenCalled();
  state.focused = true;
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(state.markRead).toHaveBeenCalledWith({
    environmentId: "remote",
    input: { projectId: "project", itemIds: ["ours"] },
  });
  expect(state.refresh).toHaveBeenCalledOnce();
});
it("does not mark a mounted but hidden split pane read", async () => {
  state.focused = true;
  await act(async () => {
    renderer = create(
      <NativeAttentionReadMarker
        environmentId={EnvironmentId.make("remote")}
        projectId={ProjectId.make("project")}
        instanceId={ProviderInstanceId.make("provider")}
        agentRef="agent"
        sessionId="session"
      />,
      { createNodeMock: () => ({ getClientRects: () => [] }) },
    );
  });
  expect(state.markRead).not.toHaveBeenCalled();
});

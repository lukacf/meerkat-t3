import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  search: {
    nativeAgent: "old-agent",
    nativeSession: "old-session",
    nativeRevision: "7",
    nativeOffset: 823,
  },
  activity: vi.fn(),
  navigate: vi.fn(),
  query: { data: null, error: null, isPending: false, refresh: vi.fn() } as any,
}));
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => state.search,
  useNavigate: () => state.navigate,
}));
vi.mock("../../state/meerkatTeam", () => ({
  meerkatTeamEnvironment: { agentActivity: state.activity },
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => state.query }));
vi.mock("./NativeAgentTranscript", () => ({ NativeAgentTranscript: "article" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
import { NativeSearchConversation } from "./NativeSearchConversation";
const props = {
  environmentId: EnvironmentId.make("remote"),
  projectId: ProjectId.make("project"),
  instanceId: ProviderInstanceId.make("original-provider"),
  label: "Reviewer",
  cwd: "/checkout",
};
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.activity.mockClear();
  state.navigate.mockClear();
  state.query = {
    data: {
      transcript: {
        sessionId: "old-session",
        storeRevision: "7",
        messages: [{ offset: 823, message: { role: "assistant", content: "hit" } }],
        exhausted: false,
        totalMessages: 900,
      },
    },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  };
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
function mount() {
  act(() => {
    renderer = create(<NativeSearchConversation {...props} />);
  });
}
describe("native saved search result", () => {
  it("loads the exact saved message through the owning provider and never renders send controls", () => {
    mount();
    expect(state.activity).toHaveBeenCalledWith({
      environmentId: "remote",
      input: {
        projectId: "project",
        instanceId: "original-provider",
        agentRef: "old-agent",
        limit: 100,
        transcriptRevision: "7",
        transcriptBefore: 824,
      },
    });
    expect(renderer!.root.findByType("article").props.initial.sessionId).toBe(
      "old-session",
    );
    expect(renderer!.root.findAllByType("textarea")).toHaveLength(0);
  });
  it("refuses another session instead of showing a replacement agent's history", () => {
    state.query.data.transcript.sessionId = "replacement";
    mount();
    expect(renderer!.root.findAllByType("article")).toHaveLength(0);
    expect(JSON.stringify(renderer!.toJSON())).toContain("no longer matches");
  });
  it("returns to the current conversation without carrying any stale search identity", () => {
    mount();
    act(() => renderer!.root.findByType("button").props.onClick());
    const navigation = state.navigate.mock.calls[0]![0];
    expect(
      navigation.search({
        ...state.search,
        nativeInstance: "original-provider",
        project: "project",
        member: "old-agent",
      }),
    ).toEqual({ project: "project", member: "old-agent" });
  });
});

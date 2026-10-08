import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  thread: null as { title: string; worktreePath: string | null; runtimeMode?: string } | null,
  search: {} as Record<string, string>,
  openFile: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => state.search,
  useParams: () => ({ environmentId: "remote", threadId: "owner" }),
}));
vi.mock("../../state/entities", () => ({
  useProject: () => ({ workspaceRoot: "/repo", title: "Project" }),
  useThreadShell: () => state.thread,
}));
vi.mock("../../state/meerkatTeam", () => ({
  meerkatTeamEnvironment: { projectTeam: () => "team", agentActivity: () => "history" },
  useVisibleTeamRefresh() {},
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    error: null,
    refresh() {},
    data: {
      providers: [
        {
          instanceId: "native",
          agents: [{ threadId: "owner", agentRef: "worker", record: { display_name: "Worker" } }],
        },
      ],
    },
  }),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("./ConversationWorkspaceChrome", () => ({ ConversationWorkspaceControls: () => null }));
vi.mock("./AgentWorkspaceTools", () => ({
  AgentHeaderIdentity: () => null,
  AgentWorkspaceTools: () => null,
}));
vi.mock("./AgentConversation", () => ({
  AgentConversation: ({ cwd, accessMode }: { cwd: string | undefined; accessMode?: string }) => (
    <button
      data-access-mode={accessMode}
      disabled={!cwd}
      onClick={() => cwd && state.openFile(cwd)}
    >
      Conversation file
    </button>
  ),
}));
vi.mock("./NativeAttentionConversation", () => ({
  NativeAttentionConversation: ({
    cwd,
    accessMode,
  }: {
    cwd: string | undefined;
    accessMode?: string;
  }) => (
    <button
      data-access-mode={accessMode}
      disabled={!cwd}
      onClick={() => cwd && state.openFile(cwd)}
    >
      Attention file
    </button>
  ),
}));
vi.mock("./NativeSearchConversation", () => ({
  NativeSearchConversation: ({ cwd }: { cwd: string | undefined }) => (
    <button disabled={!cwd} onClick={() => cwd && state.openFile(cwd)}>
      Search file
    </button>
  ),
}));
import { NativeThreadAgentConversation } from "./NativeThreadAgentConversation";

const props = {
  environmentId: EnvironmentId.make("remote"),
  projectId: ProjectId.make("project"),
  instanceId: ProviderInstanceId.make("native"),
  threadId: ThreadId.make("owner"),
  agentRef: "worker",
  onBack() {},
};
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.thread = null;
  state.search = {};
  state.openFile.mockReset();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it.each([
  ["Conversation file", {}],
  ["Attention file", { attention: "request", member: "worker" }],
  ["Search file", { nativeAgent: "worker" }],
] as const)(
  "keeps %s without checkout authority until its owner arrives",
  async (label, search) => {
    state.search = search;
    await act(async () => {
      renderer = create(<NativeThreadAgentConversation {...props} />);
    });
    const file = () =>
      renderer!.root.findAllByType("button").find((node) => node.children.includes(label))!;
    expect(file().props.disabled).toBe(true);
    await act(async () => file().props.onClick());
    expect(state.openFile).not.toHaveBeenCalled();
    state.thread = { title: "Owner", worktreePath: "/worktrees/review" };
    await act(async () => renderer!.update(<NativeThreadAgentConversation {...props} />));
    expect(file().props.disabled).toBe(false);
    await act(async () => file().props.onClick());
    expect(state.openFile).toHaveBeenLastCalledWith("/worktrees/review");
    state.thread = null;
    await act(async () => renderer!.update(<NativeThreadAgentConversation {...props} />));
    expect(file().props.disabled).toBe(true);
    expect(state.openFile).not.toHaveBeenCalledWith("/repo");
  },
);

it.each([
  ["Conversation file", {}],
  ["Attention file", { attention: "request", member: "worker" }],
] as const)("passes the owning Read-only mode into %s", async (label, search) => {
  state.search = search;
  state.thread = { title: "Owner", worktreePath: "/worktrees/review", runtimeMode: "read-only" };
  await act(async () => {
    renderer = create(<NativeThreadAgentConversation {...props} />);
  });
  const view = renderer!.root
    .findAllByType("button")
    .find((node) => node.children.includes(label))!;
  expect(view.props["data-access-mode"]).toBe("read-only");
});

import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  search: { attention: "attention", attentionInstance: "provider", project: "project" },
  navigate: vi.fn(),
  activity: vi.fn(),
  answer: vi.fn(),
  markRead: vi.fn(),
  item: null as any,
  transcriptSession: "session",
  activityAgent: undefined as any,
  queryError: null as string | null,
  refresh: vi.fn(),
  team: null as any,
  focused: false,
}));
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => state.search,
  useNavigate: () => state.navigate,
}));
vi.mock("../../state/meerkatAttention", () => ({
  useMeerkatAttention: () => ({
    data: { items: state.item ? [state.item] : [] },
    error: state.queryError,
    isPending: false,
    refresh: state.refresh,
  }),
}));
vi.mock("../../state/meerkatTeam", () => ({
  meerkatTeamEnvironment: { agentActivity: state.activity, projectTeam: () => "project-team" },
}));
vi.mock("../../state/meerkatControls", () => ({
  meerkatControlsEnvironment: { answer: "answer", attentionRead: "read" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "read" ? state.markRead : state.answer),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: unknown) => ({
    data:
      query === "project-team"
        ? state.team
        : {
            agent: state.activityAgent,
            transcript: state.transcriptSession
              ? { sessionId: state.transcriptSession, storeRevision: "7" }
              : undefined,
          },
    isPending: false,
    error: null,
    refresh: state.refresh,
  }),
  formatEnvironmentQueryError: (cause: unknown) => String(cause),
}));
vi.mock("./NativeAgentTranscript", () => ({ NativeAgentTranscript: "article" }));
vi.mock("./AgentConversation", () => ({
  AgentConversation: () => <main>Agent conversation</main>,
}));
vi.mock("./ProjectAgentPanel", () => ({
  ProjectAgentPanel: () => <main>Project agent conversation</main>,
}));
vi.mock("./AgentQuestionCard", () => ({ AgentQuestionCard: "aside" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
import { NativeAttentionConversation } from "./NativeAttentionConversation";
let renderer: ReactTestRenderer | undefined;
const props = {
  environmentId: EnvironmentId.make("remote"),
  projectId: ProjectId.make("project"),
  projectAgentId: "owner",
  cwd: "/checkout",
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => state.focused }),
  );
  state.activity.mockClear();
  state.answer.mockReset();
  state.markRead.mockReset();
  state.markRead.mockResolvedValue({ _tag: "Success" });
  state.refresh.mockReset();
  state.focused = false;
  state.queryError = null;
  state.transcriptSession = "session";
  state.activityAgent = undefined;
  state.team = null;
  state.item = {
    id: "attention",
    projectId: "project",
    instanceId: ProviderInstanceId.make("provider"),
    agentRef: "child-ref",
    sessionId: "session",
    projectAgentId: "owner",
    threadId: null,
    label: "Reviewer",
    title: "Choose",
    kind: "question",
    active: true,
    unread: true,
    question: {
      requestId: "request",
      sessionId: "session",
      mobId: "crew",
      toolCallId: "tool",
      createdAt: "2026-09-28T12:00:00.000Z",
      title: "Choose",
      questions: [],
    },
  };
  state.answer.mockResolvedValue({
    _tag: "Success",
    value: { accepted: true, requestId: "request" },
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
const mount = () =>
  act(() => {
    renderer = create(<NativeAttentionConversation {...props} />, {
      createNodeMock: () => ({ getClientRects: () => [1] }),
    });
  });
describe("offscreen native question view", () => {
  it("rehydrates and answers the exact worker session after opening/reloading its notification", async () => {
    mount();
    expect(state.activity).toHaveBeenCalledWith({
      environmentId: "remote",
      input: { projectId: "project", instanceId: "provider", agentRef: "child-ref", limit: 100 },
    });
    const answers = [{ questionId: "choice", selectedOptionIds: ["yes"], customText: "" }];
    await act(async () => {
      await renderer!.root.findByType("aside").props.onAnswer(answers, false);
    });
    expect(state.answer).toHaveBeenCalledWith({
      environmentId: "remote",
      input: {
        projectId: "project",
        instanceId: "provider",
        agentRef: "child-ref",
        requestId: "request",
        sessionId: "session",
        answers,
        dismissed: false,
      },
    });
    act(() => renderer!.unmount());
    mount();
    expect(renderer!.root.findByType("aside").props.request.requestId).toBe("request");
  });
  it("shows session replacement and answer failure without opening a replacement transcript", async () => {
    state.transcriptSession = "replacement";
    state.answer.mockResolvedValue({
      _tag: "Failure",
      cause: "This question belongs to a previous agent session.",
    });
    mount();
    expect(renderer!.root.findAllByType("article")).toHaveLength(0);
    expect(JSON.stringify(renderer!.toJSON())).toContain("will not open a replacement session");
    let error: string | null = null;
    await act(async () => {
      error = await renderer!.root.findByType("aside").props.onAnswer([], true);
    });
    expect(error).toContain("previous agent session");
  });
  it.each([
    { accepted: false, requestId: "request" },
    { accepted: true, requestId: "different-request" },
  ])(
    "keeps the local draft when the answer receipt does not confirm this request (%j)",
    async (receipt) => {
      state.answer.mockResolvedValue({ _tag: "Success", value: receipt });
      mount();
      let error: string | null = null;
      await act(async () => {
        error = await renderer!.root.findByType("aside").props.onAnswer([], false);
      });
      expect(error).toContain("did not confirm this answer");
    },
  );
  it("rejects foreign owners and treats a failed query distinctly from no questions", () => {
    state.item.projectAgentId = "someone-else";
    state.queryError = "Attention could not be loaded";
    mount();
    expect(renderer!.root.findAllByType("aside")).toHaveLength(0);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Attention could not be loaded");
  });
  it("clears actionable question UI after native question disappears", () => {
    state.item.active = false;
    mount();
    expect(renderer!.root.findAllByType("aside")).toHaveLength(0);
    expect(JSON.stringify(renderer!.toJSON())).toContain("no longer pending");
  });
  it("opens the exact project conversation for completion and closes it if its session changes", () => {
    state.item.kind = "completion";
    state.item.detail = "Truncated completion preview";
    state.transcriptSession = "";
    const agent = {
      agentRef: "child-ref",
      projectAgentId: "owner",
      record: { session_id: "session", labels: {} },
    };
    state.team = {
      providers: [{ instanceId: "provider", agents: [agent] }],
      projectAgents: [{ agentId: "owner", instanceId: "provider", agentRef: "child-ref" }],
    };
    mount();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Project agent conversation");
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Truncated completion preview");
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("saved native session is unavailable");
    agent.record.session_id = "replacement-session";
    act(() => renderer!.update(<NativeAttentionConversation {...props} />));
    expect(renderer!.root.findAllByType("main")).toHaveLength(0);
    expect(JSON.stringify(renderer!.toJSON())).toContain("will not open a replacement session");
  });
  it("opens historical completion read-only and marks only its visible saved session read", async () => {
    state.item.kind = "completion";
    state.activityAgent = {
      agentRef: "child-ref",
      projectAgentId: "owner",
      record: { session_id: "session", labels: {} },
    };
    state.team = {
      providers: [
        {
          instanceId: "provider",
          agents: [
            {
              agentRef: "replacement-ref",
              projectAgentId: "owner",
              record: { session_id: "replacement-session", labels: {} },
            },
          ],
        },
      ],
      projectAgents: [{ agentId: "owner", instanceId: "provider", agentRef: "replacement-ref" }],
    };
    mount();
    expect(renderer!.root.findAllByType("article")).toHaveLength(1);
    // Neither conversation surface may mount its queue or other agent mutations.
    expect(renderer!.root.findAllByType("main")).toHaveLength(0);
    expect(state.markRead).not.toHaveBeenCalled();
    state.focused = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(state.markRead).toHaveBeenCalledExactlyOnceWith({
      environmentId: "remote",
      input: { projectId: "project", itemIds: ["attention"] },
    });
  });
  it.each(["", "replacement-session"])(
    "does not mount a mutable historical conversation or mark read without its saved session (%s)",
    (transcriptSession) => {
      state.item.kind = "completion";
      state.transcriptSession = transcriptSession;
      state.activityAgent = {
        agentRef: "child-ref",
        projectAgentId: "owner",
        record: { session_id: "session", labels: {} },
      };
      state.team = {
        providers: [{ instanceId: "provider", agents: [] }],
        projectAgents: [],
      };
      state.focused = true;
      mount();
      expect(renderer!.root.findAllByType("main")).toHaveLength(0);
      expect(renderer!.root.findAllByType("article")).toHaveLength(0);
      expect(JSON.stringify(renderer!.toJSON())).toContain("will not open a replacement session");
      expect(state.markRead).not.toHaveBeenCalled();
    },
  );
});

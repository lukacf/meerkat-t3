import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type MeerkatPendingQuestion,
} from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  requests: [] as MeerkatPendingQuestion[],
  error: null as string | null,
  block: null as string | null,
  command: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("../../state/meerkatControls", () => ({
  meerkatControlsEnvironment: { questions: () => "questions", answer: "answer" },
}));
vi.mock("../../state/meerkatTeam", () => ({ useVisibleTeamRefresh: () => {} }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { requests: state.requests },
    error: state.error,
    refresh: state.refresh,
  }),
  formatEnvironmentQueryError: (cause: unknown) => String(cause),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.command }));
vi.mock("./useRestoreReview", () => ({
  readRestoreReviewWorkBlock: () => state.block,
  useRestoreReviewWorkBlock: () => state.block,
}));
vi.mock("./AgentQuestionCard", () => ({ AgentQuestionCard: "aside" }));
import { AgentInteractionRequests } from "./AgentInteractionRequests";

const scope = {
  environmentId: EnvironmentId.make("remote"),
  projectId: ProjectId.make("project"),
  instanceId: ProviderInstanceId.make("native"),
  agentRef: "agent",
};
const request: MeerkatPendingQuestion = {
  requestId: "question",
  sessionId: "session",
  mobId: "mob",
  toolCallId: "call",
  createdAt: "2026-10-04T00:00:00.000Z",
  title: "Choose",
  questions: [],
};
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.requests = [request];
  state.error = null;
  state.block = null;
  state.command.mockReset();
  state.refresh.mockReset();
  act(() => {
    renderer = create(<AgentInteractionRequests {...scope} />);
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("native question receipt admission", () => {
  it.each([
    { accepted: false, requestId: request.requestId },
    { accepted: true, requestId: "another-question" },
  ])("does not clear a draft for an unconfirmed receipt (%j)", async (value) => {
    state.command.mockResolvedValue({ _tag: "Success", value });
    let error: string | null = null;
    await act(async () => {
      error = await renderer!.root.findByType("aside").props.onAnswer([], false);
    });
    expect(error).toContain("did not confirm this answer");
    expect(state.refresh).toHaveBeenCalledOnce();
  });

  it("accepts only the exact request receipt and keeps the original environment/session binding", async () => {
    state.command.mockResolvedValue({
      _tag: "Success",
      value: { accepted: true, requestId: request.requestId },
    });
    const card = renderer!.root.findByType("aside");
    expect(card.props.draftScope).toEqual({
      environmentId: scope.environmentId,
      projectId: scope.projectId,
      instanceId: scope.instanceId,
    });
    let error: string | null = "not-called";
    await act(async () => {
      error = await card.props.onAnswer([], true);
    });
    expect(error).toBeNull();
    expect(state.command).toHaveBeenCalledExactlyOnceWith({
      environmentId: scope.environmentId,
      input: {
        projectId: scope.projectId,
        instanceId: scope.instanceId,
        agentRef: scope.agentRef,
        requestId: request.requestId,
        sessionId: request.sessionId,
        answers: [],
        dismissed: true,
      },
    });
  });

  it("does not dispatch a captured answer callback after restore review blocks new responses", async () => {
    const onAnswer = renderer!.root.findByType("aside").props.onAnswer;
    state.block = "Review this restored profile first.";
    let error: string | null = null;
    await act(async () => {
      error = await onAnswer([], false);
    });
    expect(error).toBe(state.block);
    expect(state.command).not.toHaveBeenCalled();
  });
});

import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MeerkatApproval,
  type MeerkatCoordinatorWork,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentQueryView } from "../../state/query";

const state = vi.hoisted(() => ({
  questions: vi.fn(),
  list: vi.fn(),
  decide: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("../../state/meerkatControls", () => ({
  meerkatControlsEnvironment: {
    questions: state.questions,
    approvals: "approvals",
    decideApproval: "decideApproval",
    answer: "answer",
  },
}));
vi.mock("../../state/meerkatTeam", () => ({ useVisibleTeamRefresh: () => {} }));
vi.mock("../../state/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/query")>()),
  useEnvironmentQuery: () => ({ data: { requests: [] }, error: null, refresh: state.refresh }),
}));
vi.mock("../../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => state.list,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.decide }));
vi.mock("./AgentQuestionCard", () => ({ AgentQuestionCard: () => null }));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
import { ThreadInteractionControls } from "./ThreadInteractionControls";

const target = {
  environmentId: EnvironmentId.make("environment"),
  projectId: ProjectId.make("project"),
  instanceId: ProviderInstanceId.make("native"),
  threadId: ThreadId.make("thread"),
};
const work: MeerkatCoordinatorWork = { sessionId: "canonical-session", busy: true, inputs: [] };
const approval: MeerkatApproval = {
  record: {
    approval_id: "approval",
    owner: { owner_type: "session", session_id: work.sessionId },
    status: "pending",
    proposed_action: { summary: "Read workspace", body: { toolName: "shell", arguments: {} } },
    created_at: "2026-10-01T00:00:00.000Z",
  },
  actionable: true,
};
const observation = (
  data: MeerkatCoordinatorWork | null,
  error: string | null = null,
): EnvironmentQueryView<MeerkatCoordinatorWork> => ({
  data,
  error,
  dataUpdatedAt: data ? 1 : null,
  isPending: !data && !error,
  isSuccess: data !== null && error === null,
  refresh: state.refresh,
});
let renderer: ReactTestRenderer | undefined;
const content = () => JSON.stringify(renderer?.toJSON());
const render = async (
  next: EnvironmentQueryView<MeerkatCoordinatorWork> & { isDormant?: boolean },
  resumeBySending = true,
) => {
  await act(async () => {
    const element = (
      <ThreadInteractionControls {...target} observation={next} resumeBySending={resumeBySending} />
    );
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  state.questions.mockReset();
  state.list.mockReset().mockResolvedValue({ _tag: "Success", value: { approvals: [] } });
  state.decide.mockReset();
  state.refresh.mockReset();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("does not poll questions or approvals before canonical admission, then begins immediately", async () => {
  await render(observation(null));
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(state.questions).not.toHaveBeenCalled();
  expect(state.list).not.toHaveBeenCalled();
  expect(content()).toBe("null");

  await render(observation(work));
  expect(state.questions).toHaveBeenCalledWith({
    environmentId: target.environmentId,
    input: {
      projectId: target.projectId,
      instanceId: target.instanceId,
      threadId: target.threadId,
    },
  });
  expect(state.list).toHaveBeenCalledOnce();
});

it("explains how to resume dormant history without polling live requests", async () => {
  await render({ ...observation(null), isDormant: true });
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(content()).toContain("Send a message to resume this conversation.");
  expect(content()).not.toContain("Could not check agent requests");
  expect(state.questions).not.toHaveBeenCalled();
  expect(state.list).not.toHaveBeenCalled();

  await render({ ...observation(work), isDormant: false });
  expect(content()).not.toContain("Send a message to resume this conversation.");
  expect(state.questions).toHaveBeenCalledOnce();
  expect(state.list).toHaveBeenCalledOnce();
});

it("does not suggest sending while the dormant conversation still requires recovery", async () => {
  await render({ ...observation(null), isDormant: true }, false);
  expect(content()).toBe("null");
  expect(state.questions).not.toHaveBeenCalled();
  expect(state.list).not.toHaveBeenCalled();
});

it("surfaces native target failures and stops polling even with a stale successful observation", async () => {
  await render(observation(work));
  const failure = "The original session requires recovery before controls can continue.";
  await render(observation(work, failure));
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(state.list).toHaveBeenCalledOnce();
  expect(content()).toContain(failure);
  await act(async () => renderer!.root.findByType("button").props.onClick());
  expect(state.refresh).toHaveBeenCalledOnce();
});

it("keeps a mismatched approval session visible as an error and offers no decision", async () => {
  state.list.mockResolvedValue({
    _tag: "Success",
    value: {
      approvals: [
        {
          ...approval,
          record: {
            ...approval.record,
            owner: { owner_type: "session", session_id: "other-session" },
          },
        },
      ],
    },
  });
  await render(observation(work));
  expect(content()).toContain("This approval belongs to a previous native session");
  expect(renderer!.root.findAllByType("button")).toHaveLength(0);
});

it("renders only the approval read error message, without its bundled stack", async () => {
  state.list.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Error("The native target changed. Refresh the conversation.")),
  });
  await render(observation(work));
  expect(content()).toContain("The native target changed. Refresh the conversation.");
  expect(content()).not.toContain("ThreadInteractionControls.test");
  expect(content()).not.toContain("Error:");
});

it("renders only a failed approval decision message and preserves the pending request", async () => {
  state.list.mockResolvedValue({ _tag: "Success", value: { approvals: [approval] } });
  state.decide.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Error("This decision belongs to a previous native session.")),
  });
  await render(observation(work));
  const allow = renderer!.root
    .findAllByType("button")
    .find((node) => node.children.includes("Allow once"));
  await act(async () => allow!.props.onClick());
  expect(content()).toContain("This decision belongs to a previous native session.");
  expect(content()).toContain("Permission to run");
  expect(content()).not.toContain("ThreadInteractionControls.test");
  expect(content()).not.toContain("Error:");
});

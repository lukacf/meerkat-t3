import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MeerkatThreadRecovery,
} from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  data: null as MeerkatThreadRecovery | null,
  error: null as string | null,
  refresh: vi.fn(),
  recover: vi.fn(),
  reconnect: vi.fn(),
  query: vi.fn(),
  onRecovered: vi.fn(),
  onStartNewTask: vi.fn(),
  restoreBlock: null as string | null,
}));
vi.mock("./useRestoreReview", () => ({
  useRestoreReviewWorkBlock: () => state.restoreBlock,
  readRestoreReviewWorkBlock: () => state.restoreBlock,
}));
vi.mock("../../state/meerkatControls", () => ({
  meerkatControlsEnvironment: {
    threadRecovery: (input: unknown) => {
      state.query(input);
      return "query";
    },
    recoverThread: "recover",
    reconnectThread: "reconnect",
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => state,
  formatEnvironmentQueryError: (cause: unknown) => String(cause),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "reconnect" ? state.reconnect : state.recover),
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));
import { ThreadRecoveryBanner } from "./ThreadRecoveryBanner";
let renderer: ReactTestRenderer | undefined;
const props = {
  environmentId: EnvironmentId.make("remote"),
  projectId: ProjectId.make("project"),
  instanceId: ProviderInstanceId.make("provider"),
  threadId: ThreadId.make("thread"),
};
const text = () => JSON.stringify(renderer?.toJSON());
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((node) => node.children.includes(label));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.data = {
    status: "interrupted",
    runId: "original",
    canRecover: true,
    message: "Outcome unknown. Review external effects before continuing.",
  };
  state.error = null;
  state.restoreBlock = null;
  state.refresh.mockReset();
  state.recover.mockReset();
  state.reconnect.mockReset();
  state.reconnect.mockResolvedValue({ _tag: "Success" });
  state.query.mockReset();
  state.onRecovered.mockReset();
  state.onStartNewTask.mockReset();
  state.onStartNewTask.mockResolvedValue({ draftId: "new-draft", threadId: "new-thread" });
  state.recover.mockResolvedValue({
    _tag: "Success",
    value: { runId: "original", recovered: true, cleanupCompleted: true, outcome: "unresolved" },
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
const render = async () => {
  await act(async () => {
    renderer = create(
      <ThreadRecoveryBanner
        {...props}
        onRecovered={state.onRecovered}
        onStartNewTask={state.onStartNewTask}
      />,
    );
  });
};
it("holds cold recovery and reconnect after restore while allowing status refresh", async () => {
  state.restoreBlock = "Review restored work before loading a session.";
  state.data = { ...state.data!, status: "running" };
  await render();
  await act(async () => button("Stop interrupted work")!.props.onClick());
  await act(async () => button("Reconnect")!.props.onClick());
  expect(state.recover).not.toHaveBeenCalled();
  expect(state.reconnect).not.toHaveBeenCalled();
  expect(state.onRecovered).not.toHaveBeenCalled();
  expect(text()).toContain(state.restoreBlock);
  act(() => button("Refresh status")!.props.onClick());
  expect(state.refresh).toHaveBeenCalledTimes(1);
});
it("makes cleanup explicit and scoped, keeps unknown-effects copy, and permits continuation only on receipt", async () => {
  await render();
  expect(state.recover).not.toHaveBeenCalled();
  expect(text()).toContain("Outcome unknown");
  await act(async () => {
    button("Stop interrupted work")!.props.onClick();
  });
  expect(state.recover).toHaveBeenCalledWith({
    environmentId: "remote",
    input: { projectId: "project", instanceId: "provider", threadId: "thread", runId: "original" },
  });
  expect(state.onRecovered).toHaveBeenCalledOnce();
  expect(text()).toContain("Interrupted work stopped");
  expect(text()).toContain("previous outcome remains unknown");
});
it("does not offer cleanup for live, uncontained or legacy work", async () => {
  for (const status of ["running", "unavailable", "settled"] as const) {
    state.data = {
      status,
      runId: "original",
      canRecover: false,
      message: "Native cleanup cannot be proven.",
    };
    await render();
    expect(button("Stop interrupted work")).toBeUndefined();
    expect(state.recover).not.toHaveBeenCalled();
    await act(async () => renderer!.unmount());
    renderer = undefined;
  }
});
it("retains the operation after unconfirmed cleanup and exposes the error", async () => {
  state.recover.mockResolvedValue({ _tag: "Failure", cause: "Gateway disconnected" });
  await render();
  await act(async () => {
    button("Stop interrupted work")!.props.onClick();
  });
  expect(state.onRecovered).not.toHaveBeenCalled();
  expect(text()).toContain("Gateway disconnected");
  expect(button("Stop interrupted work")).toBeDefined();
});
it("allows a recovered journal to finish local continuation after a lost reply without resending the prompt", async () => {
  state.data = {
    status: "recovered",
    runId: "original",
    canRecover: false,
    message: "Outcome remains unknown.",
  };
  await render();
  expect(button("Stop interrupted work")).toBeUndefined();
  await act(async () => {
    button("Continue conversation")!.props.onClick();
  });
  expect(state.recover).toHaveBeenCalledOnce();
  expect(state.onRecovered).toHaveBeenCalledOnce();
});
it("blocks cleanup when status could not be checked and provides refresh", async () => {
  state.error = "Connection unavailable";
  await render();
  expect(button("Stop interrupted work")).toBeUndefined();
  expect(text()).toContain("Connection unavailable");
  await act(async () => {
    button("Refresh status")!.props.onClick();
  });
  expect(state.refresh).toHaveBeenCalledOnce();
});
it("does not carry a successful or pending recovery into a different thread", async () => {
  let complete: (value: unknown) => void = () => {};
  state.recover.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await render();
  await act(async () => {
    button("Stop interrupted work")!.props.onClick();
  });
  await act(async () => {
    renderer!.update(
      <ThreadRecoveryBanner
        {...props}
        threadId={ThreadId.make("replacement")}
        onRecovered={state.onRecovered}
      />,
    );
  });
  await act(async () => {
    complete({ _tag: "Success" });
  });
  expect(state.onRecovered).not.toHaveBeenCalled();
  expect(button("Stop interrupted work")).toBeDefined();
  expect(text()).not.toContain("Interrupted work stopped");
});
it("reconnects the exact running operation explicitly without stopping or resending it", async () => {
  state.data = {
    status: "running",
    runId: "original",
    canRecover: false,
    message: "Original work is still running.",
  };
  await render();
  await act(async () => button("Reconnect")!.props.onClick());
  expect(state.reconnect).toHaveBeenCalledWith({
    environmentId: "remote",
    input: { projectId: "project", threadId: "thread", instanceId: "provider", runId: "original" },
  });
  expect(state.recover).not.toHaveBeenCalled();
  expect(state.refresh).toHaveBeenCalledOnce();
});
it("shows reconnect failure and preserves the original operation", async () => {
  state.data = {
    status: "settled",
    runId: "original",
    canRecover: false,
    message: "Original work has a terminal receipt.",
  };
  state.reconnect.mockResolvedValue({ _tag: "Failure", cause: "Provider changed" });
  await render();
  await act(async () => button("Reconnect")!.props.onClick());
  expect(text()).toContain("Provider changed");
  expect(state.recover).not.toHaveBeenCalled();
});
it("explains settled work without runtime jargon and reconnects only on request", async () => {
  state.data = {
    status: "settled",
    runId: "original",
    canRecover: false,
    message: "The original operation has a terminal receipt.",
  };
  const original = structuredClone(state.data);
  await render();

  expect(text()).toContain(
    "The previous request has finished. Reconnect to continue this conversation.",
  );
  expect(text()).not.toContain("terminal receipt");
  expect(button("Stop interrupted work")).toBeUndefined();
  expect(state.reconnect).not.toHaveBeenCalled();

  await act(async () => button("Reconnect")!.props.onClick());
  expect(state.reconnect).toHaveBeenCalledExactlyOnceWith({
    environmentId: "remote",
    input: { projectId: "project", threadId: "thread", instanceId: "provider", runId: "original" },
  });
  expect(state.recover).not.toHaveBeenCalled();
  expect(state.data).toEqual(original);
});
it("opens a new draft for unavailable work without recovering or reconnecting the original operation", async () => {
  state.data = {
    status: "unavailable",
    runId: "original",
    canRecover: false,
    message: "The gateway exited after dispatch began.",
  };
  const original = structuredClone(state.data);
  await render();
  expect(text()).toContain("does not stop or retry");
  expect(text()).toContain("outcome remains unknown");
  expect(state.onStartNewTask).not.toHaveBeenCalled();
  await act(async () => button("Start a new task")!.props.onClick());
  expect(state.onStartNewTask).toHaveBeenCalledExactlyOnceWith();
  expect(state.data).toEqual(original);
  expect(state.recover).not.toHaveBeenCalled();
  expect(state.reconnect).not.toHaveBeenCalled();
  expect(state.onRecovered).not.toHaveBeenCalled();
  expect(state.refresh).not.toHaveBeenCalled();
  expect(state.query).toHaveBeenCalledWith({
    environmentId: "remote",
    input: { projectId: "project", threadId: "thread", instanceId: "provider" },
  });
  expect(text()).toContain("Interrupted work needs attention");
  expect(text()).not.toContain("Interrupted work stopped");
});
it("prevents repeated new-task navigation while pending and allows retry after a navigation failure", async () => {
  state.data = {
    status: "unavailable",
    runId: "original",
    canRecover: false,
    message: "Outcome unknown.",
  };
  let rejectNavigation: (cause: Error) => void = () => {};
  state.onStartNewTask.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectNavigation = reject;
      }),
  );
  await render();
  const open = button("Start a new task")!.props.onClick;
  await act(async () => {
    open();
    open();
  });
  expect(state.onStartNewTask).toHaveBeenCalledOnce();
  expect(button("Opening new task...")!.props.disabled).toBe(true);
  await act(async () => rejectNavigation(new Error("Could not navigate to the new draft.")));
  expect(text()).toContain("Could not navigate to the new draft.");
  expect(button("Start a new task")!.props.disabled).toBe(false);
  await act(async () => button("Start a new task")!.props.onClick());
  expect(state.onStartNewTask).toHaveBeenCalledTimes(2);
  expect(text()).not.toContain("Could not navigate to the new draft.");
  expect(state.recover).not.toHaveBeenCalled();
  expect(state.reconnect).not.toHaveBeenCalled();
});
it("does not carry a pending new-task failure into a different source task", async () => {
  state.data = {
    status: "unavailable",
    runId: "original",
    canRecover: false,
    message: "Outcome unknown.",
  };
  let rejectNavigation: (cause: Error) => void = () => {};
  state.onStartNewTask.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectNavigation = reject;
      }),
  );
  await render();
  await act(async () => button("Start a new task")!.props.onClick());
  await act(async () => {
    renderer!.update(
      <ThreadRecoveryBanner
        {...props}
        threadId={ThreadId.make("replacement")}
        onStartNewTask={state.onStartNewTask}
      />,
    );
  });
  await act(async () => rejectNavigation(new Error("Old navigation failed.")));
  expect(text()).not.toContain("Old navigation failed.");
  expect(button("Start a new task")!.props.disabled).toBe(false);
  expect(state.recover).not.toHaveBeenCalled();
  expect(state.reconnect).not.toHaveBeenCalled();
});
it("keeps new-task continuation specific to unavailable work with a navigation handler", async () => {
  for (const status of ["none", "interrupted", "running", "recovered", "settled"] as const) {
    state.data = { status, runId: "original", canRecover: false, message: "Existing status." };
    await render();
    expect(button("Start a new task")).toBeUndefined();
    await act(async () => renderer!.unmount());
    renderer = undefined;
  }
  state.data = {
    status: "unavailable",
    runId: "original",
    canRecover: false,
    message: "Outcome unknown.",
  };
  await act(async () => {
    renderer = create(<ThreadRecoveryBanner {...props} />);
  });
  expect(button("Start a new task")).toBeUndefined();
  expect(state.onStartNewTask).not.toHaveBeenCalled();
});

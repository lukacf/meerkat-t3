import { renderToStaticMarkup } from "react-dom/server";
import { Alert } from "react-native";
import type { GitRunStackedActionResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  selectedThread: { environmentId: "environment-a", id: "thread-a" } as {
    environmentId: string;
    id: string;
  } | null,
  run: vi.fn(),
  refresh: vi.fn(),
  notify: vi.fn(),
  copy: vi.fn(),
  open: vi.fn(),
  branches: { refresh: vi.fn(), data: { refs: [] } },
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("./queries", () => ({ useBranches: () => state.branches }));
vi.mock("./threads", () => ({ threadEnvironment: { updateMetadata: "update" } }));
vi.mock("./vcs", () => ({
  vcsActionManager: { runStackedAction: () => "run" },
  vcsEnvironment: { refreshStatus: "refresh" },
}));
vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("./use-remote-environment-registry", () => ({ setPendingConnectionError: vi.fn() }));
vi.mock("./use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "run" ? state.run : command === "refresh" ? state.refresh : vi.fn(),
}));
vi.mock("./use-vcs-action-state", () => ({ showGitActionResult: state.notify }));
vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: state.selectedThread,
    selectedThreadProject: { workspaceRoot: "/fixture/repository" },
  }),
}));
vi.mock("./use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({
    selectedThreadCwd: "/fixture/repository",
    selectedThreadWorktreePath: null,
  }),
}));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "action-a" }));
vi.mock("../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: state.copy }));
vi.mock("../lib/openExternalUrl", () => ({ tryOpenExternalUrl: state.open }));

import { useSelectedThreadGitActions } from "./use-selected-thread-git-actions";

const prUrl = "https://github.com/example/repository/pull/42";
let actions: ReturnType<typeof useSelectedThreadGitActions>;
function Harness() {
  actions = useSelectedThreadGitActions();
  return null;
}
function actionResult(
  linkStatus?: GitRunStackedActionResult["pr"]["linkStatus"],
  status: GitRunStackedActionResult["pr"]["status"] = "created",
): GitRunStackedActionResult {
  return {
    action: "create_pr",
    branch: { status: "skipped_not_requested" },
    commit: { status: "skipped_not_requested" },
    push: { status: "skipped_not_requested" },
    pr: { status, url: prUrl, number: 42, ...(linkStatus ? { linkStatus } : {}) },
    toast: {
      title: "Pull request ready",
      description: "Existing result text",
      cta: { kind: "open_pr", label: "Open PR", url: prUrl },
    },
  };
}
async function run(result: GitRunStackedActionResult) {
  state.run.mockResolvedValue(AsyncResult.success(result));
  renderToStaticMarkup(<Harness />);
  await actions.onRunSelectedThreadGitAction({ action: "create_pr" });
}
function lastAlert() {
  const call = vi.mocked(Alert.alert).mock.calls.at(-1);
  if (!call) throw new Error("Expected a pull request warning");
  return call;
}
async function press(text: string) {
  const button = lastAlert()[2]?.find((entry) => entry.text === text);
  if (!button?.onPress) throw new Error(`Missing alert action: ${text}`);
  await button.onPress();
}
beforeEach(() => {
  vi.clearAllMocks();
  state.selectedThread = { environmentId: "environment-a", id: "thread-a" };
  state.refresh.mockResolvedValue(AsyncResult.success(undefined));
  state.copy.mockResolvedValue(true);
  state.open.mockResolvedValue(true);
});

describe("pull request association outcomes", () => {
  it("keeps a pending association visible with its URL and automatic retry guidance", async () => {
    await run(actionResult("pending"));
    const [title, message, , options] = lastAlert();
    expect(title).toBe("Pull request link pending");
    expect(message).toContain("server will retry automatically");
    expect(message).toContain(prUrl);
    expect(options).toEqual({ cancelable: false });
    expect(state.notify).not.toHaveBeenCalled();
    expect(state.run).toHaveBeenCalledExactlyOnceWith({
      actionId: "action-a",
      action: "create_pr",
      threadId: "thread-a",
    });
  });

  it("preserves an existing PR URL and explains the supported manual-link surface", async () => {
    await run(actionResult("not_saved", "opened_existing"));
    expect(lastAlert()[0]).toBe("Pull request link not saved");
    expect(lastAlert()[1]).toContain("Link pull request in the web or desktop app");
    expect(lastAlert()[1]).not.toContain("retry automatically");
    expect(lastAlert()[1]).toContain(prUrl);
    expect(state.notify).not.toHaveBeenCalled();
  });

  it("retains the URL after copy failure and copies it on retry without rerunning Git", async () => {
    state.copy.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await run(actionResult("not_saved"));
    await press("Copy PR URL");
    expect(lastAlert()[1]).toContain("Could not copy");
    expect(lastAlert()[1]).toContain(prUrl);
    await press("Copy PR URL");
    expect(state.copy).toHaveBeenNthCalledWith(2, prUrl, { target: "pull request URL" });
    expect(lastAlert()[1]).toContain("PR URL copied.");
    expect(lastAlert()[1]).toContain(prUrl);
    expect(state.run).toHaveBeenCalledTimes(1);
  });

  it("keeps Open PR available and restores the warning when opening fails", async () => {
    state.open.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await run(actionResult("pending"));
    await press("Open PR");
    expect(lastAlert()[1]).toContain("Could not open");
    expect(lastAlert()[1]).toContain(prUrl);
    await press("Open PR");
    expect(state.open).toHaveBeenNthCalledWith(2, prUrl, "pull-request");
    expect(Alert.alert).toHaveBeenCalledTimes(2);
    expect(state.run).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "linked"] as const)(
    "preserves normal success when link status is %s",
    async (status) => {
      await run(actionResult(status));
      expect(Alert.alert).not.toHaveBeenCalled();
      expect(state.notify).toHaveBeenCalledExactlyOnceWith({
        type: "success",
        title: "Pull request ready",
        description: "Existing result text",
        prUrl,
      });
    },
  );

  it("does not create an action or warning for a draft without a selected server thread", async () => {
    state.selectedThread = null;
    await run(actionResult());
    expect(state.run).not.toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(state.notify).not.toHaveBeenCalled();
  });
});

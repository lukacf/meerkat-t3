import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type SharedCheckoutPatch,
  type SharedSpecialistRequest,
  type SharedWorkspaceSnapshot,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  tasks: [] as Array<{ id: string; title: string; archivedAt: string | null }>,
  requests: [] as SharedSpecialistRequest[],
  revisionQuery: vi.fn((input) => ({ kind: "revision", input })),
  observe: vi.fn(),
  previewPatch: vi.fn(),
  putSnapshot: vi.fn(),
  putContext: vi.fn(),
  send: vi.fn(),
  ack: vi.fn(),
  navigate: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [{ id: "local-project", environmentId: "local", title: "Catalog" }],
  useThreadShellsForProjectRefs: () => state.tasks,
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({
    environmentId: "host",
    label: "Product",
    connection: { phase: "connected" },
    entry: { target: { _tag: "BearerConnectionTarget", connectionId: "paired-host" } },
  }),
}));
vi.mock("../../state/meerkatTeam", () => ({ useVisibleTeamRefresh: () => {} }));
vi.mock("../../state/sharedWorkspace", () => ({
  sharedWorkspaceEnvironment: {
    conversation: () => ({ kind: "conversation" }),
    inbox: () => ({ kind: "inbox" }),
    checkoutRevision: state.revisionQuery,
    observeCheckoutRevision: "observe",
    previewCheckoutPatch: "previewPatch",
    putSnapshot: "putSnapshot",
    putWorkContext: "putContext",
    send: "send",
    acknowledgeInbox: "ack",
  },
  useSharedDirectory: () => ({
    snapshot,
    connected: true,
    error: null,
    isPending: false,
    permissions: { contribute: true },
    refresh: state.refresh,
  }),
}));
vi.mock("../../state/query", () => ({
  formatEnvironmentQueryError: (cause: string) => cause,
  useEnvironmentQuery: (query: { kind: string } | null) => ({
    data:
      query?.kind === "conversation"
        ? {
            specialist: snapshot.specialists[0],
            requests: state.requests,
            activity: null,
            activityError: null,
          }
        : query?.kind === "revision"
          ? {
              projectId: "local-project",
              branch: "feature/task",
              commit: "a".repeat(40),
              dirty: false,
            }
          : null,
    isPending: false,
    error: null,
    refresh: state.refresh,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (
    name: "observe" | "previewPatch" | "putSnapshot" | "putContext" | "send" | "ack",
  ) => state[name],
}));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "main" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "span",
  TooltipTrigger: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipPopup: "span",
}));
vi.mock("./SharedRequestCard", () => ({
  SharedRequestCard: ({ onRetry }: { onRetry?: () => void }) =>
    onRetry ? <button onClick={onRetry}>Retry recorded request</button> : null,
  SharedMarkdown: () => null,
}));
import { SharedSpecialistConversation } from "./SharedSpecialistConversation";

const at = "2026-10-17T12:00:00.000Z";
const patch: SharedCheckoutPatch = {
  projectId: ProjectId.make("local-project"),
  threadId: ThreadId.make("task-a"),
  branch: "feature/task-a",
  commit: "a".repeat(40),
  observedAt: at,
  status: "ready",
  scope: "tracked_changes",
  patch: "diff --git a/src/catalog.ts b/src/catalog.ts\n+updated\n",
  sha256: "b".repeat(64),
  bytes: 58,
  files: [{ path: "src/catalog.ts", change: "modified" }],
  filesTruncated: false,
  excluded: [],
  excludedTruncated: false,
  maxBytes: 1_048_576,
  maxFiles: 256,
};
const snapshot: SharedWorkspaceSnapshot = {
  workspace: {
    workspaceId: "workspace",
    name: "Product",
    limits: { maxSpecialists: 100, maxSnapshotBytes: 1000 },
    createdAt: at,
  },
  participant: { participantId: "alice", kind: "person", displayName: "Alice", createdAt: at },
  projects: [],
  checkouts: [
    {
      checkoutId: "checkout",
      participantId: "alice",
      sharedProjectId: "catalog",
      localEnvironmentId: EnvironmentId.make("local"),
      localProjectId: ProjectId.make("local-project"),
      repository: "github.com/example/catalog",
      createdAt: at,
    },
  ],
  specialists: [
    {
      specialistId: "contracts",
      label: "Catalog contracts",
      nativeTarget: {
        projectId: ProjectId.make("anchor"),
        instanceId: ProviderInstanceId.make("meerkat"),
        agentId: "native",
      },
      assignments: [
        { sharedProjectId: "catalog", charter: "Own catalog contracts", paths: [], tags: [] },
      ],
      assignmentVersion: 1,
      supersededAt: null,
      successorId: null,
      createdAt: at,
    },
  ],
};
let rendered: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  state.tasks = ["task-a", "task-b"].map((id) => ({
    id: ThreadId.make(id),
    title: `Task ${id}`,
    archivedAt: null,
  }));
  state.revisionQuery.mockClear();
  state.requests = [];
  state.refresh.mockClear();
  state.navigate.mockClear();
  state.observe.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      projectId: "local-project",
      branch: "feature/task-a",
      commit: "a".repeat(40),
      dirty: false,
    },
  });
  state.previewPatch.mockReset().mockResolvedValue({ _tag: "Success", value: patch });
  state.putSnapshot.mockReset().mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: {
      snapshotId: "snapshot-reviewed",
      sharedProjectId: "catalog",
      checkoutId: input.checkoutId,
      revision: input.revision,
      sha256: patch.sha256,
      bytes: patch.bytes,
      createdAt: at,
    },
  }));
  state.putContext.mockReset().mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: {
      ...input,
      contextVersion: "bound-version",
      participantId: "alice",
      sharedProjectId: "catalog",
      updatedAt: at,
    },
  }));
  state.send
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { outcome: { status: "accepted" } } });
  state.ack.mockReset();
});
afterEach(async () => {
  await act(async () => rendered?.unmount());
  rendered = undefined;
  vi.unstubAllGlobals();
});
async function render(thread: string | null = "task-a") {
  await act(async () => {
    const view = (
      <SharedSpecialistConversation
        environmentId={EnvironmentId.make("host")}
        specialistId="contracts"
        checkoutEnvironment="local"
        checkoutProject="local-project"
        checkoutId="checkout"
        checkoutThread={thread ?? undefined}
      />
    );
    if (rendered) rendered.update(view);
    else rendered = create(view);
  });
}
async function enter(text: string) {
  await act(async () =>
    rendered!.root.findByType("textarea").props.onChange({ target: { value: text } }),
  );
}
async function submit() {
  await act(async () => rendered!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
}
function recordedRequest(
  status: SharedSpecialistRequest["outcome"]["status"],
): SharedSpecialistRequest {
  const input = state.send.mock.calls[0]![0].input;
  return {
    requestId: "ledger-id",
    clientRequestId: input.requestId,
    nativeRequestId: "native-id",
    specialistId: "contracts",
    author: snapshot.participant!,
    context: {
      ...state.putContext.mock.calls[0]![0].input,
      contextVersion: input.contextVersion,
      participantId: "alice",
      sharedProjectId: "catalog",
      updatedAt: at,
    },
    text: input.text,
    createdAt: at,
    outcome: { status, receipt: null, completion: null, detail: null, observedAt: at },
  };
}

describe("task context in a shared specialist conversation", () => {
  it("names and returns to the originating task without leaving its local environment", async () => {
    await render();
    const back = rendered!.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Back to task")!;
    expect(back.children).toContain("Back to task");
    await act(async () => back.props.onClick());
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "local", threadId: "task-a" },
    });
  });
  it.each(["project", "missing", "archived"] as const)(
    "names the project fallback truthfully for a %s context",
    async (context) => {
      if (context === "missing") state.tasks = [];
      if (context === "archived")
        state.tasks = state.tasks.map((task) => ({ ...task, archivedAt: at }));
      await render(context === "project" ? null : "task-a");
      const back = rendered!.root
        .findAllByType("button")
        .find((button) => button.props["aria-label"] === "Back to project")!;
      expect(back.children).toContain("Back to project");
      expect(
        rendered!.root
          .findAllByType("button")
          .some((button) => button.props["aria-label"] === "Back to task"),
      ).toBe(false);
      await act(async () => back.props.onClick());
      expect(state.navigate).toHaveBeenCalledExactlyOnceWith({
        to: "/$environmentId/projects/$projectId/start",
        params: { environmentId: "local", projectId: "local-project" },
      });
    },
  );
  it("observes and shares the selected task's worktree only on explicit send", async () => {
    await render();
    expect(state.revisionQuery).toHaveBeenCalledWith({
      environmentId: "local",
      input: { projectId: "local-project", threadId: "task-a" },
    });
    expect(state.observe).not.toHaveBeenCalled();
    expect(state.putContext).not.toHaveBeenCalled();
    expect(state.send).not.toHaveBeenCalled();
    await enter("Review this task's catalog changes");
    await submit();
    expect(state.observe).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { projectId: "local-project", threadId: "task-a" },
    });
    expect(state.putContext.mock.calls[0]![0]).toMatchObject({
      environmentId: "host",
      input: {
        checkoutId: "checkout",
        source: { kind: "thread", threadId: "task-a" },
        revision: { branch: "feature/task-a", commit: "a".repeat(40) },
      },
    });
    expect(state.send.mock.calls[0]![0].input.contextVersion).toBe("bound-version");
  });
  it("blocks an absent task without falling back to the project's main checkout", async () => {
    state.tasks = [];
    await render();
    await enter("Review");
    await submit();
    expect(state.revisionQuery).not.toHaveBeenCalled();
    expect(state.observe).not.toHaveBeenCalled();
    expect(state.putContext).not.toHaveBeenCalled();
    expect(JSON.stringify(rendered!.toJSON())).toContain("local task is unavailable");
    expect(
      rendered!.root.findAllByType("button").find((button) => button.props.type === "submit")!.props
        .disabled,
    ).toBe(true);
  });
  it("requires explicit snapshot sharing and binds a dirty conversation request to that exact snapshot", async () => {
    state.observe.mockResolvedValue({
      _tag: "Success",
      value: {
        projectId: patch.projectId,
        branch: patch.branch,
        commit: patch.commit,
        dirty: true,
        observedAt: at,
      },
    });
    state.send.mockResolvedValueOnce({ _tag: "Failure", cause: "reply lost" });
    await render();
    await enter("Review my uncommitted schema change");
    await submit();
    expect(state.previewPatch).not.toHaveBeenCalled();
    expect(state.putSnapshot).not.toHaveBeenCalled();
    expect(state.putContext).not.toHaveBeenCalled();
    const click = async (label: string) =>
      act(async () => {
        await rendered!.root
          .findAllByType("button")
          .find((item) => item.children.includes(label))!
          .props.onClick();
      });
    await click("Preview snapshot");
    expect(state.previewPatch).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { projectId: "local-project", threadId: "task-a" },
    });
    expect(state.putSnapshot).not.toHaveBeenCalled();
    await click("Share snapshot");
    expect(state.putSnapshot.mock.calls[0]![0].environmentId).toBe("host");
    await submit();
    expect(state.putContext.mock.calls[0]![0].input.revision).toEqual({
      branch: patch.branch,
      commit: patch.commit,
      applicability: "branch",
      snapshotId: "snapshot-reviewed",
    });
    const first = state.send.mock.calls[0]![0];
    state.previewPatch.mockResolvedValue({
      _tag: "Success",
      value: { ...patch, patch: "later changes", sha256: "c".repeat(64) },
    });
    await submit();
    expect(state.send.mock.calls[1]![0]).toEqual(first);
    expect(state.putSnapshot).toHaveBeenCalledTimes(1);
    expect(state.previewPatch).toHaveBeenCalledTimes(3);
    expect(state.putContext).toHaveBeenCalledTimes(1);
  });
  it("does not offer Share snapshot when a preview omits nonignored untracked files", async () => {
    state.previewPatch.mockResolvedValue({
      _tag: "Success",
      value: {
        ...patch,
        status: "unsupported",
        patch: null,
        sha256: null,
        excluded: [{ path: "src/new-domain.ts", reason: "untracked" }],
      },
    });
    await render();
    await act(async () => {
      await rendered!.root
        .findAllByType("button")
        .find((item) => item.children.includes("Preview snapshot"))!
        .props.onClick();
    });
    expect(JSON.stringify(rendered!.toJSON())).toContain("src/new-domain.ts");
    expect(JSON.stringify(rendered!.toJSON())).toContain("Resolve these excluded changes");
    expect(
      rendered!.root
        .findAllByType("button")
        .some((item) => item.children.includes("Share snapshot")),
    ).toBe(false);
    expect(state.putSnapshot).not.toHaveBeenCalled();
  });
  it("keeps drafts for different local tasks separate", async () => {
    await render();
    await enter("Only task A");
    await act(async () => rendered!.unmount());
    rendered = undefined;
    await render("task-b");
    expect(rendered!.root.findByType("textarea").props.value).toBe("");
    await act(async () => rendered!.unmount());
    rendered = undefined;
    await render("task-a");
    expect(rendered!.root.findByType("textarea").props.value).toBe("Only task A");
  });
  it("retries a lost response with its original task revision and request binding", async () => {
    state.send.mockResolvedValueOnce({ _tag: "Failure", cause: "reply lost" });
    await render();
    await enter("Review task A");
    await submit();
    const first = state.send.mock.calls[0]![0];
    state.observe.mockResolvedValue({
      _tag: "Success",
      value: {
        projectId: "local-project",
        branch: "feature/changed",
        commit: "b".repeat(40),
        dirty: false,
      },
    });
    await submit();
    expect(state.send.mock.calls[1]![0]).toEqual(first);
    expect(state.observe).toHaveBeenCalledTimes(1);
    expect(state.putContext).toHaveBeenCalledTimes(1);
  });
  it("retains a definitely unsent draft through refresh and retries the exact saved request", async () => {
    state.send.mockResolvedValueOnce({
      _tag: "Success",
      value: { outcome: { status: "not_admitted" } },
    });
    await render();
    await enter("Review task A");
    await submit();
    const original = state.send.mock.calls[0]![0];
    state.requests = [recordedRequest("not_admitted")];
    await render();
    expect(rendered!.root.findByType("textarea").props.value).toBe("Review task A");
    expect(JSON.stringify(rendered!.toJSON())).toContain("This saved request has not been sent.");
    await submit();
    expect(state.send.mock.calls[1]![0]).toEqual(original);
    expect(state.observe).toHaveBeenCalledTimes(1);
    expect(state.putContext).toHaveBeenCalledTimes(1);
    expect(rendered!.root.findByType("textarea").props.value).toBe("");
  });
  it("restores a recorded unsent request without replacing a different pending delivery", async () => {
    state.send.mockResolvedValueOnce({ _tag: "Failure", cause: "preflight unavailable" });
    await render();
    await enter("Review task A");
    await submit();
    const original = state.send.mock.calls[0]![0];
    state.requests = [recordedRequest("not_admitted")];
    await act(async () => rendered!.unmount());
    rendered = undefined;
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    await render();
    await enter("Keep this separate draft");
    const retry = rendered!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Retry recorded request"))!;
    await act(async () => retry.props.onClick());
    expect(state.send.mock.calls[1]![0]).toEqual(original);
    expect(state.observe).toHaveBeenCalledTimes(1);
    expect(rendered!.root.findByType("textarea").props.value).toBe("Keep this separate draft");
    state.send.mockResolvedValueOnce({ _tag: "Failure", cause: "reply lost" });
    await submit();
    expect(
      rendered!.root
        .findAllByType("button")
        .some((button) => button.children.includes("Retry recorded request")),
    ).toBe(false);
  });
  it("allows an explicit new revision only for a request confirmed not sent", async () => {
    state.send.mockResolvedValueOnce({ _tag: "Failure", cause: "reply lost" });
    await render();
    await enter("Review task A");
    await submit();
    const original = state.send.mock.calls[0]![0];
    expect(JSON.stringify(rendered!.toJSON())).not.toContain("Edit as new request");
    state.requests = [recordedRequest("not_admitted")];
    await render();
    await act(async () =>
      rendered!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Edit as new request"))!
        .props.onClick(),
    );
    state.observe.mockResolvedValue({
      _tag: "Success",
      value: {
        projectId: "local-project",
        branch: "feature/current",
        commit: "b".repeat(40),
        dirty: false,
      },
    });
    await submit();
    expect(state.send.mock.calls[1]![0].input.requestId).not.toBe(original.input.requestId);
    expect(state.putContext.mock.calls[1]![0].input.revision.commit).toBe("b".repeat(40));
    expect(state.requests[0]!.outcome.status).toBe("not_admitted");
  });
});

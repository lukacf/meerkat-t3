import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MeerkatBrowserGrant,
} from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
vi.mock("../../hooks/useProviderWorkspaceReadiness", async () => {
  const { resolveProviderWorkspaceReadiness } =
    await import("@t3tools/client-runtime/providerWorkspaceReadiness");
  return {
    useProviderWorkspaceReadiness: ({
      providers,
      cwd,
    }: {
      providers: import("@t3tools/contracts").ServerProvider[];
      cwd?: string;
    }) => resolveProviderWorkspaceReadiness(providers, cwd),
  };
});
const state = vi.hoisted(() => ({
  data: null as typeof MeerkatBrowserGrant.Type | null,
  error: null as string | null,
  isPending: false,
  refresh: vi.fn(),
  grant: vi.fn(),
  threads: [] as any[],
  createHost: vi.fn(),
  resumeHost: vi.fn(),
  savedAttempt: null as { accepted: boolean } | null,
  models: [] as any[],
}));
vi.mock("@t3tools/client-runtime/state/meerkatMedia", () => ({
  createMeerkatMediaAtoms: () => ({ browserGrant: "grant", browserStatus: () => "status" }),
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/entities", () => ({
  useThreadShells: () => state.threads,
  useProject: () => ({ workspaceRoot: "/repo" }),
  useThreadShell: (ref: { threadId: string } | null) =>
    state.threads.find((thread) => thread.id === ref?.threadId) ?? null,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "remote",
        serverConfig: {
          providers: [{ instanceId: "native", models: state.models }],
        },
      },
    ],
  }),
}));
vi.mock("../../state/vcs", () => ({ vcsEnvironment: { status: () => "vcs" } }));
vi.mock("./useAgentWorkspaceHandoff", () => ({
  useAgentWorkspaceHandoff: () => ({
    start: state.createHost,
    resume: state.resumeHost,
    savedAttempt: state.savedAttempt,
    pending: false,
    error: null,
  }),
}));
vi.mock("./useRestoreReview", () => ({ readRestoreReviewWorkBlock: () => null }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => state }));
vi.mock("../../state/meerkatTeam", () => ({ useVisibleTeamRefresh: () => {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.grant }));
vi.mock("../ui/button", () => ({
  Button: ({ children, render: _render, ...props }: any) => <button {...props}>{children}</button>,
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: any) => <div>{children}</div>,
  PopoverTrigger: ({ children }: any) => <div>{children}</div>,
  PopoverPopup: ({ children }: any) => <div>{children}</div>,
  PopoverTitle: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: any) => <a>{children}</a> }));
import { AgentBrowserControls } from "./AgentBrowserControls";
import type { AgentWorkspaceAttentionOrigin } from "./agentWorkspaceHandoffStore";
const scope = {
  environmentId: EnvironmentId.make("remote"),
  projectId: ProjectId.make("project"),
  instanceId: ProviderInstanceId.make("native"),
  threadId: ThreadId.make("thread"),
};
const context = { workspaceCwd: "/repo", label: "Reviewer", primaryProjectAgentId: "reviewer" };
let renderer: ReactTestRenderer | undefined;
const text = () => JSON.stringify(renderer?.toJSON());
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((node) => node.children.includes(label))!;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.data = { enabled: false };
  state.error = null;
  state.isPending = false;
  state.refresh.mockReset();
  state.grant.mockReset();
  state.createHost.mockReset();
  state.resumeHost.mockReset();
  state.savedAttempt = null;
  state.models = [{ slug: "review-model", isDefault: true }];
  state.grant.mockResolvedValue({ _tag: "Success", value: { enabled: true } });
  state.threads = [
    {
      id: scope.threadId,
      title: "Current checkout",
      environmentId: scope.environmentId,
      projectId: scope.projectId,
      modelSelection: { instanceId: scope.instanceId },
    },
    {
      id: "foreign",
      title: "Foreign",
      environmentId: "other",
      projectId: scope.projectId,
      modelSelection: { instanceId: scope.instanceId },
    },
  ];
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
const render = async () => {
  await act(async () => {
    renderer = create(<AgentBrowserControls scope={scope} {...context} />);
  });
};
it("shares only the selected environment/project thread and exposes revocation", async () => {
  await render();
  expect(text()).not.toContain("Foreign");
  await act(async () => button("Share browser").props.onClick());
  expect(state.grant).toHaveBeenCalledWith({
    environmentId: "remote",
    input: {
      projectId: "project",
      instanceId: "native",
      threadId: "thread",
      hostThreadId: "thread",
      enabled: true,
    },
  });
  state.data = { enabled: true, hostThreadId: scope.threadId };
  await act(async () => renderer!.update(<AgentBrowserControls scope={scope} {...context} />));
  await act(async () => button("Stop sharing").props.onClick());
  expect(state.grant).toHaveBeenLastCalledWith({
    environmentId: "remote",
    input: { projectId: "project", instanceId: "native", threadId: "thread", enabled: false },
  });
});

it("keeps exact saved-task recovery available without a fresh model or workspace", async () => {
  state.models = [];
  state.savedAttempt = { accepted: false };
  await act(async () => {
    renderer = create(
      <AgentBrowserControls
        scope={{ ...scope, threadId: undefined }}
        {...context}
        workspaceCwd={undefined}
      />,
    );
  });
  const open = button("Retry opening task");
  expect(open.props.disabled).toBe(false);
  await act(async () => open.props.onClick());
  expect(state.resumeHost).toHaveBeenCalledOnce();
  expect(state.createHost).not.toHaveBeenCalled();
  expect(state.grant).not.toHaveBeenCalled();
});

it("shows pending access and workspace discovery before the returned grant is available", async () => {
  state.isPending = true;
  const savedThreads = state.threads;
  state.threads = [];
  await render();
  expect(text()).toContain("Checking browser access...");
  expect(text()).toContain("Loading compatible workspaces...");
  expect(text()).not.toContain("Browser access is off.");
  expect(text()).not.toContain("No compatible thread exists");
  expect(button("Share browser").props.disabled).toBe(true);

  state.threads = savedThreads;
  state.isPending = false;
  state.data = { enabled: true, hostThreadId: scope.threadId };
  await act(async () => renderer!.update(<AgentBrowserControls scope={scope} {...context} />));
  expect(text()).toContain("Browser access is enabled.");
  expect(text()).toContain("Shared workspace:");
  expect(text()).toContain("Current checkout");
  expect(text()).not.toContain("Loading compatible workspaces...");
  await act(async () => button("Stop sharing").props.onClick());
  expect(state.grant).toHaveBeenCalledWith({
    environmentId: "remote",
    input: { projectId: "project", instanceId: "native", threadId: "thread", enabled: false },
  });
});

it("distinguishes loading workspaces from a confirmed empty list", async () => {
  const projectScope = { ...scope, threadId: undefined, agentRef: "reviewer" };
  state.threads = [];
  state.isPending = true;
  await act(async () => {
    renderer = create(<AgentBrowserControls scope={projectScope} {...context} />);
  });
  expect(text()).toContain("Loading compatible workspaces...");
  expect(text()).not.toContain("No compatible thread exists");
  state.isPending = false;
  await act(async () =>
    renderer!.update(<AgentBrowserControls scope={projectScope} {...context} />),
  );
  expect(text()).toContain("No compatible thread exists in this checkout.");
  await act(async () => button("Create browser workspace").props.onClick());
  expect(state.createHost).toHaveBeenCalledWith(
    expect.objectContaining({
      purpose: "browser",
      cwd: "/repo",
      origin: {
        kind: "project-agent",
        environmentId: scope.environmentId,
        projectId: scope.projectId,
        agentId: "reviewer",
        label: "Reviewer",
      },
    }),
  );
});
it("keeps host failure actionable and does not present a false enabled state", async () => {
  state.grant.mockResolvedValue({
    _tag: "Success",
    value: {
      enabled: false,
      reason: "no-host",
      message: "Open this environment in the desktop app.",
    },
  });
  await render();
  await act(async () => button("Share browser").props.onClick());
  expect(text()).toContain("Open this environment in the desktop app.");
  expect(button("Stop sharing").props.disabled).toBe(true);
});
it("blocks sharing while project access is disabled or status is unavailable", async () => {
  state.data = {
    enabled: false,
    reason: "disabled",
    message: "Enable browser access in project settings.",
  };
  await render();
  expect(button("Share browser").props.disabled).toBe(true);
  expect(text()).toContain("Enable browser access in project settings.");
  state.data = { enabled: false };
  state.error = "Host disconnected";
  await act(async () => renderer!.update(<AgentBrowserControls scope={scope} {...context} />));
  expect(button("Share browser").props.disabled).toBe(true);
});

it("blocks browser setup for a Read-only agent while preserving revocation of an existing grant", async () => {
  state.data = { enabled: true, hostThreadId: scope.threadId };
  await act(async () => {
    renderer = create(<AgentBrowserControls scope={scope} {...context} accessMode="read-only" />);
  });
  expect(text()).toContain("Read-only agents cannot use browser tools");
  expect(button("Share browser").props.disabled).toBe(true);
  expect(button("Create browser workspace").props.disabled).toBe(true);
  await act(async () => button("Share browser").props.onClick());
  await act(async () => button("Create browser workspace").props.onClick());
  expect(state.createHost).not.toHaveBeenCalled();
  expect(state.grant).not.toHaveBeenCalled();
  expect(button("Stop sharing").props.disabled).toBe(false);
  await act(async () => button("Stop sharing").props.onClick());
  expect(state.grant).toHaveBeenCalledWith({
    environmentId: "remote",
    input: { projectId: "project", instanceId: "native", threadId: "thread", enabled: false },
  });
});
it("ignores a late grant result after the native target changes", async () => {
  let complete: (value: unknown) => void = () => {};
  state.grant.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await render();
  await act(async () => button("Share browser").props.onClick());
  expect(button("Share browser").props.disabled).toBe(true);
  await act(async () =>
    renderer!.update(
      <AgentBrowserControls
        scope={{ ...scope, agentRef: "other", threadId: undefined }}
        {...context}
      />,
    ),
  );
  await act(async () =>
    complete({ _tag: "Success", value: { enabled: false, message: "Old target failed" } }),
  );
  expect(text()).not.toContain("Old target failed");
  expect(state.refresh).not.toHaveBeenCalled();
});

it("offers only exact-checkout hosts for a primary specialist without starting a turn", async () => {
  state.threads.push({
    ...state.threads[0],
    id: "other-worktree",
    title: "Different worktree",
    worktreePath: "/worktrees/other",
    branch: "feature/other",
  });
  await act(async () => {
    renderer = create(
      <AgentBrowserControls
        scope={{ ...scope, threadId: undefined, agentRef: "reviewer" }}
        {...context}
      />,
    );
  });
  expect(text()).not.toContain("Different worktree");
  await act(async () => button("Create browser workspace").props.onClick());
  expect(state.createHost).toHaveBeenCalledWith(
    expect.objectContaining({
      purpose: "browser",
      cwd: "/repo",
      worktreePath: null,
      target: {
        projectId: scope.projectId,
        instanceId: scope.instanceId,
        agentRef: "reviewer",
        threadId: undefined,
      },
      origin: expect.objectContaining({
        kind: "project-agent",
        agentId: "reviewer",
        environmentId: "remote",
      }),
      modelSelection: { instanceId: "native", model: "review-model" },
    }),
  );
  expect(state.grant).not.toHaveBeenCalled();
});

it("preserves a native raw model during browser handoff and blocks it if its account expires", async () => {
  state.models = [
    { slug: "other:default", isDefault: true, credentialState: "connected" },
    { slug: "openai:review-model", credentialState: "connected", subProvider: "openai" },
  ];
  await act(async () => {
    renderer = create(
      <AgentBrowserControls scope={scope} {...context} currentModel="review-model" />,
    );
  });
  await act(async () => button("Create browser workspace").props.onClick());
  expect(state.createHost).toHaveBeenCalledWith(
    expect.objectContaining({
      modelSelection: { instanceId: "native", model: "openai:review-model" },
    }),
  );
  state.models[1].credentialState = "reauth_required";
  state.createHost.mockClear();
  await act(async () => {
    renderer!.update(
      <AgentBrowserControls scope={scope} {...context} currentModel="review-model" />,
    );
  });
  expect(button("Create browser workspace").props.disabled).toBe(true);
  expect(text()).toContain("Reconnect openai");
  expect(text()).toContain("Open Providers");
  expect(state.createHost).not.toHaveBeenCalled();
});

it("pins a worker's browser creation to its owning worktree and fails closed without checkout context", async () => {
  state.threads[0].worktreePath = "/worktrees/review";
  state.threads[0].branch = "feature/review";
  const props = {
    scope: { ...scope, threadId: undefined, agentRef: "worker" },
    workspaceCwd: "/worktrees/review",
    ownerThreadId: scope.threadId,
    primaryProjectAgentId: "inherited-domain-owner",
    label: "Worker",
  };
  await act(async () => {
    renderer = create(<AgentBrowserControls {...props} />);
  });
  await act(async () => button("Create browser workspace").props.onClick());
  expect(state.createHost).toHaveBeenCalledWith(
    expect.objectContaining({
      cwd: "/worktrees/review",
      worktreePath: "/worktrees/review",
      branch: "feature/review",
      origin: expect.objectContaining({ kind: "thread", threadId: "thread", member: "worker" }),
    }),
  );
  await act(async () =>
    renderer!.update(<AgentBrowserControls {...props} workspaceCwd={undefined} />),
  );
  expect(button("Create browser workspace").props.disabled).toBe(true);
  expect(button("Share browser").props.disabled).toBe(true);
});

const helperOrigin: AgentWorkspaceAttentionOrigin = {
  kind: "project-agent-attention",
  environmentId: scope.environmentId,
  projectId: scope.projectId,
  agentId: "reviewer",
  attentionId: "helper-completion",
  instanceId: scope.instanceId,
  agentRef: "domain-helper",
  sessionId: "helper-session",
  label: "Review helper",
};

it("creates a domain helper browser workspace with its exact attention return and native target", async () => {
  const helperScope = { ...scope, threadId: undefined, agentRef: "domain-helper" };
  await act(async () => {
    renderer = create(
      <AgentBrowserControls
        scope={helperScope}
        workspaceCwd="/repo"
        label="Review helper"
        returnAttention={helperOrigin}
      />,
    );
  });
  await act(async () => button("Create browser workspace").props.onClick());
  expect(state.createHost).toHaveBeenCalledExactlyOnceWith({
    purpose: "browser",
    origin: helperOrigin,
    target: {
      projectId: scope.projectId,
      instanceId: scope.instanceId,
      agentRef: "domain-helper",
      threadId: undefined,
    },
    cwd: "/repo",
    branch: null,
    worktreePath: null,
    modelSelection: { instanceId: scope.instanceId, model: "review-model" },
  });
  expect(state.grant).not.toHaveBeenCalled();
});

it.each([
  { environmentId: EnvironmentId.make("other-environment") },
  { projectId: ProjectId.make("other-project") },
  { instanceId: ProviderInstanceId.make("other-instance") },
  { agentRef: "other-helper" },
])("does not create a browser handoff using a stale helper return (%j)", async (mismatch) => {
  await act(async () => {
    renderer = create(
      <AgentBrowserControls
        scope={{ ...scope, threadId: undefined, agentRef: "domain-helper" }}
        workspaceCwd="/repo"
        label="Review helper"
        returnAttention={{ ...helperOrigin, ...mismatch }}
      />,
    );
  });
  expect(button("Create browser workspace").props.disabled).toBe(true);
  await act(async () => button("Create browser workspace").props.onClick());
  expect(state.createHost).not.toHaveBeenCalled();
  expect(state.grant).not.toHaveBeenCalled();
});

it("rejects a project-root fallback while the worker's owning thread is unavailable", async () => {
  state.threads = [{ ...state.threads[0], id: "other-main-thread", title: "Main checkout" }];
  const props = {
    scope: { ...scope, threadId: undefined, agentRef: "worker" },
    workspaceCwd: "/repo",
    ownerThreadId: scope.threadId,
    label: "Worker",
  };
  await act(async () => {
    renderer = create(<AgentBrowserControls {...props} />);
  });
  expect(button("Create browser workspace").props.disabled).toBe(true);
  expect(button("Share browser").props.disabled).toBe(true);
  expect(text()).not.toContain("Main checkout");
  await act(async () => button("Create browser workspace").props.onClick());
  expect(state.createHost).not.toHaveBeenCalled();
  expect(state.grant).not.toHaveBeenCalled();

  state.threads.push({
    ...state.threads[0],
    id: scope.threadId,
    worktreePath: "/worktrees/review",
    branch: "review",
  });
  await act(async () => renderer!.update(<AgentBrowserControls {...props} />));
  expect(button("Create browser workspace").props.disabled).toBe(true);
  await act(async () =>
    renderer!.update(<AgentBrowserControls {...props} workspaceCwd="/worktrees/review" />),
  );
  expect(button("Create browser workspace").props.disabled).toBe(false);
  await act(async () => button("Create browser workspace").props.onClick());
  expect(state.createHost).toHaveBeenCalledWith(
    expect.objectContaining({ cwd: "/worktrees/review", worktreePath: "/worktrees/review" }),
  );
});

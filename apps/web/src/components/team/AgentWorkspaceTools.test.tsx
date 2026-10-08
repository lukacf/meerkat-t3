import { act, type ReactNode, useState } from "react";
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
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MeerkatProjectAgent,
  type MeerkatTeamAgent,
} from "@t3tools/contracts";
import type {
  AgentWorkspaceHandoffAttempt,
  AgentWorkspaceHandoffScope,
} from "./agentWorkspaceHandoffAttemptStore";

const state = vi.hoisted(() => ({
  project: { workspaceRoot: "/repo" } as { workspaceRoot: string } | null,
  thread: null as { branch: string; worktreePath: string | null } | null,
  cwdQueries: [] as string[],
  fileCwd: null as string | null,
  git: [] as Array<{ gitCwd: string; activeThreadRef: { threadId: string } }>,
  start: vi.fn(),
  resume: vi.fn(),
  handoffScopes: [] as Array<AgentWorkspaceHandoffScope | null>,
  savedAttempt: null as AgentWorkspaceHandoffAttempt | null,
  pending: false,
  recovery: null as {
    retry: () => Promise<void>;
    pending: boolean;
    label: string;
    message: string;
  } | null,
  models: [] as any[],
  projectActionCount: 0,
  terminalAttachments: [] as string[],
  terminalClose: vi.fn(),
  terminalCommand: vi.fn(),
  terminalInput: null as ((data: string) => void) | null,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    keybindings: [],
    availableEditors: [],
    providers: [{ instanceId: "native", models: state.models }],
  }),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { configValueAtom: () => "config" } }));
vi.mock("../../state/vcs", () => ({
  vcsEnvironment: {
    status: (input: { input: { cwd: string } }) => {
      state.cwdQueries.push(input.input.cwd);
      return "vcs";
    },
  },
}));
vi.mock("@t3tools/client-runtime/state/projectTerminal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/projectTerminal")>()),
  createProjectTerminalAtoms: () => ({
    attach: ({ input }: { input: { terminalId: string } }) => ({
      kind: "project-terminal",
      terminalId: input.terminalId,
    }),
    write: "terminal-write",
    resize: "terminal-resize",
    clear: "terminal-clear",
    close: "terminal-close",
  }),
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/query", async () => {
  const { EMPTY_PROJECT_TERMINAL } = await import("@t3tools/client-runtime/state/projectTerminal");
  const terminal = { ...EMPTY_PROJECT_TERMINAL, cwd: "/repo", status: "running" };
  return {
    useEnvironmentQuery: (query: string | { kind: string; terminalId: string } | null) => {
      if (query !== null && typeof query !== "string" && query.kind === "project-terminal") {
        state.terminalAttachments.push(query.terminalId);
        return { data: terminal, refresh() {} };
      }
      return { data: { refName: state.thread?.branch ?? "main" }, refresh() {} };
    },
    formatEnvironmentQueryError: (cause: { message: string }) => cause.message,
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "terminal-close" ? state.terminalClose : state.terminalCommand,
}));
vi.mock("../../hooks/useSettings", () => ({ useClientSettings: () => "monospace" }));
vi.mock("../../terminal/ghostty/surface", () => ({
  GhosttyTerminalSurface: {
    create: async (_container: unknown, options: { onData: (data: string) => void }) => {
      state.terminalInput = options.onData;
      return { focus() {}, dispose() {}, setTheme() {} };
    },
  },
}));
vi.mock("../ThreadTerminalDrawer", () => ({
  terminalThemeFromApp: () => ({}),
  writeTerminalOutputUpdate() {},
  terminalSelectionLineRange: () => ({ startLine: 1, endLine: 1 }),
}));
vi.mock("../../state/entities", () => ({
  useProject: () => state.project,
  useThreadShell: (ref: object | null) => (ref ? state.thread : null),
}));
vi.mock("../../hooks/useActiveProjectTarget", () => ({ useRegisterProjectWorkspace() {} }));
vi.mock("./ConversationWorkspaceChrome", () => ({ useConversationWorkspaceChrome: () => null }));
vi.mock("./AgentProjectActions", () => ({
  useAgentProjectActions: ({ onTerminalOpened }: { onTerminalOpened: (id: string) => void }) => ({
    menu: (
      <button onClick={() => onTerminalOpened(`project-action-${++state.projectActionCount}`)}>
        Run test action
      </button>
    ),
    dialog: null,
  }),
}));
vi.mock("./useAgentWorkspaceHandoff", () => ({
  useAgentWorkspaceHandoff: (scope: AgentWorkspaceHandoffScope | null) => {
    state.handoffScopes.push(scope);
    return {
      start: state.start,
      resume: state.resume,
      savedAttempt: state.savedAttempt,
      pending: state.pending,
      recovery: state.recovery,
      error: null,
    };
  },
}));
vi.mock("./agentWorkspaceContext", () => ({
  agentWorkspaceDraftId: () => "draft",
  projectAgentWorkspaceDraftId: () => "draft",
}));
vi.mock("../files/FilePreviewPanel", () => ({
  default: ({ cwd }: { cwd: string }) => {
    const [draft, setDraft] = useState("");
    state.fileCwd = cwd;
    return (
      <div>
        Files in {cwd}
        <input
          aria-label="File editor draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </div>
    );
  },
}));
vi.mock("../DiffPanel", () => ({ default: () => null }));
vi.mock("./AgentThreadTerminal", () => ({ AgentThreadTerminal: () => null }));
vi.mock("../GitActionsControl", () => ({
  default: (props: { gitCwd: string; activeThreadRef: { threadId: string } }) => {
    state.git.push(props);
    return <div>Git actions</div>;
  },
}));
vi.mock("../chat/OpenInPicker", () => ({ OpenInPicker: () => null }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactNode; children: ReactNode }) => (
    <>
      {render}
      {children}
    </>
  ),
  TooltipPopup: () => null,
}));
vi.mock("../ui/menu", () => ({
  Menu: "div",
  MenuPopup: "div",
  MenuItem: "button",
  MenuSeparator: "hr",
  MenuTrigger: ({ render }: { render: ReactNode }) => render,
}));
import { AgentWorkspaceTools } from "./AgentWorkspaceTools";

const props = {
  environmentId: EnvironmentId.make("remote"),
  projectId: ProjectId.make("project"),
  cwd: "/repo",
  projectTitle: "Project",
  workspaceAgent: {
    agentId: "reviewer",
    instanceId: ProviderInstanceId.make("native"),
    label: "Reviewer",
    model: "model",
  } as MeerkatProjectAgent,
};
const observedAgent: MeerkatTeamAgent = {
  agentRef: "native-reviewer",
  projectAgentId: "reviewer",
  mobId: "reviewer-mob",
  mobLabel: "Reviewer",
  mobKind: "project",
  scopeLabel: "Project",
  record: {
    identity: "reviewer",
    display_name: "Reviewer",
    runtime_key: "reviewer-runtime",
    runtime_member_id: "coordinator",
    visibility: "addressable",
    addressable: true,
    health: "healthy",
    labels: {},
  },
  work: {
    status: "idle",
    observedAt: "2026-10-05T06:00:00.000Z",
    model: "shared",
    modelProvider: "openai",
  },
};
const savedDelivery: AgentWorkspaceHandoffAttempt = {
  record: {
    purpose: "delivery",
    origin: {
      kind: "project-agent",
      environmentId: props.environmentId,
      projectId: props.projectId,
      agentId: props.workspaceAgent.agentId,
      label: "Reviewer",
    },
    target: { projectId: props.projectId, instanceId: props.workspaceAgent.instanceId },
    hostThreadId: ThreadId.make("original-delivery"),
    cwd: "/original-checkout",
    branch: "original-branch",
  },
  command: {
    type: "thread.create",
    commandId: CommandId.make("native-workspace-handoff:original-delivery"),
    threadId: ThreadId.make("original-delivery"),
    projectId: props.projectId,
    title: "Delivery from Reviewer",
    modelSelection: { instanceId: props.workspaceAgent.instanceId, model: "original-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "original-branch",
    worktreePath: null,
    createdAt: "2026-10-05T06:00:00.000Z",
  },
  prompt: "Original delivery context",
  accepted: false,
  contextSaved: false,
};
let renderer: ReactTestRenderer | undefined;
const button = (label: string) => renderer!.root.findByProps({ "aria-label": label });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.project = { workspaceRoot: "/repo" };
  state.thread = null;
  state.cwdQueries = [];
  state.fileCwd = null;
  state.git = [];
  state.start.mockReset();
  state.resume.mockReset().mockResolvedValue(undefined);
  state.handoffScopes = [];
  state.savedAttempt = null;
  state.pending = false;
  state.recovery = null;
  state.models = [{ slug: "model", isDefault: true }];
  state.projectActionCount = 0;
  state.terminalAttachments = [];
  state.terminalClose.mockReset().mockResolvedValue({ _tag: "Success" });
  state.terminalCommand.mockReset().mockResolvedValue({ _tag: "Success" });
  state.terminalInput = null;
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("keeps project checkout visible before opening tools and hands Git delivery into a durable task", async () => {
  await act(async () => {
    renderer = create(<AgentWorkspaceTools {...props} />);
  });
  expect(JSON.stringify(renderer!.toJSON())).toContain("Project checkout");
  expect(JSON.stringify(renderer!.toJSON())).toContain("/repo");
  expect(state.cwdQueries).toContain("/repo");
  await act(async () => button("Files").props.onClick());
  expect(state.fileCwd).toBe("/repo");
  expect(state.git).toHaveLength(0);
  const delivery = renderer!.root
    .findAllByType("button")
    .find((node) => node.children.includes("Delivery task"))!;
  await act(async () => delivery.props.onClick());
  expect(state.start).toHaveBeenCalledWith(
    expect.objectContaining({
      purpose: "delivery",
      cwd: "/repo",
      branch: "main",
      worktreePath: null,
      origin: expect.objectContaining({ agentId: "reviewer" }),
    }),
  );
});

const terminalButton = (label: string) =>
  renderer!.root
    .findAllByType("button")
    .find((node) => node.props["aria-label"] === label || node.children.includes(label))!;

function deferredTerminalClose() {
  let resolve!: (value: { _tag: "Success" }) => void;
  const promise = new Promise<{ _tag: "Success" }>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function mountProjectActionTerminal() {
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal("document", { documentElement: {} });
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  await act(async () => {
    renderer = create(<AgentWorkspaceTools {...props} />, {
      createNodeMock: (element) =>
        element.type === "div" &&
        (element.props as { "aria-label"?: string })["aria-label"] === "Project terminal"
          ? {}
          : null,
    });
  });
  await act(async () => button("Files").props.onClick());
  await act(async () => terminalButton("Run test action").props.onClick());
  expect(state.terminalAttachments.at(-1)).toBe("project-action-1");
  return values;
}

it("keeps the restarted project action shell selected after switching tools and reopening", async () => {
  const storage = await mountProjectActionTerminal();
  await act(async () => terminalButton("Restart").props.onClick());
  const restartedId = state.terminalAttachments.at(-1)!;
  expect(restartedId).toMatch(/^project-shell-/);
  expect(state.terminalClose).toHaveBeenCalledExactlyOnceWith({
    environmentId: props.environmentId,
    input: { projectId: props.projectId, terminalId: "project-action-1" },
  });
  await act(async () => button("Files").props.onClick());
  await act(async () => terminalButton("Project terminal").props.onClick());
  expect(state.terminalAttachments.at(-1)).toBe(restartedId);
  await act(async () => button("Close workspace tools").props.onClick());
  await act(async () => terminalButton("Project terminal").props.onClick());
  expect(state.terminalAttachments.at(-1)).toBe(restartedId);
  expect(storage.get(`project-terminal:${props.environmentId}:${props.projectId}`)).toBe(
    restartedId,
  );
  await act(async () => state.terminalInput!("echo still-here\r"));
  expect(state.terminalCommand).toHaveBeenLastCalledWith({
    environmentId: props.environmentId,
    input: { projectId: props.projectId, terminalId: restartedId, data: "echo still-here\r" },
  });
});

it("retains the action shell on close failure and lets an explicit restart retry succeed", async () => {
  await mountProjectActionTerminal();
  state.terminalClose.mockResolvedValueOnce({
    _tag: "Failure",
    cause: { message: "Could not close the shell." },
  });
  await act(async () => terminalButton("Restart").props.onClick());
  expect(JSON.stringify(renderer!.toJSON())).toContain("Could not close the shell.");
  expect(state.terminalAttachments.at(-1)).toBe("project-action-1");
  expect(terminalButton("Restart").props.disabled).not.toBe(true);
  await act(async () => button("Close workspace tools").props.onClick());
  await act(async () => terminalButton("Project terminal").props.onClick());
  expect(state.terminalAttachments.at(-1)).toBe("project-action-1");
  await act(async () => terminalButton("Restart").props.onClick());
  expect(state.terminalAttachments.at(-1)).toMatch(/^project-shell-/);
  expect(state.terminalClose).toHaveBeenCalledTimes(2);
});

it("finishes one pending restart after the panel closes without selecting the closed shell again", async () => {
  await mountProjectActionTerminal();
  const closed = deferredTerminalClose();
  state.terminalClose.mockReturnValue(closed.promise);
  const restart = terminalButton("Restart").props.onClick;
  await act(async () => {
    restart();
    restart();
  });
  expect(state.terminalClose).toHaveBeenCalledOnce();
  expect(terminalButton("Restart").props.disabled).toBe(true);
  await act(async () => button("Close workspace tools").props.onClick());
  await act(async () => closed.resolve({ _tag: "Success" }));
  await act(async () => terminalButton("Project terminal").props.onClick());
  expect(state.terminalAttachments.at(-1)).toMatch(/^project-shell-/);
  expect(state.terminalClose).toHaveBeenCalledOnce();
});

it("does not replace a newer action shell when an earlier restart finishes", async () => {
  const storage = await mountProjectActionTerminal();
  const closed = deferredTerminalClose();
  state.terminalClose.mockReturnValue(closed.promise);
  await act(async () => terminalButton("Restart").props.onClick());
  await act(async () => terminalButton("Run test action").props.onClick());
  expect(state.terminalAttachments.at(-1)).toBe("project-action-2");
  await act(async () => closed.resolve({ _tag: "Success" }));
  expect(state.terminalAttachments.at(-1)).toBe("project-action-2");
  expect(storage.get(`project-terminal:${props.environmentId}:${props.projectId}`)).toBe(
    "project-action-2",
  );
  await act(async () => button("Close workspace tools").props.onClick());
  await act(async () => terminalButton("Project terminal").props.onClick());
  expect(state.terminalAttachments.at(-1)).toBe("project-action-2");
});

it("does not carry a pending restart selection into a different checkout", async () => {
  await mountProjectActionTerminal();
  const closed = deferredTerminalClose();
  state.terminalClose.mockReturnValue(closed.promise);
  await act(async () => terminalButton("Restart").props.onClick());
  const otherProjectId = ProjectId.make("other-project");
  await act(async () => {
    renderer!.update(<AgentWorkspaceTools {...props} projectId={otherProjectId} />);
  });
  expect(state.terminalAttachments.at(-1)).toBe("project-shell-1");
  await act(async () => closed.resolve({ _tag: "Success" }));
  expect(state.terminalAttachments.at(-1)).toBe("project-shell-1");
  await act(async () => state.terminalInput!("pwd\r"));
  expect(state.terminalCommand).toHaveBeenLastCalledWith({
    environmentId: props.environmentId,
    input: { projectId: otherProjectId, terminalId: "project-shell-1", data: "pwd\r" },
  });
  await act(async () => renderer!.update(<AgentWorkspaceTools {...props} />));
  const restartedId = state.terminalAttachments.at(-1)!;
  expect(restartedId).toMatch(/^project-shell-/);
  expect(restartedId).not.toBe("project-shell-1");
  await act(async () => state.terminalInput!("pwd\r"));
  expect(state.terminalCommand).toHaveBeenLastCalledWith({
    environmentId: props.environmentId,
    input: { projectId: props.projectId, terminalId: restartedId, data: "pwd\r" },
  });
});

it("keeps worker files and Git on the owning worktree and never falls back while that thread is missing", async () => {
  const threadId = ThreadId.make("owner");
  state.thread = { branch: "feature/review", worktreePath: "/worktrees/review" };
  await act(async () => {
    renderer = create(<AgentWorkspaceTools {...props} threadId={threadId} />);
  });
  expect(JSON.stringify(renderer!.toJSON())).toContain("Thread worktree");
  expect(JSON.stringify(renderer!.toJSON())).toContain("feature/review");
  await act(async () => button("Files").props.onClick());
  expect(state.fileCwd).toBe("/worktrees/review");
  expect(state.git.at(-1)).toMatchObject({
    gitCwd: "/worktrees/review",
    activeThreadRef: { environmentId: "remote", threadId: "owner" },
  });
  state.thread = null;
  state.cwdQueries = [];
  await act(async () => renderer!.update(<AgentWorkspaceTools {...props} threadId={threadId} />));
  expect(button("Files").props.disabled).toBe(true);
  expect(state.cwdQueries).not.toContain("/repo");
  expect(JSON.stringify(renderer!.toJSON())).toContain("Thread workspace unavailable");
});

it("hands delivery to the observed provider and blocks if that exact model leaves the catalog", async () => {
  state.models = [
    { slug: "self_hosted:shared", isDefault: true, credentialState: "connected" },
    { slug: "openai:shared", credentialState: "connected" },
  ];
  await act(async () => {
    renderer = create(<AgentWorkspaceTools {...props} agent={observedAgent} />);
  });
  const delivery = () =>
    renderer!.root.findAllByType("button").find((node) => node.children.includes("Delivery task"))!;
  expect(delivery().props.disabled).toBe(false);
  await act(async () => delivery().props.onClick());
  expect(state.start).toHaveBeenCalledOnce();
  expect(state.start).toHaveBeenCalledWith(
    expect.objectContaining({
      modelSelection: { instanceId: "native", model: "openai:shared" },
      target: { projectId: "project", instanceId: "native", agentRef: "native-reviewer" },
    }),
  );

  state.models = [state.models[0]];
  await act(async () => {
    renderer!.update(<AgentWorkspaceTools {...props} agent={observedAgent} />);
  });
  expect(delivery().props.disabled).toBe(true);
  expect(JSON.stringify(renderer!.toJSON())).toContain(
    "The agent's current model is unavailable in this workspace.",
  );
  expect(JSON.stringify(renderer!.toJSON())).toContain("Open Providers");
  await act(async () => delivery().props.onClick());
  expect(state.start).toHaveBeenCalledOnce();
});

it("blocks a delivery handoff with an actionable account link instead of changing its model", async () => {
  state.models = [
    { slug: "other", isDefault: true, credentialState: "connected" },
    { slug: "model", subProvider: "openai", credentialState: "reauth_required" },
  ];
  await act(async () => {
    renderer = create(<AgentWorkspaceTools {...props} />);
  });
  const delivery = renderer!.root
    .findAllByType("button")
    .find((node) => node.children.includes("Delivery task"))!;
  expect(delivery.props.disabled).toBe(true);
  expect(JSON.stringify(renderer!.toJSON())).toContain("Reconnect openai");
  expect(JSON.stringify(renderer!.toJSON())).toContain("Open Providers");
  expect(state.start).not.toHaveBeenCalled();
});

it.each([false, true])(
  "recovers the original delivery with accepted=%s despite unavailable current workspace and model",
  async (accepted) => {
    state.project = null;
    state.models = [];
    state.savedAttempt = { ...savedDelivery, accepted };
    const retry = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    state.recovery = {
      retry,
      pending: false,
      label: accepted ? "Open saved task" : "Retry opening task",
      message: accepted
        ? "Your task is saved. Open it to continue."
        : "This task has not been confirmed yet. Retry to recover it without creating a duplicate.",
    };
    await act(async () => {
      renderer = create(<AgentWorkspaceTools {...props} cwd="" agent={observedAgent} />);
    });
    expect(state.handoffScopes.at(-1)).toEqual({
      purpose: "delivery",
      origin: savedDelivery.record.origin,
    });
    const findButton = (label: string) =>
      renderer!.root.findAllByType("button").find((node) => node.children.includes(label))!;
    const delivery = findButton(accepted ? "Open delivery task" : "Retry delivery task");
    expect(delivery.props.disabled).toBe(false);
    expect(JSON.stringify(renderer!.toJSON())).toContain(state.recovery.message);
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Open Providers");
    if (!accepted) expect(JSON.stringify(renderer!.toJSON())).not.toContain("Your task is saved");
    await act(async () => delivery.props.onClick());
    expect(state.resume).toHaveBeenCalledOnce();
    expect(state.resume).toHaveBeenCalledWith();
    await act(async () => findButton(state.recovery!.label).props.onClick());
    expect(retry).toHaveBeenCalledOnce();
    expect(state.start).not.toHaveBeenCalled();

    state.pending = true;
    state.recovery = { ...state.recovery, pending: true };
    await act(async () => {
      renderer!.update(<AgentWorkspaceTools {...props} cwd="" agent={observedAgent} />);
    });
    const opening = renderer!.root
      .findAllByType("button")
      .filter((node) => node.children.includes("Opening task..."));
    expect(opening).toHaveLength(2);
    expect(opening.every((node) => node.props.disabled)).toBe(true);
    expect(state.start).not.toHaveBeenCalled();
  },
);

it("keeps editor state across expansion and short-window transitions and restores focus when tools close", async () => {
  let resize: (() => void) | undefined;
  const document: { activeElement: TestElement | null; body: TestElement | null } = {
    activeElement: null,
    body: null,
  };
  class TestElement {
    inert = false;
    isConnected = true;
    clientHeight = 400;
    parentElement: TestElement | null = null;
    children: TestElement[] = [];
    ownerDocument = document;
    append(child: TestElement) {
      this.children.push(child);
      child.parentElement = this;
    }
    contains(target: TestElement | null): boolean {
      return target === this || this.children.some((child) => child.contains(target));
    }
    closest(selector: string): TestElement | null {
      if (selector === "[data-conversation-pane]") return pane;
      return this.inert ? this : (this.parentElement?.closest(selector) ?? null);
    }
    matches() {
      return false;
    }
    querySelector(): TestElement {
      return opener;
    }
    focus() {
      document.activeElement = this;
    }
  }
  const pane = new TestElement();
  const header = new TestElement();
  const opener = new TestElement();
  const tools = new TestElement();
  const conversation = new TestElement();
  pane.append(header);
  header.append(opener);
  pane.append(tools);
  pane.append(conversation);
  document.activeElement = opener;
  vi.stubGlobal("HTMLElement", TestElement);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  await act(async () => {
    renderer = create(<AgentWorkspaceTools {...props} />, {
      createNodeMock: (element) => (element.type === "header" ? header : tools),
    });
  });
  await act(async () => button("Files").props.onClick());
  expect(header.inert).toBe(true);
  expect(conversation.inert).toBe(true);
  expect(document.activeElement).toBe(tools);
  const editor = () => renderer!.root.findByProps({ "aria-label": "File editor draft" });
  await act(async () => editor().props.onChange({ target: { value: "unsaved work" } }));
  pane.clientHeight = 900;
  await act(async () => resize!());
  expect(editor().props.value).toBe("unsaved work");
  expect(header.inert).toBe(false);
  expect(conversation.inert).toBe(false);
  await act(async () => button("Expand workspace tools").props.onClick());
  expect(editor().props.value).toBe("unsaved work");
  expect(header.inert).toBe(true);
  expect(conversation.inert).toBe(true);
  await act(async () => button("Reduce workspace tools").props.onClick());
  expect(editor().props.value).toBe("unsaved work");
  expect(header.inert).toBe(false);
  expect(conversation.inert).toBe(false);
  pane.clientHeight = 300;
  await act(async () => resize!());
  expect(editor().props.value).toBe("unsaved work");
  expect(conversation.inert).toBe(true);
  await act(async () => button("Close workspace tools").props.onClick());
  expect(document.activeElement).toBe(opener);
  expect(header.inert).toBe(false);
  expect(conversation.inert).toBe(false);
});

import { act, useState, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId, ProjectId, ThreadId, type ProjectScript } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ConversationPaneContext } from "./ConversationPaneContext";

const state = vi.hoisted(() => ({
  openThread: vi.fn(),
  writeThread: vi.fn(),
  openProject: vi.fn(),
  writeProject: vi.fn(),
  submit: vi.fn(),
  commandPaletteOpen: false,
  terminalFocused: false,
  hasScripts: true,
  importedScripts: [] as ProjectScript[],
  fileContents: null as string | null,
  fileTruncated: false,
  fileReads: vi.fn(),
  focus: "primary",
}));
vi.mock("@t3tools/client-runtime/state/projectTerminal", () => ({
  createProjectTerminalAtoms: () => ({ open: "openProject", write: "writeProject" }),
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/terminal", () => ({
  terminalEnvironment: { open: "openThread", write: "writeThread" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (key: "openThread" | "writeThread" | "openProject" | "writeProject") =>
    state[key],
}));
vi.mock("../../state/terminalSessions", () => ({ useKnownTerminalSessions: () => [] }));
vi.mock("../../terminalUiStateStore", () => ({
  selectThreadTerminalUiState: () => ({ terminalIds: [] }),
  useTerminalUiStateStore: {
    getState: () => ({ terminalUiStateByThreadKey: {}, newTerminal: vi.fn() }),
  },
}));
vi.mock("../../state/entities", () => ({
  useProject: ({ projectId }: { projectId: string }) => ({
    id: projectId,
    workspaceRoot: "/repo",
    scripts: [],
  }),
}));
vi.mock("../files/projectFilesQueryState", () => ({
  useProjectFileQuery: (environmentId: string, cwd: string, path: string, enabled: boolean) => {
    state.fileReads(environmentId, cwd, path, enabled);
    return {
      data:
        state.fileContents === null
          ? null
          : { contents: state.fileContents, truncated: state.fileTruncated },
      isPending: false,
    };
  },
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { configValueAtom: () => "config" } }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    settings: {
      defaultProjectScripts: [
        ...(state.hasScripts
          ? [
              {
                id: "inspect",
                name: "Inspect",
                command: "pwd",
                icon: "play",
                runOnWorktreeCreate: false,
              },
            ]
          : []),
        ...state.importedScripts,
      ],
      projectScriptOverrides: {},
      projectSettingsOverrides: {},
      projectSettingsFolded: true,
    },
    keybindings: [
      {
        command: "script.inspect.run",
        shortcut: {
          key: "p",
          ctrlKey: true,
          altKey: false,
          metaKey: false,
          shiftKey: false,
          modKey: false,
        },
        whenAst: { type: "not", node: { type: "identifier", name: "terminalFocus" } },
      },
    ],
  }),
}));
vi.mock("../settings/useProjectScriptSettings", () => ({
  useProjectScriptSettings: () => ({ submit: state.submit, persist: vi.fn() }),
}));
vi.mock("../ui/menu", () => ({
  Menu: "div",
  MenuGroup: "div",
  MenuGroupLabel: "span",
  MenuItem: "button",
  MenuItemLabel: "span",
  MenuPopup: "div",
  MenuSeparator: "hr",
  MenuShortcut: "span",
  MenuTrigger: "button",
  MenuSub: "div",
  MenuSubTrigger: "button",
  MenuSubPopup: "div",
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogDescription: "p",
  DialogFooter: "footer",
  DialogHeader: "header",
  DialogPanel: "section",
  DialogPopup: "section",
  DialogTitle: "h2",
}));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? children : null,
  AlertDialogClose: "button",
  AlertDialogDescription: "p",
  AlertDialogFooter: "footer",
  AlertDialogHeader: "header",
  AlertDialogPopup: "section",
  AlertDialogTitle: "h2",
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/label", () => ({ Label: "label" }));
vi.mock("../ui/switch", () => ({ Switch: "input" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/group", () => ({ Group: "div", GroupSeparator: "span" }));
vi.mock("../ui/tooltip", () => ({ Tooltip: "div", TooltipTrigger: "div", TooltipPopup: "span" }));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: () => null,
  PopoverTrigger: "button",
}));
vi.mock("../../commandPaletteBus", () => ({
  isCommandPaletteOpen: () => state.commandPaletteOpen,
}));
vi.mock("../../lib/terminalFocus", () => ({
  getTerminalFocusOwner: () => (state.terminalFocused ? "right-panel" : null),
}));
vi.mock("../../lib/previewFocus", () => ({ isPreviewFocused: () => false }));
vi.mock("../../lib/editableFocus", () => ({ isEditableFocused: () => false }));
vi.mock("../../env", () => ({ isElectron: false }));
import { useAgentProjectActions } from "./AgentProjectActions";

const environmentId = EnvironmentId.make("remote");
const projectId = ProjectId.make("project");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread"));
const handlers = new Set<(event: KeyboardEvent) => void>();
let renderer: ReactTestRenderer | undefined;
const opened = vi.fn();

function Agent({ worker = false, available = true }: { worker?: boolean; available?: boolean }) {
  useAgentProjectActions({
    environmentId,
    projectId,
    threadRef: worker ? threadRef : null,
    cwd: available ? (worker ? "/worktrees/review" : "/repo") : null,
    worktreePath: worker ? "/worktrees/review" : null,
    terminalOpen: false,
    onTerminalOpened: opened,
  });
  // The menu is closed, so its contents are not mounted.
  return null;
}
function AgentMenu({ worker = false }: { worker?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(true);
  const actions = useAgentProjectActions({
    environmentId,
    projectId,
    threadRef: worker ? threadRef : null,
    cwd: worker ? "/worktrees/review" : "/repo",
    worktreePath: worker ? "/worktrees/review" : null,
    terminalOpen: false,
    onTerminalOpened: opened,
    onRequestMenuClose: () => setMenuOpen(false),
  });
  return (
    <>
      {menuOpen ? <section aria-label="Workspace actions">{actions.menu}</section> : null}
      {actions.dialog}
    </>
  );
}
function shortcut(repeat = false) {
  const event = {
    key: "p",
    code: "KeyP",
    ctrlKey: true,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    repeat,
    target: null,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation: vi.fn(),
  };
  handlers.forEach((handler) => handler(event as unknown as KeyboardEvent));
  return event;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  state.focus = "primary";
  state.commandPaletteOpen = false;
  state.terminalFocused = false;
  state.hasScripts = true;
  state.importedScripts = [];
  state.fileContents = null;
  state.fileTruncated = false;
  state.fileReads.mockReset();
  [state.openThread, state.writeThread, state.openProject, state.writeProject].forEach(
    (command) => {
      command.mockReset();
      command.mockResolvedValue({ _tag: "Success", value: {} });
    },
  );
  opened.mockClear();
  state.submit.mockReset();
  state.submit.mockResolvedValue({ _tag: "Success", value: undefined });
  vi.stubGlobal("window", {
    addEventListener: (_name: string, handler: (event: KeyboardEvent) => void) =>
      handlers.add(handler),
    removeEventListener: (_name: string, handler: (event: KeyboardEvent) => void) =>
      handlers.delete(handler),
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  handlers.clear();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "imports a repository action before running it in the agent's workspace (worker: %s)",
  async (worker) => {
    state.hasScripts = false;
    state.fileContents = JSON.stringify({
      scripts: [{ name: "Test", command: "pnpm test", icon: "test" }],
    });
    state.submit.mockImplementation(async (_id, input) => {
      state.importedScripts = [{ id: "test-action", ...input }];
      return { _tag: "Success", value: undefined };
    });
    await act(async () => {
      renderer = create(<AgentMenu worker={worker} />);
    });
    expect(state.fileReads).toHaveBeenCalledWith(environmentId, "/repo", "t3.json", true);
    const buttonWithLabel = (label: string) =>
      renderer!.root
        .findAllByType("button")
        .find((button) =>
          button.findAllByType("span").some((span) => span.children.join("") === label),
        )!;
    expect(JSON.stringify(renderer!.toJSON())).toContain("From t3.json");
    await act(async () => {
      buttonWithLabel("Test").props.onClick();
    });
    expect(state.submit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ name: "Test", command: "pnpm test" }),
    );
    expect(state.openThread).not.toHaveBeenCalled();
    expect(state.openProject).not.toHaveBeenCalled();
    await act(async () => {
      renderer!.update(<AgentMenu worker={worker} />);
    });
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("From t3.json");
    await act(async () => {
      buttonWithLabel("Run Test").props.onClick();
    });
    if (worker) {
      expect(state.openThread).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId,
          input: expect.objectContaining({
            cwd: "/worktrees/review",
            worktreePath: "/worktrees/review",
          }),
        }),
      );
      expect(state.writeThread).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId,
          input: expect.objectContaining({ data: "pnpm test\r" }),
        }),
      );
      expect(state.openProject).not.toHaveBeenCalled();
    } else {
      expect(state.openProject).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId, input: expect.objectContaining({ projectId }) }),
      );
      expect(state.writeProject).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId,
          input: expect.objectContaining({ data: "pnpm test\r" }),
        }),
      );
      expect(state.openThread).not.toHaveBeenCalled();
    }
  },
);

it("runs only the focused agent's action with the menu closed and preserves worktree ownership", async () => {
  await act(async () => {
    renderer = create(
      <>
        <ConversationPaneContext value={() => state.focus === "primary"}>
          <Agent />
        </ConversationPaneContext>
        <ConversationPaneContext value={() => state.focus === "secondary"}>
          <Agent worker />
        </ConversationPaneContext>
      </>,
    );
  });
  state.focus = "secondary";
  await act(async () => {
    shortcut();
  });
  expect(state.openProject).not.toHaveBeenCalled();
  expect(state.openThread).toHaveBeenCalledTimes(1);
  expect(state.openThread).toHaveBeenCalledWith({
    environmentId,
    input: {
      threadId: threadRef.threadId,
      terminalId: expect.any(String),
      cwd: "/worktrees/review",
      worktreePath: "/worktrees/review",
      env: { T3CODE_PROJECT_ROOT: "/repo", T3CODE_WORKTREE_PATH: "/worktrees/review" },
    },
  });
  expect(state.writeThread).toHaveBeenCalledWith({
    environmentId,
    input: { threadId: threadRef.threadId, terminalId: expect.any(String), data: "pwd\r" },
  });
  state.focus = "primary";
  await act(async () => {
    shortcut();
  });
  expect(state.openProject).toHaveBeenCalledWith({
    environmentId,
    input: { projectId, terminalId: expect.any(String) },
  });
  expect(state.writeProject).toHaveBeenCalledWith({
    environmentId,
    input: { projectId, terminalId: expect.any(String), data: "pwd\r" },
  });
  expect(state.openThread).toHaveBeenCalledTimes(1);
});

it("respects repeat, palette, terminal focus and missing workspace guards", async () => {
  await act(async () => {
    renderer = create(<Agent worker />);
  });
  await act(async () => {
    shortcut(true);
  });
  state.commandPaletteOpen = true;
  await act(async () => {
    shortcut();
  });
  state.commandPaletteOpen = false;
  state.terminalFocused = true;
  await act(async () => {
    shortcut();
  });
  state.terminalFocused = false;
  await act(async () => {
    renderer!.update(<Agent worker available={false} />);
  });
  await act(async () => {
    shortcut();
  });
  expect(state.openThread).not.toHaveBeenCalled();
  expect(state.openProject).not.toHaveBeenCalled();
});

it("does not write the command when terminal creation fails", async () => {
  state.openProject.mockResolvedValue({ _tag: "Failure" });
  await act(async () => {
    renderer = create(<Agent />);
  });
  await act(async () => {
    shortcut();
  });
  expect(state.openProject).toHaveBeenCalledTimes(1);
  expect(state.writeProject).not.toHaveBeenCalled();
  expect(opened).not.toHaveBeenCalled();
});

it.each([false, true])(
  "keeps the add editor alive after the menu unmounts (existing actions: %s)",
  async (hasScripts) => {
    state.hasScripts = hasScripts;
    await act(async () => {
      renderer = create(<AgentMenu />);
    });
    const add = renderer!.root
      .findAllByType("button")
      .find((button) =>
        button
          .findAllByType("span")
          .some((label) =>
            label.children.some((text) => typeof text === "string" && text.startsWith("Add ")),
          ),
      )!;
    await act(async () => add.props.onClick());
    expect(renderer!.root.findAllByProps({ "aria-label": "Workspace actions" })).toHaveLength(0);
    expect(renderer!.root.findByType("form")).toBeDefined();
    await act(async () => {
      renderer!.root
        .findByProps({ id: "script-name" })
        .props.onChange({ target: { value: "Build" } });
      renderer!.root
        .findByProps({ id: "script-command" })
        .props.onChange({ target: { value: "bun run build" } });
    });
    await act(async () => {
      shortcut();
    });
    expect(state.openProject).not.toHaveBeenCalled();
    await act(async () =>
      renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }),
    );
    expect(state.submit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ name: "Build", command: "bun run build" }),
    );
    expect(renderer!.root.findAllByType("form")).toHaveLength(0);
  },
);

it("keeps the edit editor alive after closing the parent menu and updates the selected action", async () => {
  await act(async () => {
    renderer = create(<AgentMenu />);
  });
  await act(async () =>
    renderer!.root.findByProps({ "aria-label": "Edit Inspect" }).props.onClick({
      preventDefault() {},
      stopPropagation() {},
    }),
  );
  expect(renderer!.root.findAllByProps({ "aria-label": "Workspace actions" })).toHaveLength(0);
  expect(renderer!.root.findByProps({ id: "script-name" }).props.value).toBe("Inspect");
  expect(renderer!.root.findByProps({ id: "script-command" }).props.value).toBe("pwd");
  await act(async () =>
    renderer!.root
      .findByProps({ id: "script-command" })
      .props.onChange({ target: { value: "pwd -P" } }),
  );
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(state.submit).toHaveBeenCalledWith(
    "inspect",
    expect.objectContaining({ command: "pwd -P" }),
  );
  expect(renderer!.root.findAllByType("form")).toHaveLength(0);
});

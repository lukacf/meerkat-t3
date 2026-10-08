import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent, useState } from "react";
import { createProjectTerminalAtoms } from "@t3tools/client-runtime/state/projectTerminal";
import {
  type EnvironmentId,
  type ProjectId,
  type ProjectScript,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv, resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useProject } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { terminalEnvironment } from "../../state/terminal";
import { useKnownTerminalSessions } from "../../state/terminalSessions";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { randomUUID } from "../../lib/utils";
import ProjectScriptsControl from "../ProjectScriptsControl";
import { ProjectScriptEditorDialog, type ProjectScriptEditorRequest } from "../projectScriptEditor";
import { useProjectScriptSettings } from "../settings/useProjectScriptSettings";
import { useConversationPaneActive } from "./ConversationPaneContext";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { resolveShortcutCommand } from "../../keybindings";
import { isEditableFocused } from "../../lib/editableFocus";
import { isPreviewFocused } from "../../lib/previewFocus";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import { projectScriptIdFromCommand } from "../../projectScripts";
import { useT3ProjectFileScripts } from "../../hooks/useT3ProjectFileScripts";

const projectTerminals = createProjectTerminalAtoms(connectionAtomRuntime);

/** Keep shortcut ownership mounted even while the workspace menu is closed. */
export function useAgentProjectActions({
  environmentId,
  projectId,
  threadRef,
  cwd,
  worktreePath,
  terminalOpen,
  onTerminalOpened,
  onRequestMenuClose,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadRef: ScopedThreadRef | null;
  cwd: string | null;
  worktreePath: string | null;
  terminalOpen: boolean;
  onTerminalOpened: (projectTerminalId?: string) => void;
  onRequestMenuClose?: () => void;
}) {
  const [editorRequest, setEditorRequest] = useState<ProjectScriptEditorRequest | null>(null);
  const paneActive = useConversationPaneActive();
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const fileScripts = useT3ProjectFileScripts(environmentId, project?.workspaceRoot ?? null);
  const edit = useProjectScriptSettings(
    config && project
      ? [{ environmentId, project, settings: config.settings, keybindings: config.keybindings }]
      : [],
  );
  const openThread = useAtomCommand(terminalEnvironment.open, "project action terminal");
  const writeThread = useAtomCommand(terminalEnvironment.write, "run project action");
  const openProject = useAtomCommand(projectTerminals.open, "project action terminal");
  const writeProject = useAtomCommand(projectTerminals.write, "run project action");
  const sessions = useKnownTerminalSessions({
    environmentId: threadRef ? environmentId : null,
    threadId: threadRef?.threadId ?? null,
  });
  async function run(script: ProjectScript) {
    if (!project || !cwd) return;
    if (threadRef) {
      const store = useTerminalUiStateStore.getState();
      const ui = selectThreadTerminalUiState(store.terminalUiStateByThreadKey, threadRef);
      const terminalId = nextTerminalId([
        ...ui.terminalIds,
        ...sessions.map((session) => session.target.terminalId),
      ]);
      const opened = await openThread({
        environmentId,
        input: {
          threadId: threadRef.threadId,
          terminalId,
          cwd,
          worktreePath,
          env: projectScriptRuntimeEnv({ project: { cwd: project.workspaceRoot }, worktreePath }),
        },
      });
      if (opened._tag !== "Success") return;
      store.newTerminal(threadRef, terminalId);
      onTerminalOpened();
      await writeThread({
        environmentId,
        input: { threadId: threadRef.threadId, terminalId, data: `${script.command}\r` },
      });
    } else {
      const terminalId = `project-action-${randomUUID()}`;
      const opened = await openProject({ environmentId, input: { projectId, terminalId } });
      if (opened._tag !== "Success") return;
      onTerminalOpened(terminalId);
      await writeProject({
        environmentId,
        input: { projectId, terminalId, data: `${script.command}\r` },
      });
    }
  }
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      !paneActive() ||
      !project ||
      !config ||
      !cwd ||
      editorRequest !== null ||
      event.defaultPrevented ||
      isCommandPaletteOpen()
    )
      return;
    const command = resolveShortcutCommand(event, config.keybindings, {
      context: {
        terminalFocus: getTerminalFocusOwner() !== null,
        terminalOpen,
        previewFocus: isPreviewFocused(),
        previewOpen: false,
        editableFocus: isEditableFocused(event.target),
        isWeb: !isElectron,
        isDesktop: isElectron,
      },
    });
    const scriptId = command ? projectScriptIdFromCommand(command) : null;
    if (!scriptId) return;
    const script = resolveProjectScripts(config.settings, project).find(
      (entry) => entry.id === scriptId,
    );
    if (!script) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) void run(script);
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);
  if (!project || !config) return { menu: null, dialog: null };
  const scripts = resolveProjectScripts(config.settings, project);
  const deleteScript = (id: string) =>
    edit.persist((current) => current.filter((script) => script.id !== id), id);
  return {
    menu: (
      <ProjectScriptsControl
        presentation="menu"
        scripts={scripts}
        fileScripts={fileScripts}
        keybindings={config.keybindings}
        onRunScript={(script) => void run(script)}
        onAddScript={(input) => edit.submit(null, input)}
        onUpdateScript={edit.submit}
        onDeleteScript={deleteScript}
        {...(onRequestMenuClose ? { onRequestMenuClose } : {})}
        onEditorRequest={setEditorRequest}
      />
    ),
    dialog: (
      <ProjectScriptEditorDialog
        request={editorRequest}
        scripts={scripts}
        onSubmit={edit.submit}
        onDelete={(id) => void deleteScript(id)}
        onClose={() => setEditorRequest(null)}
      />
    ),
  };
}

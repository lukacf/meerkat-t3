import { ProjectTerminal } from "./ProjectTerminal";
import {
  type ThreadId,
  type EnvironmentId,
  type MeerkatProjectAgent,
  type MeerkatTeamAgent,
  type MeerkatTeamProvider,
  type ProjectId,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  FolderIcon,
  GitCompareArrowsIcon,
  XIcon,
  CopyIcon,
  MessageSquarePlusIcon,
  TerminalIcon,
  RefreshCwIcon,
  Maximize2Icon,
  MoreHorizontalIcon,
  Minimize2Icon,
  GitBranchIcon,
  ArrowUpRightIcon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { serverEnvironment } from "../../state/server";
import { vcsEnvironment } from "../../state/vcs";
import { useEnvironmentQuery } from "../../state/query";
import { useProject, useThreadShell } from "../../state/entities";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { cn, randomUUID } from "../../lib/utils";
import { useConversationWorkspaceChrome } from "./ConversationWorkspaceChrome";
import { useRegisterProjectWorkspace } from "../../hooks/useActiveProjectTarget";
import { useProviderWorkspaceReadiness } from "../../hooks/useProviderWorkspaceReadiness";
import FilePreviewPanel from "../files/FilePreviewPanel";
import DiffPanel from "../DiffPanel";
import GitActionsControl from "../GitActionsControl";
import { useComposerDraftStore } from "../../composerDraftStore";
import { Menu, MenuTrigger, MenuPopup, MenuSeparator, MenuItem } from "../ui/menu";
import { useAgentProjectActions } from "./AgentProjectActions";
import { AgentThreadTerminal } from "./AgentThreadTerminal";
import { agentWorkspaceDraftId, projectAgentWorkspaceDraftId } from "./agentWorkspaceContext";
import { type TerminalContextSelection } from "../../lib/terminalContext";
import { OpenInPicker } from "../chat/OpenInPicker";
import { useAgentWorkspaceHandoff } from "./useAgentWorkspaceHandoff";
import { resolveAgentWorkspaceModel } from "./agentWorkspaceModel";
import { isolateAgentWorkspaceTools, resolveAgentWorkspaceLayout } from "./agentWorkspaceLayout";

export function AgentHeaderIdentity({
  icon,
  label,
  context,
}: {
  icon: ReactNode;
  label: string;
  context: string;
}) {
  return (
    <>
      {icon}
      <div className="min-w-0 flex-1">
        <Tooltip>
          <TooltipTrigger render={<h1 className="truncate text-sm font-semibold" />}>
            {label}
          </TooltipTrigger>
          <TooltipPopup>{label}</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<p className="truncate text-2xs text-muted-foreground" />}>
            {context}
          </TooltipTrigger>
          <TooltipPopup>{context}</TooltipPopup>
        </Tooltip>
      </div>
    </>
  );
}

export function AgentWorkspaceTools({
  environmentId,
  projectId,
  cwd,
  projectTitle,
  threadId,
  workspaceAgent,
  agent,
  provider,
  identity,
  actions,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  cwd: string;
  projectTitle: string;
  threadId?: ThreadId;
  workspaceAgent?: MeerkatProjectAgent | undefined;
  agent?: MeerkatTeamAgent | undefined;
  provider?: MeerkatTeamProvider | undefined;
  identity?: ReactNode;
  actions?: ReactNode;
}) {
  const chrome = useConversationWorkspaceChrome();
  const headerRef = useRef<HTMLElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const previousSurfaceRef = useRef<"files" | "review" | "terminal" | null>(null);
  const [paneHeight, setPaneHeight] = useState(0);
  useLayoutEffect(() => {
    const pane = headerRef.current?.closest<HTMLElement>("[data-conversation-pane]");
    if (!pane) return;
    const update = () => setPaneHeight(pane.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);
  const [surface, setSurface] = useState<"files" | "review" | "terminal" | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileReveal, setFileReveal] = useState({ line: null as number | null, requestId: 0 });
  const [pendingFiles, setPendingFiles] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const toolsLayout = resolveAgentWorkspaceLayout(paneHeight, expanded);
  const canResizeTools = !resolveAgentWorkspaceLayout(paneHeight, false).fullPane;
  useLayoutEffect(() => {
    const previousSurface = previousSurfaceRef.current;
    previousSurfaceRef.current = surface;
    const document = headerRef.current?.ownerDocument;
    if (!document) return;
    const activeElement = document.activeElement;
    const justOpened = surface !== null && previousSurface === null;
    if (justOpened) {
      returnFocusRef.current =
        activeElement instanceof HTMLElement && activeElement !== document.body
          ? activeElement
          : null;
    }
    if (surface === null) {
      if (previousSurface !== null) {
        const opener = returnFocusRef.current;
        const fallback = headerRef.current?.querySelector<HTMLElement>(
          `[data-agent-workspace-surface="${previousSurface}"]`,
        );
        const target =
          opener?.isConnected && !opener.closest("[inert]") && !opener.matches(":disabled")
            ? opener
            : fallback;
        target?.focus({ preventScroll: true });
        returnFocusRef.current = null;
      }
      return;
    }
    const panel = toolsRef.current;
    const pane = headerRef.current?.closest<HTMLElement>("[data-conversation-pane]");
    if (!toolsLayout.fullPane || !panel || !pane) return;
    // The same panel stays mounted across size changes, preserving editor and terminal state.
    // Move focus only when opening, or when a resize would cover the focused conversation control.
    if (
      !panel.contains(activeElement) &&
      (justOpened || pane.contains(activeElement) || activeElement === document.body)
    ) {
      panel.focus({ preventScroll: true });
    }
    return isolateAgentWorkspaceTools(panel, pane);
  }, [surface, toolsLayout.fullPane]);
  const [revision, setRevision] = useState(0);
  const terminalScope = `${environmentId}:${projectId}`;
  const [projectTerminalSelections, setProjectTerminalSelections] = useState<
    Record<string, string>
  >({});
  const projectTerminalId = projectTerminalSelections[terminalScope];
  const onProjectTerminalRestarted = useCallback(
    (previousTerminalId: string, terminalId: string) => {
      setProjectTerminalSelections((current) =>
        current[terminalScope] !== undefined && current[terminalScope] !== previousTerminalId
          ? current
          : { ...current, [terminalScope]: terminalId },
      );
    },
    [terminalScope],
  );
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const threadRef = useMemo(
    () => (threadId ? scopeThreadRef(environmentId, threadId) : null),
    [environmentId, threadId],
  );
  const thread = useThreadShell(threadRef);
  // Workers never fall back to the main checkout while their thread is loading or unavailable.
  const workspaceCwd = threadId
    ? thread
      ? (thread.worktreePath ?? project?.workspaceRoot ?? null)
      : null
    : (project?.workspaceRoot ?? cwd);
  const openFile = useCallback((path: string, line?: number) => {
    setSelectedFile(path);
    setFileReveal((current) => ({ line: line ?? null, requestId: current.requestId + 1 }));
    setSurface("files");
  }, []);
  const workspaceTarget = useMemo(
    () =>
      workspaceCwd
        ? { environmentId, projectId, cwd: workspaceCwd, projectName: projectTitle, openFile }
        : null,
    [environmentId, openFile, projectId, projectTitle, workspaceCwd],
  );
  useRegisterProjectWorkspace(workspaceTarget);
  const projectActions = useAgentProjectActions({
    environmentId,
    projectId,
    threadRef,
    cwd: workspaceCwd,
    worktreePath: thread?.worktreePath ?? null,
    terminalOpen: surface === "terminal",
    onRequestMenuClose: () => setActionsMenuOpen(false),
    onTerminalOpened: (id) => {
      if (id) setProjectTerminalSelections((current) => ({ ...current, [terminalScope]: id }));
      setSurface("terminal");
    },
  });
  const status = useEnvironmentQuery(
    workspaceCwd ? vcsEnvironment.status({ environmentId, input: { cwd: workspaceCwd } }) : null,
  );
  const draftId = useMemo(
    () =>
      workspaceAgent
        ? projectAgentWorkspaceDraftId({
            environmentId,
            projectId,
            instanceId: workspaceAgent.instanceId,
            agentId: workspaceAgent.agentId,
          })
        : agent && provider
          ? agentWorkspaceDraftId({
              environmentId,
              projectId,
              instanceId: provider.instanceId,
              identity: {
                kind: "native-agent",
                durableId: agent.durableId,
                agentRef: agent.agentRef,
              },
            })
          : null,
    [agent, environmentId, projectId, provider, workspaceAgent],
  );
  const onPendingChange = useCallback((path: string, pending: boolean) => {
    setPendingFiles((current) => {
      const next = new Set(current);
      if (pending) next.add(path);
      else next.delete(path);
      return next;
    });
    if (!pending) setRevision((value) => value + 1);
  }, []);
  const addTerminalContext = useCallback(
    (selection: TerminalContextSelection) => {
      if (!draftId) return;
      useComposerDraftStore.getState().addTerminalContext(draftId, {
        ...selection,
        id: randomUUID(),
        ...(threadId ? { threadId } : {}),
        createdAt: new Date().toISOString(),
      });
      setNotice("Terminal selection added to this agent's draft.");
    },
    [draftId, threadId],
  );
  function addReference() {
    if (!draftId || !selectedFile) return;
    const store = useComposerDraftStore.getState();
    const previous = store.getComposerDraft(draftId)?.prompt ?? "";
    store.setPrompt(
      draftId,
      `${previous}${previous ? "\n\n" : ""}${serializeComposerFileLink(selectedFile)}`,
    );
    setNotice("File added to this agent's draft.");
  }
  const workspaceKey = threadId ?? projectId;
  const branch = status.data?.refName ?? thread?.branch;
  const instanceId = workspaceAgent?.instanceId ?? provider?.instanceId;
  const workspaceReadiness = useProviderWorkspaceReadiness({
    environmentId,
    cwd: workspaceCwd,
    providers: config?.providers ?? [],
    ...(instanceId ? { instanceId } : {}),
  });
  const handoffProvider = workspaceReadiness.providers.find(
    (entry) => entry.instanceId === instanceId,
  );
  const currentModel = agent?.work?.model ?? workspaceAgent?.model;
  const { model: handoffModel, blockedReason } = resolveAgentWorkspaceModel(
    handoffProvider?.models ?? [],
    currentModel,
    agent?.work?.modelProvider,
  );
  const modelBlockedReason =
    instanceId && workspaceReadiness.pendingInstanceIds.has(instanceId)
      ? "Checking models for this workspace..."
      : blockedReason;
  const savedAgentId = workspaceAgent?.agentId ?? agent?.projectAgentId;
  const agentLabel = workspaceAgent?.label ?? agent?.record.display_name ?? "Project agent";
  const deliveryOrigin =
    !threadId && savedAgentId
      ? {
          kind: "project-agent" as const,
          environmentId,
          projectId,
          agentId: savedAgentId,
          label: agentLabel,
        }
      : null;
  const handoff = useAgentWorkspaceHandoff(
    deliveryOrigin ? { purpose: "delivery", origin: deliveryOrigin } : null,
  );
  function openDeliveryTask() {
    if (handoff.savedAttempt) {
      void handoff.resume();
      return;
    }
    if (!workspaceCwd || !instanceId || !handoffModel || !deliveryOrigin) return;
    void handoff.start({
      purpose: "delivery",
      origin: deliveryOrigin,
      target: { projectId, instanceId, ...(agent?.agentRef ? { agentRef: agent.agentRef } : {}) },
      cwd: workspaceCwd,
      branch: branch ?? null,
      worktreePath: null,
      modelSelection: { instanceId, model: handoffModel.slug },
      summary: [agent?.work?.objective, agent?.work?.outcome].filter(Boolean).join("\n"),
    });
  }
  return (
    <>
      <header
        ref={headerRef}
        className={cn(
          "flex h-12 min-w-0 shrink-0 items-center gap-1 border-b border-border px-3",
          !chrome?.secondary && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        {identity ? (
          <div className="mr-2 flex min-w-0 flex-1 items-center gap-2">{identity}</div>
        ) : null}
        {(
          [
            ["files", "Files", FolderIcon],
            ["review", "Changes", GitCompareArrowsIcon],
            ["terminal", threadId ? "Thread terminal" : "Project terminal", TerminalIcon],
          ] as const
        ).map(([value, label, Icon]) => (
          <Tooltip key={value}>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant={surface === value ? "secondary" : "ghost-muted"}
                  disabled={!workspaceCwd}
                  aria-label={label}
                  aria-pressed={surface === value}
                  data-agent-workspace-surface={value}
                  onClick={() => setSurface(surface === value ? null : value)}
                >
                  <Icon />
                </Button>
              }
            />
            <TooltipPopup>{label}</TooltipPopup>
          </Tooltip>
        ))}
        {actions}
      </header>
      <div
        className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-2xs text-muted-foreground"
        aria-label="Agent checkout"
      >
        <span className="shrink-0">
          {threadId
            ? thread?.worktreePath
              ? "Thread worktree"
              : "Thread checkout"
            : "Project checkout"}
        </span>
        {branch ? (
          <Tooltip>
            <TooltipTrigger
              render={<span className="flex min-w-0 max-w-40 items-center gap-1" tabIndex={0} />}
            >
              <GitBranchIcon className="size-3 shrink-0" />
              <span className="truncate">{branch}</span>
            </TooltipTrigger>
            <TooltipPopup>{branch}</TooltipPopup>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" tabIndex={0} />}>
            {workspaceCwd ?? "Thread workspace unavailable"}
          </TooltipTrigger>
          <TooltipPopup>{workspaceCwd ?? "Thread workspace unavailable"}</TooltipPopup>
        </Tooltip>
        {!threadId && savedAgentId ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={
              handoff.pending || (!handoff.savedAttempt && (!workspaceCwd || !handoffModel))
            }
            onClick={openDeliveryTask}
          >
            <ArrowUpRightIcon />
            {handoff.pending
              ? "Opening task..."
              : handoff.savedAttempt
                ? handoff.savedAttempt.accepted
                  ? "Open delivery task"
                  : "Retry delivery task"
                : "Delivery task"}
          </Button>
        ) : null}
      </div>
      {handoff.error ? (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {handoff.error}
        </p>
      ) : null}
      {handoff.recovery ? (
        <div className="flex items-center gap-2 px-3 py-2 text-xs">
          <p className="min-w-0 flex-1">{handoff.recovery.message}</p>
          <Button
            size="xs"
            variant="outline"
            disabled={handoff.recovery.pending}
            onClick={() => void handoff.recovery?.retry()}
          >
            {handoff.recovery.pending ? "Opening task..." : handoff.recovery.label}
          </Button>
        </div>
      ) : null}
      {!threadId && savedAgentId && !handoff.savedAttempt && modelBlockedReason ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {modelBlockedReason}{" "}
          <Link
            to="/settings/providers"
            search={{ environmentId, ...(instanceId ? { instanceId } : {}) }}
          >
            Open Providers
          </Link>
        </p>
      ) : null}
      {surface ? (
        <div
          ref={toolsRef}
          role="region"
          tabIndex={-1}
          className={cn(
            "@container/agent-tools flex min-h-0 shrink-0 flex-col overflow-hidden border-b border-border bg-background",
            toolsLayout.fullPane && "absolute inset-0 z-20",
          )}
          style={{ height: toolsLayout.height }}
          aria-label="Agent workspace tools"
        >
          <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-1.5">
            <Tooltip>
              <TooltipTrigger
                render={<p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" />}
              >
                {workspaceCwd ?? "Loading workspace..."}
                {branch ? ` - ${branch}` : ""}
              </TooltipTrigger>
              <TooltipPopup>
                {workspaceCwd ?? "Workspace unavailable"}
                {branch ? ` (${branch})` : ""}
              </TooltipPopup>
            </Tooltip>
            {surface === "files" && selectedFile ? (
              <>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Back to files"
                  onClick={() => setSelectedFile(null)}
                >
                  <FolderIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Copy file path"
                  onClick={() => void writeTextToClipboard(`${workspaceCwd}/${selectedFile}`)}
                >
                  <CopyIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={!draftId}
                  onClick={addReference}
                  aria-label="Add file to draft"
                >
                  <MessageSquarePlusIcon />
                </Button>
              </>
            ) : null}
            {surface !== "terminal" ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Refresh workspace tools"
                onClick={() => {
                  setRevision((value) => value + 1);
                  status.refresh();
                }}
              >
                <RefreshCwIcon />
              </Button>
            ) : null}
            {workspaceCwd ? (
              <Menu open={actionsMenuOpen} onOpenChange={setActionsMenuOpen}>
                <MenuTrigger
                  render={
                    <Button size="icon-xs" variant="ghost" aria-label="Workspace actions">
                      <MoreHorizontalIcon />
                    </Button>
                  }
                />
                <MenuPopup align="end">
                  {projectActions.menu}
                  <MenuSeparator />
                  {threadRef ? (
                    <GitActionsControl
                      presentation="menu"
                      environmentId={environmentId}
                      gitCwd={workspaceCwd}
                      activeThreadRef={threadRef}
                    />
                  ) : (
                    <MenuItem
                      disabled={!handoffModel || !savedAgentId || handoff.pending}
                      onClick={openDeliveryTask}
                    >
                      <ArrowUpRightIcon />
                      Review, commit and PR in a delivery task
                    </MenuItem>
                  )}
                </MenuPopup>
              </Menu>
            ) : null}
            {config && workspaceCwd ? (
              <OpenInPicker
                environmentId={environmentId}
                keybindings={config.keybindings}
                availableEditors={config.availableEditors}
                openInCwd={workspaceCwd}
              />
            ) : null}
            {canResizeTools ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={expanded ? "Reduce workspace tools" : "Expand workspace tools"}
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
              </Button>
            ) : null}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Close workspace tools"
              onClick={() => setSurface(null)}
            >
              <XIcon />
            </Button>
          </div>
          {notice ? (
            <p role="status" className="px-3 py-1 text-xs text-muted-foreground">
              {notice}
            </p>
          ) : null}
          {!workspaceCwd || !config || !draftId ? (
            <p role="status" className="p-4 text-sm text-muted-foreground">
              {threadId && !thread
                ? "The thread workspace is not available. Reopen the coordinator to check its status."
                : "Opening workspace..."}
            </p>
          ) : surface === "terminal" ? (
            threadRef ? (
              <AgentThreadTerminal
                key={workspaceKey}
                threadRef={threadRef}
                cwd={workspaceCwd}
                projectRoot={project?.workspaceRoot ?? cwd}
                worktreePath={thread?.worktreePath ?? null}
                keybindings={config.keybindings}
                onAddTerminalContext={addTerminalContext}
              />
            ) : (
              <ProjectTerminal
                key={`${environmentId}:${projectId}:${projectTerminalId ?? "default"}`}
                initialTerminalId={projectTerminalId}
                onRestarted={onProjectTerminalRestarted}
                environmentId={environmentId}
                projectId={projectId}
                onAddTerminalContext={addTerminalContext}
              />
            )
          ) : surface === "files" ? (
            <FilePreviewPanel
              key={`${workspaceKey}:files`}
              environmentId={environmentId}
              cwd={workspaceCwd}
              projectName={projectTitle}
              relativePath={selectedFile}
              threadRef={threadRef}
              composerDraftTarget={draftId}
              keybindings={config.keybindings}
              availableEditors={config.availableEditors}
              revealLine={fileReveal.line}
              revealRequestId={fileReveal.requestId}
              onOpenFile={openFile}
              onBrowseFiles={() => setSelectedFile(null)}
              onPendingChange={onPendingChange}
              selectedFilePending={selectedFile !== null && pendingFiles.has(selectedFile)}
              workspaceMutationId={`${revision}`}
            />
          ) : (
            <DiffPanel
              key={`${workspaceKey}:review`}
              mode="embedded"
              threadRef={null}
              workspace={{ environmentId, cwd: workspaceCwd, key: workspaceKey }}
              composerDraftTarget={draftId}
              workspaceMutationId={`${revision}`}
              onOpenFile={openFile}
            />
          )}
        </div>
      ) : null}
      {projectActions.dialog}
    </>
  );
}

import { ConversationWorkspace } from "../components/team/ConversationWorkspace";
import { AgentWorkspaceHandoffBanner } from "../components/team/AgentWorkspaceHandoffBanner";
import { useComposerDraftStore } from "../composerDraftStore";
import { Outlet, createFileRoute, redirect, useParams, useLocation } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo } from "react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { ThreadRouteView } from "../components/ThreadRouteView";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useClientSettings, useLegacySidebarEnabled } from "../hooks/useSettings";
import { openCommandPalette } from "../commandPaletteBus";
import { useProjects, useThreadShell } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { dispatchPreviewAction } from "../components/preview/previewActionBus";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useProjectHomeDraft } from "../hooks/useProjectHomeDraft";
import { SidebarInset } from "../components/ui/sidebar";
import { Button } from "../components/ui/button";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isEditableFocused } from "../lib/editableFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { undoLatestThreadAction } from "../hooks/showThreadUndoNotice";
import { resolveShortcutCommand } from "../keybindings";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isPreviewSupportedInRuntime } from "../previewStateStore";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { primaryServerKeybindingsAtom } from "~/state/server";

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupCount = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: () => null,
      }).length,
    [primaryEnvironmentId, projectGroupingSettings, projects],
  );
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  // The `previewOpen` shortcut-context flag here uses the store-only value;
  // the URL-aware arbitration lives inside ChatView's `onTogglePreview`,
  // which we invoke via the action bus to avoid duplicating the rule.
  const previewOpen = useRightPanelStore((state) =>
    routeThreadRef
      ? selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "preview"
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });

      if (isCommandPaletteOpen()) {
        return;
      }

      if (command === "thread.undo") {
        if (event.repeat || isModelPickerOpen()) return;
        if (undoLatestThreadAction()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      if (event.key === "Escape" && selectedThreadKeysSize > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      if (command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        // The default sidebar routes creation through the command palette
        // whenever there is a real choice to make; the legacy sidebar (and
        // single-project setups) keep the immediate contextual create.
        if (!legacySidebarEnabled && projectGroupCount > 1) {
          openCommandPalette({ open: "new-thread-in" });
          return;
        }
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
        return;
      }

      if (command === "preview.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (!routeThreadRef) return;
        if (!isPreviewSupportedInRuntime()) {
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: "Preview is desktop-only",
              description: "Open T3 Code in the desktop app to use the in-app preview.",
            }),
          );
          return;
        }
        dispatchPreviewAction("toggle-panel");
        return;
      }

      // The remaining preview commands only fire when the panel is the
      // currently-focused tenant. The `when: previewFocus` rule already
      // gates this, but defend against the keybinding being misconfigured.
      if (
        command === "preview.refresh" ||
        command === "preview.focusUrl" ||
        command === "preview.zoomIn" ||
        command === "preview.zoomOut" ||
        command === "preview.resetZoom"
      ) {
        event.preventDefault();
        event.stopPropagation();
        const action =
          command === "preview.refresh"
            ? "refresh"
            : command === "preview.focusUrl"
              ? "focus-url"
              : command === "preview.zoomIn"
                ? "zoom-in"
                : command === "preview.zoomOut"
                  ? "zoom-out"
                  : "reset-zoom";
        dispatchPreviewAction(action);
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activeDraftThread,
    activeThread,
    clearSelection,
    handleNewThread,
    keybindings,
    defaultProjectRef,
    previewOpen,
    projectGroupCount,
    routeThreadRef,
    selectedThreadKeysSize,
    legacySidebarEnabled,
    terminalOpen,
  ]);

  return null;
}

function ChatRouteLayout() {
  const selectedMember = useLocation({
    select: (location) => new URLSearchParams(location.searchStr).get("member"),
  });
  // Both thread routes render here, not in their own leaf components, so the
  // draft-to-thread promotion keeps one ChatView mounted across the swap.
  const threadTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const homeProject = useParams({
    strict: false,
    select: (params) =>
      params.environmentId && params.projectId
        ? scopeProjectRef(
            EnvironmentId.make(params.environmentId),
            ProjectId.make(params.projectId),
          )
        : null,
  });
  const home = useProjectHomeDraft(homeProject);
  const threadShell = useThreadShell(
    threadTarget?.kind === "server" ? threadTarget.threadRef : null,
  );
  const draft = useComposerDraftStore((state) =>
    home.draftId
      ? state.getDraftSession(home.draftId)
      : threadTarget?.kind === "draft"
        ? state.getDraftSession(threadTarget.draftId)
        : null,
  );
  const workspaceEnvironment =
    threadShell?.environmentId ?? draft?.environmentId ?? homeProject?.environmentId;
  const workspaceProject = threadShell?.projectId ?? draft?.projectId ?? homeProject?.projectId;
  const target =
    threadTarget ?? (home.draftId ? { kind: "draft" as const, draftId: home.draftId } : null);
  return (
    <>
      <ChatRouteGlobalShortcuts />
      {target ? (
        workspaceEnvironment && workspaceProject ? (
          <ConversationWorkspace
            environmentId={workspaceEnvironment}
            projectId={workspaceProject}
            primaryLabel={threadShell?.title ?? "New thread"}
            primaryTarget={
              threadShell
                ? {
                    kind: "thread",
                    environmentId: workspaceEnvironment,
                    projectId: workspaceProject,
                    threadId: threadShell.id,
                    ...(selectedMember ? { member: selectedMember } : {}),
                    label: threadShell.title,
                  }
                : undefined
            }
          >
            {(threadShell?.id ?? draft?.threadId) ? (
              <AgentWorkspaceHandoffBanner
                key={`${workspaceEnvironment}:${threadShell?.id ?? draft?.threadId}`}
                environmentId={workspaceEnvironment}
                threadId={(threadShell?.id ?? draft?.threadId)!}
                persisted={Boolean(threadShell)}
              />
            ) : null}
            <ThreadRouteView target={target} projectHome={homeProject !== null} embedded />
          </ConversationWorkspace>
        ) : (
          <ThreadRouteView target={target} projectHome={homeProject !== null} />
        )
      ) : homeProject ? (
        <SidebarInset>
          <div className="space-y-4 p-8">
            <p role={home.error ? "alert" : "status"}>{home.error ?? "Opening project..."}</p>
            {home.error ? <Button onClick={home.retry}>Retry</Button> : null}
          </div>
        </SidebarInset>
      ) : (
        <Outlet />
      )}
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ChatRouteLayout,
});

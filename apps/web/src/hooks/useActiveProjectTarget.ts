import { useLayoutEffect } from "react";
import { useLocation } from "@tanstack/react-router";
import { useConversationWorkspaceChrome } from "../components/team/ConversationWorkspaceChrome";
import {
  useConversationWorkspaceStore,
  type ProjectWorkspaceTarget,
} from "../components/team/conversationWorkspaceStore";

export type ActiveProjectTarget = ProjectWorkspaceTarget;

function useWorkspaceRouteKey() {
  return useLocation({
    select: (location) => JSON.stringify([location.pathname, location.searchStr]),
  });
}

/** Mounted conversations own their workspace and the destination for search results. */
export function useRegisterProjectWorkspace(target: ActiveProjectTarget | null, enabled = true) {
  const chrome = useConversationWorkspaceChrome();
  const routeKey = useWorkspaceRouteKey();
  const paneId = chrome?.paneId ?? `route:${routeKey}`;
  useLayoutEffect(() => {
    if (!enabled) return;
    return useConversationWorkspaceStore.getState().registerWorkspace(paneId, { routeKey, target });
  }, [enabled, paneId, routeKey, target]);
}

/** Dialog focus does not change the conversation pane that opened it. */
export function useActiveProjectTarget(): ActiveProjectTarget | null {
  const routeKey = useWorkspaceRouteKey();
  return useConversationWorkspaceStore((state) => {
    const focused = state.focusedPane ? state.workspaceTargets[state.focusedPane] : undefined;
    if (focused?.routeKey === routeKey) return focused.target;
    return state.workspaceTargets[`route:${routeKey}`]?.target ?? null;
  });
}

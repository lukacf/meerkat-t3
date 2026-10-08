import { createContext, useContext, type ReactNode } from "react";

/** Pane-owned controls stay in each conversation header, never at viewport coordinates. */
export const ConversationWorkspaceChrome = createContext<{
  paneId: string;
  split: boolean;
  secondary: boolean;
  controls: ReactNode;
} | null>(null);

export function useConversationWorkspaceChrome() {
  return useContext(ConversationWorkspaceChrome);
}

export function ConversationWorkspaceControls() {
  return useConversationWorkspaceChrome()?.controls ?? null;
}

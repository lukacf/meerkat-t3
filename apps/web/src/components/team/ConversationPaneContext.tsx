import { createContext, useContext } from "react";

/** Global shortcuts must act only on the conversation whose pane owns focus. */
export const ConversationPaneContext = createContext<() => boolean>(() => true);
export function useConversationPaneActive() {
  return useContext(ConversationPaneContext);
}

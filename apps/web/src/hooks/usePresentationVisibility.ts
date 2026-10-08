import { createContext, useContext } from "react";

/** Presentation only: hidden panes retain drafts and never interrupt agent work. */
export const PresentationVisibility = createContext(true);
export function usePresentationVisibility() {
  return useContext(PresentationVisibility);
}

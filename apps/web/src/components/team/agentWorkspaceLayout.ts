const MIN_INLINE_TOOL_HEIGHT = 240;
const CONVERSATION_HEIGHT_RESERVE = 360;

export function resolveAgentWorkspaceLayout(paneHeight: number, expanded: boolean) {
  if (expanded) return { fullPane: true, height: "100%" } as const;
  if (paneHeight <= 0) return { fullPane: false, height: "max(240px, 35vh)" } as const;
  const inlineHeight = Math.min(416, paneHeight * 0.48, paneHeight - CONVERSATION_HEIGHT_RESERVE);
  return inlineHeight < MIN_INLINE_TOOL_HEIGHT
    ? { fullPane: true, height: "100%" as const }
    : { fullPane: false, height: inlineHeight };
}

/** Keep covered conversation controls out of keyboard and assistive-technology navigation. */
export function isolateAgentWorkspaceTools(panel: HTMLElement, pane: HTMLElement) {
  if (!pane.contains(panel)) return () => {};
  const covered = new Map<HTMLElement, boolean>();
  const parents = new Set<HTMLElement>();
  const coverSiblings = () => {
    let branch = panel;
    while (branch !== pane && branch.parentElement) {
      parents.add(branch.parentElement);
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
        if (!covered.has(sibling)) covered.set(sibling, sibling.inert);
        sibling.inert = true;
      }
      branch = branch.parentElement;
    }
  };
  coverSiblings();
  // Runtime notices and conversation controls can mount while the tools are open.
  const observer = new MutationObserver(coverSiblings);
  for (const parent of parents) observer.observe(parent, { childList: true });
  return () => {
    observer.disconnect();
    for (const [element, wasInert] of covered) element.inert = wasInert;
  };
}

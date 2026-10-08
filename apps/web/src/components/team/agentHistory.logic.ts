import type { ConsoleTimelineWindowPage } from "@t3tools/contracts";

export type AgentHistoryProgress = {
  started: boolean;
  after: string | undefined;
  exhausted: boolean;
  cursors: ReadonlyArray<string>;
};
export const INITIAL_AGENT_HISTORY: AgentHistoryProgress = {
  started: false,
  after: undefined,
  exhausted: false,
  cursors: [],
};

/** Recent is only a preview. Since owns forward progress through full native history. */
export function advanceAgentHistory(
  current: AgentHistoryProgress,
  page: ConsoleTimelineWindowPage,
): AgentHistoryProgress {
  const next = page.next_cursor;
  const progressed = Boolean(next) && next !== current.after && !current.cursors.includes(next!);
  return {
    started: true,
    after: next,
    exhausted: page.exhausted === true || !progressed,
    cursors: progressed ? [...current.cursors, next!] : current.cursors,
  };
}

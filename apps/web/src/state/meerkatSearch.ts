import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MeerkatConversationSearchMatch } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";
import { meerkatTeamEnvironment } from "./meerkatTeam";
import { useDebouncedValue } from "./queries";

export type EnvironmentAgentSearchMatch = MeerkatConversationSearchMatch & {
  environmentId: EnvironmentId;
};
const EMPTY_PAGES: Array<{ environmentId: EnvironmentId; cursor: string }> = [];
export function agentSearchMatchKey(match: EnvironmentAgentSearchMatch): string {
  return JSON.stringify([
    match.environmentId,
    match.projectId,
    match.instanceId,
    match.agentRef ?? match.projectAgentId,
  ]);
}

/** Every result comes from a bounded server page, never from currently mounted conversations. */
export function useMeerkatConversationSearch(
  environmentIds: readonly EnvironmentId[],
  query: string,
) {
  const normalized = query.trim();
  const debounced = useDebouncedValue(normalized, 200);
  const active = normalized.length >= 2 && normalized.length <= 200 && normalized === debounced;
  const key = JSON.stringify([environmentIds, normalized]);
  const [continuations, setContinuations] = useState<{
    key: string;
    pages: Array<{ environmentId: EnvironmentId; cursor: string }>;
  }>({ key: "", pages: [] });
  const pages = continuations.key === key ? continuations.pages : EMPTY_PAGES;
  const result = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) => {
          const matches: EnvironmentAgentSearchMatch[] = [];
          const nextPages: Array<{ environmentId: EnvironmentId; cursor: string }> = [];
          let pending = false;
          let unavailable = 0;
          let failed = 0;
          if (!active) return { matches, nextPages, pending, unavailable, failed };
          for (const environmentId of environmentIds) {
            const cursors: Array<string | undefined> = [
              undefined,
              ...pages
                .filter((page) => page.environmentId === environmentId)
                .map((page) => page.cursor),
            ];
            for (const cursor of cursors) {
              const request = get(
                meerkatTeamEnvironment.searchConversations({
                  environmentId,
                  input: { query: normalized, ...(cursor ? { cursor } : {}) },
                }),
              );
              pending ||= request.waiting;
              const value = Option.getOrNull(AsyncResult.value(request));
              if (value) {
                unavailable += value.unavailable;
                matches.push(...value.matches.map((match) => ({ ...match, environmentId })));
                if (value.nextCursor && !cursors.includes(value.nextCursor))
                  nextPages.push({ environmentId, cursor: value.nextCursor });
              } else if (AsyncResult.isFailure(request)) failed += 1;
            }
          }
          return { matches, nextPages, pending, unavailable, failed };
        }),
      [active, environmentIds, normalized, pages],
    ),
  );
  return {
    ...result,
    isPending: (normalized.length >= 2 && normalized !== debounced) || result.pending,
    loadMore: () => setContinuations({ key, pages: [...pages, ...result.nextPages] }),
  };
}

import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SidebarSection } from "../Sidebar.logic";

export const MEERKAT_HISTORY_INITIAL_COUNT = 10;
export const MEERKAT_HISTORY_PAGE_COUNT = 25;

type ThreadIdentity = Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "id">;
type ProjectIdentity = Pick<SidebarProjectSnapshot, "projectKey" | "memberProjectRefs">;

/** One visible ordering owns rendering, keyboard traversal, selection and bulk actions. */
export function buildMeerkatSidebarGroups<T extends ThreadIdentity, P extends ProjectIdentity>({
  projects,
  pinned,
  active,
  snoozed,
  settled,
  collapsed,
  historyCounts,
  routeThreadKey,
}: {
  projects: readonly P[];
  pinned: readonly T[];
  active: readonly T[];
  snoozed: readonly T[];
  settled: readonly T[];
  collapsed: Readonly<Record<string, boolean>>;
  historyCounts: Readonly<Record<string, number>>;
  routeThreadKey: string | null;
}) {
  const rows: { thread: T; section: SidebarSection }[] = [
    ...pinned.map((thread) => ({ thread, section: "pinned" as const })),
    ...active.map((thread) => ({ thread, section: "active" as const })),
    ...snoozed.map((thread) => ({ thread, section: "snoozed" as const })),
    ...settled.map((thread) => ({ thread, section: "settled" as const })),
  ];
  return projects.map((project) => {
    const projectKeys = new Set(
      project.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
    );
    const projectRows = rows.filter(({ thread }) =>
      projectKeys.has(`${thread.environmentId}:${thread.projectId}`),
    );
    const current = projectRows.filter(
      ({ section }) => section === "pinned" || section === "active",
    );
    const history = projectRows.filter(
      ({ section }) => section === "snoozed" || section === "settled",
    );
    const count = historyCounts[project.projectKey] ?? MEERKAT_HISTORY_INITIAL_COUNT;
    const visibleHistory = history.filter(
      ({ thread }, index) =>
        index < count ||
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
    );
    const expanded = collapsed[project.projectKey] !== true;
    return {
      project,
      projectKeys,
      expanded,
      items: expanded ? [...current, ...visibleHistory] : [],
      hiddenHistoryCount: history.length - visibleHistory.length,
    };
  });
}

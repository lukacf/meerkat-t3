import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { beforeEach, expect, it } from "vite-plus/test";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import {
  buildMeerkatSidebarGroups,
  MEERKAT_HISTORY_INITIAL_COUNT,
  MEERKAT_HISTORY_PAGE_COUNT,
} from "./meerkatSidebarRows";

const environmentId = EnvironmentId.make("environment");
const otherEnvironment = EnvironmentId.make("other-environment");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const projects = [
  { projectKey: "a", memberProjectRefs: [{ environmentId, projectId: projectA }] },
  { projectKey: "b", memberProjectRefs: [{ environmentId, projectId: projectB }] },
];
const thread = (projectId: ProjectId, id: string, environment = environmentId) => ({
  projectId,
  id: ThreadId.make(id),
  environmentId: environment,
});
const aPinned = thread(projectA, "a-pinned");
const aActive = thread(projectA, "a-active");
const bActive = thread(projectB, "b-active");
const aSnoozed = thread(projectA, "a-snoozed");
const aHistory = Array.from({ length: 50 }, (_, index) => thread(projectA, `a-past-${index}`));
const bHistory = Array.from({ length: 50 }, (_, index) => thread(projectB, `b-past-${index}`));
const input = {
  projects,
  pinned: [aPinned],
  active: [bActive, aActive],
  snoozed: [aSnoozed],
  settled: [...aHistory, ...bHistory],
  collapsed: {},
  historyCounts: {},
  routeThreadKey: null,
};
const key = (value: ReturnType<typeof thread>) =>
  scopedThreadKey(scopeThreadRef(value.environmentId, value.id));
const keysOf = (groups: readonly { items: readonly { thread: ReturnType<typeof thread> }[] }[]) =>
  groups.flatMap((group) => group.items.map(({ thread: row }) => key(row)));

beforeEach(() => useThreadSelectionStore.getState().clearSelection());

it("keeps active work visible and gives each project its own bounded history", () => {
  const groups = buildMeerkatSidebarGroups(input);
  expect(groups[0]!.items.map(({ thread: row }) => row.id)).toEqual([
    aPinned.id,
    aActive.id,
    aSnoozed.id,
    ...aHistory.slice(0, 9).map((row) => row.id),
  ]);
  expect(groups[1]!.items.map(({ thread: row }) => row.id)).toEqual([
    bActive.id,
    ...bHistory.slice(0, 10).map((row) => row.id),
  ]);
  expect(groups.map((group) => group.hiddenHistoryCount)).toEqual([41, 40]);
});

it("expands one project's history without taking history capacity from its neighbor", () => {
  const groups = buildMeerkatSidebarGroups({
    ...input,
    historyCounts: { a: MEERKAT_HISTORY_INITIAL_COUNT + MEERKAT_HISTORY_PAGE_COUNT },
  });
  expect(groups[0]!.items).toHaveLength(37);
  expect(groups[0]!.hiddenHistoryCount).toBe(16);
  expect(groups[1]!.items).toHaveLength(11);
  expect(groups[1]!.hiddenHistoryCount).toBe(40);
});

it("keeps a routed deep history row in place without duplicating it as pages expand", () => {
  const target = aHistory[42]!;
  const groups = buildMeerkatSidebarGroups({ ...input, routeThreadKey: key(target) });
  expect(groups[0]!.items.at(-1)?.thread).toBe(target);
  expect(groups[0]!.items).toHaveLength(13);
  expect(groups[0]!.hiddenHistoryCount).toBe(40);
  const expanded = buildMeerkatSidebarGroups({
    ...input,
    routeThreadKey: key(target),
    historyCounts: { a: 60 },
  });
  expect(keysOf(expanded).filter((value) => value === key(target))).toHaveLength(1);
  expect(expanded[0]!.hiddenHistoryCount).toBe(0);
});

it("uses the displayed project order for range selection and bulk-action membership", () => {
  const groups = buildMeerkatSidebarGroups({
    ...input,
    projects: projects.toReversed(),
    historyCounts: { a: 2, b: 2 },
  });
  const orderedKeys = keysOf(groups);
  expect(orderedKeys).toEqual([
    key(bActive),
    key(bHistory[0]!),
    key(bHistory[1]!),
    key(aPinned),
    key(aActive),
    key(aSnoozed),
    key(aHistory[0]!),
  ]);
  const selection = useThreadSelectionStore.getState();
  selection.setAnchor(key(bHistory[1]!));
  selection.rangeSelectTo(key(aSnoozed), orderedKeys);
  expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([
    key(bHistory[1]!),
    key(aPinned),
    key(aActive),
    key(aSnoozed),
  ]);
  const visibleRows = new Map(
    groups.flatMap((group) => group.items.map((row) => [key(row.thread), row] as const)),
  );
  expect(
    [...useThreadSelectionStore.getState().selectedThreadKeys].filter((value) =>
      visibleRows.has(value),
    ),
  ).toHaveLength(4);
});

it("removes collapsed rows from navigation and bulk actions while retaining page state", () => {
  const historyCounts = { a: 35 };
  const visible = buildMeerkatSidebarGroups({ ...input, historyCounts });
  const selection = useThreadSelectionStore.getState();
  selection.toggleThread(key(aHistory[20]!));
  selection.toggleThread(key(bActive));
  const collapsed = buildMeerkatSidebarGroups({ ...input, historyCounts, collapsed: { a: true } });
  const actionable = new Set(keysOf(collapsed));
  expect(collapsed[0]!.items).toHaveLength(0);
  expect(
    [...useThreadSelectionStore.getState().selectedThreadKeys].filter((value) =>
      actionable.has(value),
    ),
  ).toEqual([key(bActive)]);
  expect(
    keysOf(buildMeerkatSidebarGroups({ ...input, historyCounts, collapsed: { a: false } })),
  ).toEqual(keysOf(visible));
});

it("does not mix same-named physical projects across environments or hide grouped members", () => {
  const remote = thread(projectA, "remote-active", otherEnvironment);
  const groups = buildMeerkatSidebarGroups({ ...input, active: [remote, aActive] });
  expect(keysOf(groups)).not.toContain(key(remote));
  const grouped = buildMeerkatSidebarGroups({
    ...input,
    projects: [
      {
        projectKey: "combined",
        memberProjectRefs: [
          { environmentId, projectId: projectA },
          { environmentId: otherEnvironment, projectId: projectA },
        ],
      },
    ],
    active: [remote, aActive],
  });
  expect(
    grouped[0]!.items.filter((row) => row.section === "active").map((row) => key(row.thread)),
  ).toEqual([key(remote), key(aActive)]);
});

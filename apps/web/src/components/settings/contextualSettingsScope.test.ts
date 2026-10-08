import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { contextualSettingsScope } from "./contextualSettingsScope";
import { resolveSettingsScope } from "./settingsScope";

const a = EnvironmentId.make("laptop");
const b = EnvironmentId.make("server");
const projects = [a, b].map((environmentId) => ({
  environmentId,
  id: ProjectId.make("same-uuid"),
  title: "Same project",
  workspaceRoot: "/checkout",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-28T00:00:00Z",
  updatedAt: "2026-09-28T00:00:00Z",
}));
const groups = buildSidebarProjectSnapshots({
  projects,
  settings: { sidebarProjectGroupingMode: "separate", sidebarProjectGroupingOverrides: {} },
  primaryEnvironmentId: a,
  resolveEnvironmentLabel: (id) => id,
});
const environments = [a, b].map((environmentId) => ({ environmentId, label: environmentId }));

describe("settings entry from native conversations", () => {
  it.each([a, b])("uses the exact physical project on %s", (environmentId) => {
    const search = contextualSettingsScope({
      environmentId,
      projectId: "same-uuid",
      groups,
      threads: [],
    });
    const scope = resolveSettingsScope(search, groups, environments);
    expect(scope.kind).toBe("checkout");
    expect(scope.members).toHaveLength(1);
    expect(scope.members[0]).toMatchObject({
      environmentId,
      id: "same-uuid",
      workspaceRoot: "/checkout",
    });
    expect(search.project).not.toBe("same-uuid");
  });
  it("resolves worker settings through its owning thread in the same environment", () => {
    const search = contextualSettingsScope({
      environmentId: b,
      threadId: "same-thread",
      groups,
      threads: [a, b].map((environmentId) => ({
        environmentId,
        id: "same-thread",
        projectId: ProjectId.make("same-uuid"),
      })),
    });
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "checkout",
      environmentId: b,
    });
  });
  it("clears unrelated route search and preserves removed targets as unavailable", () => {
    expect(contextualSettingsScope({ groups, threads: [] })).toEqual({
      project: undefined,
      machine: undefined,
      checkout: undefined,
    });
    expect(
      resolveSettingsScope(
        contextualSettingsScope({ environmentId: b, projectId: "removed", groups, threads: [] }),
        groups,
        environments,
      ),
    ).toMatchObject({ kind: "unavailable", members: [] });
  });
});

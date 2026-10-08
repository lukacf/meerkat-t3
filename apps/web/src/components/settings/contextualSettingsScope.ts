import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SettingsScopeSearch } from "./settingsScope";

/** Route project IDs identify physical projects, never logical settings groups. */
export function contextualSettingsScope(input: {
  environmentId?: string | undefined;
  projectId?: string | undefined;
  threadId?: string | undefined;
  groups: readonly SidebarProjectSnapshot[];
  threads: readonly { environmentId: EnvironmentId; id: string; projectId: ProjectId }[];
}): SettingsScopeSearch {
  const clear = { project: undefined, machine: undefined, checkout: undefined };
  if (!input.environmentId) return clear;
  const projectId =
    input.projectId ??
    input.threads.find(
      (thread) => thread.environmentId === input.environmentId && thread.id === input.threadId,
    )?.projectId;
  if (!projectId) return { ...clear, machine: input.environmentId };
  const group = input.groups.find((candidate) =>
    candidate.memberProjects.some(
      (project) => project.environmentId === input.environmentId && project.id === projectId,
    ),
  );
  const member = group?.memberProjects.find(
    (project) => project.environmentId === input.environmentId && project.id === projectId,
  );
  // A removed target stays unavailable instead of broadening the next write.
  return {
    project: group?.projectKey ?? projectId,
    machine: input.environmentId,
    checkout: member?.physicalProjectKey,
  };
}

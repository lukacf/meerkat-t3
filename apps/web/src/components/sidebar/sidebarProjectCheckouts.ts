export function sidebarCheckoutLabel(project: {
  readonly environmentId: string;
  readonly environmentLabel?: string | null;
  readonly workspaceRoot: string;
}): string {
  return `${project.environmentLabel?.trim() || project.environmentId} - ${project.workspaceRoot}`;
}

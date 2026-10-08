import type { ProjectId } from "@t3tools/contracts";

const PROJECT_TERMINAL_PREFIX = "project-terminal:";
/** Opaque PTY owner keys remain server-local and must never be branded as a ThreadId. */
export const projectTerminalOwnerKey = (projectId: ProjectId) =>
  `${PROJECT_TERMINAL_PREFIX}${projectId.length}:${projectId}`;
export const isProjectTerminalOwner = (key: string) => key.startsWith(PROJECT_TERMINAL_PREFIX);

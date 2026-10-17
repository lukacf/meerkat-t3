import type {
  EnvironmentId,
  ScopedProjectRef,
  SharedCheckout,
  SharedProject,
  SharedSpecialist,
  SharedWorkspaceSnapshot,
  ThreadId,
} from "@t3tools/contracts";

export interface SharedProjectRosterEntry {
  readonly specialist: SharedSpecialist;
  readonly checkouts: ReadonlyArray<SharedCheckout>;
  readonly projects: ReadonlyArray<SharedProject>;
}

/** A checkout association is explicit; repository display grouping is not membership. */
export function sharedProjectRoster(
  snapshot: SharedWorkspaceSnapshot,
  localProjects: ReadonlyArray<ScopedProjectRef>,
): ReadonlyArray<SharedProjectRosterEntry> {
  if (!snapshot.participant) return [];
  const checkouts = snapshot.checkouts.filter(
    (checkout) =>
      checkout.participantId === snapshot.participant!.participantId &&
      localProjects.some(
        (project) =>
          project.environmentId === checkout.localEnvironmentId &&
          project.projectId === checkout.localProjectId,
      ),
  );
  return snapshot.specialists.flatMap((specialist) => {
    const assignedIds = new Set(
      specialist.assignments.map((assignment) => assignment.sharedProjectId),
    );
    const assignedCheckouts = checkouts.filter((checkout) =>
      assignedIds.has(checkout.sharedProjectId),
    );
    return assignedCheckouts.length
      ? [
          {
            specialist,
            checkouts: assignedCheckouts,
            projects: snapshot.projects.filter((project) =>
              assignedIds.has(project.sharedProjectId),
            ),
          },
        ]
      : [];
  });
}

/** The conversation belongs to the shared host; the navigation context stays local. */
export function sharedSpecialistDestination(
  environmentId: EnvironmentId,
  specialist: SharedSpecialist,
  checkout?: SharedCheckout,
  threadId?: ThreadId,
) {
  return {
    to: "/$environmentId/agents/$agentId" as const,
    params: { environmentId, agentId: specialist.specialistId },
    search: {
      project: specialist.nativeTarget.projectId,
      shared: true as const,
      ...(checkout
        ? {
            checkoutEnvironment: checkout.localEnvironmentId,
            checkoutProject: checkout.localProjectId,
            checkoutId: checkout.checkoutId,
            ...(threadId ? { checkoutThread: threadId } : {}),
          }
        : {}),
    },
  };
}

export function sharedHostStatus(
  phase: string,
  hasSnapshot: boolean,
  error: string | null,
  pending: boolean,
): string {
  if (phase === "offline" || phase === "available") return "Host offline";
  if (phase === "connecting" || phase === "reconnecting") return "Reconnecting";
  if (phase === "error" || phase === "unsupported" || error) return "Host unavailable";
  if (!hasSnapshot && pending) return "Syncing";
  if (!hasSnapshot) return "Not connected";
  return "Shared";
}

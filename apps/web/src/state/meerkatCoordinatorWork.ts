import type {
  EnvironmentId,
  MeerkatCoordinatorTarget,
  MeerkatCoordinatorWork,
  MeerkatProjectTeam,
  OrchestrationSession,
} from "@t3tools/contracts";
import { useEffect } from "react";
import { meerkatControlsEnvironment } from "./meerkatControls";
import { meerkatTeamEnvironment, useVisibleTeamRefresh } from "./meerkatTeam";
import { useEnvironmentQuery } from "./query";

/** A starting T3 session is only a placeholder until native admission completes. */
export function canObserveMeerkatCoordinator(session: OrchestrationSession | null | undefined) {
  return session?.providerName === "meerkat" && session.status !== "starting";
}

/** A durable conversation does not imply a currently loaded native coordinator. */
export function shouldPauseMeerkatCoordinatorObservation(
  target: MeerkatCoordinatorTarget,
  team: MeerkatProjectTeam,
) {
  if (team.projectId !== target.projectId) return false;
  const provider = team.providers.find((candidate) => candidate.instanceId === target.instanceId);
  if (!provider || (provider.status !== "ready" && provider.status !== "partial")) return false;
  const matches = provider.agents.filter(
    (agent) =>
      agent.threadId === target.threadId &&
      agent.mobKind === "thread" &&
      agent.record.runtime_member_id === "ingress" &&
      !agent.record.labels.source_mob_id,
  );
  if (matches.length > 0 && matches.every((agent) => agent.availability === "unloaded"))
    return true;
  // A successful snapshot can retain a remembered coordinator as unknown when
  // its workspace is loaded but its own mob is absent. Only live identities can
  // answer live requests. Legacy servers without availability retain lookup.
  return (
    provider.status === "ready" &&
    !matches.some((agent) => agent.availability === "live" || agent.availability === undefined)
  );
}

// Several inputs can contribute to one native run. An ambiguous snapshot must
// never turn Stop into a command against whichever run happens to be current.
export function coordinatorWorkTarget(
  target: MeerkatCoordinatorTarget | null,
  work: MeerkatCoordinatorWork | null,
) {
  const first = work?.inputs[0];
  if (!target || !work?.busy || !first || work.inputs.some((input) => input.runId !== first.runId))
    return null;
  return { ...target, sessionId: work.sessionId, inputId: first.inputId, nativeRunId: first.runId };
}

export function useMeerkatCoordinatorWork(
  environmentId: EnvironmentId,
  target: MeerkatCoordinatorTarget | null,
) {
  const team = useEnvironmentQuery(
    target
      ? meerkatTeamEnvironment.projectTeam({
          environmentId,
          input: { projectId: target.projectId },
        })
      : null,
  );
  useVisibleTeamRefresh(team, target !== null);
  // Failed or partial discovery still reaches the canonical lookup and retains
  // its error. Successful discovery with no live coordinator pauses controls;
  // roster refreshes notice when the conversation resumes.
  const isDormant =
    target !== null &&
    team.error === null &&
    team.data !== null &&
    shouldPauseMeerkatCoordinatorObservation(target, team.data);
  const hasTarget = target !== null && (team.data !== null || team.error !== null) && !isDormant;
  const query = useEnvironmentQuery(
    hasTarget ? meerkatControlsEnvironment.coordinatorWork({ environmentId, input: target }) : null,
  );
  const { isPending, refresh } = query;
  const workBusy = query.data?.busy;
  useEffect(() => {
    if (!hasTarget || isPending) return;
    const timer = window.setInterval(
      () => {
        if (document.visibilityState === "visible") refresh();
      },
      workBusy ? 1_000 : 3_000,
    );
    const refreshVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [hasTarget, isPending, workBusy, refresh]);
  // Failure must not leave controls attached to the last successful snapshot.
  const current = query.error ? null : query.data;
  return {
    ...query,
    isDormant,
    refresh: hasTarget ? query.refresh : team.refresh,
    busy: current?.busy === true,
    control: coordinatorWorkTarget(target, current),
  };
}

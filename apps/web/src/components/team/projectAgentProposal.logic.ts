import type {
  MeerkatProjectAgent,
  MeerkatProjectAgentProposalCandidate,
  MeerkatProjectProposal,
  ThreadId,
} from "@t3tools/contracts";

// Busy is also reported for ordinary threads. Only the saved setup binding makes
// that state a project-agent study in the conversation UI.
export function proposalVisibleInThread(
  snapshot: Pick<MeerkatProjectProposal, "isSetupThread" | "sourceThreadId"> | null | undefined,
  threadId: ThreadId,
) {
  return snapshot?.isSetupThread === true && snapshot.sourceThreadId === threadId;
}

function assignmentText(value: string | undefined) {
  return value?.replace(/\s+/gu, " ").trim() ?? "";
}

export function proposalAssignmentMatches(
  candidate: MeerkatProjectAgentProposalCandidate,
  agent: MeerkatProjectAgent,
) {
  return (
    candidate.role === agent.role &&
    assignmentText(candidate.focus) === assignmentText(agent.focus) &&
    assignmentText(candidate.charter) === assignmentText(agent.charter) &&
    JSON.stringify([...candidate.ownershipPaths].sort()) ===
      JSON.stringify([...(agent.ownershipPaths ?? [])].sort())
  );
}

/** A receipt can outrun a query, while later canonical observations must win. */
export function latestProposalAgent(
  observed: MeerkatProjectAgent | undefined,
  receipt: MeerkatProjectAgent | null | undefined,
) {
  if (!observed) return receipt ?? null;
  if (!receipt) return observed;
  const observedAt = [observed.preparation?.updatedAt ?? "", observed.updatedAt].sort().at(-1)!;
  const receiptAt = [receipt.preparation?.updatedAt ?? "", receipt.updatedAt].sort().at(-1)!;
  return observedAt >= receiptAt ? observed : receipt;
}

export function proposalCandidateState(
  candidate: MeerkatProjectAgentProposalCandidate,
  agent: MeerkatProjectAgent | null,
) {
  if (!agent) return { label: "Not created", actionable: true, retry: false };
  if (agent.archived) return { label: "Archived", actionable: false, retry: false };
  if (!agent.enabled) return { label: "Disabled", actionable: false, retry: false };
  if (!proposalAssignmentMatches(candidate, agent))
    return { label: "Different assignment", actionable: false, retry: false };
  switch (agent.preparation?.status) {
    case "ready":
      return { label: "Ready", actionable: false, retry: false };
    case "queued":
      return { label: "Study queued", actionable: false, retry: false };
    case "dispatching":
      return { label: "Starting study", actionable: false, retry: false };
    case "studying":
      return { label: "Studying domain", actionable: false, retry: false };
    case "failed":
      return { label: "Study failed", actionable: false, retry: true };
    case "interrupted":
      return { label: "Study interrupted", actionable: false, retry: true };
    case "uncertain":
      return { label: "Study outcome unknown", actionable: false, retry: true };
    default:
      return { label: "Not prepared", actionable: true, retry: false };
  }
}

/** Unaccepted suggestions are options, not unfinished preparation work. */
export function proposalPreparationSummary(
  rows: ReadonlyArray<{
    candidate: MeerkatProjectAgentProposalCandidate;
    agent: MeerkatProjectAgent | null;
    error?: string | null | undefined;
  }>,
) {
  let accepted = 0;
  let available = 0;
  let ready = 0;
  let preparing = 0;
  let failed = 0;
  let waiting = 0;
  let disabled = 0;
  for (const { candidate, agent, error } of rows) {
    const revisionAccepted =
      agent?.pendingRevision &&
      proposalAssignmentMatches(candidate, { ...agent, ...agent.pendingRevision });
    if (
      !agent ||
      agent.archived ||
      (!proposalAssignmentMatches(candidate, agent) && !revisionAccepted)
    ) {
      if (error) failed++;
      continue;
    }
    accepted++;
    if (agent.enabled) available++;
    if (error || agent.pendingRevision?.error) failed++;
    else if (!agent.enabled) disabled++;
    else if (revisionAccepted) waiting++;
    else {
      switch (agent.preparation?.status) {
        case "ready":
          ready++;
          break;
        case "queued":
        case "dispatching":
        case "studying":
          preparing++;
          break;
        case "failed":
        case "interrupted":
        case "uncertain":
          failed++;
          break;
        default:
          waiting++;
      }
    }
  }
  const parts = [
    failed ? `${failed} ${failed === 1 ? "needs" : "need"} attention` : null,
    ready ? `${ready} ${ready === 1 ? "agent" : "agents"} ready` : null,
    preparing ? `${preparing} studying` : null,
    waiting ? `${waiting} awaiting study` : null,
    disabled ? `${disabled} disabled` : null,
  ].filter(Boolean);
  return {
    accepted,
    available,
    ready,
    preparing,
    failed,
    label: parts.join(" · ") || `${rows.length} proposed`,
    allAcceptedReady: accepted > 0 && ready === accepted && failed === 0,
  };
}

import type {
  MeerkatProjectAgent,
  MeerkatProjectAgentProposalCandidate,
  SharedProject,
  SharedSpecialistRegisterInput,
} from "@t3tools/contracts";
import { sha256 } from "@noble/hashes/sha2";
import { proposalAssignmentMatches } from "./projectAgentProposal.logic";

/** Publication never changes native permissions or invents a new agent identity. */
export function canShareProposalAgent(
  candidate: MeerkatProjectAgentProposalCandidate,
  agent: MeerkatProjectAgent | null,
) {
  return Boolean(
    agent &&
    agent.accessMode === "repository-read-only" &&
    agent.enabled &&
    !agent.archived &&
    agent.connectionStatus === "connected" &&
    agent.agentRef &&
    !agent.error &&
    !agent.pendingRevision &&
    agent.preparation?.status === "ready" &&
    !agent.preparation.error &&
    proposalAssignmentMatches(candidate, agent),
  );
}

export function proposalSpecialistRegistration(
  project: SharedProject,
  proposalId: string,
  candidate: MeerkatProjectAgentProposalCandidate,
  agent: MeerkatProjectAgent,
): SharedSpecialistRegisterInput {
  if (project.hostProjectId !== agent.projectId || !canShareProposalAgent(candidate, agent))
    throw new Error(
      "Only a prepared repository-only specialist for this host project can be shared.",
    );
  const identity = JSON.stringify([
    project.sharedProjectId,
    proposalId,
    candidate.id,
    agent.projectId,
    agent.instanceId,
    agent.agentId,
  ]);
  const hash = Array.from(sha256(new TextEncoder().encode(identity)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    requestId: `shared-proposal:${hash}`,
    nativeTarget: {
      projectId: agent.projectId,
      instanceId: agent.instanceId,
      agentId: agent.agentId,
    },
    label: agent.label,
    assignments: [
      {
        sharedProjectId: project.sharedProjectId,
        charter: candidate.charter,
        paths: [...candidate.ownershipPaths],
        tags: [],
      },
    ],
  };
}

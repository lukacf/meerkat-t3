import type { MeerkatProjectAgentProposal } from "@t3tools/contracts";
export const PROJECT_AGENT_PROPOSAL_TOOL_NAME: string;
export function isProjectAgentProposalToolName(value: unknown): boolean;
export function normalizeOwnershipPath(value: unknown): string | null;
export function normalizeProjectAgentProposal(
  value: unknown,
  options?: { proposalId?: string },
): MeerkatProjectAgentProposal | null;

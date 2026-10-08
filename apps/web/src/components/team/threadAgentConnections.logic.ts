import type { MeerkatProjectAgent, MeerkatThreadConnections } from "@t3tools/contracts";

/** Actual edges remain visible while a disconnect is pending or has failed. */
export function visibleThreadProjectAgents(
  state: MeerkatThreadConnections | null,
  definitions: ReadonlyArray<Pick<MeerkatProjectAgent, "agentId" | "label">>,
) {
  if (!state) return [];
  const ids = [
    ...new Set([
      ...state.desiredAgentIds,
      ...state.connections
        .filter((entry) => entry.status === "connected")
        .map((entry) => entry.agentId),
    ]),
  ];
  return ids.map((agentId) => ({
    agentId,
    label: definitions.find((agent) => agent.agentId === agentId)?.label ?? "Saved agent",
  }));
}

export function latestThreadConnections(
  observation: MeerkatThreadConnections | null,
  observationTime: number | null,
  receipt: { value: MeerkatThreadConnections; at: number } | null,
) {
  return receipt && (observationTime ?? 0) <= receipt.at ? receipt.value : observation;
}

export function selectableThreadProjectAgents<
  A extends Pick<MeerkatProjectAgent, "agentId" | "archived">,
>(agents: ReadonlyArray<A>, selectedIds: ReadonlyArray<string>) {
  return agents.filter((agent) => !agent.archived || selectedIds.includes(agent.agentId));
}

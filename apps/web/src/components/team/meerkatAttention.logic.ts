import type {
  EnvironmentId,
  MeerkatAttentionItem,
  MeerkatTeamAgent,
  MeerkatTeamProvider,
} from "@t3tools/contracts";

export function attentionLabel(items: readonly MeerkatAttentionItem[]) {
  if (items.some((item) => item.active && (item.kind === "question" || item.kind === "approval")))
    return "Needs input";
  if (
    items.some(
      (item) =>
        item.active &&
        (item.kind === "query-error" ||
          item.kind === "delivery-error" ||
          item.completionStatus === "failed"),
    )
  )
    return "Needs attention";
  if (items.some((item) => item.unread && item.kind === "completion")) return "Unread";
  return null;
}
export function nativeAttentionDestination(
  environmentId: EnvironmentId,
  item: MeerkatAttentionItem,
) {
  const search = { attention: item.id, attentionInstance: item.instanceId };
  if (item.threadId && item.agentRef)
    return {
      to: "/$environmentId/$threadId" as const,
      params: { environmentId, threadId: item.threadId },
      search: { ...search, member: item.agentRef },
    };
  if (item.projectAgentId)
    return {
      to: "/$environmentId/agents/$agentId" as const,
      params: { environmentId, agentId: item.projectAgentId },
      search: { ...search, project: item.projectId },
    };
  return null;
}
export function validateNativeAttentionLocation(search: Record<string, unknown>) {
  return typeof search.attention === "string" &&
    search.attention.length > 0 &&
    typeof search.attentionInstance === "string" &&
    search.attentionInstance.length > 0
    ? { attention: search.attention, attentionInstance: search.attentionInstance }
    : {};
}
/** Session-scoped identity, not a display name, is the only automatic read match. */
export function matchingAttention(
  items: readonly MeerkatAttentionItem[],
  instanceId: string,
  agentRef: string,
  sessionId: string | undefined,
) {
  return items.filter(
    (item) =>
      item.instanceId === instanceId && item.agentRef === agentRef && item.sessionId === sessionId,
  );
}

/** Only the native ref, session and owning conversation can resolve a notification. */
export function attentionConversationTarget(
  item: MeerkatAttentionItem,
  providers: readonly MeerkatTeamProvider[],
  historicalAgent?: MeerkatTeamAgent,
) {
  if (!item.agentRef || !item.sessionId) return null;
  const provider = providers.find((entry) => entry.instanceId === item.instanceId);
  if (!provider) return null;
  const matches = (agent: MeerkatTeamAgent) =>
    agent.agentRef === item.agentRef &&
    agent.record.session_id === item.sessionId &&
    (item.threadId
      ? agent.threadId === item.threadId
      : Boolean(item.projectAgentId && agent.projectAgentId === item.projectAgentId));
  const agent = provider.agents.find(matches);
  if (agent) return { provider, agent, historical: false };
  return historicalAgent && matches(historicalAgent)
    ? { provider, agent: historicalAgent, historical: true }
    : null;
}

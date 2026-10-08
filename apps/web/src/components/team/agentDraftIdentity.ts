import type { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";

export type AgentDraftScope = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  instanceId: ProviderInstanceId;
};

export type AgentDraftIdentity =
  | { kind: "project-agent"; projectAgentId: string }
  | { kind: "native-agent"; durableId?: string | undefined; agentRef: string };

export type AgentDraftTarget = AgentDraftScope & { identity: AgentDraftIdentity };
const PREFIX = "native-agent-draft:v2:";

/** Only the primary project-agent panel may supply a project definition identity. */
export function agentConversationDraftKey(target: AgentDraftTarget): string {
  const identity = target.identity;
  return `${PREFIX}${JSON.stringify([
    target.environmentId,
    target.projectId,
    target.instanceId,
    ...(identity.kind === "project-agent"
      ? ["project-agent", identity.projectAgentId]
      : identity.durableId
        ? ["native-agent", identity.durableId]
        : ["native-session", identity.agentRef]),
  ])}`;
}

export function isCanonicalAgentDraftKey(key: string): boolean {
  return key.startsWith(PREFIX);
}

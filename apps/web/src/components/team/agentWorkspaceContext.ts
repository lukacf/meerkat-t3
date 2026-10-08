import type { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { DraftId } from "../../composerDraftStore";
import { agentConversationDraftKey, type AgentDraftTarget } from "./agentDraftIdentity";

/** The donor context store is keyed by native identity, never the coordinator conversation. */
export function agentWorkspaceDraftId(target: AgentDraftTarget): DraftId {
  return DraftId.make(`native-agent:${agentConversationDraftKey(target)}`);
}

export function projectAgentWorkspaceDraftId(target: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  instanceId: ProviderInstanceId;
  agentId: string;
}): DraftId {
  return agentWorkspaceDraftId({
    ...target,
    identity: { kind: "project-agent", projectAgentId: target.agentId },
  });
}

import type {
  MeerkatAgentWork,
  ModelSelection,
  ProviderInstanceId,
  ServerConfig,
} from "@t3tools/contracts";
import { toAppModelOption } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import {
  getComposerModelSendBlock,
  type ComposerModelSendBlock,
} from "../chat/composerModelReadiness";
import type { SendAttempt } from "./agentConversationDraftStore";
import { canSendAgentQueue } from "./agentUnsentQueueStore";
import { restoreReviewWorkBlock } from "./restoreReviewReadiness";
import {
  canCheckProviderWorkspaceReadiness,
  resolveProviderWorkspaceReadiness,
} from "@t3tools/client-runtime/providerWorkspaceReadiness";

/** Current sessions retain their account binding; explicit selections use workspace defaults. */
export function getAgentModelSendBlock(input: {
  readonly instanceId: ProviderInstanceId;
  readonly selection: ModelSelection | undefined;
  readonly currentModel: string | undefined;
  readonly modelAuth?: MeerkatAgentWork["modelAuth"];
  readonly steering: boolean;
  readonly cwd?: string | null | undefined;
  readonly serverConfig:
    | Pick<ServerConfig, "providers" | "settings" | "restoreReview">
    | null
    | undefined;
}): ComposerModelSendBlock | null {
  const restoreBlock = restoreReviewWorkBlock(input.serverConfig?.restoreReview);
  if (restoreBlock) return { reason: restoreBlock, action: null };
  if (input.steering) return null;
  const workspace = resolveProviderWorkspaceReadiness(
    input.serverConfig?.providers ?? [],
    input.cwd,
  );
  const provider = workspace.providers.find((entry) => entry.instanceId === input.instanceId);
  const entries = input.serverConfig
    ? applyProviderInstanceSettings(
        deriveProviderInstanceEntries(workspace.providers),
        input.serverConfig.settings,
      )
    : [];
  const entry = entries.find((candidate) => candidate.instanceId === input.instanceId);
  if (
    input.serverConfig &&
    (!provider ||
      !entry?.enabled ||
      !entry.installed ||
      !entry.isAvailable ||
      provider.status === "disabled" ||
      (provider.supportsWorkspaceReadiness === true &&
        !canCheckProviderWorkspaceReadiness(provider)))
  )
    return {
      reason: "Model access is unavailable. Check Settings > Providers before sending.",
      action: { kind: "settings", instanceId: input.instanceId, label: "Open provider settings" },
    };
  if (!input.selection) {
    if (input.modelAuth?.state === "connected") return null;
    const account = input.modelAuth?.accountLabel
      ? `the "${input.modelAuth.accountLabel}" account`
      : "this agent's model account";
    const reason =
      input.modelAuth?.state === "needs_auth"
        ? `Connect ${account} in Settings > Providers before sending. Your draft is saved.`
        : input.modelAuth?.state === "reauth_required"
          ? `Reconnect ${account} in Settings > Providers before sending. Your draft is saved.`
          : `Could not confirm access to ${account}. Check Settings > Providers or choose a model. Your draft is saved.`;
    return {
      reason,
      action: {
        kind: "settings",
        instanceId: input.instanceId,
        label:
          input.modelAuth?.state === "needs_auth" || input.modelAuth?.state === "reauth_required"
            ? "Connect model account"
            : "Open provider settings",
      },
    };
  }
  if (workspace.pendingInstanceIds.has(input.instanceId))
    return { reason: "Checking models for this workspace...", action: null };
  if (provider?.supportsWorkspaceReadiness === true && provider.status === "error")
    return {
      reason:
        "Could not check models for this workspace. Refresh this provider in Settings before sending. Your draft is saved.",
      action: { kind: "settings", instanceId: input.instanceId, label: "Open provider settings" },
    };
  if (input.selection.instanceId !== input.instanceId) {
    return {
      reason:
        "This model selection belongs to another provider. Choose a model for this agent or use its current model.",
      action: { kind: "models", label: "Choose model" },
    };
  }
  return getComposerModelSendBlock({
    entries,
    selections: [input.selection],
    modelOptionsByInstance: new Map(
      entries.map((entry) => [entry.instanceId, entry.models.map(toAppModelOption)]),
    ),
    catalogKnown: input.serverConfig != null,
    pendingWorkspaceInstanceIds: workspace.pendingInstanceIds,
    continuesActiveTurn: false,
    nativeInstanceIds: new Set([input.instanceId]),
  });
}

/** Only an explicit retry after a receipt absence may reuse an unsent request. */
export function getAgentDeliveryRetryBlock(input: {
  readonly attempt: SendAttempt;
  readonly absentRequestId: string | undefined;
  readonly currentAgentRef: string;
  readonly addressable: boolean;
  readonly work: { status: string; observedAt: string } | undefined;
  readonly now: number;
  readonly instanceId: ProviderInstanceId;
  readonly currentModel: string | undefined;
  readonly modelAuth?: MeerkatAgentWork["modelAuth"];
  readonly cwd?: string | null | undefined;
  readonly serverConfig:
    | Pick<ServerConfig, "providers" | "settings" | "restoreReview">
    | null
    | undefined;
}): ComposerModelSendBlock | null {
  const hold = (reason: string): ComposerModelSendBlock => ({ reason, action: null });
  if (input.absentRequestId !== input.attempt.requestId)
    return hold("Check the earlier delivery before retrying this message.");
  if (!input.attempt.agentRef || input.attempt.agentRef !== input.currentAgentRef)
    return hold(
      "The original agent session is no longer current. This request cannot be retried on a replacement agent.",
    );
  if (input.attempt.mode !== "queue")
    return hold(
      "An earlier steering request cannot be retried against later work. The original request is retained.",
    );
  if (!input.addressable) return hold("Reconnect the original agent before retrying this message.");
  if (!canSendAgentQueue(input.work, input.now))
    return hold("Wait for the original agent to become idle, then retry this same message.");
  return getAgentModelSendBlock({
    instanceId: input.instanceId,
    selection: input.attempt.modelSelection,
    currentModel: input.currentModel,
    modelAuth: input.modelAuth,
    steering: false,
    cwd: input.cwd,
    serverConfig: input.serverConfig,
  });
}

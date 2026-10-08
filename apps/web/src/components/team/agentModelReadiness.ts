import type { ModelSelection, ProviderInstanceId, ServerConfig } from "@t3tools/contracts";
import { currentModelCredentialRequirement } from "../../modelCredentials";
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

/** An omitted override keeps the native session's model; it is not an unknown catalog selection. */
export function getAgentModelSendBlock(input: {
  readonly instanceId: ProviderInstanceId;
  readonly selection: ModelSelection | undefined;
  readonly currentModel: string | undefined;
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
    provider?.driver === "meerkat" &&
    provider.supportsWorkspaceReadiness === true &&
    (!canCheckProviderWorkspaceReadiness(provider) || !entry?.enabled)
  )
    return {
      reason:
        "The selected Meerkat provider is unavailable. Check this provider in Settings before sending.",
      action: { kind: "settings", instanceId: input.instanceId, label: "Open provider settings" },
    };
  if (workspace.pendingInstanceIds.has(input.instanceId))
    return { reason: "Checking models for this workspace...", action: null };
  if (provider?.supportsWorkspaceReadiness === true && provider.status === "error")
    return {
      reason:
        "Could not check models for this workspace. Refresh this provider in Settings before sending. Your draft is saved.",
      action: { kind: "settings", instanceId: input.instanceId, label: "Open provider settings" },
    };
  if (!input.selection) {
    const exactCurrent = provider?.models.find((model) => model.slug === input.currentModel);
    const currentModels =
      provider?.models.filter(
        (model) =>
          input.currentModel !== undefined &&
          (model.slug === input.currentModel || model.slug.endsWith(`:${input.currentModel}`)),
      ) ?? [];
    const current = exactCurrent ?? (currentModels.length === 1 ? currentModels[0] : undefined);
    const currentHasCredentials =
      current?.credentialState === "connected" || current?.credentialState === "host_managed";
    const reason =
      currentModelCredentialRequirement(provider?.models ?? [], undefined, input.currentModel) ??
      (provider?.auth.status === "unauthenticated" && !currentHasCredentials
        ? "Connect a model account in Settings > Providers before sending. Your draft is saved."
        : null);
    return reason
      ? {
          reason,
          action: {
            kind: "settings",
            instanceId: input.instanceId,
            label: "Connect model account",
          },
        }
      : null;
  }
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
    steering: false,
    cwd: input.cwd,
    serverConfig: input.serverConfig,
  });
}

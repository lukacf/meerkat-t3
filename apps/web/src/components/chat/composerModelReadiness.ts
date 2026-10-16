import type {
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  RestoreReviewStatus,
  ServerProvider,
} from "@t3tools/contracts";
import { canCheckProviderWorkspaceReadiness } from "@t3tools/client-runtime/providerWorkspaceReadiness";
import { getMeerkatReasoningSelection } from "@t3tools/shared/model";
import { restoreReviewWorkBlock } from "../team/restoreReviewReadiness";
import { modelCredentialRequirement } from "../../modelCredentials";
import type { AppModelOption } from "../../modelSelection";
import type { ProviderInstanceEntry } from "../../providerInstances";

export interface ComposerModelSendBlock {
  readonly reason: string;
  /** Presentation may consolidate account guidance without classifying human-readable copy. */
  readonly accountSetup?: Pick<ModelSelection, "instanceId" | "model">;
  readonly action:
    | { readonly kind: "settings"; readonly instanceId: ProviderInstanceId; readonly label: string }
    | { readonly kind: "models"; readonly label: string }
    | null;
}

/** Keep primary-action labels distinct from transport connection state. */
export function resolveComposerPrimaryActionAvailability(input: {
  readonly environmentUnavailable: boolean;
  readonly noProviderAvailable: boolean;
  readonly providerCatalogPending: boolean;
  readonly projectSelectionRequired: boolean;
  readonly sendDisabledReason: string | null;
}) {
  return {
    isEnvironmentUnavailable: input.environmentUnavailable,
    sendDisabledReason:
      input.sendDisabledReason ??
      (input.projectSelectionRequired
        ? "Choose a project to send a message."
        : input.noProviderAvailable
          ? input.providerCatalogPending
            ? "Checking model access..."
            : "Model access is unavailable. Check Settings > Providers."
          : null),
  };
}

/** Native turns require an exact identity from the environment's current catalog. */
export function getComposerModelSendBlock(input: {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly selections: ReadonlyArray<ModelSelection>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  readonly catalogKnown: boolean;
  readonly pendingWorkspaceInstanceIds?: ReadonlySet<ProviderInstanceId>;
  readonly continuesActiveTurn: boolean;
  readonly restoreReview?: RestoreReviewStatus | undefined;
  /** Retained across async preparation so a removed native instance still blocks. */
  readonly nativeInstanceIds: ReadonlySet<ProviderInstanceId>;
}): ComposerModelSendBlock | null {
  const restoreBlock = restoreReviewWorkBlock(input.restoreReview);
  if (restoreBlock) return { reason: restoreBlock, action: null };
  // Answers and native steering use the active session, not a newly selected
  // model. A catalog refresh must not take away those controls.
  if (input.continuesActiveTurn) return null;
  for (const selection of input.selections) {
    const entry = input.entries.find((candidate) => candidate.instanceId === selection.instanceId);
    const options = input.modelOptionsByInstance.get(selection.instanceId) ?? [];
    const selected = options.find((option) => option.slug === selection.model);
    const isNative =
      entry?.driverKind === "meerkat" || input.nativeInstanceIds.has(selection.instanceId);
    const settingsAction = {
      kind: "settings" as const,
      instanceId: selection.instanceId,
      label: "Open provider settings",
    };
    if (
      isNative &&
      input.catalogKnown &&
      (!entry ||
        !entry.enabled ||
        !entry.isAvailable ||
        entry.status === "disabled" ||
        !entry.installed ||
        (entry.snapshot.supportsWorkspaceReadiness === true &&
          !canCheckProviderWorkspaceReadiness(entry.snapshot)))
    ) {
      return {
        reason: "Model access is unavailable. Check Settings > Providers.",
        action: settingsAction,
      };
    }
    if (isNative && input.pendingWorkspaceInstanceIds?.has(selection.instanceId))
      return { reason: "Checking models for this workspace...", action: null };
    const credentialModel = isNative
      ? selected?.isUnavailable
        ? undefined
        : selected
      : entry?.models.find((model) => model.slug === selection.model);
    const credentialBlock = modelCredentialRequirement(credentialModel, isNative);
    if (credentialBlock) {
      return {
        reason:
          credentialModel?.credentialState === "reauth_required"
            ? "Reconnect this model account to send."
            : credentialModel?.credentialState === "needs_auth"
              ? "Connect a model account to send."
              : credentialBlock,
        accountSetup: { instanceId: selection.instanceId, model: selection.model },
        action: { ...settingsAction, label: "Connect model account" },
      };
    }
    // Other drivers retain their own custom-model and startup validation rules.
    if (!isNative) continue;
    if (!input.catalogKnown) return { reason: "Checking available models...", action: null };
    const modelHasCredentials = selected?.credentialState === "connected";
    if (entry?.snapshot.supportsWorkspaceReadiness === true && entry.status === "error") {
      return {
        reason: "Could not check models for this workspace. Refresh the provider in Settings.",
        action: settingsAction,
      };
    }
    if (entry?.snapshot.auth.status === "unauthenticated" && !modelHasCredentials) {
      return {
        reason: "Connect a model account to send.",
        accountSetup: { instanceId: selection.instanceId, model: selection.model },
        action: { ...settingsAction, label: "Connect model account" },
      };
    }
    if (selected && !selected.isUnavailable) {
      const reasoning = getMeerkatReasoningSelection(
        entry?.models.find((model) => model.slug === selection.model)?.capabilities,
        selection.options,
      );
      if (reasoning.unavailable) {
        return {
          reason:
            "The saved reasoning level is unavailable. Choose a supported level or Model default.",
          action: null,
        };
      }
      continue;
    }
    const hasModels = options.some((option) => !option.isUnavailable);
    return {
      reason: hasModels
        ? "The selected model is unavailable. Choose another model."
        : "No models are available. Check provider settings.",
      action: hasModels ? { kind: "models", label: "Choose model" } : settingsAction,
    };
  }
  return null;
}

export interface ProjectHomeAccountSetup extends Pick<ModelSelection, "instanceId" | "model"> {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly replacesProviderBanner: boolean;
  readonly providerMessage: string | null;
}

/** Only an actual account block may replace the same workspace's redundant setup notices. */
export function getProjectHomeAccountSetup(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly provider: ServerProvider | null;
  readonly modelSendBlock: ComposerModelSendBlock | null;
  readonly noticeVisible: boolean;
  readonly providerBannerVisible: boolean;
}): ProjectHomeAccountSetup | null {
  const provider = input.provider;
  const account = input.modelSendBlock?.accountSetup;
  if (
    !input.noticeVisible ||
    !input.cwd ||
    !account ||
    !provider ||
    provider.instanceId !== account.instanceId ||
    provider.driver !== "meerkat" ||
    !provider.enabled ||
    !provider.installed ||
    provider.availability === "unavailable" ||
    (provider.status !== "ready" && provider.status !== "warning") ||
    provider.auth.status === "unknown" ||
    provider.compatibilityAdvisory?.status === "unsupported" ||
    provider.compatibilityAdvisory?.status === "broken"
  )
    return null;
  const replacesProviderBanner =
    input.providerBannerVisible &&
    provider.status === "warning" &&
    provider.auth.status === "unauthenticated";
  return {
    ...account,
    environmentId: input.environmentId,
    cwd: input.cwd,
    replacesProviderBanner,
    // Preserve all provider prose in the retained notice, including custom guidance.
    providerMessage: replacesProviderBanner ? (provider.message ?? null) : null,
  };
}

export function projectHomeAccountSetupMessage(input: {
  readonly accountSetup: ProjectHomeAccountSetup | null | undefined;
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly modelSendBlock: ComposerModelSendBlock | null;
}): string | null {
  const account = input.modelSendBlock?.accountSetup;
  const setup = input.accountSetup;
  return setup &&
    setup.environmentId === input.environmentId &&
    setup.cwd === input.cwd &&
    setup.instanceId === account?.instanceId &&
    setup.model === account?.model
    ? setup.providerMessage
    : null;
}

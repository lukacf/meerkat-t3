import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { resolveProviderWorkspaceReadiness } from "@t3tools/client-runtime/providerWorkspaceReadiness";

import type { ScopedSettingsTarget } from "./scopedSettings";
import type { ResolvedSettingsScope } from "./settingsScope";

/** Environment defaults use the default realm; project settings use their exact checkout. */
export function resolveSettingsProviderReadiness(
  scope: Pick<ResolvedSettingsScope, "kind" | "members"> | null,
  target: Pick<ScopedSettingsTarget, "environmentId" | "projectId"> | null,
  providers: ReadonlyArray<ServerProvider>,
) {
  const projectScoped = scope !== null && scope.kind !== "all" && scope.kind !== "environment";
  const cwd =
    projectScoped && target?.projectId
      ? (scope.members.find(
          (member) =>
            member.environmentId === target.environmentId && member.id === target.projectId,
        )?.workspaceRoot ?? null)
      : null;
  return {
    projectScoped,
    cwd,
    ...(projectScoped
      ? resolveProviderWorkspaceReadiness(providers, cwd)
      : { providers, pendingInstanceIds: new Set<ServerProvider["instanceId"]>() }),
  };
}

/** A saved native preference is not replaced just because another checkout has a different catalog. */
export function preserveSettingsNativeModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  stored: ModelSelection | null | undefined,
  resolved: ModelSelection,
): ModelSelection {
  return stored &&
    providers.some(
      (provider) => provider.instanceId === stored.instanceId && provider.driver === "meerkat",
    )
    ? stored
    : resolved;
}

export function settingsModelUnavailableLabel(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection | null,
): string | undefined {
  if (!selection) return undefined;
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  return provider?.driver === "meerkat" &&
    selection.model &&
    !provider.models.some((model) => model.slug === selection.model)
    ? `${selection.model} (Unavailable)`
    : undefined;
}

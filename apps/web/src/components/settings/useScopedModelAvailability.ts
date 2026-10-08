import type { ProviderInstanceId, UnifiedSettings } from "@t3tools/contracts";
import { useCallback } from "react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { useSettingsScope } from "./SettingsScopeContext";
import { resolveSettingsProviderReadiness } from "./settingsProviderReadiness";
import { useSettingsWorkspaceAccess } from "./SettingsWorkspaceReadiness";

/**
 * A model choice fans out to every selected target, so it must exist on all
 * of them. Returns the reason a (instance, model) pair cannot be applied, or
 * null when every target can honor it. The representative's entries decide
 * which driver the instance id names.
 */
export function useScopedModelDisabledReason(
  settings: UnifiedSettings,
  entries: readonly ProviderInstanceEntry[],
) {
  const { scope, targets } = useSettingsScope();
  const { environments } = useEnvironments();
  const access = useSettingsWorkspaceAccess();
  return useCallback(
    (instanceId: ProviderInstanceId, model: string): string | null => {
      const sourceEntry = entries.find((entry) => entry.instanceId === instanceId);
      for (const candidate of targets) {
        const environment = environments.find(
          (entry) => entry.environmentId === candidate.environmentId,
        );
        const config = environment?.serverConfig;
        if (!config) continue;
        const { providers, pendingInstanceIds, cwd } = resolveSettingsProviderReadiness(
          scope,
          candidate,
          config.providers,
        );
        if (pendingInstanceIds.has(instanceId)) {
          if (access.get(candidate.environmentId) !== "granted") {
            return access.get(candidate.environmentId) === "denied"
              ? `This connection cannot check models for ${cwd ?? candidate.label}. Reconnect with permission to operate this environment.`
              : "Waiting for connection permissions before checking checkout models.";
          }
          return `Checking models for ${cwd ?? candidate.label}. Try again when the check finishes.`;
        }
        const entry = applyProviderInstanceSettings(
          deriveProviderInstanceEntries(providers),
          candidate.settings,
        ).find((option) => option.instanceId === instanceId);
        const options = getCustomModelOptionsByInstance(
          { ...settings, ...candidate.settings },
          providers,
        ).get(instanceId);
        if (
          !entry?.enabled ||
          !entry.isAvailable ||
          entry.driverKind !== sourceEntry?.driverKind ||
          !options?.some((option) => option.slug === model && !option.isUnavailable)
        ) {
          return `This model is unavailable on ${cwd ?? environment?.label ?? "a selected environment"}. Select that checkout or environment to choose its model separately.`;
        }
      }
      return null;
    },
    [access, entries, environments, scope, settings, targets],
  );
}

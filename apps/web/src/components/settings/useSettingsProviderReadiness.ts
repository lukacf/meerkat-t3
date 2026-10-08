import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { resolveSettingsProviderReadiness } from "./settingsProviderReadiness";
import { useSettingsWorkspaceAccess } from "./SettingsWorkspaceReadiness";

/** A grouped scope displays its representative target, while writes validate all targets. */
export function useSettingsProviderReadiness(
  environmentId: EnvironmentId | null,
  providers: ReadonlyArray<ServerProvider>,
) {
  const context = useOptionalSettingsScope();
  const access = useSettingsWorkspaceAccess();
  const target =
    context?.target?.environmentId === environmentId
      ? context.target
      : (context?.targets.find((candidate) => candidate.environmentId === environmentId) ?? null);
  const readiness = resolveSettingsProviderReadiness(context?.scope ?? null, target, providers);
  const operateAccess = readiness.projectScoped
    ? environmentId === null
      ? "pending"
      : (access.get(environmentId) ?? "pending")
    : "granted";
  return {
    ...readiness,
    operateAccess,
    pendingMessage:
      operateAccess === "denied"
        ? "This connection cannot check checkout models."
        : operateAccess === "pending"
          ? "Waiting for connection permissions."
          : "Checking models for this checkout...",
  };
}

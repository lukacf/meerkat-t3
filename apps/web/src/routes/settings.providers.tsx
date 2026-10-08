import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { ProviderAccountContext } from "../components/settings/ProviderAccountContext";
import {
  resolveProviderAccountTarget,
  validateProviderAccountSearch,
} from "../components/settings/providerAccountTarget";

/**
 * Provider configuration belongs to one environment. Account status and models
 * follow the selected checkout, or its representative in a grouped selection.
 */
function SettingsProvidersRoute() {
  const target = Route.useSearch();
  const { environment, scope } = useSettingsScope();
  const account = resolveProviderAccountTarget(target);
  if (
    account.kind === "invalid" ||
    (account.kind === "thread" &&
      environment &&
      account.target.environmentId !== environment.environmentId)
  ) {
    return (
      <p role="alert" className="p-8 text-sm text-muted-foreground">
        This thread's account link is no longer valid. Open Providers from its conversation again.
      </p>
    );
  }
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to set up its providers.`
          : "Connect an environment to set up its providers."}
      </p>
    );
  }
  return (
    <ProviderAccountContext value={account.kind === "thread" ? account.target : null}>
      <ProviderSettingsPanel
        environmentId={environment.environmentId}
        {...(target.instanceId ? { instanceId: target.instanceId } : {})}
        scoped
      />
    </ProviderAccountContext>
  );
}

export const Route = createFileRoute("/settings/providers")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...validateProviderAccountSearch(raw),
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
  }),
  component: SettingsProvidersRoute,
});

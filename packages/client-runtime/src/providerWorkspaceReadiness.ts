import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

/** Machine eligibility is shared by pending UI state and the scoped probe. */
export function canCheckProviderWorkspaceReadiness(provider: ServerProvider): boolean {
  return (
    provider.driver === "meerkat" &&
    provider.supportsWorkspaceReadiness === true &&
    provider.enabled &&
    provider.installed &&
    provider.status !== "disabled" &&
    provider.availability !== "unavailable"
  );
}

export function hasProviderWorkspaceReadiness(
  provider: ServerProvider,
  cwd: string | null | undefined,
): boolean {
  return Boolean(
    cwd && provider.workspaceSnapshots?.some((row) => row.cwd === cwd && row.readiness),
  );
}

/** Model authority follows the exact execution workspace, never a nearby checkout. */
export function resolveProviderWorkspaceReadiness(
  providers: ReadonlyArray<ServerProvider>,
  cwd: string | null | undefined,
): {
  providers: ServerProvider[];
  pendingInstanceIds: ReadonlySet<ProviderInstanceId>;
} {
  const pendingInstanceIds = new Set<ProviderInstanceId>();
  return {
    providers: providers.map((provider): ServerProvider => {
      // Legacy servers and other drivers retain their existing catalog rules.
      if (provider.driver !== "meerkat" || provider.supportsWorkspaceReadiness !== true)
        return provider;
      const workspace = cwd
        ? provider.workspaceSnapshots?.find((row) => row.cwd === cwd && row.readiness)
        : undefined;
      const machine = { ...provider };
      delete machine.message;
      if (!workspace?.readiness) {
        const checkable = canCheckProviderWorkspaceReadiness(provider);
        if (checkable) pendingInstanceIds.add(provider.instanceId);
        return {
          ...machine,
          status: checkable ? "warning" : provider.status,
          auth: { status: "unknown" },
          models: [],
        };
      }
      const readiness = workspace.readiness;
      return {
        ...machine,
        status: provider.status === "disabled" ? "disabled" : readiness.status,
        auth: readiness.auth,
        models: readiness.models,
        checkedAt: workspace.checkedAt,
        ...(readiness.message ? { message: readiness.message } : {}),
      };
    }),
    pendingInstanceIds,
  };
}

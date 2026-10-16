import type { ServerProvider } from "@t3tools/contracts";

export function getOnboardingProviderState(provider: ServerProvider | undefined) {
  if (provider === undefined) return "checking";
  if (!provider.enabled || provider.status === "disabled") return "disabled";
  if (provider.availability === "unavailable") return "attention";
  if (!provider.installed) return "install";
  if (provider.auth.status === "unauthenticated") return "signIn";
  if (provider.status === "ready") return "ready";
  return "attention";
}

/** Donor harnesses cannot satisfy model access in this application. */
export function isOnboardingModelAccessReady(
  providers: ReadonlyArray<ServerProvider> | null | undefined,
): boolean {
  return (
    providers?.some(
      (provider) =>
        provider.driver === "meerkat" &&
        getOnboardingProviderState(provider) === "ready" &&
        provider.models.some((model) => model.credentialState === "connected"),
    ) ?? false
  );
}

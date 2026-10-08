import type { ProviderInstanceEnvironmentVariable, ServerProvider } from "@t3tools/contracts";
import { getOnboardingProviderState } from "./providerReadiness.logic";

export type CredentialSetupStage = "save" | "check";

/** A successful refresh request can still report a failed provider check. */
export function requireCredentialSetupReady(provider: ServerProvider | undefined): void {
  if (getOnboardingProviderState(provider) === "ready") return;
  throw new Error(
    provider?.message?.trim() ||
      (provider === undefined
        ? "Credentials saved, but this provider has not reported its status. Retry the check."
        : provider.auth.status === "unauthenticated"
          ? "Credentials saved, but the runtime did not detect usable credentials. Check your key and retry."
          : "Credentials saved, but this provider is not ready. Retry the check or open Providers to resolve it."),
  );
}

/** A failed probe retries only the probe; it must not write credentials again. */
export async function attemptCredentialSetup(input: {
  readonly stage: CredentialSetupStage;
  readonly variables: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly save: (variables: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => Promise<void>;
  readonly check: () => Promise<void>;
}): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly stage: CredentialSetupStage; readonly message: string }
> {
  let stage = input.stage;
  try {
    if (stage === "save") {
      await input.save(input.variables);
      stage = "check";
    }
    await input.check();
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      stage,
      message:
        cause instanceof Error
          ? cause.message
          : stage === "save"
            ? "Could not save credentials."
            : "Credentials saved, but the provider check failed.",
    };
  }
}

import type { ServerProviderModel } from "@t3tools/contracts";

type ModelCredentials = Pick<
  ServerProviderModel,
  "credentialState" | "subProvider" | "accountLabel"
>;

/** Native availability requires positively detected account access. */
export function modelCredentialRequirement(
  model: ModelCredentials | undefined,
  requireConnectedAccount = false,
): string | null {
  if (
    requireConnectedAccount &&
    model &&
    model.credentialState !== "connected" &&
    model.credentialState !== "needs_auth" &&
    model.credentialState !== "reauth_required"
  ) {
    return `Check ${model.accountLabel ?? model.subProvider ?? "this provider"} in Settings > Providers before using this model.`;
  }
  if (model?.credentialState !== "needs_auth" && model?.credentialState !== "reauth_required") {
    return null;
  }
  const provider = model.accountLabel ?? model.subProvider ?? "this provider";
  return model.credentialState === "reauth_required"
    ? `Reconnect ${provider} in Settings > Providers.`
    : `Connect ${provider} in Settings > Providers to use this model.`;
}

export function currentModelCredentialRequirement(
  models: ReadonlyArray<ServerProviderModel>,
  selected: string | undefined,
  current: string | undefined,
): string | null {
  if (selected)
    return modelCredentialRequirement(
      models.find((model) => model.slug === selected),
      true,
    );
  if (!current) return null;
  const exact = models.find((model) => model.slug === current);
  if (exact) return modelCredentialRequirement(exact, true);
  const matches = models.filter((model) => model.slug.endsWith(`:${current}`));
  return matches.length === 1 ? modelCredentialRequirement(matches[0], true) : null;
}

export function modelsWithCredentialsFirst<T extends ModelCredentials>(
  models: ReadonlyArray<T>,
  requireConnectedAccount = false,
): T[] {
  return [...models].sort(
    (a, b) =>
      Number(modelCredentialRequirement(a, requireConnectedAccount) !== null) -
      Number(modelCredentialRequirement(b, requireConnectedAccount) !== null),
  );
}

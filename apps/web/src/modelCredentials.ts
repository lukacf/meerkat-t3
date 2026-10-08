import type { ServerProviderModel } from "@t3tools/contracts";

type ModelCredentials = Pick<ServerProviderModel, "credentialState" | "subProvider">;

/** Only explicit missing credentials block selection; host-managed auth is resolved at runtime. */
export function modelCredentialRequirement(model: ModelCredentials | undefined): string | null {
  if (model?.credentialState !== "needs_auth" && model?.credentialState !== "reauth_required") {
    return null;
  }
  const provider = model.subProvider ?? "this provider";
  return model.credentialState === "reauth_required"
    ? `Reconnect ${provider} in Settings > Providers.`
    : `Connect ${provider} in Settings > Providers to use this model.`;
}

export function currentModelCredentialRequirement(
  models: ReadonlyArray<ServerProviderModel>,
  selected: string | undefined,
  current: string | undefined,
): string | null {
  if (selected) return modelCredentialRequirement(models.find((model) => model.slug === selected));
  if (!current) return null;
  const exact = models.find((model) => model.slug === current);
  if (exact) return modelCredentialRequirement(exact);
  const matches = models.filter((model) => model.slug.endsWith(`:${current}`));
  return matches.length === 1 ? modelCredentialRequirement(matches[0]) : null;
}

export function modelsWithCredentialsFirst<T extends ModelCredentials>(
  models: ReadonlyArray<T>,
): T[] {
  return [...models].sort(
    (a, b) =>
      Number(modelCredentialRequirement(a) !== null) -
      Number(modelCredentialRequirement(b) !== null),
  );
}

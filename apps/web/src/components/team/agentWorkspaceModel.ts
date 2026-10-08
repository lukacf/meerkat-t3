import type { ServerProviderModel } from "@t3tools/contracts";
import { modelCredentialRequirement } from "../../modelCredentials";

/** Native work reports raw model ids; the task API requires a catalog slug. */
export function resolveAgentWorkspaceModel(
  models: ReadonlyArray<ServerProviderModel>,
  current: string | undefined,
  currentProvider?: string | undefined,
): { model: ServerProviderModel | undefined; blockedReason: string | null } {
  const qualifiedCurrent =
    currentProvider && current && !current.startsWith(`${currentProvider}:`)
      ? `${currentProvider}:${current}`
      : current;
  const exact = qualifiedCurrent
    ? models.find((model) => model.slug === qualifiedCurrent)
    : undefined;
  const rawMatches =
    !currentProvider && current ? models.filter((model) => model.slug.endsWith(`:${current}`)) : [];
  const existing = exact ?? (rawMatches.length === 1 ? rawMatches[0] : undefined);
  if (existing) {
    const blockedReason = modelCredentialRequirement(existing);
    return { model: blockedReason ? undefined : existing, blockedReason };
  }
  if (currentProvider) {
    return {
      model: undefined,
      blockedReason:
        "The agent's current model is unavailable in this workspace. Check Settings > Providers.",
    };
  }
  const usable = models.filter((model) => !modelCredentialRequirement(model));
  const connected = usable.filter((model) => model.credentialState === "connected");
  const model =
    connected.find((model) => model.isDefault) ??
    connected[0] ??
    usable.find((model) => model.isDefault) ??
    usable[0];
  return {
    model,
    blockedReason: model ? null : "Connect a model in Settings > Providers before opening a task.",
  };
}

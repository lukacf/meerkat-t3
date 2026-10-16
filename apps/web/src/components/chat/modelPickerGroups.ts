import type { ProviderInstanceId } from "@t3tools/contracts";
import { modelCredentialRequirement } from "../../modelCredentials";
import { providerModelKey } from "../../modelOrdering";
import { getDisplayModelName, type ModelEsque } from "./providerIconUtils";

type GroupableModel = ModelEsque & { instanceId: ProviderInstanceId };

/** Native catalog tiers are preserved; favorites remain an explicit user preference. */
export function groupModelPickerModels<T extends GroupableModel>(
  models: ReadonlyArray<T>,
  favorites: ReadonlySet<string>,
): Array<{ label: string; models: T[] }> {
  const groups = [
    { label: "Favorites", models: [] as T[] },
    { label: "Recommended", models: [] as T[] },
    { label: "Other supported models", models: [] as T[] },
    { label: "Configured models", models: [] as T[] },
    { label: "Other models", models: [] as T[] },
    { label: "Unavailable models", models: [] as T[] },
  ];
  for (const model of models) {
    const group =
      model.isUnavailable || modelCredentialRequirement(model, true)
        ? 5
        : favorites.has(providerModelKey(model.instanceId, model.slug))
          ? 0
          : model.catalogTier === "recommended"
            ? 1
            : model.catalogTier === "supported"
              ? 2
              : model.catalogTier === "custom"
                ? 3
                : 4;
    groups[group]!.models.push(model);
  }
  if (
    !models.some(
      (model) =>
        model.catalogTier === "recommended" &&
        !model.isUnavailable &&
        modelCredentialRequirement(model, true) === null,
    )
  ) {
    groups[2]!.label = "Supported models";
  }
  return groups.filter((group) => group.models.length > 0);
}

/** Show IDs only when the human model name and account still leave a genuine ambiguity. */
export function duplicateModelPickerNames(
  models: ReadonlyArray<GroupableModel>,
  preferShortName: boolean,
): ReadonlySet<string> {
  const counts = new Map<string, number>();
  const labelKey = (model: GroupableModel) =>
    JSON.stringify([getDisplayModelName(model, { preferShortName }), model.accountLabel ?? ""]);
  for (const model of models) {
    const key = labelKey(model);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set(
    models
      .filter((model) => (counts.get(labelKey(model)) ?? 0) > 1)
      .map((model) => providerModelKey(model.instanceId, model.slug)),
  );
}

import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionSelections,
  ServerProvider,
} from "@t3tools/contracts";
import { getProviderModelControlCapabilities } from "@t3tools/shared/model";
import { modelCredentialRequirement } from "../../modelCredentials";

export const PROJECT_AGENT_PRESETS = [
  {
    label: "Architect",
    role: "architect",
    instructions:
      "Own system design, decomposition, architectural tradeoffs, and cross-project consistency. When asked to implement, make the smallest coherent architecture-preserving change.",
  },
  {
    label: "Reviewer",
    role: "reviewer",
    instructions:
      "Review code and UX changes for bugs, regressions, missing tests, and unclear behavior. Be concrete and line-oriented when evidence is available.",
  },
  {
    label: "Builder",
    role: "builder",
    instructions:
      "Implement product changes in the current project. Prefer existing patterns, run focused checks, and report concise progress.",
  },
] as const;

export function resolveProjectAgentModel<
  P extends Pick<ServerProvider, "instanceId" | "models" | "driver" | "enabled" | "availability">,
>(
  providers: ReadonlyArray<P>,
  preferred: ModelSelection | null | undefined,
  chosenInstance: ProviderInstanceId | null,
  chosenModel: string | null,
) {
  const eligible = providers.filter(
    (entry) => entry.driver === "meerkat" && entry.enabled && entry.availability !== "unavailable",
  );
  const provider =
    eligible.find((entry) => entry.instanceId === chosenInstance) ??
    eligible.find((entry) => entry.instanceId === preferred?.instanceId) ??
    eligible[0];
  const candidate =
    provider?.models.find((entry) => entry.slug === chosenModel) ??
    provider?.models.find(
      (entry) => provider.instanceId === preferred?.instanceId && entry.slug === preferred.model,
    ) ??
    provider?.models.find((entry) => entry.isDefault && !modelCredentialRequirement(entry, true)) ??
    provider?.models.find((entry) => !modelCredentialRequirement(entry, true));
  const model = modelCredentialRequirement(candidate, true) ? undefined : candidate;
  return { provider, model };
}

export function customProjectAgentRole(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^[^a-z]+/, "")
      .slice(0, 80)
      .replace(/-+$/, "") || "specialist"
  );
}

export function projectAgentPreferredOptions(
  preferred: ModelSelection | null | undefined,
  provider: Pick<ServerProvider, "instanceId"> | undefined,
  model: Pick<ServerProvider["models"][number], "slug"> | undefined,
): ProviderOptionSelections | undefined {
  return preferred?.instanceId === provider?.instanceId && preferred?.model === model?.slug
    ? preferred?.options
    : undefined;
}

export function isProjectAgentOptionSelections(value: unknown): value is ProviderOptionSelections {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        "id" in entry &&
        typeof entry.id === "string" &&
        entry.id.trim().length > 0 &&
        "value" in entry &&
        (typeof entry.value === "boolean" ||
          (typeof entry.value === "string" && entry.value.trim().length > 0)),
    )
  );
}

export function projectAgentReasoningControl(
  model: Pick<ServerProvider["models"][number], "capabilities"> | undefined,
  options: ProviderOptionSelections | undefined,
) {
  const descriptor = getProviderModelControlCapabilities(
    "meerkat",
    model?.capabilities,
  ).optionDescriptors?.find((entry) => entry.type === "select");
  const selected =
    options?.filter((entry) => entry.id !== "prompt_cache_enabled" && entry.value !== "default") ??
    [];
  const unavailable = selected.some(
    (entry) =>
      !descriptor ||
      entry.id !== descriptor.id ||
      !descriptor.options.some((option) => option.id === entry.value),
  );
  const value = selected.find((entry) => entry.id === descriptor?.id)?.value ?? "default";
  const label = unavailable
    ? `${selected.map((entry) => String(entry.value)).join(", ")} (unavailable)`
    : value === "default"
      ? "Model default"
      : (descriptor?.options.find((option) => option.id === value)?.label ?? String(value));
  return {
    descriptor,
    unavailable,
    value: unavailable ? "unavailable-selection" : String(value),
    label,
  };
}

export function existingProjectAgentPreset<
  A extends { instanceId: string; role: string; label: string },
>(
  agents: ReadonlyArray<A>,
  instanceId: string | undefined,
  preset: { role: string; label: string },
): A | undefined {
  return agents.find(
    (agent) =>
      agent.instanceId === instanceId &&
      (agent.role === preset.role || agent.label.toLowerCase() === preset.label.toLowerCase()),
  );
}

export function validateAgentSetupSearch(search: Record<string, unknown>): {
  instance?: string;
  model?: string;
  options?: ProviderOptionSelections;
} {
  return {
    ...(typeof search.instance === "string" && search.instance
      ? { instance: search.instance }
      : {}),
    ...(typeof search.model === "string" && search.model ? { model: search.model } : {}),
    ...(isProjectAgentOptionSelections(search.options) ? { options: search.options } : {}),
  };
}

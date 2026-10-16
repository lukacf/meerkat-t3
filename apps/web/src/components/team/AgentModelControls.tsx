import type {
  EnvironmentId,
  MeerkatAgentReasoningObservation,
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { useEnvironments } from "../../state/environments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Link } from "@tanstack/react-router";
import { modelCredentialRequirement, modelsWithCredentialsFirst } from "../../modelCredentials";
import { getProviderModelControlCapabilities } from "@t3tools/shared/model";
import { resolveProviderWorkspaceReadiness } from "@t3tools/client-runtime/providerWorkspaceReadiness";
import { useProviderWorkspaceReadiness } from "../../hooks/useProviderWorkspaceReadiness";
import type { ProviderAccountSearch } from "../settings/providerAccountTarget";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";

function observedReasoningLabel(
  observation: MeerkatAgentReasoningObservation | undefined,
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): string {
  if (!observation || observation.kind === "unknown") return "Keep current";
  if (observation.kind === "default") return "Current: Model default";
  const labels: Readonly<Record<string, string>> = {
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Xhigh",
    max: "Max",
    adaptive: "Adaptive",
    between_tools: "Between tools",
  };
  return `Current: ${observation.values
    .map(({ parameter, value }) => {
      const descriptor = descriptors.find((entry) => entry.id === parameter);
      const label =
        descriptor?.type === "select"
          ? descriptor.options.find((option) => option.id === value)?.label
          : undefined;
      return (
        label ??
        (/^\d+$/.test(value)
          ? `${Number(value).toLocaleString("en-US")} tokens`
          : (labels[value] ?? "Custom"))
      );
    })
    .join(" + ")}`;
}

export function AgentModelControls({
  environmentId,
  instanceId,
  settingsScope,
  value,
  onChange,
  disabled = false,
  currentModel,
  currentModelProvider,
  currentReasoning,
  cwd,
  open,
  onOpenChange,
}: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  settingsScope: ProviderAccountSearch;
  value: ModelSelection | undefined;
  onChange: (value: ModelSelection | undefined) => void;
  currentModel?: string | undefined;
  currentModelProvider?: string | undefined;
  currentReasoning?: MeerkatAgentReasoningObservation | undefined;
  cwd?: string | undefined;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { environments } = useEnvironments();
  const providers =
    environments.find((entry) => entry.environmentId === environmentId)?.serverConfig?.providers ??
    [];
  useProviderWorkspaceReadiness({ environmentId, cwd, providers, instanceId });
  const workspace = resolveProviderWorkspaceReadiness(providers, cwd);
  const provider = workspace.providers.find((entry) => entry.instanceId === instanceId);
  const checkingWorkspace = workspace.pendingInstanceIds.has(instanceId);
  const qualifiedCurrentModel =
    currentModelProvider && currentModel && !currentModel.startsWith(`${currentModelProvider}:`)
      ? `${currentModelProvider}:${currentModel}`
      : currentModel;
  const currentModelMatches =
    provider?.models.filter(
      (entry) => currentModel !== undefined && entry.slug.endsWith(`:${currentModel}`),
    ) ?? [];
  const currentCatalogModel =
    provider?.models.find((entry) => entry.slug === qualifiedCurrentModel) ??
    (!currentModelProvider && currentModelMatches.length === 1
      ? currentModelMatches[0]
      : undefined);
  const currentModelName = currentCatalogModel
    ? getTriggerDisplayModelName(currentCatalogModel)
    : currentModel;
  const model = value
    ? value.instanceId === instanceId
      ? provider?.models.find((entry) => entry.slug === value.model)
      : undefined
    : currentCatalogModel;
  const descriptors =
    getProviderModelControlCapabilities(provider?.driver ?? "meerkat", model?.capabilities)
      .optionDescriptors ?? [];
  const currentReasoningLabel = observedReasoningLabel(currentReasoning, descriptors);
  const currentReasoningUnavailable = !currentReasoning || currentReasoning.kind === "unknown";
  const hasUnselectableCurrentReasoning =
    currentReasoning?.kind === "configured" &&
    currentReasoning.values.some(
      ({ parameter, value }) =>
        !descriptors.some(
          (descriptor) =>
            descriptor.id === parameter &&
            descriptor.type === "select" &&
            descriptor.options.some((option) => option.id === value),
        ),
    );
  const selectedLabel = value
    ? model
      ? getTriggerDisplayModelName(model)
      : `${value.model} (${checkingWorkspace ? "checking" : "unavailable"})`
    : (currentModelName ?? "Current model");
  const changeOption = (id: string, option: string | boolean) => {
    if (!model || modelCredentialRequirement(model, true)) return;
    onChange({
      instanceId,
      model: model.slug,
      options: [
        ...(value?.options ?? []).filter(
          (entry) =>
            entry.id !== id && descriptors.some((descriptor) => descriptor.id === entry.id),
        ),
        ...(option === "default" ? [] : [{ id, value: option }]),
      ],
    });
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="xs"
                  disabled={disabled}
                  aria-label="Model for next message"
                />
              }
            />
          }
        >
          <span className="max-w-[min(12rem,30cqw)] truncate">{selectedLabel}</span>
          <ChevronDownIcon />
        </TooltipTrigger>
        <TooltipPopup>{model?.name ?? selectedLabel}</TooltipPopup>
      </Tooltip>
      <PopoverPopup side="top" align="start">
        <div className="w-72 space-y-3 p-3">
          <PopoverTitle>Model for next message</PopoverTitle>
          <Select
            disabled={disabled}
            value={value ? (model?.slug ?? "unavailable-selection") : "current"}
            onValueChange={(slug) => {
              if (slug === "current") onChange(undefined);
              else {
                const next = provider?.models.find((entry) => entry.slug === slug);
                if (next && !modelCredentialRequirement(next, true))
                  onChange({ instanceId, model: next.slug });
              }
            }}
          >
            <Tooltip>
              <TooltipTrigger render={<SelectTrigger aria-label="Choose model" size="sm" />}>
                <SelectValue placeholder="Current model">
                  {value
                    ? selectedLabel
                    : currentModelName
                      ? `Current: ${currentModelName}`
                      : "Current model"}
                </SelectValue>
              </TooltipTrigger>
              <TooltipPopup>{model?.name ?? selectedLabel}</TooltipPopup>
            </Tooltip>
            <SelectPopup>
              <SelectItem value="current">Use current agent model</SelectItem>
              {value && !model ? (
                <SelectItem value="unavailable-selection" disabled>
                  {selectedLabel}
                </SelectItem>
              ) : null}
              {modelsWithCredentialsFirst(provider?.models ?? [], true).map((entry) => (
                <SelectItem
                  key={entry.slug}
                  value={entry.slug}
                  disabled={Boolean(modelCredentialRequirement(entry, true))}
                >
                  {entry.name}
                  {modelCredentialRequirement(entry, true) ? " (connect account)" : ""}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {(!provider?.models.length ||
            (value && !model) ||
            provider.models.some((entry) => modelCredentialRequirement(entry, true))) && (
            <p className="text-xs text-muted-foreground">
              {checkingWorkspace
                ? "Checking models for this workspace."
                : value && !model
                  ? "The saved selection is unavailable. Choose another model or use the agent's current model."
                  : !provider?.models.length
                    ? "No models are available from this provider."
                    : "Some models need another account."}{" "}
              {!checkingWorkspace && (
                <Link
                  to="/settings/providers"
                  search={{ ...settingsScope, environmentId, instanceId }}
                >
                  Connect in Providers
                </Link>
              )}
            </p>
          )}
          {descriptors.map((descriptor) => {
            if (descriptor.type === "boolean") {
              return (
                <label key={descriptor.id} className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={
                      value?.options?.find((entry) => entry.id === descriptor.id)?.value === true
                    }
                    onChange={(event) => changeOption(descriptor.id, event.target.checked)}
                  />
                  {descriptor.label}
                </label>
              );
            }
            const selectedValue = value
              ? String(
                  value.options?.find((entry) => entry.id === descriptor.id)?.value ?? "default",
                )
              : "current";
            const selectedOptionLabel =
              selectedValue === "current"
                ? currentReasoningLabel
                : selectedValue === "default"
                  ? "Model default"
                  : (descriptor.options.find((option) => option.id === selectedValue)?.label ??
                    selectedValue);
            return (
              <Select
                key={descriptor.id}
                disabled={disabled || Boolean(modelCredentialRequirement(model, true))}
                value={selectedValue}
                onValueChange={(option) => {
                  if (option === "current") onChange(undefined);
                  else if (option) changeOption(descriptor.id, option);
                }}
              >
                <SelectTrigger aria-label={descriptor.label}>
                  <SelectValue placeholder={descriptor.label}>
                    {descriptor.label}: {selectedOptionLabel}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {!value ? (
                    <SelectItem value="current">
                      {descriptor.label}: {currentReasoningLabel}
                    </SelectItem>
                  ) : null}
                  <SelectItem value="default">{descriptor.label}: Model default</SelectItem>
                  {descriptor.options
                    .filter((option) => option.id !== "default")
                    .map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                </SelectPopup>
              </Select>
            );
          })}
          {!value && descriptors.length === 0 && currentReasoning && (
            <p className="text-xs text-muted-foreground">
              Reasoning level: {currentReasoningLabel}
            </p>
          )}
          {!value && currentReasoningUnavailable && descriptors.length > 0 && (
            <p className="text-xs text-muted-foreground">
              The current reasoning level is unavailable. Keeping current preserves the agent's
              settings.
            </p>
          )}
          {!value && hasUnselectableCurrentReasoning && (
            <p className="text-xs text-muted-foreground">
              Some current settings are not offered here. Keeping current preserves them.
            </p>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            Changes apply to your next message when this agent is idle.
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

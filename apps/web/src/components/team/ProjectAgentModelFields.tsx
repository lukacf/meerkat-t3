import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderOptionSelections,
  ServerProvider,
} from "@t3tools/contracts";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Link } from "@tanstack/react-router";
import { modelCredentialRequirement, modelsWithCredentialsFirst } from "../../modelCredentials";
import { projectAgentReasoningControl } from "./projectAgentSetup.logic";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";

export function ProjectAgentModelFields({
  providers,
  environmentId,
  provider,
  model,
  options,
  disabled = false,
  checkingModels = false,
  onProviderChange,
  onModelChange,
  onOptionsChange,
}: {
  providers: ReadonlyArray<ServerProvider>;
  environmentId: EnvironmentId;
  provider: ServerProvider | undefined;
  model: ServerProvider["models"][number] | undefined;
  options: ProviderOptionSelections | undefined;
  disabled?: boolean;
  checkingModels?: boolean;
  onProviderChange: (instanceId: ProviderInstanceId) => void;
  onModelChange: (model: string | null) => void;
  onOptionsChange: (options: ProviderOptionSelections) => void;
}) {
  const reasoning = projectAgentReasoningControl(model, options);
  const showProviderSelection =
    providers.length > 1 ||
    (providers.length === 1 && provider?.instanceId !== providers[0]?.instanceId);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {showProviderSelection && (
        <div className="space-y-2">
          <span className="text-sm">Provider</span>
          <Select
            value={provider?.instanceId ?? null}
            disabled={disabled}
            onValueChange={(value) => {
              const next = providers.find((entry) => entry.instanceId === value);
              if (next) onProviderChange(next.instanceId);
            }}
          >
            <SelectTrigger aria-label="Agent provider">
              <SelectValue placeholder="Choose provider">
                {provider?.displayName ?? provider?.instanceId}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {providers.map((entry) => (
                <SelectItem key={entry.instanceId} value={entry.instanceId}>
                  {entry.displayName ?? entry.instanceId}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      )}
      <div className={showProviderSelection ? "space-y-2" : "space-y-2 sm:col-span-2"}>
        <span className="text-sm">Model</span>
        <Select value={model?.slug ?? null} disabled={disabled} onValueChange={onModelChange}>
          <SelectTrigger aria-label="Agent model" title={model?.name}>
            <SelectValue placeholder="Choose model">
              {model ? getTriggerDisplayModelName(model) : undefined}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
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
        {checkingModels ? (
          <p role="status" className="text-xs text-muted-foreground">
            Checking models for this project...
          </p>
        ) : provider && !provider.models.length ? (
          <p className="text-xs text-muted-foreground">
            {provider.status === "error"
              ? "Could not check this project's models."
              : "No models are available for this project."}{" "}
            <Link
              to="/settings/providers"
              search={{ environmentId, instanceId: provider.instanceId }}
            >
              Check provider settings
            </Link>
          </p>
        ) : null}
        {!checkingModels &&
          provider?.models.some((entry) => modelCredentialRequirement(entry, true)) && (
            <p className="text-xs text-muted-foreground">
              Some models need another account.{" "}
              <Link
                to="/settings/providers"
                search={{ environmentId, instanceId: provider.instanceId }}
              >
                Connect in Providers
              </Link>
              .
            </p>
          )}
      </div>
      {(reasoning.descriptor || reasoning.unavailable) && (
        <div className="space-y-2 sm:col-span-2">
          <span className="text-sm">Reasoning level</span>
          <Select
            value={reasoning.value}
            disabled={
              disabled ||
              !model ||
              checkingModels ||
              Boolean(modelCredentialRequirement(model, true))
            }
            onValueChange={(value) => {
              if (value === "default") onOptionsChange([]);
              else if (
                typeof value === "string" &&
                reasoning.descriptor?.options.some((option) => option.id === value)
              )
                onOptionsChange([{ id: reasoning.descriptor.id, value }]);
            }}
          >
            <SelectTrigger aria-label="Agent reasoning level">
              <SelectValue>{reasoning.label}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {reasoning.unavailable && (
                <SelectItem value="unavailable-selection" disabled>
                  {reasoning.label}
                </SelectItem>
              )}
              <SelectItem value="default">Model default</SelectItem>
              {reasoning.descriptor?.options
                .filter((option) => option.id !== "default")
                .map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
            </SelectPopup>
          </Select>
          {reasoning.unavailable && (
            <p role="status" className="text-xs text-muted-foreground">
              The saved reasoning level is unavailable. Choose a supported level or Model default to
              continue.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

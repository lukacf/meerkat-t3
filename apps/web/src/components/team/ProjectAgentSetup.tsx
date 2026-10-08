import type { EnvironmentId, ModelSelection, ProjectId, ServerProvider } from "@t3tools/contracts";
import { BotIcon, PlusIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { ProjectAgentModelFields } from "./ProjectAgentModelFields";
import { ProjectAgentPermissions } from "./ProjectAgentPermissions";
import {
  PROJECT_AGENT_PRESETS,
  customProjectAgentRole,
  projectAgentPreferredOptions,
  projectAgentReasoningControl,
  resolveProjectAgentModel,
} from "./projectAgentSetup.logic";

import { readRestoreReviewWorkBlock, useRestoreReviewWorkBlock } from "./useRestoreReview";
import { useProviderWorkspaceReadiness } from "../../hooks/useProviderWorkspaceReadiness";
import { getAgentModelSendBlock } from "./agentModelReadiness";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import {
  ProjectAgentCreationRecovery,
  useProjectAgentCreation,
} from "./ProjectAgentCreationRecovery";
import type {
  CreatedProjectAgent,
  ProjectAgentCreationDraft,
} from "./projectAgentCreationDraftStore";

export function ProjectAgentSetup({
  environmentId,
  projectId,
  providers: machineProviders,
  cwd,
  preferredModel,
  onCreated,
  onCancel,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  providers: ReadonlyArray<ServerProvider>;
  cwd?: string | undefined;
  preferredModel?: ModelSelection | null;
  onCreated: (agent: CreatedProjectAgent) => void;
  onCancel: () => void;
}) {
  const { providers, pendingInstanceIds } = useProviderWorkspaceReadiness({
    environmentId,
    cwd,
    providers: machineProviders,
  });
  const creation = useProjectAgentCreation({ environmentId, projectId, cwd }, onCreated);
  const { store, state, error, showError: setError } = creation;
  const {
    custom,
    label,
    role,
    instructions,
    instanceId,
    chosenModel,
    accessMode,
    options: savedOptions,
  } = state.draft.value;
  const activeAttempt = state.attempts.find(
    (entry) => entry.input.requestId === state.draft.intentId,
  );
  const pending = state.pendingIds.length > 0;
  const scopeReady = typeof cwd === "string" && cwd.trim().length > 0;
  const locked = !scopeReady || pending || activeAttempt !== undefined;
  const resolved = resolveProjectAgentModel(providers, preferredModel, instanceId, chosenModel);
  // A recovered explicit choice must not silently become another provider or model.
  const provider = instanceId
    ? providers.find(
        (entry) =>
          entry.instanceId === instanceId && entry.enabled && entry.availability !== "unavailable",
      )
    : resolved.provider;
  const model = chosenModel
    ? provider?.models.find((entry) => entry.slug === chosenModel)
    : resolved.model;
  const options =
    savedOptions ??
    (instanceId === null && chosenModel === null
      ? projectAgentPreferredOptions(preferredModel, provider, model)
      : undefined);
  const reasoning = projectAgentReasoningControl(model, options);
  const updateDraft = (patch: Partial<ProjectAgentCreationDraft>) =>
    state.updateDraft({
      // The first edit saves the displayed model and reasoning with the rest of the form.
      ...(instanceId === null && chosenModel === null && provider && model
        ? {
            instanceId: provider.instanceId,
            chosenModel: model.slug,
            ...(options !== undefined ? { options } : {}),
          }
        : {}),
      ...patch,
    });
  const restoreBlock = useRestoreReviewWorkBlock(environmentId);
  async function submit() {
    const currentBlock = readRestoreReviewWorkBlock(environmentId);
    if (currentBlock) {
      setError(currentBlock);
      return;
    }
    if (!provider || !model || !label.trim() || !role.trim() || !instructions.trim() || locked)
      return;
    if (reasoning.unavailable) {
      setError(
        "The saved reasoning level is unavailable. Choose a supported level or Model default.",
      );
      return;
    }
    const input = {
      projectId,
      instanceId: provider.instanceId,
      label: label.trim(),
      role: role.trim(),
      instructions: instructions.trim(),
      model: model.slug,
      ...(options !== undefined ? { options } : {}),
      accessMode,
    };
    const modelBlock = getAgentModelSendBlock({
      instanceId: provider.instanceId,
      selection: {
        instanceId: provider.instanceId,
        model: model.slug,
        ...(options !== undefined ? { options } : {}),
      },
      currentModel: undefined,
      steering: false,
      cwd,
      serverConfig: appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId),
    });
    if (modelBlock) {
      setError(modelBlock.reason);
      return;
    }
    await creation.dispatch(store.getState().beginCustom(input));
  }
  return (
    <section className="min-h-0 flex-1 overflow-auto px-5 py-8">
      <form
        className="mx-auto max-w-lg space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div>
          <div className="mb-2 flex items-center gap-2">
            <BotIcon className="size-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Add a project agent</h2>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Give a specialist its own conversation and a lasting role in your project.
          </p>
        </div>
        {!scopeReady && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading the project checkout before opening its saved setup...
          </p>
        )}
        <ProjectAgentCreationRecovery
          attempts={state.attempts}
          pendingIds={state.pendingIds}
          restoreBlock={restoreBlock}
          onRetry={(requestId) => void creation.retry(requestId)}
        />
        {activeAttempt && !state.pendingIds.includes(activeAttempt.input.requestId) && (
          <div className="space-y-2 rounded-lg bg-muted/40 p-3 text-sm">
            <p>
              {activeAttempt.accepted
                ? "This setup created an agent."
                : "This setup belongs to a request awaiting confirmation."}{" "}
              Its settings are locked so a retry cannot create a different agent.
            </p>
            {!activeAttempt.accepted && (
              <p className="text-xs text-muted-foreground">
                Starting a new request may create another agent if the earlier request succeeded.
                The earlier request remains available above.
              </p>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => store.getState().newDraft(true)}
            >
              {activeAttempt.accepted ? "Set up another agent" : "Edit as a new request"}
            </Button>
          </div>
        )}
        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground">Start with a role</span>
          <div className="flex flex-wrap gap-2">
            {PROJECT_AGENT_PRESETS.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                size="sm"
                variant={role === preset.role ? "secondary" : "outline"}
                disabled={locked}
                onClick={() => {
                  updateDraft({
                    custom: false,
                    label: preset.label,
                    role: preset.role,
                    instructions: preset.instructions,
                  });
                }}
              >
                {preset.label}
              </Button>
            ))}
            <Button
              type="button"
              size="sm"
              variant={
                !PROJECT_AGENT_PRESETS.some((preset) => preset.role === role)
                  ? "secondary"
                  : "outline"
              }
              disabled={locked}
              onClick={() => {
                updateDraft({ custom: true, label: "", role: "", instructions: "" });
              }}
            >
              Custom agent
            </Button>
          </div>
        </div>
        <label className="block space-y-2 text-sm">
          <span>Name</span>
          <Input
            value={label}
            placeholder="e.g. Design reviewer"
            autoFocus
            maxLength={120}
            disabled={locked}
            onChange={(event) => {
              updateDraft({
                label: event.target.value,
                ...(custom ? { role: customProjectAgentRole(event.target.value) } : {}),
              });
            }}
            required
          />
        </label>
        <label className="block space-y-2 text-sm">
          <span>Instructions</span>
          <Textarea
            value={instructions}
            placeholder="What should this agent own, and how should it work?"
            rows={6}
            maxLength={32000}
            disabled={locked}
            onChange={(event) => updateDraft({ instructions: event.target.value })}
            required
          />
          <span className="block text-xs text-muted-foreground">
            Include its responsibilities, useful files, and any constraints.
          </span>
        </label>
        <ProjectAgentModelFields
          environmentId={environmentId}
          providers={providers}
          provider={provider}
          model={model}
          options={options}
          checkingModels={provider ? pendingInstanceIds.has(provider.instanceId) : false}
          disabled={locked}
          onProviderChange={(next) => {
            updateDraft({ instanceId: next, chosenModel: null, options: [] });
          }}
          onModelChange={(chosenModel) =>
            updateDraft({
              instanceId: provider?.instanceId ?? instanceId,
              chosenModel,
              options: [],
            })
          }
          onOptionsChange={(options) =>
            updateDraft({
              instanceId: provider?.instanceId ?? instanceId,
              chosenModel: model?.slug ?? chosenModel,
              options,
            })
          }
        />
        <ProjectAgentPermissions
          value={accessMode}
          onChange={(accessMode) => updateDraft({ accessMode })}
          disabled={locked}
        />
        {(instanceId && !provider) || (chosenModel && !model) ? (
          <p role="status" className="text-sm text-muted-foreground">
            Saved selection: {instanceId} / {chosenModel ?? "Model default"}. It is unavailable for
            this project. Choose a provider and model to continue.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-warning-foreground">
            {error}
          </p>
        ) : null}
        {restoreBlock ? (
          <p role="status" className="text-sm text-muted-foreground">
            {restoreBlock}
          </p>
        ) : null}
        {!provider ? (
          <p className="text-sm text-muted-foreground">
            Enable a Meerkat provider in Settings to create project agents.
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => store.getState().newDraft(false)}
          >
            Discard draft
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Close
          </Button>
          <Button
            type="submit"
            disabled={
              locked ||
              restoreBlock !== null ||
              !provider ||
              !model ||
              reasoning.unavailable ||
              !label.trim() ||
              !role.trim() ||
              !instructions.trim()
            }
          >
            <PlusIcon />
            {pending ? "Creating agent..." : "Create agent"}
          </Button>
        </div>
      </form>
    </section>
  );
}

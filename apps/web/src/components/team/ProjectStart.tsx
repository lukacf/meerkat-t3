import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  MeerkatProjectAgentAccessMode,
  ModelSelection,
  ProjectId,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { BookOpenIcon, BotIcon, ChevronDownIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { useProjects } from "../../state/entities";
import { useProjectClone } from "../../state/projectClones";
import { useEnvironments } from "../../state/environments";
import { meerkatTeamEnvironment, useVisibleTeamRefresh } from "../../state/meerkatTeam";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { ProjectAgentPermissions, projectAgentPermissionLabel } from "./ProjectAgentPermissions";
import { readRestoreReviewWorkBlock, useRestoreReviewWorkBlock } from "./useRestoreReview";
import {
  PROJECT_AGENT_PRESETS,
  existingProjectAgentPreset,
  projectAgentPreferredOptions,
  projectAgentReasoningControl,
  resolveProjectAgentModel,
} from "./projectAgentSetup.logic";
import { useProviderWorkspaceReadiness } from "../../hooks/useProviderWorkspaceReadiness";
import { getAgentModelSendBlock } from "./agentModelReadiness";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import {
  ProjectAgentCreationRecovery,
  useProjectAgentCreation,
} from "./ProjectAgentCreationRecovery";
import { findProjectAgentCreationPreset } from "./projectAgentCreationDraftStore";
import { modelCredentialRequirement } from "../../modelCredentials";
import type { ProjectHomeAccountSetup } from "../chat/composerModelReadiness";

// Project specialists have their own model. Carry a compatible draft selection,
// otherwise use an available Meerkat model without changing the draft.
export function ProjectStart({
  environmentId,
  projectId,
  modelSelection,
  accountSetup,
  disabled = false,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  modelSelection: ModelSelection | null;
  accountSetup?: ProjectHomeAccountSetup | null;
  disabled?: boolean;
}) {
  const navigate = useNavigate();
  const project = useProjects().find(
    (entry) => entry.environmentId === environmentId && entry.id === projectId,
  );
  const { environments } = useEnvironments();
  const config = environments.find((entry) => entry.environmentId === environmentId)?.serverConfig;
  const workspace = useProviderWorkspaceReadiness({
    environmentId,
    cwd: project?.workspaceRoot,
    providers: config?.providers ?? [],
  });
  const providers = workspace.providers.filter(
    (entry) => entry.driver === "meerkat" && entry.enabled && entry.availability !== "unavailable",
  );
  const { provider, model } = resolveProjectAgentModel(providers, modelSelection, null, null);
  const options = projectAgentPreferredOptions(modelSelection, provider, model);
  const reasoning = projectAgentReasoningControl(model, options);
  const preferredModel = provider?.models.find((entry) => entry.slug === modelSelection?.model);
  const accountGuidanceInComposer =
    accountSetup !== null &&
    accountSetup !== undefined &&
    provider !== undefined &&
    accountSetup.environmentId === environmentId &&
    accountSetup.cwd === project?.workspaceRoot &&
    accountSetup.instanceId === provider.instanceId &&
    accountSetup.instanceId === modelSelection?.instanceId &&
    accountSetup.model === modelSelection?.model &&
    !workspace.pendingInstanceIds.has(accountSetup.instanceId) &&
    (provider.status === "ready" || provider.status === "warning") &&
    provider.auth.status !== "unknown" &&
    (modelCredentialRequirement(preferredModel) !== null ||
      (provider.auth.status === "unauthenticated" &&
        preferredModel?.credentialState !== "connected" &&
        preferredModel?.credentialState !== "host_managed"));
  const clone = useProjectClone(scopeProjectRef(environmentId, projectId));
  const repositoryReady = clone === null || clone.phase === "done";
  const agentsQuery = useEnvironmentQuery(
    project && providers.length > 0
      ? meerkatTeamEnvironment.projectAgents({ environmentId, input: { projectId } })
      : null,
  );
  const proposalQuery = useEnvironmentQuery(
    project && provider
      ? meerkatTeamEnvironment.projectProposal({
          environmentId,
          input: { projectId, instanceId: provider.instanceId },
        })
      : null,
  );
  useVisibleTeamRefresh(agentsQuery, true);
  useVisibleTeamRefresh(proposalQuery, true);
  const agents = agentsQuery.data?.agents.filter((entry) => !entry.archived) ?? [];
  const [addOpen, setAddOpen] = useState(false);
  const [accessMode, setAccessMode] = useState<MeerkatProjectAgentAccessMode>("read-only");
  const [error, setError] = useState<string | null>(null);
  const restoreBlock = useRestoreReviewWorkBlock(environmentId);
  const openAgent = (agentId: string) =>
    navigate({
      to: "/$environmentId/agents/$agentId",
      params: { environmentId, agentId },
      search: { project: projectId },
    });
  const creation = useProjectAgentCreation(
    { environmentId, projectId, cwd: project?.workspaceRoot },
    (agent) => void openAgent(agent.agentId),
  );
  const pending =
    creation.state.attempts.find((attempt) =>
      creation.state.pendingIds.includes(attempt.input.requestId),
    )?.input.label ?? null;

  async function introduce(preset: (typeof PROJECT_AGENT_PRESETS)[number]) {
    if (
      disabled ||
      !project ||
      !repositoryReady ||
      creation.state.pendingIds.length > 0 ||
      !agentsQuery.data ||
      agentsQuery.error
    )
      return;
    if (!creation.store.getState().refresh()) return;
    const saved = findProjectAgentCreationPreset(creation.store.getState().attempts, preset);
    if (saved) {
      await creation.retry(saved.input.requestId);
      return;
    }
    if (!provider || !model) return;
    const existing = existingProjectAgentPreset(
      agentsQuery.data.agents,
      provider.instanceId,
      preset,
    );
    if (existing) {
      await openAgent(existing.agentId);
      return;
    }
    const restoreBlock = readRestoreReviewWorkBlock(environmentId);
    if (restoreBlock) {
      setError(restoreBlock);
      return;
    }
    if (reasoning.unavailable) {
      setError(
        "The saved reasoning level is unavailable. Choose a supported level in the composer.",
      );
      return;
    }
    const input = {
      projectId,
      instanceId: provider.instanceId,
      model: model.slug,
      ...(options !== undefined ? { options } : {}),
      accessMode,
      ...preset,
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
      cwd: project.workspaceRoot,
      serverConfig: appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId),
    });
    if (modelBlock) {
      setError(modelBlock.reason);
      return;
    }
    setError(null);
    await creation.dispatch(creation.store.getState().beginPreset(input));
  }

  const setup = proposalQuery.data;
  const proposalLabel = setup?.proposal
    ? "Review proposed team"
    : setup?.isSourceThreadPersisted
      ? "Continue setup"
      : "Suggest agents";
  const openCustomAgent = () => {
    setAddOpen(false);
    void navigate({
      to: "/$environmentId/projects/$projectId/agents/new",
      params: { environmentId, projectId },
      search:
        provider && model
          ? {
              instance: provider.instanceId,
              model: model.slug,
              ...(options !== undefined ? { options } : {}),
            }
          : {},
    });
  };
  return (
    <section className="space-y-3 border-t border-border/60 pt-5 pb-6" aria-label="Project agents">
      <div className="flex items-center gap-2 text-sm font-medium">
        <BotIcon className="size-4 text-muted-foreground" />
        Project agents
        {agents.length > 0 ? (
          <span className="text-xs font-normal text-muted-foreground">{agents.length}</span>
        ) : null}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {agentsQuery.isPending && !agentsQuery.data
          ? "Loading project agents..."
          : agents.length === 0
            ? "Add specialists that know this project and collaborate across threads."
            : "Your specialists are available across threads in this project."}
      </p>
      {agents.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {agents.map((agent) => (
            <Tooltip key={agent.agentId}>
              <TooltipTrigger
                render={
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => void openAgent(agent.agentId)}
                  />
                }
              >
                <span className="max-w-44 truncate">{agent.label}</span>
                {!agent.enabled ? <span className="text-muted-foreground">Disabled</span> : null}
              </TooltipTrigger>
              <TooltipPopup>{agent.label}</TooltipPopup>
            </Tooltip>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={
            disabled ||
            pending !== null ||
            !repositoryReady ||
            !provider ||
            !setup ||
            (!setup.available && !setup.isSourceThreadPersisted)
          }
          onClick={() =>
            void navigate({
              to: "/$environmentId/projects/$projectId/agents/propose",
              params: { environmentId, projectId },
              search:
                provider && model
                  ? {
                      instance: provider.instanceId,
                      model: model.slug,
                      ...(options !== undefined ? { options } : {}),
                    }
                  : {},
            })
          }
        >
          <BookOpenIcon />
          {proposalLabel}
        </Button>
        <Popover open={addOpen} onOpenChange={setAddOpen}>
          <PopoverTrigger
            render={
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || pending !== null || !repositoryReady || !provider}
              />
            }
          >
            <PlusIcon /> Add agent <ChevronDownIcon />
          </PopoverTrigger>
          <PopoverPopup width="sm" align="start">
            <PopoverTitle>Add a project agent</PopoverTitle>
            <div className="mt-3">
              <ProjectAgentPermissions
                value={accessMode}
                onChange={setAccessMode}
                disabled={pending !== null}
              />
            </div>
            <div className="my-3 space-y-1">
              {PROJECT_AGENT_PRESETS.map((preset) => {
                const saved = findProjectAgentCreationPreset(creation.state.attempts, preset);
                const existing = existingProjectAgentPreset(
                  agentsQuery.data?.agents ?? [],
                  provider?.instanceId,
                  preset,
                );
                return (
                  <button
                    key={preset.role}
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
                    disabled={
                      disabled ||
                      (!existing && !saved?.accepted && restoreBlock !== null) ||
                      pending !== null ||
                      !repositoryReady ||
                      (!saved && !model) ||
                      !agentsQuery.data ||
                      agentsQuery.error !== null
                    }
                    onClick={() => {
                      setAddOpen(false);
                      void introduce(preset);
                    }}
                  >
                    <BotIcon className="size-4 text-muted-foreground" />
                    {saved
                      ? `${saved.accepted ? "Open" : "Retry"} ${saved.input.label}`
                      : existing
                        ? `Open ${existing.label}`
                        : preset.label}
                    {existing ? (
                      <span className="ml-auto text-xs text-muted-foreground">
                        {projectAgentPermissionLabel(existing.accessMode)}
                      </span>
                    ) : null}
                    {existing?.archived ? (
                      <span className="ml-auto text-xs text-muted-foreground">Archived</span>
                    ) : null}
                  </button>
                );
              })}
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent"
                onClick={openCustomAgent}
              >
                <PlusIcon className="size-4 text-muted-foreground" /> Custom agent
              </button>
            </div>
            {provider && model ? (
              <p className="text-xs text-muted-foreground">
                New agents use {model.name}
                {reasoning.descriptor || reasoning.unavailable
                  ? ` · ${reasoning.label} reasoning`
                  : ""}
                .
              </p>
            ) : null}
          </PopoverPopup>
        </Popover>
        {pending ? (
          <span role="status" className="text-xs text-muted-foreground">
            Creating {pending}...
          </span>
        ) : null}
      </div>
      <ProjectAgentCreationRecovery
        attempts={creation.state.attempts}
        pendingIds={creation.state.pendingIds}
        restoreBlock={restoreBlock}
        onRetry={(requestId) => void creation.retry(requestId)}
      />
      {!repositoryReady ? (
        <p role="status" className="text-xs text-muted-foreground">
          {clone?.phase === "running"
            ? `Cloning repository${clone.percent === null ? "" : ` (${clone.percent}%)`}. Agent setup will be available when ready.`
            : `Repository clone ${clone?.phase}. ${clone?.error ?? "Open a new thread to retry."}`}
        </p>
      ) : !provider ? (
        <p className="text-xs text-muted-foreground">
          Enable a Meerkat provider in Settings to add project agents.
        </p>
      ) : setup && !setup.available && !setup.isSourceThreadPersisted ? (
        <p className="text-xs text-muted-foreground">
          {setup.error ?? "Repository proposals are unavailable for this provider."}
        </p>
      ) : null}
      {provider && !model && !accountGuidanceInComposer ? (
        <p role="status" className="text-xs text-muted-foreground">
          {workspace.pendingInstanceIds.has(provider.instanceId) ? (
            "Checking models for this project..."
          ) : (
            <>
              No usable model is available for this project.{" "}
              <Link
                to="/settings/providers"
                search={{ environmentId, instanceId: provider.instanceId }}
              >
                Check provider settings
              </Link>
            </>
          )}
        </p>
      ) : null}
      {agentsQuery.error || proposalQuery.error || creation.error || error ? (
        <p role="alert" className="text-xs text-warning-foreground">
          {creation.error ?? error ?? agentsQuery.error ?? proposalQuery.error}
        </p>
      ) : null}
    </section>
  );
}

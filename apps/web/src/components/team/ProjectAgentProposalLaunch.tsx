import { ProjectAgentsGuide } from "../onboarding/ProjectAgentsGuide";
import {
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderOptionSelections,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveProviderWorkspaceReadiness } from "@t3tools/client-runtime/providerWorkspaceReadiness";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { BookOpenIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isElectron } from "../../env";
import { newMessageId, newThreadId } from "../../lib/utils";
import { useProjects, useThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { meerkatTeamEnvironment } from "../../state/meerkatTeam";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { PROJECT_AGENT_PROPOSAL_PROMPT } from "./projectAgentProposalPrompt";
import {
  projectAgentPreferredOptions,
  projectAgentReasoningControl,
  resolveProjectAgentModel,
} from "./projectAgentSetup.logic";
import { ProjectAgentModelFields } from "./ProjectAgentModelFields";
import { useProviderWorkspaceReadiness } from "../../hooks/useProviderWorkspaceReadiness";
import { getAgentModelSendBlock } from "./agentModelReadiness";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import { readRestoreReviewWorkBlock, useRestoreReviewWorkBlock } from "./useRestoreReview";

export function ProjectAgentProposalLaunch({
  environmentId,
  projectId,
  selectedModel,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  selectedModel?: ModelSelection | null;
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
  const settings = config
    ? resolveProjectSettings(config.settings, projectId, project).settings
    : null;
  const preferred = selectedModel
    ? settings?.defaultModelSelection?.instanceId === selectedModel.instanceId &&
      settings.defaultModelSelection.model === selectedModel.model
      ? { ...settings.defaultModelSelection, ...selectedModel }
      : selectedModel
    : settings?.defaultModelSelection;
  const [chosenInstance, setChosenInstance] = useState<ProviderInstanceId | null>(null);
  const [chosenModel, setChosenModel] = useState<string | null>(null);
  const [chosenOptions, setChosenOptions] = useState<ProviderOptionSelections | undefined>();
  const [retainedSelection, setRetainedSelection] = useState<ModelSelection | null>(null);
  const attempt = useRef<{
    threadId: ThreadId;
    modelSelection: ModelSelection;
    runtimeMode: RuntimeMode;
    createdAt: string;
  } | null>(null);
  const resolved = resolveProjectAgentModel(
    providers,
    retainedSelection ?? preferred,
    retainedSelection?.instanceId ?? chosenInstance,
    retainedSelection?.model ?? chosenModel,
  );
  const exactInstance = retainedSelection?.instanceId ?? chosenInstance;
  const exactModel = retainedSelection?.model ?? chosenModel;
  const provider = exactInstance
    ? providers.find((entry) => entry.instanceId === exactInstance)
    : resolved.provider;
  const model = exactModel
    ? provider?.models.find((entry) => entry.slug === exactModel)
    : resolved.model;
  const options = retainedSelection
    ? retainedSelection.options
    : (chosenOptions ?? projectAgentPreferredOptions(preferred, provider, model));
  const reasoning = projectAgentReasoningControl(model, options);
  const query = useEnvironmentQuery(
    meerkatTeamEnvironment.projectProposal({
      environmentId,
      input: { projectId, ...(provider ? { instanceId: provider.instanceId } : {}) },
    }),
  );
  const create = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const bind = useAtomCommand(meerkatTeamEnvironment.projectProposalSetup, {
    reportFailure: false,
  });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restoreBlock = useRestoreReviewWorkBlock(environmentId);
  const [createdThreadId, setCreatedThreadId] = useState<ThreadId | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [failedStage, setFailedStage] = useState<"create" | "bind" | "model" | "start" | null>(
    null,
  );
  const [requestedThreadId, setRequestedThreadId] = useState<ThreadId | null>(null);
  const inFlight = useRef(false);
  const destinationThreadId =
    requestedThreadId ??
    (!pending && !error && query.data?.isSourceThreadPersisted ? query.data.sourceThreadId : null);
  const destinationShell = useThreadShell(
    destinationThreadId ? scopeThreadRef(environmentId, destinationThreadId) : null,
  );
  const openThread = (threadId: ThreadId) => setRequestedThreadId(threadId);
  useEffect(() => {
    // The command receipt can arrive before the shell stream. Navigating before
    // its projection exists makes ThreadRouteView treat this as a missing thread.
    if (!pending && destinationThreadId && destinationShell) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: destinationThreadId },
        replace: true,
      });
    }
  }, [environmentId, destinationShell, destinationThreadId, navigate, pending]);

  async function start() {
    const restoreBlock = readRestoreReviewWorkBlock(environmentId);
    if (restoreBlock) {
      setError(restoreBlock);
      return;
    }
    if (
      !provider ||
      !model ||
      !project ||
      !query.data?.available ||
      destinationThreadId !== null ||
      inFlight.current ||
      failedStage === "start"
    )
      return;
    const chosenSelection: ModelSelection = {
      instanceId: provider.instanceId,
      model: model.slug,
      ...(options !== undefined ? { options: options.map((option) => ({ ...option })) } : {}),
    };
    const selectionForCheck = attempt.current?.modelSelection ?? chosenSelection;
    const readModelBlock = () => {
      const serverConfig = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
      const block = getAgentModelSendBlock({
        instanceId: selectionForCheck.instanceId,
        selection: selectionForCheck,
        currentModel: undefined,
        steering: false,
        cwd: project.workspaceRoot,
        serverConfig,
      });
      if (block) return block;
      const checkedModel = resolveProviderWorkspaceReadiness(
        serverConfig?.providers ?? [],
        project.workspaceRoot,
      )
        .providers.find((entry) => entry.instanceId === selectionForCheck.instanceId)
        ?.models.find((entry) => entry.slug === selectionForCheck.model);
      return projectAgentReasoningControl(checkedModel, selectionForCheck.options).unavailable
        ? {
            reason: "The saved reasoning level is unavailable.",
            action: null,
          }
        : null;
    };
    const initialModelBlock = readModelBlock();
    if (initialModelBlock) {
      setError(initialModelBlock.reason);
      return;
    }
    inFlight.current = true;
    setPending(true);
    setError(null);
    setAttempted(true);
    setFailedStage(null);
    attempt.current ??= {
      threadId: newThreadId(),
      modelSelection: chosenSelection,
      runtimeMode: "read-only",
      createdAt: new Date().toISOString(),
    };
    const { threadId, modelSelection, runtimeMode, createdAt } = attempt.current;
    setRetainedSelection(modelSelection);
    try {
      if (!createdThreadId) {
        const created = await create({
          environmentId,
          input: {
            threadId,
            commandId: CommandId.make(`project-agent-setup:${threadId}`),
            projectId,
            title: "Project setup",
            modelSelection,
            runtimeMode,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
          },
        });
        if (created._tag === "Failure") {
          setFailedStage("create");
          setError(formatEnvironmentQueryError(created.cause));
          return;
        }
        setCreatedThreadId(threadId);
      }
      const bound = await bind({
        environmentId,
        input: { projectId, sourceThreadId: threadId, instanceId: modelSelection.instanceId },
      });
      if (bound._tag === "Failure") {
        setFailedStage("bind");
        setError(formatEnvironmentQueryError(bound.cause));
        return;
      }
      const modelBlock = readModelBlock();
      if (modelBlock) {
        setFailedStage("model");
        setError(modelBlock.reason);
        return;
      }
      const started = await startTurn({
        environmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: PROJECT_AGENT_PROPOSAL_PROMPT,
            attachments: [],
          },
          modelSelection,
          runtimeMode,
          interactionMode: "default",
          createdAt,
        },
      });
      if (started._tag === "Failure") {
        setFailedStage("start");
        setError(formatEnvironmentQueryError(started.cause));
        return;
      }
      openThread(threadId);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <BookOpenIcon className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-semibold">{project?.title ?? "Project"} / Propose agents</h1>
      </WorkspacePageHeader>
      <main className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-xl space-y-6 py-4">
          <ProjectAgentsGuide environmentId={environmentId} projectId={projectId} />
          <div>
            <h2 className="text-xl font-semibold">Find the right agents for this repository</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Study the repository's architecture and ownership boundaries, then review a proposed
              roster before creating and preparing your project agents.
            </p>
          </div>
          {failedStage === "model" ? (
            <div className="space-y-2 text-sm">
              <p>
                Requested model: {retainedSelection?.model}. Reasoning: {reasoning.label}.
              </p>
              <p className="text-muted-foreground">
                Your setup conversation is ready. Open it to resolve model access or change its
                model and reasoning level before starting the study.
              </p>
            </div>
          ) : (
            <ProjectAgentModelFields
              environmentId={environmentId}
              providers={providers}
              provider={provider}
              model={model}
              options={options}
              checkingModels={
                provider ? workspace.pendingInstanceIds.has(provider.instanceId) : false
              }
              disabled={pending || attempted}
              onProviderChange={(instanceId) => {
                if (inFlight.current || attempted) return;
                setChosenInstance(instanceId);
                setChosenModel(null);
                setChosenOptions([]);
                setError(null);
              }}
              onModelChange={(model) => {
                if (inFlight.current || attempted) return;
                setChosenInstance(provider?.instanceId ?? chosenInstance);
                setChosenModel(model);
                setChosenOptions([]);
                setError(null);
              }}
              onOptionsChange={(options) => {
                if (inFlight.current || attempted) return;
                setChosenInstance(provider?.instanceId ?? chosenInstance);
                setChosenModel(model?.slug ?? chosenModel);
                setChosenOptions(options);
                setError(null);
              }}
            />
          )}
          <p className="text-sm text-muted-foreground">
            The study runs Read-only in its own conversation. It can inspect project files and
            propose agents; file changes and shell commands are blocked. You choose the agents and
            their permissions before creating them.
          </p>
          {error || query.error ? (
            <p role="alert" className="text-sm text-warning-foreground">
              {error ?? query.error}
            </p>
          ) : null}
          {restoreBlock ? (
            <p role="status" className="text-sm text-muted-foreground">
              {restoreBlock}
            </p>
          ) : null}
          {!query.isPending && !query.data?.available ? (
            <p role="status" className="text-sm text-muted-foreground">
              {query.data?.error ??
                "Repository proposals are unavailable on this environment's Meerkat runtime."}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() =>
                void navigate({
                  to: "/$environmentId/projects/$projectId/agents/new",
                  params: { environmentId, projectId },
                })
              }
            >
              Add an agent manually
            </Button>
            {createdThreadId && failedStage !== "bind" ? (
              <Button
                disabled={pending || requestedThreadId !== null}
                onClick={() => openThread(createdThreadId)}
              >
                {requestedThreadId ? "Opening setup conversation..." : "Open setup conversation"}
              </Button>
            ) : (
              <Button
                disabled={
                  pending ||
                  restoreBlock !== null ||
                  destinationThreadId !== null ||
                  query.isPending ||
                  !query.data?.available ||
                  !provider ||
                  !model ||
                  reasoning.unavailable ||
                  !project
                }
                onClick={() => void start()}
              >
                {destinationThreadId
                  ? "Opening setup conversation..."
                  : pending
                    ? "Starting repository study..."
                    : query.isPending
                      ? "Checking availability..."
                      : failedStage
                        ? "Retry setup"
                        : "Start repository study"}
              </Button>
            )}
          </div>
        </div>
      </main>
    </SidebarInset>
  );
}

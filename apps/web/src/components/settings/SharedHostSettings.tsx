import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  MeerkatProjectAgent,
  ProviderInstanceId,
  ProviderOptionSelections,
  SharedProject,
  SharedWorkspaceSnapshot,
} from "@t3tools/contracts";
import { openCommandPalette } from "../../commandPaletteBus";
import { canonicalSharedRepository } from "@t3tools/shared/sharedRepository";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useProviderWorkspaceReadiness } from "../../hooks/useProviderWorkspaceReadiness";
import { randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProjects } from "../../state/entities";
import type { EnvironmentPresentation } from "../../state/environments";
import { meerkatTeamEnvironment } from "../../state/meerkatTeam";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { environmentServerConfigsAtom } from "../../state/server";
import {
  sharedWorkspaceEnvironment as shared,
  useSharedDirectory,
} from "../../state/sharedWorkspace";
import { useAtomCommand } from "../../state/use-atom-command";
import { getAgentModelSendBlock } from "../team/agentModelReadiness";
import { ProjectAgentModelFields } from "../team/ProjectAgentModelFields";
import {
  customProjectAgentRole,
  projectAgentReasoningControl,
  resolveProjectAgentModel,
} from "../team/projectAgentSetup.logic";
import { readRestoreReviewWorkBlock, useRestoreReviewWorkBlock } from "../team/useRestoreReview";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SharedHostInvitations } from "./SharedHostInvitations";
import {
  readSharedHostSetup,
  registerHostProject,
  registerHostSpecialist,
  saveSharedHostSetup,
  type SharedHostSetup,
} from "./sharedHostSetup";

async function commandValue<A, E>(pending: Promise<AtomCommandResult<A, E>>): Promise<A> {
  const result = await pending;
  if (result._tag === "Failure") throw new Error(formatEnvironmentQueryError(result.cause));
  return result.value;
}
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Shared host setup failed. The saved request has been kept.";

function SetupStep({
  title,
  summary,
  open,
  complete,
  action,
  onOpenChange,
  focusRevision = 0,
  children,
}: {
  title: "Workspace" | "Repository" | "Specialist";
  summary: string;
  open: boolean;
  complete: boolean;
  action: string;
  onOpenChange: (open: boolean) => void;
  focusRevision?: number;
  children: ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusRevision === 0) return;
    const element = trigger.current;
    const active = element?.ownerDocument?.activeElement;
    // A request may finish after the user has started editing another visible step.
    if (
      active &&
      active !== element?.ownerDocument.body &&
      !element?.closest("[data-setup-step]")?.contains(active) &&
      !active.closest("[hidden]")
    )
      return;
    element?.focus();
  }, [focusRevision]);
  return (
    <div className="min-w-0 border-t border-border/50 first:border-t-0">
      <Collapsible
        open={open}
        onOpenChange={onOpenChange}
        className="min-w-0"
        data-setup-step={title}
      >
        <CollapsibleTrigger
          ref={trigger}
          aria-label={`${open ? "Collapse" : complete ? action : "Set up"} ${title.toLowerCase()}`}
          aria-expanded={open}
          className="flex w-full min-w-0 items-center gap-3 rounded-md py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{title}</span>
            {!open && (
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">{summary}</span>
            )}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {open ? "Hide" : complete ? action : "Set up"}
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel keepMounted hidden={!open}>
          <div className="space-y-4 pb-4">{children}</div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

function SpecialistSetup({
  host,
  project,
  sharedProject,
  snapshot,
  setup,
  persist,
  refresh,
  disabled,
  onComplete,
}: {
  host: EnvironmentPresentation;
  project: EnvironmentProject;
  sharedProject: SharedProject;
  snapshot: SharedWorkspaceSnapshot;
  setup: SharedHostSetup;
  persist: (next: SharedHostSetup) => boolean;
  refresh: () => void;
  disabled: boolean;
  onComplete: () => void;
}) {
  const agents = useEnvironmentQuery(
    meerkatTeamEnvironment.projectAgents({
      environmentId: host.environmentId,
      input: { projectId: project.id },
    }),
  );
  const create = useAtomCommand(meerkatTeamEnvironment.projectAgentCreate, {
    reportFailure: false,
  });
  const connect = useAtomCommand(meerkatTeamEnvironment.projectAgentLifecycle, {
    reportFailure: false,
  });
  const register = useAtomCommand(shared.registerSpecialist, { reportFailure: false });
  const { providers, pendingInstanceIds } = useProviderWorkspaceReadiness({
    environmentId: host.environmentId,
    cwd: project.workspaceRoot,
    providers: host.serverConfig?.providers ?? [],
  });
  const [mode, setMode] = useState<string>("new");
  const [label, setLabel] = useState("");
  const [charter, setCharter] = useState("");
  const [instanceId, setInstanceId] = useState<ProviderInstanceId | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [options, setOptions] = useState<ProviderOptionSelections>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restoreBlock = useRestoreReviewWorkBlock(host.environmentId);
  const attempt = setup.specialist;
  const resolved = resolveProjectAgentModel(
    providers,
    project.defaultModelSelection,
    instanceId,
    modelId,
  );
  const provider = instanceId
    ? providers.find(
        (entry) =>
          entry.instanceId === instanceId && entry.enabled && entry.availability !== "unavailable",
      )
    : resolved.provider;
  const model = modelId ? provider?.models.find((entry) => entry.slug === modelId) : resolved.model;
  const eligible = (agents.data?.agents ?? []).filter(
    (agent) => agent.accessMode === "repository-read-only" && !agent.archived,
  );
  const alreadyShared = snapshot.specialists.filter((entry) =>
    entry.assignments.some(
      (assignment) => assignment.sharedProjectId === sharedProject.sharedProjectId,
    ),
  );
  const available = eligible.filter(
    (agent) =>
      !snapshot.specialists.some(
        (entry) =>
          entry.nativeTarget.agentId === agent.agentId &&
          entry.nativeTarget.instanceId === agent.instanceId,
      ),
  );
  const selected = available.find((agent) => agent.agentId === mode);
  const pendingModels = provider ? pendingInstanceIds.has(provider.instanceId) : false;
  const locked = disabled || busy || Boolean(attempt) || Boolean(restoreBlock);
  const sharedResult = attempt?.result;

  async function submit() {
    if (disabled || busy || readRestoreReviewWorkBlock(host.environmentId)) return;
    setBusy(true);
    setError(null);
    try {
      let next = setup;
      if (!attempt) {
        if (!charter.trim())
          throw new Error("Describe this specialist's continuing responsibility.");
        if (mode === "new") {
          if (!label.trim() || !provider || !model || pendingModels)
            throw new Error("Choose a name and an available model before creating the specialist.");
          if (projectAgentReasoningControl(model, options).unavailable)
            throw new Error("Choose a supported reasoning level or Model default.");
          const block = getAgentModelSendBlock({
            instanceId: provider.instanceId,
            selection: { instanceId: provider.instanceId, model: model.slug, options },
            currentModel: undefined,
            steering: false,
            cwd: project.workspaceRoot,
            serverConfig: appAtomRegistry.get(environmentServerConfigsAtom).get(host.environmentId),
          });
          if (block) throw new Error(block.reason);
          next = {
            ...setup,
            specialist: {
              requestId: randomUUID(),
              sharedProjectId: sharedProject.sharedProjectId,
              label: label.trim(),
              charter: charter.trim(),
              target: null,
              result: null,
              create: {
                projectId: project.id,
                instanceId: provider.instanceId,
                requestId: randomUUID(),
                label: label.trim(),
                role: customProjectAgentRole(label),
                instructions: charter.trim(),
                model: model.slug,
                options,
                accessMode: "repository-read-only",
              },
            },
          };
        } else {
          if (!selected) throw new Error("Choose an existing repository-only specialist.");
          next = {
            ...setup,
            specialist: {
              requestId: randomUUID(),
              sharedProjectId: sharedProject.sharedProjectId,
              label: selected.label,
              charter: charter.trim(),
              create: null,
              target: {
                projectId: project.id,
                instanceId: selected.instanceId,
                agentId: selected.agentId,
              },
              result: null,
            },
          };
        }
      }
      await registerHostSpecialist(next, {
        persist,
        create: (input) => commandValue(create({ environmentId: host.environmentId, input })),
        connect: (target) =>
          commandValue(
            connect({
              environmentId: host.environmentId,
              input: { projectId: target.projectId, agentId: target.agentId, action: "connect" },
            }),
          ),
        register: (input) => commandValue(register({ environmentId: host.environmentId, input })),
      });
      agents.refresh();
      refresh();
      onComplete();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  function chooseExisting(agent: MeerkatProjectAgent | undefined) {
    setMode(agent?.agentId ?? "new");
    setCharter(agent?.charter ?? agent?.instructions ?? "");
  }
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">Project specialists</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Give a repository domain a continuing owner. People on different branches can work with
          the same specialist while keeping their tasks and files local.
        </p>
        <div className="mt-3 space-y-2">
          <Button
            size="sm"
            disabled={
              disabled || busy || Boolean(attempt && !attempt.result) || Boolean(restoreBlock)
            }
            render={
              <Link
                to="/$environmentId/projects/$projectId/agents/propose"
                params={{ environmentId: host.environmentId, projectId: project.id }}
              />
            }
          >
            Generate specialists
          </Button>
          <p className="text-xs text-muted-foreground">
            Study this repository, review its proposed domain owners, then share the specialists
            after their preparation. Shared specialists keep repository-only access.
          </p>
        </div>
      </div>
      {alreadyShared.length > 0 && (
        <ul className="space-y-2 text-sm">
          {alreadyShared.map((specialist) => (
            <li key={specialist.specialistId} className="flex items-center justify-between gap-3">
              <span className="min-w-0 flex-1 break-words">
                {specialist.label}
                {specialist.supersededAt ? " (previous)" : ""}
              </span>
              <Link
                to="/$environmentId/agents/$agentId"
                params={{
                  environmentId: host.environmentId,
                  agentId: specialist.nativeTarget.agentId,
                }}
                search={{ project: project.id }}
                className="shrink-0 text-xs text-primary hover:underline"
              >
                Open conversation
              </Link>
            </li>
          ))}
        </ul>
      )}
      {attempt ? (
        <div className="space-y-3 rounded-lg bg-muted/40 p-3 text-sm">
          <p className="break-words font-medium">{attempt.label}</p>
          <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {attempt.charter}
          </p>
          {attempt.target && (
            <p className="break-all text-xs text-muted-foreground">
              Existing agent binding: <code>{attempt.target.agentId}</code>
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {sharedResult
              ? "Registered in this shared workspace. Invite other people to use this specialist from their own checkout."
              : "This setup is saved. Retry continues with the same agent and registration request."}
          </p>
          {sharedResult ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || busy}
              onClick={() => {
                if (!persist({ ...setup, specialist: null }))
                  setError(
                    "The completed setup could not be saved. Try again when local storage is available.",
                  );
                else {
                  setLabel("");
                  setCharter("");
                  setMode("new");
                }
              }}
            >
              Add another specialist
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={disabled || busy || Boolean(restoreBlock)}
              onClick={() => void submit()}
            >
              {busy ? "Finishing setup..." : "Resume specialist setup"}
            </Button>
          )}
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {available.length > 0 && (
            <label className="block space-y-2 text-sm">
              <span>Specialist</span>
              <Select
                value={mode}
                disabled={locked}
                onValueChange={(value) =>
                  chooseExisting(available.find((agent) => agent.agentId === value))
                }
              >
                <SelectTrigger aria-label="Shared specialist">
                  <SelectValue>{selected?.label ?? "Create a specialist"}</SelectValue>
                </SelectTrigger>
                <SelectPopup className="max-w-[min(32rem,calc(100vw-2rem))] break-words">
                  <SelectItem value="new">Create a specialist</SelectItem>
                  {available.map((agent) => (
                    <SelectItem key={agent.agentId} value={agent.agentId}>
                      {agent.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
          )}
          {mode === "new" && (
            <>
              <label className="block space-y-2 text-sm">
                <span>Specialist name</span>
                <Input
                  aria-label="Shared specialist name"
                  placeholder="e.g. Search and indexing"
                  value={label}
                  maxLength={120}
                  disabled={locked}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              <ProjectAgentModelFields
                providers={providers.filter((entry) => entry.driver === "meerkat" && entry.enabled)}
                environmentId={host.environmentId}
                provider={provider}
                model={model}
                options={options}
                disabled={locked}
                checkingModels={pendingModels}
                onProviderChange={(value) => {
                  setInstanceId(value);
                  setModelId(null);
                  setOptions([]);
                }}
                onModelChange={(value) => {
                  setInstanceId(provider?.instanceId ?? null);
                  setModelId(value);
                  setOptions([]);
                }}
                onOptionsChange={setOptions}
              />
              {!provider && (
                <p className="text-xs text-muted-foreground">
                  <Link
                    to="/settings/providers"
                    search={{ environmentId: host.environmentId }}
                    className="text-primary hover:underline"
                  >
                    Connect a model account in Providers
                  </Link>{" "}
                  to create a specialist.
                </p>
              )}
            </>
          )}
          <label className="block space-y-2 text-sm">
            <span>Ongoing responsibility</span>
            <Textarea
              aria-label="Shared specialist responsibility"
              rows={3}
              maxLength={32000}
              placeholder="Own search relevance, index design, and migration compatibility. Explain tradeoffs using repository evidence and keep track of decisions across tasks."
              value={charter}
              disabled={locked}
              onChange={(event) => setCharter(event.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Repository-only access. Specialists can inspect repository evidence, use shared work,
            and exchange peer messages. They cannot edit files or run commands.
          </p>
          {eligible.length === 0 && (agents.data?.agents.length ?? 0) > 0 && (
            <p className="text-xs text-muted-foreground">
              Existing agents use different permissions. Create a repository-only specialist to
              share safely.
            </p>
          )}
          <Button
            size="sm"
            type="submit"
            disabled={
              locked ||
              !charter.trim() ||
              (mode === "new" && (!label.trim() || !model || pendingModels))
            }
          >
            {busy
              ? "Setting up specialist..."
              : mode === "new"
                ? "Create and share specialist"
                : "Share existing specialist"}
          </Button>
        </form>
      )}
      {restoreBlock && (
        <p role="status" className="text-xs text-muted-foreground">
          {restoreBlock}
        </p>
      )}
      {agents.error && (
        <p role="status" className="text-xs text-muted-foreground">
          Could not load existing specialists: {agents.error}
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function HostProjectSetup({
  host,
  project,
  snapshot,
  disabled,
  refresh,
  projectPicker,
  workspaceOpen,
  onOpenProjectStep,
}: {
  host: EnvironmentPresentation;
  project: EnvironmentProject;
  snapshot: SharedWorkspaceSnapshot;
  disabled: boolean;
  refresh: () => void;
  projectPicker: ReactNode;
  workspaceOpen: boolean;
  onOpenProjectStep: () => void;
}) {
  const register = useAtomCommand(shared.registerProject, { reportFailure: false });
  const [saved, setSaved] = useState(() => {
    try {
      return {
        setup: readSharedHostSetup({
          environmentId: host.environmentId,
          projectId: project.id,
          workspaceId: snapshot.workspace!.workspaceId,
        }),
        error: null,
      };
    } catch (cause) {
      return { setup: null, error: errorMessage(cause) };
    }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setup = saved.setup;
  const existing =
    snapshot.projects.find((entry) => entry.hostProjectId === project.id) ?? setup?.project;
  const registeredSpecialists = snapshot.specialists.filter((entry) =>
    entry.assignments.some(
      (assignment) => assignment.sharedProjectId === existing?.sharedProjectId,
    ),
  );
  const [step, setStep] = useState<"repository" | "specialist" | null>(() => {
    if (!existing || !setup) return "repository";
    if (setup.specialist && !setup.specialist.result) return "specialist";
    return setup.specialist?.result || registeredSpecialists.length ? null : "specialist";
  });
  const [specialistFocusRevision, setSpecialistFocusRevision] = useState(0);
  const changeStep = (next: "repository" | "specialist" | null) => {
    setStep(next);
    if (next) onOpenProjectStep();
  };
  let repository: string | null = null;
  try {
    repository = project.repositoryIdentity?.locator.remoteUrl
      ? canonicalSharedRepository(project.repositoryIdentity.locator.remoteUrl)
      : null;
  } catch {
    /* Registration requires an unambiguous remote. */
  }
  const persist = (next: SharedHostSetup) => {
    if (!saveSharedHostSetup(next)) return false;
    setSaved({ setup: next, error: null });
    return true;
  };
  async function submit() {
    if (disabled || busy || !setup || (!repository && !setup.projectRequest)) return;
    setBusy(true);
    setError(null);
    try {
      await registerHostProject(
        {
          ...setup,
          projectRequest: setup.projectRequest ?? {
            requestId: randomUUID(),
            name: project.title,
            repository: repository!,
            hostProjectId: project.id,
          },
        },
        {
          persist,
          register: (input) => commandValue(register({ environmentId: host.environmentId, input })),
        },
      );
      refresh();
      changeStep("specialist");
      setSpecialistFocusRevision((value) => value + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <SetupStep
        title="Repository"
        complete={Boolean(existing)}
        open={!workspaceOpen && step === "repository"}
        onOpenChange={(open) => changeStep(open ? "repository" : null)}
        action="Change"
        summary={
          existing
            ? `${project.title} - ${existing.repository}`
            : `${project.title} - not registered`
        }
      >
        {projectPicker}
        <div className="text-xs text-muted-foreground">
          <p className="break-words">
            {existing?.repository ??
              setup?.projectRequest?.repository ??
              repository ??
              "This project needs an unambiguous Git remote before it can be shared."}
          </p>
          {!existing && repository && (
            <p className="mt-1">
              The host checks this repository's current remote when you register it.
            </p>
          )}
          {existing && <p className="mt-1">Registered in this workspace.</p>}
        </div>
        {existing ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              changeStep("specialist");
              setSpecialistFocusRevision((value) => value + 1);
            }}
          >
            Continue to specialists
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || busy || !setup || (!repository && !setup.projectRequest)}
            onClick={() => void submit()}
          >
            {busy
              ? "Registering project..."
              : setup?.projectRequest
                ? "Retry project registration"
                : "Register project"}
          </Button>
        )}
        {(error ?? saved.error) && (
          <p role="alert" className="break-words text-sm text-destructive">
            {error ?? saved.error}
          </p>
        )}
      </SetupStep>
      {existing && setup ? (
        <SetupStep
          title="Specialist"
          complete={
            setup.specialist ? Boolean(setup.specialist.result) : registeredSpecialists.length > 0
          }
          open={!workspaceOpen && step === "specialist"}
          onOpenChange={(open) => changeStep(open ? "specialist" : null)}
          action="Manage"
          focusRevision={specialistFocusRevision}
          summary={
            setup.specialist && !setup.specialist.result
              ? `${setup.specialist.label} - setup needs confirmation`
              : setup.specialist?.result
                ? `${setup.specialist.result.label} - registered`
                : registeredSpecialists.length
                  ? `${registeredSpecialists.length} registered: ${registeredSpecialists.map((entry) => entry.label).join(", ")}`
                  : "Create or share a repository specialist"
          }
        >
          <SpecialistSetup
            host={host}
            project={project}
            sharedProject={existing}
            snapshot={snapshot}
            setup={setup}
            persist={persist}
            refresh={refresh}
            disabled={disabled || busy}
            onComplete={() => {
              setStep(null);
              setSpecialistFocusRevision((value) => value + 1);
            }}
          />
        </SetupStep>
      ) : null}
    </>
  );
}

/** Only mounted for a full administrative connection; the live shared session also gates writes. */
function SharedHostCapacity({
  capacity,
}: {
  capacity: NonNullable<SharedWorkspaceSnapshot["capacity"]>;
}) {
  const usage = (value: number, maximum: number) =>
    `${value.toLocaleString()} / ${maximum.toLocaleString()}`;
  const mib = (bytes: number) =>
    (bytes / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 });
  return (
    <details className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
      <summary className="cursor-pointer py-1 text-foreground">Host capacity</summary>
      <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 tabular-nums">
        <dt>Shared history budget</dt>
        <dd>
          {mib(capacity.evidence.bytes)} / {mib(capacity.evidence.maxBytes)} MiB
        </dd>
        <dt>Retained records</dt>
        <dd>{usage(capacity.evidence.records, capacity.evidence.maxRecords)}</dd>
        <dt>Unread inbox deliveries</dt>
        <dd>{usage(capacity.inbox.pending, capacity.inbox.maxPending)}</dd>
        <dt>Specialists, including reservations</dt>
        <dd>
          {usage(capacity.specialists.registeredAndReserved, capacity.specialists.maxSpecialists)}
        </dd>
        <dt>Requests awaiting resolution</dt>
        <dd>{capacity.pendingRequests.toLocaleString()}</dd>
        <dt>Pending specialist changes</dt>
        <dd>{capacity.pendingCompositionOperations.toLocaleString()}</dd>
      </dl>
      <p className="mt-3">
        The history budget includes saved evidence and reserved inbox copies. Native conversations
        and other files also use disk space. A full budget stops new records; existing results and
        acknowledgements remain available.
      </p>
      <a
        className="mt-2 inline-block underline underline-offset-2"
        href="https://github.com/lukacf/meerkat-t3/blob/main/docs/operations/shared-host.md#capacity-and-retained-evidence"
        target="_blank"
        rel="noreferrer"
      >
        Manage host storage
      </a>
    </details>
  );
}

export function SharedHostSettings({
  host,
  title = "Host shared specialists",
}: {
  host: EnvironmentPresentation;
  title?: string;
}) {
  const directory = useSharedDirectory(host);
  const configure = useAtomCommand(shared.configure, { reportFailure: false });
  const projects = useProjects().filter((project) => project.environmentId === host.environmentId);
  const [name, setName] = useState<string | null>(null);
  const projectSelectionKey = `meerkat-t3:shared-host-project:v1:${host.environmentId}`;
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => {
    try {
      return globalThis.localStorage?.getItem(projectSelectionKey) ?? null;
    } catch {
      return null;
    }
  });
  const [editingWorkspace, setEditingWorkspace] = useState<boolean | null>(null);
  const [emptyRepositoryOpen, setEmptyRepositoryOpen] = useState(true);
  const [workspaceFocusRevision, setWorkspaceFocusRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshot = directory.snapshot;
  const disabled =
    busy || !directory.connected || !directory.permissions?.admin || Boolean(directory.error);
  const project = projects.find((entry) => entry.id === selectedProjectId) ?? projects[0];
  const selectProject = (projectId: string | null) => {
    setSelectedProjectId(projectId);
    try {
      if (projectId) globalThis.localStorage?.setItem(projectSelectionKey, projectId);
    } catch {
      /* Selection is optional; mutation retry identities are persisted separately. */
    }
  };
  const workspaceName = name ?? snapshot?.workspace?.name ?? "";
  const workspaceOpen = editingWorkspace ?? !snapshot?.workspace;
  async function configureWorkspace() {
    if (disabled || !workspaceName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await commandValue(
        configure({ environmentId: host.environmentId, input: { name: workspaceName.trim() } }),
      );
      directory.refresh();
      setEditingWorkspace(false);
      setWorkspaceFocusRevision((value) => value + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  if (directory.permissions && !directory.permissions.admin) return null;
  return (
    <FoldedSettingsSection
      id={`shared-host-${host.environmentId}`}
      title={title}
      summary={snapshot?.workspace?.name ?? "Set up a workspace for your team"}
    >
      <div className="space-y-5 p-4">
        <p className="text-xs text-muted-foreground">
          This workspace hosts persistent project specialists. Participants can collaborate with
          them without access to this machine's files, terminal, or account settings.
        </p>
        {(!directory.connected || directory.error) && (
          <p role="status" className="text-sm text-muted-foreground">
            {directory.error ?? "Reconnect this host to configure shared specialists."}
          </p>
        )}
        {!snapshot && directory.isPending && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading shared workspace...
          </p>
        )}
        <div>
          <SetupStep
            title="Workspace"
            complete={Boolean(snapshot?.workspace)}
            open={workspaceOpen}
            onOpenChange={setEditingWorkspace}
            action="Edit"
            focusRevision={workspaceFocusRevision}
            summary={snapshot?.workspace?.name ?? "Name your shared workspace"}
          >
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void configureWorkspace();
              }}
            >
              <label className="min-w-48 flex-1 space-y-2 text-sm">
                <span>Workspace name</span>
                <Input
                  aria-label="Shared workspace name"
                  maxLength={200}
                  placeholder="e.g. Product engineering"
                  value={workspaceName}
                  disabled={disabled}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <Button type="submit" size="sm" disabled={disabled || !workspaceName.trim()}>
                {busy ? "Saving..." : snapshot?.workspace ? "Save name" : "Create workspace"}
              </Button>
            </form>
            {error && (
              <p role="alert" className="break-words text-sm text-destructive">
                {error}
              </p>
            )}
          </SetupStep>
          {snapshot?.workspace && (
            <>
              {projects.length ? (
                <>
                  {project && (
                    <HostProjectSetup
                      key={`${host.environmentId}:${snapshot.workspace.workspaceId}:${project.id}`}
                      host={host}
                      project={project}
                      snapshot={snapshot}
                      disabled={disabled}
                      refresh={directory.refresh}
                      workspaceOpen={workspaceOpen}
                      onOpenProjectStep={() => setEditingWorkspace(false)}
                      projectPicker={
                        <label className="block space-y-2 text-sm">
                          <span>Host project</span>
                          <Select
                            value={project.id}
                            disabled={disabled}
                            onValueChange={selectProject}
                          >
                            <SelectTrigger aria-label="Shared host project">
                              <SelectValue>{project.title}</SelectValue>
                            </SelectTrigger>
                            <SelectPopup className="max-w-[min(32rem,calc(100vw-2rem))] break-words">
                              {projects.map((entry) => (
                                <SelectItem key={entry.id} value={entry.id}>
                                  {entry.title}
                                </SelectItem>
                              ))}
                            </SelectPopup>
                          </Select>
                        </label>
                      }
                    />
                  )}
                </>
              ) : (
                <SetupStep
                  title="Repository"
                  complete={false}
                  open={!workspaceOpen && emptyRepositoryOpen}
                  onOpenChange={(open) => {
                    setEmptyRepositoryOpen(open);
                    if (open) setEditingWorkspace(false);
                  }}
                  action="Set up"
                  summary="Add a repository on this host"
                >
                  <p className="text-sm text-muted-foreground">
                    Choose a checkout for this host. Then return here to register the repository and
                    create its specialists.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={() =>
                      openCommandPalette({ open: "add-project", environmentId: host.environmentId })
                    }
                  >
                    Add host repository
                  </Button>
                </SetupStep>
              )}
            </>
          )}
        </div>
        {snapshot?.capacity && <SharedHostCapacity capacity={snapshot.capacity} />}
        <SharedHostInvitations
          environmentId={host.environmentId}
          hostLabel={host.label}
          connected={directory.connected}
        />
      </div>
    </FoldedSettingsSection>
  );
}

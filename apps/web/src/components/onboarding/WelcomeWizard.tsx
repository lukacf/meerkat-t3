import { useAuth } from "@clerk/react";
import { Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import type {
  AgentSessionProjectCandidate,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScopedProjectRef,
  ServerConfig,
  ServerProvider,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CommandId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronRightIcon,
  CloudIcon,
  LinkIcon,
  MonitorIcon,
  TerminalIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { saveOnboardingProgress, useCompleteOnboarding } from "../../onboarding/firstRun";
import { useClientSettings } from "../../hooks/useSettings";
import { OnboardingCredentials } from "./OnboardingCredentials";
import { OnboardingProjectStep } from "./OnboardingProjectStep";
import {
  groupOnboardingProjects,
  partitionOnboardingProjects,
  onboardingProjectKey,
  resolveOnboardingLandingProject,
  resolveOnboardingProjectId,
  type OnboardingProjectGroup,
} from "../../onboarding/projectImport.logic";
import {
  getOnboardingProviderState,
  getMeerkatOnboardingPresentation,
  selectOnboardingProviderSetup,
  resolveOnboardingProviderInstallCommand,
  resolveOnboardingProviderLoginCommand,
  selectOnboardingProvidersByDriver,
} from "../../onboarding/providerReadiness.logic";
import { newProjectId, randomUUID } from "../../lib/utils";
import { agentSessionImport } from "../../state/agentSessions";
import { readProjects, useProjects } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { isOnboardingRelayEnvironment } from "../../onboarding/targetEnvironment.logic";
import { useProjectScans } from "../../onboarding/useProjectScans";
import { projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { connectPairing } from "../../connection/onboarding";
import { getProviderSummary } from "../settings/providerStatus";
import { getDriverOption } from "../settings/providerDriverMeta";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { CloudEnvironmentConnectRows } from "../cloud/CloudEnvironmentConnectList";
import { ClaudeAI, OpenAI } from "../Icons";
import { APP_DISPLAY_NAME } from "../../branding";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { WizardPanel, WizardSteps, WizardPopup, WizardHeader } from "../ui/wizard";
import { Dialog } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { cn } from "../../lib/utils";
import { formatRelativeTime } from "../../timestampFormat";

/**
 * First-run welcome wizard. Rendered over the workspace at `/welcome` on a
 * fresh install (no completed-onboarding flag, empty workspace). Flow:
 * connection, model access, project choice and a first task. Only a successful
 * reply or an explicit skip completes the persisted setup journey.
 */

type WizardStep = "connection" | "agents" | "projects" | "import";
const NO_ENVIRONMENTS: readonly EnvironmentId[] = [];
const NO_PROVIDERS: readonly ServerProvider[] = [];

const AGENT_ONBOARDING_THREAD_ID = ThreadId.make("onboarding-agent-setup");
const ONBOARDING_STAGES = ["Connect", "Model access", "Project", "First task"] as const;
const SCAN_LIMIT_MESSAGE = "Scan limit reached. Some projects or conversations may be missing.";
export function WelcomeWizard({
  localAvailable,
  onDone,
}: {
  readonly localAvailable: boolean;
  readonly onDone: (projectRef?: ScopedProjectRef) => Promise<void>;
}) {
  const completeOnboarding = useCompleteOnboarding();
  const progress = useClientSettings((settings) => settings.onboardingProgress);
  const [step, setStep] = useState<WizardStep>(() =>
    progress?.step === "first-task" ? "projects" : (progress?.step ?? "connection"),
  );
  const { environments } = useEnvironments();
  const [selection, setSelection] = useState<ReadonlySet<EnvironmentId> | null>(() =>
    progress ? new Set(progress.environmentIds) : null,
  );
  const autoSelectedComputers = useRef(new Set<EnvironmentId>(progress?.environmentIds ?? []));
  const [setupIds, setSetupIds] = useState<readonly EnvironmentId[]>(
    progress?.environmentIds ?? [],
  );
  const [projectPending, setProjectPending] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const finishingPromiseRef = useRef<Promise<boolean> | null>(null);
  const primaryEnvironment = usePrimaryEnvironment();
  useEffect(() => {
    const newComputers = environments.filter(
      (environment) => !autoSelectedComputers.current.has(environment.environmentId),
    );
    if (newComputers.length === 0) return;
    for (const environment of newComputers) {
      autoSelectedComputers.current.add(environment.environmentId);
    }
    setSelection(
      (current) =>
        new Set([
          ...(current ?? []),
          ...newComputers.map((environment) => environment.environmentId),
        ]),
    );
  }, [environments]);
  const selectedIds =
    selection ?? new Set(primaryEnvironment ? [primaryEnvironment.environmentId] : []);
  const scans = useProjectScans(step === "import" ? setupIds : NO_ENVIRONMENTS);
  const isLoadingProjects =
    step === "import" &&
    scans.every((scan) => scan.data === null) &&
    scans.some((scan) => scan.isPending);
  const persistStep = useCallback(
    async (next: WizardStep, ids: readonly EnvironmentId[] = setupIds) => {
      try {
        const projectRef =
          progress?.projectRef && ids.includes(progress.projectRef.environmentId)
            ? progress.projectRef
            : null;
        await saveOnboardingProgress({
          step: next === "import" ? "projects" : next,
          environmentIds: ids,
          startedAt: progress?.startedAt ?? new Date().toISOString(),
          projectRef,
          threadId: projectRef ? (progress?.threadId ?? null) : null,
        });
        setStep(next);
        return true;
      } catch {
        toastManager.add({
          type: "error",
          title: "Could not save setup progress",
          description: "Try again before continuing.",
        });
        return false;
      }
    },
    [progress, setupIds],
  );
  const startSetup = async (ids: readonly EnvironmentId[]) => {
    if (ids.length === 0) return;
    if (await persistStep("agents", ids)) setSetupIds(ids);
  };
  const stageIndex = step === "agents" ? 1 : step === "import" || step === "projects" ? 2 : 0;
  const reviewProject = useCallback(
    async (projectRef: ScopedProjectRef) => {
      try {
        const sameProject =
          progress?.projectRef?.environmentId === projectRef.environmentId &&
          progress.projectRef.projectId === projectRef.projectId;
        await saveOnboardingProgress({
          step: "projects",
          environmentIds: setupIds,
          startedAt: sameProject ? progress.startedAt : new Date().toISOString(),
          projectRef,
          threadId: sameProject ? progress.threadId : null,
        });
        return true;
      } catch {
        toastManager.add({
          type: "error",
          title: "Could not save project selection",
          description: "Try again before continuing.",
        });
        return false;
      }
    },
    [progress, setupIds],
  );
  const finish = useCallback(
    (projectRef?: ScopedProjectRef) => {
      if (finishingPromiseRef.current !== null) return finishingPromiseRef.current;
      setIsFinishing(true);
      const completion = (async () => {
        if (projectRef) {
          const sameProject =
            progress?.projectRef?.environmentId === projectRef.environmentId &&
            progress.projectRef.projectId === projectRef.projectId;
          await saveOnboardingProgress({
            step: "first-task",
            environmentIds: setupIds,
            startedAt: sameProject ? progress.startedAt : new Date().toISOString(),
            projectRef,
            threadId: sameProject ? progress.threadId : null,
          });
        } else {
          await completeOnboarding();
        }
        await onDone(projectRef);
        return true;
      })()
        .catch(() => {
          toastManager.add({
            type: "error",
            title: "Could not continue setup",
            description: "Your progress is saved when possible. Try again.",
          });
          return false;
        })
        .finally(() => {
          finishingPromiseRef.current = null;
          setIsFinishing(false);
        });
      finishingPromiseRef.current = completion;
      return completion;
    },
    [completeOnboarding, onDone, progress, setupIds],
  );

  return (
    <Dialog open disablePointerDismissal onOpenChange={(_, event) => event.cancel()}>
      <WizardPopup
        bottomStickOnMobile={false}
        showCloseButton={false}
        initialFocus={() => document.getElementById("onboarding-pairing-url") ?? true}
      >
        <WizardHeader
          title={`Set up ${APP_DISPLAY_NAME}`}
          identity={
            <span className="text-2xl font-medium tracking-tight text-muted-foreground">
              {APP_DISPLAY_NAME}
            </span>
          }
        >
          <WizardSteps
            steps={ONBOARDING_STAGES}
            currentStep={stageIndex}
            isStepDisabled={(index) =>
              isImporting || isFinishing || projectPending || index >= stageIndex
            }
            onStepChange={(index) => {
              if (isImporting || isFinishing || projectPending || index > stageIndex) return;
              void persistStep(index === 0 ? "connection" : index === 1 ? "agents" : "projects");
            }}
          />
        </WizardHeader>

        <WizardPanel holdHeight={isLoadingProjects}>
          {step === "connection" ? (
            <ConnectionStep
              expandPairingInitially={!localAvailable && !hasCloudPublicConfig()}
              selectedIds={selectedIds}
              autoSelectedComputers={autoSelectedComputers.current}
              onSelectionChange={setSelection}
              onToggleEnvironment={(environmentId, checked) =>
                setSelection((current) => {
                  const next = new Set(current ?? selectedIds);
                  if (checked) next.add(environmentId);
                  else next.delete(environmentId);
                  return next;
                })
              }
              onContinue={() =>
                startSetup(
                  environments
                    .filter((environment) => selectedIds.has(environment.environmentId))
                    .map((environment) => environment.environmentId),
                )
              }
              onPaired={(environmentId) => {
                setSelection(new Set([...selectedIds, environmentId]));
              }}
            />
          ) : step === "agents" ? (
            <AgentsStep
              environmentIds={setupIds}
              setupPending={isFinishing}
              onContinue={() => void persistStep("projects")}
            />
          ) : step === "projects" ? (
            <OnboardingProjectStep
              environmentIds={setupIds}
              onProject={finish}
              onReviewProject={reviewProject}
              initialProjectRef={progress?.projectRef ?? null}
              onPendingChange={setProjectPending}
              onImport={() => setStep("import")}
            />
          ) : (
            <ImportStep
              scans={scans}
              isImporting={isImporting}
              setIsImporting={setIsImporting}
              onDone={(projectRef) => (projectRef ? finish(projectRef) : persistStep("projects"))}
            />
          )}
          <div className="mt-5 border-t border-border pt-3">
            <Button
              variant="ghost"
              size="sm"
              disabled={isImporting || isFinishing || projectPending}
              onClick={() => void finish()}
            >
              Skip setup for now
            </Button>
            <p className="mt-1 text-xs text-muted-foreground">
              Search for "Set up Meerkat" to return here.
            </p>
          </div>
        </WizardPanel>
      </WizardPopup>
    </Dialog>
  );
}

// ── Step 1: connection choice ────────────────────────────────

function ConnectionStep({
  autoSelectedComputers,
  expandPairingInitially,
  selectedIds,
  onSelectionChange,
  onToggleEnvironment,
  onContinue,
  onPaired,
}: {
  readonly autoSelectedComputers: Set<EnvironmentId>;
  readonly expandPairingInitially: boolean;
  readonly selectedIds: ReadonlySet<EnvironmentId>;
  readonly onSelectionChange: (ids: ReadonlySet<EnvironmentId>) => void;
  readonly onToggleEnvironment: (environmentId: EnvironmentId, checked: boolean) => void;
  readonly onContinue: () => void;
  readonly onPaired: (environmentId: EnvironmentId) => void;
}) {
  const { environments } = useEnvironments();
  const cloudEnabled = hasCloudPublicConfig();
  const directEnvironments = environments.filter(
    (environment) => !cloudEnabled || !isOnboardingRelayEnvironment(environment),
  );
  const [pairingOpen, setPairingOpen] = useState(expandPairingInitially);
  const [isPairing, setIsPairing] = useState(false);
  const ready =
    selectedIds.size > 0 &&
    [...selectedIds].every((id) =>
      environments.some(
        (environment) =>
          environment.environmentId === id && environment.connection.phase === "connected",
      ),
    );
  const continueRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (
      ready &&
      (document.activeElement === document.body ||
        document.activeElement?.getAttribute("role") === "dialog")
    ) {
      continueRef.current?.focus();
    }
  }, [ready]);
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        Connect your computers
      </h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        Choose one or more computers. We’ll set up agents and projects on each.
      </p>
      {directEnvironments.length > 0 ? (
        <fieldset className="mt-5 space-y-2">
          <legend className="sr-only">Computers to set up</legend>
          {directEnvironments.map((environment) => (
            <label
              key={environment.environmentId}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-background px-3 py-3"
            >
              <Checkbox
                checked={selectedIds.has(environment.environmentId)}
                onCheckedChange={(checked) => {
                  const next = new Set(selectedIds);
                  if (checked) next.add(environment.environmentId);
                  else next.delete(environment.environmentId);
                  onSelectionChange(next);
                }}
              />
              <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-sm font-medium break-words">
                    {environment.label}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {environment.connection.phase === "connected" ? "Connected" : "Connecting…"}
                  </span>
                </span>
                {environment.displayUrl ? (
                  <span className="mt-0.5 block text-xs break-all text-muted-foreground">
                    {environment.displayUrl}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="mt-4 space-y-2">
        {cloudEnabled ? (
          <ConnectAccountOption
            autoSelectedComputers={autoSelectedComputers}
            disabled={isPairing}
            selectedIds={selectedIds}
            onToggleEnvironment={onToggleEnvironment}
          />
        ) : null}
        <div className="rounded-lg border border-border bg-background">
          <Collapsible open={pairingOpen} onOpenChange={setPairingOpen}>
            <CollapsibleTrigger
              disabled={isPairing}
              render={
                <Button
                  variant="ghost"
                  size="sm-multiline"
                  className="min-h-14 w-full justify-start"
                />
              }
            >
              <LinkIcon className="size-4 text-muted-foreground" />
              <span className="flex-1 text-left">Add a computer</span>
              <ChevronRightIcon
                className={cn("size-4 text-muted-foreground", pairingOpen && "rotate-90")}
              />
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="px-3 pb-3">
                <PairingForm
                  isPairing={isPairing}
                  setIsPairing={setIsPairing}
                  onPaired={(environmentId) => {
                    setPairingOpen(false);
                    onPaired(environmentId);
                    requestAnimationFrame(() => continueRef.current?.focus());
                  }}
                />
              </div>
            </CollapsiblePanel>
          </Collapsible>
        </div>
      </div>
      <div className="mt-6 flex items-center justify-end gap-3">
        <Button
          ref={continueRef}
          autoFocus={!expandPairingInitially}
          disabled={!ready || isPairing}
          onClick={onContinue}
        >
          Continue
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </>
  );
}

function ConnectAccountOption({
  autoSelectedComputers,
  disabled,
  selectedIds,
  onToggleEnvironment,
}: {
  readonly autoSelectedComputers: Set<EnvironmentId>;
  readonly disabled: boolean;
  readonly selectedIds: ReadonlySet<EnvironmentId>;
  readonly onToggleEnvironment: (environmentId: EnvironmentId, checked: boolean) => void;
}) {
  const { environments } = useEnvironments();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const [expanded, setExpanded] = useState(true);
  const [discoveryReady, setDiscoveryReady] = useState(false);
  const onDiscoveryReady = useCallback(() => setDiscoveryReady(true), []);

  return (
    <div className="rounded-lg border border-border bg-background">
      <Collapsible open={expanded && !!isSignedIn && discoveryReady} onOpenChange={setExpanded}>
        <CollapsibleTrigger
          disabled={disabled || !isLoaded}
          onClick={(event) => {
            if (!isSignedIn) {
              event.preventDefault();
              setExpanded(true);
              openAuthPrompt();
            }
          }}
          render={
            <Button variant="ghost" size="sm-multiline" className="min-h-14 w-full justify-start" />
          }
        >
          <CloudIcon className="size-4 text-muted-foreground" />
          <span className="flex-1 text-left">T3 Connect</span>
          <span className="text-xs text-muted-foreground">
            {!isLoaded
              ? "Loading sign-in…"
              : !isSignedIn
                ? "Sign in"
                : !discoveryReady
                  ? "Loading computers…"
                  : null}
          </span>
          <ChevronRightIcon
            className={cn("size-4 text-muted-foreground", expanded && isSignedIn && "rotate-90")}
          />
        </CollapsibleTrigger>
        <CollapsiblePanel keepMounted>
          <div className="px-3 pb-3">
            <div className="mb-3 space-y-1.5">
              {isSignedIn ? (
                <CloudEnvironmentConnectRows
                  primaryEnvironmentId={null}
                  savedEnvironments={environments}
                  showSavedEnvironments
                  onDiscoveryReady={onDiscoveryReady}
                  selection={{ selectedIds, onChange: onToggleEnvironment, autoSelectedComputers }}
                  refreshWhileEmpty
                  empty={
                    <p className="py-3 text-sm text-muted-foreground">No computers linked yet.</p>
                  }
                />
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground">
              This Meerkat pilot includes the runtime for your local Mac. Remote installation is not
              included.
            </p>
            <p className="mt-3 text-xs text-muted-foreground">
              If you already have a compatible server, use its connection settings to link it. Keep
              that server running, then select it above.
            </p>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

// ── Step 2′: Direct pairing ──────────────────────────────────

/**
 * Register a computer in this browser using a server-minted pairing link.
 */
function PairingForm({
  isPairing,
  setIsPairing,
  onPaired,
}: {
  readonly isPairing: boolean;
  readonly setIsPairing: (value: boolean) => void;
  readonly onPaired: (environmentId: EnvironmentId) => void;
}) {
  const connectPairingEnvironment = useAtomCommand(connectPairing, { reportFailure: false });
  const [pairingUrl, setPairingUrl] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = async () => {
    if (isPairing || pairingUrl.trim().length === 0) return;
    setIsPairing(true);
    setErrorMessage("");
    const result = await connectPairingEnvironment({ pairingUrl: pairingUrl.trim() });
    if (!mountedRef.current) return;
    setIsPairing(false);
    if (result._tag === "Success") {
      onPaired(result.value);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    setErrorMessage(cause instanceof Error ? cause.message : "Pairing failed.");
  };

  return (
    <>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div>
          <label className="block text-sm text-muted-foreground" htmlFor="onboarding-pairing-url">
            Pairing link
          </label>
          <Input
            id="onboarding-pairing-url"
            autoFocus
            aria-invalid={errorMessage.length > 0}
            aria-describedby={errorMessage ? "onboarding-pairing-error" : undefined}
            className="mt-2"
            size="lg"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            nativeInput
            readOnly={isPairing}
            placeholder="https://your-server:5230/pair#token=…"
            value={pairingUrl}
            onChange={(event) => setPairingUrl(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.nativeEvent.isComposing || event.keyCode === 229)
              ) {
                event.preventDefault();
              }
            }}
          />
        </div>
        {errorMessage ? (
          <div
            id="onboarding-pairing-error"
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive"
          >
            {errorMessage}
          </div>
        ) : null}
        <Collapsible>
          <div className="flex items-center justify-between gap-3">
            <CollapsibleTrigger
              type="button"
              className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ChevronRightIcon className="size-3.5 group-data-panel-open:rotate-90" />
              Need a pairing link?
            </CollapsibleTrigger>
            <Button type="submit" disabled={isPairing || pairingUrl.trim().length === 0}>
              {isPairing ? "Pairing..." : "Pair"}
            </Button>
          </div>
          <CollapsiblePanel>
            <p className="pt-3 text-sm text-muted-foreground">
              Get a fresh pairing link from the connection settings of an existing compatible
              server, or ask its operator for one.
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Remote installation is not included in the Meerkat pilot. For the supported local
              setup, open Meerkat T3 on your Mac and choose this computer.
            </p>
          </CollapsiblePanel>
        </Collapsible>
      </form>
    </>
  );
}

// ── Step 3: agents ───────────────────────────────────────────

const PRIMARY_AGENT_DRIVERS = ["claudeAgent", "codex"] as const;
type OnboardingAgentDriver = (typeof PRIMARY_AGENT_DRIVERS)[number];

/** Setup values stay fixed while provider probes refresh the surrounding cards. */
interface AgentTerminalSession {
  readonly environmentId: EnvironmentId;
  readonly driver: OnboardingAgentDriver;
  readonly providerInstanceId: ServerProvider["instanceId"];
  readonly cwd: string;
  readonly command: string;
  readonly keybindings: ServerConfig["keybindings"];
}

/**
 * Claude Code and Codex use live probe status. Install opens the built-in
 * terminal inline with the vendor's standalone installer pre-typed. The update
 * RPC can't install a binary that isn't there yet (it infers the installer from
 * the installed binary's path), and the terminal also handles the interactive
 * login that follows.
 */
function AgentsStep({
  environmentIds,
  onContinue,
  setupPending,
}: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly onContinue: () => void;
  readonly setupPending: boolean;
}) {
  const { environments } = useEnvironments();
  const [readyByEnvironment, setReadyByEnvironment] = useState<Readonly<Record<string, boolean>>>(
    {},
  );
  const onReadinessChange = useCallback((environmentId: EnvironmentId, ready: boolean) => {
    setReadyByEnvironment((current) =>
      current[environmentId] === ready ? current : { ...current, [environmentId]: ready },
    );
  }, []);
  const ready =
    environmentIds.length > 0 &&
    environmentIds.every(
      (id) =>
        readyByEnvironment[id] &&
        environments.some(
          (environment) =>
            environment.environmentId === id && environment.connection.phase === "connected",
        ),
    );
  return (
    <StepShell
      title="Connect a model"
      description="Connect a provider before starting your first task. Existing credentials on these computers are detected automatically."
    >
      <ScrollArea scrollFade className="mt-5 h-auto max-h-96">
        <div className="space-y-5 pr-3">
          {environmentIds.map((environmentId) => (
            <ConnectedAgentsStep
              key={environmentId}
              environmentId={environmentId}
              onReadinessChange={onReadinessChange}
              setupPending={setupPending}
              machineLabel={
                environments.find((environment) => environment.environmentId === environmentId)
                  ?.label ?? "Computer"
              }
            />
          ))}
        </div>
      </ScrollArea>
      <p className="sr-only" role="status">
        {ready ? "Provider setup is ready. Choose a project to try your first task." : null}
      </p>
      <div className="mt-6 flex justify-end">
        <Button autoFocus onClick={onContinue} disabled={setupPending || !ready}>
          Continue
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </StepShell>
  );
}

function ConnectedAgentsStep({
  environmentId,
  machineLabel,
  onReadinessChange,
  setupPending,
}: {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly onReadinessChange: (environmentId: EnvironmentId, ready: boolean) => void;
  readonly setupPending: boolean;
}) {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? NO_PROVIDERS;
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const [credentialTarget, setCredentialTarget] = useState<ProviderInstanceId | null>(null);
  const [credentialPending, setCredentialPending] = useState(false);
  const [credentialError, setCredentialError] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const ready =
    !credentialPending &&
    !credentialError &&
    !rechecking &&
    !probeError &&
    providers.some((provider) => getOnboardingProviderState(provider) === "ready");
  useEffect(() => {
    onReadinessChange(environmentId, ready);
  }, [environmentId, onReadinessChange, ready]);
  const [terminalSession, setTerminalSession] = useState<AgentTerminalSession | null>(null);

  // Re-probe on entry so freshly installed CLIs show up without a manual
  // refresh; harmless when nothing changed (single-flighted per environment).
  const recheck = useCallback(async () => {
    setRechecking(true);
    setProbeError(null);
    try {
      const result = await refreshProviders({ environmentId, input: {} });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    } catch (cause) {
      setProbeError(
        cause instanceof Error ? cause.message : "Could not check providers. Try again.",
      );
    } finally {
      setRechecking(false);
    }
  }, [environmentId, refreshProviders]);
  useEffect(() => {
    void recheck();
  }, [recheck]);

  const byDriver = useMemo(() => selectOnboardingProvidersByDriver(providers), [providers]);

  const { meerkatProviders, showCliProviders } = selectOnboardingProviderSetup(providers);
  const primaryAgents = (showCliProviders ? PRIMARY_AGENT_DRIVERS : []).map((driver) => ({
    driver,
    provider: byDriver.get(driver),
  }));
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium">{machineLabel}</h2>
      <div className="space-y-1.5">
        {meerkatProviders.map((provider) => (
          <MeerkatOnboardingCard
            key={provider.instanceId}
            provider={provider}
            environmentId={environmentId}
            setupPending={setupPending || credentialPending || rechecking}
            rechecking={rechecking}
            hasCredentialRetry={credentialTarget === provider.instanceId && credentialError}
            onRecheck={() => void recheck()}
            onConfigure={() => setCredentialTarget(provider.instanceId)}
          />
        ))}
        {primaryAgents.map(({ driver, provider }) => (
          <AgentCard
            key={driver}
            driver={driver}
            provider={provider}
            terminalOpen={terminalSession?.driver === driver}
            terminalAvailable={serverConfig !== null}
            onOpenTerminal={() => {
              if (provider === undefined || serverConfig === null) return;
              setTerminalSession({
                environmentId,
                driver,
                providerInstanceId: provider.instanceId,
                cwd: serverConfig.cwd,
                command: provider.installed
                  ? resolveOnboardingProviderLoginCommand(
                      provider,
                      serverConfig.settings,
                      serverConfig.environment.platform.os,
                    )
                  : resolveOnboardingProviderInstallCommand(
                      driver,
                      serverConfig.environment.platform.os,
                    ),
                keybindings: serverConfig.keybindings,
              });
            }}
          />
        ))}
      </div>
      {probeError ? (
        <div className="mt-2 space-y-2">
          <p role="alert" className="text-xs text-destructive">
            {probeError}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void recheck()}
            disabled={setupPending || credentialPending || rechecking}
          >
            Retry check
          </Button>
        </div>
      ) : null}
      {credentialTarget !== null ? (
        <div className="mt-3">
          <OnboardingCredentials
            key={credentialTarget}
            environmentId={environmentId}
            instanceId={credentialTarget}
            onPendingChange={setCredentialPending}
            onErrorChange={setCredentialError}
          />
        </div>
      ) : null}
      {terminalSession !== null ? (
        <AgentInstallTerminal
          key={`${terminalSession.environmentId}:${terminalSession.providerInstanceId}:${terminalSession.driver}`}
          session={terminalSession}
          onClose={() => {
            setTerminalSession(null);
            void recheck();
          }}
        />
      ) : null}
    </section>
  );
}

function MeerkatOnboardingCard({
  provider,
  environmentId,
  onConfigure,
  setupPending,
  rechecking,
  hasCredentialRetry,
  onRecheck,
}: {
  readonly provider: ServerProvider;
  readonly environmentId: EnvironmentId;
  readonly onConfigure: () => void;
  readonly setupPending: boolean;
  readonly rechecking: boolean;
  readonly hasCredentialRetry: boolean;
  readonly onRecheck: () => void;
}) {
  const presentation = getMeerkatOnboardingPresentation(provider);
  const Icon = getDriverOption(provider.driver)?.icon;
  const needsRecovery =
    !presentation.ready &&
    (provider.availability === "unavailable" || getOnboardingProviderState(provider) !== "signIn");
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
      {Icon ? <Icon className="mt-0.5 size-5 shrink-0" /> : null}
      <div className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">
          {provider.displayName?.trim() || "Meerkat"}
        </span>
        <p className="mt-0.5 text-xs leading-relaxed break-words text-muted-foreground">
          {presentation.detail}
        </p>
        {(presentation.ready || getOnboardingProviderState(provider) === "signIn") &&
        provider.availability !== "unavailable" ? (
          <div className="mt-3">
            <Button size="sm" onClick={onConfigure} disabled={setupPending}>
              {setupPending
                ? "Checking credentials..."
                : presentation.ready
                  ? "Manage credentials"
                  : "Set up credentials"}
              <ArrowRightIcon className="size-3.5" />
            </Button>
          </div>
        ) : null}
        {needsRecovery ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {!hasCredentialRetry ? (
              <Button size="sm" variant="outline" onClick={onRecheck} disabled={setupPending}>
                {rechecking ? "Checking..." : "Retry check"}
              </Button>
            ) : null}
            <Link
              to="/settings/providers"
              search={{ environmentId, instanceId: provider.instanceId }}
              className="text-xs text-primary underline underline-offset-2"
            >
              Open Providers
            </Link>
          </div>
        ) : null}
      </div>
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 text-xs font-medium",
          presentation.ready ? "text-success-foreground" : "text-muted-foreground",
        )}
      >
        {presentation.ready ? <CheckIcon className="size-3.5" /> : null}
        {presentation.label}
      </span>
    </div>
  );
}

function AgentCard({
  driver,
  provider,
  terminalOpen,
  terminalAvailable,
  onOpenTerminal,
}: {
  readonly driver: OnboardingAgentDriver;
  readonly provider: ServerProvider | undefined;
  readonly terminalOpen: boolean;
  readonly terminalAvailable: boolean;
  readonly onOpenTerminal: () => void;
}) {
  const meta = getDriverOption(ProviderDriverKind.make(driver));
  const Icon = meta?.icon;
  const displayName = driver === "claudeAgent" ? "Claude Code" : (meta?.label ?? driver);
  const summary = getProviderSummary(provider);
  const providerState = getOnboardingProviderState(provider);

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
      {Icon ? (
        <Icon className={cn("size-5 shrink-0", driver !== "claudeAgent" && "fill-foreground")} />
      ) : null}
      <div className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{displayName}</span>
        <p className="mt-0.5 text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
          {summary.headline}
          {summary.detail ? ` · ${summary.detail}` : ""}
        </p>
      </div>
      <div className="shrink-0">
        {providerState === "ready" ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
            <CheckIcon className="size-3.5" />
            Ready
          </span>
        ) : providerState === "checking" ? (
          <span className="text-xs text-muted-foreground">Checking...</span>
        ) : providerState === "disabled" ? (
          <span className="text-xs text-muted-foreground">Disabled</span>
        ) : providerState === "attention" ? (
          <span className="text-xs text-muted-foreground">{summary.headline}</span>
        ) : (
          <Button
            size="xs"
            variant="ghost"
            onClick={onOpenTerminal}
            disabled={terminalOpen || !terminalAvailable}
          >
            <TerminalIcon className="size-3.5" />
            {providerState === "signIn" ? "Sign in" : "Install"}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Inline install terminal. Opens a PTY on the connected environment under a
 * synthetic onboarding thread id (terminals are keyed by free-form thread id;
 * the server validates only the cwd) and pre-types the install or login
 * command without submitting, so the user reviews and presses Enter.
 */
function AgentInstallTerminal({
  session,
  onClose,
}: {
  readonly session: AgentTerminalSession;
  readonly onClose: () => void;
}) {
  const { command, cwd, driver, environmentId, keybindings, providerInstanceId } = session;
  // Same terminal typography preference the thread drawer honors.
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const setupQueueRef = useRef(Promise.resolve());
  const setupGenerationRef = useRef(0);
  const activeSetupGenerationRef = useRef<number | null>(null);
  const [terminalId] = useState(() => `onboarding-${driver}-${randomUUID()}`);
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, AGENT_ONBOARDING_THREAD_ID),
    [environmentId],
  );
  const [setupAttempt, setSetupAttempt] = useState(0);
  const [setupState, setSetupState] = useState<
    "preparing" | "ready" | "openFailed" | "writeFailed"
  >("preparing");
  const terminalReady = setupState === "ready" || setupState === "writeFailed";

  // Keep each setup generation distinct. In Strict Mode, a canceled open can
  // finish after the replacement setup starts; it must not close or pre-type
  // into the replacement session that shares this terminal id.
  useEffect(() => {
    const generation = setupGenerationRef.current + 1;
    setupGenerationRef.current = generation;
    activeSetupGenerationRef.current = generation;
    setSetupState("preparing");

    setupQueueRef.current = setupQueueRef.current.then(async () => {
      if (activeSetupGenerationRef.current !== generation) return;
      const opened = await openTerminal({
        environmentId,
        input: {
          threadId: AGENT_ONBOARDING_THREAD_ID,
          terminalId,
          cwd,
          providerInstanceId,
        },
      });
      if (opened._tag !== "Success") {
        if (activeSetupGenerationRef.current === generation) setSetupState("openFailed");
        return;
      }

      if (activeSetupGenerationRef.current !== generation) return;

      const wrote = await writeTerminal({
        environmentId,
        input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId, data: command },
      });
      if (activeSetupGenerationRef.current !== generation) return;
      setSetupState(wrote._tag === "Success" ? "ready" : "writeFailed");
    });

    // Every exit path unmounts the drawer (Done, Continue/Skip, card switch,
    // session exit), so this cleanup is the single place the PTY dies —
    // nothing is left running behind the wizard. An interrupted install is
    // re-runnable from the card.
    return () => {
      if (activeSetupGenerationRef.current === generation) {
        activeSetupGenerationRef.current = null;
      }
      setupQueueRef.current = setupQueueRef.current.then(async () => {
        await closeTerminal({
          environmentId,
          input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId, deleteHistory: true },
        });
      });
    };
  }, [
    closeTerminal,
    command,
    cwd,
    environmentId,
    openTerminal,
    providerInstanceId,
    setupAttempt,
    terminalId,
    writeTerminal,
  ]);

  return (
    <div
      data-thread-terminal-drawer
      className="mt-4 overflow-hidden rounded-lg border border-border/70 bg-background text-foreground"
    >
      <div className="flex items-center justify-between border-b border-border/60 bg-background/60 px-3 py-1.5">
        <span className="text-2xs font-medium text-muted-foreground">
          {setupState === "writeFailed" ? (
            <>
              Run <code className="rounded bg-muted px-1 font-mono">{command}</code> in this
              terminal.
            </>
          ) : setupState === "ready" ? (
            "Review the command, then press Enter to run it."
          ) : setupState === "openFailed" ? (
            "Could not open the setup terminal."
          ) : (
            "Preparing command..."
          )}
        </span>
        <div className="flex items-center gap-1">
          {setupState === "openFailed" ? (
            <Button size="xs" variant="ghost" onClick={() => setSetupAttempt((value) => value + 1)}>
              Retry
            </Button>
          ) : null}
          <Button size="xs" variant="ghost-muted" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      <div className="h-64">
        {terminalReady ? (
          <TerminalViewport
            threadRef={threadRef}
            threadId={AGENT_ONBOARDING_THREAD_ID}
            terminalId={terminalId}
            terminalLabel={`Install ${driver}`}
            cwd={cwd}
            providerInstanceId={providerInstanceId}
            advancedTypography={advancedTypography}
            onSessionExited={onClose}
            onSessionClosed={onClose}
            focusRequestId={1}
            autoFocus
            visible
            resizeEpoch={0}
            drawerHeight={256}
            keybindings={keybindings}
          />
        ) : null}
      </div>
    </div>
  );
}

// ── Step 4: import ───────────────────────────────────────────

function ImportStep({
  scans,
  isImporting,
  setIsImporting,
  onDone,
}: {
  readonly scans: ReturnType<typeof useProjectScans>;
  readonly isImporting: boolean;
  readonly setIsImporting: (value: boolean) => void;
  readonly onDone: (projectRef?: ScopedProjectRef) => Promise<boolean>;
}) {
  const { environments } = useEnvironments();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const importThreads = useAtomCommand(agentSessionImport, { reportFailure: false });
  const projects = useProjects();
  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string> | null>(null);
  const [importError, setImportError] = useState("");
  const [landingProject, setLandingProject] = useState<ScopedProjectRef | null>(null);
  // Keep project creation attempts separate from completed history imports so both can retry.
  const importedProjectsRef = useRef(new Map<string, ScopedProjectRef>());
  const projectsWithImportedHistoryRef = useRef(new Map<string, ScopedProjectRef>());
  const lastImportSelectionRef = useRef<ReadonlyArray<string>>([]);
  const projectAttemptsRef = useRef(
    new Map<string, { readonly projectId: ProjectId; readonly commandId: CommandId }>(),
  );
  const importGenerationRef = useRef(0);

  // Ignore command completions after leaving the import step.
  useEffect(() => {
    importGenerationRef.current += 1;
    return () => {
      importGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (
      landingProject !== null &&
      projects.some(
        (project) =>
          project.id === landingProject.projectId &&
          project.environmentId === landingProject.environmentId,
      )
    ) {
      setLandingProject(null);
      void onDone(landingProject).then((completed) => {
        if (!completed) setIsImporting(false);
      });
    }
  }, [landingProject, onDone, projects, setIsImporting]);

  const { available: candidates, recent } = useMemo(
    () =>
      partitionOnboardingProjects(
        scans.flatMap((scan) =>
          (scan.data?.candidates ?? []).map((candidate) => ({
            ...candidate,
            environmentId: scan.environmentId,
            key: onboardingProjectKey(scan.environmentId, candidate.path),
          })),
        ),
      ),
    [scans],
  );
  const selectedKeys = useMemo(
    () => selectedPaths ?? new Set(recent.map((candidate) => candidate.key)),
    [selectedPaths, recent],
  );
  const selected = candidates.filter((candidate) => selectedKeys.has(candidate.key));

  const finishAfterImport = () => {
    const projectRef = resolveOnboardingLandingProject(
      lastImportSelectionRef.current,
      projectsWithImportedHistoryRef.current,
      importedProjectsRef.current,
    );
    if (projectRef === undefined) {
      void onDone();
      return;
    }
    setIsImporting(true);
    setLandingProject(projectRef);
  };

  const runImport = async (selection: typeof candidates) => {
    if (isImporting) return;
    if (selection.length === 0) {
      void onDone();
      return;
    }
    setIsImporting(true);
    setImportError("");
    lastImportSelectionRef.current = selection.map((candidate) => candidate.key);
    const importGeneration = importGenerationRef.current;
    const importedProjects = importedProjectsRef.current;
    const projectAttempts = projectAttemptsRef.current;
    // Interrupted imports are neither failures nor successes — the command was
    // superseded or the environment dropped — but they still didn't land, so
    // they must not read as "imported everything". Retries skip paths that
    // already landed this session (re-creating them would only trip the
    // duplicate-root invariant and read as a failure).
    let importedProjectsCount =
      importedProjects.size > 0
        ? selection.filter((candidate) => importedProjects.has(candidate.key)).length
        : 0;
    let importedThreadCount = 0;
    let skippedThreadCount = 0;
    const refreshEnvironments = new Set<EnvironmentId>();
    for (const candidate of selection) {
      const { environmentId } = candidate;
      if (
        importGeneration !== importGenerationRef.current ||
        importedProjects !== importedProjectsRef.current
      ) {
        return;
      }
      if (importedProjects.has(candidate.key)) continue;
      let projectId = resolveOnboardingProjectId(readProjects(), environmentId, candidate);
      if (projectId === null) {
        let attempt = projectAttempts.get(candidate.key);
        if (attempt === undefined) {
          const nextProjectId = newProjectId();
          attempt = {
            projectId: nextProjectId,
            commandId: CommandId.make(`onboarding:project:create:${nextProjectId}`),
          };
          projectAttempts.set(candidate.key, attempt);
        }
        projectId = attempt.projectId;
        const result = await createProject({
          environmentId,
          input: {
            projectId,
            commandId: attempt.commandId,
            title: candidate.title,
            workspaceRoot: candidate.path,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (
          importGeneration !== importGenerationRef.current ||
          importedProjects !== importedProjectsRef.current
        ) {
          return;
        }
        if (result._tag !== "Success") {
          if (!isAtomCommandInterrupted(result)) {
            projectAttempts.delete(candidate.key);
            refreshEnvironments.add(environmentId);
          }
          continue;
        }
      }

      const threadImportResult = await importThreads({
        environmentId,
        input: { projectId, expectedWorkspaceRoot: candidate.path },
      });
      if (
        importGeneration !== importGenerationRef.current ||
        importedProjects !== importedProjectsRef.current
      ) {
        return;
      }
      if (threadImportResult._tag === "Success") {
        importedThreadCount += threadImportResult.value.importedCount;
        skippedThreadCount += threadImportResult.value.skippedCount;
        if (threadImportResult.value.importedCount > 0) {
          projectsWithImportedHistoryRef.current.set(
            candidate.key,
            scopeProjectRef(environmentId, projectId),
          );
        }
        if (threadImportResult.value.skippedCount === 0) {
          importedProjectsCount += 1;
          importedProjects.set(candidate.key, scopeProjectRef(environmentId, projectId));
        }
      } else if (!isAtomCommandInterrupted(threadImportResult)) {
        projectAttempts.delete(candidate.key);
        refreshEnvironments.add(environmentId);
      }
    }
    for (const scan of scans) {
      if (refreshEnvironments.has(scan.environmentId)) scan.refresh();
    }
    setIsImporting(false);
    if (importedProjectsCount < selection.length) {
      if (importedThreadCount > 0 && skippedThreadCount > 0) {
        setImportError(
          `Imported ${importedThreadCount} ${importedThreadCount === 1 ? "thread" : "threads"}. ${skippedThreadCount} ${skippedThreadCount === 1 ? "thread" : "threads"} could not be imported.`,
        );
      } else if (skippedThreadCount > 0) {
        setImportError(
          `${skippedThreadCount} ${skippedThreadCount === 1 ? "thread could" : "threads could"} not be imported.`,
        );
      } else if (importedThreadCount > 0) {
        setImportError(
          `Imported ${importedThreadCount} ${importedThreadCount === 1 ? "thread" : "threads"}. Some thread history could not be imported.`,
        );
      } else {
        setImportError("Could not import thread history.");
      }
      return;
    }
    finishAfterImport();
  };

  if (scans.every((scan) => scan.data === null) && scans.some((scan) => scan.isPending)) {
    return (
      <div className="flex h-full min-h-40 flex-col">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Your projects</h1>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-6">
          <Spinner size="lg" tone="muted" />
          <p className="text-center text-sm text-muted-foreground">
            Looking for projects from Claude Code and Codex…
          </p>
        </div>
        <div className="flex justify-end">
          <Button variant="ghost-muted" onClick={() => void onDone()}>
            Do not import projects
          </Button>
        </div>
      </div>
    );
  }

  return (
    <StepShell
      title="Choose your projects"
      description="Import projects and conversations from your selected computers."
    >
      {candidates.length > 0 ? (
        <div className="mt-5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span role="status">
            {selected.length} of {candidates.length} selected
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              disabled={isImporting || selected.length === candidates.length}
              onClick={() => setSelectedPaths(new Set(candidates.map((item) => item.key)))}
            >
              Select all
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={isImporting || selected.length === 0}
              onClick={() => setSelectedPaths(new Set())}
            >
              Select none
            </Button>
          </div>
        </div>
      ) : null}
      <ScrollArea scrollFade className="mt-2 h-auto max-h-80">
        <div className="space-y-5 pr-3">
          {scans.map((scan) => {
            const scanCandidates = candidates.filter(
              (candidate) => candidate.environmentId === scan.environmentId,
            );
            const label =
              environments.find((environment) => environment.environmentId === scan.environmentId)
                ?.label ?? "Computer";
            return (
              <fieldset
                key={scan.environmentId}
                className="min-w-0 space-y-0.5"
                disabled={isImporting}
              >
                {scans.length > 1 ? (
                  <legend className="mb-2 text-sm font-medium">{label}</legend>
                ) : null}
                {scan.isPending && scan.data === null ? (
                  <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                    <Spinner size="md" />
                    Looking for projects…
                  </div>
                ) : scan.error !== null ? (
                  <div
                    role="alert"
                    className="flex items-center justify-between gap-3 text-sm text-muted-foreground"
                  >
                    <span>Could not check projects. {scan.error}</span>
                    <Button variant="ghost" size="sm" onClick={scan.refresh}>
                      Retry
                    </Button>
                  </div>
                ) : scanCandidates.length === 0 ? (
                  <p className="py-2 text-sm text-muted-foreground">
                    No existing Claude Code or Codex projects found.
                  </p>
                ) : null}
                {scan.data?.truncated ? (
                  <p className="text-xs text-muted-foreground" role="status">
                    {SCAN_LIMIT_MESSAGE}
                  </p>
                ) : null}
                <ImportCandidateList
                  candidates={scanCandidates}
                  selectedKeys={selectedKeys}
                  onSelectionChange={setSelectedPaths}
                />
              </fieldset>
            );
          })}
        </div>
      </ScrollArea>
      {importError ? <p className="mt-3 text-sm text-destructive">{importError}</p> : null}
      <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
        <Button
          variant="ghost-muted"
          disabled={isImporting}
          onClick={importError ? finishAfterImport : () => void onDone()}
        >
          {importError ? "Continue without the rest" : "Do not import projects"}
        </Button>
        <Button
          autoFocus
          disabled={isImporting || selected.length === 0}
          onClick={() => void runImport(selected)}
        >
          {isImporting
            ? "Importing…"
            : `Import ${selected.length} ${selected.length === 1 ? "project" : "projects"}`}
        </Button>
      </div>
    </StepShell>
  );
}

type ImportCandidate = AgentSessionProjectCandidate & {
  readonly environmentId: EnvironmentId;
  readonly key: string;
};

/**
 * Repositories first, newest activity on top. Clones of one repository share
 * a group with a tri-state checkbox. Folders that are not git repositories
 * sit collapsed at the bottom so they stay reachable without adding noise.
 * Source icons appear only on repository rows so the columns stay still.
 */
function ImportCandidateList({
  candidates,
  selectedKeys,
  onSelectionChange,
}: {
  readonly candidates: ReadonlyArray<ImportCandidate>;
  readonly selectedKeys: ReadonlySet<string>;
  readonly onSelectionChange: (next: ReadonlySet<string>) => void;
}) {
  const { repositories, other } = useMemo(() => groupOnboardingProjects(candidates), [candidates]);
  const setKeys = (keys: ReadonlyArray<string>, checked: boolean) => {
    const next = new Set(selectedKeys);
    for (const key of keys) {
      if (checked) next.add(key);
      else next.delete(key);
    }
    onSelectionChange(next);
  };
  const otherSelected = other.filter((candidate) => selectedKeys.has(candidate.key)).length;

  return (
    <>
      {repositories.map((group) => (
        <ImportRepositoryGroup
          key={group.key}
          group={group}
          selectedKeys={selectedKeys}
          onToggle={setKeys}
        />
      ))}
      {other.length > 0 ? (
        <Collapsible>
          <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40">
            <Checkbox
              checked={otherSelected === other.length}
              indeterminate={otherSelected > 0 && otherSelected < other.length}
              onCheckedChange={(checked) =>
                setKeys(
                  other.map((candidate) => candidate.key),
                  checked === true,
                )
              }
            />
            <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 text-left">
              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
              <span className="truncate text-sm text-muted-foreground">Other folders</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                {other.length} {other.length === 1 ? "folder" : "folders"}
              </span>
            </CollapsibleTrigger>
          </div>
          <CollapsiblePanel>
            {other.map((candidate) => (
              <ImportCandidateRow
                key={candidate.key}
                candidate={candidate}
                label={candidate.path}
                nested
                checked={selectedKeys.has(candidate.key)}
                onCheckedChange={(checked) => setKeys([candidate.key], checked)}
              />
            ))}
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </>
  );
}

function ImportRepositoryGroup({
  group,
  selectedKeys,
  onToggle,
}: {
  readonly group: OnboardingProjectGroup<ImportCandidate>;
  readonly selectedKeys: ReadonlySet<string>;
  readonly onToggle: (keys: ReadonlyArray<string>, checked: boolean) => void;
}) {
  const keys = group.candidates.map((candidate) => candidate.key);
  const selectedCount = keys.filter((key) => selectedKeys.has(key)).length;
  const single = group.candidates.length === 1;
  const only = group.candidates[0];
  if (single && only !== undefined) {
    return (
      <ImportCandidateRow
        candidate={only}
        label={group.label}
        {...(group.repository === null ? {} : { secondary: only.path })}
        checked={selectedKeys.has(only.key)}
        onCheckedChange={(checked) => onToggle([only.key], checked)}
      />
    );
  }
  return (
    <Collapsible defaultOpen>
      <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40">
        <Checkbox
          checked={selectedCount === keys.length}
          indeterminate={selectedCount > 0 && selectedCount < keys.length}
          onCheckedChange={(checked) => onToggle(keys, checked === true)}
        />
        <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
          <span className="truncate text-sm font-medium">{group.label}</span>
          <ImportRowMeta
            sources={[...new Set(group.candidates.flatMap((c) => c.sources))]}
            threadCount={group.threadCount}
            lastActiveAt={group.lastActiveAt}
          />
        </CollapsibleTrigger>
      </div>
      <CollapsiblePanel>
        {group.candidates.map((candidate) => (
          <ImportCandidateRow
            key={candidate.key}
            candidate={candidate}
            label={candidate.path}
            nested
            checked={selectedKeys.has(candidate.key)}
            onCheckedChange={(checked) => onToggle([candidate.key], checked)}
          />
        ))}
      </CollapsiblePanel>
    </Collapsible>
  );
}

function ImportCandidateRow({
  candidate,
  label,
  secondary,
  nested = false,
  checked,
  onCheckedChange,
}: {
  readonly candidate: ImportCandidate;
  readonly label: string;
  readonly secondary?: string;
  readonly nested?: boolean;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40 has-disabled:cursor-default",
        nested && "pl-8",
      )}
    >
      <Checkbox checked={checked} onCheckedChange={(value) => onCheckedChange(value === true)} />
      <Tooltip>
        <TooltipTrigger
          render={<span className="flex min-w-0 flex-1 items-baseline gap-2 truncate" />}
        >
          <span className={cn("truncate", nested ? "font-mono text-xs" : "text-sm font-medium")}>
            {label}
          </span>
          {secondary !== undefined ? (
            <span className="truncate font-mono text-2xs text-muted-foreground">{secondary}</span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup variant="code">{candidate.path}</TooltipPopup>
      </Tooltip>
      <ImportRowMeta
        sources={nested ? null : candidate.sources}
        threadCount={candidate.threadCount}
        lastActiveAt={candidate.lastActiveAt}
      />
    </label>
  );
}

/**
 * Trailing columns shared by every import row: source icons, thread count,
 * last activity. Each column has a fixed width and each icon has its own slot
 * so nothing shifts between rows that differ in sources or digit count.
 */
function ImportRowMeta({
  sources,
  threadCount,
  lastActiveAt,
}: {
  readonly sources: ReadonlyArray<"claudeAgent" | "codex"> | null;
  readonly threadCount: number;
  readonly lastActiveAt: string | null;
}) {
  const relative = lastActiveAt === null ? null : formatRelativeTime(lastActiveAt);
  // "just now" does not fit the fixed column, so collapse it.
  const age = relative === null ? "" : relative.suffix === null ? "now" : relative.value;
  return (
    <span className="ml-auto grid shrink-0 grid-cols-[1rem_1rem_2.5rem_2.25rem] items-center gap-x-1 text-xs text-muted-foreground tabular-nums">
      <span className="flex size-4 items-center justify-center">
        {sources?.includes("claudeAgent") ? (
          <ClaudeAI className="size-3" aria-label="Claude Code" />
        ) : null}
      </span>
      <span className="flex size-4 items-center justify-center">
        {sources?.includes("codex") ? <OpenAI className="size-3" aria-label="Codex" /> : null}
      </span>
      <span className="text-right">{threadCount}</span>
      <span className="text-right whitespace-nowrap">{age}</span>
    </span>
  );
}

// ── Shared bits ──────────────────────────────────────────────

function StepShell({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      {description ? (
        <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {children}
    </>
  );
}

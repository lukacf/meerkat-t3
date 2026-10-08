import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useRef, useState } from "react";

import {
  ensureClientSettingsHydrated,
  useClientSettings,
  useClientSettingsHydrationStatus,
} from "../../hooks/useSettings";
import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { useCompleteOnboarding } from "../../onboarding/firstRun";
import {
  isFirstRunWorkspaceProvenanceAuthoritative,
  isFreshFirstRunWorkspace,
  resolveFirstRunDecision,
  resolveHostedFirstRunDecision,
  transitionFirstRunGateState,
  type FirstRunGateState,
} from "../../onboarding/firstRun.logic";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { environmentProjects } from "../../state/projects";
import { primaryServerConfigAtom, primaryServerWelcomeAtom } from "../../state/server";
import { environmentShell } from "../../state/shell";
import { environmentThreadShells } from "../../state/threads";
import { Button } from "../ui/button";

/**
 * Holds back authenticated and hosted app trees until the first-run decision
 * is known, so a fresh install never flashes the main screen before the wizard.
 * Nothing renders while pending — no shell, no EventRouter (whose welcome
 * payload would otherwise navigate into a thread), no dialogs.
 *
 * Decision order: a set `onboardingCompletedAt` resolves to the app as soon as
 * settings hydrate (the common case, no server round-trip). A `null` flag also
 * covers installs that predate the field, so it alone is not enough — the gate
 * waits for environment shells to bootstrap and inspects the workspace.
 * Hosted mode instead checks its saved environment catalog. A timeout shows
 * recovery for an unreachable primary server without mounting the app tree.
 */

const FIRST_RUN_DECISION_TIMEOUT_MS = 4_000;

const primaryShellLiveAtom = Atom.make((get) => {
  const serverConfig = get(primaryServerConfigAtom);
  return (
    serverConfig !== null &&
    get(environmentShell.stateValueAtom(serverConfig.environment.environmentId)).status === "live"
  );
}).pipe(Atom.withLabel("web-onboarding-primary-shell-live"));

const workspaceEvidenceLiveAtom = Atom.make((get) => {
  const environmentIds = new Set([
    ...get(environmentProjects.projectsAtom).map((project) => project.environmentId),
    ...get(environmentThreadShells.threadShellsAtom).map((thread) => thread.environmentId),
  ]);

  for (const environmentId of environmentIds) {
    if (get(environmentShell.stateValueAtom(environmentId)).status !== "live") {
      return false;
    }
  }

  return true;
}).pipe(Atom.withLabel("web-onboarding-workspace-evidence-live"));

export function FirstRunGate({
  enabled,
  hostedStatic,
  children,
}: {
  readonly enabled: boolean;
  readonly hostedStatic: boolean;
  readonly children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const hydrationStatus = useClientSettingsHydrationStatus();
  const hydrated = hydrationStatus === "ready";
  const completeOnboarding = useCompleteOnboarding();
  const onboardingProgress = useClientSettings((settings) => settings.onboardingProgress);
  const providerRecovery =
    hydrated && onboardingProgress !== null && pathname === "/settings/providers";
  const resumed = useRef(false);
  const onboardingCompletedAt = useClientSettings((settings) => settings.onboardingCompletedAt);
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const { environments, isReady: environmentCatalogReady } = useEnvironments();
  const projects = useProjects();
  const threads = useThreadShells();
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const serverWelcome = useAtomValue(primaryServerWelcomeAtom);
  const primaryShellLive = useAtomValue(primaryShellLiveAtom);
  const workspaceEvidenceLive = useAtomValue(workspaceEvidenceLiveAtom);
  // Within a session settings stay hydrated, so remounts (e.g. returning from
  // the wizard) resolve synchronously instead of blanking a frame.
  const [gateState, setGateState] = useState<FirstRunGateState>(() => ({
    decision:
      (!enabled && !hostedStatic) || (hydrated && onboardingCompletedAt !== null)
        ? "app"
        : "pending",
    stalled: false,
  }));
  const { stalled } = gateState;
  const decision =
    hydrated && onboardingProgress
      ? onboardingProgress.step === "first-task"
        ? "app"
        : "wizard"
      : gateState.decision;
  const settingsReadFailed = hydrationStatus === "failed" || hydrationStatus === "retrying";
  // A workspace still counts as fresh when its only content is the server's
  // own cwd auto-bootstrap: web mode creates a project + thread from cwd at
  // startup (`autoBootstrapProjectFromCwd` defaults on there), so "no
  // projects at all" would mean `npx t3` users never see the wizard. Any
  // other project, more than one thread, or state in a non-primary
  // environment is real user state — the aggregate hooks span every
  // environment, and a saved remote's project must never read as "the
  // bootstrap project" just because its root string matches the primary cwd.
  const serverCwd = serverConfig?.cwd ?? null;
  const primaryEnvironmentId = serverConfig?.environment.environmentId ?? null;
  const workspaceFresh = isFreshFirstRunWorkspace({
    primaryEnvironmentId,
    serverCwd,
    bootstrapProjectId: serverWelcome?.bootstrapProjectId,
    bootstrapThreadId: serverWelcome?.bootstrapThreadId,
    bootstrapProjectCreated: serverWelcome?.bootstrapProjectCreated,
    bootstrapThreadCreated: serverWelcome?.bootstrapThreadCreated,
    projects,
    threads,
  });

  const { decision: nextDecision, persistCompletion } = hostedStatic
    ? resolveHostedFirstRunDecision({
        localEnvironmentDisabled: isLocalEnvironmentDisabled(),
        hydrated,
        completed: onboardingCompletedAt !== null,
        progressStep: onboardingProgress?.step,
        catalogReady: environmentCatalogReady,
        environmentCount: environments.length,
      })
    : resolveFirstRunDecision({
        enabled,
        hydrated,
        completed: onboardingCompletedAt !== null,
        progressStep: onboardingProgress?.step,
        bootstrapped,
        authoritative: primaryShellLive,
        workspaceAuthoritative: workspaceEvidenceLive,
        workspaceProvenanceAuthoritative: isFirstRunWorkspaceProvenanceAuthoritative({
          welcomeReceived: serverWelcome !== null,
          bootstrapStatus: serverWelcome?.bootstrapStatus ?? null,
        }),
        catalogReady: environmentCatalogReady,
        serverConfigAvailable: serverConfig !== null,
        workspaceFresh,
        projectCount: projects.length,
        threadCount: threads.length,
      });

  useEffect(() => {
    if (decision === "wizard" || !hydrated || onboardingProgress !== null) return;

    if (persistCompletion && onboardingCompletedAt === null) {
      void completeOnboarding().catch(() => undefined);
    }

    setGateState((state) =>
      transitionFirstRunGateState(state, { type: "evidence", decision: nextDecision }),
    );
  }, [
    completeOnboarding,
    decision,
    hydrated,
    nextDecision,
    onboardingCompletedAt,
    onboardingProgress,
    persistCompletion,
  ]);

  // A stalled server read gets a recovery screen, but never mounts the app.
  // The timer starts after settings hydrate so slow local hydration does not
  // show a false connection failure.
  useEffect(() => {
    if (!enabled || decision !== "pending" || !hydrated) return;
    const timer = window.setTimeout(
      () => setGateState((state) => transitionFirstRunGateState(state, { type: "timeout" })),
      FIRST_RUN_DECISION_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [decision, enabled, hydrated]);

  useEffect(() => {
    if (decision === "wizard" && pathname !== "/welcome" && !providerRecovery) {
      void navigate({ to: "/welcome", replace: true });
    }
  }, [decision, navigate, pathname, providerRecovery]);

  useEffect(() => {
    if (
      resumed.current ||
      providerRecovery ||
      !hydrated ||
      onboardingProgress?.step !== "first-task" ||
      !onboardingProgress.projectRef ||
      !environmentCatalogReady ||
      !bootstrapped
    )
      return;
    const { environmentId, projectId } = onboardingProgress.projectRef;
    // Wait for the selected project to arrive; never substitute an unrelated workspace.
    if (
      !projects.some(
        (project) => project.environmentId === environmentId && project.id === projectId,
      )
    )
      return;
    resumed.current = true;
    if (
      onboardingProgress.threadId &&
      threads.some(
        (thread) =>
          thread.environmentId === environmentId && thread.id === onboardingProgress.threadId,
      )
    ) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: onboardingProgress.threadId },
        replace: true,
      });
    } else {
      void navigate({
        to: "/$environmentId/projects/$projectId/start",
        params: { environmentId, projectId },
        replace: true,
      });
    }
  }, [
    bootstrapped,
    environmentCatalogReady,
    hydrated,
    navigate,
    onboardingProgress,
    projects,
    providerRecovery,
    threads,
  ]);

  if (settingsReadFailed) {
    return <FirstRunRecovery reason="settings" retrying={hydrationStatus === "retrying"} />;
  }
  if (decision !== "app" && !providerRecovery) {
    return stalled ? <FirstRunRecovery reason="connection" /> : null;
  }
  const setupEnvironment = environments.find(
    (environment) => environment.environmentId === onboardingProgress?.projectRef?.environmentId,
  );
  const missingSetupProject =
    onboardingProgress?.step === "first-task" &&
    environmentCatalogReady &&
    onboardingProgress.projectRef &&
    (setupEnvironment?.connection.phase !== "connected" ||
      (bootstrapped &&
        !projects.some(
          (project) =>
            project.environmentId === onboardingProgress.projectRef?.environmentId &&
            project.id === onboardingProgress.projectRef.projectId,
        )));
  return (
    <>
      {children}
      {providerRecovery ? (
        <aside
          className="fixed right-4 bottom-4 z-50 max-w-sm space-y-2 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg"
          aria-label="Resume setup"
        >
          <p className="text-sm font-medium">Setup is saved</p>
          <p className="text-xs text-muted-foreground">
            Return to setup after fixing your provider.
          </p>
          <Button size="sm" onClick={() => void navigate({ to: "/welcome" })}>
            Back to setup
          </Button>
        </aside>
      ) : null}
      {missingSetupProject && !providerRecovery ? (
        <aside
          className="fixed right-4 bottom-4 z-50 max-w-sm space-y-2 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg"
          aria-label="Resume setup"
        >
          <p className="text-sm font-medium">Your setup project is unavailable</p>
          <p className="text-xs text-muted-foreground">
            Reconnect its computer or choose another project to finish your first task.
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void navigate({ to: "/welcome" })}>
              Resume setup
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void completeOnboarding().catch(() => undefined)}
            >
              Skip setup
            </Button>
          </div>
        </aside>
      ) : null}
    </>
  );
}

export function FirstRunRecovery({
  reason,
  retrying = false,
}: {
  readonly reason: "settings" | "connection";
  readonly retrying?: boolean;
}) {
  const settingsReadFailed = reason === "settings";
  return (
    <main className="flex h-dvh min-h-0 items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-sm flex-col items-center text-center">
        <h1 className="text-lg font-semibold">
          {settingsReadFailed ? "Could not read settings" : "Still connecting"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {settingsReadFailed
            ? "Your saved settings could not be loaded."
            : "T3 Code could not confirm this workspace."}
        </p>
        <Button
          className="mt-5"
          size="sm"
          variant="outline"
          disabled={retrying}
          onClick={() => {
            if (settingsReadFailed) {
              void ensureClientSettingsHydrated().catch(() => undefined);
            } else {
              window.location.reload();
            }
          }}
        >
          <RefreshIcon refreshing={retrying} />
          {settingsReadFailed ? "Retry" : "Reload"}
        </Button>
      </div>
    </main>
  );
}

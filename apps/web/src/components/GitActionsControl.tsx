import { useAtomValue } from "@effect/atom-react";
import {
  isProviderAvailable,
  type SourceControlPublishPendingResult,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  GitActionProgressEvent,
  GitRunStackedActionResult,
  GitRunStackedActionInput,
  GitStackedAction,
  SourceControlCloneProtocol,
  SourceControlProviderDiscoveryItem,
  SourceControlProviderKind,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryVisibility,
  VcsStatusResult,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { usePublishRepositoryRecovery } from "./publishRepositoryRecovery";
import {
  CheckIcon,
  ChevronDownIcon,
  CloudDownloadIcon,
  CloudUploadIcon,
  GitBranchPlusIcon,
  GitCommitIcon,
  InfoIcon,
  LockIcon,
  GlobeIcon,
} from "lucide-react";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import {
  AzureDevOpsIcon,
  BitbucketIcon,
  GitHubIcon,
  GitLabIcon,
  ForgejoIcon,
} from "~/components/Icons";
import { RadioGroup } from "~/components/ui/radio-group";
import { Spinner } from "~/components/ui/spinner";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";
import {
  buildGitActionProgressStages,
  buildMenuItems,
  canContinueOnFeatureBranch,
  captureGitActionFollowupIntent,
  captureGitActionIntent,
  clearCommittedMessageDraft,
  isGitActionIntentCurrent,
  manualPrSubmissionBlocker,
  type CommitMessageDrafts,
  type GitActionIconName,
  type GitActionMenuItem,
  type GitActionIntent,
  type GitQuickAction,
  type DefaultBranchConfirmableAction,
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  resolveGeneratedDraftAction,
  resolveLiveThreadBranchUpdate,
  resolvePublishRepositoryEntry,
  resolveThreadBranchMetadataPatch,
  resolveQuickAction,
  resolveThreadBranchUpdate,
} from "./GitActionsControl.logic";
import { WizardPopup, WizardHeader, WizardSteps, WizardPanel, WizardFooter } from "./ui/wizard";
import { StartTruncatedPath } from "./StartTruncatedPath";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Group, GroupSeparator } from "~/components/ui/group";
import { Input } from "~/components/ui/input";
import {
  Menu,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
  MenuTrigger,
} from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";
import { stackedThreadToast, toastManager, type ThreadToastData } from "~/components/ui/toast";
import { showCreatedPullRequestLinkWarning } from "./createdPullRequestLinkToast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useOpenInPreferredEditor } from "~/editorPreferences";
import {
  useGitStackedAction,
  useSourceControlActionRunning,
  useSourceControlPublishRepositoryAction,
  useVcsInitAction,
  useVcsPullAction,
} from "~/lib/sourceControlActions";
import { useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { randomUUID } from "~/lib/utils";
import { resolvePathLinkTarget } from "~/terminal-links";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { useOpenLink } from "~/browser/useOpenLink";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { useGitAuthorSetup } from "./GitAuthorDialog";

interface GitActionsControlProps {
  presentation?: "toolbar" | "menu";
  environmentId?: ScopedThreadRef["environmentId"];
  gitCwd: string | null;
  activeThreadRef: ScopedThreadRef | null;
  draftId?: DraftId;
  /**
   * Opens the thread's own change request beside it. Absent when the thread has no project to
   * place it against, in which case it still opens in the browser.
   */
  onOpenPullRequest?: ((number: number) => void) | undefined;
}

interface PendingDefaultBranchAction extends GitActionIntent {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  commitMessage?: string;
  pullRequest?: GitRunStackedActionInput["pullRequest"];
  onConfirmed?: () => void;
  filePaths?: string[];
}

type PublishProviderKind = Extract<
  SourceControlProviderKind,
  "github" | "gitlab" | "forgejo" | "bitbucket" | "azure-devops"
>;

type GitActionToastId = ReturnType<typeof toastManager.add>;

interface ActiveGitActionProgress {
  toastId: GitActionToastId;
  toastData: ThreadToastData | undefined;
  actionId: string;
  title: string;
  phaseStartedAtMs: number | null;
  hookStartedAtMs: number | null;
  hookName: string | null;
  lastOutputLine: string | null;
  currentPhaseLabel: string | null;
}

interface RunGitActionWithToastInput {
  action: GitStackedAction;
  commitMessage?: string;
  pullRequest?: GitRunStackedActionInput["pullRequest"];
  onConfirmed?: () => void;
  skipDefaultBranchPrompt?: boolean;
  statusOverride?: VcsStatusResult | null;
  featureBranch?: boolean;
  progressToastId?: GitActionToastId;
  filePaths?: string[];
  authorVerifiedFor?: string;
  intent?: GitActionIntent;
}

const GIT_STATUS_WINDOW_REFRESH_DEBOUNCE_MS = 250;

type RefreshVcsStatus = (target: {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly input: { readonly cwd: string };
}) => Promise<unknown>;

function requestVcsStatusRefresh(
  refresh: RefreshVcsStatus,
  environmentId: ScopedThreadRef["environmentId"] | null,
  cwd: string | null,
): void {
  if (environmentId === null || cwd === null) {
    return;
  }
  void refresh({ environmentId, input: { cwd } });
}
const RUNNING_SOURCE_CONTROL_ACTIONS = ["runStackedAction", "pull", "publishRepository"] as const;

const PUBLISH_PROVIDER_OPTIONS = [
  {
    value: "forgejo",
    label: "Forgejo / Gitea",
    description: "Your signed-in server",
    host: "your server",
    pathPlaceholder: "owner/repo",
    Icon: ForgejoIcon,
  },
  {
    value: "github",
    label: "GitHub",
    description: "github.com",
    host: "github.com",
    pathPlaceholder: "owner/repo",
    Icon: GitHubIcon,
  },
  {
    value: "gitlab",
    label: "GitLab",
    description: "gitlab.com",
    host: "gitlab.com",
    pathPlaceholder: "group/project",
    Icon: GitLabIcon,
  },
  {
    value: "bitbucket",
    label: "Bitbucket",
    description: "bitbucket.org",
    host: "bitbucket.org",
    pathPlaceholder: "workspace/repository",
    Icon: BitbucketIcon,
  },
  {
    value: "azure-devops",
    label: "Azure DevOps",
    description: "dev.azure.com",
    host: "dev.azure.com",
    pathPlaceholder: "project/repository",
    Icon: AzureDevOpsIcon,
  },
] as const satisfies ReadonlyArray<{
  readonly value: PublishProviderKind;
  readonly label: string;
  readonly description: string;
  readonly host: string;
  readonly pathPlaceholder: string;
  readonly Icon: typeof GitHubIcon;
}>;

function publishProviderOption(provider: PublishProviderKind) {
  return (
    PUBLISH_PROVIDER_OPTIONS.find((option) => option.value === provider) ??
    PUBLISH_PROVIDER_OPTIONS[0]
  );
}

function isPublishProviderKind(
  provider: SourceControlProviderKind,
): provider is PublishProviderKind {
  return PUBLISH_PROVIDER_OPTIONS.some((option) => option.value === provider);
}

function getPublishProviderReadiness(input: {
  provider: PublishProviderKind;
  sourceControlProviders: ReadonlyArray<SourceControlProviderDiscoveryItem>;
}): { readonly ready: boolean; readonly hint: string | null } {
  const discovered = input.sourceControlProviders.find(
    (provider) => provider.kind === input.provider,
  );
  if (!discovered) {
    return {
      ready: false,
      hint: "Provider status unavailable. Open Settings -> Source Control and rescan.",
    };
  }
  if (discovered.status !== "available") {
    return { ready: false, hint: discovered.installHint };
  }
  if (discovered.auth.status === "unauthenticated") {
    return {
      ready: false,
      hint:
        Option.getOrNull(discovered.auth.detail) ??
        `${discovered.label} is not authenticated. Open Settings -> Source Control for setup guidance.`,
    };
  }
  return { ready: true, hint: null };
}

function formatElapsedDescription(startedAtMs: number | null): string | undefined {
  if (startedAtMs === null) {
    return undefined;
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `Running for ${elapsedSeconds}s`;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `Running for ${minutes}m ${seconds}s`;
}

function resolveProgressDescription(progress: ActiveGitActionProgress): string | undefined {
  if (progress.lastOutputLine) {
    return progress.lastOutputLine;
  }
  return formatElapsedDescription(progress.hookStartedAtMs ?? progress.phaseStartedAtMs);
}

function getMenuActionDisabledReason({
  item,
  gitStatus,
  isBusy,
  hasPrimaryRemote,
}: {
  item: GitActionMenuItem;
  gitStatus: VcsStatusResult | null;
  isBusy: boolean;
  hasPrimaryRemote: boolean;
}): string | null {
  if (!item.disabled) return null;
  if (isBusy) return "Git action in progress.";
  if (!gitStatus) return "Git status is unavailable.";

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const terminology = getSourceControlPresentation(gitStatus.sourceControlProvider).terminology;

  if (item.id === "commit") {
    if (!hasChanges) {
      return "Worktree is clean. Make changes before committing.";
    }
    return "Commit is currently unavailable.";
  }

  if (item.id === "push") {
    if (!hasBranch) {
      return "Detached HEAD: check out a branch before pushing.";
    }
    if (hasChanges) {
      return "Commit or stash local changes before pushing.";
    }
    if (isBehind) {
      return "Branch is behind upstream. Pull/rebase before pushing.";
    }
    if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
      return 'Add an "origin" remote before pushing.';
    }
    if (!isAhead) {
      return "No local commits to push.";
    }
    return "Push is currently unavailable.";
  }

  if (hasOpenPr) {
    return `View ${terminology.singular} is currently unavailable.`;
  }
  if (!hasBranch) {
    return `Detached HEAD: check out a branch before creating a ${terminology.singular}.`;
  }
  if (hasChanges) {
    return `Commit local changes before creating a ${terminology.singular}.`;
  }
  if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
    return `Add an "origin" remote before creating a ${terminology.singular}.`;
  }
  if (!isAhead) {
    return `No local commits to include in a ${terminology.singular}.`;
  }
  if (isBehind) {
    return `Branch is behind upstream. Pull/rebase before creating a ${terminology.singular}.`;
  }
  return `Create ${terminology.singular} is currently unavailable.`;
}

const COMMIT_DIALOG_TITLE = "Commit changes";
const COMMIT_DIALOG_DESCRIPTION =
  "Review and confirm your commit. Leave the message blank to auto-generate one.";

function GitActionItemIcon({
  icon,
  SourceControlIcon,
}: {
  icon: GitActionIconName;
  SourceControlIcon: ReturnType<typeof getSourceControlPresentation>["Icon"];
}) {
  if (icon === "commit") return <GitCommitIcon />;
  if (icon === "push") return <CloudUploadIcon />;
  return <SourceControlIcon />;
}

function GitQuickActionIcon({
  quickAction,
  SourceControlIcon,
  className = "size-3.5",
}: {
  quickAction: GitQuickAction;
  className?: string;
  SourceControlIcon: ReturnType<typeof getSourceControlPresentation>["Icon"];
}) {
  if (quickAction.kind === "open_pr") return <SourceControlIcon className={className} />;
  if (quickAction.kind === "open_publish") return <CloudUploadIcon className={className} />;
  if (quickAction.kind === "run_pull") return <CloudDownloadIcon className={className} />;
  if (quickAction.kind === "run_action") {
    if (quickAction.action === "commit") return <GitCommitIcon className={className} />;
    if (quickAction.action === "push" || quickAction.action === "commit_push") {
      return <CloudUploadIcon className={className} />;
    }
    return <SourceControlIcon className={className} />;
  }
  if (quickAction.label === "Commit") return <GitCommitIcon className={className} />;
  if (quickAction.label === "Push") return <CloudUploadIcon className={className} />;
  return <InfoIcon className={className} />;
}

interface PublishRepositoryDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: ScopedThreadRef["environmentId"] | null;
  /** Thread the dialog was opened from, so the new repository can open beside it. */
  readonly threadRef: ScopedThreadRef | null;
  readonly gitCwd: string;
  readonly recoveries: ReadonlyArray<SourceControlPublishPendingResult>;
  readonly recoveryReadable: boolean;
  readonly recoverySaveError: string | null;
  readonly onResult: (result: SourceControlPublishRepositoryResult) => void;
  readonly canCreate: () => boolean;
}

function PublishRepositoryDialog(props: PublishRepositoryDialogProps) {
  const openLink = useOpenLink(props.threadRef);
  const navigate = useNavigate();
  const sourceControlDiscovery = useEnvironmentQuery(
    props.environmentId === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId: props.environmentId,
          input: {},
        }),
  );
  const [selectedPublishProvider, setSelectedPublishProvider] =
    useState<PublishProviderKind | null>(null);
  const [publishRepositoryOverride, setPublishRepositoryOverride] = useState<string | null>(null);
  const [publishVisibility, setPublishVisibility] =
    useState<SourceControlRepositoryVisibility>("private");
  const [publishRemoteName, setPublishRemoteName] = useState("origin");
  const [publishProtocolOverride, setPublishProtocol] = useState<SourceControlCloneProtocol | null>(
    null,
  );
  const [requestedWizardStep, setPublishWizardStep] = useState(0);
  const [publishAdvancedOpen, setPublishAdvancedOpen] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [lastPublishResult, setPublishResult] =
    useState<SourceControlPublishRepositoryResult | null>(null);
  const publishResult = lastPublishResult ?? props.recoveries[0] ?? null;
  const publishRecovery = publishResult && "resume" in publishResult ? publishResult : null;
  const publishWizardStep = publishResult ? 2 : requestedWizardStep;
  const sourceControlScope = useMemo(
    () => ({
      environmentId: props.environmentId,
      cwd: props.gitCwd,
    }),
    [props.environmentId, props.gitCwd],
  );
  const publishRepositoryAction = useSourceControlPublishRepositoryAction(sourceControlScope);
  const publishAccountByProvider = useMemo(() => {
    const accounts: Record<PublishProviderKind, string | null> = {
      github: null,
      gitlab: null,
      forgejo: null,
      bitbucket: null,
      "azure-devops": null,
    };
    for (const provider of sourceControlDiscovery.data?.sourceControlProviders ?? []) {
      if (isPublishProviderKind(provider.kind)) {
        accounts[provider.kind] = Option.getOrNull(provider.auth.account);
      }
    }
    return accounts;
  }, [sourceControlDiscovery.data]);
  const publishProviderReadiness = useMemo(() => {
    const sourceControlProviders = sourceControlDiscovery.data?.sourceControlProviders ?? [];
    return Object.fromEntries(
      PUBLISH_PROVIDER_OPTIONS.map((option) => [
        option.value,
        getPublishProviderReadiness({
          provider: option.value,
          sourceControlProviders,
        }),
      ]),
    ) as Record<PublishProviderKind, { readonly ready: boolean; readonly hint: string | null }>;
  }, [sourceControlDiscovery.data]);
  const hasReadyPublishProvider = useMemo(
    () => PUBLISH_PROVIDER_OPTIONS.some((option) => publishProviderReadiness[option.value].ready),
    [publishProviderReadiness],
  );
  const sortedPublishProviderOptions = useMemo(
    () =>
      PUBLISH_PROVIDER_OPTIONS.toSorted((left, right) => {
        const leftReady = publishProviderReadiness[left.value].ready;
        const rightReady = publishProviderReadiness[right.value].ready;
        if (leftReady !== rightReady) {
          return leftReady ? -1 : 1;
        }
        return left.label.localeCompare(right.label);
      }),
    [publishProviderReadiness],
  );
  const firstReadyPublishProvider = sortedPublishProviderOptions.find(
    (option) => publishProviderReadiness[option.value].ready,
  )?.value;
  const publishProvider =
    publishResult && isPublishProviderKind(publishResult.repository.provider)
      ? publishResult.repository.provider
      : selectedPublishProvider !== null && publishProviderReadiness[selectedPublishProvider].ready
        ? selectedPublishProvider
        : (firstReadyPublishProvider ?? selectedPublishProvider ?? "github");
  const publishProtocol =
    publishProtocolOverride ??
    (publishProvider === "github" || publishProvider === "forgejo" ? "https" : "ssh");
  const selectedPublishProviderReadiness = publishProviderReadiness[publishProvider];
  const publishRepositoryPrefill = publishAccountByProvider[publishProvider]
    ? `${publishAccountByProvider[publishProvider]}/`
    : "";
  const publishRepository = publishRepositoryOverride ?? publishRepositoryPrefill;
  const currentPublishProvider = publishProviderOption(publishProvider);
  const publishHost =
    publishProvider === "forgejo"
      ? (Option.getOrNull(
          sourceControlDiscovery.data?.sourceControlProviders.find(
            (provider) => provider.kind === "forgejo",
          )?.auth.host ?? Option.none(),
        ) ?? currentPublishProvider.host)
      : currentPublishProvider.host;
  const publishPathPlaceholder = currentPublishProvider.pathPlaceholder;
  const publishProviderLabel = currentPublishProvider.label;
  const publishWizardSteps = ["Provider", "Repository", "Summary"] as const;
  const publishWizardStepSummaries = [
    publishProviderLabel,
    publishResult?.repository.nameWithOwner ?? null,
    null,
  ] as const;

  const canSubmitPublishRepository = useMemo(() => {
    if (publishRecovery) return props.environmentId !== null && !publishRepositoryAction.isPending;
    if (!props.recoveryReadable || props.recoverySaveError !== null) return false;
    if (!selectedPublishProviderReadiness.ready) return false;
    if (publishRepositoryAction.isPending) return false;
    const repositoryParts = publishRepository.trim().split("/");
    const owner = repositoryParts[0]?.trim() ?? "";
    const rest = repositoryParts.slice(1);
    const name = rest.join("/").trim();
    return owner.length > 0 && name.length > 0;
  }, [
    props.environmentId,
    props.recoveryReadable,
    props.recoverySaveError,
    publishRecovery,
    publishRepository,
    publishRepositoryAction.isPending,
    selectedPublishProviderReadiness,
  ]);

  const submitPublishRepository = useCallback(() => {
    if (!canSubmitPublishRepository) {
      return;
    }
    if (!publishRecovery && !props.canCreate()) return;

    setPublishError(null);

    void (async () => {
      const result = await publishRepositoryAction.run({
        provider: publishProvider,
        repository: publishRecovery?.repository.nameWithOwner ?? publishRepository.trim(),
        visibility: publishVisibility,
        remoteName: publishRemoteName.trim() || "origin",
        protocol: publishProtocol,
        ...(publishRecovery ? { resume: publishRecovery.resume } : {}),
      });

      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          setPublishError(error instanceof Error ? error.message : "An error occurred.");
        }
        return;
      }

      flushSync(() => {
        props.onResult(result.value);
        setPublishResult(result.value);
        setPublishWizardStep(2);
      });
    })();
  }, [
    canSubmitPublishRepository,
    props.environmentId,
    props.gitCwd,
    props.onResult,
    props.canCreate,
    publishRecovery,
    publishProtocol,
    publishProvider,
    publishRemoteName,
    publishRepository,
    publishRepositoryAction,
    publishVisibility,
  ]);

  const resetState = useCallback(() => {
    setPublishRemoteName("origin");
    setPublishRepositoryOverride(null);
    setPublishWizardStep(0);
    setPublishAdvancedOpen(false);
    setPublishError(null);
    setPublishResult(null);
  }, []);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      props.onOpenChange(open);
      if (!open) {
        resetState();
      }
    },
    [props, resetState],
  );

  const openSourceControlSettings = useCallback(() => {
    if (props.environmentId === null) return;
    handleOpenChange(false);
    void navigate({ to: "/settings/source-control", search: { machine: props.environmentId } });
  }, [handleOpenChange, navigate, props.environmentId]);

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <WizardPopup>
        <WizardHeader
          title="Publish repository"
          description="Pick where to host it, then point us at a repo to push to."
        >
          <WizardSteps
            steps={publishWizardSteps}
            currentStep={publishWizardStep}
            summaries={publishWizardStepSummaries}
            showSummaries
            isStepDisabled={(index) =>
              publishWizardStep === 2 ||
              index >= publishWizardSteps.length - 1 ||
              index > publishWizardStep
            }
            onStepChange={setPublishWizardStep}
          />
        </WizardHeader>

        <WizardPanel>
          {props.recoverySaveError ? (
            <p role="alert" className="mb-3 text-xs text-warning">
              {props.recoverySaveError}
            </p>
          ) : null}
          {props.recoveries.length > 1 || (!publishRecovery && props.recoveries.length > 0) ? (
            <div className="mb-3 flex flex-wrap gap-2">
              {props.recoveries.map((recovery) => (
                <Button
                  key={`${recovery.repository.url}:${recovery.remoteName}`}
                  variant="outline"
                  size="sm"
                  disabled={publishRepositoryAction.isPending}
                  onClick={() => {
                    setPublishResult(recovery);
                    setPublishError(null);
                  }}
                >
                  Finish {recovery.repository.nameWithOwner}
                </Button>
              ))}
            </div>
          ) : null}
          <div className={cn("space-y-2", publishWizardStep !== 0 && "hidden")}>
            <span id="publish-provider-cards-label" className="text-xs font-medium text-foreground">
              Provider
            </span>
            <RadioGroup
              value={publishProvider}
              onValueChange={(value) => {
                setSelectedPublishProvider(value as PublishProviderKind);
                setPublishRepositoryOverride(null);
              }}
              aria-labelledby="publish-provider-cards-label"
              className="grid grid-cols-2"
            >
              {sortedPublishProviderOptions.map((option) => {
                const readiness = publishProviderReadiness[option.value];
                const isSelected = publishProvider === option.value && readiness.ready;
                if (!readiness.ready) {
                  return (
                    <div
                      key={option.value}
                      className="relative flex cursor-not-allowed items-center gap-3 rounded-lg border border-border bg-background px-3 py-3 text-left opacity-64 dark:border-transparent dark:bg-white/[0.035]"
                    >
                      <option.Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                        {option.label}
                      </span>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="warning-outline"
                              size="micro"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                openSourceControlSettings();
                              }}
                            >
                              Setup Required
                            </Button>
                          }
                        />
                        <TooltipPopup side="top" align="end">
                          {readiness.hint ??
                            "Open Settings -> Source Control to configure this provider."}
                        </TooltipPopup>
                      </Tooltip>
                    </div>
                  );
                }

                return (
                  <RadioPrimitive.Root
                    key={option.value}
                    value={option.value}
                    className={cn(
                      "relative flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 text-left outline-none transition-[background-color,border-color,box-shadow]",
                      "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                      isSelected
                        ? "border-primary bg-background shadow-sm ring-2 ring-primary/35 dark:border-transparent dark:bg-primary/10 dark:shadow-none dark:ring-1 dark:ring-primary/30"
                        : "border-border bg-background hover:border-foreground/20 hover:bg-muted/50 dark:border-transparent dark:bg-white/[0.035] dark:hover:bg-accent",
                    )}
                  >
                    <option.Icon className="size-5 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {option.label}
                    </span>
                  </RadioPrimitive.Root>
                );
              })}
            </RadioGroup>
          </div>

          <div className={cn("space-y-5", publishWizardStep !== 1 && "hidden")}>
            <div className="space-y-2">
              <label
                htmlFor="publish-repository-path"
                className="text-xs font-medium text-foreground"
              >
                Repository
              </label>
              <div className="flex items-stretch overflow-hidden rounded-md border border-input bg-background focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-ring">
                <span className="flex shrink-0 items-center gap-1.5 border-r border-input bg-muted/50 px-2.5 font-mono text-xs text-muted-foreground">
                  <currentPublishProvider.Icon className="size-3.5" />
                  {publishHost}/
                </span>
                <input
                  id="publish-repository-path"
                  name="publish-repository-path"
                  value={publishRepository}
                  onChange={(event) => {
                    setPublishRepositoryOverride(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      submitPublishRepository();
                    }
                  }}
                  placeholder={publishPathPlaceholder}
                  disabled={publishRepositoryAction.isPending}
                  className="w-full bg-transparent px-3 py-2 font-mono text-sm placeholder:text-muted-foreground/60 focus:outline-none"
                />
              </div>
            </div>

            <div className="space-y-2">
              <span
                id="publish-visibility-cards-label"
                className="text-xs font-medium text-foreground"
              >
                Visibility
              </span>
              <RadioGroup
                value={publishVisibility}
                onValueChange={(value) =>
                  setPublishVisibility(value as SourceControlRepositoryVisibility)
                }
                aria-labelledby="publish-visibility-cards-label"
                disabled={publishRepositoryAction.isPending}
                className="grid grid-cols-2"
              >
                {[
                  {
                    value: "private" as const,
                    label: "Private",
                    description: "Only invited people",
                    Icon: LockIcon,
                  },
                  {
                    value: "public" as const,
                    label: "Public",
                    description: "Anyone on the web",
                    Icon: GlobeIcon,
                  },
                ].map((option) => {
                  const isSelected = publishVisibility === option.value;
                  return (
                    <RadioPrimitive.Root
                      key={option.value}
                      value={option.value}
                      className={cn(
                        "relative flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]",
                        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                        isSelected
                          ? "border-primary bg-background shadow-sm ring-2 ring-primary/35 dark:border-transparent dark:bg-primary/10 dark:shadow-none dark:ring-1 dark:ring-primary/30"
                          : "border-border bg-background hover:border-foreground/20 hover:bg-muted/50 dark:border-transparent dark:bg-white/[0.035] dark:hover:bg-accent",
                      )}
                    >
                      <option.Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-foreground">
                          {option.label}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      </span>
                    </RadioPrimitive.Root>
                  );
                })}
              </RadioGroup>
            </div>

            <div>
              <button
                type="button"
                onClick={() => setPublishAdvancedOpen((prev) => !prev)}
                aria-expanded={publishAdvancedOpen}
                className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronDownIcon
                  className={cn(
                    "size-3.5 transition-transform",
                    publishAdvancedOpen ? "" : "-rotate-90",
                  )}
                />
                Advanced
              </button>
              {publishAdvancedOpen ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1.5" htmlFor="publish-remote-name">
                    <span className="text-xs font-medium text-foreground">Remote</span>
                    <Input
                      id="publish-remote-name"
                      value={publishRemoteName}
                      onChange={(event) => setPublishRemoteName(event.target.value)}
                      placeholder="origin"
                      disabled={publishRepositoryAction.isPending}
                    />
                  </label>
                  <div className="space-y-1.5">
                    <span
                      id="publish-protocol-label"
                      className="text-xs font-medium text-foreground"
                    >
                      Protocol
                    </span>
                    <ToggleGroup
                      value={[publishProtocol]}
                      onValueChange={(next) => {
                        const protocol = next[0];
                        if (protocol === "ssh" || protocol === "https") {
                          setPublishProtocol(protocol);
                        }
                      }}
                      aria-labelledby="publish-protocol-label"
                      disabled={publishRepositoryAction.isPending}
                    >
                      <Toggle value="ssh">SSH</Toggle>
                      <Toggle value="https">HTTPS</Toggle>
                    </ToggleGroup>
                  </div>
                </div>
              ) : null}
            </div>

            {publishRepositoryAction.isPending ? (
              <div
                role="status"
                aria-live="polite"
                className="flex items-center gap-2 rounded-md border border-input bg-muted/40 px-3 py-2 text-xs text-muted-foreground dark:border-transparent dark:bg-white/[0.035]"
              >
                <Spinner size="sm" aria-hidden />
                Publishing repository to {publishProviderLabel}...
              </div>
            ) : null}
            {publishError && !publishRepositoryAction.isPending ? (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                <p className="font-medium">Publish failed</p>
                <p className="mt-0.5 text-destructive/90">{publishError}</p>
              </div>
            ) : null}
          </div>

          <div className={cn("space-y-4", publishWizardStep !== 2 && "hidden")}>
            {publishResult ? (
              <>
                <div className="flex flex-col items-center gap-2 py-1 text-center">
                  <span
                    className={cn(
                      "grid size-8 place-items-center rounded-full",
                      publishRecovery ? "bg-warning/15 text-warning" : "bg-success/15 text-success",
                    )}
                  >
                    {publishRecovery ? (
                      <InfoIcon className="size-4" aria-hidden />
                    ) : (
                      <CheckIcon className="size-4" aria-hidden />
                    )}
                  </span>
                  <h3 className="text-sm font-semibold text-foreground">
                    {publishResult.status === "pushed"
                      ? "Repository published"
                      : "Repository created"}
                  </h3>
                  <p className="max-w-xs text-pretty text-xs text-muted-foreground">
                    {publishResult.status === "pushed"
                      ? `${publishResult.branch} is now live on ${publishProviderLabel}.`
                      : publishResult.status === "remote_added"
                        ? `Remote "${publishResult.remoteName}" is set up. Make a commit and push it to share your code.`
                        : publishRecovery?.detail}
                  </p>
                </div>
                {publishRecovery ? (
                  <div className="space-y-1 text-xs text-muted-foreground">
                    <p>Finish in this checkout. The existing repository will be reused.</p>
                    <p className="break-all font-mono">{publishRecovery.resume.cwd}</p>
                    <p className="break-all font-mono">
                      {publishRecovery.remoteName}: {publishRecovery.remoteUrl}
                    </p>
                  </div>
                ) : null}
                {publishError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {publishError}
                  </p>
                ) : null}
                <div className="flex items-center gap-2 rounded-lg border border-input bg-muted/40 px-3 py-2 dark:border-transparent dark:bg-white/[0.035]">
                  <currentPublishProvider.Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                    {publishResult.repository.nameWithOwner}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => {
                    void openLink(publishResult.repository.url).catch(() => undefined);
                  }}
                >
                  Open on {publishProviderLabel}
                </Button>
              </>
            ) : (
              <div className="rounded-md border border-input bg-background px-3 py-2 text-xs text-muted-foreground dark:border-transparent dark:bg-white/[0.035]">
                Publish result unavailable.
              </div>
            )}
          </div>
        </WizardPanel>

        <WizardFooter>
          {publishWizardStep === 2 ? (
            <>
              <Button
                variant={publishRecovery ? "outline" : "default"}
                disabled={publishRepositoryAction.isPending}
                onClick={() => handleOpenChange(false)}
              >
                {publishRecovery ? "Close" : "Done"}
              </Button>
              {publishRecovery ? (
                <Button disabled={!canSubmitPublishRepository} onClick={submitPublishRepository}>
                  {publishRepositoryAction.isPending ? (
                    <>
                      <Spinner size="sm" aria-hidden /> Finishing...
                    </>
                  ) : publishRecovery.status === "remote_pending" ? (
                    "Retry connection"
                  ) : (
                    "Retry push"
                  )}
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={publishRepositoryAction.isPending}
                onClick={() => {
                  if (publishWizardStep === 0) {
                    handleOpenChange(false);
                    return;
                  }
                  setPublishWizardStep((step) => Math.max(0, step - 1));
                }}
              >
                {publishWizardStep === 0 ? "Cancel" : "Back"}
              </Button>
              {publishWizardStep < 1 ? (
                <Button
                  disabled={!hasReadyPublishProvider || !selectedPublishProviderReadiness.ready}
                  onClick={() => setPublishWizardStep((step) => Math.min(1, step + 1))}
                >
                  Next
                </Button>
              ) : (
                <Button disabled={!canSubmitPublishRepository} onClick={submitPublishRepository}>
                  {publishRepositoryAction.isPending ? (
                    <>
                      <Spinner size="sm" aria-hidden />
                      Publishing...
                    </>
                  ) : (
                    "Publish"
                  )}
                </Button>
              )}
            </>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}

export default function GitActionsControl({
  presentation = "toolbar",
  environmentId,
  gitCwd,
  activeThreadRef,
  draftId,
  onOpenPullRequest,
}: GitActionsControlProps) {
  const updateThreadMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "thread branch metadata update",
  );
  const activeEnvironmentId = activeThreadRef?.environmentId ?? environmentId ?? null;
  const publishRecoveryKey = `t3code:publish-recovery:v1:${JSON.stringify([activeEnvironmentId, gitCwd])}`;
  const publishRecovery = usePublishRepositoryRecovery({
    environmentId: activeEnvironmentId,
    cwd: gitCwd ?? "",
  });
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(activeEnvironmentId));
  const requiresManualCommitMessage =
    serverConfig !== null &&
    !serverConfig.providers.some(
      (provider) =>
        provider.enabled &&
        isProviderAvailable(provider) &&
        provider.supportsTextGeneration !== false,
    );
  const openInPreferredEditor = useOpenInPreferredEditor(
    activeEnvironmentId,
    serverConfig?.availableEditors ?? [],
  );
  const threadToastData = useMemo(
    () => (activeThreadRef ? { threadRef: activeThreadRef } : undefined),
    [activeThreadRef],
  );
  const openPrLink = useOpenPrLink(activeThreadRef ?? undefined);
  const openLink = useOpenLink(activeThreadRef);
  const activeDraftThread = useComposerDraftStore((store) =>
    draftId
      ? store.getDraftSession(draftId)
      : activeThreadRef
        ? store.getDraftThreadByRef(activeThreadRef)
        : null,
  );
  const activeServerThread = useThreadShell(activeThreadRef);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const [commitMessageDrafts, setCommitMessageDrafts] = useState<CommitMessageDrafts>({});
  const commitDraftScopeKey = JSON.stringify([activeEnvironmentId, gitCwd]);
  const dialogCommitMessage = commitMessageDrafts[commitDraftScopeKey] ?? "";
  const isCommitMessageMissing = requiresManualCommitMessage && !dialogCommitMessage.trim();
  const setDialogCommitMessage = (message: string) =>
    setCommitMessageDrafts((current) => ({ ...current, [commitDraftScopeKey]: message }));
  const [isManualPrDialogOpen, setIsManualPrDialogOpen] = useState(false);
  const [manualPrTitle, setManualPrTitle] = useState("");
  const [manualPrBody, setManualPrBody] = useState("");
  const [manualPrDraft, setManualPrDraft] = useState(true);
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set());
  const [isEditingFiles, setIsEditingFiles] = useState(false);
  const [isPublishDialogOpen, setIsPublishDialogOpen] = useState(false);
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<PendingDefaultBranchAction | null>(null);
  const activeGitActionProgressRef = useRef<ActiveGitActionProgress | null>(null);
  const sourceControlScope = useMemo(
    () => ({ environmentId: activeEnvironmentId, cwd: gitCwd }),
    [activeEnvironmentId, gitCwd],
  );
  const actionOwner = JSON.stringify([
    activeEnvironmentId,
    gitCwd,
    activeThreadRef?.threadId ?? null,
    draftId ?? null,
  ]);
  const authorSetupEnabled = serverConfig?.environment.capabilities.gitIdentity === true;
  const authorSetup = useGitAuthorSetup({
    environmentId: activeEnvironmentId,
    cwd: gitCwd,
    serverLabel: serverConfig?.environment.label ?? "Selected server",
    enabled: authorSetupEnabled,
    contextKey: actionOwner,
    onActionError: (cause) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Action failed",
          description: cause instanceof Error ? cause.message : "An error occurred.",
          ...(threadToastData !== undefined ? { data: threadToastData } : {}),
        }),
      );
    },
  });
  let runGitActionWithToast: (input: RunGitActionWithToastInput) => Promise<void>;

  const updateActiveProgressToast = useCallback(() => {
    const progress = activeGitActionProgressRef.current;
    if (!progress) {
      return;
    }
    toastManager.update(progress.toastId, {
      type: "loading",
      title: progress.title,
      description: resolveProgressDescription(progress),
      timeout: 0,
      data: progress.toastData,
    });
  }, []);

  const persistThreadBranchSync = useCallback(
    (branch: string | null, manualSelection = false) => {
      if (!activeThreadRef) {
        return;
      }

      if (activeServerThread) {
        if (activeServerThread.branch === branch) {
          return;
        }

        void updateThreadMetadata({
          environmentId: activeThreadRef.environmentId,
          input: {
            threadId: activeThreadRef.threadId,
            ...resolveThreadBranchMetadataPatch(branch, activeServerThread.branch),
          },
        });

        return;
      }

      if (!activeDraftThread || activeDraftThread.branch === branch) {
        return;
      }

      setDraftThreadContext(draftId ?? activeThreadRef, {
        branch,
        worktreePath: activeDraftThread.worktreePath,
        environmentSelection: manualSelection
          ? "manual"
          : (activeDraftThread.environmentSelection ??
            (activeDraftThread.branch ? "manual" : "auto")),
      });
    },
    [
      activeDraftThread,
      activeServerThread,
      activeThreadRef,
      draftId,
      setDraftThreadContext,
      updateThreadMetadata,
    ],
  );

  const syncThreadBranchAfterGitAction = useCallback(
    (result: GitRunStackedActionResult) => {
      const branchUpdate = resolveThreadBranchUpdate(result);
      if (!branchUpdate) {
        return;
      }

      persistThreadBranchSync(branchUpdate.branch, true);
    },
    [persistThreadBranchSync],
  );

  const gitStatusQuery = useEnvironmentQuery(
    activeEnvironmentId !== null && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: activeEnvironmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const { data: gitStatus, error: gitStatusError } = gitStatusQuery;
  const sourceControlPresentation = useMemo(
    () => getSourceControlPresentation(gitStatus?.sourceControlProvider),
    [gitStatus?.sourceControlProvider],
  );
  const changeRequestTerminology = sourceControlPresentation.terminology;
  const SourceControlIcon = sourceControlPresentation.Icon;
  // Default to true while loading so we don't flash init controls.
  const isRepo = gitStatus?.isRepo ?? true;
  const hasPrimaryRemote = gitStatus?.hasPrimaryRemote ?? false;
  const gitStatusForActions = gitStatus;
  const manualPrBlocker = manualPrSubmissionBlocker(gitStatusForActions);

  const allFiles = gitStatusForActions?.workingTree.files ?? [];
  const selectedFiles = allFiles.filter((f) => !excludedFiles.has(f.path));
  const allSelected = excludedFiles.size === 0;
  const noneSelected = selectedFiles.length === 0;

  const initAction = useVcsInitAction(sourceControlScope);
  const runImmediateGitAction = useGitStackedAction(sourceControlScope);
  const pullAction = useVcsPullAction(sourceControlScope);
  const isSourceControlRunning = useSourceControlActionRunning(
    sourceControlScope,
    RUNNING_SOURCE_CONTROL_ACTIONS,
  );
  const isGitActionRunning = isSourceControlRunning || authorSetup.pending;
  const isSelectingWorktreeBase =
    !activeServerThread &&
    activeDraftThread?.envMode === "worktree" &&
    activeDraftThread.worktreePath === null;

  useEffect(() => {
    if (isGitActionRunning || isSelectingWorktreeBase || activeServerThread) {
      return;
    }

    const branchUpdate = resolveLiveThreadBranchUpdate({
      threadBranch: activeDraftThread?.branch ?? null,
      gitStatus: gitStatusForActions,
    });
    if (!branchUpdate) {
      return;
    }

    persistThreadBranchSync(branchUpdate.branch);
  }, [
    activeServerThread,
    activeDraftThread?.branch,
    gitStatusForActions,
    isGitActionRunning,
    isSelectingWorktreeBase,
    persistThreadBranchSync,
  ]);

  const isDefaultRef = useMemo(() => {
    return gitStatusForActions?.isDefaultRef ?? false;
  }, [gitStatusForActions?.isDefaultRef]);

  const gitActionMenuItems = useMemo(
    () => buildMenuItems(gitStatusForActions, isGitActionRunning, hasPrimaryRemote),
    [gitStatusForActions, hasPrimaryRemote, isGitActionRunning],
  );
  const quickAction = useMemo(
    () =>
      resolveQuickAction(gitStatusForActions, isGitActionRunning, isDefaultRef, hasPrimaryRemote),
    [gitStatusForActions, hasPrimaryRemote, isDefaultRef, isGitActionRunning],
  );
  const quickActionDisabledReason = quickAction.disabled
    ? (quickAction.hint ?? "This action is currently unavailable.")
    : null;
  const generatedDraftAction = resolveGeneratedDraftAction(gitStatusForActions, isGitActionRunning);
  const pendingDefaultBranchActionCopy = pendingDefaultBranchAction
    ? resolveDefaultBranchActionDialogCopy({
        action: pendingDefaultBranchAction.action,
        branchName: pendingDefaultBranchAction.branchName,
        includesCommit: pendingDefaultBranchAction.includesCommit,
        terminology: changeRequestTerminology,
      })
    : null;
  const canContinuePendingOnFeatureBranch =
    pendingDefaultBranchAction !== null &&
    canContinueOnFeatureBranch(
      pendingDefaultBranchAction.action,
      pendingDefaultBranchAction.includesCommit,
    );

  useEffect(() => {
    if (
      pendingDefaultBranchAction &&
      !isGitActionIntentCurrent(pendingDefaultBranchAction, actionOwner, gitStatusForActions)
    ) {
      setPendingDefaultBranchAction(null);
      toastManager.add({
        type: "info",
        title: "Repository changed",
        description: "Review the selected checkout and branch, then choose the Git action again.",
      });
    }
  }, [pendingDefaultBranchAction, actionOwner, gitStatusForActions]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!activeGitActionProgressRef.current) {
        return;
      }
      updateActiveProgressToast();
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [updateActiveProgressToast]);

  useEffect(() => {
    if (gitCwd === null) {
      return;
    }

    let refreshTimeout: number | null = null;
    const scheduleRefreshCurrentGitStatus = () => {
      if (refreshTimeout !== null) {
        window.clearTimeout(refreshTimeout);
      }
      refreshTimeout = window.setTimeout(() => {
        refreshTimeout = null;
        requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
      }, GIT_STATUS_WINDOW_REFRESH_DEBOUNCE_MS);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleRefreshCurrentGitStatus();
      }
    };

    window.addEventListener("focus", scheduleRefreshCurrentGitStatus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (refreshTimeout !== null) {
        window.clearTimeout(refreshTimeout);
      }
      window.removeEventListener("focus", scheduleRefreshCurrentGitStatus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeEnvironmentId, gitCwd, refreshVcsStatus]);

  const openExistingPr = useCallback(async () => {
    const openPr = gitStatusForActions?.pr?.state === "open" ? gitStatusForActions.pr : null;
    // Beside the thread where it was made, the way the browser opens beside it. Checked before
    // the shell, which opening in the app does not need.
    if (openPr && onOpenPullRequest) {
      onOpenPullRequest(openPr.number);
      return;
    }
    const prUrl = openPr?.url ?? null;
    if (!prUrl) {
      toastManager.add({
        type: "error",
        title: "No open pull request found.",
        data: threadToastData,
      });
      return;
    }
    void openLink(prUrl).catch((err: unknown) => {
      console.error(err);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open pull request link",
          description: err instanceof Error ? err.message : "An error occurred.",
          ...(threadToastData !== undefined ? { data: threadToastData } : {}),
        }),
      );
    });
  }, [gitStatusForActions, onOpenPullRequest, openLink, threadToastData]);

  runGitActionWithToast = useEffectEvent(
    async ({
      action,
      commitMessage,
      pullRequest,
      onConfirmed,
      skipDefaultBranchPrompt = false,
      statusOverride,
      featureBranch = false,
      progressToastId,
      filePaths,
      authorVerifiedFor,
      intent: capturedIntent,
    }: RunGitActionWithToastInput) => {
      if (authorVerifiedFor !== undefined && authorVerifiedFor !== actionOwner) return;
      const submittedCommitDraftScope = commitDraftScopeKey;
      const actionStatus = statusOverride ?? gitStatusForActions;
      if (
        capturedIntent &&
        !isGitActionIntentCurrent(capturedIntent, actionOwner, gitStatusForActions)
      ) {
        toastManager.add({
          type: "info",
          title: "Review the current repository",
          description:
            "The checkout or branch changed, or its status is unavailable. Choose the Git action again.",
          data: threadToastData,
        });
        return;
      }
      const intent =
        capturedIntent ??
        captureGitActionIntent({
          action,
          owner: actionOwner,
          status: actionStatus,
          featureBranch,
          ...(filePaths ? { filePaths } : {}),
        });
      if (!intent) {
        toastManager.add({
          type: "info",
          title: "No files selected for commit",
          description: "Review the current changes and select files before committing.",
          data: threadToastData,
        });
        return;
      }
      action = intent.action;
      filePaths = intent.filePaths;
      const actionBranch = intent.branchName;
      const actionIsDefaultBranch = featureBranch ? false : isDefaultRef;
      const includesCommit = intent.includesCommit;
      if (
        !skipDefaultBranchPrompt &&
        requiresDefaultBranchConfirmation(action, actionIsDefaultBranch) &&
        actionBranch
      ) {
        if (
          action !== "push" &&
          action !== "create_pr" &&
          action !== "commit_push" &&
          action !== "commit_push_pr"
        ) {
          return;
        }
        setPendingDefaultBranchAction({
          ...intent,
          action,
          branchName: actionBranch,
          includesCommit,
          ...(commitMessage ? { commitMessage } : {}),
          ...(pullRequest ? { pullRequest } : {}),
          ...(onConfirmed ? { onConfirmed } : {}),
          ...(filePaths ? { filePaths } : {}),
        });
        return;
      }
      if (includesCommit && authorSetupEnabled && authorVerifiedFor !== actionOwner) {
        const owner = actionOwner;
        await authorSetup.runAfterAuthor(() =>
          runGitActionWithToast({
            action,
            ...(commitMessage ? { commitMessage } : {}),
            ...(pullRequest ? { pullRequest } : {}),
            ...(onConfirmed ? { onConfirmed } : {}),
            skipDefaultBranchPrompt,
            ...(statusOverride !== undefined ? { statusOverride } : {}),
            featureBranch,
            ...(progressToastId !== undefined ? { progressToastId } : {}),
            ...(filePaths ? { filePaths } : {}),
            authorVerifiedFor: owner,
            intent,
          }),
        );
        return;
      }
      onConfirmed?.();

      const progressStages = buildGitActionProgressStages({
        action,
        hasCustomCommitMessage: !!commitMessage?.trim(),
        hasWorkingTreeChanges: !!actionStatus?.hasWorkingTreeChanges,
        featureBranch,
        terminology: changeRequestTerminology,
        shouldPushBeforePr:
          action === "create_pr" &&
          (!actionStatus?.hasUpstream || (actionStatus?.aheadCount ?? 0) > 0),
      });
      const scopedToastData = threadToastData ? { ...threadToastData } : undefined;
      const submittedThreadRef =
        activeServerThread && activeThreadRef ? { ...activeThreadRef } : null;
      const actionId = randomUUID();
      const resolvedProgressToastId =
        progressToastId ??
        toastManager.add({
          type: "loading",
          title: progressStages[0] ?? "Running git action...",
          description: "Waiting for Git...",
          timeout: 0,
          data: scopedToastData,
        });

      activeGitActionProgressRef.current = {
        toastId: resolvedProgressToastId,
        toastData: scopedToastData,
        actionId,
        title: progressStages[0] ?? "Running git action...",
        phaseStartedAtMs: null,
        hookStartedAtMs: null,
        hookName: null,
        lastOutputLine: null,
        currentPhaseLabel: progressStages[0] ?? "Running git action...",
      };

      if (progressToastId) {
        toastManager.update(progressToastId, {
          type: "loading",
          title: progressStages[0] ?? "Running git action...",
          description: "Waiting for Git...",
          timeout: 0,
          data: scopedToastData,
        });
      }

      const applyProgressEvent = (event: GitActionProgressEvent) => {
        const progress = activeGitActionProgressRef.current;
        if (!progress) {
          return;
        }
        if (gitCwd && event.cwd !== gitCwd) {
          return;
        }
        if (progress.actionId !== event.actionId) {
          return;
        }

        const now = Date.now();
        switch (event.kind) {
          case "action_started":
            progress.phaseStartedAtMs = now;
            progress.hookStartedAtMs = null;
            progress.hookName = null;
            progress.lastOutputLine = null;
            break;
          case "phase_started":
            progress.title = event.label;
            progress.currentPhaseLabel = event.label;
            progress.phaseStartedAtMs = now;
            progress.hookStartedAtMs = null;
            progress.hookName = null;
            progress.lastOutputLine = null;
            break;
          case "hook_started":
            progress.title = `Running ${event.hookName}...`;
            progress.hookName = event.hookName;
            progress.hookStartedAtMs = now;
            progress.lastOutputLine = null;
            break;
          case "hook_output":
            progress.lastOutputLine = event.text;
            break;
          case "hook_finished":
            progress.title = progress.currentPhaseLabel ?? "Committing...";
            progress.hookName = null;
            progress.hookStartedAtMs = null;
            progress.lastOutputLine = null;
            break;
          case "action_finished":
            // Let the resolved mutation update the toast so we keep the
            // elapsed description visible until the final success state renders.
            return;
          case "action_failed":
            // Let the settled mutation publish the error toast to avoid a
            // transient intermediate state before the final failure message.
            return;
        }

        updateActiveProgressToast();
      };

      const result = await runImmediateGitAction.run({
        actionId,
        action,
        ...(intent.branchName !== undefined ? { expectedBranch: intent.branchName } : {}),
        ...(commitMessage ? { commitMessage } : {}),
        ...(pullRequest ? { pullRequest } : {}),
        ...(featureBranch ? { featureBranch } : {}),
        ...(filePaths ? { filePaths } : {}),
        // A pull request the action opens is linked to the thread it ran beside. Drafts
        // have no server thread yet, so there is nothing to link to.
        ...(activeServerThread ? { threadId: activeServerThread.id } : {}),
        onProgress: applyProgressEvent,
      });

      activeGitActionProgressRef.current = null;
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          toastManager.close(resolvedProgressToastId);
          return;
        }

        const error = squashAtomCommandFailure(result);
        toastManager.update(
          resolvedProgressToastId,
          stackedThreadToast({
            type: "error",
            title: "Action failed",
            description: error instanceof Error ? error.message : "An error occurred.",
            ...(scopedToastData !== undefined ? { data: scopedToastData } : {}),
          }),
        );
        return;
      }

      const actionResult = result.value;
      if (commitMessage) {
        setCommitMessageDrafts((current) =>
          clearCommittedMessageDraft(
            current,
            submittedCommitDraftScope,
            commitMessage,
            actionResult.commit.status,
          ),
        );
      }
      syncThreadBranchAfterGitAction(actionResult);
      const closeResultToast = () => {
        toastManager.close(resolvedProgressToastId);
      };

      const toastCta = actionResult.toast.cta;
      let toastActionProps: {
        children: string;
        onClick: (event: MouseEvent<HTMLButtonElement>) => void;
      } | null = null;
      if (toastCta.kind === "run_action") {
        const followupIntent = captureGitActionFollowupIntent(intent, actionResult);
        if (followupIntent) {
          toastActionProps = {
            children: toastCta.label,
            onClick: () => {
              closeResultToast();
              void runGitActionWithToast({
                action: followupIntent.action,
                intent: followupIntent,
              });
            },
          };
        }
      } else if (toastCta.kind === "open_pr") {
        toastActionProps = {
          children: toastCta.label,
          onClick: (event) => {
            closeResultToast();
            openPrLink(event, toastCta.url);
          },
        };
      }

      const prLinkStatus = actionResult.pr.linkStatus;
      if (prLinkStatus === "pending" || prLinkStatus === "not_saved") {
        const prUrl = actionResult.pr.url ?? (toastCta.kind === "open_pr" ? toastCta.url : null);
        showCreatedPullRequestLinkWarning({
          toastId: resolvedProgressToastId,
          status: prLinkStatus,
          threadRef: submittedThreadRef,
          prUrl,
          prNumber: actionResult.pr.number,
          ...(toastCta.kind === "open_pr"
            ? {
                actionProps: {
                  children: toastCta.label,
                  onClick: (event: MouseEvent<HTMLButtonElement>) =>
                    openPrLink(event, toastCta.url, submittedThreadRef ?? undefined),
                },
              }
            : {}),
          ...(scopedToastData !== undefined ? { data: scopedToastData } : {}),
        });
        return;
      }

      const successToastData = {
        ...scopedToastData,
        dismissAfterVisibleMs: 10_000,
      };

      if (toastActionProps) {
        toastManager.update(
          resolvedProgressToastId,
          stackedThreadToast({
            type: "success",
            title: actionResult.toast.title,
            description: actionResult.toast.description,
            timeout: 0,
            actionProps: toastActionProps,
            data: successToastData,
          }),
        );
      } else {
        toastManager.update(resolvedProgressToastId, {
          type: "success",
          title: actionResult.toast.title,
          description: actionResult.toast.description,
          timeout: 0,
          data: successToastData,
        });
      }
    },
  );

  const continuePendingDefaultBranchAction = () => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, pullRequest, onConfirmed, filePaths } =
      pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(pullRequest ? { pullRequest } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      skipDefaultBranchPrompt: true,
      intent: pendingDefaultBranchAction,
    });
  };

  const checkoutFeatureBranchAndContinuePendingAction = () => {
    if (!pendingDefaultBranchAction || !canContinuePendingOnFeatureBranch) return;
    const { action, commitMessage, pullRequest, onConfirmed, filePaths } =
      pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(pullRequest ? { pullRequest } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      featureBranch: true,
      skipDefaultBranchPrompt: true,
      intent: pendingDefaultBranchAction,
    });
  };

  const runDialogActionOnNewBranch = () => {
    if (!isCommitDialogOpen || isCommitMessageMissing) return;
    const commitMessage = dialogCommitMessage.trim();

    setIsCommitDialogOpen(false);
    setExcludedFiles(new Set());
    setIsEditingFiles(false);

    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      filePaths: selectedFiles.map((f) => f.path),
      featureBranch: true,
      skipDefaultBranchPrompt: true,
    });
  };

  const runQuickAction = () => {
    if (quickAction.kind === "open_pr") {
      void openExistingPr();
      return;
    }
    if (quickAction.kind === "open_publish") {
      setIsPublishDialogOpen(true);
      return;
    }
    if (quickAction.kind === "run_pull") {
      const toastId = toastManager.add({
        type: "loading",
        title: "Pulling...",
        timeout: 0,
        data: threadToastData,
      });
      void (async () => {
        const result = await pullAction.run();
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) {
            toastManager.close(toastId);
            return;
          }
          const error = squashAtomCommandFailure(result);
          toastManager.update(
            toastId,
            stackedThreadToast({
              type: "error",
              title: "Pull failed",
              description: error instanceof Error ? error.message : "An error occurred.",
              ...(threadToastData !== undefined ? { data: threadToastData } : {}),
            }),
          );
          return;
        }

        const pullResult = result.value;
        toastManager.update(toastId, {
          type: "success",
          title: pullResult.status === "pulled" ? "Pulled" : "Already up to date",
          description:
            pullResult.status === "pulled"
              ? `Updated ${pullResult.refName} from ${pullResult.upstreamRef ?? "upstream"}`
              : `${pullResult.refName} is already synchronized.`,
          data: threadToastData,
        });
      })();
      return;
    }
    if (quickAction.kind === "show_hint") {
      toastManager.add({
        type: "info",
        title: quickAction.label,
        description: quickAction.hint,
        data: threadToastData,
      });
      return;
    }
    if (quickAction.action === "commit" && requiresManualCommitMessage) {
      setExcludedFiles(new Set());
      setIsEditingFiles(false);
      setIsCommitDialogOpen(true);
      return;
    }
    if (quickAction.action) {
      void runGitActionWithToast({ action: quickAction.action });
    }
  };

  const openDialogForMenuItem = (item: GitActionMenuItem) => {
    if (item.disabled) return;
    if (item.kind === "open_pr") {
      void openExistingPr();
      return;
    }
    if (item.dialogAction === "push") {
      void runGitActionWithToast({ action: "push" });
      return;
    }
    if (item.dialogAction === "create_pr") {
      void runGitActionWithToast({ action: "create_pr" });
      return;
    }
    setExcludedFiles(new Set());
    setIsEditingFiles(false);
    setIsCommitDialogOpen(true);
  };

  const runDialogAction = () => {
    if (!isCommitDialogOpen || isCommitMessageMissing) return;
    const commitMessage = dialogCommitMessage.trim();
    setIsCommitDialogOpen(false);
    setExcludedFiles(new Set());
    setIsEditingFiles(false);
    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      filePaths: selectedFiles.map((f) => f.path),
    });
  };

  const openChangedFileInEditor = useCallback(
    (filePath: string) => {
      if (!gitCwd) {
        toastManager.add({
          type: "error",
          title: "Editor opening is unavailable.",
          data: threadToastData,
        });
        return;
      }
      const target = resolvePathLinkTarget(filePath, gitCwd);
      void (async () => {
        const result = await openInPreferredEditor(target);
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file",
            description: error instanceof Error ? error.message : "An error occurred.",
            ...(threadToastData !== undefined ? { data: threadToastData } : {}),
          }),
        );
      })();
    },
    [gitCwd, openInPreferredEditor, threadToastData],
  );

  const publishEntry = resolvePublishRepositoryEntry({
    environmentId: activeEnvironmentId,
    cwd: gitCwd,
    gitStatus: gitStatusForActions,
    pendingRecoveryCount: publishRecovery.pending.length,
    recoveryReadable: publishRecovery.readable,
  });
  const publishMenuItem = publishEntry ? (
    <MenuItem
      density={presentation === "menu" ? "touch" : "default"}
      disabled={isGitActionRunning}
      onClick={() => setIsPublishDialogOpen(true)}
    >
      <CloudUploadIcon />
      <MenuItemLabel>
        {publishEntry === "resume" ? "Finish publishing..." : "Publish repository..."}
      </MenuItemLabel>
    </MenuItem>
  ) : null;

  const initializeGit = () => {
    void (async () => {
      const result = await initAction.run();
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Git initialization failed",
          description: error instanceof Error ? error.message : "An error occurred.",
          ...(threadToastData !== undefined ? { data: threadToastData } : {}),
        }),
      );
    })();
  };
  const gitItems = (
    <>
      {authorSetupEnabled ? (
        <MenuItem
          density={presentation === "menu" ? "touch" : "default"}
          disabled={isGitActionRunning}
          onClick={() => void authorSetup.open()}
        >
          <GitCommitIcon />
          <MenuItemLabel>Commit author...</MenuItemLabel>
        </MenuItem>
      ) : null}
      {gitActionMenuItems.map((item) => {
        const disabledReason = getMenuActionDisabledReason({
          item,
          gitStatus: gitStatusForActions,
          isBusy: isGitActionRunning,
          hasPrimaryRemote,
        });
        if (item.disabled && disabledReason && presentation === "menu") {
          return (
            <div key={`${item.id}-${item.label}`}>
              <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
                <GitActionItemIcon icon={item.icon} SourceControlIcon={SourceControlIcon} />
                <MenuItemLabel>{item.label}</MenuItemLabel>
              </MenuItem>
              <p className="max-w-64 px-2 pb-2 text-xs text-muted-foreground">{disabledReason}</p>
            </div>
          );
        }
        if (item.disabled && disabledReason) {
          return (
            <Popover key={`${item.id}-${item.label}`}>
              <PopoverTrigger
                openOnHover
                nativeButton={false}
                render={<span className="block w-max cursor-not-allowed" />}
              >
                <MenuItem
                  density={presentation === "menu" ? "touch" : "default"}
                  className="w-full"
                  disabled
                >
                  <GitActionItemIcon icon={item.icon} SourceControlIcon={SourceControlIcon} />
                  <MenuItemLabel>{item.label}</MenuItemLabel>
                </MenuItem>
              </PopoverTrigger>
              <PopoverPopup tooltipStyle side="left" align="center">
                {disabledReason}
              </PopoverPopup>
            </Popover>
          );
        }

        return (
          <MenuItem
            density={presentation === "menu" ? "touch" : "default"}
            key={`${item.id}-${item.label}`}
            disabled={item.disabled}
            onClick={() => {
              openDialogForMenuItem(item);
            }}
          >
            <GitActionItemIcon icon={item.icon} SourceControlIcon={SourceControlIcon} />
            <MenuItemLabel>{item.label}</MenuItemLabel>
          </MenuItem>
        );
      })}
      {generatedDraftAction && (
        <MenuItem
          density={presentation === "menu" ? "touch" : "default"}
          disabled={generatedDraftAction.disabled}
          onClick={() => {
            void runGitActionWithToast({
              action: generatedDraftAction.action,
              pullRequest: { draft: true },
            });
          }}
        >
          <SourceControlIcon className="size-4" />
          <MenuItemLabel>{generatedDraftAction.label}</MenuItemLabel>
        </MenuItem>
      )}
      {hasPrimaryRemote && gitStatusForActions?.refName && (
        <MenuItem
          density={presentation === "menu" ? "touch" : "default"}
          disabled={isGitActionRunning}
          onClick={() => setIsManualPrDialogOpen(true)}
        >
          <SourceControlIcon className="size-4" />
          <MenuItemLabel>Write {changeRequestTerminology.singular}...</MenuItemLabel>
        </MenuItem>
      )}
      {publishMenuItem}
      {gitStatusForActions?.refName === null && (
        <p className="px-2 py-1.5 text-xs text-warning">
          Detached HEAD: create and check out a branch to enable push and pull request actions.
        </p>
      )}
      {gitStatusForActions &&
        gitStatusForActions.refName !== null &&
        !gitStatusForActions.hasWorkingTreeChanges &&
        gitStatusForActions.behindCount > 0 &&
        gitStatusForActions.aheadCount === 0 && (
          <p className="px-2 py-1.5 text-xs text-warning">Behind upstream. Pull/rebase first.</p>
        )}
      {gitStatusError && <p className="px-2 py-1.5 text-xs text-destructive">{gitStatusError}</p>}
    </>
  );

  if (!gitCwd) return null;

  return (
    <>
      {authorSetup.dialog}
      {!isRepo && publishEntry === "resume" ? (
        presentation === "menu" ? (
          publishMenuItem
        ) : (
          <Button
            variant="outline"
            size="xs"
            disabled={isGitActionRunning}
            onClick={() => setIsPublishDialogOpen(true)}
          >
            <CloudUploadIcon className="size-3.5" aria-hidden />
            Finish publishing...
          </Button>
        )
      ) : presentation === "menu" ? (
        !isRepo ? (
          <MenuItem
            density={presentation === "menu" ? "touch" : "default"}

            disabled={initAction.isPending}
            onClick={initializeGit}
          >
            <GitBranchPlusIcon className="size-4" />
            <MenuItemLabel>
              {initAction.isPending ? "Initializing..." : "Initialize Git"}
            </MenuItemLabel>
          </MenuItem>
        ) : (
          <>
            <MenuItem
              density={presentation === "menu" ? "touch" : "default"}

              disabled={isGitActionRunning || quickAction.disabled || !!quickActionDisabledReason}
              onClick={runQuickAction}
            >
              <GitQuickActionIcon
                className="size-4"
                quickAction={quickAction}
                SourceControlIcon={SourceControlIcon}
              />
              <MenuItemLabel>{quickAction.label}</MenuItemLabel>
            </MenuItem>
            {quickActionDisabledReason && (
              <p className="max-w-64 px-2 py-1.5 text-xs text-warning">
                {quickActionDisabledReason}
              </p>
            )}
            <MenuSub
              onOpenChange={(open) => {
                if (open) requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
              }}
            >
              <MenuSubTrigger density="touch" disabled={isGitActionRunning}>
                <SourceControlIcon className="size-4" />
                <MenuItemLabel>Git actions</MenuItemLabel>
              </MenuSubTrigger>
              <MenuSubPopup>{gitItems}</MenuSubPopup>
            </MenuSub>
          </>
        )
      ) : !isRepo ? (
        <Button variant="outline" size="xs" disabled={initAction.isPending} onClick={initializeGit}>
          <GitBranchPlusIcon className="size-3.5" aria-hidden />
          <span className="ml-0.5">
            {initAction.isPending ? "Initializing..." : "Initialize Git"}
          </span>
        </Button>
      ) : (
        <Group aria-label="Git actions" className="shrink-0">
          {quickActionDisabledReason ? (
            <Popover>
              <PopoverTrigger
                openOnHover
                render={<Button aria-disabled="true" size="xs" variant="outline" />}
              >
                <GitQuickActionIcon
                  quickAction={quickAction}
                  SourceControlIcon={SourceControlIcon}
                />
                <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
                  {quickAction.label}
                </span>
              </PopoverTrigger>
              <PopoverPopup tooltipStyle side="bottom" align="start">
                {quickActionDisabledReason}
              </PopoverPopup>
            </Popover>
          ) : (
            <Button
              variant="outline"
              size="xs"
              disabled={isGitActionRunning || quickAction.disabled}
              onClick={runQuickAction}
            >
              <GitQuickActionIcon quickAction={quickAction} SourceControlIcon={SourceControlIcon} />
              <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
                {quickAction.label}
              </span>
            </Button>
          )}
          <GroupSeparator className="hidden @3xl/header-actions:block" />
          <Menu
            onOpenChange={(open) => {
              if (open) {
                requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
              }
            }}
          >
            <MenuTrigger
              render={<Button aria-label="Git action options" size="icon-xs" variant="outline" />}
              disabled={isGitActionRunning}
            >
              <ChevronDownIcon aria-hidden="true" className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">{gitItems}</MenuPopup>
          </Menu>
        </Group>
      )}

      <Dialog
        open={isCommitDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsCommitDialogOpen(false);
            setExcludedFiles(new Set());
            setIsEditingFiles(false);
          }
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{COMMIT_DIALOG_TITLE}</DialogTitle>
            <DialogDescription>
              {requiresManualCommitMessage
                ? "Review your changes and enter a commit message. No writing provider is available."
                : COMMIT_DIALOG_DESCRIPTION}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-3 rounded-xl bg-zinc-25 p-3 text-sm ring-1 ring-black/5 dark:bg-white/[0.035] dark:ring-white/5">
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
                <span className="text-muted-foreground">Branch</span>
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {gitStatusForActions?.refName ?? "(detached HEAD)"}
                  </span>
                  {isDefaultRef && <span className="text-right text-warning">Default branch</span>}
                </span>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {isEditingFiles && allFiles.length > 0 && (
                      <Checkbox
                        checked={allSelected}
                        indeterminate={!allSelected && !noneSelected}
                        onCheckedChange={() => {
                          setExcludedFiles(
                            allSelected ? new Set(allFiles.map((f) => f.path)) : new Set(),
                          );
                        }}
                      />
                    )}
                    <span className="text-muted-foreground">Files</span>
                    {!allSelected && !isEditingFiles && (
                      <span className="text-muted-foreground">
                        ({selectedFiles.length} of {allFiles.length})
                      </span>
                    )}
                  </div>
                  {allFiles.length > 0 && (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setIsEditingFiles((prev) => !prev)}
                    >
                      {isEditingFiles ? "Done" : "Edit"}
                    </Button>
                  )}
                </div>
                {!gitStatusForActions || allFiles.length === 0 ? (
                  <p className="font-medium">none</p>
                ) : (
                  <div className="space-y-2">
                    <div className="h-44 rounded-lg bg-card ring-1 ring-black/5 dark:bg-white/[0.025] dark:ring-white/5">
                      <ScrollArea>
                        <div className="space-y-1 p-1">
                          {allFiles.map((file) => {
                            const isExcluded = excludedFiles.has(file.path);
                            return (
                              <div
                                key={file.path}
                                className="flex w-full items-center gap-2 rounded-md px-2 py-1 font-mono hover:bg-accent/50"
                              >
                                {isEditingFiles && (
                                  <Checkbox
                                    checked={!excludedFiles.has(file.path)}
                                    onCheckedChange={() => {
                                      setExcludedFiles((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(file.path)) {
                                          next.delete(file.path);
                                        } else {
                                          next.add(file.path);
                                        }
                                        return next;
                                      });
                                    }}
                                  />
                                )}
                                <button
                                  type="button"
                                  className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
                                  onClick={() => openChangedFileInEditor(file.path)}
                                >
                                  <StartTruncatedPath
                                    path={file.path}
                                    className={`flex-1${isExcluded ? " text-muted-foreground" : ""}`}
                                  />
                                  <span className="shrink-0">
                                    {isExcluded ? (
                                      <span className="text-muted-foreground">Excluded</span>
                                    ) : (
                                      <>
                                        <span className="text-diff-addition">
                                          +{file.insertions}
                                        </span>
                                        <span className="text-muted-foreground"> / </span>
                                        <span className="text-diff-deletion">
                                          -{file.deletions}
                                        </span>
                                      </>
                                    )}
                                  </span>
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </ScrollArea>
                    </div>
                    <div className="flex justify-end font-mono">
                      <span className="text-diff-addition">
                        +{selectedFiles.reduce((sum, f) => sum + f.insertions, 0)}
                      </span>
                      <span className="text-muted-foreground"> / </span>
                      <span className="text-diff-deletion">
                        -{selectedFiles.reduce((sum, f) => sum + f.deletions, 0)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">
                {requiresManualCommitMessage ? "Commit message" : "Commit message (optional)"}
              </p>
              <Textarea
                value={dialogCommitMessage}
                onChange={(event) => setDialogCommitMessage(event.target.value)}
                placeholder={
                  requiresManualCommitMessage
                    ? "Write a commit message"
                    : "Leave empty to auto-generate"
                }
                required={requiresManualCommitMessage}
                size="sm"
              />
            </div>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setIsCommitDialogOpen(false);
                setExcludedFiles(new Set());
                setIsEditingFiles(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={noneSelected || isCommitMessageMissing}
              onClick={runDialogActionOnNewBranch}
            >
              Commit on new branch
            </Button>
            <Button
              size="sm"
              disabled={noneSelected || isCommitMessageMissing}
              onClick={runDialogAction}
            >
              Commit
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog open={isManualPrDialogOpen} onOpenChange={setIsManualPrDialogOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Write {changeRequestTerminology.singular}</DialogTitle>
            <DialogDescription>
              Use your own title and description. No writing model is called.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {manualPrBlocker && (
              <p role="status" className="text-sm text-warning">
                {manualPrBlocker}
              </p>
            )}
            <label className="grid gap-1 text-sm font-medium">
              Title
              <Input
                value={manualPrTitle}
                maxLength={256}
                onChange={(event) => setManualPrTitle(event.target.value)}
                autoFocus
              />
            </label>
            <label className="grid gap-1 text-sm font-medium">
              Description
              <Textarea
                value={manualPrBody}
                maxLength={65536}
                onChange={(event) => setManualPrBody(event.target.value)}
                rows={8}
              />
            </label>
            {gitStatusForActions?.sourceControlProvider?.kind === "github" && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={manualPrDraft}
                  onCheckedChange={(checked) => setManualPrDraft(checked === true)}
                />
                Create as draft
              </label>
            )}
            <p className="text-sm text-muted-foreground">
              This requires a clean checkout. Committed changes will be pushed if needed.
            </p>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button variant="outline" size="sm" onClick={() => setIsManualPrDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!manualPrTitle.trim() || isGitActionRunning || manualPrBlocker !== null}
              onClick={() => {
                if (manualPrBlocker) return;
                setIsManualPrDialogOpen(false);
                void runGitActionWithToast({
                  action: "create_pr",
                  pullRequest: {
                    title: manualPrTitle.trim(),
                    body: manualPrBody,
                    ...(gitStatusForActions?.sourceControlProvider?.kind === "github"
                      ? { draft: manualPrDraft }
                      : {}),
                  },
                });
              }}
            >
              Create {changeRequestTerminology.singular}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <PublishRepositoryDialog
        key={publishRecoveryKey}
        open={isPublishDialogOpen}
        onOpenChange={setIsPublishDialogOpen}
        environmentId={activeEnvironmentId}
        threadRef={activeThreadRef}
        gitCwd={gitCwd}
        recoveries={publishRecovery.pending}
        recoveryReadable={publishRecovery.readable}
        recoverySaveError={publishRecovery.error}
        onResult={publishRecovery.record}
        canCreate={publishRecovery.canCreate}
      />

      <Dialog
        open={pendingDefaultBranchAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDefaultBranchAction(null);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {pendingDefaultBranchActionCopy?.title ?? "Run action on default branch?"}
            </DialogTitle>
            <DialogDescription>{pendingDefaultBranchActionCopy?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter variant="bare" className="sm:flex-wrap sm:items-center">
            <Button
              className="w-full sm:mr-auto sm:w-auto"
              variant="outline"
              size="sm"
              onClick={() => setPendingDefaultBranchAction(null)}
            >
              Cancel
            </Button>
            <Button
              className="w-full max-w-full sm:w-auto"
              variant="outline"
              size="sm-multiline"
              onClick={continuePendingDefaultBranchAction}
            >
              {pendingDefaultBranchActionCopy?.continueLabel ?? "Continue"}
            </Button>
            {canContinuePendingOnFeatureBranch && (
              <Button
                className="w-full max-w-full sm:w-auto"
                size="sm-multiline"
                onClick={checkoutFeatureBranchAndContinuePendingAction}
              >
                Check out feature branch & continue
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

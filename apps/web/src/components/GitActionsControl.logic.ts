import type {
  GitRunStackedActionResult,
  GitStackedAction,
  VcsStatusResult,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import {
  DEFAULT_CHANGE_REQUEST_TERMINOLOGY,
  getChangeRequestTerminology,
  type ChangeRequestTerminology,
} from "../sourceControlPresentation";

export type GitActionIconName = "commit" | "push" | "pr";

export type GitDialogAction = "commit" | "push" | "create_pr";

export type CommitMessageDrafts = Readonly<Record<string, string>>;

export interface GitActionIntent {
  action: GitStackedAction;
  owner: string;
  branchName: string | null | undefined;
  includesCommit: boolean;
  filePaths?: string[];
}

/** Freeze what was selected before a confirmation or author setup can delay dispatch. */
export function captureGitActionIntent(input: {
  action: GitStackedAction;
  owner: string;
  status: VcsStatusResult | null;
  featureBranch?: boolean;
  filePaths?: readonly string[];
}): GitActionIntent | null {
  const includesCommit =
    (input.action === "commit" ||
      input.action === "commit_push" ||
      input.action === "commit_push_pr") &&
    (input.action === "commit" ||
      input.status?.hasWorkingTreeChanges !== false ||
      input.featureBranch === true);
  const filePaths = includesCommit
    ? snapshotCommitFilePaths(input.filePaths, input.status?.workingTree.files ?? [])
    : null;
  if (includesCommit && filePaths === null) return null;
  const action = includesCommit
    ? input.action
    : input.action === "commit_push"
      ? "push"
      : input.action === "commit_push_pr"
        ? "create_pr"
        : input.action;
  return {
    action,
    owner: input.owner,
    branchName: input.status?.refName,
    includesCommit,
    ...(filePaths ? { filePaths } : {}),
  };
}

export function isGitActionIntentCurrent(
  intent: GitActionIntent,
  owner: string,
  status: VcsStatusResult | null,
): boolean {
  return (
    intent.owner === owner &&
    (intent.branchName === undefined || (status !== null && intent.branchName === status.refName))
  );
}

/** A result's next action belongs to the checkout and branch that produced it. */
export function captureGitActionFollowupIntent(
  original: GitActionIntent,
  result: GitRunStackedActionResult,
): GitActionIntent | null {
  const cta = result.toast.cta;
  if (
    cta.kind !== "run_action" ||
    (cta.action.kind !== "push" && cta.action.kind !== "create_pr")
  ) {
    return null;
  }

  // An intentional feature-branch step supersedes the branch admitted for the
  // original action. Otherwise retain that branch, never the current selection.
  const branchName = result.branch.status === "created" ? result.branch.name : original.branchName;
  if (!branchName || (result.push.branch !== undefined && result.push.branch !== branchName)) {
    return null;
  }

  return {
    action: cta.action.kind,
    owner: original.owner,
    branchName,
    includesCommit: false,
  };
}

/** Empty and omitted paths both stage everything on the server, so neither is a safe snapshot. */
export function snapshotCommitFilePaths(
  selectedPaths: readonly string[] | undefined,
  currentFiles: readonly { readonly path: string }[],
): string[] | null {
  const paths = selectedPaths ?? currentFiles.map((file) => file.path);
  return paths.length > 0 ? [...paths] : null;
}

/** A late Git result may only clear the message it successfully committed. */
export function clearCommittedMessageDraft(
  drafts: CommitMessageDrafts,
  scopeKey: string,
  submittedMessage: string,
  commitStatus: GitRunStackedActionResult["commit"]["status"],
): CommitMessageDrafts {
  if (commitStatus !== "created" || drafts[scopeKey]?.trim() !== submittedMessage.trim()) {
    return drafts;
  }
  const next = { ...drafts };
  delete next[scopeKey];
  return next;
}

export function manualPrSubmissionBlocker(gitStatus: VcsStatusResult | null): string | null {
  if (!gitStatus) return "Waiting for repository status.";
  if (!gitStatus.isRepo || !gitStatus.hasPrimaryRemote)
    return "Connect this repository to a remote before creating a pull request.";
  if (!gitStatus.refName) return "Check out a branch before creating a pull request.";
  if (gitStatus.hasWorkingTreeChanges)
    return "Commit or stash local changes before creating a pull request. Your title and description will stay here.";
  return null;
}

export function resolvePublishRepositoryEntry(input: {
  readonly environmentId: string | null;
  readonly cwd: string | null;
  readonly gitStatus: VcsStatusResult | null;
  readonly pendingRecoveryCount: number;
  readonly recoveryReadable: boolean;
}): "create" | "resume" | null {
  if (!input.environmentId || !input.cwd) return null;
  // A hosting-status failure must not hide an already-created repository.
  // The resume command revalidates the saved checkout and remote on the server.
  if (input.pendingRecoveryCount > 0 || !input.recoveryReadable) return "resume";
  return input.gitStatus?.isRepo && !input.gitStatus.hasPrimaryRemote ? "create" : null;
}

export interface GitActionMenuItem {
  id: "commit" | "push" | "pr";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog" | "open_pr";
  dialogAction?: GitDialogAction;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "open_pr" | "open_publish" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

export interface DefaultBranchActionDialogCopy {
  title: string;
  description: string;
  continueLabel: string;
}

export type DefaultBranchConfirmableAction =
  | "push"
  | "create_pr"
  | "commit_push"
  | "commit_push_pr";

function resolveChangeRequestTerminology(
  gitStatus: VcsStatusResult | null,
): ChangeRequestTerminology {
  return gitStatus?.sourceControlProvider
    ? getChangeRequestTerminology(gitStatus.sourceControlProvider)
    : DEFAULT_CHANGE_REQUEST_TERMINOLOGY;
}

export function buildGitActionProgressStages(input: {
  action: GitStackedAction;
  hasCustomCommitMessage: boolean;
  hasWorkingTreeChanges: boolean;
  pushTarget?: string;
  featureBranch?: boolean;
  shouldPushBeforePr?: boolean;
  terminology?: ChangeRequestTerminology;
}): string[] {
  const terminology = input.terminology ?? DEFAULT_CHANGE_REQUEST_TERMINOLOGY;
  const branchStages = input.featureBranch ? ["Preparing feature ref..."] : [];
  const pushStage = input.pushTarget ? `Pushing to ${input.pushTarget}...` : "Pushing...";
  const prStages = [
    `Preparing ${terminology.shortLabel}...`,
    `Generating ${terminology.shortLabel} content...`,
    `Creating ${terminology.singular}...`,
  ];

  if (input.action === "push") {
    return [pushStage];
  }
  if (input.action === "create_pr") {
    return input.shouldPushBeforePr ? [pushStage, ...prStages] : prStages;
  }

  const shouldIncludeCommitStages = input.action === "commit" || input.hasWorkingTreeChanges;
  const commitStages = !shouldIncludeCommitStages
    ? []
    : input.hasCustomCommitMessage
      ? ["Committing..."]
      : ["Generating commit message...", "Committing..."];
  if (input.action === "commit") {
    return [...branchStages, ...commitStages];
  }
  if (input.action === "commit_push") {
    return [...branchStages, ...commitStages, pushStage];
  }
  return [...branchStages, ...commitStages, pushStage, ...prStages];
}

export function buildMenuItems(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasPrimaryRemote = true,
): GitActionMenuItem[] {
  if (!gitStatus) return [];
  const terminology = resolveChangeRequestTerminology(gitStatus);

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isBehind = gitStatus.behindCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const canPushWithoutUpstream = hasPrimaryRemote && !gitStatus.hasUpstream;
  const canCommit = !isBusy && hasChanges;
  const canPush =
    !isBusy &&
    hasBranch &&
    !isBehind &&
    gitStatus.aheadCount > 0 &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canCreatePr =
    !isBusy &&
    hasBranch &&
    !hasChanges &&
    !hasOpenPr &&
    hasDefaultBranchDelta &&
    !isBehind &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canOpenPr = !isBusy && hasOpenPr;

  const commitItem: GitActionMenuItem = {
    id: "commit",
    label: "Commit",
    disabled: !canCommit,
    icon: "commit",
    kind: "open_dialog",
    dialogAction: "commit",
  };

  if (!hasPrimaryRemote) {
    return [commitItem];
  }

  return [
    commitItem,
    {
      id: "push",
      label: "Push",
      disabled: !canPush,
      icon: "push",
      kind: "open_dialog",
      dialogAction: "push",
    },
    hasOpenPr
      ? {
          id: "pr",
          label: `View ${terminology.shortLabel}`,
          disabled: !canOpenPr,
          icon: "pr",
          kind: "open_pr",
        }
      : {
          id: "pr",
          label: `Create ${terminology.shortLabel}`,
          disabled: !canCreatePr,
          icon: "pr",
          kind: "open_dialog",
          dialogAction: "create_pr",
        },
  ];
}

export function resolveQuickAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  isDefaultRef = false,
  hasPrimaryRemote = true,
): GitQuickAction {
  if (isBusy) {
    return { label: "Commit", disabled: true, kind: "show_hint", hint: "Git action in progress." };
  }

  if (!gitStatus) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Git status is unavailable.",
    };
  }

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const isBehind = gitStatus.behindCount > 0;
  const isDiverged = isAhead && isBehind;
  const terminology = resolveChangeRequestTerminology(gitStatus);

  if (!hasBranch) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: `Create and checkout a ref before pushing or opening a ${terminology.singular}.`,
    };
  }

  if (hasChanges) {
    if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
      return { label: "Commit", disabled: false, kind: "run_action", action: "commit" };
    }
    if (hasOpenPr || isDefaultRef) {
      return { label: "Commit & push", disabled: false, kind: "run_action", action: "commit_push" };
    }
    return {
      label: `Commit, push & ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "commit_push_pr",
    };
  }

  if (!gitStatus.hasUpstream) {
    if (!hasPrimaryRemote) {
      if (hasOpenPr && !isAhead) {
        return { label: `View ${terminology.shortLabel}`, disabled: false, kind: "open_pr" };
      }
      return {
        label: "Publish repository",
        disabled: false,
        kind: "open_publish",
      };
    }
    if (!isAhead) {
      if (hasOpenPr) {
        return { label: `View ${terminology.shortLabel}`, disabled: false, kind: "open_pr" };
      }
      return {
        label: "Push",
        disabled: true,
        kind: "show_hint",
        hint: "No local commits to push.",
      };
    }
    if (hasOpenPr || isDefaultRef) {
      return {
        label: "Push",
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: `Push & create ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (isDiverged) {
    return {
      label: "Sync ref",
      disabled: true,
      kind: "show_hint",
      hint: "Branch has diverged from upstream. Rebase/merge first.",
    };
  }

  if (isBehind) {
    return {
      label: "Pull",
      disabled: false,
      kind: "run_pull",
    };
  }

  if (isAhead) {
    if (hasOpenPr || isDefaultRef) {
      return {
        label: "Push",
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: `Push & create ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (hasOpenPr && gitStatus.hasUpstream) {
    return { label: `View ${terminology.shortLabel}`, disabled: false, kind: "open_pr" };
  }

  if (hasDefaultBranchDelta && !isDefaultRef) {
    return {
      label: `Create ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  return {
    label: "Commit",
    disabled: true,
    kind: "show_hint",
    hint: "Branch is up to date. No action needed.",
  };
}

export function requiresDefaultBranchConfirmation(
  action: GitStackedAction,
  isDefaultRef: boolean,
): boolean {
  if (!isDefaultRef) return false;
  return (
    action === "push" ||
    action === "create_pr" ||
    action === "commit_push" ||
    action === "commit_push_pr"
  );
}

export function canContinueOnFeatureBranch(
  action: DefaultBranchConfirmableAction,
  includesCommit: boolean,
): boolean {
  // The server's automatic feature branch step derives its name from changes to commit.
  return includesCommit && (action === "commit_push" || action === "commit_push_pr");
}

export function resolveGeneratedDraftAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
): { action: "create_pr" | "commit_push_pr"; label: string; disabled: boolean } | null {
  if (
    !gitStatus?.isRepo ||
    !gitStatus.hasPrimaryRemote ||
    gitStatus.sourceControlProvider?.kind !== "github" ||
    gitStatus.pr?.state === "open" ||
    gitStatus.behindCount > 0 ||
    (gitStatus.isDefaultRef && !gitStatus.hasWorkingTreeChanges)
  ) {
    return null;
  }
  // Default-ref protection remains in the action runner, including new-branch selection.
  const quickAction = resolveQuickAction(gitStatus, false, false);
  if (quickAction.action !== "create_pr" && quickAction.action !== "commit_push_pr") return null;
  return {
    action: quickAction.action,
    label:
      quickAction.action === "commit_push_pr"
        ? "Commit, push & create draft PR"
        : "Create draft PR",
    disabled: isBusy,
  };
}

export function resolveDefaultBranchActionDialogCopy(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  terminology?: ChangeRequestTerminology;
}): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;
  const suffix = canContinueOnFeatureBranch(input.action, input.includesCommit)
    ? ` on "${branchLabel}". You can continue on this ref or create a feature ref and run the same action there.`
    : ` on "${branchLabel}". To use a feature branch, cancel and create it with the branch selector first.`;
  const terminology = input.terminology ?? DEFAULT_CHANGE_REQUEST_TERMINOLOGY;

  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return {
        title: "Commit & push to default ref?",
        description: `This action will commit and push changes${suffix}`,
        continueLabel: `Commit & push to ${branchLabel}`,
      };
    }
    return {
      title: "Push to default ref?",
      description: `This action will push local commits${suffix}`,
      continueLabel: `Push to ${branchLabel}`,
    };
  }

  if (input.includesCommit) {
    return {
      title: `Commit, push & create ${terminology.shortLabel} from default ref?`,
      description: `This action will commit, push, and create a ${terminology.singular}${suffix}`,
      continueLabel: `Commit, push & create ${terminology.shortLabel}`,
    };
  }
  return {
    title: `Push & create ${terminology.shortLabel} from default ref?`,
    description: `This action will push local commits and create a ${terminology.singular}${suffix}`,
    continueLabel: `Push & create ${terminology.shortLabel}`,
  };
}

export function resolveThreadBranchUpdate(
  result: GitRunStackedActionResult,
): { branch: string } | null {
  if (result.branch.status !== "created" || !result.branch.name) {
    return null;
  }

  return {
    branch: result.branch.name,
  };
}

export function resolveThreadBranchMetadataPatch(
  branch: string | null,
  expectedBranch: string | null,
): {
  branch: string | null;
  expectedBranch: string | null;
} {
  return { branch, expectedBranch };
}

export function resolveLiveThreadBranchUpdate(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
}): { branch: string | null } | null {
  if (!input.gitStatus) {
    return null;
  }

  if (input.gitStatus.refName === null && input.threadBranch !== null) {
    return null;
  }

  if (input.threadBranch === input.gitStatus.refName) {
    return null;
  }

  if (
    input.threadBranch !== null &&
    input.gitStatus.refName !== null &&
    !isTemporaryWorktreeBranch(input.threadBranch) &&
    isTemporaryWorktreeBranch(input.gitStatus.refName)
  ) {
    return null;
  }

  return {
    branch: input.gitStatus.refName,
  };
}

// Re-export from shared for backwards compatibility in this module's exports
export { resolveAutoFeatureBranchName } from "@t3tools/shared/git";

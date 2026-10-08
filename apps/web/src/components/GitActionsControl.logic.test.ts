import type { GitRunStackedActionResult, VcsStatusResult } from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";
import {
  buildGitActionProgressStages,
  buildMenuItems,
  canContinueOnFeatureBranch,
  captureGitActionFollowupIntent,
  captureGitActionIntent,
  clearCommittedMessageDraft,
  isGitActionIntentCurrent,
  manualPrSubmissionBlocker,
  requiresDefaultBranchConfirmation,
  resolveAutoFeatureBranchName,
  resolveDefaultBranchActionDialogCopy,
  resolveGeneratedDraftAction,
  resolveLiveThreadBranchUpdate,
  resolvePublishRepositoryEntry,
  resolveQuickAction,
  resolveThreadBranchUpdate,
  resolveThreadBranchMetadataPatch,
  snapshotCommitFilePaths,
} from "./GitActionsControl.logic";

describe("delayed commit file selection", () => {
  it("freezes explicit and quick-action paths before later changes appear", () => {
    const files = [{ path: "selected.ts" }];
    const selected = ["selected.ts"];
    const quickSnapshot = snapshotCommitFilePaths(undefined, files);
    const dialogSnapshot = snapshotCommitFilePaths(selected, files);
    files.push({ path: "late-secret.ts" });
    selected.push("late-secret.ts");
    assert.deepEqual(quickSnapshot, ["selected.ts"]);
    assert.deepEqual(dialogSnapshot, ["selected.ts"]);
  });

  it("blocks empty selection rather than using the server's stage-everything semantics", () => {
    assert.isNull(snapshotCommitFilePaths([], [{ path: "unselected.ts" }]));
    assert.isNull(snapshotCommitFilePaths(undefined, []));
  });
});

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("Git success-toast continuation", () => {
  const scope = ["server-a", "/checkout", "thread-a", null];
  const owner = JSON.stringify(scope);
  const original = () =>
    captureGitActionIntent({
      action: "commit",
      owner,
      status: status({ hasWorkingTreeChanges: true }),
      filePaths: ["committed.txt"],
    })!;
  const result = (
    overrides: Partial<GitRunStackedActionResult> = {},
  ): GitRunStackedActionResult => ({
    action: "commit",
    branch: { status: "skipped_not_requested" },
    commit: { status: "created", commitSha: "abc1234" },
    push: { status: "skipped_not_requested" },
    pr: { status: "skipped_not_requested" },
    toast: {
      title: "Committed abc1234",
      cta: { kind: "run_action", label: "Push", action: { kind: "push" } },
    },
    ...overrides,
  });

  it("keeps the committed branch's Push usable without committing later edits", () => {
    const followup = captureGitActionFollowupIntent(original(), result());
    assert.isNotNull(followup);
    assert.isTrue(
      isGitActionIntentCurrent(followup!, owner, status({ hasWorkingTreeChanges: true })),
    );
    assert.equal(followup!.action, "push");
    assert.isFalse(followup!.includesCommit);
    assert.isUndefined(followup!.filePaths);
  });

  it("rejects the old toast after branch or action context changes", () => {
    const followup = captureGitActionFollowupIntent(original(), result())!;
    assert.isFalse(isGitActionIntentCurrent(followup, owner, status({ refName: "feature/other" })));
    for (let field = 0; field < scope.length; field++) {
      const changed = [...scope];
      changed[field] = "different";
      assert.isFalse(isGitActionIntentCurrent(followup, JSON.stringify(changed), status()));
    }
    assert.isFalse(isGitActionIntentCurrent(followup, owner, null));
    assert.isFalse(isGitActionIntentCurrent(followup, owner, status({ refName: null })));
  });

  it("binds Create PR after Push to the successful push's original context", () => {
    const push = captureGitActionIntent({ action: "push", owner, status: status() })!;
    const followup = captureGitActionFollowupIntent(
      push,
      result({
        action: "push",
        commit: { status: "skipped_not_requested" },
        push: { status: "pushed", branch: "feature/test" },
        toast: {
          title: "Pushed feature/test",
          cta: { kind: "run_action", label: "Create PR", action: { kind: "create_pr" } },
        },
      }),
    )!;
    assert.equal(followup.action, "create_pr");
    assert.isTrue(isGitActionIntentCurrent(followup, owner, status()));
    assert.isFalse(isGitActionIntentCurrent(followup, owner, status({ refName: "feature/other" })));
  });

  it("uses the deliberately created feature branch instead of the original branch", () => {
    const followup = captureGitActionFollowupIntent(
      original(),
      result({ branch: { status: "created", name: "feature/new" } }),
    )!;
    assert.isTrue(isGitActionIntentCurrent(followup, owner, status({ refName: "feature/new" })));
    assert.isFalse(isGitActionIntentCurrent(followup, owner, status()));
  });

  it("does not invent a branch when the original or created identity is missing", () => {
    assert.isNull(
      captureGitActionFollowupIntent({ ...original(), branchName: undefined }, result()),
    );
    assert.isNull(captureGitActionFollowupIntent({ ...original(), branchName: null }, result()));
    assert.isNull(
      captureGitActionFollowupIntent(original(), result({ branch: { status: "created" } })),
    );
  });

  it("refuses conflicting completed branch identities", () => {
    assert.isNull(
      captureGitActionFollowupIntent(
        original(),
        result({ push: { status: "pushed", branch: "feature/other" } }),
      ),
    );
    assert.isNull(
      captureGitActionFollowupIntent(
        original(),
        result({
          branch: { status: "created", name: "feature/new" },
          push: { status: "pushed", branch: "feature/other" },
        }),
      ),
    );
  });

  it("does not turn an Open PR link or a commit-bearing suggestion into a continuation", () => {
    assert.isNull(
      captureGitActionFollowupIntent(
        original(),
        result({
          toast: {
            title: "Created PR",
            cta: { kind: "open_pr", label: "View PR", url: "https://github.com/owner/repo/pull/1" },
          },
        }),
      ),
    );
    assert.isNull(
      captureGitActionFollowupIntent(
        original(),
        result({
          toast: {
            title: "Suggestion",
            cta: { kind: "run_action", label: "Commit and push", action: { kind: "commit_push" } },
          },
        }),
      ),
    );
  });
});

describe("frozen Git action intent", () => {
  const scope = ["server-a", "/checkout", "thread-a", null];
  const owner = JSON.stringify(scope);

  it("keeps a clean primary Push push-only when files appear before confirmation", () => {
    const clean = status({ refName: "main", isDefaultRef: true, aheadCount: 1 });
    const quick = resolveQuickAction(clean, false, true, true);
    assert.equal(quick.action, "commit_push");
    const intent = captureGitActionIntent({ action: quick.action!, owner, status: clean });
    assert.isNotNull(intent);
    const changed = status({
      ...clean,
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "late.txt", insertions: 1, deletions: 0 }],
        insertions: 1,
        deletions: 0,
      },
    });
    assert.isTrue(isGitActionIntentCurrent(intent!, owner, changed));
    assert.equal(intent!.action, "push");
    assert.isFalse(intent!.includesCommit);
    assert.isUndefined(intent!.filePaths);
  });

  it("keeps clean push-and-PR intent without admitting a later commit", () => {
    const intent = captureGitActionIntent({ action: "commit_push_pr", owner, status: status() });
    assert.equal(intent?.action, "create_pr");
    assert.isFalse(intent?.includesCommit);
    assert.isUndefined(intent?.filePaths);
  });

  it("preserves selected commit paths through confirmation and author setup", () => {
    const selected = ["selected.txt"];
    const dirty = status({ hasWorkingTreeChanges: true });
    const intent = captureGitActionIntent({
      action: "commit_push_pr",
      owner,
      status: dirty,
      filePaths: selected,
    });
    selected.push("later.txt");
    assert.isNotNull(intent);
    assert.isTrue(isGitActionIntentCurrent(intent!, owner, { ...dirty }));
    assert.equal(intent!.action, "commit_push_pr");
    assert.deepEqual(intent!.filePaths, ["selected.txt"]);
    assert.isTrue(
      intent!.action !== "commit" &&
        canContinueOnFeatureBranch(intent!.action, intent!.includesCommit),
    );
  });

  it("rejects a changed environment, checkout, thread, draft or observed branch", () => {
    const original = status({ refName: "main" });
    const intent = captureGitActionIntent({ action: "push", owner, status: original })!;
    assert.isTrue(isGitActionIntentCurrent(intent, owner, original));
    for (let field = 0; field < scope.length; field++) {
      const changed = [...scope];
      changed[field] = "different";
      assert.isFalse(isGitActionIntentCurrent(intent, JSON.stringify(changed), original));
    }
    assert.isFalse(isGitActionIntentCurrent(intent, owner, status({ refName: "feature/other" })));
    assert.isFalse(isGitActionIntentCurrent(intent, owner, status({ refName: null })));
    assert.isFalse(isGitActionIntentCurrent(intent, owner, null));
  });

  it("keeps an explicit commit and feature-branch intent, but refuses an empty selection", () => {
    const dirty = status({ hasWorkingTreeChanges: true });
    const intent = captureGitActionIntent({
      action: "commit_push",
      owner,
      status: dirty,
      featureBranch: true,
      filePaths: ["selected.txt"],
    });
    assert.equal(intent?.action, "commit_push");
    assert.isTrue(intent?.includesCommit);
    assert.isNull(
      captureGitActionIntent({ action: "commit", owner, status: dirty, filePaths: [] }),
    );
  });

  it("does not infer a clean checkout or invent a branch when status is unavailable", () => {
    for (const action of ["commit", "commit_push", "commit_push_pr"] as const) {
      const intent = captureGitActionIntent({
        action,
        owner,
        status: null,
        filePaths: ["selected.txt"],
      });
      assert.equal(intent?.action, action);
      assert.isTrue(intent?.includesCommit);
      assert.isUndefined(intent?.branchName);
      assert.deepEqual(intent?.filePaths, ["selected.txt"]);
    }
  });
});

describe("publish recovery entry", () => {
  const scope = { environmentId: "server-a", cwd: "/exact-checkout" };

  it("keeps a created repository recoverable after status fails or the checkout changes", () => {
    const initial = {
      ...scope,
      gitStatus: status({ hasPrimaryRemote: false }),
      pendingRecoveryCount: 0,
      recoveryReadable: true,
    };
    assert.equal(resolvePublishRepositoryEntry(initial), "create");
    for (const gitStatus of [null, status(), status({ isRepo: false })]) {
      assert.equal(
        resolvePublishRepositoryEntry({ ...initial, gitStatus, pendingRecoveryCount: 1 }),
        "resume",
      );
    }
  });

  it("keeps unreadable saved recovery accessible without offering a new creation", () => {
    assert.equal(
      resolvePublishRepositoryEntry({
        ...scope,
        gitStatus: null,
        pendingRecoveryCount: 0,
        recoveryReadable: false,
      }),
      "resume",
    );
  });

  it("requires exact scope for recovery and preserves fresh publish prerequisites", () => {
    const recovery = {
      ...scope,
      gitStatus: null,
      pendingRecoveryCount: 1,
      recoveryReadable: true,
    };
    assert.isNull(resolvePublishRepositoryEntry({ ...recovery, environmentId: null }));
    assert.isNull(resolvePublishRepositoryEntry({ ...recovery, cwd: null }));
    assert.isNull(resolvePublishRepositoryEntry({ ...recovery, cwd: "" }));
    for (const gitStatus of [null, status(), status({ isRepo: false, hasPrimaryRemote: false })]) {
      assert.isNull(
        resolvePublishRepositoryEntry({ ...recovery, gitStatus, pendingRecoveryCount: 0 }),
      );
    }
  });
});

describe("manual pull request prerequisites", () => {
  it("blocks a dirty checkout before the authored request is submitted", () => {
    assert.match(
      manualPrSubmissionBlocker(status({ hasWorkingTreeChanges: true })) ?? "",
      /Commit or stash local changes/,
    );
  });

  it("allows a clean branch with a remote", () => {
    assert.isNull(manualPrSubmissionBlocker(status({ aheadCount: 2 })));
  });

  it("waits for status and blocks a missing remote or detached checkout", () => {
    assert.isString(manualPrSubmissionBlocker(null));
    assert.isString(manualPrSubmissionBlocker(status({ isRepo: false })));
    assert.isString(manualPrSubmissionBlocker(status({ hasPrimaryRemote: false })));
    assert.isString(manualPrSubmissionBlocker(status({ refName: null })));
  });
});

describe("generated draft pull requests", () => {
  const github = { kind: "github", name: "GitHub", baseUrl: "https://github.com" } as const;

  it("includes dirty changes in the commit and push action", () => {
    assert.deepEqual(
      resolveGeneratedDraftAction(
        status({ sourceControlProvider: github, hasWorkingTreeChanges: true }),
        false,
      ),
      {
        action: "commit_push_pr",
        label: "Commit, push & create draft PR",
        disabled: false,
      },
    );
  });

  it("offers a generated draft for a clean branch with committed changes", () => {
    assert.deepEqual(
      resolveGeneratedDraftAction(
        status({ sourceControlProvider: github, aheadOfDefaultCount: 2 }),
        true,
      ),
      { action: "create_pr", label: "Create draft PR", disabled: true },
    );
  });

  it("keeps default-ref confirmation for changes that can create a feature branch", () => {
    const action = resolveGeneratedDraftAction(
      status({ sourceControlProvider: github, isDefaultRef: true, hasWorkingTreeChanges: true }),
      false,
    );
    assert.isNotNull(action);
    assert.isTrue(requiresDefaultBranchConfirmation(action!.action, true));
    assert.isNull(
      resolveGeneratedDraftAction(
        status({ sourceControlProvider: github, isDefaultRef: true, aheadCount: 2 }),
        false,
      ),
    );
  });

  it("keeps existing PRs and ineligible checkouts out of the creation flow", () => {
    const eligible = status({ sourceControlProvider: github, hasWorkingTreeChanges: true });
    for (const candidate of [
      null,
      { ...eligible, sourceControlProvider: undefined },
      { ...eligible, sourceControlProvider: { ...github, kind: "gitlab" as const } },
      { ...eligible, isRepo: false },
      { ...eligible, hasPrimaryRemote: false },
      { ...eligible, refName: null },
      { ...eligible, behindCount: 1 },
      { ...eligible, hasWorkingTreeChanges: false },
      {
        ...eligible,
        pr: {
          number: 10,
          title: "Existing PR",
          url: "https://example.com/pr/10",
          baseRef: "main",
          headRef: "feature/test",
          state: "open" as const,
        },
      },
    ]) {
      assert.isNull(resolveGeneratedDraftAction(candidate, false));
    }
  });
});

describe("manual commit message drafts", () => {
  it("keeps the authored message when Git does not create a commit", () => {
    const drafts = { checkout: "Fix the broken review receipt" };
    assert.strictEqual(
      clearCommittedMessageDraft(drafts, "checkout", drafts.checkout, "skipped_no_changes"),
      drafts,
    );
    assert.strictEqual(
      clearCommittedMessageDraft(drafts, "checkout", drafts.checkout, "skipped_not_requested"),
      drafts,
    );
  });

  it("clears only the submitted checkout draft after a commit is created", () => {
    const drafts = { checkout: "  Fix the review receipt\n", otherCheckout: "Ship documentation" };
    assert.deepEqual(
      clearCommittedMessageDraft(drafts, "checkout", "Fix the review receipt", "created"),
      { otherCheckout: "Ship documentation" },
    );
    assert.equal(drafts.checkout, "  Fix the review receipt\n");
  });

  it("preserves a newer message when an earlier commit finishes", () => {
    const drafts = { checkout: "Explain the follow-up change" };
    assert.strictEqual(
      clearCommittedMessageDraft(drafts, "checkout", "Fix the review receipt", "created"),
      drafts,
    );
  });

  it("ignores completion for a checkout without an authored draft", () => {
    const drafts = { otherCheckout: "Ship documentation" };
    assert.strictEqual(
      clearCommittedMessageDraft(drafts, "checkout", "Generated subject", "created"),
      drafts,
    );
  });
});

describe("when: ref is clean and has an open PR", () => {
  it("resolveQuickAction opens the existing PR", () => {
    const quick = resolveQuickAction(
      status({
        pr: {
          number: 10,
          title: "Open PR",
          url: "https://example.com/pr/10",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, { kind: "open_pr", label: "View PR", disabled: false });
  });

  it("buildMenuItems disables commit/push and enables open PR", () => {
    const items = buildMenuItems(
      status({
        pr: {
          number: 11,
          title: "Existing PR",
          url: "https://example.com/pr/11",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "View PR",
        disabled: false,
        icon: "pr",
        kind: "open_pr",
      },
    ]);
  });
});

describe("when: actions are busy", () => {
  it("resolveQuickAction returns running disabled state", () => {
    const quick = resolveQuickAction(status(), true);
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Commit",
      disabled: true,
      hint: "Git action in progress.",
    });
  });

  it("buildMenuItems disables all actions", () => {
    const items = buildMenuItems(status(), true);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: git status is unavailable", () => {
  it("resolveQuickAction returns unavailable disabled state", () => {
    const quick = resolveQuickAction(null, false);
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Commit",
      disabled: true,
      hint: "Git status is unavailable.",
    });
  });

  it("buildMenuItems returns no menu items", () => {
    const items = buildMenuItems(null, false);
    assert.deepEqual(items, []);
  });
});

describe("when: ref is clean, ahead, and has an open PR", () => {
  it("resolveQuickAction prefers push", () => {
    const quick = resolveQuickAction(
      status({
        aheadCount: 3,
        pr: {
          number: 13,
          title: "Open PR",
          url: "https://example.com/pr/13",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, { kind: "run_action", action: "push", label: "Push" });
  });

  it("buildMenuItems enables push and keeps open PR available", () => {
    const items = buildMenuItems(
      status({
        aheadCount: 2,
        pr: {
          number: 12,
          title: "Existing PR",
          url: "https://example.com/pr/12",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: false,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "View PR",
        disabled: false,
        icon: "pr",
        kind: "open_pr",
      },
    ]);
  });
});

describe("when: ref is clean, ahead, and has no open PR", () => {
  it("resolveQuickAction pushes and creates a PR", () => {
    const quick = resolveQuickAction(status({ aheadCount: 2, pr: null }), false);
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "create_pr",
      label: "Push & create PR",
    });
  });

  it("buildMenuItems enables push and create PR, with commit disabled", () => {
    const items = buildMenuItems(status({ aheadCount: 2, pr: null }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: false,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: false,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: source control provider uses merge requests", () => {
  it("uses GitLab MR terminology in quick actions and menu items", () => {
    const gitlabStatus = status({
      aheadCount: 2,
      sourceControlProvider: {
        kind: "gitlab",
        name: "GitLab",
        baseUrl: "https://gitlab.com",
      },
    });

    const quick = resolveQuickAction(gitlabStatus, false);
    const items = buildMenuItems(gitlabStatus, false);

    assert.deepInclude(quick, {
      kind: "run_action",
      action: "create_pr",
      label: "Push & create MR",
    });
    assert.deepInclude(items[2], {
      id: "pr",
      label: "Create MR",
    });
  });
});

describe("when: ref is clean, up to date, and has no open PR", () => {
  it("enables create PR when synced with upstream but ahead of default", () => {
    const syncedFeature = status({
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 1,
      pr: null,
    });

    const quick = resolveQuickAction(syncedFeature, false);
    assert.deepInclude(quick, {
      label: "Create PR",
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    });

    const items = buildMenuItems(syncedFeature, false);
    assert.equal(items.find((item) => item.id === "pr")?.disabled, false);
  });

  it("resolveQuickAction returns disabled no-action state", () => {
    const quick = resolveQuickAction(
      status({ aheadCount: 0, behindCount: 0, hasWorkingTreeChanges: false, pr: null }),
      false,
    );
    assert.deepInclude(quick, { kind: "show_hint", label: "Commit", disabled: true });
  });

  it("buildMenuItems disables commit, push, and create PR", () => {
    const items = buildMenuItems(status({ aheadCount: 0, behindCount: 0, pr: null }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: ref is behind upstream", () => {
  it("resolveQuickAction returns pull", () => {
    const quick = resolveQuickAction(status({ behindCount: 2 }), false);
    assert.deepInclude(quick, { kind: "run_pull", label: "Pull", disabled: false });
  });

  it("buildMenuItems disables push and create PR", () => {
    const items = buildMenuItems(status({ behindCount: 1, pr: null }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: ref has diverged from upstream", () => {
  it("resolveQuickAction returns a disabled sync hint", () => {
    const quick = resolveQuickAction(status({ aheadCount: 2, behindCount: 1 }), false);
    assert.deepEqual(quick, {
      label: "Sync ref",
      disabled: true,
      kind: "show_hint",
      hint: "Branch has diverged from upstream. Rebase/merge first.",
    });
  });
});

describe("when: working tree has local changes", () => {
  it("resolveQuickAction returns commit, push, and create PR", () => {
    const quick = resolveQuickAction(status({ hasWorkingTreeChanges: true }), false);
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push_pr",
      label: "Commit, push & PR",
    });
  });

  it("resolveQuickAction falls back to commit when no origin remote exists", () => {
    const quick = resolveQuickAction(
      status({ hasWorkingTreeChanges: true, hasUpstream: false }),
      false,
      false,
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit",
      label: "Commit",
      disabled: false,
    });
  });

  it("resolveQuickAction returns commit and push when open PR exists", () => {
    const quick = resolveQuickAction(
      status({
        hasWorkingTreeChanges: true,
        pr: {
          number: 16,
          title: "Existing PR",
          url: "https://example.com/pr/16",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Commit & push",
    });
  });

  it("buildMenuItems enables commit and disables push and PR", () => {
    const items = buildMenuItems(status({ hasWorkingTreeChanges: true }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: false,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });

  it("buildMenuItems enables push for ahead commits while local changes remain uncommitted", () => {
    const items = buildMenuItems(
      status({
        refName: "feature/test",
        hasWorkingTreeChanges: true,
        aheadCount: 1,
        workingTree: {
          files: [{ path: ".vercel/project.json", insertions: 1, deletions: 0 }],
          insertions: 1,
          deletions: 0,
        },
      }),
      false,
    );
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: false,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: false,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: on default ref without open PR", () => {
  it("resolveQuickAction returns commit and push when local changes exist", () => {
    const quick = resolveQuickAction(
      status({ refName: "main", hasWorkingTreeChanges: true }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Commit & push",
      disabled: false,
    });
  });

  it("resolveQuickAction returns push when ref is ahead", () => {
    const quick = resolveQuickAction(
      status({ refName: "main", aheadCount: 2, pr: null }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Push",
      disabled: false,
    });
  });
});

describe("when: working tree has local changes and ref is behind upstream", () => {
  it("resolveQuickAction still prefers commit, push, and create PR", () => {
    const quick = resolveQuickAction(
      status({ hasWorkingTreeChanges: true, behindCount: 1 }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push_pr",
      label: "Commit, push & PR",
    });
  });

  it("buildMenuItems enables commit and keeps push and PR disabled", () => {
    const items = buildMenuItems(status({ hasWorkingTreeChanges: true, behindCount: 2 }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: false,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: HEAD is detached and there are no local changes", () => {
  it("resolveQuickAction shows detached head hint", () => {
    const quick = resolveQuickAction(
      status({ refName: null, hasWorkingTreeChanges: false, hasUpstream: false }),
      false,
    );
    assert.deepInclude(quick, { kind: "show_hint", label: "Commit", disabled: true });
  });

  it("buildMenuItems keeps commit, push, and PR disabled", () => {
    const items = buildMenuItems(status({ refName: null, hasWorkingTreeChanges: false }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: ref has no upstream configured", () => {
  it("resolveQuickAction is disabled when clean, no upstream, and no local commits are ahead", () => {
    const quick = resolveQuickAction(
      status({ hasUpstream: false, pr: null, aheadCount: 0 }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Push",
      hint: "No local commits to push.",
      disabled: true,
    });
  });

  it("resolveQuickAction opens PR when clean, no upstream, no local commits are ahead, and PR exists", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 0,
        pr: {
          number: 14,
          title: "Existing PR",
          url: "https://example.com/pr/14",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "open_pr",
      label: "View PR",
      disabled: false,
    });
  });

  it("resolveQuickAction runs push when clean, no upstream, and local commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 1,
        pr: {
          number: 15,
          title: "Existing PR",
          url: "https://example.com/pr/15",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "push",
      label: "Push",
      disabled: false,
    });
  });

  it("buildMenuItems disables push and create PR when no commits are ahead", () => {
    const items = buildMenuItems(status({ hasUpstream: false, pr: null, aheadCount: 0 }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });

  it("resolveQuickAction runs push and create PR when no upstream and commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 2,
        pr: null,
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "create_pr",
      label: "Push & create PR",
      disabled: false,
    });
  });

  it("resolveQuickAction publishes when no origin remote exists", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 2,
        pr: null,
      }),
      false,
      false,
      false,
    );
    assert.deepEqual(quick, {
      kind: "open_publish",
      label: "Publish repository",
      disabled: false,
    });
  });

  it("buildMenuItems enables create PR when no upstream and commits are ahead", () => {
    const items = buildMenuItems(status({ hasUpstream: false, pr: null, aheadCount: 2 }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: false,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: false,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });

  it("buildMenuItems hides push and create PR when no origin remote exists", () => {
    const items = buildMenuItems(
      status({ hasUpstream: false, pr: null, aheadCount: 2 }),
      false,
      false,
    );
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
    ]);
  });

  it("resolveQuickAction is disabled on default ref when no upstream exists and no commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        refName: "main",
        hasUpstream: false,
        aheadCount: 0,
        pr: null,
      }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Push",
      hint: "No local commits to push.",
      disabled: true,
    });
  });

  it("resolveQuickAction uses push-only on default ref when no upstream exists and commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        refName: "main",
        hasUpstream: false,
        aheadCount: 1,
        pr: null,
      }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Push",
      disabled: false,
    });
  });

  it("buildMenuItems still disables push and create PR when ref is behind", () => {
    const items = buildMenuItems(
      status({
        hasUpstream: false,
        behindCount: 1,
        aheadCount: 0,
        pr: null,
      }),
      false,
    );
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("requiresDefaultBranchConfirmation", () => {
  it("requires confirmation for push actions on default ref", () => {
    assert.isFalse(requiresDefaultBranchConfirmation("commit", true));
    assert.isTrue(requiresDefaultBranchConfirmation("push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("create_pr", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push_pr", true));
    assert.isFalse(requiresDefaultBranchConfirmation("commit_push", false));
    assert.isFalse(requiresDefaultBranchConfirmation("push", false));
  });
});

describe("default-branch feature continuation", () => {
  it("routes an already committed default branch through the branch selector", () => {
    const checkout = status({
      isDefaultRef: true,
      refName: "main",
      hasUpstream: false,
      aheadCount: 2,
    });
    assert.deepEqual(resolveQuickAction(checkout, false, true, true), {
      label: "Push",
      disabled: false,
      kind: "run_action",
      action: "commit_push",
    });
    for (const action of ["push", "create_pr"] as const) {
      assert.isTrue(requiresDefaultBranchConfirmation(action, true));
      assert.isFalse(canContinueOnFeatureBranch(action, false));
      assert.isFalse(canContinueOnFeatureBranch(action, true));
      const copy = resolveDefaultBranchActionDialogCopy({
        action,
        branchName: "main",
        includesCommit: false,
      });
      assert.include(copy.description, "cancel and create it with the branch selector first");
      assert.notInclude(copy.description, "run the same action there");
    }
  });

  it.each(["commit_push", "commit_push_pr"] as const)(
    "keeps %s feature continuation only while it includes a commit",
    (action) => {
      assert.isTrue(canContinueOnFeatureBranch(action, true));
      assert.isFalse(canContinueOnFeatureBranch(action, false));
      const copy = resolveDefaultBranchActionDialogCopy({
        action,
        branchName: "main",
        includesCommit: true,
      });
      assert.include(copy.description, "create a feature ref and run the same action there");
    },
  );
});

describe("resolveDefaultBranchActionDialogCopy", () => {
  it("uses push-only copy when pushing without a commit", () => {
    const copy = resolveDefaultBranchActionDialogCopy({
      action: "commit_push",
      branchName: "main",
      includesCommit: false,
    });

    assert.deepEqual(copy, {
      title: "Push to default ref?",
      description:
        'This action will push local commits on "main". To use a feature branch, cancel and create it with the branch selector first.',
      continueLabel: "Push to main",
    });
  });

  it("uses push-and-pr copy when creating a PR without a commit", () => {
    const copy = resolveDefaultBranchActionDialogCopy({
      action: "commit_push_pr",
      branchName: "main",
      includesCommit: false,
    });

    assert.deepEqual(copy, {
      title: "Push & create PR from default ref?",
      description:
        'This action will push local commits and create a pull request on "main". To use a feature branch, cancel and create it with the branch selector first.',
      continueLabel: "Push & create PR",
    });
  });

  it("keeps commit copy when the action includes a commit", () => {
    const copy = resolveDefaultBranchActionDialogCopy({
      action: "commit_push_pr",
      branchName: "main",
      includesCommit: true,
    });

    assert.deepEqual(copy, {
      title: "Commit, push & create PR from default ref?",
      description:
        'This action will commit, push, and create a pull request on "main". You can continue on this ref or create a feature ref and run the same action there.',
      continueLabel: "Commit, push & create PR",
    });
  });
});

describe("buildGitActionProgressStages", () => {
  it("shows only push progress for explicit push actions", () => {
    const stages = buildGitActionProgressStages({
      action: "push",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: false,
      pushTarget: "origin/feature/test",
    });
    assert.deepEqual(stages, ["Pushing to origin/feature/test..."]);
  });

  it("shows push and PR progress for create-pr actions that still need a push", () => {
    const stages = buildGitActionProgressStages({
      action: "create_pr",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: false,
      pushTarget: "origin/feature/test",
      shouldPushBeforePr: true,
    });
    assert.deepEqual(stages, [
      "Pushing to origin/feature/test...",
      "Preparing PR...",
      "Generating PR content...",
      "Creating pull request...",
    ]);
  });

  it("shows only PR progress when create-pr can skip the push", () => {
    const stages = buildGitActionProgressStages({
      action: "create_pr",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: false,
      shouldPushBeforePr: false,
    });
    assert.deepEqual(stages, [
      "Preparing PR...",
      "Generating PR content...",
      "Creating pull request...",
    ]);
  });

  it("includes commit stages for commit+push when working tree is dirty", () => {
    const stages = buildGitActionProgressStages({
      action: "commit_push",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: true,
      pushTarget: "origin/feature/test",
    });
    assert.deepEqual(stages, [
      "Generating commit message...",
      "Committing...",
      "Pushing to origin/feature/test...",
    ]);
  });

  it("includes granular PR stages for commit+push+PR actions", () => {
    const stages = buildGitActionProgressStages({
      action: "commit_push_pr",
      hasCustomCommitMessage: true,
      hasWorkingTreeChanges: true,
      pushTarget: "origin/feature/test",
    });
    assert.deepEqual(stages, [
      "Committing...",
      "Pushing to origin/feature/test...",
      "Preparing PR...",
      "Generating PR content...",
      "Creating pull request...",
    ]);
  });
});

describe("resolveThreadBranchUpdate", () => {
  it("returns a branch update when the action created a new branch", () => {
    const update = resolveThreadBranchUpdate({
      action: "commit_push_pr",
      branch: {
        status: "created",
        name: "feature/fix-toast-copy",
      },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "feat: add ref sync",
      },
      push: { status: "pushed", branch: "feature/fix-toast-copy" },
      pr: { status: "skipped_not_requested" },
      toast: {
        title: "Pushed 89abcde to origin/feature/fix-toast-copy",
        cta: { kind: "none" },
      },
    });

    assert.deepEqual(update, {
      branch: "feature/fix-toast-copy",
    });
  });

  it("returns null when the action stayed on the existing branch", () => {
    const update = resolveThreadBranchUpdate({
      action: "commit_push",
      branch: {
        status: "skipped_not_requested",
      },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "feat: add ref sync",
      },
      push: { status: "pushed", branch: "feature/fix-toast-copy" },
      pr: { status: "skipped_not_requested" },
      toast: {
        title: "Pushed 89abcde to origin/feature/fix-toast-copy",
        cta: { kind: "none" },
      },
    });

    assert.equal(update, null);
  });
});

describe("resolveLiveThreadBranchUpdate", () => {
  it("returns a branch update when live git status differs from stored thread metadata", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "feature/old-ref",
      gitStatus: status({ refName: "effect-atom" }),
    });

    assert.deepEqual(update, {
      branch: "effect-atom",
    });
  });

  it("returns null when live git status is unavailable", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "feature/old-ref",
      gitStatus: null,
    });

    assert.equal(update, null);
  });

  it("returns null when the stored thread ref already matches git status", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "effect-atom",
      gitStatus: status({ refName: "effect-atom" }),
    });

    assert.equal(update, null);
  });

  it("returns null when git status is detached HEAD but the thread already has a ref", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "effect-atom",
      gitStatus: status({ refName: null }),
    });

    assert.equal(update, null);
  });

  it("does not regress a semantic thread ref back to a temporary worktree ref", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "t3code/github-query-rate-limit",
      gitStatus: status({ refName: "t3code/bda76797" }),
    });

    assert.equal(update, null);
  });

  it("allows a temporary worktree ref to reconcile to a semantic branch", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "t3code/a9628676",
      gitStatus: status({ refName: "feature/diff-panel-toggle" }),
    });

    assert.deepEqual(update, { branch: "feature/diff-panel-toggle" });
  });
});

describe("resolveThreadBranchMetadataPatch", () => {
  it("does not overwrite worktree metadata while reconciling a branch", () => {
    assert.deepEqual(
      resolveThreadBranchMetadataPatch("feature/current-ref", "feature/previous-ref"),
      {
        branch: "feature/current-ref",
        expectedBranch: "feature/previous-ref",
      },
    );
  });
});

describe("resolveAutoFeatureBranchName", () => {
  it("uses semantic preferred ref names when available", () => {
    const ref = resolveAutoFeatureBranchName(["main", "feature/other"], "fix toast copy");
    assert.equal(ref, "feature/fix-toast-copy");
  });

  it("normalizes preferred names that already include a ref namespace", () => {
    const ref = resolveAutoFeatureBranchName(["main"], "feature/refine-toolbar-actions");
    assert.equal(ref, "feature/refine-toolbar-actions");
  });

  it("increments suffix when the preferred ref name already exists", () => {
    const ref = resolveAutoFeatureBranchName(
      ["main", "feature/fix-toast-copy", "feature/fix-toast-copy-2"],
      "fix toast copy",
    );
    assert.equal(ref, "feature/fix-toast-copy-3");
  });

  it("treats existing ref names as case-insensitive for collision checks", () => {
    const ref = resolveAutoFeatureBranchName(["Feature/Ticket-1"], "feature/ticket-1");
    assert.equal(ref, "feature/ticket-1-2");
  });

  it("falls back to feature/update when no preferred name is provided", () => {
    const ref = resolveAutoFeatureBranchName(["main"]);
    assert.equal(ref, "feature/update");
  });
});

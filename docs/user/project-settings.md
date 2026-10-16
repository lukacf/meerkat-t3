# Settings and project overrides

Check the project and computer shown at the top of Settings before changing a value. Choose **All projects** for defaults or select a project to override them. Device preferences, such as appearance, are saved on this device and do not follow the project selection.

A setting's source indicator shows whether its value comes from a built-in default, the computer, or a project override. Reset an override to inherit again. Changing a computer default preserves a project's explicit override.

## Defaults and inheritance

**General** controls model, permission, and workspace defaults for new threads. **Integrations** controls browser access. **Source Control** includes automatic pull and text generation. These defaults do not retroactively change an existing specialist's permissions or model.

The Project category holds the project's name, icon, actions, checkouts, and removal. Import actions from the repository's `t3.json` when offered, or create actions for commands you use regularly. Actions execute in the selected workspace; inspect their commands before running them.

For settings also declared in `t3.json`, precedence is: project override, computer setting, repository configuration, built-in default. Leave a setting on **Inherit** to use the next applicable value.

New worktrees initialize submodules recursively by default. **Settings > General > Submodules** can limit this to top-level submodules or skip initialization for a setup script. Check your project's requirements before changing it.

## Storage cleanup

**Settings > Storage** contains optional cleanup policies. They are off by default. Worktree cleanup can follow the computer's rules, be disabled for a project, or use project-specific rules.

Only app-managed worktrees are eligible for automatic removal. Active sessions, shared worktrees, uncommitted changes, and ignored files other than `node_modules` prevent removal. Branches and thread history remain; continuing work can recreate the checkout.

Rules can consider inactivity, merged work, or deleted threads. Read the selected rule before enabling it. Merge cleanup requires the commits to be present in the remote default branch, so squash merges may need an inactivity rule instead.

Browser captures and rotated logs have separate retention periods. Expired capture links stop working; message attachments and browser profiles are kept. Cleanup is not a substitute for [profile and project backups](troubleshooting.md#reinstall-back-up-or-recover-a-profile).

## Project icons

Select a project in Settings to choose an icon, emoji, monogram, or image. The choice applies to its grouped checkouts. Choose **Automatic** to restore detection.

## Keep the default branch current

**Source Control > Automatically pull** can keep the default-branch checkout current with its configured upstream. Pulls happen only when they can fast-forward and the checkout has no changed files, untracked files, or local commits. Checkouts on another branch or without an upstream are skipped.

If a checkout contains local work, resolve it before automatic pulls can resume. A peer connection does not synchronize branches or files between projects.

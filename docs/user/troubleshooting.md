# Recovery and troubleshooting

## A message fails or the agent stops responding

Keep the message and error visible. Check that the selected model belongs to your connected API account and that the account has quota. Reconnect if the app reports a lost connection. If delivery is **uncertain**, use **Check delivery** before retrying; a missing reply does not prove the original action never ran.

A saved conversation can be visible while its agent is disconnected. Use **Connect** to continue a persistent project agent. After an app restart, inspect the recovery notice and current file changes before resending work. A recovery action may offer reconnect, stop, or a new task depending on what the runtime can confirm.

## My saved model or account is unavailable

Use the account link beside the failed task or model choice to open the correct computer's provider settings. A saved key can be expired or revoked even when the app detects it. Follow [Accounts and billing](accounts.md) to replace it or reconnect, then return to the original conversation. Check delivery before retrying a message whose status is uncertain.

If a saved model is unavailable, choose a model your account can use. If only the saved reasoning level is unsupported, choose a supported level or **Model default**. Do not create a replacement agent just to change these settings. An existing specialist may need **Connect** before its current model and reasoning level can be shown.

## Setup or a project draft did not come back

Reopen setup by searching for **Set up Meerkat** in the same app or browser profile. A different server address may have separate saved progress. Setup retains the saved step and project folder; it saves only complete repository URLs without embedded credentials, query parameters, or fragments. Use a credential-free clone URL and the computer's Git sign-in instead.

If the app reports that it cannot read saved setup, use its retry action. For an unreadable project draft, choose **Retry reading draft** before continuing. **Discard draft** lets you start again, but does not cancel a clone that may already be running or remove a repository on disk. If a project draft is **only in this view**, keep the view open and copy the folder path and credential-free URL before closing it. A saved form does not mean a clone or project creation completed; inspect any reported result before trying again.

## Stop or cancel follow-up work

Use **Stop turn** for current work. Separately delete any still-waiting **Queue for idle** messages you no longer want sent. Stopping a turn does not reverse commands that already ran, cancel external services, or remove the durable follow-up queue.

## Recover files

Inspect Changes before restoring anything. Commit work you want to keep. Native specialist and worker conversations provide **Workspace checkpoints**: save a snapshot before risky work, then preview and restore selected files if needed. Automatic native checkpoint capture is not available in this prototype. A snapshot cannot recover the state from before it was saved.

Restoring files does not rewind the conversation, undo an external action, or necessarily affect Git staging. If other agents or you share a checkout, their edits can also appear in a snapshot. Conflicting later edits are protected; review any conflicts instead of forcing a restore.

## Reinstall, back up, or recover a profile

Replacing the application bundle is different from deleting its profile. Keep your saved profile when reinstalling. The offline recovery tool saves the whole app profile and the separate desktop profile, including conversations, native agent histories, pending queues, attachments, settings, and credentials stored in those directories. It also discovers native state stored elsewhere by current settings or saved agent references. Do not copy only a live SQLite file or delete data to solve a launch problem.

This is **same-user, same-Mac, same-path recovery**, not a migration tool. It does not move or back up project repositories outside the profile, global `~/.rkat` configuration, external symlink targets, OS Keychain entries, or shared provider credential stores. Keep your ordinary Mac/project backups too. Credentials outside the profile may require signing in again. Browser cookies tied to the original Mac may not be portable.

### Make an offline backup

The backup directory **contains plaintext secrets and private project data**. Store it on an encrypted volume you control. Do not upload it as a bug report or put it in a repository. The tool restricts filesystem permissions but does not encrypt the backup.

To fully quit the desktop app, choose **Meerkat T3 (Prototype) > Quit Meerkat T3 (Prototype)** from the menu bar. Closing its window leaves it running.

1. Use a build with restore-review support with the original profile at least once, record its version from About, and retain that exact app build. Finish or stop active work. Then quit the app, any standalone prototype server, and tools using its worktrees. Keep them closed throughout backup or restore. A supported restore pauses agent work until you review it, confirm resumption, and restart the app.
2. Open Terminal. These commands use the app's bundled runtime, so no separate Node installation is needed. The recovery script is included with new builds; if your build lacks it, ask the distributor for the matching `meerkat-profile-backup.mjs` file and set `meerkat_tool` to its path.
3. Set `meerkat_app` to the supplied Meerkat T3 app's location. The example uses the current release's Meerkat T3 (Prototype) app in Applications. Replace the backup output below with a new directory on your encrypted volume and `VERSION_FROM_ABOUT` with the version you recorded. The profile paths shown are the defaults. If you launched with a custom home or desktop-data path, use those original paths instead.

```sh
meerkat_app="/Applications/Meerkat T3 (Prototype).app"
meerkat_executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$meerkat_app/Contents/Info.plist")
meerkat_runtime="$meerkat_app/Contents/MacOS/$meerkat_executable"
meerkat_tool="$meerkat_app/Contents/Resources/meerkat-profile-backup.mjs"

ELECTRON_RUN_AS_NODE=1 "$meerkat_runtime" "$meerkat_tool" backup \
  --profile "$HOME/.meerkat-t3" \
  --desktop-data "$HOME/Library/Application Support/meerkat-t3" \
  --output "/Volumes/EncryptedBackup/Meerkat-before-update" \
  --app-version "VERSION_FROM_ABOUT" --confirm-closed --include-secrets
```

The tool prints the included roots after verifying the copy. Any additional roots must be supplied in the same order with `--native-state "/original/path"` when restoring. For a native state directory not referenced by current settings or saved agents, add it explicitly with that option when making the backup too. If a referenced directory is missing, stop and locate it; do not treat a partial copy as a complete backup.

Check that the result says **Restore review supported**. Older builds can still be backed up and their archives verified, but this tool refuses to restore an archive without matching restore-review support. Keep those archives unchanged. While the original profile is available, open it with a supporting build, quit, and create a fresh backup using that build's version. If the original profile is lost, keep the app closed and contact the distributor for recovery assistance. Do not edit an archive to bypass this check.

The tool refuses a source with a live server PID or open files. It also detects files changing during the copy. If it reports a busy profile, close the owning app or terminal yourself and retry; the tool never terminates processes. SQLite database, WAL, and shared-memory files are copied together. Stale process markers and Chromium singleton locks are excluded.

You can check the saved copy without starting Meerkat:

```sh
ELECTRON_RUN_AS_NODE=1 "$meerkat_runtime" "$meerkat_tool" verify \
  --backup "/Volumes/EncryptedBackup/Meerkat-before-update"
```

Verification detects missing files or changed bytes and reports whether restore review is supported. A verified older archive can still be unavailable for restore. Verification is not proof of who created a backup; restore only backups you trust.

### Restore without overwriting the current profile

1. Keep the app and its servers closed. Verify that the backup reports **Restore review supported**. Retain both the backup and the exact original app build. Use the backup's recorded version; do not downgrade a migrated profile in place.
2. Move the current app profile and desktop-data directories aside to new, unused names. Keep them until recovery is verified. Move any additional native roots aside too. The tool requires the original target locations to be absent and never merges into or replaces a profile. Supply the actual moved-aside directories with `--retained-profile`, `--retained-desktop-data`, and one `--retained-native-state` per external native root, in the same order. The tool checks these locations for live processes before staging and again before restoring.
3. Run the following with the original paths, actual moved-aside paths, recorded version, and any additional native roots printed during backup. The example assumes you moved the two profiles to names ending in `.retained`; replace them with the names you actually used. If all original directories have been lost, use the recovery mode below instead of inventing retained paths:

```sh
ELECTRON_RUN_AS_NODE=1 "$meerkat_runtime" "$meerkat_tool" restore \
  --backup "/Volumes/EncryptedBackup/Meerkat-before-update" \
  --profile "$HOME/.meerkat-t3" \
  --desktop-data "$HOME/Library/Application Support/meerkat-t3" \
  --retained-profile "$HOME/.meerkat-t3.retained" \
  --retained-desktop-data "$HOME/Library/Application Support/meerkat-t3.retained" \
  --app-version "VERSION_FROM_ABOUT" --confirm-closed --include-secrets
```

The tool verifies every copied file, prepares all roots, and adds a fresh restore-review marker before publishing them. Saved queues and delivery receipts remain unchanged, and any earlier permission to resume is replaced. If it reports a partial restore, keep the app closed, preserve the reported directories, and contact the distributor before retrying. It never deletes the old directories you moved aside.

### Recover when the original profiles were lost

If the app profile, desktop profile, and any external native state directories no longer exist, restore the backup to their original paths with `--originals-missing` instead of the `--retained-*` options:

```sh
ELECTRON_RUN_AS_NODE=1 "$meerkat_runtime" "$meerkat_tool" restore \
  --backup "/Volumes/EncryptedBackup/Meerkat-before-update" \
  --profile "$HOME/.meerkat-t3" \
  --desktop-data "$HOME/Library/Application Support/meerkat-t3" \
  --originals-missing \
  --app-version "VERSION_FROM_ABOUT" --confirm-closed --include-secrets
```

Include the same `--native-state` paths if the backup contains external native roots. Every destination must be absent. Do not use this mode for directories that you moved aside or delete surviving data to use it. If only some original directories were lost, preserve everything that remains and contact the distributor for partial-profile recovery.

Quit all Meerkat T3 instances and standalone servers first. This mode checks for recognizable app and server processes before preparing files and again before restoring, and stops if process inspection fails. It does not terminate anything or print process command lines. A custom or renamed server may not be recognizable, so these checks do not prove that every possible server is closed: `--confirm-closed` and `--originals-missing` confirm that you have closed them and the original directories are genuinely lost. Keep them closed throughout recovery. The same version, backup verification, and no-overwrite protections still apply. This remains same-user, same-Mac, same-path recovery.

### Review restored work before resuming

Open the retained original app build. Agent work remains paused while you inspect the restored profile. Choose **Review** in the **Restored work paused** notice to inspect saved work. Confirm that a saved task, a project specialist, an attachment, and the expected settings are present, and review recovery notices and waiting follow-ups. Native agent mailboxes cannot be inspected while their agents remain unloaded. A saved delivery receipt does not mean an external action can safely be repeated. Restoring a profile does not undo edits in external repositories or actions already taken by an agent.

When you are ready for pending work to resume, choose **Resume restored work** in the **Review restored work** dialog and restart the app. The notice changes to **Restart required**; confirming alone does not start agent work in the current process. Sign in again if needed. If you are unsure whether a waiting action already happened, keep work paused and ask the distributor for recovery assistance. Do not run the restored profile and its moved-aside copy at the same time: they share identities and project paths.

## Report a problem

Choose **Help > Export support report** in the desktop menu, or **Settings > Diagnostics > Export support report**, and select a folder. No editor or working backend is required. If startup fails after the desktop initializes, the error dialog also offers to export a report before quitting.

The report includes this Mac's app, Electron, and operating system versions, bundled Meerkat/MobKit build versions, and local backend readiness/restart status. Runtime versions come from the bundled manifest, not a live probe; a missing or invalid manifest is marked. It excludes conversations, credentials, file paths, raw logs, screenshots, and remote computer details. Nothing is uploaded automatically. Send the JSON file to the person who provided your build, with the smallest steps that reproduce the issue. A screenshot of the affected controls can help.

Review screenshots and any separately requested logs before sharing: they may contain project names, paths, prompts, or other private details. Do not share API keys, passwords, authorization headers, or a whole profile. Raw logs are separate from the support report; the Open logs folder action requires a configured editor.

If the operating system blocks the app or the desktop itself cannot initialize, an export dialog cannot run. Report the build version and the operating system message to the person who provided the prototype. There is no public Meerkat T3 support destination configured yet. Do not send Meerkat-specific reports to the original T3 project.

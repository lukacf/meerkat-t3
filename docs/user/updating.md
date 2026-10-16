# Updating MeerkaT3

## Preview updates

The current build uses ad-hoc signing and **manual updates**. It does not download or install updates automatically, and **Check for Updates** may say that updates are unavailable. That does not mean a newer Meerkat build does not exist.

No public desktop binary has been released yet. When packages are published, [MeerkaT3 Releases](https://github.com/lukacf/meerkat-t3/releases) will list them with release notes and checksums. If you already have a maintainer-supplied preview, use its replacement DMG or ZIP and the matching SHA-256 checksum. Source users should follow the [development runbook](https://github.com/lukacf/meerkat-t3/blob/main/docs/operations/development.md) to rebuild.

Original T3 downloads, Homebrew packages, `t3 update`, and `npx t3` update a different product. They are not an update path for MeerkaT3.

## Replace the app safely

1. Finish or stop current work. Review any saved follow-up queue and remove work you do not want to run later. Commit important project changes.
2. Verify the new DMG or ZIP using the [installation instructions](install.md#get-and-open-the-app). Record the current version from About and retain its matching app or download for recovery.
3. Choose **MeerkaT3 > Quit MeerkaT3** from the menu bar. If your supplied build has a different name, use its matching app menu and Quit command. Closing the window leaves the app running. Make an [offline profile backup](troubleshooting.md#make-an-offline-backup) while the app and any standalone server remain closed.
4. Install the replacement app in Applications using the DMG or ZIP instructions. Replace the old application bundle, keeping your saved profile. If the supplied app name has changed, move the old app aside and update any Dock shortcut so it opens the replacement.
5. Open the replacement from Applications, approve it in macOS if prompted as described in [installation](install.md#if-macos-asks-you-to-approve-the-app), and check its version. Check the provider connection, then reopen a saved task. Connect a saved specialist if needed; its current model and reasoning level become visible after connecting. Inspect recovery notices before retrying interrupted work.

Restarting can interrupt active agents and terminal commands. Saved history is not proof that an interrupted external action did or did not finish. Do not delete the profile as part of an update.

## When an update fails

Keep the error message, old application, and profile. [Report the failure](troubleshooting.md#report-a-problem) with both app versions and the step that failed. Do not run an older binary against a profile that a newer version has migrated without a supported recovery path. If you made an offline backup before updating, follow [Restore without overwriting the current profile](troubleshooting.md#restore-without-overwriting-the-current-profile) with the retained matching app build.

Use the MeerkaT3 version and release notes supplied with your replacement. The original T3 release history does not describe this app.

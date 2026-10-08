# Updating Meerkat T3

## Prototype updates

The current build uses ad-hoc signing and **manual updates**. It does not download or install updates automatically, and **Check for Updates** may say that updates are unavailable. That does not mean a newer Meerkat build does not exist.

Check the private [Meerkat T3 Releases](https://github.com/lukacf/meerkat-t3/releases) page for a newer Apple Silicon preview shared with you. Use the DMG or ZIP and SHA-256 checksum for the exact file and version you choose. Sign in with your invited GitHub account; repository access by invitation is required. Original T3 downloads, Homebrew packages, `t3 update`, and `npx t3` update a different product. They are not an update path for this app.

## Replace the app safely

1. Finish or stop current work. Review any saved follow-up queue and remove work you do not want to run later. Commit important project changes.
2. Verify the new DMG or ZIP using the [installation instructions](install.md#get-and-open-the-app). Record the current version from About and retain its matching app or download for recovery.
3. Choose **Meerkat T3 (Prototype) > Quit Meerkat T3 (Prototype)** from the menu bar. Closing the window leaves the app running. Make an [offline profile backup](troubleshooting.md#make-an-offline-backup) while the app and any standalone server remain closed.
4. Install the replacement app in Applications using the DMG or ZIP instructions. Replace the old application bundle, keeping your saved profile. If the supplied app name has changed, move the old app aside and update any Dock shortcut so it opens the replacement.
5. Open the replacement from Applications, approve it in macOS if prompted as described in [installation](install.md#if-macos-asks-you-to-approve-the-app), and check its version. Check the provider connection, then reopen a saved task. Connect a saved specialist if needed; its current model and reasoning level become visible after connecting. Inspect recovery notices before retrying interrupted work.

Restarting can interrupt active agents and terminal commands. Saved history is not proof that an interrupted external action did or did not finish. Do not delete the profile as part of an update.

## When an update fails

Keep the error message, old application, and profile. Contact your distributor for a compatible build and recovery steps. Do not blindly run an older binary against a profile that a newer version has migrated. If you made an offline backup before updating, follow [Restore without overwriting the current profile](troubleshooting.md#restore-without-overwriting-the-current-profile) with the retained matching app build.

Use the Meerkat T3 version and release notes supplied with your replacement. The original T3 release history does not describe this app.

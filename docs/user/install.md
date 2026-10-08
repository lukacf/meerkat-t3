# Install Meerkat T3

## Supported pilot

The current prototype is a **private pilot for Apple Silicon Macs**. Check Apple menu > About This Mac for an Apple M-series chip. The app requires macOS 13 or later. Intel Mac, Windows, Linux, mobile, and remote-host workflows are outside this pilot.

You need a provider API account with a valid key and access to the model you select, an internet connection for model requests, and a project folder. Git is needed for branches, worktrees, diffs, and commits. Building and testing your own project also requires that project's tools, such as Node.js or Python. The app includes Meerkat and MobKit; no separate Meerkat, Rust, Codex CLI, or Claude Code installation is required.

## Get and open the app

1. Open [Meerkat T3 Releases](https://github.com/lukacf/meerkat-t3/releases) and choose a published Apple Silicon preview. Download its DMG or ZIP and the SHA-256 checksum for that exact file and version. You may need repository access to see a private preview.
2. Compare the downloaded file's checksum with the value published for that release. In Terminal, type `shasum -a 256 `, drag the DMG or ZIP into the window, and press Return. If the values differ, request a fresh download.
3. For a DMG, open it and copy the supplied Meerkat T3 app to Applications, then eject the disk image. For a ZIP, expand it and move the app to Applications. Keep the supplied app name and open that copy, not the one in the disk image or Downloads.
4. Open it from Applications. This build uses ad-hoc signing, without Developer ID signing or Apple notarization. If macOS reports an unidentified developer or says Apple cannot check the app, follow the steps below.
5. Check the version in **About Meerkat T3**, then follow [Your first task](getting-started.md). The in-app guide is available from the sidebar's **Help** button before connecting a model account.

Original T3 downloads, `brew install --cask t3-code`, `npx t3`, and the T3 app-store clients install the donor product, not this prototype. Do not use them to install or update Meerkat T3.

**SSH** connections in Settings > Connections are disabled in this prototype. Use the local Mac for this pilot.

### If macOS asks you to approve the app

After checking the download and trusting its source, try opening the app once. In **System Settings > Privacy & Security**, find the message for Meerkat T3 and choose **Open Anyway**, then confirm **Open**. This approves that app; you do not need an Apple Developer account or a different signed build. [Apple's instructions](https://support.apple.com/en-us/102445) describe this per-app exception.

If that option is unavailable, or macOS says the app is damaged or will harm your computer, keep the exact message and contact the distributor. Do not disable Gatekeeper or remove quarantine with Terminal commands.

## If startup fails

Keep the error message and build version. Retry opening the app once. If it still fails, use [Recovery and troubleshooting](troubleshooting.md) or ask your distributor for a replacement build. Reinstalling the app should not require deleting your saved profile. Do not delete your data to fix a startup problem.

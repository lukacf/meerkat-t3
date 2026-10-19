# Install MeerkaT3

## Preview availability

[MeerkaT3 v0.1.0-preview.1](https://github.com/lukacf/meerkat-t3/releases/tag/v0.1.0-preview.1) is available as an Apple Silicon desktop prerelease. The source is available in [lukacf/meerkat-t3](https://github.com/lukacf/meerkat-t3), and contributors can [build from source](https://github.com/lukacf/meerkat-t3/blob/main/docs/operations/development.md).

The current desktop preview targets Apple Silicon Macs (arm64) running macOS 13 or later. Check **Apple menu > About This Mac** for an Apple M-series chip. Intel Mac, Windows, Linux, mobile, and remote-host workflows are outside this preview. Clean-Mac or isolated-VM installation verification remains deferred for this preview.

You need a supported provider account with access to the model you select, an internet connection for model requests, and a project folder. Connect it through browser sign-in, device sign-in, or an API key in Settings > Providers. Git is needed for branches, worktrees, diffs, and commits. Building and testing your own project also requires that project's tools, such as Node.js or Python. The app includes its agent runtime; no separate runtime or coding-agent CLI installation is required.

## Get and open the app

Get the DMG or ZIP, matching checksums and standalone installation guide from the [v0.1.0-preview.1 release](https://github.com/lukacf/meerkat-t3/releases/tag/v0.1.0-preview.1). Updates are [manual](updating.md); the app does not install them automatically.

1. Obtain the Apple Silicon DMG or ZIP and its SHA-256 checksum for the exact file and version. Use a package and checksum supplied together by the maintainers; do not substitute a T3 Code download.
2. Compare the downloaded file's checksum with the value published for that release. In Terminal, type `shasum -a 256 `, drag the DMG or ZIP into the window, and press Return. If the values differ, request a fresh download.
3. For a DMG, open it and copy the supplied MeerkaT3 app to Applications, then eject the disk image. For a ZIP, expand it and move the app to Applications. Keep the supplied app name and open that copy, not the one in the disk image or Downloads.
4. Open it from Applications. This build uses ad-hoc signing, without Developer ID signing or Apple notarization. If macOS reports an unidentified developer or says Apple cannot check the app, follow the steps below.
5. Check the version in **About MeerkaT3**, then follow [Start with your project](getting-started.md) to connect a model account and generate your project specialists. The in-app guide is available from the sidebar's **Help** button before connecting a model account.

Original T3 downloads, `brew install --cask t3-code`, `npx t3`, and the T3 app-store clients install the donor product, not MeerkaT3. Do not use them to install or update MeerkaT3.

**SSH** connections in Settings > Connections are disabled in this preview. Use the local Mac.

### If macOS asks you to approve the app

After checking the download and trusting its source, try opening the app once. In **System Settings > Privacy & Security**, find the message for MeerkaT3 and choose **Open Anyway**, then confirm **Open**. This approves that app; you do not need an Apple Developer account or a different signed build. [Apple's instructions](https://support.apple.com/en-us/102445) describe this per-app exception.

If that option is unavailable, or macOS says the app is damaged or will harm your computer, keep the exact message and contact the maintainers. Do not disable Gatekeeper or remove quarantine with Terminal commands.

## If startup fails

Keep the exact error message and build version, then retry opening the app once. If About is unavailable, select the installed app in Finder and choose **File > Get Info** to find its version. Record your macOS version from **Apple menu > About This Mac** too.

If the startup error offers **Export support report**, use that action. If the desktop menu is available, you can also choose **Help > Export support report** even when the workspace will not load. Choose a folder, then attach the saved JSON file to a [MeerkaT3 issue](https://github.com/lukacf/meerkat-t3/issues). It contains versions and startup status, excludes conversations, credentials and raw logs, and is not uploaded automatically.

If no app menu or export dialog appears, report the versions, exact message and the step that failed. You do not need to get into the app to report a launch failure. Once the app opens, [Recovery and troubleshooting](troubleshooting.md) has further recovery steps. Review screenshots before sharing them, and do not send API keys or a whole profile. Keep your saved profile when reinstalling; deleting it is not a startup repair.

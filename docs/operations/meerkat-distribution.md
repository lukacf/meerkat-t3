# MeerkaT3 distribution

This repository contains preview source using Meerkat and Meta 0.9.1. There is no
current public 0.9-based Mac binary yet. The supported distribution target is Apple
Silicon macOS, using ad-hoc signing and manual updates without an Apple Developer
account. Optional Developer ID signing and notarization require explicitly
configured Apple credentials. Record the actual signing status with each archive.

The owned destination for qualified binaries is
[lukacf/meerkat-t3 Releases](https://github.com/lukacf/meerkat-t3/releases). A fresh
clone calls this remote `origin`; a development checkout may call it `meerkat`.
Verify the URL before publishing. No MeerkaT3 Homebrew cask, public npm installer,
or managed updater feed is configured. Source visibility does not qualify a binary
for release. See the [release procedure](release.md).

## Website and installer handoff

Use the maintained [install](../user/install.md), [project setup](../user/getting-started.md), [accounts](../user/accounts.md), [updates](../user/updating.md), and [troubleshooting](../user/troubleshooting.md) guides as the product instructions. They are also bundled by `apps/web/src/components/help/guide.ts`; documentation edits reach the offline guide in the next app build, not an already produced archive.

For each binary handoff, supply the following with the delivered archive. The names below describe the default release-purpose package. An explicit internal-validation artifact uses the names and restrictions in [Native license notices](#native-license-notices); do not present that artifact as pilot or public-release qualification:

| Field                | Value                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product              | MeerkaT3                                                                                                                                                   |
| Audience             | Invited Apple Silicon Mac pilot users; macOS 13 or later                                                                                                   |
| Version              | Exact app version contained in the archive                                                                                                                 |
| Archive              | `Meerkat-T3-<version>-arm64.zip`                                                                                                                           |
| SHA-256              | Checksum computed from the exact archive being delivered                                                                                                   |
| App bundle           | `MeerkaT3.app`                                                                                                                                             |
| Install destination  | `/Applications`                                                                                                                                            |
| Signing status       | Unsigned release with ad-hoc code signing, no Developer ID team, and no notarization. Verify the actual delivered archive.                                 |
| Delivery and support | [Releases](https://github.com/lukacf/meerkat-t3/releases); [repository issues](https://github.com/lukacf/meerkat-t3/issues) or the maintainer for support. |
| Updates              | Manual replacement from owned Releases or the maintainer; no automatic update feed                                                                         |

Accompany the archive with its acceptance results and remaining limits. Distinguish checks run against that artifact from results retained from an earlier version. Do not claim a fresh-Mac install, real API-key replacement through the UI, subscription sign-in, or a remote GitHub workflow unless that journey has been verified. Never modify the archive behind a published checksum; a changed app needs a new artifact and checksum.

For a preview page, use the heading **MeerkaT3 for Mac** and the description **A workspace for long-lived project specialists. Generate agents around your repository's domains, then connect them to collaborate within and across projects.** Show **Build from source** until a current release asset is published and accessible; do not add a dead download button. Then label the owned artifact link **Download MeerkaT3 for Apple Silicon** and place its version, checksum, signing status, and install guide together. Account access uses provider billing; do not promise that a chat subscription includes API use.

The app guide routes are `/help?topic=install`, `/help?topic=start`, `/help?topic=accounts`, `/help?topic=updates`, and `/help?topic=recovery`. On a separate website, publish the maintained guide content at owned website URLs instead of sending visitors to app-local routes. The install guide leads to account setup, repository-generated project specialists, and peering within and across projects. Task coordinators and task-scoped workers support that workflow. Models and reasoning levels are user choices, while caching is automatic where supported.

The inherited marketing app is not ready to publish as that page. Its download page and release resolver still target the original T3 releases, its shell/PowerShell installers install the donor runtime, and its hosted/mobile links and legal pages describe the donor service. Replace those destinations and service claims before publishing an owned site. Do not relabel the existing installer scripts as Meerkat installers. Until an owned runtime package exists, the Mac archive is the intended binary delivery format.

## Identity and updater defaults

Default release-purpose installers use `Meerkat-T3-${version}-${arch}.${ext}`, package name `meerkat-t3`, and app ID `ai.rkat.meerkat-t3`. Their display name is MeerkaT3, with MeerkaT3 (Dev), MeerkaT3 (Nightly), and MeerkaT3 (Internal Validation) identifying development, nightly, and internal-validation builds. These display names do not change archive naming, app IDs, or profile locations. Explicit internal-validation builds retain the archive naming and restrictions described below.

Without `MEERKAT_DESKTOP_UPDATE_REPOSITORY`, the build explicitly sets `publish: null`. This disables electron-builder's repository inference and omits the updater feed. `GITHUB_REPOSITORY`, the Git remote, and the inherited `T3CODE_DESKTOP_UPDATE_REPOSITORY` do not select a feed. Preview versions always omit a feed.

When a signed release has an explicitly selected update repository, the build accepts its canonical `owner/repository` value through `MEERKAT_DESKTOP_UPDATE_REPOSITORY`. Unsigned Mac releases use manual replacement and cannot enable the updater feed. The build rejects the original `pingdotgg/t3code` repository, including case variants, and rejects URLs and `.git` aliases. No automatic update destination is configured by the source defaults. The configured fork URL is also used for package homepage metadata; unconfigured builds have no homepage rather than advertising the donor site.

The runtime independently validates the bundled updater YAML. Only a non-donor GitHub repository using the normal HTTPS GitHub host is accepted. Generic feeds are not accepted from the bundled file; the explicit developer mock-update option remains restricted to its loopback server. Auto-download and auto-install-on-quit are disabled even when a feed is rejected.

The web client uses `VITE_MEERKAT_RELEASE_REPOSITORY` for optional release-history links. Set it to the same real fork repository when configuring a release build. Without it, the UI links to the bundled update guide. It uses the same repository validator as the build and runtime.

Linux AppImage builds also produce a Debian package, which requires homepage metadata. Those targets now fail before staging unless `MEERKAT_DESKTOP_UPDATE_REPOSITORY` names an owned fork repository. Offline Mac builds do not require that setting. Linux remains outside the supported pilot.

SSH setup is disabled in the client and rejected at the desktop service boundary, including retries of saved SSH connections. The inherited installer downloads the original T3 CLI archive, so managed remote Meerkat computers need a supported installer and runtime package before this path can be enabled. Disconnect remains available to clean up existing tunnels.

## Frozen source installation

Install the source workspace with the pnpm version declared in `package.json` and `--frozen-lockfile`. If registry tarball fetches repeatedly fail, retry in a fresh isolated workspace with bounded download settings, within the build's overall time limit:

```sh
pnpm install --frozen-lockfile --network-concurrency=4 --fetch-timeout=300000
```

A missing host `@effect/tsgo-<platform>-<arch>` package makes `effect-tsgo patch` fail even though platform packages are declared optional. Treat this as an incomplete install: keep the lock and optional dependencies, and require the frozen install's `prepare` step to succeed. Do not bypass it with `--ignore-scripts` or remove optional packages. Installation success is only a prerequisite for build and package qualification.

## Frozen Apple Silicon production dependencies

The macOS arm64 desktop packager uses the reviewed production resolution in `scripts/desktop-production-resolutions/mac-arm64/`. It validates the generated dependency specifiers, Electron and package-manager versions, workspace settings, and selected patch bytes before installing with `--prod --frozen-lockfile`. Missing or changed inputs stop the build. App version, signing, publishing, and other build metadata still come from the current build.

The initial resolution is the full production-stage lock retained from the private `0.0.91` build. It is separate from the monorepo lock and the pruned `node_modules/.pnpm/lock.yaml`; neither is a substitute. Other desktop targets, the Windows server sidecar, and CLI archives still use their existing install paths and are not covered by this resolution.

When intentionally changing a dependency or installation setting:

1. Run the desktop packager with `--keep-stage`. It prints the retained staging directory even if resolution validation fails.
2. Review the generated `app/package.json`, `app/pnpm-workspace.yaml`, and selected patches there. In that isolated `app` directory, use the declared pnpm version to generate a candidate full lock with `install --lockfile-only --no-frozen-lockfile`.
3. Review the dependency changes and update the maintained `pnpm-lock.yaml` and `resolution.json` together. Copy dependency specifiers and package-manager version from the generated package; compute SHA-256 values from the exact workspace, selected patch, and full lock files. Do not copy the staged package's app identity or build configuration into the resolution.
4. Repeat the frozen installation and packaged native-load checks before qualifying a release. A lock records dependency resolution; it does not establish signing, toolchain reproducibility, offline package availability, or fresh-Mac compatibility.

## Native license notices

Start with [Reproduce native notice inputs](native-notices.md) to capture the exact
builds and prepare the package index, selected graph, and verified notice bundle.
The commands below consume that bundle when packaging the desktop app.

The desktop packager requires a prepared `apps/server/resources/native-notices/` bundle. Collect it with `scripts/collect-native-license-notices.mjs` using the exact gateway and resource-monitor Cargo locks, cached crate sources, and the reviewed dependency selection for the binaries being packaged. The collector does not rebuild the native runtime. Do not substitute a whole lockfile package list for the selected target and feature graph, or reuse a bundle merely because package versions match.

The bundle contains `manifest.json`, `selection.json`, `inventory.json`, `README.txt`, `T3-LICENSE`, and available notice texts. Its inventory distinguishes selected packages from all-target entries and records source provenance and missing inputs. The default `--artifact-purpose release` requires `collectionStatus: "collected"`. Every purpose verifies the target, both native binary hashes, both lock hashes, selected-graph hash, repository `LICENSE`, and every declared file. Changed binaries or locks, malformed bundles, unlisted files, and symlinks stop staging. Regenerate the bundle when its bound inputs change; do not edit its status to bypass missing inputs. Collection completeness does not establish legal clearance for distribution.

For private qualification only, explicitly pass `--artifact-purpose internal-validation`. This permits an incomplete collection while retaining its exact manifest, missing-input inventory and all integrity checks. Internal artifacts use the MeerkaT3 (Internal Validation) product/installer name and retain `INTERNAL-VALIDATION` in their filenames, default to `release-internal/`, and embed their purpose plus `meerkatPublicDistributionEligible: false` in package metadata. They omit public update feeds even when a release repository is configured; an explicitly requested loopback mock-update feed remains available for private tests. Unsigned builds and preview versions do not select this mode automatically. App IDs and profile locations are unchanged, so continue using the explicit isolated test-profile paths below. This mode does not qualify an artifact for public distribution.

The packaged app places the bundle at `Contents/Resources/native-notices/` on macOS, beside the existing native runtime. Read `README.txt` and `inventory.json` there to inspect its coverage and provenance. The unchanged T3 repository license is also copied to `Contents/Resources/LICENSE`. The existing npm notice manifest remains available through Settings and is collected independently; native notices do not replace it. Other native targets require their own matching bundle and dependency selection before packaging.

Mac packaging also preserves Electron's `LICENSE` and full `LICENSES.chromium.html` under `Contents/Resources/electron-notices/`. It verifies the installed Electron package and runtime versions match the pinned build version before copying them. Missing or empty notices stop packaging. If dependency installation skipped Electron's runtime download, run `node apps/desktop/scripts/ensure-electron-runtime.mjs` before packaging. This copy is necessary because electron-builder removes the original root notice files while assembling a Mac app.

## Desktop quit, relaunch, and support qualification

Run desktop lifecycle checks against the exact delivered app using an owned test profile. For a credential-free first-launch trial, use a disposable macOS user or VM without provider accounts, host credentials, or shared host folders. Separate profile directories and a sanitized launch environment do not establish credential isolation: [desktop startup](../../apps/desktop/src/shell/DesktopShellEnvironment.ts) reads login-shell settings, including `SSH_AUTH_SOCK` and XDG paths, and the [server](../../apps/server/src/os-jank.ts) also invokes a login shell to discover `PATH`.

For state-isolated checks in an existing user account, set both absolute `T3CODE_HOME` (server state) and `T3CODE_DESKTOP_USER_DATA_DIR` (Electron state) paths on every launch, use a separate local port, and reuse the same paths when relaunching. A normal Finder launch does not inherit shell overrides and therefore is not a valid relaunch of that isolated profile. Record credential isolation separately from application-state isolation.

Record VM and physical-Mac graphics results separately. A diagnostic build with hardware acceleration disabled can help identify a VM graphics failure, but does not qualify the unmodified release's startup rendering. Require visible, responsive UI; a renderer-ready log alone does not prove that the window painted.

Quit through the app menu's **Quit** action, using the running artifact's displayed name: **MeerkaT3 > Quit MeerkaT3** for the normal app, or the matching Dev, Nightly, or Internal Validation label for that build. Closing the last window on macOS leaves the app running. The default keyboard shortcut requires holding Command-Q or pressing it twice quickly. Verify that the owned app and backend processes exit and their listening port closes before relaunching.

Unexpected desktop process loss is not equivalent to Quit. Before copying, restoring, or relaunching a profile, verify that its prior app, backend and native processes have stopped. Never stop processes by name or a broad pattern. Record normal Quit and unexpected process-loss results separately in the delivered artifact's acceptance record. Neither establishes OS reboot recovery or safe replay of interrupted external actions.

On reopening, MeerkaT3 opens a new-thread draft in the most recently active project. Select a saved conversation in the sidebar to resume it; its unsent message and settings remain saved. This startup selection is separate from conversation retention. Check the saved history, unsent draft, model and reasoning selection, and a device preference after relaunch. Missing credentials should prevent sending while leaving saved history readable.

The native **Help > Export support report** action works without a provider account. It asks for a destination folder, writes a new `meerkat-t3-support-<uuid>.json` file, and confirms the path. Cancel should return without producing a report. The report includes product identity, selected system versions, bundled native manifest versions, and local primary-backend health. Bundled manifest metadata is not a live native-version probe. Logs, conversations, file paths, account names, credentials, environment variables, addresses, command lines, and screenshots are excluded.

## Local mock-update checks

Building with `--mock-updates` writes loopback feed metadata; it does not persist the runtime opt-in. Launch the packaged app executable from a shell with `T3CODE_DESKTOP_MOCK_UPDATES=true` and `T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT` set to the same port as the mock server and build. The default port is `3000`. Use separate `T3CODE_HOME` and `T3CODE_DESKTOP_USER_DATA_DIR` paths for the test profile. A normal Finder launch does not receive these shell variables and leaves the bundled generic feed disabled. Do not enable the mock opt-in for a managed release.

## Build a Mac release

Use `unsigned` for a release that does not use Apple credentials, `signed` to explicitly request Developer ID signing and notarization, or `internal-unsigned` for an Internal Validation artifact. Signing and artifact purpose are separate: `unsigned` uses normal release purpose and filenames. Only `internal-unsigned` selects Internal Validation purpose. There is no automatic signed-to-unsigned fallback.

With the source dependencies and prepared native resources available, local packaging needs only the mode and exact version:

```sh
MEERKAT_MAC_RELEASE_MODE=unsigned \
MEERKAT_MAC_RELEASE_VERSION=0.1.0 \
node scripts/build-meerkat-mac.ts
```

This produces DMG and ZIP files under `release-mac/` on an Apple Silicon Mac, with no updater feed or publication. Add `--plan` to inspect public parameters, or `--check` to validate configuration without packaging. No repository or CI environment is required when local updates are disabled. Native resources and their purpose-specific notice checks remain the same for signed and unsigned releases.

The reusable `.github/workflows/meerkat-mac.yml` prepares the same packages without invoking the inherited all-platform release workflow. Its CI inputs retain an explicit canonical owned repository matching the calling repository and a named GitHub environment for the job. These identify the CI/native-artifact context, not a publication step. No destination or account is preselected by this source configuration.

The caller supplies an existing same-repository native artifact by exact run ID and artifact ID, plus an independently reviewed SHA-256 of `meerkat-mac-native-inputs.json`. That manifest uses `{ "schemaVersion": 1, "target": { "platform": "macos", "arch": "aarch64" }, "files": { "repository-relative/path": "sha256" } }`. It contains the prepared `apps/server/resources/meerkat-runtime/` files, complete `apps/server/resources/native-notices/` tree, and `native/resource-monitor/target/aarch64-apple-darwin/release/t3-resource-monitor`. Include only those allowlisted paths and the manifest in the artifact. The staging helper verifies identity and every declared byte before copying them; the existing packager still verifies runtime compatibility, exact native/lock bindings, and purpose-specific notice completeness. The lane reuses this exact monitor instead of rebuilding it. It does not manufacture native qualification or missing notice text.

Signed mode requires `CSC_LINK` (certificate export), `CSC_KEY_PASSWORD`, `APPLE_API_KEY` (raw API key secret in the workflow), `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` through the selected secure Actions scope. The workflow writes the API key to a restricted temporary file and removes it when the step ends. Local invocation uses an existing file path in `APPLE_API_KEY`. Missing inputs stop before packaging; an unusable distribution signing identity or failed notarization fails the build. Signed builds refuse pull-request contexts and non-Mac hosts, where the underlying packager could otherwise skip signing. Local Meerkat does not need Clerk, associated domains or a provisioning profile. If the optional managed cloud sign-in is actually configured, or passkey RP domains are explicitly supplied, the existing passkey team/profile/domain requirements apply to that feature.

Unsigned modes ignore ambient signing credentials and disable identity discovery. Signed mode keeps the feed off unless `MEERKAT_MAC_RELEASE_ENABLE_UPDATES=true` (workflow input `enable_updates`) and an owned `MEERKAT_MAC_RELEASE_REPOSITORY` are explicitly selected. `--check` validates required input presence and the API key file for signed mode; it does not validate the certificate or notarization account. A signing or notarization failure stops that build. Package creation always uses `--publish never`; publishing the resulting files is a separate action.

Successful workflow jobs retain the exact DMG, ZIP, standalone installation guide, checksums and native-input receipt as an Actions artifact for 14 days. The same guide is generated from `docs/user/install.md` beside the app in both archives, so first-launch instructions can be read before opening the app. When updates are enabled, they also retain and checksum the two blockmaps and the selected Mac update manifest. Updates require a stable or supported nightly version; preview and other prerelease builds keep updates disabled. That is a build handoff, not a GitHub Release or public download destination. Before managed delivery, verify the produced artifact's identity and downloaded installation behavior. Verify a real update using isolated profiles if an updater feed is selected. Donor publishing and service-deployment workflows have been removed. The remaining workflow does not publish a release.

Keep the prior app and a complete [offline profile backup](../user/troubleshooting.md#make-an-offline-backup) for recovery. Verify that the archive reports restore-review support. Supported restores hold agent work until the user reviews it, confirms resumption, and restarts. Older archives remain verifiable but are refused by the restore tool; preserve them and create a fresh backup from the original profile using a supporting build. If the original profile is lost, preserve the archive for assisted recovery.

The server writes `meerkat-restore-review-capability.json` at the profile root (`ServerConfig.baseDir`, above `userdata` and `dev`) with `{ "version": 1, "appVersion": "<running app version>" }`. Packaged desktop launches pass the app version through bootstrap; standalone servers use their server package version. The offline tool marks a backup with `restoreReviewVersion: 1` only when that file is valid and matches the recorded app version. Restore retains the exact-version requirement, verifies all staged roots, and replaces any inherited `meerkat-restore-review.json` with a fresh version-1 marker containing a UUID `restoreId`, ISO `restoredAt` and `backupCreatedAt`, and the exact `appVersion`. The marker file and directory are synced before publication, and each destination parent is synced after publication. The tool never carries forward `consentedAt`; only the running server can record that consent. Queues and delivery receipts are copied unchanged. Keep this contract aligned between the server and bundled recovery tool when releasing a build.

# Releasing MeerkaT3

[v0.1.0-preview.1](https://github.com/lukacf/meerkat-t3/releases/tag/v0.1.0-preview.1)
is the Apple Silicon (arm64) Mac prerelease using the pinned Meerkat Core 0.9.2
backport and registry Meta 0.9.2. Its release page provides the DMG, ZIP,
installation guide and checksums. It uses ad-hoc signing and manual updates.
Clean-Mac or isolated-VM verification remains deferred, as recorded below.
Source publication and binary release qualification remain separate; use the
exact artifacts and limitations recorded for each release.

The owned release destination is
[lukacf/meerkat-t3](https://github.com/lukacf/meerkat-t3/releases). Never publish to
T3 Code's repository, npm package, hosted service, or update feed. Repository
visibility changes do not publish an installer.

## Prepare a release candidate

1. Select an exact source revision and version. If preparing an uncommitted local
   candidate, first capture its full source as described below. Install the frozen JavaScript
   dependencies and build the native gateway from that revision's `core/Cargo.lock`.
2. Run the supported CI checks and native boundary tests. For an upgrade, supply
   the actual previous executable to the restart test and retain its identity.
   Run `pnpm release:qualify` against the candidate's built server/runtime and
   supply both the current and previous packaged apps. The
   [qualification command](development.md#shared-collaboration-checks) retains
   test and cleanup receipts and refuses skipped acceptance. CI automatically
   runs its local-workflow, shared-workspace and offline recovery contracts; packaged
   acceptance still needs the exact release artifacts.
3. Prepare matching resource-monitor and native-license bundles. Every shipped
   binary, lockfile, dependency selection, and notice file must match the manifest.
4. Build the unsigned Mac candidate with the
   [distribution procedure](meerkat-distribution.md#build-a-mac-release). No Apple
   Developer account is required. Record that it uses ad-hoc signing and manual
   updates; do not describe it as notarized.
5. Install the exact archive on a clean Apple Silicon Mac or isolated VM. Verify
   first launch, account setup, model availability, project-specialist creation,
   peer collaboration, a normal development task, quit/reopen, saved state, and
   support export. Test the unmodified release renderer, not a diagnostic build.
   For shared-workspace support, also complete the
   [shared host acceptance](shared-host.md#release-acceptance) against these artifacts
   for the advertised hosting scope. Same-Mac hosting does not require a remote
   deployment; remote HTTPS operation has a separate rollout check.
6. Retain the source revision, native versions, dependency locks, artifact hashes,
   checks performed, and known limitations with the candidate. Publish only those
   exact tested bytes, with checksums and the standalone install guide.

The [reusable Mac workflow](../../.github/workflows/meerkat-mac.yml) is build-only.
It accepts exact same-repository native artifact IDs and a reviewed manifest hash,
then validates inputs before packaging. It does not run on tag pushes, create a
GitHub Release, publish npm packages, or deploy any hosted service. CI does not
possess provider account secrets or release credentials.

For a preview, publish a prerelease with clear platform, signing, update, and known
limitation notes. Keep a previous compatible installer and the offline recovery
instructions available. If bytes or dependencies change after acceptance, build and
verify a new candidate; do not silently replace a published artifact.

Clean-Mac or isolated-VM verification is deferred for `0.1.0-preview.1`. Keep that
gap in the candidate's qualification record and preview limitations until it is
completed. Testing on an existing Mac does not satisfy the clean-install check.

The full [distribution guide](meerkat-distribution.md) covers signing configuration,
notice completeness, isolated profiles, update defaults, and recovery constraints.

## Candidate provenance

A normal release should identify a reviewed source commit. The packaged build
label currently records a short Git `HEAD`; it does not describe uncommitted
changes. For a local candidate built from a dirty checkout, retain `HEAD` as
ancestry only and identify the source by an archive digest:

1. Stop editing the candidate checkout. Review its tracked and nonignored
   untracked file list, including deletions. Exclude ignored state, credentials,
   dependency installations and generated binaries. Do not use `git archive HEAD`
   as a substitute for the working source.
2. Archive those exact working bytes and executable modes, retaining symlinks as
   links without reading their targets. Record each relative path, type, mode,
   size and SHA-256 in an inventory. Normalize archive owner and timestamp
   metadata so another capture of unchanged source produces the same digest.
3. Verify the archive against the inventory without extracting external links.
   Compare the source inventory again after packaging. If source changed, discard
   that candidate's qualification and rebuild from a new captured source.

Before publishing a normal release, commit the reviewed candidate source and run
the supported CI gate on that exact revision. Build and qualify its versioned
artifacts, then create the owned release tag at that same commit. Attach the
tested ZIP, DMG, installation guide and checksums, with the runtime versions and
remaining acceptance limits in its release notes. Keep private profiles, raw test
logs and qualification archives out of the public assets. Download the published
assets and verify their checksums against the retained candidate; a tag or a
successful upload does not establish that the right bytes were delivered.

Keep this evidence private until its contents have been reviewed for publication.
An ignore file is not a secret scanner. The source archive excludes the generated
native resources, so retain their identities separately with the build:

| Input            | Record                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------- |
| Source           | Full ancestry commit, source archive and inventory SHA-256                              |
| JavaScript       | `pnpm-lock.yaml`, package-manager and Node versions, production resolution files        |
| Native gateway   | `core/Cargo.lock`, exact executable hash, provisioned runtime manifest and helper files |
| Resource monitor | Its `Cargo.lock`, exact arm64 release executable hash                                   |
| Native notices   | Complete manifest, selection and inventory, with `collectionStatus: "collected"`        |
| Outputs          | Exact ZIP and DMG hashes, standalone install guide, app version and signing status      |
| Acceptance       | Commands, results, tested artifact hashes and remaining limitations                     |

Use the [native notice capture procedure](native-notices.md) after the final native
changes. Reuse the captured binaries during packaging; do not rebuild a monitor
or provision another gateway against an older notice bundle. A successful
`--plan` or `--check` validates configuration only. Earlier 0.9.1 integration
results and screenshots remain historical evidence until the candidate's 0.9.2
artifacts complete the relevant checks.

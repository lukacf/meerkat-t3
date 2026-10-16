# Releasing MeerkaT3

MeerkaT3 source uses Meerkat and Meta 0.9.1. There is no current public 0.9-based Mac
binary yet. Source publication and binary release qualification are separate; an
old prototype artifact is not the executable for the current source.

The owned release destination is
[lukacf/meerkat-t3](https://github.com/lukacf/meerkat-t3/releases). Never publish to
T3 Code's repository, npm package, hosted service, or update feed. Repository
visibility changes do not publish an installer.

## Prepare a release candidate

1. Select an exact source revision and version. Install the frozen JavaScript
   dependencies and build the native gateway from that revision's `core/Cargo.lock`.
2. Run the supported CI checks and native boundary tests. For an upgrade, supply
   the actual previous executable to the restart test and retain its identity.
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

The full [distribution guide](meerkat-distribution.md) covers signing configuration,
notice completeness, isolated profiles, update defaults, and recovery constraints.

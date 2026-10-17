# Development

The supported contributor path is an Apple Silicon Mac with the local Electron,
web, and server stack. This repository includes the Rust gateway source; a separate
Meerkat App checkout is not required. The native dependency set is locked to Meerkat
and Meta 0.9.2 in `core/Cargo.lock`.

## First checkout

Install Git, Xcode Command Line Tools (`xcode-select --install`), Rust 1.97.0 through
[rustup](https://rustup.rs/), Node 24 matching `package.json`, and pnpm 11.10.0.
Use the package-manager version declared in `package.json` rather than regenerating
the lock with another version. Vite+ is installed as a repository dependency.

```sh
git clone https://github.com/lukacf/meerkat-t3.git
cd meerkat-t3
pnpm install --frozen-lockfile
pnpm native:build
pnpm dev:desktop
```

`native:build` builds the locked in-repository gateway and stages a runtime bundle
only after its binary identity, capabilities, target, helper handshake, and cleanup
have been verified. Run it again after changing native source or its lockfile.
Generated binaries and runtime manifests are not committed.

On first launch, add a model account in Settings before starting agent work. An
account is needed for live model requests, not for compiling the app or running the
loopback integration tests below. Never copy credentials into a test fixture.

For the local browser client, use `pnpm dev`. Open the complete pairing URL printed
by the dev runner; the bare origin does not authenticate a new browser.

## Development state and processes

The main checkout defaults to `~/.meerkat-t3/dev`. A linked worktree defaults to its
own `.t3/userdata`, even when `T3CODE_HOME` is set. Choose a completely separate
profile explicitly when testing recovery or an existing installation:

```sh
pnpm dev --home-dir /tmp/meerkat-t3-dev
```

Never point development at an installed user's profile. Prefer synthetic projects
and fixture data. A real profile includes private conversations and may refer to
credential stores outside that directory.

Read ports from the `[dev-runner]` output; occupied ports can shift the preference.
Stop only the process you started and whose PID you retained. Closing the last
Electron window on macOS is not the same as quitting the app.

`pnpm dev:server` and `pnpm dev:web` run the two services separately. Keep
`VITE_HTTP_URL` and `VITE_WS_URL` unset: Vite proxies backend requests through the
browser's origin. Hardcoding localhost breaks authentication and remote clients.

### Sharing a development instance

`pnpm dev --share` publishes the web port on the machine's tailnet and prints an
administrative pairing link. Give that complete link only to the intended tester.
The dev runner removes its mapping on exit. Sharing is not enabled for the desktop
dev command; use the browser stack for this test.

A fixed `T3CODE_DEV_AUTH_TOKEN` in a gitignored `.env` can reuse a development browser
credential across worktrees on one trusted hostname. It is an administrative secret,
not a public config value. Cookies reach services on other ports of that hostname;
use ordinary per-environment pairing if any of those services are untrusted. See
[environment authentication](../internals/environment-auth.md#reusable-dev-credential).

## Focused checks

Run checks from the package that owns the changed code. Before invoking desktop
Vitest directly, run `pnpm --filter @t3tools/desktop ensure:electron` once. The
package's normal `test` command does this automatically, before parallel test
imports can race to extract Electron:

```sh
pnpm --dir apps/server exec vp test run src/cli/triagePrompt.test.ts
pnpm --filter t3 typecheck
pnpm --filter @t3tools/web typecheck
pnpm --filter @t3tools/desktop typecheck
pnpm exec vp lint path/to/changed-file.ts
pnpm exec vp fmt --check path/to/changed-file.ts
```

The Ubuntu CI lane also compiles the inherited Linux browser-secret helper and
tests it with synthetic keyring responses. To run these desktop tests on Ubuntu
or Debian, install the compiler, package metadata tool, and libsecret headers:

```sh
sudo apt-get update
sudo apt-get install --yes --no-install-recommends build-essential pkg-config libsecret-1-dev
```

These tests do not require a desktop keyring or provider credentials. Linux test
coverage does not make Linux a supported preview distribution.

Native tests use the repository wrapper so concurrent checkouts do not share a
Cargo target directory:

```sh
scripts/repo-cargo test --locked \
  -p meerkat-desktop-contracts -p meerkat-desktop-gateway -p meerkat-desktop-stdio \
  -- --test-threads=2
```

The wrapper prints its cache and target paths with `scripts/repo-cargo --print-env`.
Build a debug executable for the actual Node-to-native boundary tests:

```sh
scripts/repo-cargo build --locked -p meerkat-desktop-stdio
native_target_dir="$(scripts/repo-cargo --print-env | sed -n 's/^CARGO_TARGET_DIR=//p')"
T3CODE_TEST_MEERKAT_BINARY="$native_target_dir/debug/meerkat-desktop-stdio" \
  pnpm --dir apps/server exec vp test run \
  src/provider/meerkat/MeerkatAuth.native.test.ts \
  src/provider/meerkat/MeerkatGatewayClient.native.test.ts \
  src/provider/meerkat/MeerkatGatewayClient.restart.native.test.ts
```

These suites use temporary state and loopback provider fixtures. An optional
`T3CODE_TEST_MEERKAT_PREVIOUS_BINARY` selects a specific previous executable for
cross-version migration testing. Its absence exercises same-version restart; it
does not qualify an upgrade from an older release.

Tests named `*.server.native.test.ts` and packaged-app acceptance tests require
additional explicit built-server or app paths. Read each test's entry conditions;
a skipped native suite is not evidence that its scenario passed. Tests must not
inherit paid provider credentials or modify an installed user's profile.

### Shared collaboration checks

The repeatable qualification command uses already-built inputs and runs these
contract suites in sequence:

- Local multi-worktree development, including peer reviews, steering, stopping,
  active tool and child deletion, and sibling isolation.
- Steering through threads, project specialists and owned children, with a
  separate successful cleanup receipt required for each surface.
- Queued work across client disconnects and server restart, plus specialist
  responsibility revisions and repository study refreshes.
- Shared specialists, two-person expansion, loopback TLS, composition restart,
  and offline recovery.

```sh
pnpm native:build
pnpm build:desktop
pnpm release:qualify \
  --server-entry "$PWD/apps/server/dist/bin.mjs" \
  --runtime-dir "$PWD/apps/server/resources/meerkat-runtime" \
  --evidence-dir "/tmp/meerkat-qualification-results"
```

Choose a new absolute evidence directory for each run. The command refuses local
`.env` files, uses fresh HOME and temporary paths, and starts test runners directly
from the frozen installation without inheriting provider keys or profile overrides.
It does not build, launch a GUI, or modify installed app profiles. Each fixture
owns its processes and native shutdown budget. The wrapper adds no forced timeout
and stops after the first failed suite or cleanup receipt.

The results directory retains a summary, exact server/runtime input hashes, test
reports, logs and native acceptance receipts. Skipped or missing tests, disabled
workflow peer controls, and failed cleanup cannot pass. Synthetic fixture directories remain at the recorded paths
for investigation; the result bundle does not copy profiles, databases or keys.
CI runs this same command after building the desktop stack, reusing its staged
native executable and server. The quality gate requires this lane to pass and
retains its evidence for 14 days.

To include packaged upgrade, snapshot and unavailable-preview-host checks, add
both `--current-app "/absolute/current/MeerkaT3.app"` and
`--previous-app "/absolute/previous/MeerkaT3.app"`. These must be the actual
candidate and previous executable, not two aliases for the same build. Packaged
executables, native manifests and every declared runtime file are bound before
and after the run. The current packaged runtime must match the staged runtime;
the previous runtime may differ. The local and shared workflow suites use the
explicit built server/runtime inputs; the three packaged suites run their server
from the supplied app archive using its Electron executable. With
neither supplied, the report explicitly records that packaged acceptance did not
run. Add `--plan` to validate and print inputs and the selected suites without
starting tests. UI, OAuth, live-model behavior, and general crash recovery remain
separate acceptance work.

For a focused change, the individual suites below remain available.

The focused shared services use disposable application SQLite and controlled
native or transport boundaries. For composition, delegation, interests and
correction behavior:

```sh
pnpm --dir apps/server exec vp test run \
  src/shared/SharedCompositionService.test.ts \
  src/shared/SharedDelegationService.test.ts \
  src/shared/SharedDelegationInterest.test.ts \
  src/shared/SharedWorkspaceStore.test.ts
```

Composition tests include a saved self-revision that continues only after native
idle, bounded continuation across service reconstruction, and split/consolidation
routing with existing request bindings preserved. These are application-contract
tests; controlled adapter responses do not prove native activation or a process
restart.

For the shared-specialist two-client acceptance test, build the locked runtime and
server bundle first, then opt in with their exact absolute paths:

```sh
pnpm native:build
pnpm --filter t3 build:bundle
T3CODE_TEST_MEERKAT_SERVER_ENTRY="$PWD/apps/server/dist/bin.mjs" \
T3CODE_TEST_MEERKAT_RUNTIME_DIR="$PWD/apps/server/resources/meerkat-runtime" \
  pnpm --dir apps/server exec vp test run \
  src/shared/SharedSpecialist.server.native.test.ts
```

This test owns its temporary host, model fixture and client connections. It does
not connect to an installed app or require model credentials. It checks exact
request outcomes, retained inbox batches and an orderly host restart against the
same disposable state.

The separate expansion fixture adds two personal servers, native local task
agents and distinct repositories/branches. Run it against the same freshly built
artifacts:

```sh
T3CODE_TEST_MEERKAT_SERVER_ENTRY="$PWD/apps/server/dist/bin.mjs" \
T3CODE_TEST_MEERKAT_RUNTIME_DIR="$PWD/apps/server/resources/meerkat-runtime" \
  pnpm --dir apps/server exec vp test run \
  src/shared/SharedExpansion.server.native.test.ts
```

To qualify the delegated transport over TLS, run the same fixture with its
explicit HTTPS mode:

```sh
T3CODE_TEST_SHARED_TLS=1 \
T3CODE_TEST_MEERKAT_SERVER_ENTRY="$PWD/apps/server/dist/bin.mjs" \
T3CODE_TEST_MEERKAT_RUNTIME_DIR="$PWD/apps/server/resources/meerkat-runtime" \
  pnpm --dir apps/server exec vp test run \
  src/shared/SharedExpansion.server.native.test.ts
```

This mode creates a disposable certificate authority and trusts it only in the
owned personal-server processes through `NODE_EXTRA_CA_CERTS`. It exercises WSS
delegation and revocation, plus rejected untrusted certificates, hostname
mismatches, credentials, scopes and participant identities. It qualifies the
loopback TLS transport, not a physical remote deployment or production reverse
proxy. It does not disable certificate verification globally.

The dated results below used Meerkat and Meta 0.9.1. They retain the identity of
those historical artifacts; rerun the fixtures for a 0.9.2 candidate.

The strengthened expansion fixture passed on 2026-10-17 in 94.79 seconds with
three real servers, no provider errors, and owned cleanup complete. It qualified
the artifacts in acceptance JSON SHA-256
`651c9be22bf681d14820f38c981aac706d5efc69e270cf24a83d3ba21a3152d1`,
including server entry SHA-256
`34d3456bb07ed06e48ad24ad8365186d1fd89921c6a30eea804f7e590f4ba75a`.
Its checks cover personal opt-in and captured objective publication, delegated
tool attribution, interest-matched briefings, correction notifications and search
lineage, independent specialist creation/peering, revocation, and self-revision
completed by host continuation after the native turn ends. The loopback model is
scripted, so success establishes the integration path rather than a live model's
ability to recognize overlap or decide how to organize specialists.

The separate composition restart fixture passed on 2026-10-17 in 67.92 seconds
with no provider errors and owned cleanup complete:

```sh
T3CODE_TEST_MEERKAT_SERVER_ENTRY="$PWD/apps/server/dist/bin.mjs" \
T3CODE_TEST_MEERKAT_RUNTIME_DIR="$PWD/apps/server/resources/meerkat-runtime" \
  pnpm --dir apps/server exec vp test run \
  src/shared/SharedComposition.server.native.test.ts
```

It requires a pending split with a native successor already created to survive an
actual host stop/reopen and finish through the saved background operation. It
also consolidates into a new native specialist while preserving an admitted
predecessor request and rejecting new work through superseded routing. The
original product request is completed before restart; only an unrelated native
control turn is interrupted. This distinguishes composition recovery from active
inference migration. Retain `shared-composition-acceptance.json` with its exact
server/runtime identity and cleanup result. The retained passing JSON has SHA-256
`c6f36987262934717910249c78280ad0ea800e49de71c8b494931482b59761f4`,
server entry SHA-256
`34d3456bb07ed06e48ad24ad8365186d1fd89921c6a30eea804f7e590f4ba75a`,
and runtime SHA-256
`638ef4a0b6659c897cffae06e57563530367e24b897831e69efe98d826a942ff`.
Later source changes require their own qualification.

Keep the generated `shared-expansion-acceptance.json` with the exact server hash,
runtime manifest and owned-cleanup result from the disposable test directory.
Missing opt-in paths skip these tests; a prior run against older source or a
success before cleanup does not qualify the final artifacts. The
[shared-workspace architecture](../internals/shared-workspace.md) describes the
authority boundaries and the remaining acceptance gates.

## Build and distribution

```sh
pnpm build:desktop
```

This builds the supported desktop stack without launching it or publishing a
release. It is separate from packaging an installable archive. Mac packaging also
requires matching resource-monitor and native-license bundles; see the
[distribution guide](meerkat-distribution.md). Do not bypass incomplete notices to
produce a public artifact.

The [CI workflow](../../.github/workflows/ci.yml) runs supported workspace checks and
native integration on GitHub-hosted runners without provider secrets. The inherited
mobile, hosted relay, marketing, Linux, and Windows trees are not part of the preview
release contract. Their presence does not imply a working MeerkaT3 installer.

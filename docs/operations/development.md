# Development

The supported contributor path is an Apple Silicon Mac with the local Electron,
web, and server stack. This repository includes the Rust gateway source; a separate
Meerkat App checkout is not required. The native dependency set is locked to Meerkat
and Meta 0.9.1 in `core/Cargo.lock`.

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

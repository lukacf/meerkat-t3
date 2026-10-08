# Meerkat T3

Meerkat T3 is a desktop workspace for coding with Meerkat and MobKit. Start with a task in a project, inspect the changes, and bring in persistent specialists when you need a second opinion. It builds on the open-source T3 Code interface.

## Current availability

This is a **Meerkat T3 preview for Apple Silicon Macs**. The Meerkat runtime is included. You do not need to install Meerkat, MobKit, Rust, or another coding-agent CLI to use the packaged app.

The canonical source is [lukacf/meerkat-t3](https://github.com/lukacf/meerkat-t3). Preview downloads, their version/checksums, and the external installation guide appear on this repository's [Releases](https://github.com/lukacf/meerkat-t3/releases) page when a release is published. Repository access may be required while the preview is private. Updates are manual; no automatic update feed is configured. This build uses ad-hoc signing without Developer ID signing or notarization. Follow the [installation instructions](docs/user/install.md), including the per-app macOS approval steps if prompted.

The original T3 website, package-manager packages, hosted web app, and mobile apps are separate products. They do not install this Meerkat prototype. Other operating systems and remote/mobile use are not part of the supported pilot.

## Start here

1. [Install the prototype](docs/user/install.md) on a supported Mac.
2. [Connect a model account](docs/user/accounts.md). The self-service path uses a provider API key and that provider's billing. A chat-app subscription alone is not an API credential.
3. [Complete your first task](docs/user/getting-started.md), then optionally [ask a project specialist to review it](docs/user/agents.md).

The same guide is available offline from **Help > Meerkat T3 Guide** in the app, or the sidebar's **Help** button.

## How T3 fits into Meerkat

Meerkat Core runs the agents, and this prototype uses MobKit for application-level coordination. MobKit is being renamed Meerkat Meta in the wider ecosystem. T3 brings the runtime into a project workspace with conversations, specialist agents, and change review.

Connect focuses on optional integration discovery and setup. Recall provides shared knowledge grounded in source evidence. These are separate ecosystem components; neither is required to start using this prototype. See the [Meerkat documentation](https://docs.rkat.ai/introduction) for platform concepts and other ways to build with Meerkat.

## Help and maintenance

- [Permissions and access](docs/user/permission-modes.md)
- [Messages, steering, and queued work](docs/user/agents.md#follow-up-messages)
- [Recovery and troubleshooting](docs/user/troubleshooting.md)
- [Updating this prototype](docs/user/updating.md)
- [Data and privacy](docs/user/telemetry.md)
- [All documentation](docs/README.md)

For preview support, use this repository's [issues](https://github.com/lukacf/meerkat-t3/issues) or contact the person who provided your build. Include its version and the steps that failed, without API keys or private project data. Do not report Meerkat-specific problems to the original T3 maintainers.

## Developing the app

This repository preserves T3 Code history and adds the Meerkat integration plus the native Rust workspace under `core/`. The donor is [pingdotgg/t3code](https://github.com/pingdotgg/t3code); this repository is the Meerkat T3 source and release destination. See [AGENTS.md](AGENTS.md), the [development runbook](docs/operations/development.md), and [architecture overview](docs/internals/overview.md). Development instructions are for contributors, not prerequisites for using the packaged app.

Install the project Node dependencies with `vp i`. The accepted native build used Rust 1.97.0 on `aarch64-apple-darwin`. To build and stage the native runtime from this combined checkout, run from the repository root:

```sh
CARGO_BUILD_JOBS=2 node scripts/build-meerkat-runtime.ts --source "$PWD" --build
```

This invokes the locked Rust build and runtime handshake. `scripts/repo-cargo` manages an external target cache and requires a real Git checkout; do not assume the binary is in `core/target`. Toolchain and registry dependencies are external build prerequisites. A fresh source build is not a promise of byte-identical release binaries. See the [Meerkat distribution runbook](docs/operations/meerkat-distribution.md) for prepared native inputs, packaging and the separate publication step. Inherited donor workflows are retained as source; GitHub Actions is disabled for this destination until a maintainer deliberately configures an owned workflow.

T3 Code attribution and its MIT license remain unchanged in [LICENSE](LICENSE). The added native Cargo packages declare MIT; their accompanying terms and attribution limits are in [core/LICENSE-MIT](core/LICENSE-MIT) and [core/NOTICE](core/NOTICE). The donor copyright is not an attribution to those native packages. The inherited provider, mobile, and server documentation describes donor features and does not expand the supported Meerkat pilot.

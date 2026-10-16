# MeerkaT3

A desktop development workspace for long-lived project specialists. MeerkaT3 studies your repository, proposes agents for its domains, and lets you connect them to work together within and across projects.

Your API specialist can coordinate a contract change with the client specialist in another repository. Each keeps its own responsibilities and conversation, working in its owning project's checkout. Task threads bring those specialists together for a particular change, with temporary workers when needed.

## Start here

The current preview targets **Apple Silicon Macs running macOS 13 or later**. This repository contains the source; a public desktop download has not yet been published.

- **Evaluate the source:** follow [Build from source](docs/operations/development.md). Development requires the documented toolchain and native runtime build.
- **Already have a preview build:** follow [Install MeerkaT3](docs/user/install.md), then the [first-project guide](docs/user/getting-started.md). The packaged app includes its agent runtime.

Once the app is running:

1. **Connect a model account** in Settings > Providers. Sign in or add an API key using the methods offered for your account. Available models depend on that account's access.
2. **Open or create a project.** Start a repository study, review the proposed specialists and their assignments, and prepare the ones you need.
3. **Connect the specialists.** Drag one agent onto another, or use Connections. Connections can cross projects on the same computer.
4. **Give a specialist an objective.** Ask it to coordinate with the relevant peers, inspect the resulting changes, run your project's checks, and commit the work you want to keep.

The [user guide](docs/README.md#use-meerkat3) covers the complete workflow and is also available offline through **Help > MeerkaT3 Guide**.

## Work that stays with the project

| Concept            | Use it for                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| Project specialist | A durable responsibility in your repository, with its own instructions and conversation.               |
| Peer connection    | Collaboration between specialists or task coordinators, within one project or across related projects. |
| Task thread        | A focused change, with a coordinator and selected project specialists.                                 |
| Worker             | A helper created for part of a task, alongside the project's long-lived specialists.                   |

Repository studies propose domain ownership from your code rather than requiring a preset team. You review assignments before applying them and can refine them as the project changes. Connections allow agents to exchange messages; they do not merge histories or move an agent into another checkout.

The workspace includes conversations and images, steering and queued follow-ups, files, terminals, change review, Git worktrees, and pull request workflows. Read [Work with project specialists](docs/user/agents.md) for peering, permissions, and returning to saved work.

## Preview scope

The supported workflow is the local Mac desktop app. Windows, Linux, mobile clients, remote installation, and the original T3 hosted services are outside this preview. Retained upstream integrations are identified as reference material in the documentation.

Model access is configured through accounts, with recommended and supported models shown for each connection. Model credits are not included. The runtime runs locally; hosted model requests send their context to the selected provider. See [Accounts](docs/user/accounts.md), [Permissions](docs/user/permission-modes.md), and [Data and privacy](docs/user/telemetry.md).

Preview packages use ad-hoc signing without Apple notarization and are updated manually. Source publication does not establish a binary release or an automatic update channel. Published artifacts, when available, will be listed on [MeerkaT3 Releases](https://github.com/lukacf/meerkat-t3/releases) with their versions and checksums.

## Built on Meerkat and T3 Code

[Meerkat Core](https://github.com/lukacf/meerkat) owns agent execution, model access, tools, and durable session state. Meerkat Meta, formerly MobKit, provides the application-facing coordination layer. This integration uses **Meerkat and Meta 0.9.1**. The desktop workspace builds on [T3 Code](https://github.com/pingdotgg/t3code).

MeerkaT3 uses the bundled Meerkat runtime for its agents. Connecting an OpenAI, Anthropic, Google, or Copilot account selects model access through that runtime; it does not require another coding-agent CLI.

## Contribute and get help

- [Documentation](docs/README.md) - user guides, development, and architecture.
- [Contributing](CONTRIBUTING.md) - setup, focused checks, and change proposals.
- [Code of conduct](CODE_OF_CONDUCT.md) - community expectations and reporting concerns.
- [Troubleshooting](docs/user/troubleshooting.md) - interrupted work, recovery, and support reports.
- [Issues](https://github.com/lukacf/meerkat-t3/issues) - reproducible bugs and feature proposals for this project.
- [Security policy](SECURITY.md) - report a vulnerability privately.

For a bug, include the app version, macOS version, steps to reproduce, and what happened. Review attachments before sharing; do not post credentials, private conversations, or an app profile. Please report MeerkaT3 issues here, rather than to the original T3 maintainers.

## License

MeerkaT3 retains T3 Code's [MIT license and attribution](LICENSE). Bundled dependencies have their own licenses; the app includes [third-party notices](docs/user/open-source-licenses.md).

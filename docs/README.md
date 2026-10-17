# MeerkaT3 documentation

MeerkaT3 is a desktop workspace for long-lived project specialists and the connections between them. The supported preview is the local Apple Silicon Mac app. Start with the user guides below; no previous Meerkat experience is required.

## Use MeerkaT3

| I want to...                              | Read                                                            |
| ----------------------------------------- | --------------------------------------------------------------- |
| Install a preview build                   | [Installation and availability](user/install.md)                |
| Set up my first repository                | [Start with your project](user/getting-started.md)              |
| Sign in and choose a model                | [Providers and accounts](user/accounts.md)                      |
| Generate specialists and connect projects | [Project specialists and peering](user/agents.md)               |
| Share specialists across local checkouts  | [Shared specialists (experimental)](user/shared-specialists.md) |
| Understand what agents can do             | [Permissions and access](user/permission-modes.md)              |
| Recover interrupted work or report a bug  | [Recovery and troubleshooting](user/troubleshooting.md)         |
| Replace a preview build                   | [Updates](user/updating.md)                                     |
| Understand local data and model requests  | [Data and privacy](user/telemetry.md)                           |
| Find dependency attribution               | [Open-source licenses](user/open-source-licenses.md)            |

These guides are also bundled offline in **Help > MeerkaT3 Guide** and the sidebar **Help** button, including before you connect a model account.

## Everyday work

- [Messages and context](user/composer.md) - attachments, follow-ups, model choices, and references.
- [Working with threads](user/thread-sidebar.md) - task workspaces, finding work, and keeping the sidebar useful.
- [Source control](user/source-control.md) - GitHub setup, commits, pull requests, and linked reviews.
- [Terminal](user/terminal.md) - local commands and retained output.
- [Project settings](user/project-settings.md) - project overrides, actions, and worktree defaults.
- [Usage](user/usage.md) - recorded native token counts and their limits.
- [Keyboard shortcuts](user/keybindings.md) and [appearance](user/appearance.md).

## Develop MeerkaT3

Start with [Contributing](../CONTRIBUTING.md) and the [development runbook](operations/development.md). The [distribution runbook](operations/meerkat-distribution.md) describes app identity, runtime packaging, notices, and manual previews.

For a shared workspace, see [Operating a shared specialist host](operations/shared-host.md)
for HTTPS access, maintenance, backup and acceptance checks.

The source includes the T3 workspace and its Meerkat integration. Public source availability does not mean a public binary has been released. Use the [repository release page](https://github.com/lukacf/meerkat-t3/releases) for published artifacts and the installation guide for supported use.

For architecture and integration boundaries:

- [Architecture overview](internals/overview.md)
- [Glossary](internals/glossary.md)
- [Connection runtime](internals/connection-runtime.md)
- [Provider integration](internals/providers.md)
- [Model classification](internals/model-manifest.md)
- [Environment authentication](internals/environment-auth.md)
- [Shared specialist authority and recovery](internals/shared-workspace.md)
- [License notice pipeline](internals/open-source-licenses.md)
- [Reproduce native notice inputs](operations/native-notices.md)

## Inherited T3 reference material

Some source and documentation remain from upstream T3 Code. Pages marked **Inherited T3 reference** describe those original features and are not the supported MeerkaT3 setup. In particular, original T3 CLI installation, alternate agent runtimes, hosted services, mobile clients, and remote installation do not install or extend this preview.

This material is retained for contributors working on the donor code:

- Agent-runtime references: [Codex](user/providers-codex.md), [Claude Code](user/providers-claude.md), [OpenCode](user/providers-opencode.md), and [Antigravity](user/providers-antigravity.md).
- Other surfaces: [remote access](user/remote-access.md), [background service](user/background-service.md), [mobile notifications](user/mobile-notifications.md), and [devices](user/devices.md).
- Additional interface references: [browser import](user/browser-import.md), [SnapShot](user/snap-shot.md), [keyboard focus](user/keyboard-focus.md), and [question attachments](user/question-attachments.md).

Follow [Providers and accounts](user/accounts.md) for MeerkaT3 model access. The original T3 website, packages, and app-store clients are separate distribution channels.

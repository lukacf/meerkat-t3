# Meerkat T3 documentation

## Using the prototype

The supported pilot is the maintainer-distributed Apple Silicon Mac app. Start here:

- [Install Meerkat T3](user/install.md)
- [Your first task](user/getting-started.md)
- [Accounts and billing](user/accounts.md)
- [Projects, specialists, and collaboration](user/agents.md)
- [Permissions and access](user/permission-modes.md)
- [Recovery and troubleshooting](user/troubleshooting.md)
- [Updates](user/updating.md)
- [Data and privacy](user/telemetry.md)
- [Open-source licenses](user/open-source-licenses.md)

The app includes this guide under **Help > Meerkat T3 Guide** and the sidebar Help button, including when you have not connected a model account.

## Shared interface references

These inherited T3 guides explain shared controls. Provider-specific, hosted, mobile, and remote-host features are not a promise of support in the Meerkat pilot. Follow the Meerkat guides above when behavior differs.

- [Ordinary thread composer](user/composer.md)
- [Thread sidebar](user/thread-sidebar.md)
- [Terminal](user/terminal.md)
- [Source control](user/source-control.md)
- [Project settings](user/project-settings.md)
- [Keyboard shortcuts](user/keybindings.md)
- [Appearance](user/appearance.md)

---

## Working on T3 Code

For this fork's app identity and disabled-by-default update feed, see [Meerkat distribution](operations/meerkat-distribution.md). The inherited release machinery is not a configured Meerkat publishing pipeline.

Start with the [development runbook](./operations/development.md) and
[contribution policy](../CONTRIBUTING.md).

Internal notes preserve architectural decisions, constraints, and implementation traps that the
source alone does not explain. Most code changes do not need an internal documentation update. Follow the
[documentation rules](../AGENTS.md#documentation) before adding one.

- [Architecture overview](./internals/overview.md)
- [Glossary](./internals/glossary.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Providers](./internals/providers.md)
- [Pull request file revisions](./internals/pull-request-file-revisions.md)
- [Model classification](./internals/model-manifest.md)
- [Remote environments](./internals/remote.md)
- [Server updates](./internals/server-updates.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Product analytics](./internals/product-analytics.md)
- [Environment auth](./internals/environment-auth.md)
- [T3 Connect](./internals/t3-connect.md)
- [Assistant citations](./internals/assistant-citations.md)
- [Mobile navigation](./internals/mobile-navigation.md)
- [Mobile development lifecycle](./internals/mobile-development.md)
- [Terminal runtime](./internals/terminal-runtime.md)
- [Devices](./internals/devices.md)
- [Voice input](./internals/voice-input.md)

### Runbooks

- [Development and local builds](./operations/development.md)
- [T3 Connect setup](./operations/connect-setup.md)
- [Release](./operations/release.md)
- [Observability](./operations/observability.md)
- [Relay observability](./operations/relay-observability.md)
- [Mobile app store screenshots](./operations/mobile-app-store-screenshots.md)

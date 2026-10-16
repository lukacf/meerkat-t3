# Data and privacy

MeerkaT3 runs its agent runtime locally, but using a hosted model sends that model's request context to the provider account you selected. Context can include your messages, attached images, project files, and tool results. Review the provider's terms and your project's data requirements before using sensitive material.

Conversations, agent state, settings, and media are saved in this app's local profile. Project files stay in their selected checkout. A connection between agents allows messages; it does not merge all conversation histories. Sharing a browser workspace is an additional explicit capability.

Product analytics are **off by default in this preview**. To enable them, the server operator must set `T3CODE_TELEMETRY_ENABLED=true`, `T3CODE_POSTHOG_KEY` to their own PostHog project key, and `T3CODE_POSTHOG_HOST` to that project's ingestion base URL. There is no built-in analytics destination. If either destination setting is missing or blank, analytics stay disabled and no analytics identifier is read or created.

When enabled, analytics include provider, model, permission mode, turn result, duration, and main-agent token totals where available, associated with a hashed account or installation identifier. They do not intentionally include prompts, responses, file contents, authentication tokens, or child-agent output. Child-agent token use is excluded, so analytics are not a complete billing ledger.

Diagnostics and screenshots can contain private project details. Review them before sharing and never include credentials or a whole profile in a bug report. See [Recovery and troubleshooting](troubleshooting.md).

# Usage and model costs

Open **Usage** and choose **Load recorded usage** in **Meerkat lifetime tokens**. This reads recorded coordinator, project-specialist, and worker tokens from the selected connection's current storage. Use **Refresh snapshot** for a newer reading.

Preparing a team starts a separate study for each selected specialist. Task coordinators and workers can make additional requests using the configured model account. Start with the specialists you need and check your provider's usage as you expand the team.

## Read the snapshot

The snapshot shows when it was taken and how many retained sessions and stores it includes. Retained sessions are counted even when their agents are disconnected.

- **Input** includes cache tokens.
- **Output** includes reasoning tokens.
- **Cache read**, **Cache write**, and **Reasoning** give the corresponding breakdowns when reported. Do not add them again to input or output.
- **Not reported** means a measurement is unknown, not zero.

If a storage read is incomplete, the app shows the problem and withholds the total. Resolve the reported issue before comparing the snapshot with another one.

## What the snapshot does not tell you

Lifetime snapshots exclude previous storage locations and auxiliary generation, such as titles. They are separate from inherited period charts and dollar estimates. Connections sharing the same storage can overlap, so their snapshots are not added together.

An empty chart or a zero in a chart below the snapshot does not mean there has been no agent usage. These views are not an account invoice or a spending limit. Use your model provider's billing and usage page for actual charges, subscription limits, and remaining quota.

[Providers and accounts](accounts.md) explains account defaults, model access, and authentication methods. The app does not include model credits.

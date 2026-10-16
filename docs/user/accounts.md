# Providers and accounts

## Connect a model account

Open **Settings > Providers** on the computer that will run your projects. You can connect an account before creating a project. First-run setup uses the same account controls.

Choose your provider and an authentication method:

- **OpenAI:** sign in with ChatGPT or add an OpenAI API key.
- **Anthropic:** sign in with Claude or add an Anthropic API key.
- **Google:** sign in with Google Code Assist or add a Gemini API key.
- **GitHub Copilot:** follow the device sign-in instructions.
- **Azure OpenAI:** add the API key, endpoint and deployment name.
- **Amazon Bedrock:** add a bearer token, endpoint and model or inference profile.
- **Microsoft Foundry:** add an API key, endpoint and Claude deployment name.

Follow the browser or device instructions for sign-in. For API access, enter credentials in the provider form and save them there. Never paste credentials into a conversation or bug report. Only methods supported by this build are offered.

API requests use the API account's billing and quota. Browser sign-in uses the connected service's account and access rules; it does not convert a chat subscription into a general API key. This app does not include model credits. GitHub access for repositories is configured separately from model access.

## Accounts and defaults

You can keep more than one account, such as personal and work accounts. Give each a recognizable name and choose the default account for its provider. New projects inherit accounts configured for this computer. Account links from a project or conversation preserve that project's configuration, including a specific checkout when applicable.

Review the selected computer and account before changing credentials. A project-specific account can take precedence over the computer's default. Open Providers from the affected conversation when you need to change the account used by that checkout.

**Remove account** removes that account's saved configuration and credentials from this device, including its model connections. Agents and conversations remain saved. It does not revoke your account at the provider or remove credentials supplied elsewhere on the computer. Accounts managed outside the app may need to be changed at their source instead.

## Connection status and models

After signing in, return to the app and wait for the account result. Finishing the provider's browser page alone does not confirm that the app received the credentials. API-key accounts show **Key saved**; browser accounts show **Connected** when credentials are available.

Recommended models are the suggested starting choices for that connection. Expand supported models to see the other choices. The list depends on your account and connection method: a ChatGPT sign-in and an OpenAI API key can offer different models, and Copilot uses its own account's model access. A catalog-supported model is not a promise of entitlement, quota, or a successful request.

**Not verified** means the app has account configuration but has not confirmed usable credentials. Choose **Check account** when offered; this may ask the operating system to allow access to saved credentials. Reconnect if the check reports that sign-in is required. An unverified configuration does not count as a connected account.

If a Copilot account is connected but its models have not been verified, **Check account** also refreshes that account's model discovery. Use the model-list refresh action after other account changes. If no models appear, keep the reported error and follow [Troubleshooting](troubleshooting.md#my-saved-model-or-account-is-unavailable).

For an expired or revoked credential, reconnect or save a replacement for the same account. For quota, model access, endpoint, or network errors, correct the reported problem and retry the original task. Send a small non-sensitive message to confirm the complete path after configuration.

## Model and reasoning

Choose a model and, when offered, its reasoning level. **Model default** uses that model's default reasoning. Review the level again when switching models, since the available choices differ.

For an existing project agent, **Use current agent model** keeps its saved model and reasoning after reconnecting or restarting the app. A label such as **Current: Xhigh** reports the saved level. Keeping current also preserves settings that the picker cannot describe. An explicit change applies to your next message when the agent is idle.

Prompt caching follows the model backend's automatic policy; there is no cache switch to configure. Support and cache hits vary by provider and request, so a saving is not guaranteed.

## GitHub repositories

Git and GitHub CLI are separate tools; the preview does not install them. On a fresh Mac:

1. Install [Git](https://git-scm.com/downloads) and [GitHub CLI](https://cli.github.com/) 2.81.0 or newer. Open Terminal and check `git --version` and `gh --version`.
2. Run `gh auth login --hostname github.com` in Terminal. Choose HTTPS for the clone path described here and follow the sign-in prompts using an account that can access your repository.
3. Return to **Settings > Source Control** for this computer, choose **Rescan**, and confirm that GitHub is **Authenticated**. Settings detects the external login; it does not perform sign-in.

New HTTPS clones from github.com can reuse that login automatically when Git has no custom credential setup. This connection is saved for the checkout, so later fetches and pushes use your active GitHub CLI account after restarting the app.

Existing Git credential helpers keep their current behavior. If GitHub is connected in Settings but a private clone cannot authenticate, run `gh auth login --hostname github.com` and `gh auth setup-git --hostname github.com` on the project's computer, then retry the failed clone. The second command configures Git to use your GitHub CLI account. SSH and GitHub Enterprise repositories use their separately configured Git access. A repository-not-found error can also mean the address is wrong or the selected account lacks access.

## Several agents can make several requests

Project specialists, task coordinators, and workers can each use the provider account. Preparing a proposed team starts a separate repository study for each selected specialist. Review the proposed assignments and select the smallest team that covers the domains you need. Inspect activity and provider usage as you add or connect specialists.

In **Usage**, load a lifetime-token snapshot to see recorded coordinator, specialist, and worker tokens in the selected connection's current storage. Retained sessions are included even after their agents have been unloaded. Missing measurements remain unknown, and an incomplete storage read produces no total. Cache tokens are included in input tokens; reasoning tokens are included in output tokens.

These snapshots exclude auxiliary generation, such as titles, and previous storage locations. They are not part of the period charts or dollar estimates. Connections that share storage can overlap, so their snapshots are not added together. Do not read an empty chart or a zero there as zero spend. Use your model provider's billing/usage view for account totals; estimates and missing prices in this app are not a spending limit.

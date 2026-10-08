# Accounts and billing

## Choose the account that will run your model

Meerkat is the agent runtime bundled with the app. The model comes from the provider you connect, such as OpenAI, Anthropic, or Google. The self-service prototype path uses that provider's API key.

A subscription to a provider's chat app and access to its API are different products. Use an API account with billing or quota and access to the model you select. Model requests are billed by that provider. Meerkat T3 does not include model credits. The source-control account used to clone or publish code is separate again.

## Get an API key

Choose the provider whose models you want to use:

- **OpenAI:** Sign in to the [OpenAI API keys page](https://platform.openai.com/api-keys) and create a key for your API project. [API billing](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform) is separate from your ChatGPT subscription.
- **Anthropic:** Open [Claude Console API keys](https://platform.claude.com/settings/keys), choose **Create key**, and scope it to the workspace you will use. Set up API billing in the Console; a [paid Claude chat plan does not include API access](https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console).
- **Gemini:** Open [Google AI Studio API keys](https://aistudio.google.com/api-keys) and create a key in the Google Cloud project you want to use. Check that project's model access and quota. Some models have a limited free tier; paid access uses the project's [Gemini API billing](https://ai.google.dev/gemini-api/docs/billing).

Copy the key, then return to Meerkat T3. If your organization manages API access, ask its administrator for access to the appropriate project or workspace.

In **Settings > Providers**, select Meerkat on the computer running your project, open **Credentials**, choose your provider, and enter the API key. Click outside the field or press Tab to save it. Keys are masked in the interface. Never paste a key into a conversation or a bug report. Configure only the account you intend to use, then choose one of its models.

For Azure OpenAI, select **Prefer Azure OpenAI** and enter a matching **Preferred Azure endpoint** and **Preferred Azure API key**. The fields save separately when you leave each field, so check that both values belong together before continuing.

To remove the Azure preference, remove both preferred fields. Existing credentials on the computer or in **Project Connections** can still apply; removing the preference does not sign out those accounts.

## Model and reasoning

Choose a model and, when offered, its reasoning level. **Model default** uses that model's default reasoning. Review the level again when switching models, since the available choices differ.

For an existing project agent, **Use current agent model** keeps its saved model and reasoning after reconnecting or restarting the app. A label such as **Current: Xhigh** reports the saved level. Keeping current also preserves settings that the picker cannot describe. An explicit change applies to your next message when the agent is idle.

Prompt caching follows the model backend's automatic policy; there is no cache switch to configure. Support and cache hits vary by provider and request, so a saving is not guaranteed.

## Model access and errors

A catalog entry means the model is known, not that your account has access. If another provider's model asks for credentials, connect that provider or switch back to your connected account. If a saved draft names a model or reasoning level that is no longer offered, choose a supported model and level, or **Model default** for reasoning. Your saved choice is not proof of continuing access.

After saving credentials, the app checks that the runtime detects them. This does not verify the key with the model provider. Send a small non-sensitive message to confirm the complete path. If it fails, use **Open provider settings** on the error to review the same account and computer, then retry. Setup also keeps **Manage credentials** available after detection. If saving or checking fails, use the displayed **Retry save** or **Retry check** before continuing.

For a removed, expired, or revoked key, save a working replacement in that account's settings, refresh its status, and return to the original task. Quota, model access, and network errors need their own correction. Removing a saved key may expose credentials already configured on the computer; it does not necessarily sign out that provider. Connections configured by your pilot contact may use a separate account, so check **Project Connections** if changing the general key has no effect.

## Browser sign-in

The prototype can use browser sign-in when its distributor has already configured a supported OAuth profile. **Project Connections** shows Sign in only for those profiles. An unconfigured profile cannot be created by clicking Sign in. If you only have a chat subscription, ask the distributor whether it is supported; do not assume the API-key field accepts a subscription login.

## GitHub repositories

Git and GitHub CLI are separate tools; the prototype does not install them. On a fresh Mac:

1. Install [Git](https://git-scm.com/downloads) and [GitHub CLI](https://cli.github.com/) 2.81.0 or newer. Open Terminal and check `git --version` and `gh --version`.
2. Run `gh auth login --hostname github.com` in Terminal. Choose HTTPS for the clone path described here and follow the sign-in prompts using an account that can access your repository.
3. Return to **Settings > Source Control** for this computer, choose **Rescan**, and confirm that GitHub is **Authenticated**. Settings detects the external login; it does not perform sign-in.

New HTTPS clones from github.com can reuse that login automatically when Git has no custom credential setup. This connection is saved for the checkout, so later fetches and pushes use your active GitHub CLI account after restarting the app.

Existing Git credential helpers keep their current behavior. If GitHub is connected in Settings but a private clone cannot authenticate, run `gh auth login --hostname github.com` and `gh auth setup-git --hostname github.com` on the project's computer, then retry the failed clone. The second command configures Git to use your GitHub CLI account. SSH and GitHub Enterprise repositories use their separately configured Git access. A repository-not-found error can also mean the address is wrong or the selected account lacks access.

## Several agents can make several requests

A coordinator, project specialists, and workers can each use the provider account. Preparing a recommended team can start a separate repository study for each selected specialist. Start with one or two agents and inspect activity before adding more.

In **Usage**, load a Meerkat lifetime-token snapshot to see recorded coordinator, specialist, and worker tokens in the selected connection's current storage. Retained sessions are included even after their agents have been unloaded. Missing measurements remain unknown, and an incomplete storage read produces no total. Cache tokens are included in input tokens; reasoning tokens are included in output tokens.

These snapshots exclude auxiliary generation, such as titles, and previous storage locations. They are not part of the period charts or dollar estimates. Connections that share storage can overlap, so their snapshots are not added together. Do not read an empty chart or a zero there as zero spend. Use your model provider's billing/usage view for account totals; estimates and missing prices in this app are not a spending limit.

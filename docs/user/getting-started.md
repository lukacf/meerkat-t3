# Your first task

Start with one project and one conversation. Specialists are optional. This guide is for the private Mac pilot; use the prototype build and update instructions supplied by your pilot contact.

## Connect a model account

On the **Model access** step, choose **Set up credentials** for Meerkat. Select the provider you have an API account with and enter its key, then click outside the field or press Tab to save it. [Accounts and billing](accounts.md) explains the difference between an API key and a chat subscription.

Use a model from that connected provider for your first task. A model appearing in the catalog does not by itself establish that your account can use it. If setup opens Settings, finish there and return to setup or the project list.

## Open or create a project

On **Choose your first project**, select **Open folder**, **Create project**, or **Clone repository**. To start from scratch, use Create project and choose a local location for its new folder. Importing existing coding-agent history is optional; no previous Meerkat, Codex, or Claude history is required. Later, use **Add project** to add another project.

Start with a small project you can build locally. If the project needs dependencies, credentials, or a development server, follow its README. The app's terminal runs on your computer and uses your project's installed tools.

The **Check your project** step shows whether Git is ready and which commit author will be used. For a new folder, you can initialize Git there. If an author is missing, enter your name and email and choose **Save for this repository**. This sets the repository's local author, not your other projects. **Continue without Git setup** is available if you want to explore first; you will need Git and an author before committing.

## Ask for one small change

Open **New thread** in the project. Choose the model and, when offered, its reasoning level. **Model default** leaves reasoning to the model's default. Review the [permissions](permission-modes.md) before sending. [Model and reasoning](accounts.md#model-and-reasoning) explains saved choices and automatic caching. A useful first task is:

> Explain this project's structure, then suggest one small improvement. Wait for me before editing files.

After reviewing the explanation, ask for a specific change and its tests. Read and respond to any approval or question in the conversation. Use Stop to interrupt current work. [Follow-up messages](agents.md#follow-up-messages) explains steering and queued work.

Setup finishes after a successful first reply. **Skip setup for now** lets you explore without claiming the model connection worked. Search for **Set up Meerkat** to reopen setup.

## Inspect, test, and keep the result

Open **Changes** to inspect the diff and **Terminal** to run the project's test or build command. Use a configured project action when one is available. A successful agent reply is not evidence that tests ran; check their results.

Commit the files you intend to keep. Before publishing to GitHub, follow [GitHub account setup](accounts.md#github-repositories) on this Mac, then rescan **Settings > Source Control**. Your model-provider account does not automatically sign you in to GitHub or another source-control host.

If a repository has no commit author, the commit action asks for your name and email before continuing. It saves them for that repository only and keeps your chosen message and files. To review or change the author later, open the Git actions menu and choose **Commit author**. This is available for subsequent projects too.

### Create your first pull request

For a cloned GitHub repository you can push to:

1. Open the thread's **Git action options** menu and choose **Commit**. Use **Edit** beside Files to select what belongs in the commit, and enter your own commit message. Choose **Commit on new branch** to keep the change off the repository's default branch, or **Commit** if you are already on the intended feature branch.
2. Commit or stash any remaining local changes; the pull request action requires a clean checkout. Review the selected project and branch, then choose **Write pull request...** in Git actions. Enter your title and description and choose whether to **Create as draft**.
3. Choose **Create pull request**. This pushes committed changes if needed and creates the pull request on GitHub. Supplying the commit message and using **Write pull request...** avoids calling a writing model.

After success, use **Linked pull requests** in the same saved thread to reopen the review, including after restarting the app. A PR created beside a new, unsent draft is not automatically linked to a saved thread. Keep its URL and use **Link pull request** once you have a saved thread; do not create another PR just to recover its link.

## Add a second opinion

When the basic task works, [add a project specialist](agents.md). Connect it to the task and ask for a review of the exact branch, commit, or worktree you changed. Project specialists keep their own conversation and project checkout, so a connection does not move them into your task's worktree.

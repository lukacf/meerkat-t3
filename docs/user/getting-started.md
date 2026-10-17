# Start with your project

MeerkaT3 centers on long-lived specialists for your project's domains. Generate a proposed team from the repository, prepare the specialists you need, and connect them so they can work with one another across tasks and projects. This guide covers the local Apple Silicon Mac preview. See [Installation and availability](install.md) for the current distribution status.

## Connect a model account

On the **Model access** step, choose your provider and sign in or save its API credentials. The same account controls are available in **Settings > Providers**. [Providers and accounts](accounts.md) explains the supported methods, account defaults, and billing.

Use a model from that connected provider for the repository study and its specialists. Recommended models are the suggested starting choices for your connection; supported models offer more options. A catalog entry does not by itself establish account access or quota. If setup opens Settings, finish there and return to setup or the project list.

## Open or create a project

On **Choose your first project**, select **Open folder**, **Create project**, or **Clone repository**. To start from scratch, use Create project and choose a local location for its new folder. Importing existing coding-agent history is optional; no previous Meerkat, Codex, or Claude history is required. Later, use **Add project** to add another project.

Start with a small project you can build locally. If the project needs dependencies, credentials, or a development server, follow its README. The app's terminal runs on your computer and uses your project's installed tools.

The **Check your project** step shows whether Git is ready and which commit author will be used. For a new folder, you can initialize Git there. If an author is missing, enter your name and email and choose **Save for this repository**. This sets the repository's local author, not your other projects. **Continue without Git setup** is available if you want to explore first; you will need Git and an author before committing.

## Generate project specialists

1. First-run setup opens the repository study after you choose and check your project. For another project, choose **Propose agents from repository** in its actions menu, or **Suggest agents** on its start screen.
2. Choose the model and reasoning level for the study, then **Start repository study**. It inspects the repository in Read-only mode and proposes specialists based on the code's domains and responsibilities.
3. Open **Review proposal**. Check each specialist's focus and assignment details, including the files it will study. Select the assignments you want and check their access mode. The default, **Read and collaborate**, allows repository inspection and peer replies without commands or file changes. Choose **Full access** only when the specialist itself should run commands or edit files. **Read-only** specialists can inspect and answer you directly, but cannot send peer replies.
4. Choose **Apply** with the selected assignment count. Each selected specialist starts its own study using the configured model account. When an agent is ready, open its conversation from the project's Agents section. Its responsibilities and conversation stay with it across tasks.

In first-run setup, choose **Continue to specialists** after applying assignments. This opens a specialist's conversation; preparation may still be running. Reading the proposal alone does not finish setup. **Skip setup** lets you explore and return later through **Set up your workspace** in search. [Model and reasoning](accounts.md#model-and-reasoning) explains saved choices and automatic caching.

The proposal is a starting point for your repository. Keep the specialists whose domains are useful to your work. **Add agent** is available when you already know an additional responsibility you want to assign. [Work with project specialists](agents.md) explains ongoing assignments and connections.

## Connect specialists and begin work

Connect agents whose responsibilities need to meet. Open a specialist's **Connections**, choose **Connect an agent** (or **Manage connections** if it already has peers), select a peer, and confirm **Connect agents**. The picker includes agents from other projects on the same connected computer. You can also drag one agent onto another in the sidebar and confirm the connection.

Give the work to the specialist responsible for it and ask it to coordinate with its connected peers. For example, an API specialist can agree a response format with the client specialist in a related project, then send their findings to an implementation task. Each keeps its own conversation and checkout. See [Peer specialists within and across projects](agents.md#peer-specialists-within-and-across-projects) for the available connections and their limits.

For a focused task involving several specialists, choose **Start a task** from the proposal or open **New thread** in the project. Select the relevant project agents before sending the first message. The thread's coordinator can work with those specialists and create task-scoped workers. Name the change, the expected result, and the tests you want. A thread with no selected specialists can also run independently.

Respond to questions or approvals in the relevant conversation. Use Stop to interrupt current work. [Follow-up messages](agents.md#follow-up-messages) explains steering and queued work.

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

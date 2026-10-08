# Work with agents

## Projects, tasks, and specialists

A **project** is a folder or repository on your computer. A **thread** is a task conversation within that project. Its coordinator is the agent you talk to; it can create workers for parts of that task.

A **project specialist** is a persistent collaborator, such as a Reviewer, with its own instructions and conversation across tasks. Start solo if you do not need one. Add a specialist from the project's Agents section, or ask the app to study the repository and propose a team. Review the selected roles and models before preparing them: each selected agent can start its own model-backed study.

If the sidebar groups several copies of a repository, choose the checkout when opening the project or starting a new thread. Each choice shows its computer and folder path. Project-agent sections use the same checkout labels; agents belong to that folder even when another copy of the repository is open.

## Connect and request a review

Select the project agents to include when starting a task, or use **Connections** on an existing conversation. You can also drag one agent or thread onto another to connect them. A connection allows messages; it does not merge histories, automatically request a review, or move anyone's checkout.

Peer messaging requires **Full access** in the current native policy. A Read-only specialist can inspect files and answer you directly, but cannot send a report to another agent. If you want the coordinator to request and receive a peer review, use a specialist with Full access and be aware that this also permits edits and commands. Giving it review-only instructions does not enforce a restriction on edits.

Ask the coordinator to request a review and name what should be reviewed. For a worktree task, include the worktree or exact commit. Project specialists work in the project's checkout; task workers use their task's worktree. Check the displayed workspace and branch before reading files, running commands, or committing.

Open the specialist from the sidebar to inspect its conversation. Follow attention links for questions or approvals. Read the returned review in the requesting task, and ask for a summary of any unresolved findings. Disconnect collaborators when you no longer want that messaging relationship.

## Deliver a specialist's work

The agent header identifies its **Project checkout** or **Thread worktree**, with the path and branch. A project specialist's **Delivery task** opens a saved task in that same checkout so you can inspect changes, test, commit, and create a pull request. It keeps a link to the source specialist and its latest objective or outcome. Review that handoff and add any findings needed from earlier conversation; the entire transcript is not copied, and creating the task does not send a model message automatically.

For browser work with a Full access specialist, select an existing task in the exact same checkout or choose **Create browser workspace**. Send its first message, then use **Share browser and return** to grant access and return to the specialist. The browser is shared only after that action. Use **Stop sharing** when finished. Read-only agents cannot use browser tools in this prototype.

## Permissions

Read the specialist's effective access mode before giving it work. "Reviewer" is a role name, not a filesystem restriction. Project-agent permissions are separate from a thread's permissions. Choose **Read-only** for direct advice without edits, commands, or peer messaging, or deliberately allow **Full access** when it should collaborate with other agents or run tools. Project agents do not currently support Supervised mode. Reconnecting or changing a role does not change its access; create another agent to choose a different mode. [Permissions](permission-modes.md) explains the distinction.

## Follow-up messages

In a project-specialist or native worker conversation:

- **Message** submits a new message to the agent's native queue. If it is busy, this does not mean an immediate interruption.
- **Steer current work** sends a correction to the active work. If that work already ended, send a new message instead.
- **Queue for idle** saves an editable follow-up in this environment until the agent is idle. You can edit, reorder, or delete items that are still waiting.
- **Stop turn** interrupts the active turn. It does not delete saved Queue for idle items. Remove those separately if you no longer want them to run.

If delivery is uncertain, use **Check delivery** before sending again. It checks the original attempt instead of blindly duplicating it. Keep the app connected until you can see whether work was accepted.

Ordinary thread composers have their own queue controls and **Settings > General > Follow-up behavior**. Do not assume changing that setting changes a specialist's Message/Steer selection.

## Returning later

Saved conversations remain visible when agents are disconnected. **Connect** makes a persistent specialist available to continue; a saved transcript alone does not mean it is running. After a restart, inspect active work and attention notices before retrying. If the outcome is unknown, use its recovery action rather than starting the same change again.

Archive finished work to keep it out of the active list while retaining history. Stop a running task before abandoning it. See [Recovery and troubleshooting](troubleshooting.md) for file recovery and interrupted work.

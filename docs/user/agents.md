# Work with project specialists

## Specialists that stay with the project

A **project** is a folder or repository on your computer. Its **project specialists** are long-lived agents with their own responsibilities, instructions, and conversations. Use the repository study to propose specialists for the project's actual domains, then keep working with those agents as the project evolves.

From the project's actions menu, choose **Propose agents from repository**, or choose **Suggest agents** on its start screen. Review the proposed focus and assignment details, select the specialists you want, and apply their assignments. Each selected specialist runs a study of its assigned area. [Generate project specialists](getting-started.md#generate-project-specialists) walks through the model and permission choices.

Open a specialist from the project's Agents section to ask questions, give it work in its domain, or inspect its progress. If a later proposal changes an existing assignment, the proposal shows the change before you apply it. Applying the update preserves that agent's conversation and connections, and starts a fresh study when it is idle.

If the sidebar groups several copies of a repository, choose the checkout when opening the project or starting a new thread. Each choice shows its computer and folder path. Project-agent sections use the same checkout labels; specialists belong to that folder even when another copy of the repository is open.

## Peer specialists within and across projects

Connect specialists when their work needs to meet. They can coordinate design, share findings, resolve an interface change, or review each other's work. Connections can join agents in the same project or agents in different projects.

Open a specialist's **Connections** and choose **Connect an agent**, or **Manage connections** if it already has peers. Search by agent or project name, choose a peer, and confirm **Connect agents**. You can also drag an agent onto another agent in the sidebar and confirm the connection. In this preview, both must use the same connected computer. Specialists in different projects on that computer can peer; specialists on different computers cannot.

For example, connect a service's API specialist to the client specialist in a separate application project. Ask one to agree a response format with its peer before making the change. For work inside one repository, connect the specialists responsible for the affected domains in the same way.

A connection allows peer messages when permissions permit. It does not send a task by itself, merge conversations, share every past message, or move either agent into the other's checkout. State the objective and ask the agent to coordinate with the named peers. Include the exact branch, commit, or worktree when that matters to the work.

New local specialists default to **Read and collaborate**. They can inspect repository files and exchange messages with connected peers, while commands, file changes, browser control, and external tools remain blocked. A **Read-only** specialist can inspect files and answer you directly, but cannot send a report to another agent. Existing specialists keep their saved permissions. [Shared specialists](shared-specialists.md) use a separate repository-only policy for explicit-revision evidence. Check each agent's permissions before connecting it for two-way collaboration.

Use **Connections** to open a peer's conversation or **Manage connections** to disconnect it. Inspect the connection status: a saved connection can be offline. Follow attention links for questions or approvals, and read the replies in the requesting agent's conversation.

## Use task threads and workers

A **thread** is a focused task conversation within a project. Its **coordinator** is the agent you talk to in that conversation. Select the project specialists to connect before sending the first message, or use **Connections** on an existing thread. The same connection controls can also join existing threads to other threads or specialists, including in another project on the same connected computer.

The coordinator can create **workers** for parts of that task. These are task-scoped helpers; the project's specialists keep their separate responsibilities and conversations across tasks. Open the thread's agent menu to inspect its coordinator and workers.

Project specialists work in their project's checkout. Task workers use the task's checkout or worktree. A peer connection does not move files, switch branches, or change either checkout. Check the displayed workspace and branch before reading files, running commands, or committing.

## Deliver a specialist's work

The agent header identifies its **Project checkout** or **Thread worktree**, with the path and branch. A project specialist's **Delivery task** opens a saved task in that same checkout so you can inspect changes, test, commit, and create a pull request. It keeps a link to the source specialist and its latest objective or outcome. Review that handoff and add any findings needed from earlier conversation; the entire transcript is not copied, and creating the task does not send a model message automatically.

For browser work with a Full access specialist, select an existing task in the exact same checkout or choose **Create browser workspace**. Send its first message, then use **Share browser and return** to grant access and return to the specialist. The browser is shared only after that action. Use **Stop sharing** when finished. Read-only agents cannot use browser tools in this preview.

## Permissions

Project-agent permissions are separate from a thread's permissions. A specialist's name, domain, or assignment does not restrict its tools. Use **Read and collaborate** for repository guidance and peer coordination, **Read-only** for direct advice without peer messaging, or **Full access** when the specialist itself needs to run commands or change files. A task coordinator with suitable permissions can implement changes using the specialists' advice. Project agents do not currently support Supervised mode. Reconnecting or changing an assignment does not change its access; create another agent to choose a different mode. [Permissions](permission-modes.md) explains the distinction.

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

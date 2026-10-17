# Permissions and access

The agent works on the computer and checkout shown by the app. Permissions decide which tools it may use and when you approve them; a role name or a request to "only review" is not an enforced permission boundary.

## Task threads

Choose the permission mode in the composer before sending. Set a default in **Settings > General > New threads > Permissions**; a project's settings can override it.

For task threads:

| Mode        | Effect                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------- |
| Read-only   | Native policy restricts the agent to read-only tools.                                             |
| Supervised  | Requests approval before tool calls. Read and approve or reject each request in the conversation. |
| Full access | Allows available commands and edits without tool-approval prompts.                                |

Changing a default does not retroactively change an existing agent's permissions.

## Persistent project agents

Project specialists are separate from task threads. Check their access mode at creation and in their conversation; a thread's Supervised choice does not supervise its connected specialists.

- **Read and collaborate** is the default for newly created local specialists. It allows repository file inspection and messages to connected peers. Native policy blocks commands, file changes, browser control, and external tools. Give implementation work to a task coordinator with suitable permissions.
- **Read-only** allows file inspection and direct replies to you. Native policy blocks shell commands, file changes, and sending messages to peers. It cannot send its findings to another specialist or a task coordinator.
- **Full access** allows peer collaboration, commands, and edits.
- **Repository-only** is used by shared specialists. It allows explicit-revision repository inspection, shared-workspace tools and peer messages, while blocking shell commands, edits and arbitrary external tools. Create these through [shared host setup](shared-specialists.md).
- **Supervised is not available for persistent project agents in this preview.** A specialist's name or assignment does not restrict its tools.

The choice is retained across reconnects and responsibility changes. Existing Read-only specialists and saved creation requests stay Read-only; they are not upgraded automatically. Create a new specialist to use a different mode. A new repository-study proposal runs Read-only; that does not set the access of the specialists you later create from the proposal. Check their creation choice before confirming.

## Browser and device access

Browser control needs both a compatible access mode and an explicitly shared browser workspace. Read-only, Read and collaborate, and Repository-only specialists cannot use browser tools. For a project specialist, use Full access if it needs browser control. Check **Settings > Integrations** and the conversation's Browser controls before granting access. Revoke sharing when it is no longer needed. Device access is optional and off by default.

Before running work, confirm the model account, actual checkout, permissions, and any shared browser. These choices can differ between a task and a connected project specialist.

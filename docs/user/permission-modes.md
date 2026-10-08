# Permissions and access

The agent works on the computer and checkout shown by the app. Permissions decide which tools it may use and when you approve them; a role name or a request to "only review" is not an enforced permission boundary.

## Task threads

Choose the permission mode in the composer before sending. Set a default in **Settings > General > New threads > Permissions**; a project's settings can override it.

For Meerkat task threads:

| Mode | Effect |
| --- | --- |
| Read-only | Native policy restricts the agent to read-only tools. |
| Supervised | Requests approval before tool calls. Read and approve or reject each request in the conversation. |
| Full access | Allows available commands and edits without tool-approval prompts. |

Other inherited providers may offer additional modes. A mode is available only when that provider implements it. Changing a default does not retroactively change an existing agent's permissions.

## Persistent project agents

Project specialists are separate from task threads. Check their access mode at creation and in their conversation; a thread's Supervised choice does not supervise its connected specialists.

- **Read-only** allows file inspection and direct replies to you. Native policy blocks shell commands, file changes, and sending messages to peers. It cannot automatically return a review to the coordinator.
- **Full access** allows peer collaboration, commands, and edits. The current policy cannot grant peer messaging alone while enforcing read-only file access.
- **Supervised is not available for persistent project agents in this prototype.** A Reviewer role is not inherently read-only.

The choice is retained across reconnects and responsibility changes. Create a new specialist to use a different mode. A new repository-study proposal runs Read-only; that does not set the access of the specialists you later create from the proposal. Check their creation choice before confirming.

## Browser and device access

Browser control needs both a compatible access mode and an explicitly shared browser workspace. Read-only agents cannot use the browser tools in this prototype. For a project specialist, use Full access if it needs browser control. Check **Settings > Integrations** and the conversation's Browser controls before granting access. Revoke sharing when it is no longer needed. Device access is optional and off by default.

Before running work, confirm the model account, actual checkout, permissions, and any shared browser. These choices can differ between a task and a connected project specialist.

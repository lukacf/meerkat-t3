# Working with threads

Use a thread for a focused task in a project. Its coordinator can work with the project's long-lived specialists and create temporary workers. Use a [specialist's own conversation](agents.md) for work that belongs to its ongoing domain.

## Start a thread

Choose **New thread** in the project. Check the model, permissions, selected specialists, and workspace before sending. Project defaults can override your remembered choices.

Choose **New worktree** when a task needs a separate branch and working directory. To continue in an existing worktree, use **New thread in this worktree** from the branch toolbar. A separate conversation alone does not isolate file changes.

### Start in the background

In a new thread, `Cmd+Enter` starts it and opens another draft. The next draft keeps your selected workspace mode and base branch. With **New worktree**, each background submission gets its own worktree.

## Pin and reorder threads

Pin a thread from its menu to keep it above active work. Drag within the pinned or active section to change its order. Drag between sections to pin, unpin, or settle a thread. The drag label shows the action before you release it.

Pinning, unpinning, settling, snoozing, and archiving show a brief **Undo** action. When no text field is focused, `Cmd+Z` reverses the latest available sidebar action. See [Keybindings](keybindings.md#commands-with-special-behavior).

You can drag files from your computer onto a thread row to open that thread with the files attached to its draft. Review them before sending.

## Settle finished work

**Settle thread** moves finished work out of the active list without deleting its conversation. **Un-settle thread** brings it back. Pinning does not prevent settlement.

Automatic settlement rules live in **Settings > General**. Work in progress, pending questions or approvals, and live background work prevent automatic settlement. A thread's **Auto-settle behavior > Disabled** setting keeps that thread active until you settle it yourself. Changing a default does not reopen already settled threads.

Manually settling an idle thread dismisses unanswered async questions without answering them or restarting the agent. Resolve a question first if its answer should reach the agent.

## Link a pull request

Use **Link pull request** to keep a review with a saved thread. Git actions can also link a newly created pull request automatically when launched beside a saved thread. Reopen it through **Linked pull requests**, including after restarting.

An unsent draft has no saved thread to attach to. Keep the pull request URL and link it after saving the thread; do not create another pull request to recover its link. See [Source control](source-control.md#linked-pull-requests).

## Find and reference work

Open search with `Cmd+K` to find projects, agents, commands, and threads. Message search begins after two characters and includes user messages and final agent replies. Use the sidebar's project and agent sections to return to long-lived specialists.

**Settings > Keybindings** lists shortcuts for searching files and copying a thread reference. A copied reference uses the linked pull request when available, otherwise the thread ID.

## Inspect agent work

Use the thread's agent menu to inspect its coordinator and workers. Connected project specialists retain their own conversations; open them through Connections or the project's Agents section.

Expand a tool call to read its command, output, and result. A concise activity summary can describe the last tool even after it finishes, so use the call's result to determine whether it succeeded.

## Snooze until later

Choose **Snooze > Custom** to pick a local date and time, or a duration. Durations begin when you confirm; one day means 24 hours. **Wake thread** returns it early.

Snoozing changes when work appears in your active list. Use Stop and review queued follow-ups when you want to stop agent work. See [Recovery and troubleshooting](troubleshooting.md#stop-or-cancel-follow-up-work).

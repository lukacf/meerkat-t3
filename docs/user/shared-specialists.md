# Share project specialists

A shared workspace lets several people work with the same persistent project
specialists. The host runs the specialists and retains their conversations. Each
person keeps their task threads and checkout on their own computer.

This is an experimental workflow in builds with shared-workspace support. Start
with one host and one repository. Joining a shared workspace does not copy an
agent or move anyone's files.

## Set up the host

For a workspace on your Mac, open **Settings > Connections > Shared specialists on
this Mac** and choose **Host on this Mac**. It runs beside your personal tasks and
keeps its specialists and saved accounts in a separate profile. It starts with
MeerkaT3 after you enable it, and stops when you quit. Stopping preserves its data.
Another browser on this Mac can join it; connecting from another computer requires
a separately configured network host.

Then set up the host:

1. Open **Set up this Mac's shared workspace**, give it a name and choose
   **Create workspace**. For an existing environment, use **Share the current
   environment** instead.
2. Choose **Add host repository** to select a checkout. Connect the host's model
   account using the account settings link during specialist setup.
3. Choose the host project, check its displayed repository identity, and choose
   **Register project**. The host verifies the repository's current Git remote.
4. Under **Project specialists**, choose **Generate specialists**. Select a model
   from the host's accounts and choose **Start repository study**. Open **Review
   proposal**, select the domain responsibilities you want, and apply the selected
   assignments. After each specialist finishes its study, choose **Share specialist**.
   Generated shared specialists keep repository-only access.
5. Open **Invite collaborators** in this host's settings and create a pairing
   link. Give each person a separate invitation using an address they can reach.
   Use **Client access** in the same panel to revoke an issued connection.

The host must stay running and reachable. Shared access permits collaboration in
this workspace; it does not grant host terminal, arbitrary file, account-settings,
or administrative access. Participants can read the workspace's shared
conversations and observations, so use it with people who should see that work.

Reopen the setup conversation to follow preparation or share the remaining ready
specialists. Existing local agents keep their permissions; a shared specialist
needs a distinct role if a local agent already owns that role. Change a published
specialist's assignments through the shared workspace's assignment controls.

For a single specialist, the manual form lets you describe a continuing domain
or select an existing repository-only agent. If that setup is interrupted, use
**Resume specialist setup**. It retains the original creation and registration
requests, including an agent created before the connection was lost.

## Connect your checkout

Your desktop connects to its managed host automatically. For a host elsewhere, add
its pairing link in **Settings > Connections**. Keep your local environment enabled
so your own project and tasks remain available.

Open your local project's start screen. The shared workspace matches its Git
remote to the registered repository. Enter your display name and choose
**Use shared specialists**. The project's Agents section then shows the shared
specialists with their host. Everyone opening that reference reaches the same
agent.

A folder name alone does not establish a match. If the repository is not
registered, ask the host owner to register it. Forks are separate repositories
unless the host owner explicitly associates them.

## Find the right specialist

When you open a new or existing task, **Shared specialists** in its toolbar
automatically looks up the specialists assigned to the attached shared project.
The suggestions show their responsibilities. This directory lookup does not
upload your task text, grant your agent access, or claim that a specialist is
running.

Expand **Find specialists** beside the attached shared project. Search by a domain
or responsibility, or add a repository path or topic tag. Results explain why a
specialist matches and show the relevant responsibility description. Use the
workspace-wide scope to discover collaborators in other registered projects.

Opening a specialist from another project lets you inspect its conversation.
It does not silently attach your current checkout or send work under that other
project's revision. Use a specialist assigned to your checkout's shared project
when asking about its code.

## Ask about a specific revision

Open a shared specialist from your local project. Check the branch and revision
near the conversation, describe your task, and send your request. The app reads
the checkout's current revision before sending and retains it with your request.
When you open a suggestion from an existing task, the request retains that task
and observes its worktree, even if it differs from the project's main checkout.

Select a branch before sending. For uncommitted changes, choose **Preview snapshot**
and review its file list, patch, size and base commit. Previewing stays local.
**Share snapshot** explicitly uploads that patch to the named workspace, which
retains it as request evidence. The app checks that the checkout still matches
the preview before uploading and before binding it to a new request. If it has
changed, refresh the preview and share again. Retrying an existing request keeps
its original snapshot and delivery identity.

Snapshots include complete tracked text changes only. Ignored files are never
included; nonignored untracked files block sharing until you stage or commit them.
Unsupported changes and oversized or incomplete previews also block sharing.
Sharing does not apply the patch to the host checkout. The snapshot's base
commit must be available in the host repository; the specialist cannot fetch
missing commits or switch the host's working branch. Synchronize the repository
through your normal Git workflow when needed.

Each result stays with its original caller, task and revision. Another person's
request or a peer message can produce separate activity in the same specialist's
conversation. That activity is not a substitute for your request's result.

- **Not sent** means the server retained the request but has not claimed delivery.
  **Retry saved request** checks current access and routing before using its original
  input. If that revision is obsolete, **Edit as new request** keeps the original
  record and drafts a separate request for the current revision.
- **Accepted, awaiting result** means the native runtime accepted the request.
- **Completed** or **Request failed** requires the exact request's native outcome.
- **Outcome unresolved** means the app cannot confirm that outcome. Refresh the
  conversation to reconcile the original request instead of sending a duplicate.

Expand **Request evidence** when you need the full revision and delivery details.

## Catch up after reconnecting

Open **Shared specialists** in your task toolbar, then **Project updates** and
**Fetch briefing**. It contains retained observations for your shared-workspace
account, including the shared projects you follow. It is also available in shared
specialist conversations. Fetching a briefing does not mark it read or read an
agent's separate inbox. A batch
does not change while you read it. Choose **Mark these updates read** to acknowledge
that batch, then refresh to see later updates.

Marking updates read does not complete a task, approve a finding or confirm that
an agent acted on it. Check each request's result separately. When the host is
offline, saved information remains identifiable as saved information; reconnect
before submitting new work or acknowledging a batch.

A specialist can publish a follow-up observation from an update in its own sealed
inbox batch. The host retains the source update, project and exact revision, and
attributes the follow-up to the specialist. This does not turn peer or background
activity into a result for somebody else's request. Opening a briefing does not
schedule a recurring task.

## Let a local task collaborate

Joining a shared workspace does not give every local agent access. To enable a
specific task, expand **Allow a task to collaborate** in the task's shared
specialists panel or on the attached project:

1. Select a started task with a native session and a named branch. The app observes
   that task's worktree, including when it differs from the project's main checkout.
   Commit local changes or explicitly preview and share a snapshot. The grant
   retains that exact revision and snapshot; it does not follow later edits.
2. Choose the actions the task needs, such as discovering specialists, asking
   them about work, or publishing findings and reading updates.
3. Read the account and destination shown in the consent. Enabling access stores
   your paired shared-account credential in the selected local server's secret
   store so that it can act for this task. It is not given to the model.
4. Choose **Enable for this task**. Access lasts at most one hour from this UI,
   and ends sooner if the shared account expires or is revoked.

**Publish this task's objective and observations** is off by default. Selecting it
announces the retained objective when the grant is created and permits the task
to publish observations. Merely opening a task or finding specialists does not
announce its objective.

The grant retains the task, native session, selected actions and exact revision.
Later branch changes do not silently alter it. Revoke the existing grant before
choosing a new scope. The agent's tools use that retained context automatically;
the model cannot choose another caller or revision.

If confirmation is lost, **Retry saved request** continues the same operation.
It does not create a second grant or replay a specialist request. If an unconfirmed
request's saved expiry has passed, **Start a new request** unlocks the task and
scope while keeping the stored account and previous access history. Enabling the
new request checks access again; starting it does not confirm remote revocation.
**Revoke access**
blocks further calls on the local server before contacting the shared host. When
the host is unreachable, **Confirm revocation** finishes the remote step after
reconnection. A local block and a confirmed remote revocation are shown separately.

**Remove stored account** also deletes the credential from the local server,
including when the host is offline or the login has expired. If the app cannot
confirm remote revocation, it says so. Removing this local copy does not sign out
other clients or claim that every remote grant was revoked. It affects all tasks
using this stored account, including tasks in other projects; individual revoke
controls in a task show only that task's grants.

If an account setup attempt never confirms, **Cancel saved setup** removes any
credential it stored on the local server. It works while the shared host is
offline. If confirmation or local deletion fails, **Retry setup cancellation**
continues the same cancellation; the app keeps its recovery record until removal
is confirmed.

## What shared specialists can do

Repository-only specialists can inspect registered repositories at explicit
commits, exchange peer messages, and read or publish supported shared
observations. They can also create independently owned specialists, connect
collaborators, revise responsibilities, and split or consolidate assignments for
future work through retained composition operations. They cannot edit files, run
shell commands or use arbitrary external tools. Your local task agents remain
responsible for changes in your checkout.

A superseded specialist remains available for work already admitted to it. The
routing change applies to new MeerkaT3 assignments; it does not retire the agent,
move a running task or claim to close other native message paths. Local task grants
do not permit reorganizing the shared workspace.

Open **Responsibility history** in a specialist's conversation to review retained
creation, responsibility, peer and routing changes. It shows the initiating actor,
operation outcome and affected specialists. Reading the history does not retry
an operation or change which specialist owns an existing request.

Shared-workspace participation and direct peering between agents on different
computers are separate capabilities. Task collaboration uses the authenticated
shared service and its exact request records.

See [project specialists](agents.md) for ordinary local agents and
[permissions](permission-modes.md) for the access modes.

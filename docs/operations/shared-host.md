# Operate a shared specialist host

A shared workspace runs inside one MeerkaT3 environment server. That host owns
the persistent specialists and shared project records. Each participant keeps a
separate local environment, checkout and task history. Follow the
[shared specialist guide](../user/shared-specialists.md) for setup and daily use.

The supported preview host is the Apple Silicon Mac app or its source-built
server. This is not a managed hosting service, a clustered deployment, or a host
migration tool. Use one active server for a profile. Its availability depends on
the computer remaining awake, the server running, and its network address being
reachable.

## Network and account access

The host can run on your own Mac. Choose the setup that matches who will connect:

- **On this Mac:** choose **Settings > Connections > Shared specialists on this
  Mac > Host on this Mac**. The app starts a separate loopback server with its own
  saved profile and port. Name the workspace, add a host repository and connect
  the host's model account. Your personal tasks continue in the local environment.
  The desktop connects to its own host automatically; another browser on this Mac
  can join with a participant invitation.
- **From other computers:** use an environment with configured network access and
  an address those computers can reach. The managed same-Mac host listens only on
  loopback. A loopback address always reaches the computer opening it, so it cannot
  connect another computer to your host.

The managed host starts with the desktop after opt-in and stops when you quit.
**Stop shared host** retains its profile, specialists and chosen port. Starting it
again reconnects to the same workspace. If its port is occupied, close the
conflicting listener or ask its owner to do so, then retry. The app never kills
that process or silently moves the host to another address.

To host in an existing environment, use **Share the current environment**. Keep
that environment separate from personal task environments. Source servers also
support this topology; see [development state and processes](development.md#development-state-and-processes)
for profile isolation. They configure exposure at startup.

Local-task delegation to a host on another computer requires an **HTTPS origin**.
HTTP is accepted for `localhost`, `127.0.0.1` and `[::1]` during same-Mac use. A
working LAN HTTP connection for a human does not qualify the task-delegation
path. Establish and verify the HTTPS endpoint before inviting people on other
computers who need their local agents to collaborate. Do not forward an
unauthenticated development service to the public internet.

Create a separate invitation per person from the host's **Invite collaborators**
section. Each invitation has fixed participant permissions. Use **Client access**
to revoke an issued connection; revoking an unused invitation does not revoke a
connection that already redeemed it.
Participants receive workspace read and contribution permissions, not host
terminal, arbitrary file, provider settings or administration permissions. Shared
conversations, snapshots and published observations are visible within the
workspace; it is not a private per-person inbox service. Keep administrator
invitations separate from participant invitations.

Saved model accounts live on the host for its specialists. The managed same-Mac
host uses a separate native account configuration and credential namespace;
removing a saved account there does not remove a personal environment's account.
API keys inherited from the app's launch environment can still be available to
both servers through native environment authentication. This separation does not
isolate either server from the macOS user who runs it.

A participant's local task
uses that participant's local model account. Task collaboration requires explicit
consent to store the paired shared-account credential on the selected local
server. Grants retain a task, native identity, actions and exact context, and the
UI limits them to one hour or the account's earlier expiry. Removing a stored
account locally and confirming remote revocation are distinct outcomes; inspect
the result rather than assuming an unreachable host acknowledged removal.

## Repositories and durable state

Register real host repositories with verified Git remotes. Attach participants'
checkouts by canonical repository identity, not folder name. The host must have
the commits requested by participants: specialists do not fetch missing commits
or switch the host branch automatically. Synchronize repositories through the
normal Git workflow.

Keep the full host profile and its native state together. It retains the
directory, assignments, participant identity, request bindings, sealed inbox
batches, snapshots, evidence and composition history. Each personal server also
retains its own delegation records and stored account credentials. A backup of
the host alone is not a backup of participants' tasks or repositories.

Use the [offline backup and recovery procedure](../user/troubleshooting.md#make-an-offline-backup)
before an upgrade. Quit all processes using the selected profile first; copying
a live SQLite database alone is not a backup. Keep repositories, external
credential stores and the exact original app separately as described there.
Restoring requires the same user, Mac and paths, and holds work for review. Never
run the restored profile alongside its original copy with the same identities.

## Capacity and retained evidence

The host defaults to a product-evidence budget of **256 MiB**, **100,000 retained
records** and **20,000 outstanding inbox deliveries**. The existing specialist
limit includes registered specialists, pending creations and superseded
predecessors. The per-snapshot limit still applies independently.

Evidence accounting covers immutable work-context versions, activity, knowledge
and snapshot patches. It also reserves the current-context and searchable-text
copies, and one immutable batch copy plus a 1 KiB envelope per inbox delivery.
Each context version, activity, knowledge record, snapshot and recipient delivery
counts as one retained record. Reservations are made during publication; fetching
an accepted briefing never needs more budget. Repeating the same accepted
publication ID or restarting the host does not charge it again.

When the inbox backlog is full, a publication that would add too many deliveries
is refused as a whole. Have recipients fetch and explicitly acknowledge their
pending briefings, then retry the same publication. An acknowledgement frees
backlog capacity, but keeps its evidence and saved batch receipt.

When either retained-evidence limit is full, new contexts, snapshots and evidence
are refused with usage and limits. Existing evidence stays readable, inboxes can
still be fetched and acknowledged, and already accepted native requests can
finish and record their exact outcomes. A refused correction does not replace the
old finding or leave a partial event, search record or inbox delivery behind.

To increase capacity, take an offline backup during a maintenance window and check
the host's free disk space. Restart the **same profile** with larger server
environment limits. These settings accept positive safe integers and are read once
at startup; invalid values stop startup instead of silently removing the limit.

| Server environment setting           |     Default | Unit                            |
| ------------------------------------ | ----------: | ------------------------------- |
| `T3CODE_SHARED_EVIDENCE_MAX_BYTES`   | `268435456` | Accounted UTF-8 bytes           |
| `T3CODE_SHARED_EVIDENCE_MAX_RECORDS` |    `100000` | Retained records and deliveries |
| `T3CODE_SHARED_INBOX_MAX_PENDING`    |     `20000` | Unacknowledged deliveries       |

For a source-built host, supply these with its existing launch command, profile
and port. For example, doubling the evidence budget while keeping the backlog
limit unchanged:

```sh
T3CODE_SHARED_EVIDENCE_MAX_BYTES=536870912 \
T3CODE_SHARED_EVIDENCE_MAX_RECORDS=200000 \
node apps/server/dist/bin.mjs --base-dir /absolute/path/to/existing-host --no-browser
```

For the app-managed host, quit the app normally, then launch the installed app
from a terminal with the same settings. Use its exact installed path:

```sh
meerkat_app="/Applications/MeerkaT3.app"
meerkat_executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$meerkat_app/Contents/Info.plist")
T3CODE_SHARED_EVIDENCE_MAX_BYTES=536870912 \
T3CODE_SHARED_EVIDENCE_MAX_RECORDS=200000 \
"$meerkat_app/Contents/MacOS/$meerkat_executable"
```

The app passes these settings to its managed server. Keep them in the host's
launch script for subsequent starts; opening the app from Finder does not retain
a terminal's environment settings. Preserve any custom profile launch options.

Use the profile path and other launch options already configured for that host.
This preserves workspace identity, specialist identities, admitted requests and
saved evidence. Confirm the effective limits in the capacity overview, then retry
the refused publication. Lowering a limit below existing usage also preserves
data: reads, retries and acknowledgements remain available, while new evidence
growth is refused until capacity is raised again.

There is no automatic deletion, destructive specialist retirement, or in-flight
transfer. Do not delete database rows to make room. Safe automated archive or
retirement requires native drain and handover support.

The capacity overview also reports retained requests without an observed terminal
outcome and pending composition operations. These are app observations, not a
second native queue or proof of completed work. Evidence accounting is not the
SQLite file size or a disk quota: native transcripts, request receipts, directory
metadata, indexes, logs and repositories need ordinary disk monitoring and
backups independently. Keep enough free space for those files and their backups.

## Upgrade and reconnect

1. Coordinate a host maintenance window. Finish or stop active work, retain the
   previous app and create a verified offline backup before changing versions.
2. Replace the app with the qualified candidate and reopen the same profile.
   Check workspace identity, registered projects, specialist assignments and
   native availability before asking participants to resume.
3. Reconnect an existing participant and reconcile its saved request. An
   unresolved outcome stays unresolved until its exact native receipt is
   observed; a newer message in the conversation is not its result.
4. Fetch an outstanding briefing. Its sealed batch should remain unchanged until
   acknowledged explicitly. Reading or acknowledging it does not prove that an
   agent completed work.

Do not start an older executable against a profile already migrated by the new
version. To recover the previous version, retain the upgraded profile and use the
matching offline backup and original app through the documented restore flow.

## Release acceptance

Run the [native integration fixtures](development.md#shared-collaboration-checks)
against the final gateway and server, then verify the packaged client itself.
Loopback fixtures prove application and native integration. The explicit
`T3CODE_TEST_SHARED_TLS=1` fixture also checks TLS certificate validation and
delegation over WSS with a disposable certificate authority. That is a loopback
transport qualification; it does not establish a physical remote deployment,
production reverse proxy, live account authentication or acceptable user
experience.

For a candidate that includes shared workspaces, retain evidence of:

- Two independently paired participants, separate local branches and tasks, and
  one persistent specialist. Concurrent requests must retain the correct author,
  task, revision and outcome after a peer message and an orderly host restart.
- Participant setup and explicit local-task consent against the selected host.
  Same-Mac qualification can use loopback HTTP with separate host and personal
  profiles. Verify discovery, scoped send, an observation, reconnect catch-up,
  expiry and revocation. Confirm shared credentials cannot call host file,
  terminal or account-setting APIs.
- A reviewed dirty-checkout snapshot and a rejected stale preview. Verify the
  request and task grant retain the approved patch, while unsupported or
  nonignored untracked changes block sharing without silent omission.
- An immutable briefing retried across an offline interval, explicit batch
  acknowledgement, and retained correction history without rewriting old
  evidence or assigning background output to another person's request.
- Host backup and recovery, plus a narrow client layout with long specialist and
  repository names. Check that requests, saved work and access controls remain
  usable after reconnect.

Before advertising deployment across computers, repeat the participant and task
journeys against an actual remote HTTPS host. That is an additional remote-rollout
gate, not a prerequisite for the same-Mac hosting option. Keep the loopback TLS
fixture result separate from this physical deployment evidence.

Record any untested journey as a limitation of that candidate. Directory and
evidence limits are documented in the [shared architecture](../internals/shared-workspace.md);
bounded records and passing fixtures do not establish production scale or model
quality. Shared participation does not promise automatic destructive retirement,
transfer of in-flight work, runtime federation or migration between hosts.

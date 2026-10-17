# Shared specialists

The shared workspace extends the environment server. A user's task agents and
checkout remain on that user's environment. One always-on host owns shared
specialists, repository registrations, activity inboxes and evidence.

## Authority

Meerkat and Meta own native identity, conversation, pending work, delivery and
lifecycle. A directory specialist refers to one host project agent. Assignments
can place that specialist in several shared projects without creating new native
agents. Local checkout attachment never copies conversations or retires local
agents.

The app owns repository aliases, participant attribution, work context, activity
acknowledgements, evidence and composition intent. Operation completion requires
observed native receipts where a native action was requested. A disconnected
client cannot stop a host agent. An uncertain send is reconciled using its original
identity, never repeated with a new request ID.

## Repository and revision identity

Match remote repository identities, not directory names. SSH and HTTPS forms of
the same remote normalize to one identity. Explicit aliases handle renames and
mirrors. Fork ancestry is separate from aliases and does not merge projects.

Every work event carries its exact branch, commit and optional content-addressed
patch. Store that revision with the event, not as a reference to a mutable
checkout head. Proposed, branch-local and merged evidence have distinct
applicability. Merging code changes applicability; it never merges agents or
their transcripts.

## Connections and permissions

Use the existing authenticated connection transport with explicit shared
permissions. Shared participation must not grant host terminal, arbitrary file,
provider-account or server-settings access. Attribute publications from the
authenticated session or an explicitly bound native tool invocation. Do not
trust a participant ID supplied in message text.

Specialists inspect explicit revisions through repository readers. Repository
read access is distinct from the native blanket read-only execution policy:
communication, evidence and composition tools need their own positive
capabilities. Shell and arbitrary MCP tools cannot be permitted under a claim
that repository access is read-only.

## Durable collaboration

Activity publication and recipient inbox insertion commit atomically. A stable
event ID makes retries idempotent; reusing it with different content is a conflict.
Reads seal bounded, immutable batches with retained observation references.
Recipients acknowledge those batches. An acknowledgement proves only that the
product batch was acknowledged, not native admission, inference or task completion.
Live notifications are hints. Reconnect and periodic reads recover the durable
inbox without requiring native subscriptions. This does not promise exactly-once
model reasoning. Native facts retain owner references and source-qualified
cursors instead of becoming duplicate product-owned facts.

Evidence is append-only and revision-qualified. Recording a correction commits
its evidence, reverse lineage and a durable correction activity together. Recipient
matching includes the original evidence's areas as well as the correcting task's
areas. The correction keeps its own author, context and revision; delivery does
not turn a branch-local finding into merged truth. The `knowledge.supersede`
capability authorizes this associated notification without requiring a separate
`activity.publish` grant. A failed fan-out or size check rolls back the whole write.

Knowledge search combines structured filters with literal full-text lookup.
Every hit includes bounded direct correction references even when the correction
text does not match the original query. Fetch a referenced correction with
`evidenceId`; page all direct corrections with `supersedes`. The hit's original
payload remains immutable. Its correction references are a current lineage
observation, not a rewrite or a claim that one correction is universally applicable.
`hasMoreCorrections` distinguishes a complete reference list from a bounded one.

Activity and evidence admission are limited to 128 KiB of encoded content;
inbox and knowledge response pages are limited to 192 KiB. Inbox batches stay
sealed until acknowledged; cursors resume matching records that did not fit on
the previous page. An unreadable oversized retained record is reported rather
than silently skipped. Publication also enforces the workspace fan-out limit.
These are product storage and delivery bounds, not a model cost budget.

## Delivery gates

1. Two independently authenticated clients use one persistent specialist,
   conversation and native queue. Every request retains its caller, task,
   repository, revision and exact native outcome binding across concurrent
   requests, peer/scheduler wakes and supported restart recovery. Unresolved
   outcomes stay unresolved; the latest output is never a substitute.
2. Two local task agents on different branches publish work and receive relevant
   specialist briefings, including after an offline interval.
3. A durable composition operation creates independently owned specialists,
   revises assignments or splits/consolidates future responsibility. Superseded
   predecessors remain available for already-admitted work and retain the
   original reply bindings. Evidence transfers retain references and lineage.
4. A two-user, two-repository pilot verifies overlap detection, new specialist
   creation, corrections, concurrency and resource limits.

These are acceptance gates, not claims that every stage is already available.
Federation, arbitrary runtime migration and cross-runtime transcript forks are
outside this version. Automatic destructive retirement and general in-flight
handover depend on upstream admission/drain and coordinated handover contracts.
App routing changes do not claim to close native peer or scheduler ingress.

## Exact request evidence

A shared request retains the authenticated participant, immutable context version,
specialist reference and original native send ID before admission. Native receipt
reconciliation supplies the accepted session and interaction. Only that exact
interaction's terminal frame can resolve the request. A sessionless terminal frame
requires the gateway's exact-interaction binding; a general conversation frame or
the most recent assistant message cannot stand in for it.

Context updates append versions. Delayed requests, activity and evidence continue
to reference the version they admitted, including its objective and full commit.
Native tool calls receive their session and interaction lineage from the runtime.
The server verifies the currently observed read-only repository policy before
accepting the caller, then resolves writes to that interaction's retained context.
An unrelated peer turn can fetch its own inbox but cannot borrow another caller's
task attribution.

The private callback listener binds only to loopback, uses an ephemeral process
credential and rejects browser origins and redirects. It is separate from public
participant RPC. The server configures its native gateway through a private startup
call. That gateway keeps the callback configuration in owner-scoped memory and
accepts only an identical retry. It is never passed to agent subprocesses through
environment variables, persisted in agent configuration or exposed in tool schemas.
Shared participant credentials do not grant host files, terminals, model accounts
or configuration access. Repository tools use immutable Git objects and explicit
full commits; they do not check out a branch or run repository hooks.

Local patch preview is a separate `orchestration:read` operation. It resolves only
the selected project or active task checkout, captures tracked working-tree
changes against the full HEAD commit, and returns the branch, file list, exact
SHA-256 and byte count before any upload. Capture disables external diff,
text-conversion, clean-filter and filesystem-monitor commands; repeated patch,
status, index and HEAD observations reject a concurrent change. The preview is
bounded to a 1 MiB patch, 1 MiB per input blob/file, 16 MiB total source content,
256 changed files and 45 seconds. Ignored entries are disclosed
as excluded metadata without traversing ignored trees. Untracked files, binary
changes, symlinks, submodules, detached HEAD, configured content filters and
incomplete or oversized observations return an unsupported result with no patch.

An uploaded snapshot remains retained evidence, never a patch applied to the
shared host. Before a new local task delegation is admitted, the personal broker
reads the authenticated participant's exact remote context, checkout association
and retained snapshot metadata. It compares those with a fresh capture of that
local task's worktree, including base commit, branch, digest and size. An opaque
snapshot ID alone grants nothing. Already admitted retries retain their original
immutable revision and do not reinterpret later checkout changes.

The implementation boundaries are
[request custody](../../apps/server/src/shared/SharedSpecialistService.ts),
[native tool authorization](../../apps/server/src/shared/SharedToolService.ts),
[repository inspection](../../apps/server/src/shared/SharedRepositoryReader.ts), and
[product evidence](../../apps/server/src/shared/SharedWorkspaceStore.ts).

## Recovery verification

The opt-in
[two-client native test](../../apps/server/src/shared/SharedSpecialist.server.native.test.ts)
uses disposable repositories, independent scoped credentials and a loopback model
fixture. It holds concurrent requests apart, checks exact committed repository
content through the native tool callback, reconnects a participant to an immutable
inbox batch, and restarts the host against its original state directory. It must
run against a freshly built server and verified runtime bundle. Skipping it does
not establish the shared identity or restart gate.

The native receipt tests separately insert peer and scheduler completions around
two caller requests. Keep this distinction in test reports: a synthetic native
receipt test proves correlation rules; it is not a deployment or live scheduler
test. An orderly restart test also does not establish recovery after arbitrary
process termination during admission.

## Discovery and future responsibility

Discovery filters the application directory by canonical shared project, literal
repository paths, exact tags and responsibility text. Each match identifies the
assignment that matched. Excerpts are labelled and bounded; they are not a second
charter. Directory results do not infer native reachability or lifecycle. A stale
assignment version must be refreshed before using it to open a contextual action.

Composition records an actor-scoped immutable intent before native calls. Stable
creation IDs reserve capacity and survive uncertain acknowledgements. Independent
project agents are created through the existing native owner, not as children of
the requesting specialist. Native instruction activation and peer connections
must be observed before a corresponding application operation is completed.

Future routing, interest indexes and predecessor lineage change in one database
transaction. Expected assignment versions reject concurrent edits. Successor
validation rejects cycles or a successor that disappears during the same cutover.
A request admitted before cutover keeps its original owner, context and result
binding. The claim transaction rechecks routing after asynchronous native reads,
so a newly superseded owner cannot accidentally admit new work through this path.
It also refuses new admission while the specialist has a pending composition
reservation: native responsibilities may already have changed before the final
directory cutover. The caller can retry the same unsent request after the change
finishes. Accepted or uncertain deliveries remain available for reconciliation
against their original native receipts throughout the change.

A pending or conflicting operation is an observation of incomplete composition,
not evidence that all runtime effects were rolled back. Retrying an admitted
operation must use its original actor, ID and immutable input. `operations.get`
only observes the retained result. No composition action destroys or retires the
predecessor.

A server-scoped continuation resumes pending operations without a client or a
second agent turn. It reserves one candidate durably before native I/O, attempts
at most four candidates per pass, bounds each attempt to 15 seconds, then waits
two seconds before the next pass. A retained cursor and frozen scan boundary
prevent slow operations or new arrivals from starving older intents across a
service restart. The continuation validates the saved actor, operation key and
input fingerprint, then reuses the same creation IDs, revision IDs and target
reservations through the ordinary execution path.

This is especially important for self-revision. A specialist cannot activate its
own new instructions while its current tool turn is busy. The operation remains
pending; after the turn ends, continuation asks the native owner to apply that
same revision at its verified idle boundary. Neither the busy guard nor native
activation is replaced by an application timer. Native uncertainty leaves the
operation pending and its evidence intact for a later bounded attempt.

## Personal task delegation

The personal broker is an explicit opt-in on the participant's environment. It
stores the paired shared-account credential in the existing secret store; product
rows and browser recovery drafts contain only nonsecret metadata and request IDs.
Connection setup, grant creation and uncertain retries use retained IDs. Canceling
setup saves an owner-scoped tombstone before credential cleanup so a delayed
response or later retry cannot recreate it. If setup already completed, cancellation
uses the full disconnect path.

The local server verifies the selected task's current native coordinator, mob and
session. The shared server binds the delegation to its authenticated parent
participant and immutable checkout context, with a bounded action list and expiry.
The remote identity is explicitly a participant-broker assertion: a remote Core
instance has not attested that local agent's identity. This provenance travels
with published observations and request authorship. A grant installs interests
from that exact context for its agent inbox. Matching excludes expired or revoked
grants, inactive parent sessions and grants without inbox access.

Opening a task can discover its project's specialists without publishing the
prompt or delegating authority. The user separately chooses the task, immutable
objective and revision, allowed actions and expiry. Granting `activity.publish`
announces the captured objective once as `task_started`, atomically with grant
creation. Without that action, enabling a grant does not announce the objective.
A later task-title or context edit cannot rewrite the retained announcement.

Every forwarded call verifies the live local owner, unrevoked local grant and
parent session. A bounded WebSocket connection checks the expected remote
environment, workspace and participant before the operation on that same socket.
It follows no redirects, performs no automatic reconnect or mutation replay, and
exposes no transport error that could contain credentials. The remote host checks
its parent session and saved grant again. Product writes repeat that check inside
their transaction.

The native local dispatcher advertises only discovery, specialist requests,
product activity, evidence and inbox actions. The broker supplies the grant's
exact context and revision, rejecting conflicting model arguments. It exposes no
composition, repository file, terminal or account-management capability. Registered
host specialists use their separate native verification path; a failed check
never falls back to the personal broker.

Revocation blocks local dispatch before remote I/O. While an account remains
connected, a lost acknowledgement can be reconciled using the retained grant.
Removing the stored account also removes its private credential, even if the
remote host or parent login is unavailable. The retained removal result separately
records whether remote revocation was confirmed. An unconfirmed result is not
proof that remote grants were revoked; their parent-session and expiry checks
still apply. Expired or disconnected grants never gain a new session or revision
by inference. A fresh explicit enable can replace an expired admission with a new
request ID and current native binding; it preserves the old grant and its expiry
and revocation evidence. An unexpired grant still requires revocation before its
connection or context can change.

The boundaries are [remote grants](../../apps/server/src/shared/SharedDelegationService.ts),
[personal credential custody](../../apps/server/src/shared/SharedLocalDelegationService.ts),
[bounded transport](../../apps/server/src/shared/SharedDelegationRemote.ts), and
[composition](../../apps/server/src/shared/SharedCompositionService.ts).

## Verification boundaries

The [composition tests](../../apps/server/src/shared/SharedCompositionService.test.ts)
use real application SQLite and controlled native-adapter responses. They cover
lost creation acknowledgements, competing reservations, split and consolidation
cutover, retained predecessor requests and history, and bounded continuation
across service reconstruction and slow observations. They establish the
application contract; they do not prove a live native split or crash recovery.

The [three-server expansion fixture](../../apps/server/src/shared/SharedExpansion.server.native.test.ts)
uses one shared host and two personal environments with distinct repositories and
branches. It exercises real native tool callbacks, exact delegated request
attribution, interest-matched inboxes, independent specialist creation and peering,
revocation, and correction delivery. It captures actual local patches, validates
snapshot-backed task grants, and reads the immutable snapshot through native tools.
It also requires publication from a peer-delivered inbox event without borrowing
participant attribution or changing retained request outcomes and sealed batches.
Self-revision must remain pending during its requesting turn, complete through
continuation at native idle, and retain the same specialist and session. Original
query text must reveal a differently worded correction and permit exact retrieval.

The strengthened expansion fixture passed against the built server and locked
0.9.1 runtime on 2026-10-17 in 62.71 seconds (63.22 seconds for the test runner):
three actual servers, 48 controlled provider requests, all 12 completion markers,
no provider errors, and owned cleanup complete without forced termination.
Its retained `shared-expansion-acceptance.json` has SHA-256
`bb0712674cecf23f752ebbeaeeab675cf92cdcbc58c4a8624b259df6e637e653`.
That qualification applies to the artifacts recorded in the evidence, not later
source changes or arbitrary crash timing.

The separate [composition restart fixture](../../apps/server/src/shared/SharedComposition.server.native.test.ts)
holds a real native control turn to leave a split pending after creating a
permanent successor. It completes and retains an admitted product request, stops
and reopens the actual host, reconnects the exact native owners, and requires the
saved operation to finish through background continuation. It then consolidates
future responsibility into a new permanent specialist while a predecessor request
is still admitted, requiring that request to complete on its original session and
interaction. It uses public RPC and lifecycle APIs, with no SQL seeding or test
hooks. The unrelated control turn may be canceled by orderly shutdown; this is
not a claim of active model-call migration across restart.

The composition restart fixture passed on 2026-10-17 in 70.20 seconds (70.73 seconds
for the test runner), with no provider errors and owned cleanup complete. Its
retained `shared-composition-acceptance.json` has SHA-256
`a7e854ac99d77b1afbe36581b010a797f159224aec381373299065678a0d546a`.
The fixture verifies the exact pending record after the old process exits, before
starting the replacement host.

Both final runs used server entry SHA-256
`a5fbadbaac00bef3cda9eff5627dd6193dd8c2ab57f6c9650e7e9dac43ddb6f1`
and the locked Meerkat/Meta 0.9.1 runtime, whose native binary SHA-256 is
`02554576291b9863e1fa3d05f740c28e66c66db77e18ca9063a21779bb428d5a`.
This qualifies those recorded artifacts, not later source changes. Neither
scripted fixture establishes autonomous judgments from a live provider. Use the
commands and evidence requirements in the
[development guide](../operations/development.md#shared-collaboration-checks).

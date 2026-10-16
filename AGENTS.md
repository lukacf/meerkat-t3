# Working on MeerkaT3

MeerkaT3 is a macOS-first development workspace built on T3 Code and the Meerkat
runtime. Its central workflow is long-lived project specialists: generate agents
from a repository's domains, work with them across threads, and connect peers
within and across projects. Meerkat Meta owns multi-agent execution and delivery.

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[development guide](docs/operations/development.md) before changing the repository.
The supported preview is the Apple Silicon Mac desktop app and its local web/server
stack. Inherited mobile, relay, marketing, and other-platform code is not a claim
that those products are supported by MeerkaT3.

## Boundaries that matter

- Meerkat is the only agent runtime exposed by this product. Provider accounts and
  supported models come from its native auth and catalog APIs. Do not add a second
  source of model availability, credentials, agent state, or peer-delivery truth.
- Native execution, session identity, lifecycle, storage custody, and peer routing
  belong to Meerkat and Meta. The app translates native facts into its contracts and
  UI. A queued request, a completed turn, and released storage are different facts.
- Project specialists remain first-class in project navigation. Thread agents and
  their conversations belong with the thread. Do not replace this model with a
  separate generic team administration page or fixed roles such as Reviewer.
- Preserve the original T3 Code attribution and license. Inherited `t3`, `@t3tools`,
  and `mobkit` identifiers remain where changing them would break compatibility.
  They are not alternate supported products or release destinations.

## Repository map

- `apps/web`: React UI, also rendered by Electron.
- `apps/desktop`: Electron shell, native integration, packaging, and support export.
- `apps/server`: environment-owned files, Git, terminals, RPC, and native adapter.
- `apps/server/src/provider/meerkat`: project agents, peer links, native transport,
  auth, model options, checkpoints, and recovery.
- `core`: the in-repository Rust gateway and stdio executable, with locked Meerkat
  and Meta dependencies. Use `scripts/repo-cargo` for this workspace.
- `packages/contracts`: typed wire contracts; `packages/client-runtime`: shared
  client state; `packages/shared`: reusable utilities.
- `docs/user`: task-oriented product guides, bundled into the app.
- `docs/internals`: durable architectural constraints and decisions.
- `docs/operations`: contributor setup, diagnosis, and distribution.

For Effect code, follow nearby implementations and the checked-in reference under
`.repos/effect-smol` when present. Reference repositories are read-only material,
not runtime dependencies.

## Protect concurrent work

Use an isolated checkout and test profile. Preserve unrelated edits. Never start a
server against an installed user's profile or open its SQLite files read-write.
Tests should use synthetic repositories and explicit loopback provider fixtures;
copying a real profile also copies private conversations and potentially secrets.

Stop only processes you started and whose PIDs you retained. Do not kill by process
name, executable path, or a broad matching pattern. A user may be running this app,
a VM, and other agents while you work. Do not restart their app as a build step.

Keep `VITE_HTTP_URL` and `VITE_WS_URL` unset during development. The dev runner's
single-origin proxy is required for authenticated remote browsers. Treat pairing
URLs, auth callbacks, tokens, environment files, and support evidence as private.

## Verification

Run the smallest meaningful checks for the changed behavior. Use the commands in
the development guide; CI runs the supported workspace suite. Pure unit checks
must not need real model credentials. Native integration tests opt in to an exact
binary and use disposable state and local provider fixtures.

For lifecycle work, wait for native receipts and actual worker drain. A timeout,
empty queue, or closed sender is not proof of shutdown. For UI work, verify the
integrated result in a real client when authorized, including narrow layouts,
loading/error states, keyboard focus, and reconnect behavior. Do not start browsers
or dev servers in parallel subagents.

Use UI primitives and semantic tokens. Keep appearance in components that own it,
layout in their parents, and provider logic at the adapter boundary. Test observable
behavior rather than duplicating implementation or asserting component wiring.

## Documentation and changes

Update user guidance when a task or decision changes. Keep internal documentation
for reasons and traps that cross component boundaries; link to source instead of
copying types or narrating every method. Rewrite obsolete guidance rather than
appending a second contradictory account.

Keep scratch notes, audit logs, screenshots, and generated runtime bundles outside
tracked source unless they are intentional product assets or fixtures. Describe
what changed, why, and what was verified in a pull request. Include before/after
images for visual changes and interaction evidence where timing matters. Do not
create or publish a pull request unless the user requested that action.

Publishing source and publishing an executable are separate operations. Use the
[release guide](docs/operations/release.md); never invoke donor publishing or
service-deployment workflows. Do not claim release qualification from unit tests.

Use ASCII hyphens in newly authored text.

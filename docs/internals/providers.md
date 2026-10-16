# Native runtime and account boundaries

MeerkaT3 exposes one execution runtime: Meerkat, composed through Meerkat Meta.
OpenAI, Anthropic, GitHub Copilot, and other native account types are credentials
and model backends within that runtime. They are not alternate app-level adapters.
Legacy adapter code and `provider` identifiers remain for inherited contracts and
saved data; they must not leak into the product as a second setup system.

## The native gateway owns meaning

The Node server talks to the in-repository `meerkat-desktop-stdio` executable using
[the gateway client](../../apps/server/src/provider/meerkat/MeerkatGatewayClient.ts).
The [adapter](../../apps/server/src/provider/Layers/MeerkatAdapter.ts) translates
native run facts into the server's typed orchestration contract. It must preserve
native session identity, terminal failures, delivery receipts, and cancellation
outcomes rather than inventing success from transport closure.

Meta 0.9 renamed the upstream crate from `meerkat-mobkit` to `meerkat-meta`. The
Cargo dependency alias and some app RPC/manifest fields retain `mobkit` for
compatibility. This is one runtime, not two installations. The gateway translates
app-facing `mobkit/*` methods to the native `meta/*` surface.

## Authentication before model availability

[Account operations](../../apps/server/src/provider/meerkat/MeerkatControlsService.ts)
route to native auth APIs on the selected environment. Global and project config
must retain the exact native account identity. A successful OAuth browser redirect
alone is not proof that credentials were stored or that a model can be used.

Passive status must not prompt for credentials, open an OAuth browser, or read a
protected secret interactively. An unknown credential observation stays unknown.
The explicit `auth.v1.check` action performs a bounded native credential check;
login, deletion, default changes, and checks invalidate affected model projections.
Do not turn a cached connected label into proof of current access.

Models, recommendation status, reasoning choices, and account availability come
from the native catalog. Preserve provider-qualified model identity through
selection and dispatch, even when the UI uses a friendly label. Never manufacture
cross-provider model variants or restore an old catalog after an authoritative
empty result. Prompt caching is selected by the native integration where supported;
it is not a user-facing setup option. See [model catalog](model-manifest.md).

## Execution and storage ownership

Long-lived project specialists and thread crews use native agents and peer links.
The app stores presentation and references, while native services own delivery,
agent execution, durable child state, and storage leases. An app event saying work
was requested does not prove that a peer received or completed it.

A clean shutdown closes admission, drains the exact owned work, and awaits native
actor and storage-release evidence. Retain the same in-progress cleanup future
across cancellation and retry. A closed sender or an elapsed deadline cannot stand
in for physical worker completion. Restoring a conversation must use the same
native identity and owning workspace configuration.

## Capability and recovery boundaries

Unsupported operations must fail before changing workspace state. For example,
conversation rollback is not interchangeable with restoring files from a checkpoint.
Use native capabilities and the explicit execution-mode contract to determine
which actions can be offered. Keep saved history readable when execution is
unavailable.

The gateway's locked identity, required capabilities, helper handshake, and actual
cleanup are checked when provisioning a runtime bundle. Native integration tests
exercise auth, cancellation, isolated workspaces, and restart through the real
stdio boundary using loopback providers. They are separate from mocked adapter
unit tests and packaged-app acceptance.

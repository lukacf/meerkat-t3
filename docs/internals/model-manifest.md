# Model catalog

The active MeerkaT3 model picker is a projection of the Meerkat native catalog and
its account state. Authentication comes first: a backend's static model metadata
does not establish that the current environment has an account able to use it.

The [native catalog projection](../../apps/server/src/provider/Drivers/MeerkatDriver.ts)
retains provider-qualified identity, recommended/supported classification, and
credential availability. Model labels are presentation only; dispatch must retain
the exact qualified model and account binding. A Claude model reached through
Copilot is not an invitation to manufacture the same model under every backend.

Account sign-in, explicit checks, default changes, and removal invalidate affected
catalogs. An authoritative empty catalog clears stale availability. An unavailable
native runtime must not cause the picker to silently switch to a legacy provider's
model list. Saved conversations may still show their previous model while sending
is unavailable.

[Model options](../../apps/server/src/provider/meerkat/MeerkatModelOptions.ts) derive
reasoning choices from native capability data. Unsupported choices are rejected
before dispatch. Prompt caching is automatically configured where supported; it
is not a separate user preference.

The inherited `model-manifest.json` remains input to legacy adapters and metadata
code. It is not the source of account access or the active Meerkat model catalog.
Do not edit it to work around a native auth or catalog integration failure.

Tests should use synthetic model identities and exercise projection, account
changes, and native dispatch. Repeating today's model list in a test turns ordinary
catalog updates into unrelated test maintenance.

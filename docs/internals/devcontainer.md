# Development container

The inherited [container configuration](../../.devcontainer/devcontainer.json)
provides Linux tooling for source inspection and JavaScript checks. It is not the
supported MeerkaT3 desktop or native runtime qualification environment. Use the
[Apple Silicon development path](../operations/development.md) to run the app.

Do not assume that opening a Codespace creates a working agent environment. The
container's setup scripts and caching were inherited from T3 Code and do not replace
native runtime provisioning, account setup, or release checks. Do not publish a
Codespaces or container quickstart until that complete path is verified.

Keep all runtime state in an isolated profile. Do not mount a live desktop profile,
forward credential stores, or copy provider secrets merely to make a check pass.
For web access, preserve the dev runner's single-origin proxy and open the complete
pairing URL on the actual forwarded origin.

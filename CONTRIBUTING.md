# Contributing to MeerkaT3

Bug fixes, documentation improvements, accessibility work, and focused reliability
changes are welcome. For substantial features or architecture changes, open an
[issue](https://github.com/lukacf/meerkat-t3/issues) describing the problem and
proposed direction before investing in implementation. This helps keep work aligned
with long-lived project specialists and connected agent workflows.

## Get a working checkout

Follow the [development guide](docs/operations/development.md). It covers frozen
JavaScript installation, the in-repository native runtime, isolated development
profiles, and scoped checks. No private checkout or provider account is needed to
build or run the local automated fixtures.

Read [AGENTS.md](AGENTS.md) for layer ownership and concurrency precautions. The
[architecture guide](docs/internals/overview.md) explains where application state
ends and native runtime authority begins.

## Send a useful change

Keep one coherent problem per pull request. Explain the behavior before and after,
why the change is needed, and the checks you ran. Add a regression test for behavior
that was broken; documentation-only and cosmetic changes do not need artificial
code tests. Update the relevant user guide when the workflow changes.

For visual changes, include clear before/after screenshots. For interaction or
layout problems, show the relevant viewport and state. Review screenshots, logs,
and reproduction archives for private project content before uploading them.

AI-assisted contributions are welcome and held to the same standard as any other
change. Understand and verify the code you submit. Do not include private prompts,
credentials, conversation histories, or an agent's scratch files in the repository.

CI validates the supported desktop/web/server stack and native integration. A green
unit suite is not a substitute for testing a changed user workflow. Explain any
check you could not run so reviewers can evaluate the remaining uncertainty.

## Report problems and get help

Use [Issues](https://github.com/lukacf/meerkat-t3/issues) for bugs, questions, and
proposals. Include the app version or source commit, operating system, steps to
reproduce, and the observed result. The [support guide](SUPPORT.md) explains how to
collect a useful report. Security vulnerabilities belong in the private channel
listed in [SECURITY.md](SECURITY.md), not a public issue.

## License and attribution

Contributions are licensed under this repository's [MIT license](LICENSE).
MeerkaT3 builds on T3 Code; retain upstream copyright and attribution when adapting
its code or assets. Dependencies retain their own licenses. Changes to packaged
native dependencies must regenerate the matching notice bundle as described in
[distribution](docs/operations/meerkat-distribution.md#native-license-notices).

# Security

Report vulnerabilities privately through
[GitHub vulnerability reporting](https://github.com/lukacf/meerkat-t3/security/advisories/new).
Use this channel for issues involving credential exposure, unauthorized execution,
workspace access, authentication bypass, or data isolation.

Include the affected version or commit, a minimal reproduction, the impact you
observed, and any relevant redacted logs. Do not include real API keys, OAuth tokens,
auth callback URLs, private repositories, or another person's data. Do not open a
public issue containing an unpatched vulnerability.

MeerkaT3 is a preview. Reports should identify the exact build; older preview builds
do not carry a long-term support guarantee. Fixes and any affected-version guidance
will be published with the relevant advisory or release.

## Trust boundaries

Agent execution has the permissions of the environment running it. A connected
client can control that environment according to its granted access. Only connect
to environments you trust, and review the selected access mode before giving an
agent a task. The app is not a sandbox for untrusted repositories or model output.

Model credentials belong to the native runtime on the selected environment.
Opening Settings or checking passive status must not silently start OAuth, read
protected credentials interactively, or substitute another account. An explicit
account check or sign-in may invoke the operating system's credential UI.

Treat pairing links, reusable development tokens, exported profiles, logs, and
conversation archives as sensitive. The built-in support report intentionally
omits these contents; inspect any additional evidence before sharing it.

MeerkaT3 is maintained independently from T3 Code. Report vulnerabilities in this
fork here; do not send its private reports to the upstream T3 team.

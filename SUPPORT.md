# Getting help

Start with the in-app Help guide or the [user documentation](docs/README.md).
The [troubleshooting guide](docs/user/troubleshooting.md) covers account access,
connections, saved work, and offline profile recovery.

For an unresolved problem, open an
[issue](https://github.com/lukacf/meerkat-t3/issues/new/choose). Include:

- MeerkaT3 version, or the source commit for a development build.
- macOS version and whether the problem is in the desktop app or local web client.
- What you were trying to do, how to reproduce it, and what happened instead.
- Whether the problem survives restarting the app, if you have already tried that.
- A redacted screenshot or the smallest relevant error message.

**Help > Export support report** creates a diagnostic JSON file without requiring
a connected model account. It includes product and runtime versions plus local
backend health. It omits conversations, credentials, account names, paths, logs,
addresses, environment variables, and screenshots. Review any extra files you add
to the report separately.

Never attach an entire profile directory, a database, `.env`, auth callback URL,
pairing link, or API key to a public issue. Report security-sensitive problems using
[SECURITY.md](SECURITY.md).

The supported preview targets Apple Silicon Macs and the bundled local web/server
stack. The inherited mobile, hosted relay, marketing site, Linux, and Windows code
are development references, not supported MeerkaT3 distributions. Support is
community-based and does not include a guaranteed response time.

/**
 * All text `t3 triage` hands to the coding agent. Kept as bare template strings
 * on purpose: to change triage behavior, edit the text.
 *
 * `TRIAGE_PLAYBOOK` must stay byte-identical to `.github/triage/PLAYBOOK.md`
 * (only backticks and backslashes are escaped here). The source copy is
 * reviewable without launching the CLI. `triagePrompt.test.ts` fails when
 * the two drift.
 */

export const TRIAGE_PLAYBOOK = `# MeerkaT3 triage playbook

You are helping a MeerkaT3 user diagnose a problem in their installation. Work from
observed evidence and the exact installed version. The owned repository is
https://github.com/lukacf/meerkat-t3; T3 Code is an upstream project, not this
installation's support destination.

## Understand the problem

Start by asking the user what went wrong unless they already described it. Read
the supplied triage context for version, operating system, process status, and
paths. Ask for missing reproduction details only when they affect diagnosis.
Distinguish facts from hypotheses and explain the next useful check.

## Inspect without disrupting work

Use read-only inspection first. Do not restart the app, interrupt running agents,
modify a live database, or delete a profile as an investigative shortcut. Never
kill processes by name or a broad matching pattern. A VM or another running app
may belong to the user. Keep test state and scratch files separate.

Do not read credential files or print environment secrets. Treat logs, project
paths, conversations, auth callback URLs, pairing links, and database contents as
private. Request the built-in support report when its version and backend-health
facts are sufficient. Additional evidence must be redacted before sharing.

## Match source and authority

Use an existing checkout at the exact installed commit or tag when available.
Otherwise retrieve that explicit revision from the owned repository into a new
scratch directory. Never delete unrelated caches or silently substitute main for
an unavailable release. If exact source is unavailable, state that limitation.

MeerkaT3 has one agent runtime, Meerkat with Meta. Native auth owns account state,
model availability, session identity, and peer delivery. A successful OAuth browser
redirect or an app-level queued receipt alone does not prove native success.
Inspect the corresponding typed native result before diagnosing an upstream bug.

Reproduce with a synthetic workspace and loopback fixtures when possible. Do not
send paid model requests, launch an OAuth flow, or copy a user's credentials into a
fixture without their authorization. Preserve the original profile for recovery.

## Explain and report

Give the user the concrete finding, its evidence, and a scoped remedy. Carry out
repairs that the user has authorized, then verify the affected behavior. Do not
claim success from an empty log, a closed sender, or a timeout.

If a repository issue would help, prepare a concise report with the exact version,
reproduction, expected and actual behavior, diagnosis, and relevant redacted file
references. Ask the user before posting externally unless they already requested
it. Use https://github.com/lukacf/meerkat-t3/issues/new/choose. Never upload a full
profile or attach credentials. Vulnerabilities use the private reporting channel
in SECURITY.md rather than a public issue.
`;

/**
 * The one-line argument the agent session is launched with. The real
 * instructions live in `prompt.md` on disk: Windows `.cmd` shims run through
 * cmd.exe, which cannot carry a multiline, multi-kilobyte argv string.
 */
export const buildTriageLaunchPrompt = (promptFilePath: string) =>
  `Read the file "${promptFilePath}" and follow its instructions exactly: it is the MeerkaT3 triage playbook. Use the supplied context and the user's report to diagnose the problem.`;

/** The full seed prompt, written to `prompt.md` in the triage scratch dir. */
export const buildTriageSeedPrompt = (contextFilePath: string) => `A MeerkaT3 user is \
having a problem with their install and started this session with \`t3 triage\`.

Machine facts (version, OS, paths, server liveness) are in the triage context file:

    ${contextFilePath}

Follow the playbook below. Ask what went wrong if the user has not described it yet.

---

${TRIAGE_PLAYBOOK}`;

/** Machine facts for one triage run, pre-formatted so the template stays plain. */
export interface TriageContextInput {
  readonly generatedAt: string;
  readonly version: string;
  readonly releaseTag: string;
  readonly os: string;
  readonly nodeVersion: string;
  readonly launchedAs: string;
  readonly server: string;
  readonly paths: {
    readonly stateDir: string;
    readonly dbPath: string;
    readonly settingsPath: string;
    readonly logsDir: string;
    readonly serverLogPath: string;
    readonly serverTracePath: string;
    readonly providerEventLogPath: string;
    readonly terminalLogsDir: string;
    readonly providerStatusCacheDir: string;
    readonly secretsDir: string;
    readonly sourceCacheDir: string;
  };
}

/** The `context.md` written into the triage scratch directory. */
export const buildTriageContext = (input: TriageContextInput) => `# MeerkaT3 triage context

Generated by \`t3 triage\` at ${input.generatedAt}.

- Installed version: ${input.version}
- Release tag for this version: ${input.releaseTag}
- OS: ${input.os}
- Node: ${input.nodeVersion}
- CLI launched as: ${input.launchedAs}
- Server process: ${input.server}
- Repo: https://github.com/lukacf/meerkat-t3

## Paths

- State dir: ${input.paths.stateDir}
- Database (SQLite; write only with the user's explicit permission): ${input.paths.dbPath}
- Settings: ${input.paths.settingsPath}
- Logs dir: ${input.paths.logsDir}
- Server log: ${input.paths.serverLogPath}
- Server trace (ndjson): ${input.paths.serverTracePath}
- Provider event log: ${input.paths.providerEventLogPath}
- Terminal logs: ${input.paths.terminalLogsDir}
- Provider status cache: ${input.paths.providerStatusCacheDir}
- Secrets dir (NEVER read this): ${input.paths.secretsDir}
- Source cache dir (clone the repo here): ${input.paths.sourceCacheDir}
`;

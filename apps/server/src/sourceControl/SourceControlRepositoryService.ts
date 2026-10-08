import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import {
  SourceControlProviderError,
  SourceControlRepositoryError,
  type SourceControlCloneRepositoryInput,
  type SourceControlCloneRepositoryResult,
  type SourceControlCloneProtocol,
  type SourceControlProviderKind,
  type SourceControlPublishRepositoryInput,
  type SourceControlPublishRepositoryResult,
  type SourceControlPublishResume,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryInfo,
  type SourceControlRepositoryLookupInput,
} from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import { expandHomePathWith } from "../pathExpansion.ts";
import {
  parseGitCloneProgressLine,
  type GitCloneProgressLine,
} from "../project/gitCloneProgress.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { GitHubCliAuthenticationError } from "./GitHubCli.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);
const isSourceControlProviderError = Schema.is(SourceControlProviderError);
const isGitHubCliAuthenticationError = Schema.is(GitHubCliAuthenticationError);

export class SourceControlRepositoryService extends Context.Service<
  SourceControlRepositoryService,
  {
    readonly lookupRepository: (
      input: SourceControlRepositoryLookupInput,
    ) => Effect.Effect<SourceControlRepositoryInfo, SourceControlRepositoryError>;
    /**
     * Everything `cloneRepository` checks before running git: the resolved
     * remote, the normalized destination, and that the destination is empty.
     * Lets a caller create the project first and clone afterwards.
     */
    readonly prepareClone: (
      input: SourceControlCloneRepositoryInput,
    ) => Effect.Effect<SourceControlPreparedClone, SourceControlRepositoryError>;
    readonly cloneRepository: (
      input: SourceControlCloneRepositoryInput,
      options?: SourceControlCloneOptions,
    ) => Effect.Effect<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;
    /** Removes a partial or failed clone so the destination is empty again. */
    readonly discardClone: (
      destinationPath: string,
    ) => Effect.Effect<void, SourceControlRepositoryError>;
    readonly publishRepository: (
      input: SourceControlPublishRepositoryInput,
    ) => Effect.Effect<SourceControlPublishRepositoryResult, SourceControlRepositoryError>;
  }
>()("t3/sourceControl/SourceControlRepositoryService") {}

export interface SourceControlPreparedClone {
  readonly destinationPath: string;
  /** Credential-free; safe to show and to store in snapshots. */
  readonly remoteUrl: string;
  /** What git is given; may carry embedded credentials. */
  readonly cloneUrl: string;
  readonly repository: SourceControlRepositoryInfo | null;
}

export interface SourceControlCloneOptions {
  readonly onProgress?: (line: GitCloneProgressLine) => Effect.Effect<void>;
  /** Overrides the default clone budget; `null` disables the deadline. */
  readonly timeoutMs?: number | null;
}

// The synchronous RPC (older clients, mobile) keeps a deadline: nothing else
// tells the user a clone stalled. The tracked path passes null and relies on
// progress and Cancel instead.
const CLONE_TIMEOUT_MS = 120_000;
const CLONE_ENV = {
  // `--progress` forces the transfer counters through the pipe; the delay env
  // makes the checkout counter start immediately. No tty means a credential
  // prompt would hang forever, so tell git to fail instead.
  GIT_PROGRESS_DELAY: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
} satisfies NodeJS.ProcessEnv;

function usesGitHubHttps(remoteUrl: string): boolean {
  try {
    const url = new URL(remoteUrl);
    return (
      url.origin === "https://github.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function cloneFailureDetail(remoteUrl: string, stderr: ReadonlyArray<string>): string {
  const detail = stderr.length > 0 ? stderr.join(" ") : "The repository could not be cloned.";
  if (
    usesGitHubHttps(remoteUrl) &&
    stderr.some((line) =>
      /^fatal: (?:Authentication failed|could not read (?:Username|Password))\b/i.test(line),
    )
  ) {
    return `${detail} On this project's computer, run \`gh auth login --hostname github.com\` and \`gh auth setup-git --hostname github.com\`, then retry the clone. These commands reconnect Git to your GitHub CLI account.`;
  }
  return detail;
}

function mapRepositoryError(operation: string, provider: SourceControlProviderKind) {
  return Effect.mapError((cause: unknown) =>
    isSourceControlRepositoryError(cause)
      ? cause
      : new SourceControlRepositoryError({
          operation,
          provider,
          // A typed auth failure can provide fixed recovery guidance without
          // promoting arbitrary provider stderr (which may contain tokens).
          detail:
            isSourceControlProviderError(cause) &&
            cause.provider === "github" &&
            isGitHubCliAuthenticationError(cause.cause)
              ? "GitHub CLI is not authenticated. Run `gh auth login` on this repository's server, rescan Source Control in Settings, and retry."
              : "The source control operation could not be completed.",
          cause,
        }),
  );
}

function toRepositoryInfo(
  provider: SourceControlProviderKind,
  urls: SourceControlRepositoryCloneUrls,
): SourceControlRepositoryInfo {
  return {
    provider,
    nameWithOwner: urls.nameWithOwner,
    url: urls.url,
    sshUrl: urls.sshUrl,
  };
}

/**
 * The URL clients see. A pasted `https://user:token@host/…` must not travel
 * back over `subscribeProjectClones` to every reader; git still gets the
 * original.
 */
function redactRemoteUrl(remoteUrl: string): string {
  try {
    const url = new URL(remoteUrl);
    // Queries and fragments are unnecessary in a displayed clone address and
    // may contain credentials, just like userinfo.
    if (!url.username && !url.password && !url.search && !url.hash) {
      return remoteUrl;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // Do not echo a malformed URL whose credential boundaries are unknown.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remoteUrl)) return "Repository URL not saved";
    return remoteUrl;
  }
}

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>]+/gi;
const URL_TRAILING_PUNCTUATION = /["'),.;:]+$/;

/** Apply the snapshot policy to echoed URLs without losing diagnostic punctuation. */
function redactUrlCredentials(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    const punctuation = match.match(URL_TRAILING_PUNCTUATION)?.[0] ?? "";
    const address = punctuation ? match.slice(0, -punctuation.length) : match;
    return `${redactRemoteUrl(address)}${punctuation}`;
  });
}

function selectRemoteUrl(
  urls: SourceControlRepositoryCloneUrls,
  protocol: SourceControlCloneProtocol | undefined,
): string {
  switch (protocol ?? "auto") {
    case "https":
      return urls.url;
    case "ssh":
    case "auto":
      return urls.sshUrl;
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

  const ensureConcreteProvider = (input: {
    readonly operation: string;
    readonly provider: SourceControlProviderKind;
  }) => {
    if (input.provider !== "unknown") {
      return Effect.succeed(input.provider);
    }

    return Effect.fail(
      new SourceControlRepositoryError({
        operation: input.operation,
        provider: input.provider,
        detail: "Choose a source control provider before continuing.",
      }),
    );
  };

  const lookupRepository = Effect.fn("SourceControlRepositoryService.lookupRepository")(function* (
    input: SourceControlRepositoryLookupInput,
  ) {
    const providerKind = yield* ensureConcreteProvider({
      operation: "lookupRepository",
      provider: input.provider,
    });
    const provider = yield* providers.get(providerKind);
    const urls = yield* provider.getRepositoryCloneUrls({
      cwd: input.cwd ?? config.cwd,
      repository: input.repository.trim(),
    });
    return toRepositoryInfo(providerKind, urls);
  });

  const normalizeDestinationPath = Effect.fn("SourceControlRepositoryService.normalizeDestination")(
    function* (destinationPath: string) {
      const trimmed = destinationPath.trim();
      if (trimmed.length === 0) {
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: "unknown",
          detail: "Choose a destination path before cloning.",
        });
      }

      return path.resolve(expandHomePathWith(trimmed, path));
    },
  );

  const prepareDestination = Effect.fn("SourceControlRepositoryService.prepareDestination")(
    function* (destinationPath: string) {
      const normalizedDestination = yield* normalizeDestinationPath(destinationPath);
      if (yield* fileSystem.exists(normalizedDestination)) {
        const entries = yield* fileSystem
          .readDirectory(normalizedDestination, { recursive: false })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: "unknown",
                  detail: "Destination path already exists and is not a directory.",
                  cause,
                }),
            ),
          );
        if (entries.length > 0) {
          return yield* new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: "unknown",
            detail: "Destination path already exists and is not empty.",
          });
        }
      } else {
        yield* fileSystem.makeDirectory(path.dirname(normalizedDestination), { recursive: true });
      }

      return {
        destinationPath: normalizedDestination,
        parentPath: path.dirname(normalizedDestination),
        directoryName: path.basename(normalizedDestination),
      };
    },
  );

  const prepareClone = Effect.fn("SourceControlRepositoryService.prepareClone")(function* (
    input: SourceControlCloneRepositoryInput,
  ) {
    const preparedDestination = yield* prepareDestination(input.destinationPath);
    let repository: SourceControlRepositoryInfo | null = null;
    let remoteUrl = input.remoteUrl?.trim() ?? null;
    let provider: SourceControlProviderKind = input.provider ?? "unknown";

    if (input.provider && input.repository) {
      repository = yield* lookupRepository({
        provider: input.provider,
        repository: input.repository,
        cwd: preparedDestination.parentPath,
      });
      remoteUrl = selectRemoteUrl(repository, input.protocol);
      provider = input.provider;
    }

    if (!remoteUrl) {
      return yield* new SourceControlRepositoryError({
        operation: "cloneRepository",
        provider,
        detail: "Enter a repository path or clone URL before cloning.",
      });
    }

    return {
      destinationPath: preparedDestination.destinationPath,
      remoteUrl: redactRemoteUrl(remoteUrl),
      cloneUrl: remoteUrl,
      repository,
    } satisfies SourceControlPreparedClone;
  });

  const cloneRepository = Effect.fn("SourceControlRepositoryService.cloneRepository")(function* (
    input: SourceControlCloneRepositoryInput,
    options?: SourceControlCloneOptions,
  ) {
    const prepared = yield* prepareClone(input);
    const useGitHubCredentialHelper =
      usesGitHubHttps(prepared.cloneUrl) && !process.env.GIT_TEMPLATE_DIR
        ? yield* git
            .execute({
              operation: "SourceControlRepositoryService.inspectCloneCredentials",
              cwd: path.dirname(prepared.destinationPath),
              // Match any helper, including partial URL keys. Conditional includes or
              // custom templates may add helpers only once the destination exists.
              args: [
                "config",
                "--includes",
                "--name-only",
                "--get-regexp",
                "^(credential(\\..*)?\\.helper|includeif\\..*\\.path|init\\.templatedir)$",
              ],
              allowNonZeroExit: true,
            })
            .pipe(
              Effect.map((result) => result.exitCode === 1),
              Effect.catch(() => Effect.succeed(false)),
            )
        : false;
    const onProgress = options?.onProgress;
    // Git interleaves progress redraws with its real messages on stderr. The
    // last non-progress lines are what explain a failure ("Repository not
    // found", "Permission denied"), so keep them for the error detail.
    const stderrTail: Array<string> = [];
    const onStderrLine = (line: string) => {
      const parsed = parseGitCloneProgressLine(line);
      if (parsed) return onProgress ? onProgress(parsed) : Effect.void;
      return Effect.sync(() => {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("Cloning into")) return;
        // Git echoes the remote in some failures; the tail becomes user-facing text.
        stderrTail.push(redactUrlCredentials(trimmed));
        if (stderrTail.length > 4) stderrTail.shift();
      });
    };
    yield* git
      .execute({
        operation: "SourceControlRepositoryService.cloneRepository",
        cwd: path.dirname(prepared.destinationPath),
        args: [
          "clone",
          "--progress",
          // Clone-local config also serves later fetch/push after a restart.
          // Only add it when no helper is configured. Git sends approved credentials
          // to every matching helper, so appending to an existing store could copy a token.
          ...(useGitHubCredentialHelper
            ? ["--config", "credential.https://github.com.helper=!gh auth git-credential"]
            : []),
          prepared.cloneUrl,
          path.basename(prepared.destinationPath),
        ],
        timeoutMs: options?.timeoutMs === undefined ? CLONE_TIMEOUT_MS : options.timeoutMs,
        // Progress redraws add up on a slow multi-GB clone. The buffered copy
        // is never read (the tail is kept by hand above), so keep it small
        // and let the line callbacks keep flowing past the cap.
        maxOutputBytes: 256 * 1024,
        appendTruncationMarker: true,
        keepLineCallbacksAfterTruncation: true,
        env: CLONE_ENV,
        progress: { onStderrLine },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider: input.provider ?? "unknown",
              detail: cloneFailureDetail(prepared.cloneUrl, stderrTail),
              cause,
            }),
        ),
      );

    return {
      cwd: prepared.destinationPath,
      remoteUrl: prepared.remoteUrl,
      repository: prepared.repository,
    };
  });

  const discardClone = Effect.fn("SourceControlRepositoryService.discardClone")(function* (
    destinationPath: string,
  ) {
    const normalized = yield* normalizeDestinationPath(destinationPath);
    // Only what git left behind may go. The destination was empty when the
    // clone started, so anything without a `.git` inside was put there by
    // someone else since; refuse rather than delete their files.
    // A missing destination is already discarded; any other read failure
    // (a file in its place, permissions) is not something to remove through.
    const entries = yield* fileSystem.readDirectory(normalized).pipe(
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed<ReadonlyArray<string>>([]),
      ),
      Effect.mapError(
        (cause) =>
          new SourceControlRepositoryError({
            operation: "discardClone",
            provider: "unknown",
            detail: "The clone destination could not be inspected.",
            cause,
          }),
      ),
    );
    if (entries.length > 0 && !entries.includes(".git")) {
      return yield* new SourceControlRepositoryError({
        operation: "discardClone",
        provider: "unknown",
        detail: "Destination path contains files that are not from the clone.",
      });
    }
    // The directory itself is the project's workspace root and must stay;
    // only git's partial contents go. An interrupted git may still be closing
    // files, so removal retries briefly.
    yield* fileSystem.remove(normalized, { recursive: true, force: true }).pipe(
      Effect.andThen(fileSystem.makeDirectory(normalized, { recursive: true })),
      Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 5 }),
      Effect.mapError(
        (cause) =>
          new SourceControlRepositoryError({
            operation: "discardClone",
            provider: "unknown",
            detail: "The partial clone could not be removed.",
            cause,
          }),
      ),
    );
  });

  const publishRepository = Effect.fn("SourceControlRepositoryService.publishRepository")(
    function* (input: SourceControlPublishRepositoryInput) {
      const providerKind = yield* ensureConcreteProvider({
        operation: "publishRepository",
        provider: input.provider,
      });
      const requestedRemoteName =
        input.resume?.remoteName ?? (input.remoteName?.trim() || "origin");
      if (!/^[A-Za-z0-9._](?:[A-Za-z0-9._-]*[A-Za-z0-9._])?$/.test(requestedRemoteName)) {
        return yield* new SourceControlRepositoryError({
          operation: "publishRepository",
          provider: providerKind,
          detail:
            "Use letters, digits, dots, underscores, or internal hyphens for the remote name before publishing.",
        });
      }
      if (
        input.resume &&
        (input.resume.cwd !== input.cwd ||
          input.resume.repository.provider !== providerKind ||
          input.resume.repository.nameWithOwner !== input.repository.trim() ||
          (input.resume.remoteUrl !== input.resume.repository.url &&
            input.resume.remoteUrl !== input.resume.repository.sshUrl))
      ) {
        return yield* new SourceControlRepositoryError({
          operation: "publishRepository",
          provider: providerKind,
          detail:
            "The saved publish target does not match this checkout and repository. Return to the original checkout to finish publishing.",
        });
      }
      // Only a returned create receipt establishes this recovery target. A failed
      // or disconnected create is never inferred to have succeeded.
      const urls = input.resume
        ? input.resume.repository
        : yield* (yield* providers.get(providerKind)).createRepository({
            cwd: input.cwd,
            repository: input.repository.trim(),
            visibility: input.visibility,
          });
      const repository = toRepositoryInfo(providerKind, urls);
      const remoteUrl = input.resume?.remoteUrl ?? selectRemoteUrl(urls, input.protocol);
      const preferredName = requestedRemoteName;
      const resume: SourceControlPublishResume = {
        cwd: input.cwd,
        repository,
        remoteName: preferredName,
        remoteUrl,
      };
      const pending = (status: "remote_pending" | "push_pending", target = resume) => ({
        repository,
        remoteName: target.remoteName,
        remoteUrl,
        resume: target,
        status,
        detail:
          status === "remote_pending"
            ? "The repository was created, but its local remote could not be connected. Check this checkout's Git configuration and permissions, then retry the connection."
            : "The repository and local remote are ready, but the push did not finish. Check the connection and Git transport credentials on this server, then retry the push.",
      });

      let existingResumeRemote = false;
      if (input.resume) {
        const remoteNames = yield* git.execute({
          operation: "SourceControlRepositoryService.publishRepository.resumeRemotes",
          cwd: input.cwd,
          args: ["remote"],
        });
        if (remoteNames.stdout.split(/\r?\n/).includes(preferredName)) {
          existingResumeRemote = true;
          for (const direction of [[], ["--push"]]) {
            const remote = yield* git.execute({
              operation: "SourceControlRepositoryService.publishRepository.resumeRemoteUrl",
              cwd: input.cwd,
              args: ["remote", "get-url", ...direction, "--all", preferredName],
            });
            const currentUrls = remote.stdout.trim().split(/\r?\n/);
            if (currentUrls.some((url) => url !== remoteUrl)) {
              return yield* new SourceControlRepositoryError({
                operation: "publishRepository",
                provider: providerKind,
                detail:
                  "The saved remote now points to another repository. Restore its original destination or finish publishing manually; no remote was changed or pushed.",
              });
            }
          }
        }
      }
      const remoteResult = yield* (
        input.resume
          ? existingResumeRemote
            ? Effect.succeed(preferredName)
            : git
                .execute({
                  operation: "SourceControlRepositoryService.publishRepository.resumeAddRemote",
                  cwd: input.cwd,
                  args: ["remote", "add", preferredName, remoteUrl],
                })
                .pipe(Effect.as(preferredName))
          : git.ensureRemote({
              cwd: input.cwd,
              preferredName,
              url: remoteUrl,
            })
      ).pipe(Effect.result);
      if (Result.isFailure(remoteResult)) return pending("remote_pending");
      const remoteName = remoteResult.success;
      const connectedResume = { ...resume, remoteName };

      // An empty local repo (no commits) would make `git push HEAD:...` fail
      // with an opaque "src refspec HEAD does not match any". Treat this as a
      // partial success: the remote was created and wired up, but there is
      // nothing to push yet.
      const hasCommits = yield* git
        .execute({
          operation: "SourceControlRepositoryService.publishRepository.headCheck",
          cwd: input.cwd,
          args: ["rev-parse", "--verify", "HEAD"],
        })
        .pipe(
          Effect.map(() => true),
          Effect.orElseSucceed(() => false),
        );
      if (!hasCommits) {
        const details = yield* git.statusDetails(input.cwd).pipe(Effect.orElseSucceed(() => null));
        return {
          repository,
          remoteName,
          remoteUrl,
          branch: details?.branch ?? "main",
          status: "remote_added" as const,
        };
      }

      const push = yield* git
        .pushCurrentBranch(input.cwd, null, { remoteName })
        .pipe(Effect.result);
      if (Result.isFailure(push)) return pending("push_pending", connectedResume);
      const pushResult = push.success;

      return {
        repository,
        remoteName,
        remoteUrl,
        branch: pushResult.branch,
        ...(pushResult.upstreamBranch ? { upstreamBranch: pushResult.upstreamBranch } : {}),
        status: "pushed" as const,
      };
    },
  );

  return SourceControlRepositoryService.of({
    lookupRepository: (input) =>
      lookupRepository(input).pipe(mapRepositoryError("lookupRepository", input.provider)),
    prepareClone: (input) =>
      prepareClone(input).pipe(mapRepositoryError("cloneRepository", input.provider ?? "unknown")),
    cloneRepository: (input, options) =>
      cloneRepository(input, options).pipe(
        mapRepositoryError("cloneRepository", input.provider ?? "unknown"),
      ),
    discardClone: (destinationPath) =>
      discardClone(destinationPath).pipe(mapRepositoryError("discardClone", "unknown")),
    publishRepository: (input) =>
      publishRepository(input).pipe(mapRepositoryError("publishRepository", input.provider)),
  });
});

export const layer = Layer.effect(SourceControlRepositoryService, make);

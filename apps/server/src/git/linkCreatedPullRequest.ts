import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import {
  type CommandId,
  pullRequestHostOf,
  type GitRunStackedActionResult,
  type OrchestrationProjectShell,
  type SourceControlProviderKind,
  type ThreadId,
} from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from "../orchestration/Errors.ts";
import {
  CreatedPullRequestLinkStore,
  type CreatedPullRequestLinkIntent,
} from "./CreatedPullRequestLinkStore.ts";

export interface CreatedPullRequestKey {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

const decodeCreationUrl = Schema.decodeUnknownOption(Schema.URLFromString);

/**
 * The identity a stacked action's pull request should be linked under, or
 * null when the action did not leave one behind. Reading the host and
 * repository from the URL keeps the link host-level even when the checkout's
 * remote differs from where the PR was opened (a fork, say); the project is
 * only consulted when the URL is one this cannot read.
 */
export function createdPullRequestKey(
  result: Pick<GitRunStackedActionResult, "pr">,
  project: OrchestrationProjectShell | undefined,
): CreatedPullRequestKey | null {
  const { status, number, url } = result.pr;
  if ((status !== "created" && status !== "opened_existing") || number === undefined || !url) {
    return null;
  }
  const parsed = parseChangeRequestUrl(url);
  if (parsed !== null) return { ...parsed, url };

  // This URL came from a successful provider action, so a GitHub Enterprise
  // result does not need "github" in its hostname to name the created PR.
  const decoded = decodeCreationUrl(url);
  if (Option.isSome(decoded)) {
    const returnedUrl = decoded.value;
    const match = /^\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/u.exec(returnedUrl.pathname);
    if (match) {
      if (
        (returnedUrl.protocol !== "https:" && returnedUrl.protocol !== "http:") ||
        returnedUrl.username ||
        returnedUrl.password ||
        returnedUrl.search ||
        returnedUrl.hash ||
        !Number.isSafeInteger(number) ||
        Number(match[2]) !== number
      )
        return null;
      return {
        host: returnedUrl.hostname.toLowerCase(),
        repository: match[1]!.toLowerCase(),
        number,
        url,
      };
    }
  }
  const identity = project?.repositoryIdentity;
  const kind = identity?.provider as SourceControlProviderKind | undefined;
  const repository = sourceControlRepositorySelector(identity);
  if (!identity || kind === undefined || repository === null) return null;
  return {
    host: pullRequestHostOf(identity, kind),
    repository: repository.toLowerCase(),
    number,
    url,
  };
}

const dispatchCreatedLink = Effect.fn("dispatchCreatedLink")(function* (
  intent: CreatedPullRequestLinkIntent,
) {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  return yield* engine
    .dispatch({ type: "thread.pull-request.link", ...intent, source: "created" })
    .pipe(
      Effect.as("linked" as const),
      Effect.catchTags({
        OrchestrationCommandInvariantError: readBack,
        OrchestrationCommandPreviouslyRejectedError: readBack,
      }),
    );

  function readBack(
    error: OrchestrationCommandInvariantError | OrchestrationCommandPreviouslyRejectedError,
  ) {
    return Effect.gen(function* () {
      const thread = yield* snapshots.getThreadShellById(intent.threadId);
      if (Option.isNone(thread)) return "not_saved" as const;
      const alreadyLinked = thread.value.pullRequests.some(
        (link) =>
          link.host.toLowerCase() === intent.host.toLowerCase() &&
          link.repository.toLowerCase() === intent.repository.toLowerCase() &&
          link.number === intent.number &&
          link.source !== "stack-dismissed",
      );
      if (alreadyLinked) return "linked" as const;
      return yield* error;
    });
  }
});

const attemptCreatedLink = Effect.fn("attemptCreatedLink")(function* (
  intent: CreatedPullRequestLinkIntent,
) {
  const store = yield* CreatedPullRequestLinkStore;
  const status = yield* dispatchCreatedLink(intent).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      () =>
        Effect.logWarning("created pull request link is retained for retry", {
          threadId: intent.threadId,
        }).pipe(Effect.as("pending" as const)),
    ),
  );
  if (status !== "pending") {
    // Replaying an accepted command receipt cannot undo a later explicit unlink.
    yield* store.remove(intent).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        () => Effect.logWarning("acknowledged pull request link cleanup will retry"),
      ),
    );
  }
  return status;
});

/** Retain the exact host result before linking; a retry never runs Git or creates another PR. */
export const linkCreatedPullRequest = <E>(input: {
  readonly threadId: ThreadId;
  readonly result: Pick<GitRunStackedActionResult, "pr">;
  readonly commandId: Effect.Effect<CommandId, E>;
}): Effect.Effect<
  GitRunStackedActionResult["pr"]["linkStatus"],
  never,
  | OrchestrationEngine.OrchestrationEngineService
  | ProjectionSnapshotQuery.ProjectionSnapshotQuery
  | CreatedPullRequestLinkStore
> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      if (input.result.pr.status !== "created" && input.result.pr.status !== "opened_existing")
        return undefined;
      const store = yield* CreatedPullRequestLinkStore;
      const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      let key = createdPullRequestKey(input.result, undefined);
      if (key === null) {
        const thread = yield* snapshots.getThreadShellById(input.threadId);
        if (Option.isNone(thread)) return "not_saved" as const;
        const project = Option.getOrUndefined(
          yield* snapshots.getProjectShellById(thread.value.projectId),
        );
        key = createdPullRequestKey(input.result, project);
      }
      if (key === null) return "not_saved" as const;
      const commandId = yield* input.commandId;
      const intent = { commandId, threadId: input.threadId, ...key };
      // Client disconnect must not roll back receipt capture after host success.
      yield* store.put(intent);
      return yield* restore(attemptCreatedLink(intent));
    }),
  ).pipe(
    Effect.withSpan("linkCreatedPullRequest"),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.logWarning("failed to link created pull request to thread", {
            threadId: input.threadId,
          }).pipe(Effect.as("not_saved" as const)),
    ),
  );

/** The existing PR reactor runs this before branch discovery, including after restart. */
export const retryCreatedPullRequestLinks = Effect.gen(function* () {
  const store = yield* CreatedPullRequestLinkStore;
  const intents = yield* store.list;
  yield* Effect.forEach(intents, attemptCreatedLink, { discard: true });
}).pipe(
  Effect.catchCauseIf(
    (cause) => !Cause.hasInterruptsOnly(cause),
    () => Effect.logWarning("could not load retained pull request links"),
  ),
);

import {
  SharedCheckoutRevisionError,
  type SharedCheckoutRevision,
  type SharedCheckoutRevisionInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VcsProcess } from "../vcs/VcsProcess.ts";
import { sharedGitReadOverrides } from "./sharedGitReadOverrides.ts";
import { sharedGitEnvironment } from "./sharedGitEnvironment.ts";
import { captureSharedCheckoutPatch } from "./SharedCheckoutPatch.ts";

/** No cwd or Git arguments are accepted from the browser. */
export const makeSharedCheckoutRevision = Effect.gen(function* () {
  const projects = yield* ProjectionSnapshotQuery;
  const path = yield* Path.Path;
  const resolve = Effect.fn("SharedCheckoutRevision.resolve")(function* (
    input: SharedCheckoutRevisionInput,
  ) {
    const project = yield* projects.getProjectShellById(input.projectId).pipe(
      Effect.mapError(
        () =>
          new SharedCheckoutRevisionError({
            code: "unavailable",
            message: "Could not read this local project.",
          }),
      ),
    );
    if (Option.isNone(project) || !path.isAbsolute(project.value.workspaceRoot))
      return yield* new SharedCheckoutRevisionError({
        code: "not_found",
        message: "This local checkout is no longer available.",
      });
    let cwd = project.value.workspaceRoot;
    if (input.threadId) {
      const thread = yield* projects.getThreadShellById(input.threadId).pipe(
        Effect.mapError(
          () =>
            new SharedCheckoutRevisionError({
              code: "unavailable",
              message: "Could not read the selected task checkout.",
            }),
        ),
      );
      if (
        Option.isNone(thread) ||
        thread.value.projectId !== input.projectId ||
        thread.value.archivedAt
      )
        return yield* new SharedCheckoutRevisionError({
          code: "not_found",
          message: "The selected active task does not belong to this project.",
        });
      cwd = thread.value.worktreePath ?? cwd;
      if (!path.isAbsolute(cwd))
        return yield* new SharedCheckoutRevisionError({
          code: "not_found",
          message: "The task checkout is unavailable.",
        });
    }
    return cwd;
  });
  const read = (input: SharedCheckoutRevisionInput) =>
    resolve(input).pipe(Effect.flatMap((cwd) => observeSharedCheckoutRevision(input, cwd)));
  const patch = (input: SharedCheckoutRevisionInput) =>
    resolve(input).pipe(Effect.flatMap((cwd) => captureSharedCheckoutPatch(input, cwd)));
  return { read, patch };
});

export const observeSharedCheckoutRevision = Effect.fn("SharedCheckoutRevision.observe")(function* (
  input: SharedCheckoutRevisionInput,
  cwd: string,
) {
  const vcs = yield* VcsProcess;
  const env = sharedGitEnvironment();
  const overrides = yield* sharedGitReadOverrides(cwd);
  const run = (args: ReadonlyArray<string>) =>
    vcs
      .run({
        operation: "SharedCheckoutRevision.read",
        command: "git",
        args: [...overrides, ...args],
        cwd,
        env,
        timeoutMs: 8_000,
        maxOutputBytes: 1_048_576,
        outputMode: "error",
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.mapError(
          () =>
            new SharedCheckoutRevisionError({
              code: "unavailable",
              message: "Could not inspect this checkout. Refresh its revision before sending.",
            }),
        ),
      );
  const before = yield* run(["rev-parse", "--verify", "HEAD"]);
  const commit = before.stdout.trim();
  if (before.exitCode !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))
    return yield* new SharedCheckoutRevisionError({
      code: "uncommitted",
      message:
        "This checkout needs a Git commit before it can provide a revision to a shared specialist.",
    });
  // Parent filter overrides do not cover drivers configured only in a submodule.
  // Refuse that unsupported coverage before Git status can inspect nested content.
  const index = yield* run(["ls-files", "--stage", "-z"]);
  if (index.exitCode !== 0 || index.stdoutTruncated || index.stdoutInvalidUtf8)
    return yield* new SharedCheckoutRevisionError({
      code: "unavailable",
      message: "Could not inspect the complete checkout index. Refresh before sending.",
    });
  if (index.stdout.split("\0").some((entry) => entry.startsWith("160000 ")))
    return yield* new SharedCheckoutRevisionError({
      code: "unavailable",
      message:
        "Shared checkout context does not support submodules. Their working trees were not inspected.",
    });
  const status = yield* run([
    "status",
    "--porcelain=v2",
    "--branch",
    "--untracked-files=all",
    "--ignore-submodules=all",
  ]);
  if (status.exitCode !== 0 || status.stdoutTruncated || status.stdoutInvalidUtf8)
    return yield* new SharedCheckoutRevisionError({
      code: "unavailable",
      message: "Could not read a complete checkout status. Refresh before sending.",
    });
  const lines = status.stdout.split("\n").filter(Boolean);
  const statusCommit = lines.find((line) => line.startsWith("# branch.oid "))?.slice(13);
  const branch = lines.find((line) => line.startsWith("# branch.head "))?.slice(14);
  const after = yield* run(["rev-parse", "--verify", "HEAD"]);
  if (statusCommit !== commit || after.exitCode !== 0 || after.stdout.trim() !== commit || !branch)
    return yield* new SharedCheckoutRevisionError({
      code: "changed",
      message: "The checkout changed while its revision was being read. Refresh before sending.",
    });
  return {
    projectId: input.projectId,
    branch: branch === "(detached)" ? null : branch,
    commit,
    dirty: lines.some((line) => !line.startsWith("# ")),
    observedAt: DateTime.formatIso(yield* DateTime.now),
  } satisfies SharedCheckoutRevision;
});

// @effect-diagnostics nodeBuiltinImport:off - verify retained snapshot content fingerprints.
import * as NodeCrypto from "node:crypto";
import {
  SharedProjectRegisterInput,
  SharedWorkspaceError,
  type ProjectId,
} from "@t3tools/contracts";
import { canonicalSharedRepository } from "@t3tools/shared/sharedRepository";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VcsProcess } from "../vcs/VcsProcess.ts";
import type { SharedWorkspaceStore } from "./SharedWorkspaceStore.ts";
import { sharedGitEnvironment } from "./sharedGitEnvironment.ts";

const MAX_TREE_BYTES = 1_048_576;
const MAX_TEXT_BYTES = 131_072;
const MAX_SEARCH_BYTES = 8 * 1024 * 1024;
const FULL_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const decodeRegistration = Schema.decodeUnknownEffect(SharedProjectRegisterInput);
const isSharedWorkspaceError = Schema.is(SharedWorkspaceError);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
// eslint-disable-next-line no-control-regex -- Identifiers must reject whitespace and control characters.
const invalidIdentifierCharacters = /[\x00-\x20\x7f]/;
// eslint-disable-next-line no-control-regex -- Paths must reject control characters and alternate path syntax.
const invalidPathCharacters = /[\\:\x00-\x1f\x7f]/;
// eslint-disable-next-line no-control-regex -- Git search queries must be single text records.
const invalidQueryCharacters = /[\x00-\x1f\x7f]/;
const error = (code: SharedWorkspaceError["code"], message: string) =>
  new SharedWorkspaceError({ code, message });

function object(value: unknown, fields: ReadonlyArray<string>): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("arguments");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !fields.includes(key))) throw new Error("fields");
  return result;
}
function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 256 ||
    invalidIdentifierCharacters.test(value)
  )
    throw new Error("identifier");
  return value;
}
function repositoryPath(value: unknown, optional: boolean): string {
  if (optional && (value === undefined || value === "")) return "";
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    invalidPathCharacters.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("path");
  return value;
}
function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error("integer");
  return value;
}
function base(input: Record<string, unknown>) {
  const sharedProjectId = identifier(input.sharedProjectId);
  if (typeof input.commit !== "string" || !FULL_COMMIT.test(input.commit))
    throw new Error("commit");
  return { sharedProjectId, commit: input.commit };
}
function decode<A>(fn: () => A): Effect.Effect<A, SharedWorkspaceError> {
  return Effect.try({
    try: fn,
    catch: () =>
      error(
        "invalid_input",
        "Specify a sharedProjectId and full Git commit, with a relative repository path and bounded arguments. Branch names, checkout paths and abbreviated commits are not accepted.",
      ),
  });
}

type TreeEntry = { path: string; blobId: string; executable: boolean; bytes: number };
function parseTree(stdout: string): Effect.Effect<Array<TreeEntry>, SharedWorkspaceError> {
  return Effect.try({
    try: () =>
      stdout
        .split("\0")
        .filter(Boolean)
        .flatMap((record) => {
          const match =
            /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64}) +(\d+|-)\t([\s\S]+)$/.exec(
              record,
            );
          if (!match) throw new Error("tree");
          // A symlink's blob is its target path, not repository file contents. Submodules are not traversed.
          if (match[1] !== "100644" && match[1] !== "100755") return [];
          const bytes = Number(match[4]);
          if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("blob size");
          return [
            {
              path: repositoryPath(match[5], false),
              blobId: match[3]!,
              executable: match[1] === "100755",
              bytes,
            },
          ];
        }),
    catch: () =>
      error("unavailable", "The repository tree cannot be represented safely as text paths."),
  });
}

function excerpt(content: string, startLine: number, limit: number) {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const selected = lines.slice(startLine - 1, startLine - 1 + limit);
  const text = selected.join("\n");
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES)
    return Effect.fail(
      error("limit_exceeded", "This text range is too large. Request fewer lines."),
    );
  return Effect.succeed({
    content: text,
    startLine,
    totalLines: lines.length,
    truncated: startLine > 1 || startLine - 1 + selected.length < lines.length,
  });
}

/** Git object reads only. The browser and model never supply cwd, executable, or arbitrary Git arguments. */
export const makeSharedRepositoryReader = (
  store: Pick<SharedWorkspaceStore, "project" | "getSnapshot">,
) =>
  Effect.gen(function* () {
    const projects = yield* ProjectionSnapshotQuery;
    const vcs = yield* VcsProcess;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const inspectHost = Effect.fn("SharedRepositoryReader.inspectHost")(function* (
      hostProjectId: ProjectId,
    ) {
      const local = yield* projects
        .getProjectShellById(hostProjectId)
        .pipe(
          Effect.mapError(() =>
            error("unavailable", "Could not resolve this shared project's host repository."),
          ),
        );
      if (Option.isNone(local) || !path.isAbsolute(local.value.workspaceRoot))
        return yield* error("not_found", "The shared project's host repository is unavailable.");
      const cwd = yield* fs
        .realPath(local.value.workspaceRoot)
        .pipe(
          Effect.mapError(() =>
            error("not_found", "The shared project's host repository is unavailable."),
          ),
        );
      const env = sharedGitEnvironment();
      const fixed = [
        "--no-optional-locks",
        "--no-pager",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "submodule.recurse=false",
        "-c",
        "grep.recurseSubmodules=false",
        "-c",
        "protocol.allow=never",
      ];
      const run = (args: ReadonlyArray<string>, maxOutputBytes = MAX_TEXT_BYTES) =>
        vcs
          .run({
            operation: "SharedRepositoryReader.inspect",
            command: "git",
            args: [...fixed, ...args],
            cwd,
            env,
            allowNonZeroExit: true,
            timeoutMs: 5_000,
            maxOutputBytes,
            outputMode: "error",
          })
          .pipe(
            Effect.mapError((cause) =>
              error(
                cause._tag === "VcsProcessOutputLimitError" ? "limit_exceeded" : "unavailable",
                "Repository inspection did not complete within its time or output bounds. No network fetch was attempted.",
              ),
            ),
            Effect.flatMap((result) =>
              result.stdoutInvalidUtf8 || result.stdoutTruncated || result.stderrTruncated
                ? Effect.fail(
                    error("unavailable", "Repository output is incomplete or is not valid UTF-8."),
                  )
                : Effect.succeed(result),
            ),
          );

      const top = yield* run(["rev-parse", "--show-toplevel"]);
      if (top.exitCode !== 0)
        return yield* error("not_found", "The host project is not a Git working tree.");
      const topPath = yield* fs
        .realPath(top.stdout.trim())
        .pipe(
          Effect.mapError(() =>
            error("unavailable", "Could not resolve the host repository root."),
          ),
        );
      if (topPath !== cwd)
        return yield* error("conflict", "The registered host project is not the repository root.");
      const location = yield* run(["rev-parse", "--absolute-git-dir"]);
      if (location.exitCode !== 0 || !path.isAbsolute(location.stdout.trim()))
        return yield* error("unavailable", "Could not resolve the host Git object store.");
      const gitDir = yield* fs
        .realPath(location.stdout.trim())
        .pipe(
          Effect.mapError(() =>
            error("unavailable", "Could not resolve the host Git object store."),
          ),
        );
      // Pin every subsequent command to the observed object store, including linked worktrees.
      fixed.push(`--git-dir=${gitDir}`, `--work-tree=${cwd}`);
      const remotes = yield* run([
        "config",
        "--local",
        "--null",
        "--get-regexp",
        "^remote\\..*\\.url$",
      ]);
      const repositories = new Set<string>();
      if (remotes.exitCode !== 0 && remotes.exitCode !== 1)
        return yield* error(
          "unavailable",
          "Could not inspect the host repository's configured remotes.",
        );
      for (const record of remotes.stdout.split("\0").filter(Boolean)) {
        const newline = record.indexOf("\n");
        if (newline < 0) continue;
        try {
          repositories.add(canonicalSharedRepository(record.slice(newline + 1)));
        } catch {
          /* Local paths and credential-bearing remotes cannot establish repository identity. */
        }
      }
      return { run, repositories };
    });

    const verifyRegistration = Effect.fn("SharedRepositoryReader.verifyRegistration")(function* (
      raw: unknown,
    ) {
      const input = yield* decodeRegistration(raw).pipe(
        Effect.mapError(() => error("invalid_input", "Invalid shared project registration.")),
      );
      const repository = yield* Effect.try({
        try: () => canonicalSharedRepository(input.repository),
        catch: () => error("invalid_input", "Specify a canonical remote repository identity."),
      });
      const observed = yield* inspectHost(input.hostProjectId);
      // Aliases are explicit admin declarations, not evidence for a different primary identity.
      if (!observed.repositories.has(repository))
        return yield* error(
          "conflict",
          "The host checkout's current remote does not match the project repository. Refresh the project before registering it.",
        );
      return { ...input, repository };
    });

    const open = Effect.fn("SharedRepositoryReader.open")(function* (
      sharedProjectId: string,
      commit: string,
      requireCommit = true,
    ) {
      const shared = yield* store
        .project(sharedProjectId)
        .pipe(
          Effect.mapError((cause) =>
            isSharedWorkspaceError(cause)
              ? cause
              : error("unavailable", "Could not read the shared repository registration."),
          ),
        );
      const { run, repositories } = yield* inspectHost(shared.hostProjectId);
      const allowed = yield* Effect.try({
        try: () => new Set([shared.repository, ...shared.aliases].map(canonicalSharedRepository)),
        catch: () => error("unavailable", "The shared repository registration is invalid."),
      });
      if (![...repositories].some((repository) => allowed.has(repository)))
        return yield* error(
          "conflict",
          "The host checkout has no remote matching this shared repository or its registered aliases.",
        );
      if (requireCommit) {
        const kind = yield* run(["cat-file", "-t", commit]);
        if (kind.exitCode !== 0 || kind.stdout.trim() !== "commit")
          return yield* error(
            "not_found",
            "This exact commit is unavailable on the host. Fetch it explicitly before inspection.",
          );
      }
      const tree = Effect.fn("SharedRepositoryReader.tree")(function* (prefix: string) {
        const result = yield* run(
          ["ls-tree", "-r", "-z", "-l", "--full-tree", commit, "--", ...(prefix ? [prefix] : [])],
          MAX_TREE_BYTES,
        );
        if (result.exitCode !== 0)
          return yield* error("unavailable", "Could not read this commit's repository tree.");
        return yield* parseTree(result.stdout);
      });
      return { shared, run, tree };
    });

    const list = Effect.fn("SharedRepositoryReader.list")(function* (raw: unknown) {
      const input = yield* decode(() => {
        const value = object(raw, ["sharedProjectId", "commit", "path", "limit"]);
        return {
          ...base(value),
          path: repositoryPath(value.path, true),
          limit: integer(value.limit, 100, 400),
        };
      });
      const repo = yield* open(input.sharedProjectId, input.commit);
      const entries = yield* repo.tree(input.path);
      return {
        kind: "committed_files" as const,
        sharedProjectId: input.sharedProjectId,
        repository: repo.shared.repository,
        commit: input.commit,
        path: input.path,
        entries: entries.slice(0, input.limit),
        truncated: entries.length > input.limit,
      };
    });

    const read = Effect.fn("SharedRepositoryReader.read")(function* (raw: unknown) {
      const input = yield* decode(() => {
        const value = object(raw, [
          "sharedProjectId",
          "commit",
          "path",
          "snapshotId",
          "startLine",
          "limit",
        ]);
        const revision = base(value);
        if ((value.path === undefined) === (value.snapshotId === undefined))
          throw new Error("read target");
        return {
          ...revision,
          path: value.path === undefined ? undefined : repositoryPath(value.path, false),
          snapshotId: value.snapshotId === undefined ? undefined : identifier(value.snapshotId),
          startLine: integer(value.startLine, 1, 10_000_000),
          limit: integer(value.limit, 200, 500),
        };
      });
      const repo = yield* open(input.sharedProjectId, input.commit, input.snapshotId === undefined);
      if (input.snapshotId !== undefined) {
        const { snapshot, patch } = yield* store
          .getSnapshot(input.snapshotId)
          .pipe(
            Effect.mapError((cause) =>
              isSharedWorkspaceError(cause)
                ? cause
                : error("unavailable", "Could not read the retained snapshot."),
            ),
          );
        if (
          snapshot.sharedProjectId !== input.sharedProjectId ||
          snapshot.revision.commit !== input.commit
        )
          return yield* error(
            "conflict",
            "This snapshot does not belong to the requested project and base commit.",
          );
        if (
          Buffer.byteLength(patch) !== snapshot.bytes ||
          NodeCrypto.createHash("sha256").update(patch).digest("hex") !== snapshot.sha256
        )
          return yield* error("unavailable", "The retained snapshot failed its integrity check.");
        const selected = yield* excerpt(patch, input.startLine, input.limit);
        return { kind: "snapshot_evidence" as const, applied: false, snapshot, ...selected };
      }
      const entries = yield* repo.tree(input.path!);
      const entry = entries.find((item) => item.path === input.path);
      if (!entry)
        return yield* error(
          "not_found",
          "This commit has no regular file at that path. Symlinks and submodules are not followed.",
        );
      const size = yield* repo.run(["cat-file", "-s", entry.blobId]);
      if (size.exitCode !== 0 || !/^\d+\n?$/.test(size.stdout))
        return yield* error("unavailable", "Could not inspect this committed blob.");
      if (Number(size.stdout) > MAX_TEXT_BYTES)
        return yield* error(
          "limit_exceeded",
          "This committed blob exceeds the text inspection limit.",
        );
      const blob = yield* repo.run(["cat-file", "blob", entry.blobId]);
      if (blob.exitCode !== 0 || blob.stdout.includes("\0"))
        return yield* error(
          "unavailable",
          "This committed blob is unavailable or is not a text file.",
        );
      return {
        kind: "committed_file" as const,
        sharedProjectId: input.sharedProjectId,
        repository: repo.shared.repository,
        commit: input.commit,
        path: entry.path,
        blobId: entry.blobId,
        ...(yield* excerpt(blob.stdout, input.startLine, input.limit)),
      };
    });

    const search = Effect.fn("SharedRepositoryReader.search")(function* (raw: unknown) {
      const input = yield* decode(() => {
        const value = object(raw, ["sharedProjectId", "commit", "query", "path", "limit"]);
        if (
          typeof value.query !== "string" ||
          !value.query.length ||
          value.query.length > 512 ||
          invalidQueryCharacters.test(value.query)
        )
          throw new Error("query");
        return {
          ...base(value),
          query: value.query,
          path: repositoryPath(value.path, true),
          limit: integer(value.limit, 40, 100),
        };
      });
      const repo = yield* open(input.sharedProjectId, input.commit);
      const entries = yield* repo.tree(input.path);
      // Git grep loads whole blobs before binary detection. Bound object allocation
      // from committed size metadata before invoking it, not only its stdout.
      if (
        entries.some((entry) => entry.bytes > MAX_TEXT_BYTES) ||
        entries.reduce((total, entry) => total + entry.bytes, 0) > MAX_SEARCH_BYTES
      )
        return yield* error(
          "limit_exceeded",
          "This search selection includes a file over 128 KiB or exceeds 8 MiB in total. Narrow path to a smaller directory or file; no files were silently skipped.",
        );
      const files = new Set(entries.map((entry) => entry.path));
      const result = yield* repo.run([
        "grep",
        "--threads=1",
        "-n",
        "-z",
        "-I",
        "-F",
        "--no-column",
        "--no-color",
        "--no-textconv",
        "-e",
        input.query,
        input.commit,
        "--",
        ...(input.path ? [input.path] : []),
      ]);
      if (result.exitCode !== 0 && result.exitCode !== 1)
        return yield* error("unavailable", "Could not search this exact commit.");
      const matches = yield* Effect.try({
        try: () => {
          const found: Array<{ path: string; line: number; text: string }> = [];
          let offset = 0;
          while (offset < result.stdout.length) {
            const first = result.stdout.indexOf("\0", offset);
            const second = result.stdout.indexOf("\0", first + 1);
            const newline = result.stdout.indexOf("\n", second + 1);
            if (first < offset || second <= first || newline <= second)
              throw new Error("grep output");
            const prefix = result.stdout.slice(offset, first);
            const line = result.stdout.slice(first + 1, second);
            if (!prefix.startsWith(`${input.commit}:`) || !/^\d+$/.test(line))
              throw new Error("grep record");
            const file = repositoryPath(prefix.slice(input.commit.length + 1), false);
            if (files.has(file))
              found.push({
                path: file,
                line: Number(line),
                text: result.stdout.slice(second + 1, newline),
              });
            offset = newline + 1;
          }
          return found;
        },
        catch: () => error("unavailable", "Search returned an ambiguous text record."),
      });
      return {
        kind: "committed_matches" as const,
        sharedProjectId: input.sharedProjectId,
        repository: repo.shared.repository,
        commit: input.commit,
        query: input.query,
        matches: matches.slice(0, input.limit),
        truncated: matches.length > input.limit,
      };
    });

    const bounded =
      <A>(operation: (raw: unknown) => Effect.Effect<A, SharedWorkspaceError>) =>
      (raw: unknown) =>
        operation(raw).pipe(
          Effect.flatMap((result) =>
            Buffer.byteLength(encode(result)) > 196_608
              ? Effect.fail(
                  error(
                    "limit_exceeded",
                    "This result exceeds the tool response limit. Narrow the path, result count or line range.",
                  ),
                )
              : Effect.succeed(result),
          ),
          Effect.timeoutOrElse({
            duration: "20 seconds",
            orElse: () =>
              Effect.fail(error("unavailable", "Repository inspection exceeded its time limit.")),
          }),
        );
    return {
      list: bounded(list),
      read: bounded(read),
      search: bounded(search),
      verifyRegistration: bounded(verifyRegistration),
    };
  });

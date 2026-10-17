// @effect-diagnostics nodeBuiltinImport:off - digest of the exact local preview bytes.
import * as NodeCrypto from "node:crypto";
import {
  SharedCheckoutRevisionError,
  type SharedCheckoutPatch,
  type SharedCheckoutPatchInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { VcsProcess } from "../vcs/VcsProcess.ts";
import { sharedGitReadOverrides } from "./sharedGitReadOverrides.ts";
import { sharedGitEnvironment } from "./sharedGitEnvironment.ts";

const MAX_BYTES = 1_048_576;
const MAX_FILES = 256;
const MAX_STATUS_BYTES = 524_288;
const MAX_SOURCE_BYTES = 16 * MAX_BYTES;
const fail = (code: SharedCheckoutRevisionError["code"], message: string) =>
  new SharedCheckoutRevisionError({ code, message });
const complete = (value: { stdoutTruncated: boolean; stdoutInvalidUtf8?: boolean }) =>
  !value.stdoutTruncated && !value.stdoutInvalidUtf8;
// Patch paths are displayed and retained as literal repository-relative names.
const safePath = (value: string) =>
  value.length > 0 &&
  value.length <= 1024 &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.split("/").some((part) => part === "." || part === "..") &&
  !Array.from(value).some((character) => character.charCodeAt(0) < 32);

/** The caller resolves cwd from its own project/task store. This never uploads or mutates files. */
export const captureSharedCheckoutPatch = Effect.fn("SharedCheckoutPatch.capture")(
  function* (input: SharedCheckoutPatchInput, cwd: string) {
    const vcs = yield* VcsProcess;
    const fs = yield* FileSystem.FileSystem;
    const pathApi = yield* Path.Path;
    const env = sharedGitEnvironment();
    const overrides = yield* sharedGitReadOverrides(cwd);
    const run = (args: ReadonlyArray<string>, maxOutputBytes = MAX_STATUS_BYTES, stdin?: string) =>
      vcs
        .run({
          operation: "SharedCheckoutPatch.capture",
          command: "git",
          args: [...overrides, ...args],
          cwd,
          env,
          ...(stdin === undefined ? {} : { stdin }),
          timeoutMs: 8_000,
          maxOutputBytes,
          outputMode: "truncate",
          appendTruncationMarker: false,
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.mapError(() =>
            fail("unavailable", "Could not capture this checkout. No patch was uploaded."),
          ),
        );

    const head = yield* run(["rev-parse", "--verify", "HEAD"], 256);
    const commit = head.stdout.trim();
    if (head.exitCode !== 0 || !complete(head) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))
      return yield* fail("uncommitted", "Create a Git commit before capturing a patch against it.");
    const statusArgs = [
      "status",
      "--porcelain=v2",
      "--branch",
      "--no-renames",
      "--untracked-files=normal",
      "--ignored=matching",
      "--ignore-submodules=all",
      "-z",
    ];
    const status = yield* run(statusArgs);
    if (status.exitCode !== 0)
      return yield* fail("unavailable", "Could not inspect this checkout. No patch was captured.");
    const entries = status.stdout.split("\0").filter(Boolean);
    const branchValue = entries.find((entry) => entry.startsWith("# branch.head "))?.slice(14);
    const branch = branchValue && branchValue !== "(detached)" ? branchValue : null;
    const files: SharedCheckoutPatch["files"][number][] = [];
    const blobs = new Map<string, Set<string>>();
    const excluded: SharedCheckoutPatch["excluded"][number][] = [];
    let filesTruncated = false;
    let excludedTruncated = false;
    let unsupported = false;
    const exclude = (path: string, reason: SharedCheckoutPatch["excluded"][number]["reason"]) => {
      if (reason !== "ignored") unsupported = true;
      if (excluded.length < MAX_FILES) excluded.push({ path: path.slice(0, 1024), reason });
      else excludedTruncated = true;
    };
    if (!complete(status)) {
      filesTruncated = true;
      excludedTruncated = true;
      exclude(".", "oversize");
    }
    for (const entry of entries) {
      if (entry.startsWith("# ")) continue;
      if (entry.startsWith("! ")) {
        exclude(entry.slice(2), "ignored");
        continue;
      }
      if (entry.startsWith("? ")) {
        exclude(entry.slice(2), "untracked");
        continue;
      }
      if (entry.startsWith("u ")) {
        exclude(/^u (?:\S+ ){9}([\s\S]*)$/.exec(entry)?.[1] ?? ".", "conflict");
        continue;
      }
      const match = /^1 (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) ([\s\S]*)$/.exec(entry);
      if (!match) {
        exclude(".", "unsupported_path");
        continue;
      }
      const path = match[8]!;
      for (const oid of [match[6]!, match[7]!]) {
        if (/^0+$/.test(oid)) continue;
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) {
          exclude(path, "unsupported_path");
          continue;
        }
        const paths = blobs.get(oid) ?? new Set<string>();
        paths.add(path);
        blobs.set(oid, paths);
      }
      if (!safePath(path)) exclude(path, "unsupported_path");
      if ([match[3], match[4], match[5]].includes("120000")) exclude(path, "symlink");
      const change = match[1]!.includes("D")
        ? "deleted"
        : match[1]!.includes("T")
          ? "type_changed"
          : match[3] === "000000"
            ? "added"
            : "modified";
      if (files.length < MAX_FILES) files.push({ path, change });
      else filesTruncated = true;
    }
    // Do not traverse submodule working trees. Their presence is explicit unsupported
    // coverage, including dirty nested work that --ignore-submodules intentionally omits.
    const index = yield* run(["ls-files", "--stage", "-z"], 2_097_152);
    if (index.exitCode !== 0 || !complete(index)) exclude(".", "oversize");
    else
      for (const record of index.stdout.split("\0"))
        if (record.startsWith("160000 "))
          exclude(record.slice(record.indexOf("\t") + 1), "submodule");
    if (!branch) exclude(".", "detached");
    if (filesTruncated || excludedTruncated) unsupported = true;

    const output = (patch: string | null): SharedCheckoutPatch => ({
      ...input,
      branch,
      commit,
      observedAt: DateTime.formatIso(DateTime.nowUnsafe()),
      status: unsupported ? "unsupported" : patch ? "ready" : "clean",
      scope: "tracked_changes",
      patch,
      sha256: patch === null ? null : NodeCrypto.createHash("sha256").update(patch).digest("hex"),
      bytes: patch === null ? 0 : Buffer.byteLength(patch),
      files,
      filesTruncated,
      excluded,
      excludedTruncated,
      maxBytes: MAX_BYTES,
      maxFiles: MAX_FILES,
    });
    if (unsupported) return output(null);

    // stdout limits alone do not bound Git's blob allocations. Refuse large
    // worktree and immutable base/index inputs before invoking content diff.
    let sourceBytes = 0;
    for (const file of files) {
      if (file.change === "deleted") continue;
      const info = yield* fs
        .stat(pathApi.join(cwd, file.path))
        .pipe(
          Effect.mapError(() =>
            fail("changed", "A changed file became unavailable. Preview the checkout again."),
          ),
        );
      if (info.type !== "File") exclude(file.path, "unsupported_path");
      if (info.size > BigInt(MAX_BYTES)) exclude(file.path, "oversize");
      sourceBytes += Number(info.size);
    }
    if (blobs.size) {
      const sizes = yield* run(
        ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
        65_536,
        [...blobs.keys()].join("\n") + "\n",
      );
      if (sizes.exitCode !== 0 || !complete(sizes))
        return yield* fail("unavailable", "Could not verify source blob sizes.");
      const seen = new Set<string>();
      for (const line of sizes.stdout.trim().split("\n")) {
        const fields = /^([a-f0-9]+) blob ([0-9]+)$/.exec(line);
        if (!fields || !blobs.has(fields[1]!) || seen.has(fields[1]!))
          return yield* fail("unavailable", "Could not verify every source blob size.");
        seen.add(fields[1]!);
        const size = Number(fields[2]);
        if (!Number.isSafeInteger(size) || size > MAX_BYTES)
          for (const path of blobs.get(fields[1]!)!) exclude(path, "oversize");
        sourceBytes += size;
      }
      if (seen.size !== blobs.size)
        return yield* fail("unavailable", "Could not verify every source blob size.");
    }
    if (sourceBytes > MAX_SOURCE_BYTES) exclude(".", "oversize");
    if (unsupported) return output(null);

    if (files.length) {
      const attrs = yield* vcs
        .run({
          operation: "SharedCheckoutPatch.attributes",
          command: "git",
          args: [...overrides, "check-attr", "-z", "--stdin", "filter"],
          stdin: files.map((file) => file.path).join("\0") + "\0",
          cwd,
          env,
          timeoutMs: 8_000,
          maxOutputBytes: MAX_STATUS_BYTES,
          outputMode: "truncate",
          appendTruncationMarker: false,
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.mapError(() => fail("unavailable", "Could not verify changed-file attributes.")),
        );
      if (attrs.exitCode !== 0 || !complete(attrs))
        return yield* fail("unavailable", "Could not verify changed-file attributes.");
      const values = attrs.stdout.split("\0");
      for (let offset = 0; offset + 2 < values.length; offset += 3)
        if (values[offset + 2] !== "unspecified" && values[offset + 2] !== "unset")
          exclude(values[offset]!, "filter");
      if (unsupported) return output(null);
    }
    const diffArgs = [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--ignore-submodules=all",
      "--no-color",
      "--full-index",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--no-indent-heuristic",
    ];
    const stats = yield* run([...diffArgs, "--numstat", "-z", "HEAD", "--"]);
    if (stats.exitCode !== 0 || !complete(stats)) {
      exclude(".", "oversize");
      return output(null);
    }
    for (const stat of stats.stdout.split("\0").filter(Boolean)) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(stat);
      if (!match) return yield* fail("unavailable", "Could not inspect every changed file.");
      if (match[1] === "-" || match[2] === "-") exclude(match[3]!, "binary");
    }
    if (unsupported) return output(null);
    const patchArgs = [...diffArgs, "--patch", "--unified=3", "HEAD", "--"];
    const first = yield* run(patchArgs, MAX_BYTES);
    if (first.exitCode !== 0 || !complete(first)) {
      exclude(".", first.stdoutInvalidUtf8 ? "binary" : "oversize");
      return output(null);
    }
    const second = yield* run(patchArgs, MAX_BYTES);
    const after = yield* run(statusArgs);
    const afterIndex = yield* run(["ls-files", "--stage", "-z"], 2_097_152);
    const afterHead = yield* run(["rev-parse", "--verify", "HEAD"], 256);
    if (
      ![second, after, afterIndex, afterHead].every(
        (value) => value.exitCode === 0 && complete(value),
      ) ||
      first.stdout !== second.stdout ||
      status.stdout !== after.stdout ||
      index.stdout !== afterIndex.stdout ||
      commit !== afterHead.stdout.trim() ||
      entries.find((entry) => entry.startsWith("# branch.oid "))?.slice(13) !== commit
    )
      return yield* fail(
        "changed",
        "This checkout changed during capture. Preview it again before sharing.",
      );
    return output(first.stdout || null);
  },
  Effect.timeoutOrElse({
    duration: "45 seconds",
    orElse: () =>
      Effect.fail(fail("unavailable", "Patch capture timed out. No patch was uploaded.")),
  }),
);

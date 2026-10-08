// @effect-diagnostics nodeBuiltinImport:off - guarded writes require file descriptors and no-follow flags.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  CheckpointRef,
  MeerkatCheckpointError,
  type MeerkatWorkspaceCheckpoint,
  type MeerkatCheckpointPreview,
  type MeerkatCheckpointFile,
  type MeerkatCheckpointRestoreResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CheckpointStore } from "../../checkpointing/CheckpointStore.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";

export interface MeerkatCheckpointScope {
  readonly instanceId: string;
  readonly mobId: string;
  readonly sessionId: string;
  readonly stateRoot: string;
  readonly projectPath: string;
  /** Canonical native execution workspace, resolved by the consumer, never the browser. */
  readonly workspace: string;
}
const Row = Schema.Struct({
  id: Schema.String,
  instance_id: Schema.String,
  mob_id: Schema.String,
  session_id: Schema.String,
  state_root: Schema.String,
  project_path: Schema.String,
  workspace: Schema.String,
  before_ref: Schema.NullOr(Schema.String),
  after_ref: Schema.NullOr(Schema.String),
  started_at: Schema.String,
  completed_at: Schema.NullOr(Schema.String),
  status: Schema.Literals(["active", "complete", "partial", "unavailable"]),
  source: Schema.Literals(["native", "manual"]),
  detail: Schema.NullOr(Schema.String),
});
type Row = typeof Row.Type;
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
const LIMIT = 1024 * 1024;
const fail = (cause: unknown) =>
  new MeerkatCheckpointError({ message: cause instanceof Error ? cause.message : String(cause) });
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: fail });
const missing = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";
const digest = (text: string, mode: number) =>
  NodeCrypto.createHash("sha256").update(`${mode}:`).update(text).digest("hex");
const publicRow = (row: Row): MeerkatWorkspaceCheckpoint => ({
  id: row.id,
  source: row.source,
  sessionId: row.session_id,
  workspace: row.workspace,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  status: row.status,
  detail: row.detail,
});

/** Refuses traversal, symlink parents, hard links and non-regular files. Never creates parents. */
async function safePath(workspace: string, relative: string) {
  if (
    !relative ||
    relative.includes("\0") ||
    NodePath.isAbsolute(relative) ||
    relative
      .split(/[\\/]/)
      .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
  )
    throw Error("This path cannot be restored safely.");
  if ((await NodeFSP.realpath(workspace)) !== workspace)
    throw Error("The workspace location changed. Refresh the conversation.");
  let parent = workspace;
  for (const part of relative.split("/").slice(0, -1)) {
    parent = NodePath.join(parent, part);
    const stat = await NodeFSP.lstat(parent).catch((cause: unknown) => {
      if (missing(cause))
        throw Error(
          `The parent folder "${NodePath.relative(workspace, parent)}" is missing. Recreate it as an ordinary folder in this workspace, then refresh History to restore the file.`,
        );
      throw cause;
    });
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error("A parent directory changed or is a symbolic link.");
  }
  return NodePath.join(workspace, relative);
}
async function readCurrent(workspace: string, relative: string) {
  const file = await safePath(workspace, relative);
  const handle = await NodeFSP.open(
    file,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
  ).catch((cause: unknown) => {
    if (missing(cause)) return null;
    throw cause;
  });
  if (!handle) return { text: null, mode: 0, fingerprint: "missing" };
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1)
      throw Error("Only regular files with one link can be restored.");
    if (stat.size > LIMIT) throw Error("This file is too large for the text restore preview.");
    const buffer = await handle.readFile();
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
    if (text.includes("\0")) throw Error("Binary files cannot be restored from this preview.");
    const mode = stat.mode & 0o100 ? 0o100755 : 0o100644;
    return { text, mode, fingerprint: digest(text, mode) };
  } finally {
    await handle.close();
  }
}

/** Durable workspace snapshots; metadata never claims which agent caused a change. */
export const makeMeerkatCheckpointStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const snapshots = yield* CheckpointStore;
  const git = yield* GitVcsDriver;
  const lock = yield* Semaphore.make(1);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const execute = (
    cwd: string,
    args: ReadonlyArray<string>,
    stdin?: string,
    env?: NodeJS.ProcessEnv,
  ) =>
    git
      .execute({
        operation: "MeerkatWorkspaceCheckpoint",
        cwd,
        args: ["-c", "core.fsmonitor=false", ...args],
        ...(stdin !== undefined ? { stdin } : {}),
        ...(env ? { env } : {}),
        maxOutputBytes: 4 * LIMIT,
        timeoutMs: 30_000,
      })
      .pipe(
        Effect.mapError(fail),
        Effect.flatMap((result) =>
          result.stdoutTruncated
            ? Effect.fail(fail("The checkpoint exceeds the preview size limit."))
            : Effect.succeed(result.stdout),
        ),
      );
  const checkWorkspace = Effect.fn("MeerkatCheckpoint.checkWorkspace")(function* (
    scope: MeerkatCheckpointScope,
  ) {
    const workspace = yield* attempt(() => NodeFSP.realpath(scope.workspace));
    if (workspace !== scope.workspace)
      return yield* fail("The native workspace must use its canonical location.");
    const root = (yield* execute(workspace, ["rev-parse", "--show-toplevel"])).trim();
    if ((yield* attempt(() => NodeFSP.realpath(root))) !== workspace)
      return yield* fail("Workspace snapshots require the native Git worktree root.");
  });
  /** Capture working bytes without running repository clean/smudge filters or EOL conversion. */
  const captureRaw = Effect.fn("MeerkatCheckpoint.captureRaw")(function* (
    workspace: string,
    checkpointRef: string,
  ) {
    const commonDir = (yield* execute(workspace, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])).trim();
    const temporary = yield* attempt(() =>
      NodeFSP.mkdtemp(NodePath.join(commonDir, "t3-raw-checkpoint-")),
    );
    const env = {
      ...process.env,
      GIT_INDEX_FILE: NodePath.join(temporary, "index"),
      GIT_AUTHOR_NAME: "T3 Code",
      GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
      GIT_COMMITTER_NAME: "T3 Code",
      GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
    };
    const privateGit = (args: ReadonlyArray<string>, stdin?: string) =>
      execute(
        workspace,
        ["-c", "core.fsync=objects,reference", "-c", "core.fsyncMethod=fsync", ...args],
        stdin,
        env,
      );
    yield* Effect.gen(function* () {
      const tracked = (yield* execute(workspace, ["ls-files", "--stage", "-z"]))
        .split("\0")
        .filter(Boolean);
      const entries = new Map<string, { mode: string; oid: string }>();
      for (const entry of tracked) {
        const match = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(entry);
        if (!match || match[3] !== "0")
          return yield* fail("Resolve Git merge conflicts before saving a workspace snapshot.");
        entries.set(match[4]!, { mode: match[1]!, oid: match[2]! });
      }
      const skipped = new Set(
        (yield* execute(workspace, ["ls-files", "-v", "-z"]))
          .split("\0")
          .filter((entry) => entry.slice(0, 2).toUpperCase() === "S ")
          .map((entry) => entry.slice(2)),
      );
      const names = [
        ...new Set([
          ...entries.keys(),
          ...(yield* execute(workspace, ["ls-files", "-t", "--others", "--exclude-standard", "-z"]))
            .split("\0")
            .filter(Boolean)
            // An ASCII status prefix also preserves a leading BOM in the first filename.
            .map((entry) => entry.slice(2)),
        ]),
      ];
      const regular: Array<{ path: string; absolute: string; stat: NodeFS.Stats }> = [];
      const index: string[] = [];
      for (const relative of names) {
        // Embedded repositories without a commit are not ordinary snapshot files.
        if (relative.endsWith("/")) continue;
        const original = entries.get(relative);
        const absolute = yield* attempt(() =>
          safePath(workspace, relative).catch((cause: unknown) => {
            if (missing(cause)) return null;
            throw cause;
          }),
        );
        if (!absolute) {
          if (original && skipped.has(relative))
            index.push(`${original.mode} ${original.oid}\t${relative}\0`);
          continue;
        }
        const stat = yield* attempt(() =>
          NodeFSP.lstat(absolute).catch((cause: unknown) => {
            if (missing(cause)) return null;
            throw cause;
          }),
        );
        if (!stat) {
          if (original && skipped.has(relative))
            index.push(`${original.mode} ${original.oid}\t${relative}\0`);
          continue;
        }
        if (stat.isSymbolicLink()) {
          const target = yield* attempt(() => NodeFSP.readlink(absolute));
          const oid = (yield* privateGit(
            ["hash-object", "--no-filters", "-w", "--stdin"],
            target,
          )).trim();
          index.push(`120000 ${oid}\t${relative}\0`);
        } else if (stat.isFile()) {
          regular.push({ path: relative, absolute, stat });
        } else if (stat.isDirectory() && original?.mode === "160000") {
          // Preserve the submodule link; this snapshot does not include its nested worktree.
          index.push(`160000 ${original.oid}\t${relative}\0`);
        } else {
          return yield* fail(`Cannot snapshot a non-regular workspace entry: ${relative}`);
        }
      }
      // Quoted paths are Git's documented stdin-paths encoding. No shell is involved.
      const objects = regular.length
        ? (yield* privateGit(
            ["hash-object", "--no-filters", "-w", "--stdin-paths"],
            regular.map((file) => JSON.stringify(file.absolute)).join("\n") + "\n",
          ))
            .trim()
            .split("\n")
        : [];
      if (
        objects.length !== regular.length ||
        objects.some((oid) => !/^[0-9a-f]{40,64}$/.test(oid))
      )
        return yield* fail("Git did not confirm every raw workspace file.");
      for (const [indexPosition, file] of regular.entries()) {
        const current = yield* attempt(async () =>
          NodeFSP.lstat(await safePath(workspace, file.path)),
        );
        if (
          !current.isFile() ||
          current.dev !== file.stat.dev ||
          current.ino !== file.stat.ino ||
          current.size !== file.stat.size ||
          current.mtimeMs !== file.stat.mtimeMs ||
          current.ctimeMs !== file.stat.ctimeMs
        )
          return yield* fail(`This file changed while saving the snapshot: ${file.path}`);
        index.push(
          `${file.stat.mode & 0o100 ? "100755" : "100644"} ${objects[indexPosition]}\t${file.path}\0`,
        );
      }
      yield* privateGit(["read-tree", "--empty"]);
      if (index.length) yield* privateGit(["update-index", "-z", "--index-info"], index.join(""));
      const tree = (yield* privateGit(["write-tree"])).trim();
      const commit = (yield* privateGit([
        "commit-tree",
        tree,
        "-m",
        `t3 raw workspace snapshot ref=${checkpointRef}`,
      ])).trim();
      yield* privateGit(["update-ref", checkpointRef, commit]);
    }).pipe(
      Effect.ensuring(
        attempt(() => NodeFSP.rm(temporary, { recursive: true, force: true })).pipe(Effect.ignore),
      ),
    );
  });
  const rowsFor = (scope: MeerkatCheckpointScope) =>
    sql`SELECT * FROM meerkat_workspace_checkpoints WHERE
    instance_id=${scope.instanceId} AND mob_id=${scope.mobId} AND session_id=${scope.sessionId}
    AND state_root=${scope.stateRoot} AND project_path=${scope.projectPath} AND workspace=${scope.workspace} ORDER BY started_at DESC, rowid DESC LIMIT 100`.pipe(
      Effect.flatMap(decodeRows),
      Effect.mapError(fail),
    );
  const get = Effect.fn("MeerkatCheckpoint.get")(function* (
    scope: MeerkatCheckpointScope,
    id: string,
  ) {
    const row = (yield* rowsFor(scope)).find((value) => value.id === id);
    if (!row)
      return yield* fail(
        "This checkpoint does not belong to the selected native session and workspace.",
      );
    return row;
  });
  const begin = Effect.fn("MeerkatCheckpoint.begin")(function* (
    scope: MeerkatCheckpointScope,
    options: { replaceActive?: boolean } = {},
  ) {
    const existing = (yield* rowsFor(scope)).find((row) => row.status === "active");
    if (existing && !options.replaceActive) return publicRow(existing);
    if (existing) {
      const interruptedAt = yield* now;
      yield* sql`UPDATE meerkat_workspace_checkpoints SET status='partial', completed_at=${interruptedAt}, detail='No completion snapshot was captured before the next native run.' WHERE id=${existing.id}`.pipe(
        Effect.mapError(fail),
      );
    }
    const id = yield* Effect.sync(() => NodeCrypto.randomUUID());
    const started = yield* now;
    const ref = CheckpointRef.make(`refs/t3/native-work/${id}/before`);
    const capture = yield* checkWorkspace(scope).pipe(
      Effect.andThen(captureRaw(scope.workspace, ref)),
      Effect.mapError(fail),
      Effect.result,
    );
    const status = capture._tag === "Success" ? "active" : "unavailable";
    const detail = capture._tag === "Success" ? null : capture.failure.message;
    yield* sql`INSERT INTO meerkat_workspace_checkpoints
      (id,instance_id,mob_id,session_id,state_root,project_path,workspace,before_ref,after_ref,started_at,completed_at,status,detail)
      VALUES (${id},${scope.instanceId},${scope.mobId},${scope.sessionId},${scope.stateRoot},${scope.projectPath},${scope.workspace},${capture._tag === "Success" ? ref : null},NULL,${started},NULL,${status},${detail})`.pipe(
      Effect.mapError(fail),
    );
    return publicRow(yield* get(scope, id));
  }, lock.withPermits(1));
  const complete = Effect.fn("MeerkatCheckpoint.complete")(function* (
    scope: MeerkatCheckpointScope,
    options: { failed?: boolean; checkpointId?: string } = {},
  ) {
    const row = (yield* rowsFor(scope)).find(
      (value) =>
        value.status === "active" &&
        (options.checkpointId === undefined || value.id === options.checkpointId),
    );
    if (!row) return null;
    const ref = CheckpointRef.make(`refs/t3/native-work/${row.id}/after`);
    const capture = yield* checkWorkspace(scope).pipe(
      Effect.andThen(captureRaw(scope.workspace, ref)),
      Effect.mapError(fail),
      Effect.result,
    );
    const completed = yield* now;
    const status = capture._tag === "Success" && !options.failed ? "complete" : "partial";
    const detail =
      capture._tag === "Failure"
        ? capture.failure.message
        : options.failed
          ? "Native work ended with an error. This snapshot includes the workspace at that boundary."
          : null;
    yield* sql`UPDATE meerkat_workspace_checkpoints SET after_ref=${capture._tag === "Success" ? ref : null},completed_at=${completed},status=${status},detail=${detail} WHERE id=${row.id}`.pipe(
      Effect.mapError(fail),
    );
    return publicRow(yield* get(scope, row.id));
  }, lock.withPermits(1));
  const capture = Effect.fn("MeerkatCheckpoint.capture")(function* (
    scope: MeerkatCheckpointScope,
    assertWriteSafe: Effect.Effect<void, MeerkatCheckpointError> = Effect.void,
  ) {
    yield* checkWorkspace(scope);
    const id = yield* Effect.sync(() => NodeCrypto.randomUUID());
    const started = yield* now;
    const ref = CheckpointRef.make(`refs/t3/native-work/${id}/before`);
    yield* assertWriteSafe;
    yield* captureRaw(scope.workspace, ref).pipe(Effect.mapError(fail));
    yield* assertWriteSafe;
    yield* sql`INSERT INTO meerkat_workspace_checkpoints
      (id,instance_id,mob_id,session_id,state_root,project_path,workspace,before_ref,after_ref,started_at,completed_at,status,source,detail)
      VALUES (${id},${scope.instanceId},${scope.mobId},${scope.sessionId},${scope.stateRoot},${scope.projectPath},${scope.workspace},${ref},${ref},${started},${started},'complete','manual',NULL)`.pipe(
      Effect.mapError(fail),
    );
    return publicRow(yield* get(scope, id));
  }, lock.withPermits(1));
  const readBlob = Effect.fn("MeerkatCheckpoint.readBlob")(function* (
    workspace: string,
    ref: string,
    path: string,
  ) {
    const entry = yield* execute(workspace, ["ls-tree", "-z", ref, "--", `:(literal)${path}`]);
    if (!entry) return null;
    const match = /^(\d+) blob ([0-9a-f]+)\t/.exec(entry);
    if (!match || (match[1] !== "100644" && match[1] !== "100755") || !match[2])
      return yield* fail("Only regular text files can be restored.");
    const size = Number((yield* execute(workspace, ["cat-file", "-s", match[2]])).trim());
    if (size > LIMIT) return yield* fail("This file is too large for the text restore preview.");
    // The batch header precedes the blob so the driver's UTF-8 decoder cannot strip its BOM.
    const batch = yield* execute(workspace, ["cat-file", "--batch"], `${match[2]}\n`);
    const separator = batch.indexOf("\n");
    const text = batch.slice(separator + 1, -1);
    if (
      batch.slice(0, separator) !== `${match[2]} blob ${size}` ||
      !batch.endsWith("\n") ||
      Buffer.byteLength(text) !== size ||
      text.includes("\0") ||
      (yield* execute(workspace, ["hash-object", "--no-filters", "--stdin"], text)).trim() !==
        match[2]
    )
      return yield* fail("Binary or non-UTF-8 files cannot be restored from this preview.");
    const mode = Number.parseInt(match[1], 8);
    return { text, mode, fingerprint: digest(text, mode) };
  });
  const preview = Effect.fn("MeerkatCheckpoint.preview")(function* (
    scope: MeerkatCheckpointScope,
    id: string,
  ): Effect.fn.Return<MeerkatCheckpointPreview, MeerkatCheckpointError> {
    yield* checkWorkspace(scope);
    const row = yield* get(scope, id);
    if (!row.before_ref || !row.after_ref)
      return yield* fail(
        "A complete before-and-after workspace snapshot is not available for this work.",
      );
    const baselineCommit = yield* execute(scope.workspace, ["cat-file", "commit", row.before_ref]);
    const rawBaseline = baselineCommit
      .slice(baselineCommit.indexOf("\n\n") + 2)
      .startsWith(`t3 raw workspace snapshot ref=${row.before_ref}\n`);
    // Manual points compare their saved baseline with the current worktree,
    // using a private Git index so the user's staging stays intact.
    const comparisonRef =
      row.source === "manual"
        ? CheckpointRef.make(`refs/t3/native-work/${row.id}/preview`)
        : CheckpointRef.make(row.after_ref);
    if (row.source === "manual")
      yield* captureRaw(scope.workspace, comparisonRef).pipe(Effect.mapError(fail));
    const names = (yield* execute(scope.workspace, [
      "diff",
      "--no-renames",
      "--name-status",
      "-z",
      row.before_ref,
      comparisonRef,
      "--",
    ]))
      .split("\0")
      .filter(Boolean);
    if (names.length > 200)
      return yield* fail(
        "This snapshot changes more than 100 files. Use Git to review and restore it.",
      );
    const files: MeerkatCheckpointFile[] = [];
    for (let i = 0; i < names.length; i += 2) {
      const path = names[i + 1];
      if (!path) continue;
      const status: MeerkatCheckpointFile["status"] =
        names[i] === "A"
          ? "added"
          : names[i] === "D"
            ? "deleted"
            : names[i] === "T"
              ? "type-changed"
              : "modified";
      const result = yield* Effect.gen(function* () {
        const before = yield* readBlob(scope.workspace, row.before_ref!, path);
        const after = yield* readBlob(scope.workspace, comparisonRef, path);
        const current = yield* attempt(() => readCurrent(scope.workspace, path));
        const reason = !rawBaseline
          ? "This older snapshot cannot guarantee the original working bytes. Review it in Git and save a new snapshot before restoring."
          : !before
            ? "New files remain in your workspace; this action never deletes files."
            : current.fingerprint !== (after?.fingerprint ?? "missing")
              ? "This file changed after the snapshot. Keep the newer changes or review them in Git."
              : null;
        return {
          path,
          status,
          before: before?.text ?? null,
          current: current.text,
          expectedCurrent: current.fingerprint,
          restorable: reason === null,
          reason,
        };
      }).pipe(Effect.result);
      files.push(
        result._tag === "Success"
          ? result.success
          : {
              path,
              status,
              before: null,
              current: null,
              expectedCurrent: "",
              restorable: false,
              reason: result.failure.message,
            },
      );
    }
    const patch = yield* snapshots
      .diffCheckpoints({
        cwd: scope.workspace,
        fromCheckpointRef: CheckpointRef.make(row.before_ref),
        toCheckpointRef: comparisonRef,
        ignoreWhitespace: false,
      })
      .pipe(Effect.mapError(fail));
    return { checkpoint: publicRow(row), patch, files, sharedWorkspace: true };
  });
  const restore = Effect.fn("MeerkatCheckpoint.restore")(function* (
    scope: MeerkatCheckpointScope,
    id: string,
    selected: ReadonlyArray<{ path: string; expectedCurrent: string }>,
    assertWriteSafe: Effect.Effect<void, MeerkatCheckpointError> = Effect.void,
  ): Effect.fn.Return<MeerkatCheckpointRestoreResult, MeerkatCheckpointError> {
    if (
      !selected.length ||
      selected.length > 100 ||
      new Set(selected.map((file) => file.path)).size !== selected.length
    )
      return yield* fail("Choose between 1 and 100 distinct files.");
    yield* assertWriteSafe;
    const active =
      yield* sql`SELECT id FROM meerkat_workspace_checkpoints WHERE workspace=${scope.workspace} AND status='active' LIMIT 1`.pipe(
        Effect.mapError(fail),
      );
    if (active.length)
      return yield* fail(
        "Native work is still using this workspace. Wait for it to finish before restoring files.",
      );
    const view = yield* preview(scope, id);
    const restored: string[] = [];
    const conflicts: Array<{ path: string; reason: string }> = [];
    const choices = selected.map((choice) => ({
      choice,
      file: view.files.find((file) => file.path === choice.path),
    }));
    for (const { choice, file } of choices) {
      if (
        !file?.restorable ||
        file.before === null ||
        file.expectedCurrent !== choice.expectedCurrent
      )
        conflicts.push({
          path: choice.path,
          reason:
            file?.reason ??
            "This file changed or is not part of this restore preview. Refresh it before restoring.",
        });
    }
    if (conflicts.length) return { restored, conflicts };
    const row = yield* get(scope, id);
    for (const { choice, file } of choices) {
      if (!file || file.before === null || !row.before_ref) continue;
      const before = yield* readBlob(scope.workspace, row.before_ref, file.path);
      if (!before) continue;
      const written = yield* assertWriteSafe.pipe(
        Effect.andThen(
          attempt(async () => {
            const destination = await safePath(scope.workspace, file.path);
            const current = await readCurrent(scope.workspace, file.path);
            if (current.fingerprint !== choice.expectedCurrent)
              throw Error("This file changed after preview. Refresh before restoring.");
            // Never touch Git's index. O_EXCL preserves newly created files, O_NOFOLLOW rejects symlinks.
            const handle = await NodeFSP.open(
              destination,
              current.text === null
                ? NodeFS.constants.O_WRONLY |
                    NodeFS.constants.O_CREAT |
                    NodeFS.constants.O_EXCL |
                    NodeFS.constants.O_NOFOLLOW
                : NodeFS.constants.O_RDWR | NodeFS.constants.O_NOFOLLOW,
              before.mode & 0o111 ? 0o700 : 0o600,
            );
            try {
              const resolvedDestination = await safePath(scope.workspace, file.path);
              const openedStat = await handle.stat();
              const currentStat = await NodeFSP.lstat(resolvedDestination);
              if (
                currentStat.isSymbolicLink() ||
                openedStat.dev !== currentStat.dev ||
                openedStat.ino !== currentStat.ino
              )
                throw Error("The selected file location changed during restore.");
              let permissions = before.mode & 0o111 ? 0o700 : 0o600;
              if (current.text !== null) {
                const stat = await handle.stat();
                // Git records executable intent, not individual permission classes.
                // Retain existing execute bits; only add owner execute when restoring that intent.
                permissions = before.mode & 0o100 ? (stat.mode & 0o777) | 0o100 : stat.mode & 0o666;
                if (!stat.isFile() || stat.nlink !== 1 || stat.size > LIMIT)
                  throw Error("The selected file changed type or size.");
                const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
                  await handle.readFile(),
                );
                if (
                  digest(text, stat.mode & 0o100 ? 0o100755 : 0o100644) !== choice.expectedCurrent
                )
                  throw Error("This file changed after preview. Refresh before restoring.");
              }
              const bytes = Buffer.from(before.text);
              let offset = 0;
              while (offset < bytes.length) {
                const { bytesWritten } = await handle.write(
                  bytes,
                  offset,
                  bytes.length - offset,
                  offset,
                );
                if (bytesWritten === 0)
                  throw Error("The filesystem stopped writing the selected file.");
                offset += bytesWritten;
              }
              await handle.truncate(bytes.length);
              await handle.chmod(permissions);
              await handle.sync();
            } finally {
              await handle.close();
            }
          }),
        ),
        Effect.result,
      );
      if (written._tag === "Success") restored.push(file.path);
      else conflicts.push({ path: file.path, reason: written.failure.message });
    }
    return { restored, conflicts };
  }, lock.withPermits(1));
  const list = (scope: MeerkatCheckpointScope) =>
    rowsFor(scope).pipe(Effect.map((rows) => ({ checkpoints: rows.map(publicRow) })));
  /** Call only after the owner has fenced/stopped the previous native process. */
  const interruptInstance = Effect.fn("MeerkatCheckpoint.interruptInstance")(function* (
    instanceId: string,
  ) {
    const interruptedAt = yield* now;
    yield* sql`UPDATE meerkat_workspace_checkpoints SET status='partial',completed_at=${interruptedAt},detail='Native runtime disconnected before a completion snapshot was captured.' WHERE instance_id=${instanceId} AND status='active'`.pipe(
      Effect.mapError(fail),
    );
  }, lock.withPermits(1));
  return { begin, complete, capture, list, preview, restore, interruptInstance };
});

export class MeerkatCheckpointStoreService extends Context.Service<
  MeerkatCheckpointStoreService,
  Effect.Success<typeof makeMeerkatCheckpointStore>
>()("t3/provider/meerkat/MeerkatCheckpointStore/MeerkatCheckpointStoreService") {}
export const meerkatCheckpointStoreLayer = Layer.effect(
  MeerkatCheckpointStoreService,
  makeMeerkatCheckpointStore,
);

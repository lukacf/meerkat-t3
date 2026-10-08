// @effect-diagnostics nodeBuiltinImport:off - isolated Git repositories exercise real checkpoint and restore behavior.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as Config from "../../config.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriver from "../../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { makeMeerkatCheckpointStore } from "./MeerkatCheckpointStore.ts";
import { MeerkatCheckpointError } from "@t3tools/contracts";

const layers = Layer.mergeAll(
  GitVcsDriver.vcsLayer,
  GitVcsDriver.layer,
  SqlitePersistenceMemory,
).pipe(
  Layer.provide(Config.layerTest(process.cwd(), { prefix: "native-checkpoint-test-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);
const io = <A>(run: () => Promise<A>) => Effect.promise(run);
const harness = Effect.fnUntraced(function* () {
  const root = yield* Effect.acquireRelease(
    io(
      async () =>
        await NodeFSP.realpath(
          await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "native-checkpoint-")),
        ),
    ),
    (root) => io(() => NodeFSP.rm(root, { recursive: true, force: true })),
  );
  const workspace = NodePath.join(root, "repo");
  yield* io(() => NodeFSP.mkdir(workspace));
  const driver = yield* VcsDriver.VcsDriver;
  const rawGit = yield* GitVcsDriver.GitVcsDriver;
  const git = (args: ReadonlyArray<string>, cwd = workspace) =>
    rawGit.execute({ operation: "native-checkpoint-test", cwd, args });
  yield* git(["init"]);
  yield* git(["config", "user.name", "Checkpoint Test"]);
  yield* git(["config", "user.email", "checkpoint@test.invalid"]);
  const write = (path: string, text: string) =>
    io(() => NodeFSP.writeFile(NodePath.join(workspace, path), text));
  const read = (path: string) => io(() => NodeFSP.readFile(NodePath.join(workspace, path), "utf8"));
  yield* write("selected.txt", "committed\n");
  yield* write("other.txt", "committed other\n");
  yield* git(["add", "."]);
  yield* git(["commit", "-m", "fixture"]);
  const repository = yield* driver.detectRepository(workspace);
  if (!repository) throw Error("Fixture Git repository missing.");
  const handle = { kind: repository.kind, repository, driver };
  const snapshots = yield* CheckpointStore.make.pipe(
    Effect.provideService(VcsDriverRegistry.VcsDriverRegistry, {
      get: () => Effect.succeed(driver),
      detect: () => Effect.succeed(handle),
      resolve: () => Effect.succeed(handle),
    }),
  );
  const store = yield* makeMeerkatCheckpointStore.pipe(
    Effect.provideService(CheckpointStore.CheckpointStore, snapshots),
  );
  const scope = {
    instanceId: "native",
    mobId: "mob",
    sessionId: "session",
    stateRoot: "/native",
    projectPath: workspace,
    workspace,
  };
  return { root, workspace, store, scope, git, write, read, snapshots };
});

it.effect(
  "restores selected text to the real dirty baseline and preserves index, other edits and new files",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.write("selected.txt", "user staged\n");
      yield* h.git(["add", "selected.txt"]);
      yield* h.write("selected.txt", "user unstaged baseline\n");
      yield* h.write("existing-untracked.txt", "user file\n");
      const indexBefore = (yield* h.git(["write-tree"])).stdout;
      const started = yield* h.store.begin(h.scope);
      expect(started.status).toBe("active");
      expect((yield* h.store.begin(h.scope)).id).toBe(started.id);
      yield* h.write("selected.txt", "agent change\n");
      yield* h.write("other.txt", "other agent change\n");
      yield* h.write("new.txt", "new work\n");
      expect((yield* h.store.complete(h.scope))?.status).toBe("complete");
      const view = yield* h.store.preview(h.scope, started.id);
      expect(view.sharedWorkspace).toBe(true);
      expect(view.patch).toContain("agent change");
      expect(view.files.find((file) => file.path === "new.txt")?.restorable).toBe(false);
      const selected = view.files.find((file) => file.path === "selected.txt")!;
      expect(selected.before).toBe("user unstaged baseline\n");
      expect(selected.restorable).toBe(true);
      expect(
        yield* h.store.restore(h.scope, started.id, [
          { path: selected.path, expectedCurrent: selected.expectedCurrent },
        ]),
      ).toEqual({ restored: ["selected.txt"], conflicts: [] });
      expect(yield* h.read("selected.txt")).toBe("user unstaged baseline\n");
      expect(yield* h.read("other.txt")).toBe("other agent change\n");
      expect(yield* h.read("new.txt")).toBe("new work\n");
      expect(yield* h.read("existing-untracked.txt")).toBe("user file\n");
      expect((yield* h.git(["write-tree"])).stdout).toBe(indexBefore);
    }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect("refuses later changes, cross-session requests and paths absent from the preview", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const checkpoint = yield* h.store.begin(h.scope);
    yield* h.write("selected.txt", "agent change\n");
    yield* h.write("other.txt", "agent other\n");
    yield* h.store.complete(h.scope);
    const view = yield* h.store.preview(h.scope, checkpoint.id);
    yield* h.write("selected.txt", "newer human change\n");
    const result = yield* h.store.restore(
      h.scope,
      checkpoint.id,
      view.files.map((file) => ({ path: file.path, expectedCurrent: file.expectedCurrent })),
    );
    expect(result.restored).toEqual([]);
    expect(result.conflicts.map((file) => file.path)).toContain("selected.txt");
    expect(yield* h.read("other.txt")).toBe("agent other\n");
    expect(yield* h.read("selected.txt")).toBe("newer human change\n");
    expect(
      (yield* h.store.restore(h.scope, checkpoint.id, [
        { path: "../escape", expectedCurrent: "missing" },
      ])).conflicts,
    ).toHaveLength(1);
    expect(
      (yield* Effect.result(
        h.store.preview({ ...h.scope, sessionId: "other-session" }, checkpoint.id),
      ))._tag,
    ).toBe("Failure");
    expect(
      (yield* h.store.list({ ...h.scope, stateRoot: "/replacement-native" })).checkpoints,
    ).toEqual([]);
    expect(
      (yield* Effect.result(
        h.store.preview({ ...h.scope, stateRoot: "/replacement-native" }, checkpoint.id),
      ))._tag,
    ).toBe("Failure");
  }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect("restores an agent-deleted file without following links or deleting added files", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const checkpoint = yield* h.store.begin(h.scope);
    yield* io(() => NodeFSP.unlink(NodePath.join(h.workspace, "selected.txt")));
    yield* h.write("added.txt", "keep\n");
    yield* h.store.complete(h.scope, { failed: true });
    const view = yield* h.store.preview(h.scope, checkpoint.id);
    expect(view.checkpoint.status).toBe("partial");
    const deleted = view.files.find((file) => file.path === "selected.txt")!;
    expect(deleted).toMatchObject({ status: "deleted", restorable: true, current: null });
    const added = view.files.find((file) => file.path === "added.txt")!;
    expect(added.restorable).toBe(false);
    yield* io(() =>
      NodeFSP.symlink(
        NodePath.join(h.workspace, "other.txt"),
        NodePath.join(h.workspace, "selected.txt"),
      ),
    );
    expect((yield* h.store.restore(h.scope, checkpoint.id, [deleted])).conflicts).toHaveLength(1);
    expect(yield* h.read("other.txt")).toBe("committed other\n");
    yield* io(() => NodeFSP.unlink(NodePath.join(h.workspace, "selected.txt")));
    expect((yield* h.store.restore(h.scope, checkpoint.id, [deleted])).restored).toEqual([
      "selected.txt",
    ]);
    expect(yield* h.read("selected.txt")).toBe("committed\n");
    expect(yield* h.read("added.txt")).toBe("keep\n");
  }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect(
  "explains how to recover a deleted parent directory before restoring saved file bytes",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const directory = NodePath.join(h.workspace, "src", "feature");
      const path = "src/feature/file.ts";
      yield* io(() => NodeFSP.mkdir(directory, { recursive: true }));
      yield* h.write(path, "original nested file\n");
      const checkpoint = yield* h.store.begin(h.scope);
      yield* io(() => NodeFSP.rm(directory, { recursive: true }));
      yield* h.store.complete(h.scope);

      const blocked = (yield* h.store.preview(h.scope, checkpoint.id)).files.find(
        (file) => file.path === path,
      )!;
      expect(blocked).toMatchObject({
        status: "deleted",
        restorable: false,
        reason:
          'The parent folder "src/feature" is missing. Recreate it as an ordinary folder in this workspace, then refresh History to restore the file.',
      });
      expect((yield* h.store.restore(h.scope, checkpoint.id, [blocked])).restored).toEqual([]);
      expect(
        yield* io(() =>
          NodeFSP.stat(directory).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);

      yield* io(() => NodeFSP.mkdir(directory));
      const ready = (yield* h.store.preview(h.scope, checkpoint.id)).files.find(
        (file) => file.path === path,
      )!;
      expect(ready).toMatchObject({ restorable: true, before: "original nested file\n" });
      expect((yield* h.store.restore(h.scope, checkpoint.id, [ready])).restored).toEqual([path]);
      expect(yield* h.read(path)).toBe("original nested file\n");
    }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect("uses exact worktree snapshots and retains metadata across store reconstruction", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const worktree = NodePath.join(h.root, "worktree");
    yield* h.git(["worktree", "add", "-b", "isolated", worktree]);
    const scope = { ...h.scope, workspace: worktree, projectPath: worktree };
    const checkpoint = yield* h.store.begin(scope);
    yield* io(() =>
      NodeFSP.writeFile(NodePath.join(worktree, "selected.txt"), "worktree change\n"),
    );
    yield* h.store.complete(scope);
    const resumed = yield* makeMeerkatCheckpointStore.pipe(
      Effect.provideService(CheckpointStore.CheckpointStore, h.snapshots),
    );
    expect((yield* resumed.list(scope)).checkpoints.map((row) => row.id)).toEqual([checkpoint.id]);
    expect((yield* resumed.list(h.scope)).checkpoints).toEqual([]);
    const view = yield* resumed.preview(scope, checkpoint.id);
    expect((yield* resumed.restore(scope, checkpoint.id, [view.files[0]!])).restored).toEqual([
      "selected.txt",
    ]);
    expect(yield* h.read("selected.txt")).toBe("committed\n");
    expect(yield* io(() => NodeFSP.readFile(NodePath.join(worktree, "selected.txt"), "utf8"))).toBe(
      "committed\n",
    );
  }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect("excludes binary data and hard links and preserves restrictive file permissions", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* io(() =>
      NodeFSP.writeFile(NodePath.join(h.workspace, "binary.bin"), Buffer.from([0, 255, 1])),
    );
    yield* io(() => NodeFSP.chmod(NodePath.join(h.workspace, "selected.txt"), 0o600));
    const checkpoint = yield* h.store.begin(h.scope);
    yield* h.write("selected.txt", "agent change\n");
    yield* h.write("other.txt", "linked change\n");
    yield* io(() =>
      NodeFSP.writeFile(NodePath.join(h.workspace, "binary.bin"), Buffer.from([0, 255, 2])),
    );
    yield* h.store.complete(h.scope);
    yield* io(() =>
      NodeFSP.link(
        NodePath.join(h.workspace, "other.txt"),
        NodePath.join(h.root, "external-link.txt"),
      ),
    );
    const preview = yield* h.store.preview(h.scope, checkpoint.id);
    expect(preview.files.find((file) => file.path === "binary.bin")?.restorable).toBe(false);
    expect(preview.files.find((file) => file.path === "other.txt")?.restorable).toBe(false);
    const selected = preview.files.find((file) => file.path === "selected.txt")!;
    expect((yield* h.store.restore(h.scope, checkpoint.id, [selected])).restored).toEqual([
      "selected.txt",
    ]);
    expect(
      (yield* io(() => NodeFSP.stat(NodePath.join(h.workspace, "selected.txt")))).mode & 0o777,
    ).toBe(0o600);
  }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect(
  "replaces an interrupted run baseline and refuses restore while another native session is active",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const interrupted = yield* h.store.begin(h.scope);
      yield* h.write("selected.txt", "interrupted state\n");
      const fresh = yield* h.store.begin(h.scope, { replaceActive: true });
      expect(fresh.id).not.toBe(interrupted.id);
      expect(
        (yield* h.store.list(h.scope)).checkpoints.find((row) => row.id === interrupted.id)?.status,
      ).toBe("partial");
      yield* h.write("selected.txt", "next run change\n");
      yield* h.store.complete(h.scope);
      const view = yield* h.store.preview(h.scope, fresh.id);
      expect(view.files[0]?.before).toBe("interrupted state\n");
      const other = { ...h.scope, sessionId: "peer" };
      yield* h.store.begin(other);
      expect(
        (yield* Effect.result(h.store.restore(h.scope, fresh.id, [view.files[0]!])))._tag,
      ).toBe("Failure");
      expect(yield* h.read("selected.txt")).toBe("next run change\n");
      yield* h.store.complete(other);
      expect((yield* h.store.restore(h.scope, fresh.id, [view.files[0]!])).restored).toEqual([
        "selected.txt",
      ]);
    }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect(
  "does not complete a replacement checkpoint when a terminal callback names the interrupted one",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const interrupted = yield* h.store.begin(h.scope);
      const replacement = yield* h.store.begin(h.scope, { replaceActive: true });
      expect(yield* h.store.complete(h.scope, { checkpointId: interrupted.id })).toBeNull();
      expect(
        (yield* h.store.list(h.scope)).checkpoints.find((row) => row.id === replacement.id)?.status,
      ).toBe("active");
      expect((yield* h.store.complete(h.scope, { checkpointId: replacement.id }))?.status).toBe(
        "complete",
      );
    }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect(
  "manual snapshots compare current files with their saved baseline and preserve staging",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.write("selected.txt", "staged baseline\n");
      yield* h.git(["add", "selected.txt"]);
      yield* h.write("selected.txt", "manual baseline\n");
      const indexBefore = (yield* h.git(["diff", "--cached"])).stdout;
      const snapshot = yield* h.store.capture(h.scope);
      expect(snapshot.source).toBe("manual");
      expect(snapshot.status).toBe("complete");
      yield* h.write("selected.txt", "changed later\n");
      const view = yield* h.store.preview(h.scope, snapshot.id);
      expect(view.files[0]?.before).toBe("manual baseline\n");
      expect(view.files[0]?.current).toBe("changed later\n");
      const selected = view.files.map(({ path, expectedCurrent }) => ({ path, expectedCurrent }));
      expect((yield* h.store.restore(h.scope, snapshot.id, selected)).restored).toEqual([
        "selected.txt",
      ]);
      expect(yield* h.read("selected.txt")).toBe("manual baseline\n");
      expect((yield* h.git(["diff", "--cached"])).stdout).toBe(indexBefore);
      expect((yield* h.store.preview(h.scope, snapshot.id)).files).toEqual([]);
    }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect(
  "rechecks runtime safety before each file and reports partial restore without overwriting later work",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const snapshot = yield* h.store.capture(h.scope);
      yield* h.write("selected.txt", "selected change\n");
      yield* h.write("other.txt", "other change\n");
      const view = yield* h.store.preview(h.scope, snapshot.id);
      let checks = 0;
      const guard = Effect.suspend(() =>
        ++checks < 3
          ? Effect.void
          : Effect.fail(
              new MeerkatCheckpointError({ message: "Native work started in this workspace." }),
            ),
      );
      const result = yield* h.store.restore(h.scope, snapshot.id, view.files, guard);
      expect(result.restored).toEqual(["other.txt"]);
      expect(result.conflicts).toEqual([
        { path: "selected.txt", reason: "Native work started in this workspace." },
      ]);
      expect(yield* h.read("other.txt")).toBe("committed other\n");
      expect(yield* h.read("selected.txt")).toBe("selected change\n");
    }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect("does not publish a manual snapshot when native work starts during capture", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    let checks = 0;
    const guard = Effect.suspend(() =>
      ++checks === 1
        ? Effect.void
        : Effect.fail(new MeerkatCheckpointError({ message: "Workspace became busy." })),
    );
    expect((yield* Effect.result(h.store.capture(h.scope, guard)))._tag).toBe("Failure");
    expect((yield* h.store.list(h.scope)).checkpoints).toEqual([]);
  }).pipe(Effect.provide(layers), Effect.scoped),
);

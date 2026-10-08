// @effect-diagnostics nodeBuiltinImport:off - isolated Git repositories exercise real checkpoint and restore behavior.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { CheckpointRef } from "@t3tools/contracts";
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

it.effect("adversarial: CRLF text files remain restorable with Git normalization configured", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.write(".gitattributes", "selected.txt text eol=crlf\n");
    yield* h.write("selected.txt", "baseline\r\n");
    const snapshot = yield* h.store.capture(h.scope);
    yield* h.write("selected.txt", "changed\r\n");
    const view = yield* h.store.preview(h.scope, snapshot.id);
    const selected = view.files.find((file) => file.path === "selected.txt")!;
    expect(selected.current).toBe("changed\r\n");
    expect(selected.restorable).toBe(true);
    expect(selected.before).toBe("baseline\r\n");
    expect((yield* h.store.restore(h.scope, snapshot.id, [selected])).restored).toEqual([
      "selected.txt",
    ]);
    expect(yield* h.read("selected.txt")).toBe("baseline\r\n");
  }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect(
  "adversarial: restoring an owner-only executable does not grant group or other execute",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* io(() => NodeFSP.chmod(NodePath.join(h.workspace, "selected.txt"), 0o700));
      const snapshot = yield* h.store.capture(h.scope);
      yield* h.write("selected.txt", "changed\n");
      const view = yield* h.store.preview(h.scope, snapshot.id);
      const selected = view.files.find((file) => file.path === "selected.txt")!;
      expect(selected.reason).toBe(null);
      expect((yield* h.store.restore(h.scope, snapshot.id, [selected])).restored).toEqual([
        "selected.txt",
      ]);
      expect(
        (yield* io(() => NodeFSP.stat(NodePath.join(h.workspace, "selected.txt")))).mode & 0o777,
      ).toBe(0o700);
    }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect("preserves mixed EOL bytes without invoking configured clean or smudge filters", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const marker = NodePath.join(h.root, "filter-invoked");
    yield* h.git(["config", "filter.review.clean", `touch '${marker}'; cat`]);
    yield* h.git(["config", "filter.review.smudge", `touch '${marker}'; cat`]);
    yield* h.git(["config", "filter.review.required", "true"]);
    yield* h.write(".gitattributes", "selected.txt text eol=crlf filter=review\n");
    yield* h.write("selected.txt", "first\r\nsecond\nthird\r\n");
    const snapshot = yield* h.store.capture(h.scope);
    yield* h.write("selected.txt", "later\r\n");
    const view = yield* h.store.preview(h.scope, snapshot.id);
    const selected = view.files.find((file) => file.path === "selected.txt")!;
    expect(selected.before).toBe("first\r\nsecond\nthird\r\n");
    expect((yield* h.store.restore(h.scope, snapshot.id, [selected])).restored).toEqual([
      "selected.txt",
    ]);
    expect(yield* h.read("selected.txt")).toBe("first\r\nsecond\nthird\r\n");
    expect(
      yield* io(() =>
        NodeFSP.stat(marker).then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false);
  }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect("keeps older Git-normalized snapshots reviewable but refuses inexact restoration", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.write(".gitattributes", "selected.txt text eol=crlf\n");
    yield* h.write("selected.txt", "baseline\r\n");
    const snapshot = yield* h.store.capture(h.scope);
    yield* h.snapshots.captureCheckpoint({
      cwd: h.workspace,
      checkpointRef: CheckpointRef.make(`refs/t3/native-work/${snapshot.id}/before`),
    });
    yield* h.write("selected.txt", "changed\r\n");
    const view = yield* h.store.preview(h.scope, snapshot.id);
    const selected = view.files.find((file) => file.path === "selected.txt")!;
    expect(view.patch).toContain("baseline");
    expect(selected.restorable).toBe(false);
    expect(selected.reason).toContain("older snapshot");
    expect((yield* h.store.restore(h.scope, snapshot.id, [selected])).restored).toEqual([]);
    expect(yield* h.read("selected.txt")).toBe("changed\r\n");
  }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect(
  "keeps existing 0750 permission classes and recreates a deleted executable privately",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* io(() => NodeFSP.chmod(NodePath.join(h.workspace, "selected.txt"), 0o750));
      const snapshot = yield* h.store.capture(h.scope);
      yield* h.write("selected.txt", "changed\n");
      let view = yield* h.store.preview(h.scope, snapshot.id);
      expect((yield* h.store.restore(h.scope, snapshot.id, view.files)).restored).toEqual([
        "selected.txt",
      ]);
      expect(
        (yield* io(() => NodeFSP.stat(NodePath.join(h.workspace, "selected.txt")))).mode & 0o777,
      ).toBe(0o750);
      yield* io(() => NodeFSP.unlink(NodePath.join(h.workspace, "selected.txt")));
      view = yield* h.store.preview(h.scope, snapshot.id);
      expect((yield* h.store.restore(h.scope, snapshot.id, view.files)).restored).toEqual([
        "selected.txt",
      ]);
      expect(
        (yield* io(() => NodeFSP.stat(NodePath.join(h.workspace, "selected.txt")))).mode & 0o777,
      ).toBe(0o700);
      expect(yield* h.read("selected.txt")).toBe("committed\n");
    }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect(
  "retains BOM and unusual file names, and represents removed parent directories as conflicts",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const unusual = '\ufeffquote"tab\tline\n.txt';
      yield* h.write(unusual, "\ufeffbaseline\r\n");
      yield* io(() => NodeFSP.mkdir(NodePath.join(h.workspace, "removed")));
      yield* h.write("removed/file.txt", "keep\n");
      yield* h.git(["add", "removed/file.txt"]);
      const snapshot = yield* h.store.capture(h.scope);
      yield* h.write(unusual, "\ufeffchanged\r\n");
      yield* io(() => NodeFSP.rm(NodePath.join(h.workspace, "removed"), { recursive: true }));
      const view = yield* h.store.preview(h.scope, snapshot.id);
      const file = view.files.find((entry) => entry.path === unusual)!;
      expect(file.reason).toBe(null);
      expect(file.before).toBe("\ufeffbaseline\r\n");
      expect(file.current).toBe("\ufeffchanged\r\n");
      expect((yield* h.store.restore(h.scope, snapshot.id, [file])).restored).toEqual([unusual]);
      expect(yield* h.read(unusual)).toBe("\ufeffbaseline\r\n");
      expect(view.files.find((entry) => entry.path === "removed/file.txt")?.restorable).toBe(false);
    }).pipe(Effect.provide(layers), Effect.scoped),
);

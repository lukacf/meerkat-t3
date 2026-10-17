// @effect-diagnostics nodeBuiltinImport:off - exact preview digest assertions.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { observeSharedCheckoutRevision } from "./SharedCheckoutRevision.ts";
import { captureSharedCheckoutPatch } from "./SharedCheckoutPatch.ts";
import { sharedGitEnvironment } from "./sharedGitEnvironment.ts";

const testLayer = VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer));
const input = { projectId: ProjectId.make("local-project") };
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess.VcsProcess;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "shared-patch-test-" });
  const git = (args: ReadonlyArray<string>) =>
    vcs
      .run({
        operation: "SharedCheckoutPatch.test",
        command: "git",
        args,
        cwd: root,
        env: sharedGitEnvironment(),
        timeoutMs: 5_000,
        maxOutputBytes: 2_097_152,
        outputMode: "error",
      })
      .pipe(Effect.map((value) => value.stdout.trim()));
  const write = (name: string, value: string) => fs.writeFileString(path.join(root, name), value);
  yield* git(["init", "-q", "-b", "feature/test"]);
  yield* git(["config", "user.name", "Fixture"]);
  yield* git(["config", "user.email", "fixture@example.invalid"]);
  yield* write("source.ts", "export const value = 1;\n");
  yield* write(".gitignore", "ignored/\n");
  yield* git(["add", "."]);
  yield* git(["commit", "-qm", "base"]);
  const commit = yield* git(["rev-parse", "HEAD"]);
  const capture = captureSharedCheckoutPatch(input, root);
  return { fs, path, vcs, root, git, write, commit, capture };
});

describe("SharedCheckoutPatch", () => {
  it.effect(
    "captures exact tracked changes without changing index, HEAD or worktree and discloses ignored exclusions",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write("source.ts", "export const value = 2;\n");
        yield* f.write("new.ts", "export const added = true;\n");
        yield* f.git(["add", "new.ts"]);
        yield* f.fs.makeDirectory(f.path.join(f.root, "ignored"));
        yield* f.write("ignored/secret.txt", "never capture this content");
        const before = yield* f.fs.readFile(f.path.join(f.root, ".git/index"));
        const preview = yield* f.capture;
        assert.strictEqual(preview.status, "ready");
        assert.strictEqual(preview.commit, f.commit);
        assert.strictEqual(preview.branch, "feature/test");
        assert.strictEqual(
          preview.sha256,
          NodeCrypto.createHash("sha256").update(preview.patch!).digest("hex"),
        );
        assert.strictEqual(preview.bytes, Buffer.byteLength(preview.patch!));
        assert.deepStrictEqual(preview.files.map((file) => [file.path, file.change]).sort(), [
          ["new.ts", "added"],
          ["source.ts", "modified"],
        ]);
        assert(
          preview.excluded.some((entry) => entry.path === "ignored/" && entry.reason === "ignored"),
        );
        assert(!preview.patch!.includes("never capture"));
        assert.strictEqual(preview.filesTruncated, false);
        assert.deepStrictEqual(yield* f.fs.readFile(f.path.join(f.root, ".git/index")), before);
        assert.strictEqual(yield* f.git(["rev-parse", "HEAD"]), f.commit);
        assert.strictEqual(
          yield* f.fs.readFileString(f.path.join(f.root, "source.ts")),
          "export const value = 2;\n",
        );
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("blocks untracked changes until deliberately staged", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write("untracked.txt", "a new file\n");
      const blocked = yield* f.capture;
      assert.strictEqual(blocked.status, "unsupported");
      assert.strictEqual(blocked.patch, null);
      assert(blocked.excluded.some((entry) => entry.reason === "untracked"));
      yield* f.git(["add", "untracked.txt"]);
      const ready = yield* f.capture;
      assert.strictEqual(ready.status, "ready");
      assert(ready.patch!.includes("a new file"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  for (const scenario of [
    "binary",
    "symlink",
    "submodule",
    "oversize",
    "detached",
    "filter",
  ] as const) {
    it.effect(`reports unsupported ${scenario} without exposing a partial patch`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write("source.ts", "changed\n");
        if (scenario === "binary")
          yield* f.fs.writeFile(f.path.join(f.root, "source.ts"), new Uint8Array([0, 1, 2]));
        if (scenario === "symlink") {
          yield* f.fs.remove(f.path.join(f.root, "source.ts"));
          yield* f.fs.symlink(".git/config", f.path.join(f.root, "source.ts"));
        }
        if (scenario === "submodule")
          yield* f.git(["update-index", "--add", "--cacheinfo", `160000,${f.commit},nested`]);
        if (scenario === "oversize") yield* f.write("source.ts", "x".repeat(1_100_000));
        if (scenario === "detached") yield* f.git(["checkout", "--detach", "-q"]);
        if (scenario === "filter") {
          yield* f.write(".gitattributes", "source.ts filter=hostile\n");
          yield* f.git(["add", ".gitattributes"]);
          yield* f.git(["config", "filter.hostile.clean", "touch should-not-run; cat"]);
          yield* f.git(["config", "filter.hostile.required", "true"]);
          const revision = yield* observeSharedCheckoutRevision(input, f.root);
          assert.strictEqual(revision.dirty, true);
          assert.strictEqual(yield* f.fs.exists(f.path.join(f.root, "should-not-run")), false);
        }
        const preview = yield* f.capture;
        assert.strictEqual(preview.status, "unsupported");
        assert.strictEqual(preview.patch, null);
        assert.strictEqual(preview.sha256, null);
        assert(preview.excluded.some((entry) => entry.reason === scenario));
        assert.strictEqual(yield* f.fs.exists(f.path.join(f.root, "should-not-run")), false);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );
  }

  for (const source of ["base", "index"] as const) {
    it.effect(`rejects an oversized ${source} blob before invoking content diff`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write("source.ts", "x".repeat(1_100_000));
        yield* f.git(["add", "source.ts"]);
        if (source === "base") yield* f.git(["commit", "-qm", "large base fixture"]);
        yield* f.write("source.ts", "small replacement\n");
        let diffs = 0;
        const preview = yield* f.capture.pipe(
          Effect.provideService(VcsProcess.VcsProcess, {
            run: (command) => {
              if (command.args.includes("diff")) diffs++;
              return f.vcs.run(command);
            },
          }),
        );
        assert.strictEqual(preview.status, "unsupported");
        assert.strictEqual(preview.patch, null);
        assert(
          preview.excluded.some(
            (entry) => entry.path === "source.ts" && entry.reason === "oversize",
          ),
        );
        assert.strictEqual(diffs, 0);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );
  }

  it.effect("disables external diff, textconv, filesystem monitor and optional index writes", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write(".gitattributes", "source.ts diff=hostile\n");
      yield* f.git(["add", ".gitattributes"]);
      yield* f.write("source.ts", "changed\n");
      for (const key of [
        "diff.external",
        "diff.hostile.command",
        "diff.hostile.textconv",
        "core.fsmonitor",
      ])
        yield* f.git(["config", key, "touch should-not-run"]);
      const preview = yield* f.capture;
      assert.strictEqual(preview.status, "ready");
      assert.strictEqual(yield* f.fs.exists(f.path.join(f.root, "should-not-run")), false);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "rejects concurrent tracked content changes instead of returning a mixed snapshot",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write("source.ts", "first dirty contents\n");
        let patches = 0;
        const error = yield* f.capture.pipe(
          Effect.provideService(VcsProcess.VcsProcess, {
            run: (command) =>
              Effect.gen(function* () {
                if (command.args.includes("--patch") && ++patches === 2)
                  yield* f.write("source.ts", "second dirty contents\n");
                return yield* f.vcs.run(command);
              }),
          }),
          Effect.flip,
        );
        assert.strictEqual(error.code, "changed");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("bounds changed-file and exclusion lists and does not claim a complete snapshot", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (let i = 0; i < 257; i++) yield* f.write(`added-${i}.txt`, "new\n");
      yield* f.git(["add", "."]);
      const preview = yield* f.capture;
      assert.strictEqual(preview.status, "unsupported");
      assert.strictEqual(preview.patch, null);
      assert.strictEqual(preview.files.length, 256);
      assert.strictEqual(preview.filesTruncated, true);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcess, layer as vcsLayer, type VcsProcessInput } from "../vcs/VcsProcess.ts";
import { sharedGitEnvironment } from "./sharedGitEnvironment.ts";
import {
  makeSharedCheckoutRevision,
  observeSharedCheckoutRevision,
} from "./SharedCheckoutRevision.ts";

const commit = "a".repeat(40);
const input = { projectId: ProjectId.make("catalog") };
function fixture(
  options: {
    branch?: string;
    dirty?: boolean;
    moved?: boolean;
    unborn?: boolean;
    truncated?: boolean;
    submodule?: boolean;
    truncatedIndex?: boolean;
  } = {},
) {
  const calls: VcsProcessInput[] = [];
  let heads = 0;
  const layer = Layer.succeed(VcsProcess, {
    run: (command) =>
      Effect.sync(() => {
        calls.push(command);
        if (command.args.includes("config"))
          return {
            exitCode: ChildProcessSpawner.ExitCode(1),
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        if (command.args.includes("ls-files"))
          return {
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: options.submodule ? `160000 ${commit} 0\tnested\0` : "",
            stderr: "",
            stdoutTruncated: options.truncatedIndex ?? false,
            stderrTruncated: false,
          };
        const status = command.args.includes("status");
        if (!status) heads += 1;
        const stdout = status
          ? `# branch.oid ${commit}\n# branch.head ${options.branch ?? "feature/catalog"}\n${options.dirty ? "? new-file.ts\n" : ""}`
          : options.moved && heads > 1
            ? "b".repeat(40)
            : commit;
        return {
          exitCode: ChildProcessSpawner.ExitCode(options.unborn ? 128 : 0),
          stdout,
          stderr: "",
          stdoutTruncated: status && (options.truncated ?? false),
          stderrTruncated: false,
        };
      }),
  });
  return { layer, calls };
}

it.effect(
  "observes the exact clean checkout branch and full commit without a shell or index writes",
  () => {
    const { layer, calls } = fixture();
    return Effect.gen(function* () {
      const result = yield* observeSharedCheckoutRevision(input, "/workspace/catalog");
      assert.strictEqual(result.branch, "feature/catalog");
      assert.strictEqual(result.commit, commit);
      assert.strictEqual(result.dirty, false);
      assert.strictEqual(calls.length, 5);
      assert(calls.every((call) => call.command === "git" && call.cwd === "/workspace/catalog"));
      assert(calls.every((call) => call.args.includes("--no-optional-locks")));
      assert(calls.every((call) => call.env?.GIT_OPTIONAL_LOCKS === "0"));
      assert(calls.every((call) => !call.args.includes("diff") && !call.args.includes("add")));
      assert(
        calls
          .find((call) => call.args.includes("status"))
          ?.args.includes("--ignore-submodules=all"),
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "reports uncommitted changes and detached HEAD without inventing a branch or snapshot",
  () => {
    const { layer } = fixture({ branch: "(detached)", dirty: true });
    return Effect.gen(function* () {
      const result = yield* observeSharedCheckoutRevision(input, "/workspace/catalog");
      assert.strictEqual(result.branch, null);
      assert.strictEqual(result.dirty, true);
      assert.strictEqual("snapshotId" in result, false);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("rejects an observation when HEAD changes during the read", () => {
  const { layer } = fixture({ moved: true });
  return Effect.gen(function* () {
    const error = yield* observeSharedCheckoutRevision(input, "/workspace/catalog").pipe(
      Effect.flip,
    );
    assert.strictEqual(error.code, "changed");
  }).pipe(Effect.provide(layer));
});

it.effect("does not fabricate a revision in a repository without a commit", () => {
  const { layer, calls } = fixture({ unborn: true });
  return Effect.gen(function* () {
    const error = yield* observeSharedCheckoutRevision(input, "/workspace/catalog").pipe(
      Effect.flip,
    );
    assert.strictEqual(error.code, "uncommitted");
    assert.strictEqual(calls.length, 2);
  }).pipe(Effect.provide(layer));
});

it.effect("rejects incomplete status instead of declaring the checkout clean", () => {
  const { layer } = fixture({ truncated: true });
  return Effect.gen(function* () {
    const error = yield* observeSharedCheckoutRevision(input, "/workspace/catalog").pipe(
      Effect.flip,
    );
    assert.strictEqual(error.code, "unavailable");
  }).pipe(Effect.provide(layer));
});

for (const scenario of ["submodule", "truncatedIndex"] as const) {
  it.effect(`refuses ${scenario} before inspecting worktree contents`, () => {
    const { layer, calls } = fixture({ [scenario]: true });
    return Effect.gen(function* () {
      const failure = yield* observeSharedCheckoutRevision(input, "/workspace/catalog").pipe(
        Effect.flip,
      );
      assert.strictEqual(failure.code, "unavailable");
      assert(!calls.some((call) => call.args.includes("status")));
    }).pipe(Effect.provide(layer));
  });
}

it.effect("never runs a submodule-only clean filter during revision observation", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcs = yield* VcsProcess;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "shared-revision-submodule-" });
    const child = path.join(root, "nested");
    yield* fs.makeDirectory(child);
    const git = (cwd: string, args: ReadonlyArray<string>) =>
      vcs.run({
        operation: "SharedCheckoutRevision.test",
        command: "git",
        args,
        cwd,
        env: sharedGitEnvironment(),
        timeoutMs: 5_000,
        maxOutputBytes: 131_072,
        outputMode: "error",
      });
    for (const cwd of [root, child]) {
      yield* git(cwd, ["init", "-q"]);
      yield* git(cwd, ["config", "user.name", "Fixture"]);
      yield* git(cwd, ["config", "user.email", "fixture@example.invalid"]);
    }
    yield* fs.writeFileString(path.join(child, ".gitattributes"), "file.txt filter=nested\n");
    yield* fs.writeFileString(path.join(child, "file.txt"), "before\n");
    yield* git(child, ["add", "."]);
    yield* git(child, ["commit", "-qm", "nested fixture"]);
    const childCommit = (yield* git(child, ["rev-parse", "HEAD"])).stdout.trim();
    yield* fs.writeFileString(
      path.join(root, ".gitmodules"),
      '[submodule "nested"]\n\tpath = nested\n\turl = ./nested\n',
    );
    yield* git(root, ["add", ".gitmodules"]);
    yield* git(root, ["update-index", "--add", "--cacheinfo", `160000,${childCommit},nested`]);
    yield* git(root, ["commit", "-qm", "parent fixture"]);
    yield* git(child, ["config", "filter.nested.clean", "touch should-not-run; cat"]);
    // Equal byte length forces content comparison instead of a size-only dirty check.
    yield* fs.writeFileString(path.join(child, "file.txt"), "after!\n");
    const failure = yield* observeSharedCheckoutRevision(input, root).pipe(Effect.flip);
    assert.strictEqual(failure.code, "unavailable");
    assert(failure.message.includes("submodules"));
    assert.strictEqual(yield* fs.exists(path.join(child, "should-not-run")), false);
  }).pipe(Effect.scoped, Effect.provide(vcsLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

for (const scenario of ["worktree", "foreign", "archived"] as const) {
  it.effect(`resolves a selected task checkout and rejects ${scenario} mismatches`, () => {
    const { layer, calls } = fixture();
    return Effect.gen(function* () {
      const service = yield* makeSharedCheckoutRevision;
      const operation = service.read({ ...input, threadId: ThreadId.make("task") });
      if (scenario === "worktree") {
        yield* operation;
        assert(calls.every((call) => call.cwd === "/worktrees/feature-api"));
      } else {
        const failure = yield* operation.pipe(Effect.flip);
        assert.strictEqual(failure.code, "not_found");
        assert.strictEqual(calls.length, 0);
        const patchFailure = yield* service
          .patch({ ...input, threadId: ThreadId.make("task") })
          .pipe(Effect.flip);
        assert.strictEqual(patchFailure.code, "not_found");
        assert.strictEqual(calls.length, 0);
      }
    }).pipe(
      Effect.provide([layer, NodeServices.layer]),
      Effect.provideService(ProjectionSnapshotQuery, {
        getProjectShellById: () =>
          Effect.succeedSome({ id: input.projectId, workspaceRoot: "/base/project" }),
        getThreadShellById: () =>
          Effect.succeedSome({
            id: "task",
            projectId: scenario === "foreign" ? "other" : input.projectId,
            worktreePath: "/worktrees/feature-api",
            archivedAt: scenario === "archived" ? "2026-10-17T00:00:00.000Z" : null,
          }),
      } as never),
    );
  });
}

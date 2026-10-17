// @effect-diagnostics nodeBuiltinImport:off - snapshot digest fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  SharedWorkspaceError,
  type SharedProject,
  type SharedSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { makeSharedRepositoryReader } from "./SharedRepositoryReader.ts";
import { sharedGitEnvironment } from "./sharedGitEnvironment.ts";

const testLayer = VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer));
const project: SharedProject = {
  sharedProjectId: "shared-api",
  name: "API",
  repository: "github.com/example/api",
  aliases: ["mirror.example/Example/API"],
  forkOf: null,
  hostProjectId: ProjectId.make("host-api"),
  createdAt: "2026-10-17T00:00:00.000Z",
};

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess.VcsProcess;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "shared-repository-test-" });
  const git = Effect.fn("SharedRepositoryReader.test.git")(function* (args: ReadonlyArray<string>) {
    return (yield* vcs.run({
      operation: "SharedRepositoryReader.test",
      command: "git",
      args,
      cwd: root,
      env: sharedGitEnvironment(),
      timeoutMs: 5_000,
      maxOutputBytes: 1_048_576,
      outputMode: "error",
    })).stdout.trim();
  });
  yield* git(["init", "--quiet"]);
  yield* git(["config", "user.name", "Fixture"]);
  yield* git(["config", "user.email", "fixture@example.invalid"]);
  yield* git(["remote", "add", "origin", "git@github.com:Example/API.git"]);
  yield* fs.makeDirectory(path.join(root, "src"));
  yield* fs.writeFileString(
    path.join(root, "src/api.ts"),
    "export const contract = 'first';\n// exact evidence\n",
  );
  yield* fs.writeFileString(path.join(root, "-option.txt"), "exact evidence option\n");
  yield* fs.writeFileString(path.join(root, "literal[glob].txt"), "exact evidence literal\n");
  yield* fs.writeFileString(path.join(root, "literalG.txt"), "wrong glob\n");
  yield* git(["add", "."]);
  yield* git(["commit", "--quiet", "-m", "first"]);
  const first = yield* git(["rev-parse", "HEAD"]);
  yield* fs.writeFileString(
    path.join(root, "src/api.ts"),
    "export const contract = 'second';\n// exact evidence\n",
  );
  yield* git(["add", "."]);
  yield* git(["commit", "--quiet", "-m", "second"]);
  const second = yield* git(["rev-parse", "HEAD"]);
  yield* fs.writeFileString(path.join(root, "src/api.ts"), "mutable uncommitted contents\n");
  const patch =
    "diff --git a/src/api.ts b/src/api.ts\n--- a/src/api.ts\n+++ b/src/api.ts\n+retained snapshot evidence\n";
  const snapshot: SharedSnapshot = {
    snapshotId: "snapshot-a",
    sharedProjectId: project.sharedProjectId,
    checkoutId: "client-checkout",
    revision: { branch: "feature/api", commit: first, applicability: "proposal" },
    sha256: NodeCrypto.createHash("sha256").update(patch).digest("hex"),
    bytes: Buffer.byteLength(patch),
    createdAt: project.createdAt,
  };
  let snapshotValue = { snapshot, patch };
  const store = {
    project: (id: string) =>
      id === project.sharedProjectId
        ? Effect.succeed(project)
        : Effect.fail(new SharedWorkspaceError({ code: "not_found", message: "missing" })),
    getSnapshot: (id: string) =>
      id === snapshot.snapshotId
        ? Effect.succeed(snapshotValue)
        : Effect.fail(new SharedWorkspaceError({ code: "not_found", message: "missing" })),
  };
  const inspectionArgs: Array<ReadonlyArray<string>> = [];
  const reader = yield* makeSharedRepositoryReader(store).pipe(
    Effect.provideService(ProjectionSnapshotQuery, {
      getProjectShellById: (id: unknown) =>
        Effect.succeed(
          id === project.hostProjectId
            ? Option.some({ id: project.hostProjectId, workspaceRoot: root })
            : Option.none(),
        ),
    } as never),
    Effect.provideService(VcsProcess.VcsProcess, {
      ...vcs,
      run: (input) => {
        inspectionArgs.push(input.args);
        return vcs.run(input);
      },
    }),
  );
  const input = { sharedProjectId: project.sharedProjectId, commit: first };
  return {
    fs,
    path,
    root,
    git,
    first,
    second,
    reader,
    input,
    snapshot,
    inspectionArgs,
    corruptSnapshot: () => {
      snapshotValue = { snapshot, patch: `${patch}tampered` };
    },
  };
});

describe("shared repository immutable inspection", () => {
  it.effect("reads each exact commit, lists and searches without changing the checkout", () =>
    Effect.gen(function* () {
      const { reader, input, second, git } = yield* fixture;
      const before = yield* git(["status", "--porcelain=v2"]);
      const firstRead = yield* reader.read({ ...input, path: "src/api.ts" });
      assert.strictEqual(firstRead.kind, "committed_file");
      assert.include(firstRead.content, "'first'");
      const secondRead = yield* reader.read({ ...input, commit: second, path: "src/api.ts" });
      assert.include(secondRead.content, "'second'");
      const files = yield* reader.list(input);
      assert.deepEqual(
        files.entries.map((entry) => entry.path),
        ["-option.txt", "literalG.txt", "literal[glob].txt", "src/api.ts"],
      );
      yield* git(["config", "grep.column", "true"]);
      const matches = yield* reader.search({ ...input, query: "exact evidence", path: "src" });
      assert.deepEqual(matches.matches, [
        { path: "src/api.ts", line: 2, text: "// exact evidence" },
      ]);
      assert.strictEqual(yield* git(["status", "--porcelain=v2"]), before);
      assert.strictEqual(yield* git(["rev-parse", "HEAD"]), second);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects refs, abbreviated commits, path traversal and arbitrary Git arguments", () =>
    Effect.gen(function* () {
      const { reader, input, first } = yield* fixture;
      for (const commit of ["HEAD", "main", first.slice(0, 12), `${first}^{tree}`, "--help"])
        assert.strictEqual(
          (yield* reader.list({ ...input, commit }).pipe(Effect.flip)).code,
          "invalid_input",
        );
      for (const path of [
        "../outside",
        "/etc/passwd",
        "src/../api.ts",
        "src\\api.ts",
        "src//api.ts",
        ":(top)*",
      ])
        assert.strictEqual(
          (yield* reader.read({ ...input, path }).pipe(Effect.flip)).code,
          "invalid_input",
        );
      assert.strictEqual(
        (yield* reader.list({ ...input, cwd: "/tmp" }).pipe(Effect.flip)).code,
        "invalid_input",
      );
      assert.strictEqual(
        (yield* reader.list({ ...input, commit: "0".repeat(40) }).pipe(Effect.flip)).code,
        "not_found",
      );
      assert.strictEqual(
        (yield* reader.search({ ...input, query: "line\nbreak" }).pipe(Effect.flip)).code,
        "invalid_input",
      );
      assert.include((yield* reader.read({ ...input, path: "-option.txt" })).content, "option");
      assert.include(
        (yield* reader.read({ ...input, path: "literal[glob].txt" })).content,
        "literal",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("requires the registered remote and accepts only its explicit alias", () =>
    Effect.gen(function* () {
      const { reader, input, git } = yield* fixture;
      yield* git(["remote", "set-url", "origin", "https://github.com/a-fork/api"]);
      assert.strictEqual((yield* reader.list(input).pipe(Effect.flip)).code, "conflict");
      yield* git(["remote", "set-url", "origin", "https://mirror.example/Example/API.git"]);
      assert.lengthOf((yield* reader.list(input)).entries, 4);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("verifies the host's fresh primary remote before accepting registration", () =>
    Effect.gen(function* () {
      const { reader, git, root } = yield* fixture;
      const registration = {
        requestId: "register-observed",
        name: "API",
        repository: "git@github.com:Example/API.git",
        aliases: ["https://mirror.example/Example/API.git"],
        hostProjectId: project.hostProjectId,
      };
      const before = yield* git(["status", "--porcelain=v2"]);
      assert.strictEqual(
        (yield* reader.verifyRegistration(registration)).repository,
        "github.com/example/api",
      );
      assert.strictEqual(
        (yield* reader
          .verifyRegistration({ ...registration, hostProjectId: ProjectId.make("unregistered") })
          .pipe(Effect.flip)).code,
        "not_found",
      );
      assert.strictEqual(
        (yield* reader
          .verifyRegistration({
            ...registration,
            repository: "github.com/another/api",
            aliases: [registration.repository],
            cwd: root,
          })
          .pipe(Effect.flip)).code,
        "conflict",
      );
      // A stale browser preview cannot establish identity after an actual remote change.
      yield* git(["remote", "set-url", "origin", "https://github.com/a-fork/api"]);
      assert.strictEqual(
        (yield* reader.verifyRegistration(registration).pipe(Effect.flip)).code,
        "conflict",
      );
      assert.strictEqual(
        (yield* reader.verifyRegistration({
          ...registration,
          repository: "https://github.com/a-fork/api.git",
        })).repository,
        "github.com/a-fork/api",
      );
      // A caller-supplied alias does not prove that a different primary repository exists here.
      yield* git(["remote", "set-url", "origin", "https://mirror.example/Example/API.git"]);
      assert.strictEqual(
        (yield* reader.verifyRegistration(registration).pipe(Effect.flip)).code,
        "conflict",
      );
      yield* git(["remote", "set-url", "origin", "https://credential@github.com/Example/API.git"]);
      assert.strictEqual(
        (yield* reader.verifyRegistration(registration).pipe(Effect.flip)).code,
        "conflict",
      );
      yield* git(["remote", "remove", "origin"]);
      assert.strictEqual(
        (yield* reader.verifyRegistration(registration).pipe(Effect.flip)).code,
        "conflict",
      );
      assert.strictEqual(yield* git(["status", "--porcelain=v2"]), before);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "does not follow symlinks or submodules, invoke textconv, or read replacement objects",
    () =>
      Effect.gen(function* () {
        const { reader, input, fs, path, root, git, second } = yield* fixture;
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "shared-repository-secret-" });
        const secret = path.join(outside, "secret.txt");
        yield* fs.writeFileString(secret, "OUTSIDE_SECRET\n");
        yield* fs.symlink(secret, path.join(root, "escape"));
        yield* fs.writeFileString(path.join(root, ".gitattributes"), "*.ts diff=hostile\n");
        yield* git(["config", "diff.hostile.textconv", `touch ${path.join(root, "textconv-ran")}`]);
        yield* git(["add", "escape", ".gitattributes"]);
        yield* git(["update-index", "--add", "--cacheinfo", `160000,${second},nested-module`]);
        yield* git(["commit", "--quiet", "-m", "boundaries"]);
        const commit = yield* git(["rev-parse", "HEAD"]);
        const selected = { ...input, commit };
        const paths = (yield* reader.list(selected)).entries.map((entry) => entry.path);
        assert.notInclude(paths, "escape");
        assert.notInclude(paths, "nested-module");
        assert.strictEqual(
          (yield* reader.read({ ...selected, path: "escape" }).pipe(Effect.flip)).code,
          "not_found",
        );
        assert.strictEqual(
          (yield* reader.read({ ...selected, path: "nested-module" }).pipe(Effect.flip)).code,
          "not_found",
        );
        assert.deepEqual(
          (yield* reader.search({ ...selected, query: "OUTSIDE_SECRET" })).matches,
          [],
        );
        assert.isAbove(
          (yield* reader.search({ ...selected, query: "exact evidence" })).matches.length,
          0,
        );
        assert.isFalse(yield* fs.exists(path.join(root, "textconv-ran")));
        yield* git(["replace", input.commit, second]);
        assert.include((yield* reader.read({ ...input, path: "src/api.ts" })).content, "'first'");
        yield* git(["update-ref", `refs/heads/${input.commit}`, second]);
        assert.include((yield* reader.read({ ...input, path: "src/api.ts" })).content, "'first'");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("bounds text and result sizes and refuses ambiguous binary contents", () =>
    Effect.gen(function* () {
      const { reader, input, fs, path, root, git } = yield* fixture;
      const limited = yield* reader.list({ ...input, limit: 1 });
      assert.lengthOf(limited.entries, 1);
      assert.isTrue(limited.truncated);
      const page = yield* reader.read({ ...input, path: "src/api.ts", startLine: 2, limit: 1 });
      assert.strictEqual(page.content, "// exact evidence");
      assert.isTrue(page.truncated);
      yield* fs.writeFileString(path.join(root, "binary.dat"), "binary\0content");
      yield* fs.writeFileString(path.join(root, "large.txt"), "x".repeat(131_073));
      yield* git(["add", "binary.dat", "large.txt"]);
      yield* git(["commit", "--quiet", "-m", "bounded"]);
      const commit = yield* git(["rev-parse", "HEAD"]);
      assert.strictEqual(
        (yield* reader.read({ ...input, commit, path: "binary.dat" }).pipe(Effect.flip)).code,
        "unavailable",
      );
      assert.strictEqual(
        (yield* reader.read({ ...input, commit, path: "large.txt" }).pipe(Effect.flip)).code,
        "limit_exceeded",
      );
      assert.strictEqual(
        (yield* reader.search({ ...input, commit, query: "x" }).pipe(Effect.flip)).code,
        "limit_exceeded",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("refuses large search blobs and aggregate selections before Git grep loads them", () =>
    Effect.gen(function* () {
      const { reader, input, fs, path, root, git, inspectionArgs } = yield* fixture;
      yield* fs.writeFileString(path.join(root, "large-no-match.txt"), "z".repeat(131_073));
      yield* git(["add", "large-no-match.txt"]);
      yield* git(["commit", "--quiet", "-m", "large search input"]);
      const largeCommit = yield* git(["rev-parse", "HEAD"]);
      inspectionArgs.length = 0;
      const large = yield* reader
        .search({
          ...input,
          commit: largeCommit,
          path: "large-no-match.txt",
          query: "absent needle",
        })
        .pipe(Effect.flip);
      assert.strictEqual(large.code, "limit_exceeded");
      assert.include(large.message, "Narrow path");
      assert.isFalse(inspectionArgs.some((args) => args.includes("grep")));
      yield* fs.makeDirectory(path.join(root, "aggregate"));
      for (let index = 0; index < 65; index++)
        yield* fs.writeFileString(
          path.join(root, "aggregate", `${index}.txt`),
          "x".repeat(131_072),
        );
      yield* git(["add", "aggregate"]);
      yield* git(["commit", "--quiet", "-m", "bounded aggregate search"]);
      const aggregateCommit = yield* git(["rev-parse", "HEAD"]);
      inspectionArgs.length = 0;
      const aggregate = yield* reader
        .search({ ...input, commit: aggregateCommit, path: "aggregate", query: "absent needle" })
        .pipe(Effect.flip);
      assert.strictEqual(aggregate.code, "limit_exceeded");
      assert.isFalse(inspectionArgs.some((args) => args.includes("grep")));
      assert.deepEqual(
        (yield* reader.search({
          ...input,
          commit: aggregateCommit,
          path: "aggregate/0.txt",
          query: "absent needle",
        })).matches,
        [],
      );
      assert.isTrue(
        inspectionArgs.some((args) => args.includes("grep") && args.includes("--threads=1")),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("returns snapshot patches as retained evidence with exact base and integrity", () =>
    Effect.gen(function* () {
      const { reader, input, snapshot, second, corruptSnapshot } = yield* fixture;
      const result = yield* reader.read({ ...input, snapshotId: snapshot.snapshotId });
      assert.strictEqual(result.kind, "snapshot_evidence");
      if (result.kind !== "snapshot_evidence") throw new Error("snapshot expected");
      assert.strictEqual(result.applied, false);
      assert.deepEqual(result.snapshot, snapshot);
      assert.include(result.content, "+retained snapshot evidence");
      assert.strictEqual(
        (yield* reader
          .read({ ...input, commit: second, snapshotId: snapshot.snapshotId })
          .pipe(Effect.flip)).code,
        "conflict",
      );
      assert.strictEqual(
        (yield* reader
          .read({ ...input, path: "src/api.ts", snapshotId: snapshot.snapshotId })
          .pipe(Effect.flip)).code,
        "invalid_input",
      );
      corruptSnapshot();
      assert.strictEqual(
        (yield* reader.read({ ...input, snapshotId: snapshot.snapshotId }).pipe(Effect.flip)).code,
        "unavailable",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

it("overrides inherited Git redirections instead of accidentally retaining them through extended env", () => {
  const inherited = {
    GIT_DIR: "/wrong",
    GIT_CONFIG_PARAMETERS: "-c core.sshCommand=bad",
    GIT_TRACE: "/secret-output",
    OTHER: "retained",
  };
  const effective: NodeJS.ProcessEnv = { ...inherited, ...sharedGitEnvironment(inherited) };
  assert.strictEqual(effective.GIT_DIR, undefined);
  assert.strictEqual(effective.GIT_CONFIG_PARAMETERS, undefined);
  assert.strictEqual(effective.GIT_TRACE, undefined);
  assert.strictEqual(effective.OTHER, "retained");
  assert.strictEqual(effective.GIT_NO_LAZY_FETCH, "1");
  assert.strictEqual(effective.GIT_NO_REPLACE_OBJECTS, "1");
});

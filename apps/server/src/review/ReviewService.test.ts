import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ReviewService from "./ReviewService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

function makeLayer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly detectCalls?: Array<{ readonly cwd: string }>;
  readonly registeredRoots?: () => ReadonlyArray<string>;
}) {
  return ReviewService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        get: () => Effect.die("unexpected VCS registry get"),
        resolve: () => Effect.die("unexpected VCS registry resolve"),
        detect: (request) =>
          Effect.sync(() => {
            input.detectCalls?.push({ cwd: request.cwd });
            return null;
          }),
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getReviewWorkspaceRoots: () => Effect.sync(() => input.registeredRoots?.() ?? []),
      }),
    ),
    Layer.provide(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("ReviewService", () => {
  it.effect("skips an inaccessible saved root without accepting an inaccessible candidate", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const inaccessible = `${projectRoot}\0invalid`;
      const detectCalls: Array<{ readonly cwd: string }> = [];
      yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        assert.strictEqual((yield* review.getDiffPreview({ cwd: projectRoot })).cwd, projectRoot);
        const error = yield* review.getDiffPreview({ cwd: inaccessible }).pipe(Effect.flip);
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
        assert.deepStrictEqual(detectCalls, [{ cwd: projectRoot }]);
      }).pipe(
        Effect.provide(
          makeLayer({
            workspaceRoot,
            baseDir,
            detectCalls,
            registeredRoots: () => [inaccessible, projectRoot],
          }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts registered external checkouts and observes their removal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const nested = `${projectRoot}/..valid-name`;
      yield* fs.makeDirectory(nested);
      let roots: ReadonlyArray<string> = [projectRoot];
      const detectCalls: Array<{ readonly cwd: string }> = [];

      yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        assert.strictEqual((yield* review.getDiffPreview({ cwd: projectRoot })).cwd, projectRoot);
        assert.strictEqual((yield* review.getDiffPreview({ cwd: nested })).cwd, nested);
        roots = [];
        const removed = yield* review.getDiffPreview({ cwd: projectRoot }).pipe(Effect.flip);
        assert.strictEqual(removed._tag, "VcsRepositoryDetectionError");
        assert.deepStrictEqual(detectCalls, [{ cwd: projectRoot }, { cwd: nested }]);
      }).pipe(
        Effect.provide(
          makeLayer({ workspaceRoot, baseDir, detectCalls, registeredRoots: () => roots }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows canonical aliases but rejects symlink escapes and sibling prefixes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const externalRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-external-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const projectRoot = `${externalRoot}/project`;
      const sibling = `${externalRoot}/project-other`;
      const alias = `${externalRoot}/alias`;
      yield* fs.makeDirectory(projectRoot);
      yield* fs.makeDirectory(sibling);
      yield* fs.symlink(projectRoot, alias);
      yield* fs.symlink(sibling, `${projectRoot}/escape`);
      const detectCalls: Array<{ readonly cwd: string }> = [];

      yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        yield* review.getDiffPreview({ cwd: alias });
        const siblingError = yield* review.getDiffPreview({ cwd: sibling }).pipe(Effect.flip);
        const escapeError = yield* review
          .getDiffFileContents({
            cwd: `${projectRoot}/escape`,
            sourceKind: "working-tree",
            changeType: "change",
            baseRef: "HEAD",
            headRef: null,
            oldPath: "file.ts",
            newPath: "file.ts",
          })
          .pipe(Effect.flip);
        assert.strictEqual(siblingError._tag, "VcsRepositoryDetectionError");
        assert.strictEqual(escapeError._tag, "VcsRepositoryDetectionError");
        assert.deepStrictEqual(detectCalls, [{ cwd: alias }]);
      }).pipe(
        Effect.provide(
          makeLayer({ workspaceRoot, baseDir, detectCalls, registeredRoots: () => [projectRoot] }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects diff preview cwd outside the configured workspace roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffPreview");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within the configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("attributes file-content workspace violations to the file-content operation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review
          .getDiffFileContents({
            cwd: outsideRoot,
            sourceKind: "working-tree",
            changeType: "change",
            baseRef: "HEAD",
            headRef: null,
            oldPath: "file.ts",
            newPath: "file.ts",
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffFileContents");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within the configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows diff preview cwd inside the configured workspace root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: workspaceRoot });
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(result.cwd, workspaceRoot);
      assert.deepStrictEqual(result.sources, []);
      assert.deepStrictEqual(detectCalls, [{ cwd: workspaceRoot }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves unexpected path-resolution failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const invalidCwd = `${workspaceRoot}\0invalid`;
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: invalidCwd }).pipe(Effect.flip);
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      if (error._tag !== "VcsRepositoryDetectionError") return;
      assert.strictEqual(error.operation, "ReviewService.assertWorkspaceBoundCwd.canonicalizePath");
      assert.strictEqual(error.cwd, invalidCwd);
      assert.match(error.detail, /Failed to resolve a path/);
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

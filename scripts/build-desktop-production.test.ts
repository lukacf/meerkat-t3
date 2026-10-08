import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import rootPackageJson from "../package.json" with { type: "json" };
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };
import {
  createStagePatchedDependencies,
  createStageWorkspaceConfig,
  installDesktopProductionDependencies,
  resolveDesktopRuntimeDependencies,
  resolveMergedStageDependencies,
} from "./build-desktop-artifact.ts";
import { selectCliRuntimeExternalDependencies } from "./lib/cli-external-packages.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

const WorkspaceInputs = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});
const decodeWorkspaceInputs = Schema.decodeEffect(fromYaml(WorkspaceInputs));
const encodeStageWorkspace = Schema.encodeEffect(fromYaml(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const resolutionRelativePath = "scripts/desktop-production-resolutions/mac-arm64";

const makeCurrentStage = Effect.fn("test.makeCurrentDesktopProductionStage")(function* (
  input: {
    readonly platform?: "mac" | "linux" | "win";
    readonly arch?: "arm64" | "x64" | "universal";
    readonly copyResolution?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourceRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const temporaryRoot = yield* fs.makeTempDirectoryScoped({
    prefix: "t3-production-install-test-",
  });
  const repoRoot = path.join(temporaryRoot, "repo");
  const stageAppDir = path.join(temporaryRoot, "stage");
  const resolutionDir = path.join(repoRoot, resolutionRelativePath);
  const platform = input.platform ?? "mac";
  const arch = input.arch ?? "arm64";
  yield* fs.makeDirectory(repoRoot, { recursive: true });
  yield* fs.makeDirectory(stageAppDir, { recursive: true });

  const workspace = yield* decodeWorkspaceInputs(
    yield* fs.readFileString(path.join(sourceRoot, "pnpm-workspace.yaml")),
  );
  const catalog = workspace.catalog ?? {};
  const serverDependencies = resolveCatalogDependencies(
    serverPackageJson.dependencies,
    catalog,
    "apps/server",
  );
  const desktopDependencies = resolveDesktopRuntimeDependencies(
    desktopPackageJson.dependencies,
    catalog,
  );
  const dependencies =
    platform === "win"
      ? desktopDependencies
      : resolveMergedStageDependencies({
          platform,
          arch,
          serverDependencies,
          desktopDependencies,
          fffNodeVersion: serverPackageJson.dependencies["@ff-labs/fff-node"],
        });
  const patchedDependencies = createStagePatchedDependencies(
    workspace.patchedDependencies ?? {},
    dependencies,
  );
  const stageWorkspace = createStageWorkspaceConfig({
    platform,
    arch,
    allowBuilds: workspace.allowBuilds ?? {},
    patchedDependencies,
    overrides: resolveCatalogDependencies(workspace.overrides ?? {}, catalog, "apps/desktop"),
  });
  const packageJson = {
    name: "meerkat-t3",
    version: "0.0.92-test",
    buildVersion: "0.0.92-test",
    t3codeCommitHash: "new-build-identity",
    private: true,
    packageManager: rootPackageJson.packageManager,
    main: "apps/desktop/dist-electron/boot.cjs",
    build: {
      appId: "ai.rkat.meerkat-t3",
      publish: null,
      artifactName: "New-Build-${version}-${arch}.${ext}",
    },
    dependencies,
    devDependencies: { electron: desktopPackageJson.dependencies.electron },
  };
  const packageText = `${yield* encodeJson(packageJson)}\n`;
  const workspaceText = yield* encodeStageWorkspace(stageWorkspace);
  yield* fs.writeFileString(path.join(stageAppDir, "package.json"), packageText);
  yield* fs.writeFileString(path.join(stageAppDir, "pnpm-workspace.yaml"), workspaceText);
  for (const patchPath of Object.values(patchedDependencies)) {
    yield* fs.makeDirectory(path.dirname(path.join(stageAppDir, patchPath)), { recursive: true });
    yield* fs.copyFile(path.join(sourceRoot, patchPath), path.join(stageAppDir, patchPath));
  }

  let canonicalLock: Uint8Array | undefined;
  if (input.copyResolution !== false) {
    yield* fs.makeDirectory(path.dirname(resolutionDir), { recursive: true });
    yield* fs.copy(path.join(sourceRoot, resolutionRelativePath), resolutionDir);
    canonicalLock = yield* fs.readFile(path.join(resolutionDir, "pnpm-lock.yaml"));
  }
  return {
    repoRoot,
    stageAppDir,
    resolutionDir,
    platform,
    arch,
    packageJson,
    packageText,
    workspaceText,
    canonicalLock,
    serverRuntimeDependencyNames: Object.keys(
      selectCliRuntimeExternalDependencies(serverDependencies),
    ),
  };
});

function mockProcess(exitCode: number) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const observeInstaller = Effect.fn("test.observeDesktopProductionInstaller")(function* (
  stageAppDir: string,
  exitCode = 0,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const calls: Array<{
    readonly command: ChildProcess.StandardCommand;
    readonly lock: Uint8Array | undefined;
    readonly packageText: string;
    readonly workspaceText: string;
  }> = [];
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") {
          return yield* Effect.die("Expected a single production install command");
        }
        const lockPath = path.join(stageAppDir, "pnpm-lock.yaml");
        calls.push({
          command,
          lock: (yield* fs.exists(lockPath)) ? yield* fs.readFile(lockPath) : undefined,
          packageText: yield* fs.readFileString(path.join(stageAppDir, "package.json")),
          workspaceText: yield* fs.readFileString(path.join(stageAppDir, "pnpm-workspace.yaml")),
        });
        return mockProcess(exitCode);
      }),
    ),
  );
  return { calls, layer };
});

it.layer(NodeServices.layer)("desktop production resolution integration", (it) => {
  it.effect(
    "installs the recorded lock with current generated inputs and preserves the new build identity",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const fixture = yield* makeCurrentStage();
          for (const file of [
            ".npmrc",
            ".env",
            ".pnpmfile.cjs",
            "node_modules/owner.txt",
            "resources/old-native",
          ]) {
            const filePath = path.join(fixture.resolutionDir, file);
            yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
            yield* fs.writeFileString(filePath, "unrelated input must remain outside the stage");
          }
          const observer = yield* observeInstaller(fixture.stageAppDir);
          yield* installDesktopProductionDependencies({ ...fixture, verbose: false }).pipe(
            Effect.provide(observer.layer),
            Effect.provideService(HostProcessPlatform, "darwin"),
          );

          assert.equal(observer.calls.length, 1);
          const call = observer.calls[0];
          assert.isDefined(call);
          assert.equal(call.command.command, "vp");
          assert.deepStrictEqual(call.command.args, ["install", "--prod", "--frozen-lockfile"]);
          assert.equal(call.command.options.cwd, fixture.stageAppDir);
          assert.isDefined(fixture.canonicalLock);
          assert.deepStrictEqual(call.lock, fixture.canonicalLock);
          assert.equal(call.packageText, fixture.packageText);
          assert.equal(call.workspaceText, fixture.workspaceText);
          assert.equal(
            yield* fs.readFileString(path.join(fixture.stageAppDir, "package.json")),
            fixture.packageText,
          );
          assert.deepStrictEqual((yield* fs.readDirectory(fixture.stageAppDir)).sort(), [
            "package.json",
            "patches",
            "pnpm-lock.yaml",
            "pnpm-workspace.yaml",
          ]);
          assert.containsAllKeys(
            fixture.packageJson.dependencies,
            fixture.serverRuntimeDependencyNames,
          );
        }),
      ),
  );

  it.effect("propagates a frozen installer failure without retrying an unlocked install", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeCurrentStage();
        const observer = yield* observeInstaller(fixture.stageAppDir, 9);
        const error = yield* installDesktopProductionDependencies({
          ...fixture,
          verbose: false,
        }).pipe(
          Effect.provide(observer.layer),
          Effect.provideService(HostProcessPlatform, "darwin"),
          Effect.flip,
        );
        assert.equal(error._tag, "BuildCommandFailedError");
        assert.equal(observer.calls.length, 1);
        assert.deepStrictEqual(observer.calls[0]?.command.args, [
          "install",
          "--prod",
          "--frozen-lockfile",
        ]);
        assert.deepStrictEqual(observer.calls[0]?.lock, fixture.canonicalLock);
      }),
    ),
  );

  for (const missingFile of ["resolution.json", "pnpm-lock.yaml"]) {
    it.effect(`rejects missing default ${missingFile} before starting the installer`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const fixture = yield* makeCurrentStage();
          yield* fs.remove(path.join(fixture.resolutionDir, missingFile));
          const observer = yield* observeInstaller(fixture.stageAppDir);
          const error = yield* installDesktopProductionDependencies({
            ...fixture,
            verbose: false,
          }).pipe(
            Effect.provide(observer.layer),
            Effect.provideService(HostProcessPlatform, "darwin"),
            Effect.flip,
          );
          assert.equal(error._tag, "DesktopProductionResolutionError");
          assert.deepStrictEqual(observer.calls, []);
          assert.isFalse(yield* fs.exists(path.join(fixture.stageAppDir, "pnpm-lock.yaml")));
        }),
      ),
    );
  }

  it.effect("rejects current dependency drift before starting the installer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeCurrentStage();
        const changedPackageText = yield* encodeJson({
          ...fixture.packageJson,
          dependencies: { ...fixture.packageJson.dependencies, "node-pty": "^1.2.0" },
        });
        yield* fs.writeFileString(
          path.join(fixture.stageAppDir, "package.json"),
          changedPackageText,
        );
        const observer = yield* observeInstaller(fixture.stageAppDir);
        const error = yield* installDesktopProductionDependencies({
          ...fixture,
          verbose: false,
        }).pipe(
          Effect.provide(observer.layer),
          Effect.provideService(HostProcessPlatform, "darwin"),
          Effect.flip,
        );
        assert.equal(error._tag, "DesktopProductionResolutionError");
        assert.deepStrictEqual(observer.calls, []);
        assert.isFalse(yield* fs.exists(path.join(fixture.stageAppDir, "pnpm-lock.yaml")));
      }),
    ),
  );

  for (const target of [
    { platform: "mac", arch: "x64" },
    { platform: "linux", arch: "x64" },
    { platform: "win", arch: "arm64" },
  ] as const) {
    it.effect(
      `keeps the existing unlocked ${target.platform}/${target.arch} install without implying a recorded resolution`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fixture = yield* makeCurrentStage({ ...target, copyResolution: false });
            const observer = yield* observeInstaller(fixture.stageAppDir);
            yield* installDesktopProductionDependencies({ ...fixture, verbose: false }).pipe(
              Effect.provide(observer.layer),
              Effect.provideService(HostProcessPlatform, "darwin"),
            );
            assert.equal(observer.calls.length, 1);
            assert.equal(observer.calls[0]?.command.command, "vp");
            assert.deepStrictEqual(observer.calls[0]?.command.args, ["install", "--prod"]);
            assert.isUndefined(observer.calls[0]?.lock);
            assert.equal(observer.calls[0]?.packageText, fixture.packageText);
            assert.equal(observer.calls[0]?.workspaceText, fixture.workspaceText);
          }),
        ),
    );
  }
});

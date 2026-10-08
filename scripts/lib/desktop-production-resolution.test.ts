// @effect-diagnostics nodeBuiltinImport:off - Fixtures bind packaging input bytes with SHA-256.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  DesktopProductionResolutionError,
  prepareDesktopProductionResolution,
} from "./desktop-production-resolution.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const patchPath = "patches/example@1.0.0.patch";
const patchText = "diff --git a/index.js b/index.js\n+export const fixed = true;\n";
const workspaceText = `supportedArchitectures:
  os: [darwin]
  cpu: [arm64]
allowBuilds:
  electron: true
patchedDependencies:
  example@1.0.0: ${patchPath}
`;
const productionLock = {
  lockfileVersion: "9.0",
  importers: {
    ".": {
      dependencies: {
        example: { specifier: "^1.0.0", version: "1.0.0" },
        helper: { specifier: "2.0.0", version: "2.0.0" },
      },
      devDependencies: {
        electron: { specifier: "44.4.2", version: "44.4.2" },
      },
    },
  },
  packages: {
    "example@1.0.0": { resolution: { integrity: "sha512-example" } },
    "helper@2.0.0": { resolution: { integrity: "sha512-helper" } },
    "electron@44.4.2": { resolution: { integrity: "sha512-electron" } },
  },
  snapshots: {
    "example@1.0.0": {},
    "helper@2.0.0": {},
    "electron@44.4.2": {},
  },
};

const fixture = Effect.fn("test.desktopProductionResolution.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-production-resolution-" });
  const resolutionDir = path.join(root, "resolution");
  const stageAppDir = path.join(root, "stage");
  yield* fs.makeDirectory(resolutionDir);
  yield* fs.makeDirectory(path.join(stageAppDir, "patches"), { recursive: true });
  const packageInput = {
    name: "meerkat-t3",
    version: "0.0.92",
    buildVersion: "0.0.92",
    t3codeCommitHash: "current-checkout",
    private: true,
    packageManager: "pnpm@11.10.0",
    dependencies: { helper: "2.0.0", example: "^1.0.0" },
    devDependencies: { electron: "44.4.2" },
    build: { appId: "ai.rkat.meerkat-t3", publish: null },
  };
  const packageText = `${yield* encodeJson(packageInput)}\n`;
  // JSON is valid YAML and keeps fixture mutations explicit without exercising
  // a second serializer. The helper still uses the real YAML decoder.
  const lockText = `${yield* encodeJson(productionLock)}\n`;
  const metadata = {
    schemaVersion: 1,
    platform: "mac",
    arch: "arm64",
    packageManager: "pnpm@11.10.0",
    dependencies: { example: "^1.0.0", helper: "2.0.0" },
    devDependencies: { electron: "44.4.2" },
    workspaceSha256: hash(workspaceText),
    patchSha256: { [patchPath]: hash(patchText) },
    lockSha256: hash(lockText),
  };
  const metadataPath = path.join(resolutionDir, "resolution.json");
  const lockPath = path.join(resolutionDir, "pnpm-lock.yaml");
  const stageLockPath = path.join(stageAppDir, "pnpm-lock.yaml");
  yield* fs.writeFileString(metadataPath, yield* encodeJson(metadata));
  yield* fs.writeFileString(lockPath, lockText);
  yield* fs.writeFileString(path.join(stageAppDir, "package.json"), packageText);
  yield* fs.writeFileString(path.join(stageAppDir, "pnpm-workspace.yaml"), workspaceText);
  yield* fs.writeFileString(path.join(stageAppDir, patchPath), patchText);
  return {
    fs,
    path,
    resolutionDir,
    stageAppDir,
    metadataPath,
    lockPath,
    stageLockPath,
    packageInput,
    packageText,
    lockText,
    metadata,
    input: { resolutionDir, stageAppDir, platform: "mac", arch: "arm64" } as const,
  };
});

const assertRejected = Effect.fn("test.desktopProductionResolution.assertRejected")(function* (
  f: Effect.Success<ReturnType<typeof fixture>>,
  reason: string,
) {
  const error = yield* prepareDesktopProductionResolution(f.input).pipe(Effect.flip);
  assert.instanceOf(error, DesktopProductionResolutionError);
  assert.include(error.reason, reason);
  assert.include(error.message, "do not retry with an unlocked install");
  assert.isFalse(yield* f.fs.exists(f.stageLockPath));
  assert.equal(
    yield* f.fs.readFileString(f.path.join(f.stageAppDir, "package.json")),
    f.packageText,
  );
});

it.layer(NodeServices.layer)("frozen desktop production resolution", (it) => {
  it.effect("copies only the validated lock and preserves the new artifact identity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.writeFileString(
          f.path.join(f.resolutionDir, "package.json"),
          '{"version":"old"}',
        );
        yield* f.fs.writeFileString(
          f.path.join(f.resolutionDir, ".npmrc"),
          "registry=https://unexpected.invalid\n",
        );
        yield* f.fs.writeFileString(
          f.path.join(f.resolutionDir, ".pnpmfile.cjs"),
          "throw new Error('must not run')",
        );
        const args = yield* prepareDesktopProductionResolution(f.input);
        assert.deepStrictEqual(args, ["install", "--prod", "--frozen-lockfile"]);
        assert.equal(yield* f.fs.readFileString(f.stageLockPath), f.lockText);
        assert.equal(
          yield* f.fs.readFileString(f.path.join(f.stageAppDir, "package.json")),
          f.packageText,
        );
        assert.equal(
          yield* f.fs.readFileString(f.path.join(f.stageAppDir, "pnpm-workspace.yaml")),
          workspaceText,
        );
        assert.equal(yield* f.fs.readFileString(f.path.join(f.stageAppDir, patchPath)), patchText);
        assert.deepStrictEqual((yield* f.fs.readDirectory(f.stageAppDir)).sort(), [
          "package.json",
          "patches",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
        ]);
      }),
    ),
  );

  it.effect(
    "reads each input once and stages the validated buffer after the source lock changes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const reads = new Map<string, number>();
          const interceptedFs = {
            ...f.fs,
            readFile: (filePath: string) => {
              reads.set(filePath, (reads.get(filePath) ?? 0) + 1);
              return f.fs.readFile(filePath);
            },
            writeFile: (...args: Parameters<typeof f.fs.writeFile>) =>
              Effect.gen(function* () {
                if (args[0] === f.stageLockPath) {
                  yield* f.fs.writeFileString(f.lockPath, "changed after validation\n");
                }
                return yield* f.fs.writeFile(...args);
              }),
          };
          yield* prepareDesktopProductionResolution(f.input).pipe(
            Effect.provideService(FileSystem.FileSystem, interceptedFs),
          );
          assert.equal(yield* f.fs.readFileString(f.lockPath), "changed after validation\n");
          assert.equal(yield* f.fs.readFileString(f.stageLockPath), f.lockText);
          assert.equal(reads.size, 5);
          assert.deepStrictEqual([...reads.values()], [1, 1, 1, 1, 1]);
        }),
      ),
  );

  it.effect("rejects malformed resolution metadata without altering the stage", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.writeFileString(
          f.metadataPath,
          yield* encodeJson({ ...f.metadata, lockSha256: "not-a-digest" }),
        );
        yield* assertRejected(f, "Invalid resolution.json metadata");
      }),
    ),
  );

  for (const required of ["resolution.json", "pnpm-lock.yaml"] as const) {
    it.effect(`rejects a missing ${required} before creating a stage lock`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.fs.remove(f.path.join(f.resolutionDir, required));
          yield* assertRejected(f, "Cannot read required input");
        }),
      ),
    );
  }

  for (const target of [{ platform: "linux" }, { arch: "x64" }]) {
    it.effect(`rejects a resolution for another ${Object.keys(target)[0]}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.fs.writeFileString(
            f.metadataPath,
            yield* encodeJson({ ...f.metadata, ...target }),
          );
          yield* assertRejected(f, "Resolution target does not match");
        }),
      ),
    );
  }

  for (const mismatch of [
    { label: "package manager", metadata: { packageManager: "pnpm@11.9.0" } },
    {
      label: "production range",
      metadata: { dependencies: { example: "^2.0.0", helper: "2.0.0" } },
    },
    { label: "missing production dependency", metadata: { dependencies: { example: "^1.0.0" } } },
    { label: "development version", metadata: { devDependencies: { electron: "44.3.0" } } },
  ]) {
    it.effect(`rejects stale ${mismatch.label} metadata`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.fs.writeFileString(
            f.metadataPath,
            yield* encodeJson({ ...f.metadata, ...mismatch.metadata }),
          );
          yield* assertRejected(f, "Staged package manager or dependency inputs changed");
        }),
      ),
    );
  }

  it.effect("rejects changed workspace bytes even when its patch selection is unchanged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.writeFileString(
          f.path.join(f.stageAppDir, "pnpm-workspace.yaml"),
          workspaceText.replace("electron: true", "electron: false"),
        );
        yield* assertRejected(f, "pnpm-workspace.yaml bytes changed");
      }),
    ),
  );

  for (const patches of [
    {},
    { [patchPath]: hash(patchText), "patches/unused.patch": hash("unused") },
  ]) {
    it.effect(`rejects a patch inventory with ${Object.keys(patches).length} recorded paths`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.fs.writeFileString(
            f.metadataPath,
            yield* encodeJson({ ...f.metadata, patchSha256: patches }),
          );
          yield* assertRejected(f, "Selected patch paths do not match");
        }),
      ),
    );
  }

  it.effect("rejects changed staged patch bytes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.writeFileString(f.path.join(f.stageAppDir, patchPath), `${patchText}changed\n`);
        yield* assertRejected(f, "Selected patch bytes changed");
      }),
    ),
  );

  it.effect("rejects a patch path escaping the stage even when metadata records it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const escaped = "patches/../../outside.patch";
        const workspace = workspaceText.replace(patchPath, escaped);
        yield* f.fs.writeFileString(f.path.join(f.stageAppDir, "pnpm-workspace.yaml"), workspace);
        yield* f.fs.writeFileString(
          f.metadataPath,
          yield* encodeJson({
            ...f.metadata,
            workspaceSha256: hash(workspace),
            patchSha256: { [escaped]: hash(patchText) },
          }),
        );
        yield* assertRejected(f, "must remain inside the staged patches directory");
      }),
    ),
  );

  it.effect("rejects a changed lock before copying any bytes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.writeFileString(f.lockPath, `${f.lockText}\n`);
        yield* assertRejected(f, "Recorded pnpm-lock.yaml bytes changed");
      }),
    ),
  );

  const invalidLocks = [
    {
      label: "workspace importers",
      lock: {
        ...productionLock,
        importers: { ...productionLock.importers, "apps/server": productionLock.importers["."] },
      },
      reason: "only the root importer",
    },
    {
      label: "no root importer",
      lock: { ...productionLock, importers: { "apps/server": productionLock.importers["."] } },
      reason: "only the root importer",
    },
    {
      label: "pruned development entries",
      lock: {
        ...productionLock,
        importers: { ".": { dependencies: productionLock.importers["."].dependencies } },
      },
      reason: "devDependencies do not match",
    },
    {
      label: "stale production specifiers",
      lock: {
        ...productionLock,
        importers: {
          ".": {
            ...productionLock.importers["."],
            dependencies: {
              ...productionLock.importers["."].dependencies,
              example: { specifier: "^2.0.0", version: "2.0.0" },
            },
          },
        },
      },
      reason: "dependencies do not match",
    },
    {
      label: "workspace-linked resolutions",
      lock: {
        ...productionLock,
        importers: {
          ".": {
            ...productionLock.importers["."],
            dependencies: {
              ...productionLock.importers["."].dependencies,
              example: { specifier: "^1.0.0", version: "link:../example" },
            },
          },
        },
      },
      reason: "dependencies do not match",
    },
    {
      label: "missing package graph",
      lock: { lockfileVersion: "9.0", importers: productionLock.importers },
      reason: "Expected a full production lock with lockfileVersion 9.0",
    },
  ];
  for (const invalid of invalidLocks) {
    it.effect(`rejects ${invalid.label} even with an updated lock digest`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const text = yield* encodeJson(invalid.lock);
          yield* f.fs.writeFileString(f.lockPath, text);
          yield* f.fs.writeFileString(
            f.metadataPath,
            yield* encodeJson({ ...f.metadata, lockSha256: hash(text) }),
          );
          yield* assertRejected(f, invalid.reason);
        }),
      ),
    );
  }
});

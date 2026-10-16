import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Electron from "electron";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import { make, makeSupportReport } from "./DesktopDiagnostics.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeReport = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      nativeBuild: Schema.Struct({
        status: Schema.String,
        mobkitVersion: Schema.NullOr(Schema.String),
      }),
      health: Schema.Struct({
        startupFailure: Schema.NullOr(Schema.String),
        backend: Schema.Struct({ ready: Schema.Boolean }),
      }),
    }),
  ),
);

const manifest = {
  format: 1,
  build: {
    gatewayVersion: "0.1.0",
    meerkatVersion: "0.8.42",
    mobkitVersion: "0.8.42",
    cargoLockSha256: "a".repeat(64),
    platform: "macos",
    arch: "aarch64",
    privateBuildPath: "/Users/PRIVATE/src",
    token: "SECRET_TOKEN",
  },
  files: { "/Users/PRIVATE/native": "PRIVATE_FILE" },
};

const reportInput = {
  appVersion: "0.0.42",
  packaged: true,
  platform: "darwin",
  architecture: "arm64",
  osRelease: "25.0.0",
  versions: { electron: "42.0.0", node: "24.14.0", chrome: "148.0.0", extra: "PRIVATE_VERSION" },
  generatedAt: "2026-10-04T00:00:00.000Z",
  manifestState: "available" as const,
  manifest,
  startupFailure: null,
  quitting: false,
  backend: {
    ready: false,
    desiredRunning: true,
    processRunning: false,
    restartAttempt: 2,
    restartScheduled: true,
  },
};

function backendLayer() {
  return DesktopBackendPool.layerTest([
    {
      id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
      label: Effect.die("must not read a computer name"),
      start: Effect.die("must not start a backend"),
      stop: () => Effect.die("must not stop a backend"),
      currentConfig: Effect.die("must not read credentials or paths"),
      snapshot: Effect.succeed({
        ready: false,
        desiredRunning: true,
        activePid: Option.none(),
        restartAttempt: 2,
        restartScheduled: true,
      }),
      waitForReady: () => Effect.die("must not wait for a backend"),
    },
  ]);
}

function makeFixture(
  root: string,
  options: {
    pick?: "cancel" | "fail";
    folder?: string;
    startupResponse?: number;
    messages?: Electron.MessageBoxOptions[];
  } = {},
) {
  const environment = DesktopEnvironment.layer({
    dirname: "/private/app/dist",
    homeDirectory: "/private/home",
    platform: "darwin",
    processArch: "arm64",
    appVersion: "0.0.42",
    appPath: "/private/app",
    isPackaged: true,
    resourcesPath: root,
    runningUnderArm64Translation: false,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))));
  const dialog = Layer.succeed(ElectronDialog.ElectronDialog, {
    pickFolder: () =>
      options.pick === "cancel"
        ? Effect.succeedNone
        : options.pick === "fail"
          ? Effect.fail(
              new ElectronDialog.ElectronDialogPickFolderError({
                ownerWindowId: null,
                defaultPath: null,
                cause: "PRIVATE_PICKER_ERROR",
              }),
            )
          : Effect.succeed(Option.some(options.folder ?? root)),
    pickFiles: () => Effect.die("unexpected file picker"),
    showMessageBox: (message) =>
      Effect.sync(() => {
        options.messages?.push(message);
        return { response: options.startupResponse ?? 0, checkboxChecked: false };
      }),
    showErrorBox: () => Effect.die("unexpected raw error box"),
  } satisfies ElectronDialog.ElectronDialog["Service"]);
  return make.pipe(
    Effect.provide(Layer.mergeAll(environment, DesktopState.layer, backendLayer(), dialog)),
  );
}

describe("desktop support report allowlist", () => {
  it("projects identity and health without leaking source fields", () => {
    const output = makeSupportReport(reportInput);
    assert.equal(output.nativeBuild.meerkatVersion, "0.8.42");
    assert.equal(output.nativeBuild.source, "bundled-manifest-not-a-live-runtime-probe");
    assert.equal(output.health.backend.ready, false);
    const json = encodeJson(output);
    for (const privateValue of ["PRIVATE", "SECRET_TOKEN", "privateBuildPath", "extra", "files"])
      assert.notInclude(json, privateValue);
  });

  it("rejects malformed identity values rather than including arbitrary strings", () => {
    const output = makeSupportReport({
      ...reportInput,
      appVersion: "/private/path",
      osRelease: "PRIVATE_OS",
      manifest: { format: 1, build: { ...manifest.build, meerkatVersion: "SECRET_TOKEN" } },
    });
    assert.isNull(output.product.version);
    assert.isNull(output.system.osRelease);
    assert.equal(output.nativeBuild.status, "invalid");
    assert.isNull(output.nativeBuild.meerkatVersion);
    assert.notInclude(encodeJson(output), "SECRET_TOKEN");
  });
});

describe("desktop support report export", () => {
  it.effect(
    "exports a private report while the backend is down and includes startup category",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(path.join(root, "meerkat-runtime"));
        yield* fs.writeFileString(
          path.join(root, "meerkat-runtime", "manifest.json"),
          encodeJson(manifest),
        );
        const diagnostics = yield* makeFixture(root);
        yield* diagnostics.recordStartupFailure("bootstrap");
        const result = yield* diagnostics.exportReport;
        assert.equal(result.status, "saved");
        if (!result.filePath) return assert.fail("expected a report path");
        const saved = yield* fs.readFileString(result.filePath);
        const output = decodeReport(saved);
        assert.equal(output.health.startupFailure, "bootstrap");
        assert.equal(output.health.backend.ready, false);
        assert.equal(output.nativeBuild.mobkitVersion, "0.8.42");
        assert.notInclude(saved, root);
        assert.equal((yield* fs.stat(result.filePath)).mode & 0o777, 0o600);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("cancellation creates no file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const diagnostics = yield* makeFixture(root, { pick: "cancel" });
      assert.equal((yield* diagnostics.exportReport).status, "cancelled");
      assert.deepEqual(yield* fs.readDirectory(root), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("missing and invalid manifests remain exportable with explicit status", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const diagnostics = yield* makeFixture(root);
      const missing = yield* diagnostics.exportReport;
      if (!missing.filePath) return assert.fail("expected a report path");
      assert.equal(
        decodeReport(yield* fs.readFileString(missing.filePath)).nativeBuild.status,
        "missing",
      );
      yield* fs.makeDirectory(path.join(root, "meerkat-runtime"));
      yield* fs.writeFileString(
        path.join(root, "meerkat-runtime", "manifest.json"),
        "PRIVATE_BROKEN_JSON",
      );
      const invalid = yield* diagnostics.exportReport;
      if (!invalid.filePath) return assert.fail("expected a report path");
      const output = yield* fs.readFileString(invalid.filePath);
      assert.equal(decodeReport(output).nativeBuild.status, "invalid");
      assert.notInclude(output, "PRIVATE_BROKEN_JSON");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("picker and write failures return constant safe categories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const picker = yield* makeFixture(root, { pick: "fail" });
      assert.deepEqual(yield* picker.exportReport, {
        status: "failed",
        filePath: null,
        errorCategory: "picker-failed",
      });
      const writer = yield* makeFixture(root, {
        folder: path.join(root, "missing", "PRIVATE_FOLDER"),
      });
      assert.deepEqual(yield* writer.exportReport, {
        status: "failed",
        filePath: null,
        errorCategory: "save-failed",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("startup recovery offers and saves a report without a renderer", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const messages: Electron.MessageBoxOptions[] = [];
      const diagnostics = yield* makeFixture(root, { messages });
      yield* diagnostics.recordStartupFailure("bootstrap");
      yield* diagnostics.offerStartupReport;
      assert.equal(messages[0]?.title, "MeerkaT3 could not start");
      assert.equal(messages[1]?.title, "Support report saved");
      assert.equal((yield* fs.readDirectory(root)).length, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

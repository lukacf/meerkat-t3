// @effect-diagnostics nodeBuiltinImport:off - Notice fixtures bind exact file bytes with SHA-256.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  type NativeNoticeArtifactPurpose,
  NativeNoticeBundleError,
  stageNativeNotices,
} from "./native-notices.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isBundleError = Schema.is(NativeNoticeBundleError);
const hash = (bytes: string) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const license = "MIT License\nCopyright (c) 2026 T3 Tools Inc.\n";
const selection = '{"gateway":["example@1.0.0"],"resourceMonitor":["monitor-dependency@2.0.0"]}\n';
const payloads = {
  "README.txt": "Collected native notices, not legal clearance.\n",
  "inventory.json": '{"selected":["example@1.0.0","monitor-dependency@2.0.0"],"missing":[]}\n',
  "selection.json": selection,
  "T3-LICENSE": license,
  "notices/example-1.0.0/LICENSE-MIT": "Exact original notice\r\nCopyright Example\r\n",
  "notices/monitor-dependency-2.0.0/NOTICE": "Exact monitor notice\n",
};

const fixture = Effect.fn("test.nativeNotices.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-notices-" });
  const bundleDir = path.join(root, "prepared");
  const destinationDir = path.join(root, "staged");
  const t3LicensePath = path.join(root, "LICENSE");
  const monitorLockPath = path.join(root, "Cargo.lock");
  const gatewayLockPath = path.join(root, "gateway-Cargo.lock");
  const monitorBinaryPath = path.join(root, "t3-resource-monitor");
  yield* fs.makeDirectory(bundleDir);
  yield* fs.writeFileString(t3LicensePath, license);
  yield* fs.writeFileString(monitorLockPath, "monitor lock bytes\n");
  yield* fs.writeFileString(gatewayLockPath, "gateway lock");
  yield* fs.writeFileString(monitorBinaryPath, "monitor binary bytes\n");
  for (const [file, bytes] of Object.entries(payloads)) {
    yield* fs.makeDirectory(path.dirname(path.join(bundleDir, file)), { recursive: true });
    yield* fs.writeFileString(path.join(bundleDir, file), bytes);
  }
  const manifest = {
    schemaVersion: 1,
    target: { platform: "macos", arch: "aarch64" },
    collectionStatus: "collected",
    bindings: {
      gateway: { cargoLockSha256: hash("gateway lock"), binarySha256: hash("gateway binary") },
      resourceMonitor: {
        cargoLockSha256: hash("monitor lock bytes\n"),
        binarySha256: hash("monitor binary bytes\n"),
      },
      selectionSha256: hash(selection),
      t3LicenseSha256: hash(license),
    },
    files: Object.fromEntries(Object.entries(payloads).map(([file, bytes]) => [file, hash(bytes)])),
  };
  const manifestPath = path.join(bundleDir, "manifest.json");
  const writeManifest = (value: unknown) =>
    encodeJson(value).pipe(Effect.flatMap((json) => fs.writeFileString(manifestPath, `${json}\n`)));
  yield* writeManifest(manifest);
  return {
    fs,
    path,
    root,
    bundleDir,
    destinationDir,
    manifest,
    manifestPath,
    writeManifest,
    input: {
      bundleDir,
      destinationDir,
      target: manifest.target,
      gateway: { ...manifest.bindings.gateway, cargoLockPath: gatewayLockPath },
      resourceMonitor: { cargoLockPath: monitorLockPath, binaryPath: monitorBinaryPath },
      t3LicensePath,
    },
  };
});

const assertRejected = Effect.fn("test.nativeNotices.assertRejected")(function* (
  f: Effect.Success<ReturnType<typeof fixture>>,
  reason: string,
  artifactPurpose?: NativeNoticeArtifactPurpose,
) {
  const error = yield* stageNativeNotices(
    artifactPurpose === undefined ? f.input : { ...f.input, artifactPurpose },
  ).pipe(Effect.flip);
  assert.isTrue(isBundleError(error));
  assert.include(error.reason, reason);
  assert.isFalse(yield* f.fs.exists(f.destinationDir));
});

it.layer(NodeServices.layer)("native notice staging", (it) => {
  it.effect("stages the exact selected notice bytes and retains the unchanged T3 license", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const result = yield* stageNativeNotices(f.input);
        assert.equal(result.collectionStatus, "collected");
        for (const [file, bytes] of Object.entries(payloads)) {
          assert.equal(yield* f.fs.readFileString(f.path.join(f.destinationDir, file)), bytes);
        }
        assert.equal(
          yield* f.fs.readFileString(f.path.join(f.destinationDir, "manifest.json")),
          yield* f.fs.readFileString(f.manifestPath),
        );
        assert.equal(yield* f.fs.readFileString(f.input.t3LicensePath), license);
      }),
    ),
  );

  for (const artifactPurpose of [undefined, "release"] as const) {
    it.effect(`refuses an incomplete collection for ${artifactPurpose ?? "default release"}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.writeManifest({ ...f.manifest, collectionStatus: "incomplete" });
          yield* assertRejected(f, "incomplete", artifactPurpose);
        }),
      ),
    );
  }

  it.effect(
    "preserves incomplete status and exact missing-input inventory for internal validation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const inventory =
            '{"missing":[{"package":"example@1.0.0","reason":"First-party text unavailable"}]}\r\n';
          yield* f.fs.writeFileString(f.path.join(f.bundleDir, "inventory.json"), inventory);
          yield* f.writeManifest({
            ...f.manifest,
            collectionStatus: "incomplete",
            files: { ...f.manifest.files, "inventory.json": hash(inventory) },
          });
          const originalManifest = yield* f.fs.readFileString(f.manifestPath);
          const result = yield* stageNativeNotices({
            ...f.input,
            artifactPurpose: "internal-validation",
          });
          assert.equal(result.collectionStatus, "incomplete");
          assert.equal(
            yield* f.fs.readFileString(f.path.join(f.destinationDir, "manifest.json")),
            originalManifest,
          );
          assert.equal(
            yield* f.fs.readFileString(f.path.join(f.destinationDir, "inventory.json")),
            inventory,
          );
          assert.equal(yield* f.fs.readFileString(f.manifestPath), originalManifest);
          for (const [file, bytes] of Object.entries(payloads)) {
            if (file !== "inventory.json") {
              assert.equal(yield* f.fs.readFileString(f.path.join(f.destinationDir, file)), bytes);
            }
          }
        }),
      ),
  );

  for (const artifactPurpose of ["future-purpose", null]) {
    it.effect(`rejects unknown runtime artifact purpose ${String(artifactPurpose)}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          // Untyped callers can supply values outside the exported TypeScript union.
          Object.defineProperty(f.input, "artifactPurpose", { value: artifactPurpose });
          yield* assertRejected(f, "Invalid artifact purpose");
        }),
      ),
    );
  }

  for (const artifactPurpose of ["release", "internal-validation"] as const) {
    for (const fault of ["malformed", "target", "binary", "hash", "path", "symlink"] as const) {
      it.effect(`rejects ${fault} incomplete bundles during ${artifactPurpose}`, () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            const manifest = { ...f.manifest, collectionStatus: "incomplete" };
            let reason: string;
            switch (fault) {
              case "malformed":
                yield* f.fs.writeFileString(f.manifestPath, "not JSON");
                reason = "Invalid manifest.json";
                break;
              case "target":
                yield* f.writeManifest({
                  ...manifest,
                  target: { platform: "linux", arch: "aarch64" },
                });
                reason = "target differs";
                break;
              case "binary":
                yield* f.writeManifest(manifest);
                yield* f.fs.writeFileString(
                  f.input.resourceMonitor.binaryPath,
                  "Different binary\n",
                );
                reason = "Resource monitor binary or Cargo.lock differs";
                break;
              case "hash":
                yield* f.writeManifest(manifest);
                yield* f.fs.writeFileString(
                  f.path.join(f.bundleDir, "inventory.json"),
                  "changed inventory",
                );
                reason = "Notice file differs";
                break;
              case "path":
                yield* f.writeManifest({
                  ...manifest,
                  files: { ...manifest.files, "../outside": hash("outside") },
                });
                reason = "safe relative paths";
                break;
              case "symlink": {
                yield* f.writeManifest(manifest);
                const notice = f.path.join(f.bundleDir, "T3-LICENSE");
                yield* f.fs.remove(notice);
                yield* f.fs.symlink(f.input.t3LicensePath, notice);
                reason = "only regular files and directories";
                break;
              }
            }
            yield* assertRejected(f, reason, artifactPurpose);
          }),
        ),
      );
    }
  }

  it.effect("rejects malformed binding metadata", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.writeManifest({
          ...f.manifest,
          bindings: { ...f.manifest.bindings, selectionSha256: "invalid" },
        });
        yield* assertRejected(f, "Invalid manifest.json");
      }),
    ),
  );

  for (const target of [
    { platform: "linux", arch: "aarch64" },
    { platform: "macos", arch: "x86_64" },
  ]) {
    it.effect(`rejects the wrong ${target.platform}/${target.arch} target`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.writeManifest({ ...f.manifest, target });
          yield* assertRejected(f, "target differs");
        }),
      ),
    );
  }

  for (const field of ["cargoLockSha256", "binarySha256"] as const) {
    it.effect(`rejects a gateway ${field} mismatch even when the target is unchanged`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.writeManifest({
            ...f.manifest,
            bindings: {
              ...f.manifest.bindings,
              gateway: { ...f.manifest.bindings.gateway, [field]: hash("different") },
            },
          });
          yield* assertRejected(f, "Gateway binary or Cargo.lock differs");
        }),
      ),
    );
  }

  for (const field of ["cargoLockPath", "binaryPath"] as const) {
    it.effect(`hashes the actual staged monitor ${field}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.fs.writeFileString(f.input.resourceMonitor[field], "changed bytes\n");
          yield* assertRejected(f, "Resource monitor binary or Cargo.lock differs");
        }),
      ),
    );
  }

  it.effect("rejects a stale runtime and notice pair after the source gateway lock changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.writeFileString(f.input.gateway.cargoLockPath, "upgraded source lock\n");
        yield* assertRejected(f, "Current gateway Cargo.lock differs from the provisioned runtime");
      }),
    ),
  );

  it.effect("requires the current gateway lock to exist as a regular file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.remove(f.input.gateway.cargoLockPath);
        yield* assertRejected(f, "Cannot read regular input");
      }),
    ),
  );

  it.effect("rejects replacement of the repository license", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.writeFileString(f.input.t3LicensePath, "Replacement copyright\n");
        yield* assertRejected(f, "Repository LICENSE differs");
      }),
    ),
  );

  it.effect("requires the shipped selection to match its separately recorded identity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.writeManifest({
          ...f.manifest,
          bindings: { ...f.manifest.bindings, selectionSha256: hash("another selection") },
        });
        yield* assertRejected(f, "Selection or T3 license file is not bound");
      }),
    ),
  );

  for (const file of ["manifest.json", "notices/example-1.0.0/LICENSE-MIT"]) {
    it.effect(`rejects missing ${file}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.fs.remove(f.path.join(f.bundleDir, file));
          yield* assertRejected(
            f,
            file === "manifest.json" ? "Cannot read regular input" : "missing or unlisted files",
          );
        }),
      ),
    );
  }

  it.effect("does not copy a changed notice even when every other notice is valid", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.writeFileString(
          f.path.join(f.bundleDir, "notices/example-1.0.0/LICENSE-MIT"),
          "altered notice",
        );
        yield* assertRejected(f, "Notice file differs");
      }),
    ),
  );

  it.effect("refuses an unlisted file rather than carrying extra local content into the app", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.writeFileString(
          f.path.join(f.bundleDir, ".env"),
          "SYNTHETIC_TEST_ONLY=value\n",
        );
        yield* assertRejected(f, "missing or unlisted files");
      }),
    ),
  );

  for (const invalidPath of ["../outside.txt", "/absolute.txt", "notices\\outside.txt"]) {
    it.effect(`rejects an unsafe declared path ${invalidPath}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.writeManifest({
            ...f.manifest,
            files: { ...f.manifest.files, [invalidPath]: hash("unsafe") },
          });
          yield* assertRejected(f, "safe relative paths");
        }),
      ),
    );
  }

  it.effect("rejects case-colliding paths before writing to a Mac staging directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.writeManifest({
          ...f.manifest,
          files: { ...f.manifest.files, "t3-license": hash(license) },
        });
        yield* assertRejected(f, "distinct, safe relative paths");
      }),
    ),
  );

  for (const linked of ["T3-LICENSE", "notices"] as const) {
    it.effect(`rejects a symlinked ${linked} input`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const source = f.path.join(f.bundleDir, linked);
          const moved = f.path.join(f.root, `moved-${linked}`);
          yield* f.fs.rename(source, moved);
          yield* f.fs.symlink(moved, source);
          yield* assertRejected(f, "only regular files and directories");
        }),
      ),
    );
  }

  it.effect("does not overwrite an existing staging directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.makeDirectory(f.destinationDir);
        const prior = f.path.join(f.destinationDir, "keep.txt");
        yield* f.fs.writeFileString(prior, "existing stage\n");
        const error = yield* stageNativeNotices(f.input).pipe(Effect.flip);
        assert.include(error.reason, "fresh staging directory");
        assert.deepStrictEqual(yield* f.fs.readDirectory(f.destinationDir), ["keep.txt"]);
        assert.equal(yield* f.fs.readFileString(prior), "existing stage\n");
      }),
    ),
  );
});

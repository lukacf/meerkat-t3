// @effect-diagnostics nodeBuiltinImport:off - Native notice staging owns exact filesystem bytes and hashes.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const BinaryBinding = Schema.Struct({ cargoLockSha256: Digest, binarySha256: Digest });
export const NativeNoticeArtifactPurpose = Schema.Literals(["release", "internal-validation"]);
export type NativeNoticeArtifactPurpose = typeof NativeNoticeArtifactPurpose.Type;
const decodeArtifactPurpose = Schema.decodeUnknownEffect(NativeNoticeArtifactPurpose);
export const NativeNoticeManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  target: Schema.Struct({
    platform: Schema.Literals(["macos", "linux", "windows"]),
    arch: Schema.Literals(["aarch64", "x86_64"]),
  }),
  collectionStatus: Schema.Literals(["incomplete", "collected"]),
  bindings: Schema.Struct({
    gateway: BinaryBinding,
    resourceMonitor: BinaryBinding,
    selectionSha256: Digest,
    t3LicenseSha256: Digest,
  }),
  files: Schema.Record(Schema.String, Digest),
});
const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(NativeNoticeManifest));
const REQUIRED_FILES = ["inventory.json", "README.txt", "selection.json", "T3-LICENSE"] as const;

export class NativeNoticeBundleError extends Schema.TaggedError<NativeNoticeBundleError>()(
  "NativeNoticeBundleError",
  { bundleDir: Schema.String, reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Native notice bundle at ${this.bundleDir} cannot be packaged: ${this.reason}. Collect notices for the exact native binaries and locks before packaging.`;
  }
}

function digest(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function safeRelativePath(value: string): boolean {
  return (
    value.normalize("NFC").toLowerCase() !== "manifest.json" &&
    !/[\\:\p{Cc}]/u.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

async function readRegularFile(file: string): Promise<Uint8Array> {
  const handle = await NodeFSP.open(
    file,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Not a regular file: ${file}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function regularFiles(directory: string, relative = ""): Promise<string[]> {
  if (!(await NodeFSP.lstat(NodePath.join(directory, relative))).isDirectory()) {
    throw new Error(`Not a regular directory: ${relative || directory}`);
  }
  const files: string[] = [];
  for (const entry of await NodeFSP.readdir(NodePath.join(directory, relative))) {
    const child = relative ? `${relative}/${entry}` : entry;
    const info = await NodeFSP.lstat(NodePath.join(directory, child));
    if (info.isDirectory()) files.push(...(await regularFiles(directory, child)));
    else if (info.isFile()) files.push(child);
    else throw new Error(`Native notice bundle contains a non-regular entry: ${child}`);
  }
  return files.sort();
}

export const stageNativeNotices = Effect.fn("stageNativeNotices")(function* (input: {
  readonly artifactPurpose?: NativeNoticeArtifactPurpose;
  readonly bundleDir: string;
  readonly destinationDir: string;
  readonly target: { readonly platform: string; readonly arch: string };
  readonly gateway: {
    readonly cargoLockPath: string;
    readonly cargoLockSha256: string;
    readonly binarySha256: string;
  };
  readonly resourceMonitor: { readonly cargoLockPath: string; readonly binaryPath: string };
  readonly t3LicensePath: string;
}) {
  const failure = (reason: string, cause?: unknown) =>
    new NativeNoticeBundleError({
      bundleDir: input.bundleDir,
      reason,
      ...(cause === undefined ? {} : { cause }),
    });
  const artifactPurpose = yield* decodeArtifactPurpose(
    input.artifactPurpose === undefined ? "release" : input.artifactPurpose,
  ).pipe(Effect.mapError((cause) => failure("Invalid artifact purpose", cause)));
  const read = (file: string) =>
    Effect.tryPromise({
      try: () => readRegularFile(file),
      catch: (cause) => failure(`Cannot read regular input ${file}`, cause),
    });

  const actualFiles = yield* Effect.tryPromise({
    try: () => regularFiles(input.bundleDir),
    catch: (cause) => failure("Bundle must contain only regular files and directories", cause),
  });
  const manifestBytes = yield* read(NodePath.join(input.bundleDir, "manifest.json"));
  const manifest = yield* decodeManifest(new TextDecoder().decode(manifestBytes)).pipe(
    Effect.mapError((cause) => failure("Invalid manifest.json", cause)),
  );
  if (
    manifest.target.platform !== input.target.platform ||
    manifest.target.arch !== input.target.arch
  ) {
    return yield* failure("Bundle target differs from the packaged native target");
  }
  if (
    manifest.bindings.gateway.cargoLockSha256 !== input.gateway.cargoLockSha256 ||
    manifest.bindings.gateway.binarySha256 !== input.gateway.binarySha256
  ) {
    return yield* failure("Gateway binary or Cargo.lock differs from the notice selection");
  }
  const gatewayLock = yield* read(input.gateway.cargoLockPath);
  if (digest(gatewayLock) !== input.gateway.cargoLockSha256) {
    return yield* failure("Current gateway Cargo.lock differs from the provisioned runtime");
  }
  const monitorLock = yield* read(input.resourceMonitor.cargoLockPath);
  const monitorBinary = yield* read(input.resourceMonitor.binaryPath);
  if (
    digest(monitorLock) !== manifest.bindings.resourceMonitor.cargoLockSha256 ||
    digest(monitorBinary) !== manifest.bindings.resourceMonitor.binarySha256
  ) {
    return yield* failure(
      "Resource monitor binary or Cargo.lock differs from the notice selection",
    );
  }
  const t3License = yield* read(input.t3LicensePath);
  if (digest(t3License) !== manifest.bindings.t3LicenseSha256) {
    return yield* failure("Repository LICENSE differs from the collected T3 license");
  }

  const paths = Object.keys(manifest.files).sort();
  const normalizedPaths = new Set(paths.map((file) => file.normalize("NFC").toLowerCase()));
  if (paths.some((file) => !safeRelativePath(file)) || normalizedPaths.size !== paths.length) {
    return yield* failure("Notice paths must be distinct, safe relative paths");
  }
  if (REQUIRED_FILES.some((file) => manifest.files[file] === undefined)) {
    return yield* failure("Bundle is missing inventory, README, selection, or T3 license");
  }
  const declaredFiles = [...paths, "manifest.json"].sort();
  if (
    actualFiles.length !== declaredFiles.length ||
    actualFiles.some((file, index) => file !== declaredFiles[index])
  ) {
    return yield* failure("Bundle contains missing or unlisted files");
  }
  if (
    manifest.files["selection.json"] !== manifest.bindings.selectionSha256 ||
    manifest.files["T3-LICENSE"] !== manifest.bindings.t3LicenseSha256
  ) {
    return yield* failure("Selection or T3 license file is not bound to its recorded digest");
  }

  // Copy the bytes we validated, not a later recursive read of the source tree.
  const payloads = new Map<string, Uint8Array>([["manifest.json", manifestBytes]]);
  for (const file of paths) {
    const bytes = yield* read(NodePath.join(input.bundleDir, file));
    if (digest(bytes) !== manifest.files[file]) {
      return yield* failure(`Notice file differs from its manifest: ${file}`);
    }
    payloads.set(file, bytes);
  }
  if (manifest.collectionStatus !== "collected" && artifactPurpose === "release") {
    return yield* failure("Selected native notice inputs are incomplete; inspect inventory.json");
  }
  yield* Effect.tryPromise({
    try: async () => {
      await NodeFSP.mkdir(input.destinationDir);
      for (const [file, bytes] of payloads) {
        const destination = NodePath.join(input.destinationDir, file);
        await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
        await NodeFSP.writeFile(destination, bytes, { flag: "wx", mode: 0o644 });
      }
    },
    catch: (cause) =>
      failure("Cannot write the verified bundle to a fresh staging directory", cause),
  });
  return manifest;
});

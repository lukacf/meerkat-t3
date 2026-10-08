// @effect-diagnostics nodeBuiltinImport:off - Release input staging owns exact filesystem bytes before packaging.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Schema from "effect/Schema";

export const NATIVE_INPUT_MANIFEST = "meerkat-mac-native-inputs.json";
export const RUNTIME_DIRECTORY = "apps/server/resources/meerkat-runtime";
export const NOTICE_DIRECTORY = "apps/server/resources/native-notices";
export const GATEWAY_PATH = `${RUNTIME_DIRECTORY}/meerkat-desktop-stdio`;
export const MONITOR_PATH =
  "native/resource-monitor/target/aarch64-apple-darwin/release/t3-resource-monitor";
const RUNTIME_FILES = [
  `${RUNTIME_DIRECTORY}/manifest.json`,
  GATEWAY_PATH,
  `${RUNTIME_DIRECTORY}/meerkat-project-agent-proposal-mcp.mjs`,
  `${RUNTIME_DIRECTORY}/meerkat-project-agent-proposal-contract.mjs`,
  `${RUNTIME_DIRECTORY}/meerkat-project-agent-proposal-schema.json`,
] as const;
const REQUIRED_FILES = [
  ...RUNTIME_FILES,
  MONITOR_PATH,
  ...["manifest.json", "inventory.json", "selection.json", "T3-LICENSE", "README.txt"].map(
    (name) => `${NOTICE_DIRECTORY}/${name}`,
  ),
];
const digest = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

// The prepared artifact contains this manifest and only its declared regular
// files, at their repository-relative paths. Its expected hash is supplied by
// the caller independently of the artifact. Existing packager checks remain
// authoritative for runtime compatibility and notice completeness.
const BundleManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  target: Schema.Struct({ platform: Schema.Literal("macos"), arch: Schema.Literal("aarch64") }),
  files: Schema.Record(Schema.String, Digest),
});
const ArtifactMetadata = Schema.Struct({
  id: Schema.Int,
  expired: Schema.Literal(false),
  workflow_run: Schema.Struct({
    id: Schema.Int,
    repository_id: Schema.Int,
    head_repository_id: Schema.Int,
  }),
});
const decodeManifest = Schema.decodeSync(Schema.fromJsonString(BundleManifest));
const decodeArtifact = Schema.decodeSync(Schema.fromJsonString(ArtifactMetadata));
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function positiveId(value: string): number {
  const id = Number(value);
  if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(id)) {
    throw new Error("Artifact, run and repository IDs must be exact positive integers.");
  }
  return id;
}

function allowedPath(file: string): boolean {
  if (
    /[\\:\p{Cc}]/u.test(file) ||
    file.normalize("NFC") !== file ||
    file.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    return false;
  return (
    RUNTIME_FILES.some((allowed) => allowed === file) ||
    file === MONITOR_PATH ||
    file.startsWith(`${NOTICE_DIRECTORY}/`)
  );
}

async function readRegularFile(file: string): Promise<Buffer> {
  const handle = await NodeFSP.open(
    file,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Expected regular file: ${file}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function filesIn(directory: string, relative = ""): Promise<string[]> {
  if (!(await NodeFSP.lstat(NodePath.join(directory, relative))).isDirectory()) {
    throw new Error(`Expected regular directory: ${relative || directory}`);
  }
  const files: string[] = [];
  for (const entry of await NodeFSP.readdir(NodePath.join(directory, relative))) {
    const child = relative ? `${relative}/${entry}` : entry;
    const stat = await NodeFSP.lstat(NodePath.join(directory, child));
    if (stat.isDirectory()) files.push(...(await filesIn(directory, child)));
    else if (stat.isFile()) files.push(child);
    else throw new Error(`Native inputs contain a non-regular entry: ${child}`);
  }
  return files.sort();
}

async function validateDestination(repoRoot: string, relative: string): Promise<void> {
  const parts = relative.split("/");
  for (let length = 0; length <= parts.length; length++) {
    const path = NodePath.join(repoRoot, ...parts.slice(0, length));
    const stat = await NodeFSP.lstat(path).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) continue;
    if (length === parts.length)
      throw new Error(`Native input destination already exists: ${relative}`);
    if (!stat.isDirectory())
      throw new Error(`Native input destination parent is not a regular directory: ${path}`);
  }
}

export async function stageMeerkatMacNativeInputs(input: {
  readonly bundleDir: string;
  readonly repoRoot: string;
  readonly expectedManifestSha256: string;
  readonly artifactMetadataPath: string;
  readonly artifactId: string;
  readonly runId: string;
  readonly repositoryId: string;
}) {
  const artifactId = positiveId(input.artifactId);
  const runId = positiveId(input.runId);
  const repositoryId = positiveId(input.repositoryId);
  if (!/^[a-f0-9]{64}$/u.test(input.expectedManifestSha256)) {
    throw new Error("Expected native input manifest SHA256 must be 64 lowercase hex characters.");
  }
  const artifact = decodeArtifact(
    (await readRegularFile(input.artifactMetadataPath)).toString("utf8"),
  );
  if (
    artifact.id !== artifactId ||
    artifact.workflow_run.id !== runId ||
    artifact.workflow_run.repository_id !== repositoryId ||
    artifact.workflow_run.head_repository_id !== repositoryId
  )
    throw new Error(
      "Native input artifact must match the exact run and current repository, including its source repository.",
    );

  const actualFiles = await filesIn(input.bundleDir);
  const manifestBytes = await readRegularFile(
    NodePath.join(input.bundleDir, NATIVE_INPUT_MANIFEST),
  );
  if (digest(manifestBytes) !== input.expectedManifestSha256) {
    throw new Error("Native input manifest SHA256 differs from the caller's expected identity.");
  }
  const manifest = decodeManifest(manifestBytes.toString("utf8"));
  const paths = Object.keys(manifest.files).sort();
  if (
    paths.some((file) => !allowedPath(file)) ||
    new Set(paths.map((file) => file.toLowerCase())).size !== paths.length
  ) {
    throw new Error("Native input manifest must contain distinct allowlisted paths only.");
  }
  if (REQUIRED_FILES.some((file) => manifest.files[file] === undefined)) {
    throw new Error(
      "Native input manifest is missing required runtime, notice or resource-monitor files.",
    );
  }
  const expectedFiles = [...paths, NATIVE_INPUT_MANIFEST].sort();
  if (
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some((file, i) => file !== expectedFiles[i])
  ) {
    throw new Error("Native inputs contain missing or undeclared files.");
  }
  const payloads = new Map<string, Buffer>();
  for (const file of paths) {
    const bytes = await readRegularFile(NodePath.join(input.bundleDir, file));
    if (digest(bytes) !== manifest.files[file])
      throw new Error(`Native input SHA256 mismatch: ${file}`);
    payloads.set(file, bytes);
  }
  for (const destination of [RUNTIME_DIRECTORY, NOTICE_DIRECTORY, MONITOR_PATH]) {
    await validateDestination(input.repoRoot, destination);
  }
  // Copy only the buffers validated above. No scripts, package manifests or
  // configuration from the downloaded artifact can overwrite the checkout.
  for (const [file, bytes] of payloads) {
    const destination = NodePath.join(input.repoRoot, file);
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFSP.writeFile(destination, bytes, { flag: "wx", mode: 0o644 });
  }
  for (const file of [GATEWAY_PATH, MONITOR_PATH])
    await NodeFSP.chmod(NodePath.join(input.repoRoot, file), 0o755);
  return {
    artifactId,
    runId,
    repositoryId,
    manifestSha256: input.expectedManifestSha256,
    files: paths,
  };
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const names = new Set([
    "bundle-dir",
    "repo-root",
    "manifest-sha256",
    "artifact-metadata",
    "artifact-id",
    "run-id",
    "repository-id",
  ]);
  const values = new Map<string, string>();
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.replace(/^--/u, "");
    const value = args[index + 1];
    if (!name || !names.has(name) || values.has(name) || !value || !args[index]?.startsWith("--")) {
      throw new Error(
        "Expected each documented native-input option exactly once, followed by its value.",
      );
    }
    values.set(name, value);
  }
  const required = (name: string) => {
    const value = values.get(name);
    if (!value) throw new Error(`Missing --${name}.`);
    return value;
  };
  const receipt = await stageMeerkatMacNativeInputs({
    bundleDir: required("bundle-dir"),
    repoRoot: required("repo-root"),
    expectedManifestSha256: required("manifest-sha256"),
    artifactMetadataPath: required("artifact-metadata"),
    artifactId: required("artifact-id"),
    runId: required("run-id"),
    repositoryId: required("repository-id"),
  });
  process.stdout.write(`${encodeReceipt(receipt)}\n`);
}

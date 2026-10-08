// @effect-diagnostics nodeBuiltinImport:off - These tests stage harmless native-input fixtures in private temporary directories.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { test, type TestContext } from "vite-plus/test";

import * as Schema from "effect/Schema";

import {
  GATEWAY_PATH,
  MONITOR_PATH,
  NATIVE_INPUT_MANIFEST,
  NOTICE_DIRECTORY,
  RUNTIME_DIRECTORY,
  stageMeerkatMacNativeInputs,
} from "./meerkat-mac-native-inputs.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const digest = (bytes: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

async function fixture(t: TestContext) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "meerkat-mac-native-test-"));
  t.onTestFinished(() => NodeFSP.rm(root, { recursive: true, force: true }));
  const bundleDir = NodePath.join(root, "bundle");
  const repoRoot = NodePath.join(root, "checkout");
  await NodeFSP.mkdir(repoRoot);
  await NodeFSP.writeFile(NodePath.join(repoRoot, "package.json"), "current source identity\n");
  const files: Record<string, string> = {};
  const payloads = new Map([
    [`${RUNTIME_DIRECTORY}/manifest.json`, '{"format":1}\n'],
    [GATEWAY_PATH, "synthetic gateway, never executed\n"],
    [`${RUNTIME_DIRECTORY}/meerkat-project-agent-proposal-mcp.mjs`, "export {};\n"],
    [`${RUNTIME_DIRECTORY}/meerkat-project-agent-proposal-contract.mjs`, "export {};\n"],
    [`${RUNTIME_DIRECTORY}/meerkat-project-agent-proposal-schema.json`, "{}\n"],
    [MONITOR_PATH, "synthetic monitor, never executed\n"],
    [`${NOTICE_DIRECTORY}/manifest.json`, '{"collectionStatus":"incomplete"}\n'],
    [`${NOTICE_DIRECTORY}/inventory.json`, '{"missing":["retained"]}\n'],
    [`${NOTICE_DIRECTORY}/selection.json`, "{}\n"],
    [`${NOTICE_DIRECTORY}/T3-LICENSE`, "Original T3 notice\r\n"],
    [`${NOTICE_DIRECTORY}/README.txt`, "Prepared notice inventory\n"],
    [`${NOTICE_DIRECTORY}/registry/example/LICENSE`, "Exact nested notice\r\n"],
  ]);
  for (const [file, contents] of payloads) {
    const path = NodePath.join(bundleDir, file);
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, contents, { mode: 0o755 });
    files[file] = digest(contents);
  }
  const manifest = { schemaVersion: 1, target: { platform: "macos", arch: "aarch64" }, files };
  const artifact = {
    id: 123,
    expired: false,
    workflow_run: { id: 456, repository_id: 789, head_repository_id: 789 },
  };
  const artifactMetadataPath = NodePath.join(root, "artifact.json");
  const input = {
    bundleDir,
    repoRoot,
    artifactMetadataPath,
    expectedManifestSha256: "",
    artifactId: "123",
    runId: "456",
    repositoryId: "789",
  };
  const writeManifest = async () => {
    const bytes = `${encodeJson(manifest)}\n`;
    await NodeFSP.writeFile(NodePath.join(bundleDir, NATIVE_INPUT_MANIFEST), bytes);
    input.expectedManifestSha256 = digest(bytes);
  };
  const writeArtifact = () => NodeFSP.writeFile(artifactMetadataPath, encodeJson(artifact));
  await writeManifest();
  await writeArtifact();
  return {
    root,
    bundleDir,
    repoRoot,
    payloads,
    manifest,
    artifact,
    input,
    writeManifest,
    writeArtifact,
  };
}

async function rejectsWithoutStaging(f: Awaited<ReturnType<typeof fixture>>, pattern?: RegExp) {
  if (pattern) await NodeAssert.rejects(stageMeerkatMacNativeInputs(f.input), pattern);
  else await NodeAssert.rejects(stageMeerkatMacNativeInputs(f.input));
  NodeAssert.deepEqual(await NodeFSP.readdir(f.repoRoot), ["package.json"]);
  NodeAssert.equal(
    await NodeFSP.readFile(NodePath.join(f.repoRoot, "package.json"), "utf8"),
    "current source identity\n",
  );
}

test("stages exact declared bytes and sets executable mode only on gateway and monitor", async (t) => {
  const f = await fixture(t);
  const receipt = await stageMeerkatMacNativeInputs(f.input);
  NodeAssert.equal(receipt.manifestSha256, f.input.expectedManifestSha256);
  NodeAssert.equal(receipt.artifactId, 123);
  NodeAssert.equal(receipt.runId, 456);
  NodeAssert.deepEqual(receipt.files, [...f.payloads.keys()].sort());
  for (const [file, contents] of f.payloads) {
    const target = NodePath.join(f.repoRoot, file);
    NodeAssert.equal(await NodeFSP.readFile(target, "utf8"), contents);
    NodeAssert.equal(
      (await NodeFSP.stat(target)).mode & 0o111,
      file === GATEWAY_PATH || file === MONITOR_PATH ? 0o111 : 0,
    );
  }
  NodeAssert.equal(
    await NodeFSP.readFile(NodePath.join(f.repoRoot, "package.json"), "utf8"),
    "current source identity\n",
  );
  await NodeAssert.rejects(NodeFSP.stat(NodePath.join(f.repoRoot, NATIVE_INPUT_MANIFEST)), {
    code: "ENOENT",
  });
});

test("rejects a self-consistent bundle with an unapproved manifest digest", async (t) => {
  const f = await fixture(t);
  f.input.expectedManifestSha256 = "0".repeat(64);
  await rejectsWithoutStaging(f, /manifest SHA256 differs/);
});

test("rejects changed payload bytes before writing any destination", async (t) => {
  const f = await fixture(t);
  await NodeFSP.writeFile(NodePath.join(f.bundleDir, MONITOR_PATH), "different monitor");
  await rejectsWithoutStaging(f, /SHA256 mismatch/);
});

for (const field of ["id", "run", "repository", "headRepository"] as const) {
  test(`rejects artifact ${field} mismatch`, async (t) => {
    const f = await fixture(t);
    if (field === "id") f.artifact.id = 999;
    if (field === "run") f.artifact.workflow_run.id = 999;
    if (field === "repository") f.artifact.workflow_run.repository_id = 999;
    if (field === "headRepository") f.artifact.workflow_run.head_repository_id = 999;
    await f.writeArtifact();
    await rejectsWithoutStaging(f, /exact run and current repository/);
  });
}

test("rejects expired artifacts", async (t) => {
  const f = await fixture(t);
  f.artifact.expired = true;
  await f.writeArtifact();
  await rejectsWithoutStaging(f);
});

test("rejects malformed or imprecise input IDs before staging", async (t) => {
  const f = await fixture(t);
  for (const id of ["123/path", "1e3", "01", "9007199254740992", "0"]) {
    f.input.artifactId = id;
    await rejectsWithoutStaging(f, /exact positive integers/);
  }
});

test("rejects wrong targets even with the caller's matching manifest hash", async (t) => {
  const f = await fixture(t);
  f.manifest.target.arch = "x86_64";
  await f.writeManifest();
  await rejectsWithoutStaging(f);
});

for (const path of [
  "scripts/build-meerkat-mac.ts",
  `${NOTICE_DIRECTORY}/../package.json`,
  `${NOTICE_DIRECTORY}/a\\b`,
  `${NOTICE_DIRECTORY}//empty`,
]) {
  test(`rejects disallowed declared path ${path}`, async (t) => {
    const f = await fixture(t);
    f.manifest.files[path] = digest("not allowed");
    await f.writeManifest();
    await rejectsWithoutStaging(f, /distinct allowlisted paths/);
  });
}

test("rejects case-colliding notice paths on the Mac target", async (t) => {
  const f = await fixture(t);
  f.manifest.files[`${NOTICE_DIRECTORY}/README.TXT`] = digest("collision");
  await f.writeManifest();
  await rejectsWithoutStaging(f, /distinct allowlisted paths/);
});

test("rejects missing required inputs and undeclared files", async (t) => {
  const f = await fixture(t);
  delete f.manifest.files[MONITOR_PATH];
  await f.writeManifest();
  await rejectsWithoutStaging(f, /missing required/);
  f.manifest.files[MONITOR_PATH] = digest(f.payloads.get(MONITOR_PATH)!);
  await f.writeManifest();
  await NodeFSP.writeFile(NodePath.join(f.bundleDir, "unexpected.txt"), "extra");
  await rejectsWithoutStaging(f, /undeclared files/);
});

test("rejects missing declared payloads", async (t) => {
  const f = await fixture(t);
  await NodeFSP.unlink(NodePath.join(f.bundleDir, MONITOR_PATH));
  await rejectsWithoutStaging(f, /missing or undeclared/);
});

test("rejects downloaded file and directory symlinks", async (t) => {
  const f = await fixture(t);
  const gateway = NodePath.join(f.bundleDir, GATEWAY_PATH);
  await NodeFSP.unlink(gateway);
  await NodeFSP.symlink(NodePath.join(f.repoRoot, "package.json"), gateway);
  await rejectsWithoutStaging(f, /non-regular entry/);
  await NodeFSP.unlink(gateway);
  await NodeFSP.writeFile(gateway, f.payloads.get(GATEWAY_PATH)!);
  await NodeFSP.symlink(f.repoRoot, NodePath.join(f.bundleDir, "linked-directory"));
  await rejectsWithoutStaging(f, /non-regular entry/);
});

test("refuses existing native destinations without changing them", async (t) => {
  const f = await fixture(t);
  const existing = NodePath.join(f.repoRoot, RUNTIME_DIRECTORY);
  await NodeFSP.mkdir(existing, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(existing, "keep.txt"), "existing payload");
  await NodeAssert.rejects(stageMeerkatMacNativeInputs(f.input), /destination already exists/);
  NodeAssert.equal(
    await NodeFSP.readFile(NodePath.join(existing, "keep.txt"), "utf8"),
    "existing payload",
  );
  await NodeAssert.rejects(NodeFSP.stat(NodePath.join(f.repoRoot, NOTICE_DIRECTORY)), {
    code: "ENOENT",
  });
});

test("refuses symlinked destination parents instead of writing outside the checkout", async (t) => {
  const f = await fixture(t);
  const outside = NodePath.join(f.root, "outside");
  await NodeFSP.mkdir(outside);
  await NodeFSP.symlink(outside, NodePath.join(f.repoRoot, "apps"));
  await NodeAssert.rejects(
    stageMeerkatMacNativeInputs(f.input),
    /parent is not a regular directory/,
  );
  NodeAssert.deepEqual(await NodeFSP.readdir(outside), []);
});

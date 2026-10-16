import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import * as Effect from "effect/Effect";
import { collectNativeNotices, readCrate, sha256 } from "./collect-native-license-notices.mjs";
import { stageNativeNotices } from "./lib/native-notices.ts";

function archive(files) {
  const blocks = [];
  for (const [name, content, type = "0"] of files) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.fill(32, 148, 156);
    header.write(type, 156);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return NodeZlib.gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

NodeTest.test(
  "reads nested notice bytes and rejects mismatched archive provenance or escaping paths",
  () => {
    const bytes = archive([
      ["demo-1.0.0/vendor/LICENSE", "Original notice\r\n"],
      ["demo-1.0.0/Cargo.toml", '[package]\nlicense = "MIT"\n'],
    ]);
    const entries = readCrate(bytes, sha256(bytes), "demo-1.0.0");
    NodeAssert.deepEqual(entries.get("vendor/LICENSE").data, Buffer.from("Original notice\r\n"));
    NodeAssert.throws(() => readCrate(bytes, "0".repeat(64), "demo-1.0.0"), /checksum mismatch/);
    const escaping = archive([["demo-1.0.0/../LICENSE", "bad"]]);
    NodeAssert.throws(
      () => readCrate(escaping, sha256(escaping), "demo-1.0.0"),
      /Unsafe relative path/,
    );
  },
);

async function readBundle(options) {
  const read = (name) => NodeFSP.readFile(NodePath.join(options.output, name), "utf8");
  return {
    manifest: JSON.parse(await read("manifest.json")),
    inventory: JSON.parse(await read("inventory.json")),
    selection: JSON.parse(await read("selection.json")),
    texts: await Promise.all(
      ["manifest.json", "inventory.json", "selection.json", "README.txt"].map(read),
    ),
  };
}

function stageInput(options, manifest, destinationDir, selection) {
  return {
    bundleDir: options.output,
    destinationDir,
    target: manifest.target,
    gateway: manifest.bindings.gateway,
    resourceMonitor: {
      cargoLockPath: selection.products.resourceMonitor.lock.path,
      binaryPath: selection.products.resourceMonitor.root.binary,
    },
    t3LicensePath: options.t3License,
  };
}

NodeTest.test(
  "publishes portable provenance, binds both selections, and passes the unchanged packager",
  async (context) => {
    const { root, options, selection, inventory } = await fixture(context);
    const marker = "/Users/SYNTHETIC_PRIVATE_HOME/Library/Caches/private-evidence";
    const sourceManifest = NodePath.join(root, "private-source-manifest.toml");
    const sourceManifestBytes = '[package]\nname = "demo"\nversion = "1.0.0"\n';
    const extra = NodePath.join(root, "private-supplement.txt");
    await NodeFSP.writeFile(sourceManifest, sourceManifestBytes);
    await NodeFSP.writeFile(extra, "Exact supplemental copyright\r\n");
    inventory.packages[0].licenseExpression = "Apache-2.0 / MIT";
    await NodeFSP.writeFile(options.inventory, JSON.stringify(inventory));
    selection.method = `Private capture at ${marker}`;
    selection.provenance = {
      inventory: { path: `${marker}/inventory.json`, sha256: "a".repeat(64) },
    };
    for (const graph of Object.values(selection.products)) {
      graph.profile = "debug";
      graph.root.artifact = `${marker}/deps/private-artifact`;
      graph.lock.currentSource = `${marker}/Cargo.lock`;
      graph.inputs = {
        metadata: { path: `${marker}/metadata.json`, sha256: "b".repeat(64), bytes: 10 },
      };
      graph.unitGraph = { path: `${marker}/units.json`, sha256: "c".repeat(64), bytes: 20 };
      graph.selectedRegistryPackages[0].units = [`${marker}/fingerprint.json`];
    }
    await NodeFSP.writeFile(options.selection, JSON.stringify(selection));
    options.supplements = NodePath.join(root, "private-supplements.json");
    await NodeFSP.writeFile(
      options.supplements,
      JSON.stringify({
        packages: [
          {
            key: "demo@1.0.0",
            checksum: selection.products.gateway.selectedRegistryPackages[0].checksum,
            notices: [
              {
                name: "COPYRIGHT",
                file: extra,
                sha256: sha256("Exact supplemental copyright\r\n"),
                source: {
                  kind: "repository-workspace-license",
                  repositoryPath: "core/LICENSE-MIT",
                  localCachePath: marker,
                  packageManifest: {
                    path: sourceManifest,
                    sha256: sha256(sourceManifestBytes),
                    bytes: Buffer.byteLength(sourceManifestBytes),
                  },
                  declaration: {
                    sourceUrl: "https://example.com/commit/LICENSE",
                    declaredLink: "http://www.apache.org/licenses/LICENSE-2.0",
                    path: "LICENSE",
                    localEvidence: marker,
                  },
                },
              },
            ],
          },
        ],
      }),
    );
    const originalSelection = await NodeFSP.readFile(options.selection);
    await collectNativeNotices(options);
    const bundle = await readBundle(options);
    for (const text of bundle.texts) {
      NodeAssert.ok(!text.includes(marker));
      NodeAssert.ok(!text.includes(root));
      NodeAssert.ok(!text.includes("file://"));
    }
    NodeAssert.equal(bundle.selection.provenance.sourceSelectionSha256, sha256(originalSelection));
    NodeAssert.equal(bundle.manifest.bindings.selectionSha256, sha256(bundle.texts[2]));
    NodeAssert.notEqual(bundle.manifest.bindings.selectionSha256, sha256(originalSelection));
    NodeAssert.equal(
      bundle.selection.products.gateway.root.binarySha256,
      bundle.manifest.bindings.gateway.binarySha256,
    );
    NodeAssert.equal(
      bundle.selection.products.gateway.lock.sha256,
      bundle.manifest.bindings.gateway.cargoLockSha256,
    );
    NodeAssert.deepEqual(await NodeFSP.readFile(options.selection), originalSelection);
    const source = bundle.inventory.packages[0].notices.at(-1).source;
    NodeAssert.deepEqual(source.packageManifest, {
      sha256: sha256(sourceManifestBytes),
      bytes: Buffer.byteLength(sourceManifestBytes),
    });
    NodeAssert.deepEqual(source.declaration, {
      sourceUrl: "https://example.com/commit/LICENSE",
      declaredLink: "http://www.apache.org/licenses/LICENSE-2.0",
      path: "LICENSE",
    });
    await Effect.runPromise(
      stageNativeNotices(
        stageInput(options, bundle.manifest, NodePath.join(root, "staged"), selection),
      ),
    );
  },
);

NodeTest.test(
  "rejects changed private lock and manifest evidence before public collection",
  async (context) => {
    const { options, selection } = await fixture(context);
    await NodeFSP.appendFile(selection.products.gateway.lock.path, "# changed after capture\n");
    await NodeAssert.rejects(collectNativeNotices(options), /Lock binding mismatch/);
    // New collection inputs cannot disguise a workspace notice's stale manifest hash.
    const other = await fixture(context);
    const sourceManifest = NodePath.join(other.root, "manifest.toml");
    const extra = NodePath.join(other.root, "notice.txt");
    await NodeFSP.writeFile(sourceManifest, "changed manifest");
    await NodeFSP.writeFile(extra, "exact notice");
    other.options.supplements = NodePath.join(other.root, "supplements.json");
    await NodeFSP.writeFile(
      other.options.supplements,
      JSON.stringify({
        packages: [
          {
            key: "demo@1.0.0",
            checksum: other.selection.products.gateway.selectedRegistryPackages[0].checksum,
            notices: [
              {
                name: "extra",
                file: extra,
                sha256: sha256("exact notice"),
                source: {
                  kind: "repository-workspace-license",
                  packageManifest: { path: sourceManifest, sha256: sha256("original manifest") },
                },
              },
            ],
          },
        ],
      }),
    );
    await NodeAssert.rejects(
      collectNativeNotices(other.options),
      /Workspace manifest provenance mismatch/,
    );
  },
);

NodeTest.test(
  "unchanged packager rejects altered public selection and native inputs",
  async (context) => {
    const { root, options, selection } = await fixture(context);
    await collectNativeNotices(options);
    const { manifest } = await readBundle(options);
    const input = stageInput(options, manifest, NodePath.join(root, "tampered-staging"), selection);
    await NodeFSP.appendFile(NodePath.join(options.output, "selection.json"), " ");
    await NodeAssert.rejects(
      Effect.runPromise(stageNativeNotices(input)),
      /Notice file differs from its manifest: selection.json/,
    );
    NodeAssert.equal(await NodeFSP.stat(input.destinationDir).catch(() => null), null);
    const other = await fixture(context);
    await collectNativeNotices(other.options);
    const valid = await readBundle(other.options);
    const wrong = stageInput(
      other.options,
      valid.manifest,
      NodePath.join(other.root, "changed-binary-staging"),
      other.selection,
    );
    await NodeFSP.writeFile(wrong.resourceMonitor.binaryPath, "changed after collection");
    await NodeAssert.rejects(
      Effect.runPromise(stageNativeNotices(wrong)),
      /Resource monitor binary or Cargo.lock differs/,
    );
    NodeAssert.equal(await NodeFSP.stat(wrong.destinationDir).catch(() => null), null);
  },
);

NodeTest.test("rejects local paths in recognized public provenance fields", async (context) => {
  for (const source of [
    { kind: "repository-commit", path: "/Users/SYNTHETIC_PRIVATE_HOME/LICENSE" },
    { kind: "repository-commit", sourceUrl: "file:///Users/SYNTHETIC_PRIVATE_HOME/LICENSE" },
    { kind: "repository-commit", attribution: "Copied from /Users/SYNTHETIC_PRIVATE_HOME/LICENSE" },
    { kind: "repository-commit", attribution: "Copied=/Users/SYNTHETIC_PRIVATE_HOME/LICENSE" },
  ]) {
    const { root, options, selection } = await fixture(context);
    const file = NodePath.join(root, "extra");
    await NodeFSP.writeFile(file, "exact notice");
    options.supplements = NodePath.join(root, "supplements.json");
    await NodeFSP.writeFile(
      options.supplements,
      JSON.stringify({
        packages: [
          {
            key: "demo@1.0.0",
            checksum: selection.products.gateway.selectedRegistryPackages[0].checksum,
            notices: [{ name: "extra", file, sha256: sha256("exact notice"), source }],
          },
        ],
      }),
    );
    await NodeAssert.rejects(
      collectNativeNotices(options),
      /Unsafe relative path|public HTTP\(S\)|local filesystem paths/,
    );
  }
});

NodeTest.test("resolves PAX long paths before matching nested notices", () => {
  const longPath = `demo-1.0.0/${"nested/".repeat(20)}LICENSE`;
  const payload = `path=${longPath}\n`;
  let length = payload.length + 3;
  while (String(length).length + 1 + payload.length !== length)
    length = String(length).length + 1 + payload.length;
  const bytes = archive([
    ["pax", `${length} ${payload}`, "x"],
    ["short", "exact"],
  ]);
  NodeAssert.equal(
    readCrate(bytes, sha256(bytes), "demo-1.0.0").get(longPath.slice(11)).data.toString(),
    "exact",
  );
});

async function fixture(context) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "native-notices-test-"));
  context.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
  const src = NodePath.join(root, "registry/src/index/demo-1.0.0");
  const cache = NodePath.join(root, "registry/cache/index");
  await NodeFSP.mkdir(src, { recursive: true });
  await NodeFSP.mkdir(cache, { recursive: true });
  const bytes = archive([
    ["demo-1.0.0/Cargo.toml", '[package]\nname = "demo"\nversion = "1.0.0"\nlicense = "MIT"\n'],
    ["demo-1.0.0/LICENSE", "Original holder\n"],
    ["demo-1.0.0/vendor/COPYRIGHT", "Nested notice\r\n"],
  ]);
  const checksum = sha256(bytes);
  await NodeFSP.writeFile(NodePath.join(cache, "demo-1.0.0.crate"), bytes);
  const source = "registry+https://github.com/rust-lang/crates.io-index";
  const lock = `version = 4\n\n[[package]]\nname = "demo"\nversion = "1.0.0"\nsource = "${source}"\nchecksum = "${checksum}"\n`;
  const lockPath = NodePath.join(root, "Cargo.lock");
  await NodeFSP.writeFile(lockPath, lock);
  const binary = NodePath.join(root, "binary");
  await NodeFSP.writeFile(binary, "fixture binary");
  const packageRecord = {
    key: "demo@1.0.0",
    name: "demo",
    version: "1.0.0",
    source,
    checksum,
    roles: ["runtime"],
  };
  const product = {
    lock: { path: lockPath, sha256: sha256(lock) },
    root: { binary, binarySha256: sha256("fixture binary") },
    unresolvedEdges: [],
    selectedRegistryPackages: [packageRecord],
  };
  const selection = {
    schemaVersion: 1,
    platform: "aarch64-apple-darwin",
    products: { gateway: product, resourceMonitor: product },
  };
  const inventory = {
    schema: 1,
    locks: { gateway: { sha256: sha256(lock) }, resourceMonitor: { sha256: sha256(lock) } },
    packages: [
      {
        name: "demo",
        version: "1.0.0",
        registrySource: source,
        lockChecksum: checksum,
        cachedSource: src,
      },
    ],
  };
  await NodeFSP.writeFile(NodePath.join(root, "selection.json"), JSON.stringify(selection));
  await NodeFSP.writeFile(NodePath.join(root, "index.json"), JSON.stringify(inventory));
  await NodeFSP.writeFile(NodePath.join(root, "LICENSE"), "Existing T3 holder\n");
  return {
    root,
    selection,
    inventory,
    options: {
      inventory: NodePath.join(root, "index.json"),
      selection: NodePath.join(root, "selection.json"),
      t3License: NodePath.join(root, "LICENSE"),
      output: NodePath.join(root, "bundle"),
    },
  };
}

NodeTest.test(
  "collects exact nested bytes with binary/lock bindings and refuses an existing reviewed output",
  async (context) => {
    const { options } = await fixture(context);
    const summary = await collectNativeNotices(options);
    NodeAssert.equal(summary.collectionStatus, "collected");
    const manifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(options.output, "manifest.json")),
    );
    NodeAssert.equal(manifest.bindings.gateway.binarySha256, sha256("fixture binary"));
    NodeAssert.equal(manifest.files["selection.json"], manifest.bindings.selectionSha256);
    NodeAssert.deepEqual(
      await NodeFSP.readFile(NodePath.join(options.output, "crates/demo@1.0.0/vendor/COPYRIGHT")),
      Buffer.from("Nested notice\r\n"),
    );
    NodeAssert.deepEqual(
      await NodeFSP.readFile(NodePath.join(options.output, "T3-LICENSE")),
      await NodeFSP.readFile(options.t3License),
    );
    await NodeAssert.rejects(collectNativeNotices(options), /EEXIST/);
  },
);

NodeTest.test(
  "keeps missing selected text explicit and rejects stale graph binaries",
  async (context) => {
    const { root, options } = await fixture(context);
    await NodeFSP.unlink(NodePath.join(root, "registry/cache/index/demo-1.0.0.crate"));
    const summary = await collectNativeNotices(options);
    NodeAssert.equal(summary.collectionStatus, "incomplete");
    NodeAssert.deepEqual(summary.missing, [
      { key: "demo@1.0.0", selected: true, reason: "crate-archive-unavailable" },
    ]);
    await NodeFSP.writeFile(NodePath.join(root, "binary"), "changed binary");
    await NodeAssert.rejects(
      collectNativeNotices({ ...options, output: NodePath.join(root, "stale") }),
      /Binary binding mismatch/,
    );
  },
);

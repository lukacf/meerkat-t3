import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { collectNativeNotices, readCrate, sha256 } from "./collect-native-license-notices.mjs";

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

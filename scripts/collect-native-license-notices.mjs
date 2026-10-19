#!/usr/bin/env node
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeZlib from "node:zlib";
import { pinnedGitSource, readPinnedGitPackage } from "./lib/pinned-git-source.mjs";

export const sha256 = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const noticeName = /^(?:licen[cs]e|copying|copyright|notice|unlicense)(?:[._-].*)?$/i;
const hashPattern = /^[a-f0-9]{64}$/;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function safeRelative(value) {
  check(
    typeof value === "string" &&
      value.length > 0 &&
      !/[\\:\p{Cc}]/u.test(value) &&
      !NodePath.posix.isAbsolute(value) &&
      value.split("/").every((part) => part !== ".." && part !== "." && part !== ""),
    `Unsafe relative path: ${String(value)}`,
  );
  return value;
}

function publicText(value) {
  check(
    typeof value === "string" &&
      !/(?:^|[\s"'(:=])(?:\/\S|[A-Za-z]:[\\/]|~[\\/]|file:)|\/(?:Users|home|private|tmp|var|Library)\//u.test(
        value,
      ),
    "Public provenance must not contain local filesystem paths",
  );
  return value;
}

function publicUrl(value) {
  const url = new URL(value);
  check(
    ["https:", "http:"].includes(url.protocol) && !url.username && !url.password,
    "Expected a public HTTP(S) source URL",
  );
  return value;
}

function digestRecord(record) {
  check(record && hashPattern.test(record.sha256), "Invalid evidence digest");
  if (record.bytes !== undefined)
    check(Number.isSafeInteger(record.bytes) && record.bytes >= 0, "Invalid evidence size");
  return { sha256: record.sha256, ...(record.bytes === undefined ? {} : { bytes: record.bytes }) };
}

// Publish only documented provenance fields. Private evidence remains in the
// collector inputs and is identified by its digest, never by a local path.
async function publicProvenance(source) {
  check(
    source && typeof source === "object" && !Array.isArray(source),
    "Invalid notice provenance",
  );
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      [
        "kind",
        "license",
        "licenseId",
        "declaredLicenseExpression",
        "extraction",
        "attribution",
        "reason",
        "key",
      ].includes(key)
    )
      result[key] = publicText(value);
    else if (["repository", "sourceUrl", "declaredLink"].includes(key))
      result[key] = publicUrl(value);
    else if (["path", "repositoryPath", "pathInVcs"].includes(key))
      result[key] = safeRelative(value);
    else if (key === "commit") {
      check(/^[a-f0-9]{7,64}$/.test(value), "Invalid upstream commit");
      result[key] = value;
    } else if (
      [
        "copiedVerbatim",
        "notAPackageRepositoryFile",
        "appendixFieldsSubstituted",
        "appleSdkCaveatPreserved",
      ].includes(key)
    ) {
      check(typeof value === "boolean", "Invalid provenance flag");
      result[key] = value;
    } else if (["applicability", "declaration"].includes(key))
      result[key] = await publicProvenance(value);
    else if (key === "packageManifest") {
      const bytes = await regularBytes(value.path);
      check(
        sha256(bytes) === value.sha256 &&
          (value.bytes === undefined || bytes.length === value.bytes),
        "Workspace manifest provenance mismatch",
      );
      result[key] = digestRecord(value);
    }
  }
  return result;
}

function publicSelectedPackage(item, locked) {
  const pinned = locked.get(item.key);
  check(
    pinned &&
      pinned.source === (item.source ?? undefined) &&
      pinned.checksum === (item.checksum ?? undefined),
    `Selection is outside the lock: ${item.key}`,
  );
  check(
    Array.isArray(item.roles) &&
      item.roles.every((role) => ["runtime", "build", "proc-macro"].includes(role)),
    `Invalid selected roles: ${item.key}`,
  );
  return { ...pinned, roles: [...new Set(item.roles)].sort() };
}

function publicProduct(graph, locked) {
  if (graph.profile !== undefined)
    check(["debug", "release"].includes(graph.profile), "Unsupported build profile");
  if (graph.selectedUnitCount !== undefined)
    check(
      Number.isSafeInteger(graph.selectedUnitCount) && graph.selectedUnitCount > 0,
      "Invalid selected unit count",
    );
  return {
    ...(graph.profile === undefined ? {} : { profile: graph.profile }),
    lock: { sha256: graph.lock.sha256 },
    root: { binarySha256: graph.root.binarySha256 },
    unresolvedEdges: [],
    selectedRegistryPackages: graph.selectedRegistryPackages.map((item) =>
      publicSelectedPackage(item, locked),
    ),
    selectedGitPackages: (graph.selectedGitPackages ?? []).map((item) =>
      publicSelectedPackage(item, locked),
    ),
    selectedWorkspacePackages: (graph.selectedWorkspacePackages ?? []).map((item) =>
      publicSelectedPackage(item, locked),
    ),
    ...(graph.selectedUnitCount === undefined
      ? {}
      : { selectedUnitCount: graph.selectedUnitCount }),
    ...(graph.unitGraph === undefined ? {} : { unitGraph: digestRecord(graph.unitGraph) }),
    ...(graph.inputs === undefined
      ? {}
      : {
          inputs: Object.fromEntries(
            ["metadata", "buildMessages"]
              .filter((name) => graph.inputs[name] !== undefined)
              .map((name) => [name, digestRecord(graph.inputs[name])]),
          ),
        }),
  };
}

function paxFields(bytes) {
  const values = {};
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset);
    const length = Number(bytes.subarray(offset, space).toString("ascii"));
    check(
      space > offset &&
        Number.isSafeInteger(length) &&
        length > space - offset + 1 &&
        offset + length <= bytes.length,
      "Invalid PAX record",
    );
    const record = bytes.subarray(space + 1, offset + length).toString("utf8");
    const equals = record.indexOf("=");
    check(equals > 0 && record.endsWith("\n"), "Invalid PAX value");
    values[record.slice(0, equals)] = record.slice(equals + 1, -1);
    offset += length;
  }
  return values;
}

// Read archive bytes directly. No extraction, subprocess, Cargo or network access.
export function readCrate(archive, expectedChecksum, prefix) {
  check(
    hashPattern.test(expectedChecksum) && sha256(archive) === expectedChecksum,
    `Crate checksum mismatch: ${prefix}`,
  );
  const tar = NodeZlib.gunzipSync(archive, { maxOutputLength: 256 * 1024 * 1024 });
  const entries = new Map();
  let extended = {};
  let longName;
  const text = (buffer) => buffer.toString("utf8").replace(/\0.*$/s, "");
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const octal = (start, end) => {
      const value = text(header.subarray(start, end)).trim();
      check(/^[0-7]+$/.test(value), `Invalid tar number: ${prefix}`);
      return Number.parseInt(value, 8);
    };
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    check(sum === octal(148, 156), `Tar header checksum mismatch: ${prefix}`);
    const size = octal(124, 136);
    const end = offset + 512 + size;
    check(Number.isSafeInteger(size) && end <= tar.length, `Truncated tar entry: ${prefix}`);
    const data = tar.subarray(offset + 512, end);
    const type = text(header.subarray(156, 157));
    const name = text(header.subarray(0, 100));
    const directory = text(header.subarray(345, 500));
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      extended = paxFields(data);
      continue;
    }
    if (type === "g") {
      const global = paxFields(data);
      check(!global.path && !global.size, "Global PAX path/size is unsupported");
      continue;
    }
    if (type === "L") {
      longName = text(data);
      continue;
    }
    const fullName = extended.path ?? longName ?? (directory ? `${directory}/${name}` : name);
    check(!extended.size || Number(extended.size) === size, "PAX size mismatch");
    extended = {};
    longName = undefined;
    if (type === "5") continue;
    check(fullName.startsWith(`${prefix}/`), `Unexpected crate prefix: ${fullName}`);
    const relative = safeRelative(fullName.slice(prefix.length + 1));
    check(!entries.has(relative), `Duplicate crate entry: ${relative}`);
    entries.set(relative, { data, regular: type === "" || type === "0" });
  }
  return entries;
}

function lockedPackages(lock) {
  return lock
    .split(/^\[\[package\]\]$/m)
    .slice(1)
    .map((block) => {
      const field = (name) => new RegExp(`^${name} = "([^"\\n]+)"$`, "m").exec(block)?.[1];
      const name = field("name");
      const version = field("version");
      const source = field("source");
      const checksum = field("checksum");
      check(
        /^[A-Za-z0-9_-]+$/.test(name ?? "") && /^[A-Za-z0-9.+-]+$/.test(version ?? ""),
        "Unsupported Cargo.lock package entry",
      );
      if (source?.startsWith("git+")) {
        pinnedGitSource(source);
        check(
          checksum === undefined,
          "Git packages must use commit provenance, not a registry checksum",
        );
      } else if (source) {
        check(
          source.startsWith("registry+") && hashPattern.test(checksum ?? ""),
          `Expected a checksum-pinned registry package: ${name}@${version}`,
        );
        publicUrl(source.slice("registry+".length));
      }
      return { key: `${name}@${version}`, name, version, source, checksum };
    });
}

function packageLicense(bytes) {
  const section = bytes
    .toString("utf8")
    .split(/^\[package\]\s*$/m)[1]
    ?.split(/^\[/m)[0];
  return /^license\s*=\s*"([^"\n]+)"\s*$/m.exec(section ?? "")?.[1] ?? null;
}

async function regularBytes(file) {
  check((await NodeFSP.lstat(file)).isFile(), `Expected a regular source file: ${file}`);
  return NodeFSP.readFile(file);
}

export async function collectNativeNotices(options) {
  const inventoryBytes = await regularBytes(options.inventory);
  const inventory = JSON.parse(inventoryBytes);
  const selectionBytes = await regularBytes(options.selection);
  const selection = JSON.parse(selectionBytes);
  check(
    inventory.schema === 1 && selection.schemaVersion === 1,
    "Unsupported inventory/selection schema",
  );
  check(
    selection.platform === "aarch64-apple-darwin",
    "This collection requires the verified macOS arm64 graph",
  );
  const output = NodePath.resolve(options.output);
  await NodeFSP.mkdir(output); // Never overwrite a previously reviewed bundle.
  const files = {};
  const write = async (relative, data) => {
    safeRelative(relative);
    check(!Object.hasOwn(files, relative), `Duplicate output: ${relative}`);
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(output, relative)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(output, relative), data, { flag: "wx" });
    files[relative] = sha256(data);
    return { path: relative, sha256: files[relative], bytes: Buffer.byteLength(data) };
  };
  const publicSelection = {
    schemaVersion: 1,
    platform: selection.platform,
    method:
      "Portable compilation selection; complete build evidence is retained separately by digest",
    provenance: {
      sourceSelectionSha256: sha256(selectionBytes),
      sourceInventorySha256: sha256(inventoryBytes),
    },
    products: {},
  };
  const bindings = {};
  const all = new Map();
  const selected = new Map();
  const workspace = new Map();
  for (const product of ["gateway", "resourceMonitor"]) {
    const graph = selection.products[product];
    check(graph && graph.unresolvedEdges.length === 0, `Unresolved selected graph: ${product}`);
    const lockBytes = await regularBytes(graph.lock.path);
    check(
      sha256(lockBytes) === graph.lock.sha256 &&
        inventory.locks[product].sha256 === graph.lock.sha256,
      `Lock binding mismatch: ${product}`,
    );
    check(
      sha256(await regularBytes(graph.root.binary)) === graph.root.binarySha256,
      `Binary binding mismatch: ${product}`,
    );
    bindings[product] = {
      cargoLockSha256: graph.lock.sha256,
      binarySha256: graph.root.binarySha256,
    };
    const locked = new Map(
      lockedPackages(lockBytes.toString("utf8")).map((item) => [item.key, item]),
    );
    publicSelection.products[product] = publicProduct(graph, locked);
    for (const item of locked.values()) {
      if (!item.source) {
        workspace.set(item.key, { ...item, product });
        continue;
      }
      const existing = all.get(item.key);
      check(
        !existing || (existing.checksum === item.checksum && existing.source === item.source),
        `Conflicting locked identities: ${item.key}`,
      );
      all.set(item.key, { ...item, products: [...(existing?.products ?? []), product] });
    }
    for (const item of [...graph.selectedRegistryPackages, ...(graph.selectedGitPackages ?? [])]) {
      const pinned = locked.get(item.key);
      check(
        pinned && pinned.source === item.source && pinned.checksum === (item.checksum ?? undefined),
        `Selection is outside the lock: ${item.key}`,
      );
      selected.set(item.key, [...(selected.get(item.key) ?? []), { product, roles: item.roles }]);
    }
  }
  const overrides = options.supplements
    ? JSON.parse(await regularBytes(options.supplements))
    : { packages: [] };
  const supplementBase = options.supplements
    ? NodePath.dirname(NodePath.resolve(options.supplements))
    : output;
  const supplementMap = new Map((overrides.packages ?? []).map((item) => [item.key, item]));
  const index = new Map(inventory.packages.map((item) => [`${item.name}@${item.version}`, item]));
  const packages = [];
  const missing = [];
  for (const item of [...all.values()].sort((a, b) => a.key.localeCompare(b.key, "en"))) {
    const known = index.get(item.key);
    check(
      known &&
        (item.source.startsWith("git+")
          ? known.gitSource === item.source && known.lockChecksum === undefined
          : known.lockChecksum === item.checksum && known.registrySource === item.source),
      `Package index differs from lock: ${item.key}`,
    );
    const record = {
      ...item,
      selected: selected.get(item.key) ?? [],
      notices: [],
      licenseExpression:
        known.licenseExpression == null ? null : publicText(known.licenseExpression),
    };
    packages.push(record);
    if (item.source.startsWith("git+")) {
      const git = readPinnedGitPackage(item.source, known.cachedSource);
      record.manifestSha256 = sha256(git.manifest);
      record.gitCommitVerified = true;
      for (const notice of git.notices) {
        const copied = await write(`git/${item.key}/${safeRelative(notice.path)}`, notice.data);
        record.notices.push({
          ...copied,
          source: {
            kind: "git-commit",
            repository: git.repository,
            commit: git.commit,
            repositoryPath: notice.path,
            resolvedRepositoryPath: safeRelative(notice.resolvedPath),
          },
        });
      }
      if (record.notices.length === 0)
        missing.push({
          key: item.key,
          selected: record.selected.length > 0,
          reason: "notice-text-unavailable",
        });
      continue;
    }
    const source = known.cachedSource;
    const archive =
      source &&
      NodePath.join(
        NodePath.dirname(NodePath.dirname(NodePath.dirname(source))),
        "cache",
        NodePath.basename(NodePath.dirname(source)),
        `${item.name}-${item.version}.crate`,
      );
    let entries;
    if (archive) {
      try {
        entries = readCrate(
          await regularBytes(archive),
          item.checksum,
          `${item.name}-${item.version}`,
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (entries) {
      const manifest = entries.get("Cargo.toml");
      check(manifest?.regular, `Missing crate manifest: ${item.key}`);
      record.manifestSha256 = sha256(manifest.data);
      const declaredLicense = packageLicense(manifest.data);
      record.licenseExpression =
        declaredLicense === null ? record.licenseExpression : publicText(declaredLicense);
      record.archiveChecksumVerified = true;
      for (const [relative, entry] of [...entries].sort(([a], [b]) => a.localeCompare(b, "en"))) {
        if (!noticeName.test(NodePath.posix.basename(relative))) continue;
        check(entry.regular, `Non-regular notice: ${item.key}/${relative}`);
        const copied = await write(`crates/${item.key}/${relative}`, entry.data);
        record.notices.push({
          ...copied,
          source: { kind: "crate-archive", path: relative, archiveSha256: item.checksum },
        });
      }
      // This bundled SQLite notice lives in source, not a standalone LICENSE.
      if (item.key === "libsqlite3-sys@0.35.0") {
        const sqlite = entries.get("sqlite3/sqlite3.c");
        check(sqlite?.regular, "Missing bundled SQLite source");
        const lines = sqlite.data.toString("utf8").split(/(?<=\n)/);
        const header = lines.slice(0, 45).join("");
        check(
          header.includes("The author disclaims copyright") &&
            header.includes("May you share freely"),
          "Bundled SQLite notice moved; review its exact source range",
        );
        const copied = await write(`crates/${item.key}/sqlite3-source-notice.txt`, header);
        record.notices.push({
          ...copied,
          source: {
            kind: "crate-source-excerpt",
            path: "sqlite3/sqlite3.c",
            lines: [1, 45],
            sourceSha256: sha256(sqlite.data),
            archiveSha256: item.checksum,
          },
        });
      }
    }
    const supplement = supplementMap.get(item.key);
    if (supplement) {
      check(supplement.checksum === item.checksum, `Supplement lock mismatch: ${item.key}`);
      for (const notice of supplement.notices) {
        const bytes = await regularBytes(NodePath.resolve(supplementBase, notice.file));
        check(
          sha256(bytes) === notice.sha256 && notice.source,
          `Supplement provenance mismatch: ${item.key}`,
        );
        const copied = await write(`supplements/${item.key}/${safeRelative(notice.name)}`, bytes);
        record.notices.push({ ...copied, source: await publicProvenance(notice.source) });
      }
    }
    if (!entries || record.notices.length === 0)
      missing.push({
        key: item.key,
        selected: record.selected.length > 0,
        reason: !entries ? "crate-archive-unavailable" : "notice-text-unavailable",
      });
  }
  const t3 = await regularBytes(options.t3License);
  bindings.t3LicenseSha256 = sha256(t3);
  await write("T3-LICENSE", t3);
  for (const item of workspace.values()) {
    if (item.name === "t3-resource-monitor") {
      item.notices = [{ path: "T3-LICENSE", sha256: sha256(t3) }];
      continue;
    }
    const supplement = supplementMap.get(item.key);
    item.notices = [];
    for (const notice of supplement?.notices ?? []) {
      const bytes = await regularBytes(NodePath.resolve(supplementBase, notice.file));
      check(
        sha256(bytes) === notice.sha256 && notice.source,
        `Workspace notice provenance mismatch: ${item.key}`,
      );
      item.notices.push({
        ...(await write(`workspace/${item.key}/${safeRelative(notice.name)}`, bytes)),
        source: await publicProvenance(notice.source),
      });
    }
    if (item.notices.length === 0)
      missing.push({ key: item.key, selected: true, reason: "owner-notice-required" });
  }
  const collectionStatus = missing.some((item) => item.selected) ? "incomplete" : "collected";
  const result = {
    schemaVersion: 1,
    collectionStatus,
    target: { platform: "macos", arch: "aarch64" },
    sourceInventorySha256: sha256(inventoryBytes),
    selectedRegistryCount: [...selected.keys()].filter((key) =>
      all.get(key).source.startsWith("registry+"),
    ).length,
    selectedGitCount: [...selected.keys()].filter((key) => all.get(key).source.startsWith("git+"))
      .length,
    allTargetRegistryCount: [...all.values()].filter((item) => item.source.startsWith("registry+"))
      .length,
    allTargetGitCount: [...all.values()].filter((item) => item.source.startsWith("git+")).length,
    packages,
    workspacePackages: [...workspace.values()],
    missing,
    excludedSources: await Promise.all((overrides.excludedSources ?? []).map(publicProvenance)),
    limits: [
      "Selected compilation closure is not proof of retained symbols or license applicability.",
      "All-target lock entries are inventoried separately from the selected macOS graph.",
      "Verbatim available-text collection does not establish legal clearance or complete notice obligations.",
      "Non-Cargo toolchain, native/system libraries and source-availability decisions are outside this collection.",
    ],
  };
  const publicSelectionBytes = `${JSON.stringify(publicSelection, null, 2)}\n`;
  bindings.selectionSha256 = sha256(publicSelectionBytes);
  await write("selection.json", publicSelectionBytes);
  await write("inventory.json", `${JSON.stringify(result, null, 2)}\n`);
  await write(
    "README.txt",
    `Native dependency notice collection\n\nStatus: ${collectionStatus}\n` +
      "See inventory.json for exact versions, checksums, copied file provenance, selected compile roles and missing inputs.\n" +
      "Notice texts are copied verbatim. All-target inventory entries are not assertions that they ship in the binary.\n" +
      "This collection is not legal clearance or a completeness claim. Original T3 Tools notice is preserved in T3-LICENSE.\n",
  );
  const manifest = { schemaVersion: 1, target: result.target, collectionStatus, bindings, files };
  await NodeFSP.writeFile(
    NodePath.join(output, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      flag: "wx",
    },
  );
  return {
    collectionStatus,
    selectedRegistryCount: [...selected.keys()].filter((key) =>
      all.get(key).source.startsWith("registry+"),
    ).length,
    selectedGitCount: [...selected.keys()].filter((key) => all.get(key).source.startsWith("git+"))
      .length,
    allTargetRegistryCount: [...all.values()].filter((item) => item.source.startsWith("registry+"))
      .length,
    allTargetGitCount: [...all.values()].filter((item) => item.source.startsWith("git+")).length,
    noticeFileCount: Object.keys(files).length - 4,
    missing,
    manifestSha256: sha256(await NodeFSP.readFile(NodePath.join(output, "manifest.json"))),
  };
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const i = args.indexOf(`--${name}`);
    return i < 0 ? undefined : args[i + 1];
  };
  const options = {
    inventory: option("inventory"),
    selection: option("selection"),
    supplements: option("supplements"),
    t3License: option("t3-license"),
    output: option("output"),
  };
  check(
    options.inventory && options.selection && options.t3License && options.output,
    "Usage: node scripts/collect-native-license-notices.mjs --inventory <package-index.json> --selection <selected-graph.json> --t3-license <LICENSE> [--supplements <provenance.json>] --output <new-directory>",
  );
  console.log(JSON.stringify(await collectNativeNotices(options), null, 2));
}

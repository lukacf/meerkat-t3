#!/usr/bin/env node
/** Offline, same-location recovery. No runtime RPCs, credential decoding, or project relocation. */
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This bundled standalone CLI has no Effect runtime dependency.
const platform = NodeOS.platform();

const run = NodeUtil.promisify(NodeChildProcess.execFile);
const FORMAT = "meerkat-t3-offline-profile";
const RESTORE_REVIEW_VERSION = 1;
const RESTORE_REVIEW_MARKER = "meerkat-restore-review.json";
const RESTORE_REVIEW_CAPABILITY = "meerkat-restore-review-capability.json";
const UNGUARDED_BACKUP_GUIDANCE = "This backup was made without matching restore-review support. Keep this archive unchanged. Open the original profile with a restore-review-capable build, quit it, and create a fresh backup using that build's version. If the original profile is lost, keep the app closed and contact the distributor for recovery assistance.";
const exists = async (file) => NodeFSP.lstat(file).then(() => true, (error) => {
  if (error.code === "ENOENT") return false;
  throw error;
});
const inside = (parent, child) => {
  const relative = NodePath.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${NodePath.sep}`) && relative !== ".." && !NodePath.isAbsolute(relative));
};
const fail = (message) => { throw new Error(message); };

async function hasRestoreReviewCapability(profile, appVersion) {
  let file;
  try {
    file = await NodeFSP.open(NodePath.join(profile, RESTORE_REVIEW_CAPABILITY), NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096) return false;
    const value = JSON.parse(await file.readFile("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).length === 2 && value.version === RESTORE_REVIEW_VERSION && value.appVersion === appVersion;
  } catch {
    // Archives remain useful even when an older build cannot support guarded recovery.
    return false;
  } finally { await file?.close(); }
}

function isCanonicalTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

async function syncDirectory(directory) {
  const handle = await NodeFSP.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeRestoreReviewMarker(profile, manifest) {
  const marker = {
    version: RESTORE_REVIEW_VERSION,
    restoreId: NodeCrypto.randomUUID(),
    restoredAt: new Date().toISOString(),
    backupCreatedAt: manifest.createdAt,
    appVersion: manifest.appVersion,
  };
  const contents = `${JSON.stringify(marker, null, 2)}\n`;
  const temporary = NodePath.join(profile, `.meerkat-restore-review-${NodeCrypto.randomUUID()}.tmp`);
  const handle = await NodeFSP.open(temporary, "wx", 0o600);
  try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
  if (await NodeFSP.readFile(temporary, "utf8") !== contents) fail("Restore review marker failed verification. Nothing was restored.");
  // Replace any inherited consent without following a saved marker's symbolic link.
  await NodeFSP.rename(temporary, NodePath.join(profile, RESTORE_REVIEW_MARKER));
  await syncDirectory(profile);
}

function safeRelative(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") &&
    !value.includes("\\") && !NodePath.posix.isAbsolute(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

async function canonical(file, mustExist = true) {
  if (!NodePath.isAbsolute(file ?? "")) fail("All profile, desktop, native, and backup paths must be absolute.");
  if (await exists(file)) {
    const stat = await NodeFSP.lstat(file);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`Expected a real directory: ${file}`);
    return NodeFSP.realpath(file);
  }
  if (mustExist) fail(`Directory does not exist: ${file}`);
  return NodePath.join(await NodeFSP.realpath(NodePath.dirname(file)), NodePath.basename(file));
}

function validateRoots(roots) {
  for (const [index, root] of roots.entries()) {
    if (root.source === NodePath.parse(root.source).root) fail("A filesystem root is not an app profile.");
    for (const previous of roots.slice(0, index)) {
      if (inside(previous.source, root.source) || inside(root.source, previous.source)) {
        fail("Profile roots overlap. Supply separate profile and desktop data directories.");
      }
    }
  }
}

async function explicitRoots(options, mustExist) {
  const roots = [
    { id: "profile", source: await canonical(options.profile, mustExist) },
    { id: "desktop", source: await canonical(options.desktopData, mustExist) },
  ];
  for (const [index, source] of (options.nativeStates ?? []).entries()) {
    roots.push({ id: `native-${index + 1}`, source: await canonical(source, mustExist) });
  }
  validateRoots(roots);
  return roots;
}

/** Query a disposable copy, never SQLite-open the original profile or its WAL. */
export async function readPersistedNativeRoots(profile) {
  const found = [];
  const queries = {
    meerkat_project_agents: "SELECT provider_state_root AS root FROM meerkat_project_agents UNION SELECT state_root FROM meerkat_project_agents",
    meerkat_peer_connections: "SELECT provider_state_root AS root FROM meerkat_peer_connections",
    meerkat_observed_agents: "SELECT provider_state_root AS root FROM meerkat_observed_agents UNION SELECT state_root FROM meerkat_observed_agents",
    meerkat_workspace_checkpoints: "SELECT state_root AS root FROM meerkat_workspace_checkpoints",
    provider_session_runtime: "SELECT resume_cursor_json AS cursor FROM provider_session_runtime WHERE provider_name = 'meerkat' AND resume_cursor_json IS NOT NULL",
  };
  for (const state of ["userdata", "dev"]) {
    const database = NodePath.join(profile, state, "state.sqlite");
    if (!(await exists(database))) continue;
    const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "meerkat-backup-index-"));
    try {
      await NodeFSP.chmod(temporary, 0o700);
      for (const suffix of ["", "-wal", "-shm"]) {
        if (!(await exists(`${database}${suffix}`))) continue;
        await NodeStreamPromises.pipeline(
          NodeFS.createReadStream(`${database}${suffix}`, { flags: NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW }),
          NodeFS.createWriteStream(NodePath.join(temporary, `state.sqlite${suffix}`), { flags: "wx", mode: 0o600 }),
        );
      }
      const query = async (sql) => {
        const result = await run("/usr/bin/sqlite3", ["-json", NodePath.join(temporary, "state.sqlite"), sql], { maxBuffer: 32 * 1024 * 1024 });
        return result.stdout.trim() ? JSON.parse(result.stdout) : [];
      };
      const tables = await query("SELECT name FROM sqlite_master WHERE type = 'table'");
      for (const { name } of tables) {
        if (!Object.hasOwn(queries, name)) continue;
        for (const row of await query(queries[name])) {
          const value = row.cursor ? JSON.parse(row.cursor).stateRoot : row.root;
          if (value !== null && value !== undefined) {
            if (typeof value !== "string" || !NodePath.isAbsolute(value)) fail("A saved native state root is invalid; repair the profile before backup.");
            // Definitions and peer connections can be saved before native state
            // exists. Observed agents, sessions and checkpoints establish history.
            found.push({
              source: value,
              required: name !== "meerkat_project_agents" && name !== "meerkat_peer_connections",
            });
          }
        }
      }
    } finally { await NodeFSP.rm(temporary, { recursive: true, force: true }); }
  }
  return found;
}

async function addConfiguredNativeRoots(roots, persistedRoots) {
  let settingsFound = false;
  const candidates = [...persistedRoots];
  for (const state of ["userdata", "dev"]) {
    const settingsFile = NodePath.join(roots[0].source, state, "settings.json");
    if (!(await exists(settingsFile))) continue;
    settingsFound = true;
    const contents = await NodeFSP.readFile(settingsFile, "utf8");
    let settings;
    try { settings = JSON.parse(contents); }
    catch {
      fail("Profile settings are not valid JSON. Keep the original file unchanged and repair it before backup. No backup was created.");
    }
    for (const [id, instance] of Object.entries(settings.providerInstances ?? {})) {
      if (instance?.driver !== "meerkat" && id !== "meerkat") continue;
      const configured = instance?.config?.stateRoot;
      if (configured === undefined) continue;
      candidates.push({ source: configured, required: false });
    }
  }
  if (!settingsFound) fail("Profile has no userdata/settings.json or dev/settings.json. Check the selected profile.");
  const references = new Map();
  for (const { source, required } of candidates) {
    if (!NodePath.isAbsolute(source ?? "")) fail("A configured native state root is invalid.");
    references.set(source, required || references.get(source) === true);
  }
  const resolved = [];
  for (const [candidate, required] of references) {
    if (!(await exists(candidate))) {
      if (required) fail(`Saved agent history references a missing directory: ${candidate}. Locate and restore that directory before making a full backup. No backup was created.`);
      if (roots.some((root) => inside(root.source, candidate))) continue;
    }
    resolved.push(await canonical(candidate));
  }
  for (const source of [...new Set(resolved)].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
    if (roots.some((root) => inside(root.source, source))) continue;
    if (roots.some((root) => inside(source, root.source))) fail("A discovered native state root overlaps a selected root; choose its parent explicitly with --native-state.");
    roots.push({ id: `native-${roots.filter((root) => root.id.startsWith("native-")).length + 1}`, source });
  }
  validateRoots(roots);
  return roots;
}

function ephemeral(rootId, relative) {
  if (rootId === "desktop") return ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"].includes(relative);
  if (rootId === "profile") return ["server-process.json", "userdata/server-runtime.json", "dev/server-runtime.json"].includes(relative);
  return false;
}

async function hashFile(file) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const bytes of NodeFS.createReadStream(file, { flags: NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW })) hash.update(bytes);
  return hash.digest("hex");
}

async function inventory(directory, rootId, relative = "") {
  const entries = [];
  for (const name of (await NodeFSP.readdir(NodePath.join(directory, relative))).sort()) {
    const child = relative ? `${relative}/${name}` : name;
    if (!safeRelative(child)) fail(`Unsupported filename in profile: ${child}`);
    if (ephemeral(rootId, child)) continue;
    const file = NodePath.join(directory, child);
    const stat = await NodeFSP.lstat(file);
    const entry = { path: child, mode: stat.mode & 0o777 };
    if (stat.isSymbolicLink()) entries.push({ ...entry, type: "link", target: await NodeFSP.readlink(file) });
    else if (stat.isDirectory()) {
      entries.push({ ...entry, type: "directory" });
      entries.push(...await inventory(directory, rootId, child));
    } else if (stat.isFile()) entries.push({ ...entry, type: "file", size: stat.size, sha256: await hashFile(file) });
    else fail(`Unsupported live socket or special file: ${file}. Quit the app and its tools before backup.`);
  }
  return entries;
}

const contentIdentity = (entries) => JSON.stringify(entries.map(({ mode: _mode, ...entry }) => entry));

async function copyInventory(source, destination, entries, restore = false) {
  for (const entry of entries) {
    const target = NodePath.join(destination, entry.path);
    if (entry.type === "directory") await NodeFSP.mkdir(target, { mode: 0o700 });
    else if (entry.type === "link") await NodeFSP.symlink(entry.target, target);
    else {
      await NodeStreamPromises.pipeline(
        NodeFS.createReadStream(NodePath.join(source, entry.path), { flags: NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW }),
        NodeFS.createWriteStream(target, { flags: "wx", mode: 0o600 }),
      );
      if (restore) await NodeFSP.chmod(target, entry.mode);
    }
  }
  if (restore) {
    for (const entry of [...entries].reverse()) {
      if (entry.type === "directory") await NodeFSP.chmod(NodePath.join(destination, entry.path), entry.mode);
    }
  }
}

/** lsof inspects open handles only; the tool never signals or terminates a process. */
export async function assertProfileOffline(roots) {
  for (const root of roots) {
    if (!(await exists(root.source))) continue;
    if (root.id === "profile") {
      for (const relative of ["server-process.json", "userdata/server-runtime.json", "dev/server-runtime.json"]) {
        const file = NodePath.join(root.source, relative);
        if (!(await exists(file))) continue;
        const state = JSON.parse(await NodeFSP.readFile(file, "utf8"));
        if (!Number.isSafeInteger(state.pid) || state.pid < 1) fail(`Invalid runtime PID record: ${file}`);
        try { process.kill(state.pid, 0); fail(`Profile server PID ${state.pid} still exists. Quit it before continuing.`); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
    let result;
    try { result = await run("/usr/sbin/lsof", ["-t", "+D", root.source], { maxBuffer: 8 * 1024 * 1024 }); }
    catch (error) {
      if (error.code !== 1 || error.stderr?.trim()) throw new Error(`Cannot verify closed profile ${root.source}: ${error.message}`);
      result = error;
    }
    if (result.stderr?.trim()) fail(`Cannot verify closed profile ${root.source}: lsof reported an error.`);
    if (result.stdout?.trim()) fail(`Profile has open files: ${root.source}. Quit the app, terminals, and other tools using it.`);
  }
}

/** @typedef {{ pid: number, executable: string, args: string }} RecoveryProcess */

/** Read only this user's process metadata; never include command lines in errors. */
async function readRecoveryProcesses() {
  const read = async (column) => {
    const result = await run("/bin/ps", ["-x", "-ww", "-o", `pid=,${column}=`], { maxBuffer: 8 * 1024 * 1024 });
    if (result.stderr?.trim()) throw new Error("Process inspection failed.");
    const entries = new Map();
    for (const line of result.stdout.split("\n").filter((line) => line.trim())) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1) throw new Error("Invalid process inspection result.");
      entries.set(Number(match[1]), match[2]);
    }
    if (!entries.has(process.pid)) throw new Error("Incomplete process inspection result.");
    return entries;
  };
  const [executables, argumentsByPid] = await Promise.all([read("comm"), read("args")]);
  return [...executables].map(([pid, executable]) => ({ pid, executable, args: argumentsByPid.get(pid) ?? "" }));
}

/**
 * Missing roots have no live PID records or open directories to inspect. This
 * conservative extra check complements, but cannot replace, --confirm-closed.
 * @param {{ readProcesses?: () => Promise<RecoveryProcess[]>, ownPid?: number, executablePath?: string }} dependencies
 */
export async function assertMissingOriginalsOffline(dependencies = {}) {
  const ownPid = dependencies.ownPid ?? process.pid;
  const executablePath = dependencies.executablePath ?? process.execPath;
  let processes;
  try { processes = await (dependencies.readProcesses ?? readRecoveryProcesses)(); }
  catch { fail("Cannot inspect running processes for missing-originals recovery. Keep the app and its servers closed, then retry."); }
  const bundledExecutable = executablePath.includes(".app/Contents/");
  for (const entry of processes) {
    if (entry.pid === ownPid) continue;
    const name = NodePath.basename(entry.executable);
    const isApp = /\/meerkat[^/]*\.app\/contents\//i.test(entry.executable) ||
      (bundledExecutable && entry.executable === executablePath);
    const isNative = name === "meerkat-desktop-stdio";
    const isJsRuntime = /^(?:node|nodejs|bun|electron)$/i.test(name);
    const isServer = name === "t3" || (isJsRuntime && /(?:^|[ /])apps\/server\/(?:src|dist)\/(?:bin|index)\.(?:[cm]?js|ts)(?=[\s"']|$)/.test(entry.args));
    if (isApp || isNative || isServer) {
      fail(`A possible Meerkat app or server is still running (PID ${entry.pid}). Quit it before missing-originals recovery; no process was stopped.`);
    }
  }
}

function requireConsent(options) {
  if (!options.confirmClosed) fail("Quit Meerkat T3 and its servers, then pass --confirm-closed.");
  if (!options.includeSecrets) fail("This full profile contains credentials and private data. Use encrypted storage and pass --include-secrets.");
  if (typeof options.appVersion !== "string" || !options.appVersion.trim()) fail("Record the app's version with --app-version.");
}

export async function createProfileBackup(options, dependencies = {}) {
  requireConsent(options);
  const offline = dependencies.assertOffline ?? assertProfileOffline;
  const selectedRoots = await explicitRoots(options, true);
  await offline(selectedRoots);
  const persistedRoots = await (dependencies.readPersistedRoots ?? readPersistedNativeRoots)(selectedRoots[0].source);
  const roots = await addConfiguredNativeRoots(selectedRoots, persistedRoots);
  const destination = await canonical(options.output, false);
  if (await exists(destination)) fail("Backup destination already exists; choose a new directory.");
  if (roots.some((root) => inside(root.source, destination) || inside(destination, root.source))) fail("Backup must be outside every profile root.");
  await offline(roots);
  const manifest = {
    format: FORMAT, version: 1, createdAt: new Date().toISOString(), appVersion: options.appVersion,
    recovery: "same-user-same-machine-same-path", containsSecrets: true,
    externalDependencies: ["OS Keychain and shared provider credential stores (reauthenticate)", "Global ~/.rkat configuration", "Project repositories and external symlink targets"],
    roots: [],
  };
  for (const root of roots) manifest.roots.push({ ...root, entries: await inventory(root.source, root.id) });
  await NodeFSP.mkdir(destination, { mode: 0o700 });
  try {
    for (const root of manifest.roots) {
      await NodeFSP.mkdir(NodePath.join(destination, root.id), { mode: 0o700 });
      await copyInventory(root.source, NodePath.join(destination, root.id), root.entries);
      const copied = await inventory(NodePath.join(destination, root.id), root.id);
      if (contentIdentity(copied) !== contentIdentity(root.entries)) fail(`Copied data failed verification: ${root.id}`);
    }
    await offline(roots);
    for (const root of manifest.roots) {
      if (contentIdentity(await inventory(root.source, root.id)) !== contentIdentity(root.entries)) fail(`Profile changed during backup: ${root.id}. Keep the app closed and retry.`);
    }
    if (await hasRestoreReviewCapability(NodePath.join(destination, "profile"), manifest.appVersion)) {
      manifest.restoreReviewVersion = RESTORE_REVIEW_VERSION;
    }
    await NodeFSP.writeFile(NodePath.join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return manifest;
  } catch (error) {
    await NodeFSP.rm(destination, { recursive: true, force: true });
    throw error;
  }
}

function validateManifest(manifest) {
  if (manifest?.format !== FORMAT || manifest.version !== 1 || manifest.recovery !== "same-user-same-machine-same-path" || manifest.containsSecrets !== true || !Array.isArray(manifest.roots)) fail("Unsupported or incomplete profile backup.");
  if (manifest.restoreReviewVersion !== undefined && manifest.restoreReviewVersion !== RESTORE_REVIEW_VERSION) fail("Unsupported restore-review version in backup. Keep the archive and use its matching recovery tool.");
  if (manifest.restoreReviewVersion === RESTORE_REVIEW_VERSION &&
      (typeof manifest.appVersion !== "string" || !manifest.appVersion.trim() || !isCanonicalTimestamp(manifest.createdAt))) fail("Invalid restore-review backup version or creation time.");
  const ids = new Set();
  for (const root of manifest.roots) {
    if (!/^(profile|desktop|native-[1-9][0-9]*)$/.test(root.id) || ids.has(root.id) || !NodePath.isAbsolute(root.source) || !Array.isArray(root.entries)) fail("Invalid profile root in backup manifest.");
    ids.add(root.id);
    const seen = new Map();
    for (const entry of root.entries) {
      if (!safeRelative(entry.path) || seen.has(entry.path) || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) fail("Invalid or duplicate backup path.");
      const parent = NodePath.posix.dirname(entry.path);
      if (parent !== "." && seen.get(parent) !== "directory") fail("Backup path traverses a missing directory or symbolic link.");
      if (entry.type === "file") {
        if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail("Invalid file checksum in backup.");
      } else if (entry.type === "link") {
        if (typeof entry.target !== "string" || !entry.target || entry.target.includes("\0")) fail("Invalid symbolic link in backup.");
      } else if (entry.type !== "directory") fail("Unsupported backup entry.");
      if (ephemeral(root.id, entry.path)) fail("Backup contains live process markers; use a supported backup.");
      seen.set(entry.path, entry.type);
    }
  }
  if (!ids.has("profile") || !ids.has("desktop")) fail("Backup is missing the profile or desktop data.");
  validateRoots(manifest.roots);
}

export async function verifyProfileBackup(backup) {
  const directory = await canonical(backup);
  const manifestPath = NodePath.join(directory, "manifest.json");
  const stat = await NodeFSP.lstat(manifestPath);
  if (!stat.isFile() || stat.size > 256 * 1024 * 1024) fail("Invalid backup manifest file.");
  const manifest = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8"));
  validateManifest(manifest);
  const topLevel = (await NodeFSP.readdir(directory)).sort();
  if (JSON.stringify(topLevel) !== JSON.stringify(["manifest.json", ...manifest.roots.map((root) => root.id)].sort())) fail("Backup contains unexpected or missing root directories.");
  for (const root of manifest.roots) {
    const payload = await canonical(NodePath.join(directory, root.id));
    const actual = await inventory(payload, "payload");
    if (contentIdentity(actual) !== contentIdentity(root.entries)) fail(`Backup checksum or content mismatch: ${root.id}. Nothing was restored.`);
  }
  if (manifest.restoreReviewVersion === RESTORE_REVIEW_VERSION &&
      !(await hasRestoreReviewCapability(NodePath.join(directory, "profile"), manifest.appVersion))) fail(`Backup restore-review capability is missing or invalid. ${UNGUARDED_BACKUP_GUIDANCE}`);
  return manifest;
}

async function retainedRestoreRoots(options, roots) {
  if (!options.retainedProfile || !options.retainedDesktopData ||
      (options.retainedNativeStates ?? []).length !== roots.filter((root) => root.id.startsWith("native-")).length) {
    fail("Restore requires --retained-profile, --retained-desktop-data, and one --retained-native-state for each external native root. Supply the actual moved-aside directories so their running processes can be checked.");
  }
  const retained = await explicitRoots({
    profile: options.retainedProfile,
    desktopData: options.retainedDesktopData,
    nativeStates: options.retainedNativeStates,
  }, true);
  const backup = await canonical(options.backup);
  for (const root of retained) {
    if ([...roots, { source: backup }].some((other) => inside(root.source, other.source) || inside(other.source, root.source))) {
      fail("Retained profile roots must be separate from restore destinations and the backup.");
    }
  }
  return retained;
}

export async function restoreProfileBackup(options, dependencies = {}) {
  requireConsent(options);
  const offline = dependencies.assertOffline ?? assertProfileOffline;
  const manifest = await verifyProfileBackup(options.backup);
  if (manifest.appVersion !== options.appVersion) fail("Use the original app version for recovery before upgrading. App version does not match backup.");
  if (manifest.restoreReviewVersion !== RESTORE_REVIEW_VERSION) fail(UNGUARDED_BACKUP_GUIDANCE);
  const roots = await explicitRoots(options, false);
  if (roots.length !== manifest.roots.length || roots.some((root) => !manifest.roots.some((saved) => saved.id === root.id && saved.source === root.source))) fail("Restore roots must match the original backup locations, including every external --native-state root.");
  if (roots.some((root) => inside(root.source, options.backup) || inside(options.backup, root.source))) fail("Backup and restored profile roots must be separate.");
  for (const root of roots) if (await exists(root.source)) fail(`Restore refuses to overwrite ${root.source}. Keep the app closed and move that directory aside first.`);
  if (options.originalsMissing && (options.retainedProfile || options.retainedDesktopData || options.retainedNativeStates?.length)) {
    fail("Use either --originals-missing or the actual retained-root paths, not both.");
  }
  const retained = options.originalsMissing ? [] : await retainedRestoreRoots(options, roots);
  const retainedIdentities = await Promise.all(retained.map((root) => NodeFSP.stat(root.source)));
  const checkOffline = async () => {
    if (options.originalsMissing) {
      await assertMissingOriginalsOffline(dependencies);
      for (const root of roots) if (await exists(root.source)) fail(`Restore destination appeared: ${root.source}. Keep the app closed; no existing profile will be overwritten.`);
    }
    for (const [index, root] of retained.entries()) {
      // Do not silently skip a retained root that was moved again or replaced.
      await canonical(root.source);
      const current = await NodeFSP.stat(root.source);
      if (current.dev !== retainedIdentities[index].dev || current.ino !== retainedIdentities[index].ino) fail(`Retained profile directory changed: ${root.source}. Keep the app closed and retry with its actual location.`);
    }
    await offline([...retained, ...roots]);
  };
  await checkOffline();
  const staged = [];
  const restored = [];
  try {
    for (const root of manifest.roots) {
      const temporary = NodePath.join(NodePath.dirname(root.source), `.meerkat-restore-${NodeCrypto.randomUUID()}`);
      await NodeFSP.mkdir(temporary, { mode: 0o700 });
      staged.push({ id: root.id, temporary, source: root.source });
      await copyInventory(NodePath.join(options.backup, root.id), temporary, root.entries, true);
      if (contentIdentity(await inventory(temporary, "payload")) !== contentIdentity(root.entries)) fail(`Staged restore failed verification: ${root.id}`);
    }
    await writeRestoreReviewMarker(staged.find((entry) => entry.id === "profile").temporary, manifest);
    await checkOffline();
    for (const root of roots) if (await exists(root.source)) fail(`Restore destination appeared while preparing: ${root.source}`);
    for (const entry of staged) {
      // Reserve an absent destination before publication. Never replace an existing profile.
      await NodeFSP.mkdir(entry.source, { mode: 0o700 });
      try { await NodeFSP.rename(entry.temporary, entry.source); }
      catch (error) { await NodeFSP.rmdir(entry.source).catch(() => {}); throw error; }
      restored.push(entry.source);
      await syncDirectory(NodePath.dirname(entry.source));
    }
    return { restored, appVersion: manifest.appVersion };
  } catch (error) {
    if (restored.length) throw new Error(`${error.message}\nPartial restore retained at: ${restored.join(", ")}. Keep the app closed; move these aside before retrying. Existing data was not overwritten.`);
    throw error;
  } finally {
    for (const entry of staged) await NodeFSP.rm(entry.temporary, { recursive: true, force: true });
  }
}

const usage = `Offline Meerkat T3 profile recovery (macOS)
  backup --profile PATH --desktop-data PATH --output NEW_DIRECTORY --app-version VERSION --confirm-closed --include-secrets [--native-state PATH ...]
  verify --backup DIRECTORY
  restore --backup DIRECTORY --profile ORIGINAL_PATH --desktop-data ORIGINAL_PATH --retained-profile MOVED_PATH --retained-desktop-data MOVED_PATH --app-version VERSION --confirm-closed --include-secrets [--native-state ORIGINAL_PATH --retained-native-state MOVED_PATH ...]
  For genuinely lost original directories, replace all --retained-* options with --originals-missing.
Paths must be absolute. Backup contains plaintext secrets; use encrypted storage. Restore never overwrites a directory.
Quit the app and its servers throughout the operation. Supply every moved-aside root for the offline checks.
Missing-originals recovery additionally checks recognizable app/server processes; custom or renamed servers still require your --confirm-closed attestation.
Original build, user, machine, project paths and external credentials are required for recovery.
Only backups with matching restore-review support can be restored. Older archives remain verifiable.
Guarded restores open with agent work paused for review. Confirm resumption in the app, then restart to enable it.`;

export async function main(argv) {
  if (argv.length === 0 || argv.includes("--help")) { console.log(usage); return; }
  if (platform !== "darwin") fail("This recovery tool currently supports the macOS pilot only.");
  const [command, ...args] = argv;
  const options = { nativeStates: [], retainedNativeStates: [] };
  const names = { "--profile": "profile", "--desktop-data": "desktopData", "--retained-profile": "retainedProfile", "--retained-desktop-data": "retainedDesktopData", "--output": "output", "--backup": "backup", "--app-version": "appVersion" };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--confirm-closed") options.confirmClosed = true;
    else if (flag === "--include-secrets") options.includeSecrets = true;
    else if (flag === "--originals-missing" && !options.originalsMissing) options.originalsMissing = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith("--")) fail(`Missing value for ${flag}.`);
      if (flag === "--native-state") options.nativeStates.push(value);
      else if (flag === "--retained-native-state") options.retainedNativeStates.push(value);
      else if (names[flag] && options[names[flag]] === undefined) options[names[flag]] = value;
      else fail(`Unknown or repeated option: ${flag}`);
    }
  }
  if (command === "backup") {
    const manifest = await createProfileBackup(options);
    const review = manifest.restoreReviewVersion === RESTORE_REVIEW_VERSION
      ? "Restore review supported. Restored agent work stays paused until you confirm resumption and restart."
      : `Restore unavailable for this archive. ${UNGUARDED_BACKUP_GUIDANCE}`;
    console.log(`Verified private backup: ${options.output}\nRoots: ${manifest.roots.map((root) => root.source).join(", ")}\n${review}\nKeep this directory private and on encrypted storage. It contains credentials.`);
  } else if (command === "verify") {
    const manifest = await verifyProfileBackup(options.backup);
    const review = manifest.restoreReviewVersion === RESTORE_REVIEW_VERSION ? "Restore review supported." : `Restore unavailable for this archive. ${UNGUARDED_BACKUP_GUIDANCE}`;
    console.log(`Backup verified. App version: ${manifest.appVersion}. Roots: ${manifest.roots.map((root) => root.source).join(", ")}\n${review}`);
  } else if (command === "restore") {
    const result = await restoreProfileBackup(options);
    console.log(`Restored: ${result.restored.join(", ")}\nOpen the original build to review restored work. Agent work stays paused until you confirm resumption in the app and restart. Reauthenticate external accounts as needed.`);
  } else fail(usage);
}

// macOS /tmp aliases /private/tmp, and users may invoke a symlink to this script.
// Compare the actual files so a supported invocation cannot silently skip main.
const invokedFile = process.argv[1]
  ? await NodeFSP.realpath(NodePath.resolve(process.argv[1])).catch(() => undefined)
  : undefined;
if (invokedFile && invokedFile === await NodeFSP.realpath(NodeURL.fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// Cargo records both the requested revision and resolved commit. Accept only
// an immutable public HTTPS pin, never a branch, tag, or abbreviated revision.
export function pinnedGitSource(source) {
  const match =
    /^git\+(https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\?rev=([a-f0-9]{40})#\2$/.exec(
      source ?? "",
    );
  if (!match) throw new Error("Expected an exact GitHub HTTPS commit pin");
  return { repository: match[1], commit: match[2] };
}

export function readPinnedGitPackage(source, directory) {
  const identity = pinnedGitSource(source);
  if (!directory) throw new Error("Pinned Git package source is unavailable");
  const git = (args) =>
    NodeChildProcess.execFileSync("git", ["-C", directory, ...args], {
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const root = git(["rev-parse", "--show-toplevel"]).toString().trim();
  if (git(["rev-parse", "HEAD"]).toString().trim() !== identity.commit)
    throw new Error("Git checkout differs from the locked commit");
  // Cargo adds this marker when it completes checkout. No other untracked
  // inputs or changed tracked files are acceptable for release provenance.
  const changes = git(["status", "--porcelain", "--untracked-files=all"])
    .toString()
    .split("\n")
    .filter((line) => line && line !== "?? .cargo-ok");
  if (changes.length) throw new Error("Git checkout contains changed or untracked inputs");
  const relative = NodePath.relative(root, NodeFS.realpathSync(directory))
    .split(NodePath.sep)
    .join("/");
  if (relative.startsWith("../") || NodePath.isAbsolute(relative))
    throw new Error("Git package is outside its checkout");
  const prefix = relative ? relative + "/" : "";
  const manifestPath = prefix + "Cargo.toml";
  const entries = new Map();
  for (const line of git(["ls-tree", "--full-tree", "-rz", identity.commit])
    .toString()
    .split("\0")) {
    if (!line) continue;
    const match = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(line);
    if (!match) throw new Error("Unsupported Git tree entry");
    const [, mode, type, object, name] = match;
    entries.set(name, { mode, type, object });
  }
  const readBlob = (name, seen = new Set()) => {
    if (seen.has(name) || seen.size >= 32) throw new Error("Cyclic Git notice link");
    seen.add(name);
    const entry = entries.get(name);
    if (!entry || entry.type !== "blob")
      throw new Error("Git notice target is not a committed file");
    const data = git(["cat-file", "blob", entry.object]);
    const file = NodePath.join(root, name);
    if (entry.mode === "120000") {
      const link = data.toString("utf8");
      const target = NodePath.posix.normalize(
        NodePath.posix.join(NodePath.posix.dirname(name), link),
      );
      if (
        NodePath.posix.isAbsolute(link) ||
        /[\\\0]/.test(link) ||
        target.startsWith("../") ||
        target === ".."
      )
        throw new Error("Git notice link escapes its repository");
      if (!NodeFS.lstatSync(file).isSymbolicLink() || NodeFS.readlinkSync(file) !== link)
        throw new Error("Git notice link differs from its committed target");
      return readBlob(target, seen);
    }
    if (!["100644", "100755"].includes(entry.mode))
      throw new Error("Git notice is not a regular file");
    if (!NodeFS.lstatSync(file).isFile() || !NodeFS.readFileSync(file).equals(data))
      throw new Error("Git notice or manifest differs from its committed bytes");
    return { data, resolvedPath: name };
  };
  const notices = [];
  for (const name of entries.keys()) {
    const inPackage = name.startsWith(prefix);
    const ancestor =
      !name.includes("/") || (relative && relative.startsWith(NodePath.posix.dirname(name) + "/"));
    const notice = /^(?:licen[cs]e|copying|copyright|notice|unlicense)(?:[._-].*)?$/i.test(
      NodePath.posix.basename(name),
    );
    if (notice && (inPackage || ancestor)) notices.push({ path: name, ...readBlob(name) });
  }
  if (!["100644", "100755"].includes(entries.get(manifestPath)?.mode))
    throw new Error("Pinned Git package manifest is missing or not a regular file");
  const manifest = readBlob(manifestPath).data;
  return { ...identity, manifest, notices };
}

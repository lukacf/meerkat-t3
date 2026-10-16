#!/usr/bin/env node
// Validate local documentation links without network access or dependencies.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const markdown = new Map();
async function collect(directory) {
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    const target = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) await collect(target);
    else if (/\.mdx?$/.test(entry.name))
      markdown.set(target, await NodeFSP.readFile(target, "utf8"));
  }
}
await collect(NodePath.join(root, "docs"));
for (const entry of await NodeFSP.readdir(root)) {
  if (/\.md$/.test(entry))
    markdown.set(
      NodePath.join(root, entry),
      await NodeFSP.readFile(NodePath.join(root, entry), "utf8"),
    );
}

function prose(text) {
  let fence;
  return text.split("\n").map((line) => {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (match) {
      if (!fence) fence = match[1][0];
      else if (fence === match[1][0]) fence = undefined;
      return "";
    }
    return fence ? "" : line;
  });
}
function anchors(text) {
  const counts = new Map();
  const ids = new Set();
  for (const line of prose(text)) {
    for (const match of line.matchAll(/(?:id|name)=["']([^"']+)["']/g)) ids.add(match[1]);
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const slug = heading[1]
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]*>/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, "")
      .replace(/\s/g, "-");
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    ids.add(count ? `${slug}-${count}` : slug);
  }
  return ids;
}
const errors = [];
let checked = 0;
for (const [file, text] of markdown) {
  const lines = prose(text);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/`[^`]*`/g, "");
    const links = [
      ...line.matchAll(/\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\)/g),
      ...line.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/g),
    ];
    for (const match of links) {
      const link = match[1];
      if (/^[a-z][a-z\d+.-]*:/i.test(link) || link.startsWith("//")) continue;
      checked++;
      const [rawFile, rawAnchor] = link.split("#", 2);
      let target;
      try {
        target = rawFile
          ? NodePath.resolve(
              rawFile.startsWith("/") ? root : NodePath.dirname(file),
              decodeURIComponent(rawFile.replace(/^\//, "").split("?")[0]),
            )
          : file;
      } catch {
        errors.push(`${NodePath.relative(root, file)}:${index + 1}: invalid URL ${link}`);
        continue;
      }
      const location = `${NodePath.relative(root, file)}:${index + 1}`;
      try {
        if (!(await NodeFSP.stat(target)).isFile() && rawAnchor)
          throw new Error("directory anchor");
        if (rawAnchor && /\.mdx?$/.test(target)) {
          const content = markdown.get(target) ?? (await NodeFSP.readFile(target, "utf8"));
          if (!anchors(content).has(decodeURIComponent(rawAnchor)))
            errors.push(`${location}: missing anchor ${link}`);
        }
      } catch {
        errors.push(`${location}: missing target ${link}`);
      }
    }
  }
}
if (errors.length) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Checked ${checked} local links in ${markdown.size} documentation files.\n`);
}

#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeOS from "node:os";
import { initializeMeerkatProfile } from "../packages/shared/src/meerkatProfile.ts";
import { verifyMeerkatRuntime } from "../packages/shared/src/meerkatRuntime.ts";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const arguments_ = process.argv.slice(2);
const mode = arguments_[0] ?? "web";
if (!["web", "desktop", "serve", "configure"].includes(mode)) {
  throw new Error(
    "Usage: node scripts/meerkat-prototype.mjs [web|desktop|serve|configure] [--home-dir <profile>] [--legacy-profile]",
  );
}
const seen = new Set();
for (let index = 1; index < arguments_.length; index++) {
  const option = arguments_[index];
  if (!["--home-dir", "--legacy-profile"].includes(option))
    throw new Error(`Unknown option: ${option}. Profile import or relocation is not supported.`);
  if (seen.has(option)) throw new Error(`Duplicate option: ${option}.`);
  seen.add(option);
  if (option === "--home-dir") {
    const value = arguments_[++index];
    if (!value || value.startsWith("--")) throw new Error("--home-dir requires a path.");
  }
}
if (seen.has("--home-dir") && seen.has("--legacy-profile"))
  throw new Error("Choose either --home-dir or --legacy-profile, not both.");
const homeFlag = arguments_.indexOf("--home-dir");
const prototypeHome = NodePath.resolve(
  (homeFlag >= 0 ? arguments_[homeFlag + 1] : undefined) ??
    process.env.T3CODE_HOME ??
    (arguments_.includes("--legacy-profile")
      ? NodePath.join(repoRoot, ".meerkat-prototype")
      : NodePath.join(NodeOS.homedir(), ".meerkat-t3")),
);
const legacyHome = NodePath.join(repoRoot, ".meerkat-prototype");
if (homeFlag < 0 && !process.env.T3CODE_HOME && !arguments_.includes("--legacy-profile")) {
  try {
    await NodeFSP.access(NodePath.join(legacyHome, "userdata", "settings.json"));
    console.log(
      `Earlier prototype data is at ${legacyHome}. Use --legacy-profile to continue there, or pass the same path as T3CODE_HOME to the desktop app.`,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const runtimeDirectory = NodePath.resolve(
  process.env.MEERKAT_RUNTIME_DIR ??
    NodePath.join(repoRoot, "apps/server/resources/meerkat-runtime"),
);
await verifyMeerkatRuntime(runtimeDirectory);
await initializeMeerkatProfile(prototypeHome, {
  desktop: mode === "desktop",
  ...(process.env.MEERKAT_PROTOTYPE_PROJECT
    ? { projectPath: await NodeFSP.realpath(process.env.MEERKAT_PROTOTYPE_PROJECT) }
    : {}),
});
console.log(`Meerkat profile: ${prototypeHome}`);
console.log(
  "Open a project's Connections menu to set up API-key credentials or sign in with a configured OAuth profile. Existing conversations and settings stay in this profile.",
);
if (mode === "configure") process.exit(0);

const env = {
  ...process.env,
  T3CODE_HOME: prototypeHome,
  T3CODE_TELEMETRY_ENABLED: "false",
  T3CODE_DISABLE_AUTO_UPDATE: "true",
  MEERKAT_RUNTIME_DIR: runtimeDirectory,
};
// Hosted T3 services and the old app's reverse-tool bridge have no authority
// in this isolated prototype. Preserve model credentials in the environment.
for (const key of Object.keys(env)) {
  if (
    /^(T3CODE|VITE|EXPO_PUBLIC).*?(CLERK|RELAY|OTLP)/.test(key) ||
    key.startsWith("MEERKAT_UI_") ||
    key === "VITE_HTTP_URL" ||
    key === "VITE_WS_URL"
  ) {
    delete env[key];
  }
}
env.PATH = `${NodePath.join(repoRoot, "node_modules", ".bin")}${NodePath.delimiter}${env.PATH ?? ""}`;
const port = process.env.MEERKAT_PROTOTYPE_PORT ?? "3773";
if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) {
  throw new Error("MEERKAT_PROTOTYPE_PORT must be an integer from 1024 to 65535.");
}
const args =
  mode === "serve"
    ? [
        NodePath.join(repoRoot, "apps/server/src/bin.ts"),
        "--base-dir",
        prototypeHome,
        "--no-browser",
        "--port",
        port,
        "--host",
        "127.0.0.1",
      ]
    : [
        NodePath.join(repoRoot, "scripts", "dev-runner.ts"),
        mode === "desktop" ? "dev:desktop" : "dev",
        "--home-dir",
        prototypeHome,
      ];
const child = NodeChildProcess.spawn(process.execPath, args, {
  cwd: repoRoot,
  env,
  stdio: "inherit",
});
if (mode === "serve" && child.pid) {
  await NodeFSP.writeFile(
    NodePath.join(prototypeHome, "server-process.json"),
    `${JSON.stringify({ pid: child.pid, port: Number(port), url: `http://127.0.0.1:${port}` })}\n`,
    { mode: 0o600 },
  );
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});

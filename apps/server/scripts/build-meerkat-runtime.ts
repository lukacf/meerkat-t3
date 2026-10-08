#!/usr/bin/env node
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
// @effect-diagnostics nodeBuiltinImport:off - build-time staging owns its subprocesses and filesystem.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import {
  MEERKAT_RUNTIME_FILES,
  hashMeerkatRuntimeFile,
  meerkatFileHash,
  meerkatTarget,
  validateMeerkatHealth,
  type MeerkatRuntimeManifest,
} from "@t3tools/shared/meerkatRuntime";
import { createMeerkatGatewayClient } from "../src/provider/meerkat/MeerkatGatewayClient.ts";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);

import { lockedMeerkatReleases } from "../../../scripts/lib/meerkat-runtime-lock.ts";

async function run(command: string, args: string[], cwd: string, capture = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd,
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
      shell: false,
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve(output) : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}

export async function stageMeerkatRuntime(input: {
  sourceRoot: string;
  output: string;
  binary?: string;
  build?: boolean;
}) {
  const sourceRoot = await NodeFSP.realpath(input.sourceRoot);
  const lock = await NodeFSP.readFile(NodePath.join(sourceRoot, "core/Cargo.lock"), "utf8");
  const releases = lockedMeerkatReleases(lock);
  const target = meerkatTarget();
  let binary = input.binary;
  if (!binary) {
    if (!input.build)
      throw new Error(
        "Pass --binary <locked consumer gateway> or --build to build it with scripts/repo-cargo --locked.",
      );
    if (HostProcessPlatform.defaultValue() === "win32")
      throw new Error(
        "Building the native consumer requires its POSIX repo-cargo wrapper. On Windows provision a matching prebuilt consumer with --binary.",
      );
    const wrapper = NodePath.join(sourceRoot, "scripts/repo-cargo");
    await run(
      wrapper,
      ["build", "--release", "--locked", "-p", "meerkat-desktop-stdio"],
      sourceRoot,
    );
    const output = await run(wrapper, ["--print-env"], sourceRoot, true);
    const targetDir = /^CARGO_TARGET_DIR=(.+)$/m.exec(output)?.[1];
    if (!targetDir) throw new Error("Consumer build wrapper did not report CARGO_TARGET_DIR.");
    binary = NodePath.join(targetDir, "release", target.binary);
  }
  // Stage beside the destination, then swap only after exact compatibility proof.
  const destination = NodePath.resolve(input.output);
  await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
  const staged = await NodeFSP.mkdtemp(`${destination}.staging-`);
  try {
    await NodeFSP.copyFile(binary, NodePath.join(staged, target.binary));
    await NodeFSP.chmod(NodePath.join(staged, target.binary), 0o755);
    for (const name of MEERKAT_RUNTIME_FILES)
      await NodeFSP.copyFile(NodePath.join(repoRoot, "scripts", name), NodePath.join(staged, name));
    const client = createMeerkatGatewayClient({
      binaryPath: NodePath.join(staged, target.binary),
      cwd: staged,
      env: {
        ...process.env,
        MEERKAT_NODE_PATH: process.execPath,
        MEERKAT_PROJECT_AGENT_PROPOSAL_MCP_SERVER_JS: NodePath.join(
          staged,
          MEERKAT_RUNTIME_FILES[0],
        ),
      },
      requestTimeoutMs: 20_000,
    });
    let identity;
    try {
      identity = validateMeerkatHealth(
        await client.request("system.v1.health"),
        await client.request("system.v1.capabilities"),
      );
      if (
        identity.cargoLockSha256 !== meerkatFileHash(Buffer.from(lock)) ||
        identity.meerkatVersion !== releases.meerkat ||
        identity.mobkitVersion !== releases["meerkat-mobkit"]
      )
        throw new Error(
          "The native executable was not built from this consumer Cargo.lock. Rebuild with --build.",
        );
      if (identity.platform !== target.platform || identity.arch !== target.arch)
        throw new Error(
          "Native gateway target does not match the host. Cross-target staging is not supported by this local build route.",
        );
      const capabilities = (await client.request("system.v1.capabilities")) as {
        capabilities?: { projectAgentProposalTool?: boolean };
      };
      if (capabilities.capabilities?.projectAgentProposalTool !== true)
        throw new Error("Bundled project-agent proposal helper failed its native handshake.");
    } finally {
      await client.close();
    }
    const files: Record<string, string> = {};
    for (const name of [target.binary, ...MEERKAT_RUNTIME_FILES])
      files[name] = await hashMeerkatRuntimeFile(NodePath.join(staged, name));
    const manifest: MeerkatRuntimeManifest = {
      format: 1,
      build: identity,
      binary: target.binary,
      files,
    };
    await NodeFSP.writeFile(
      NodePath.join(staged, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const backup = `${destination}.previous-${process.pid}`;
    let replaced = false;
    try {
      await NodeFSP.rename(destination, backup);
      replaced = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await NodeFSP.rename(staged, destination);
    } catch (error) {
      if (replaced) await NodeFSP.rename(backup, destination);
      throw error;
    }
    if (replaced) await NodeFSP.rm(backup, { recursive: true, force: true });
    return manifest;
  } finally {
    await NodeFSP.rm(staged, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args[i + 1];
  };
  const sourceRoot = value("--source");
  if (!sourceRoot)
    throw new Error(
      "Usage: node scripts/build-meerkat-runtime.ts --source <meerkat-app consumer checkout> [--build | --binary <executable>] [--output <directory>]",
    );
  const binary = value("--binary");
  const result = await stageMeerkatRuntime({
    sourceRoot,
    output: value("--output") ?? NodePath.join(repoRoot, "apps/server/resources/meerkat-runtime"),
    ...(binary ? { binary } : {}),
    build: args.includes("--build"),
  });
  process.stdout.write(
    `Provisioned Meerkat ${result.build.meerkatVersion}, MobKit ${result.build.mobkitVersion} (${result.build.platform}-${result.build.arch}).\n`,
  );
}

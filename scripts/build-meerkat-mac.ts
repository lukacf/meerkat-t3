#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - The release command owns one packaging subprocess.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  createMeerkatMacReleaseEnvironment,
  resolveMeerkatMacReleasePlan,
  type MeerkatMacReleasePlan,
} from "./lib/meerkat-mac-release.ts";

const repoRoot = NodeURL.fileURLToPath(new URL("../", import.meta.url));

async function runPackager(args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(process.execPath, [...args], {
      cwd: repoRoot,
      env,
      stdio: "inherit",
      shell: false,
    });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    const cleanup = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code) => {
      cleanup();
      resolve(code ?? 1);
    });
  });
}

export async function buildMeerkatMac(input: {
  env: NodeJS.ProcessEnv;
  checkOnly?: boolean;
  platform?: string;
  arch?: string;
  run?: typeof runPackager;
}): Promise<{ plan: MeerkatMacReleasePlan; exitCode: number }> {
  const plan = resolveMeerkatMacReleasePlan(input.env);
  const env = createMeerkatMacReleaseEnvironment(plan, input.env);
  if (plan.mode === "signed") {
    const keyPath = env.APPLE_API_KEY!;
    const stat = await NodeFSP.lstat(NodePath.resolve(repoRoot, keyPath)).catch(() => undefined);
    if (!stat?.isFile() || stat.size === 0) {
      throw new Error("APPLE_API_KEY must reference a nonempty regular .p8 file.");
    }
  }
  if (input.checkOnly) return { plan, exitCode: 0 };
  // oxlint-disable-next-line t3code/no-global-process-runtime -- This pre-install CLI has no Effect runtime dependency.
  const platform = input.platform ?? process.platform;
  // oxlint-disable-next-line t3code/no-global-process-runtime -- This pre-install CLI has no Effect runtime dependency.
  const arch = input.arch ?? process.arch;
  if (platform !== "darwin" || arch !== "arm64") {
    throw new Error("This Mac packaging lane requires an Apple Silicon macOS runner.");
  }
  return { plan, exitCode: await (input.run ?? runPackager)(plan.args, env) };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    if (args.length > 1 || (args.length === 1 && args[0] !== "--plan" && args[0] !== "--check")) {
      throw new Error(
        "Usage: node scripts/build-meerkat-mac.ts [--plan | --check]. A local package needs MEERKAT_MAC_RELEASE_MODE and MEERKAT_MAC_RELEASE_VERSION; unsigned needs no Apple credentials.",
      );
    }
    if (args[0] === "--plan") {
      // Public configuration only. Credential availability is checked by --check and every build.
      process.stdout.write(
        `${JSON.stringify(resolveMeerkatMacReleasePlan(process.env), null, 2)}\n`,
      );
    } else {
      const result = await buildMeerkatMac({ env: process.env, checkOnly: args[0] === "--check" });
      process.exitCode = result.exitCode;
      if (args[0] === "--check")
        process.stdout.write(
          "Mac release inputs passed local configuration checks; no packaging or signing ran.\n",
        );
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Mac release configuration failed."}\n`,
    );
    process.exitCode = 1;
  }
}

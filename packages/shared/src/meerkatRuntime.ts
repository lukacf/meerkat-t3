import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
// @effect-diagnostics nodeBuiltinImport:off - runtime bundle verification is a Node-only filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

export const MEERKAT_RUNTIME_FILES = [
  "meerkat-project-agent-proposal-mcp.mjs",
  "meerkat-project-agent-proposal-contract.mjs",
  "meerkat-project-agent-proposal-schema.json",
] as const;
export const MEERKAT_REQUIRED_METHODS = [
  "configs.v1.get",
  "configs.v1.patch",
  "models.v1.catalog",
  "skills.v1.list",
  "auth.v1.status",
  "auth.v1.check",
  "auth.v1.configure",
  "auth.v1.deviceStart",
  "auth.v1.devicePoll",
  "auth.v1.delete",
  "auth.v1.default",
  "auth.v1.loginStart",
  "auth.v1.loginComplete",
  "auth.v1.logout",
  "text.v1.generate",
  "mobs.v1.teamSnapshot",
  "mobs.v1.createThreadMob",
  "mobs.v1.createDomainMob",
  "mobs.v1.domainRevise",
  "mobs.v1.consoleHistory",
  "mobs.v1.consoleSend",
  "mobs.v1.consoleResume",
  "mobs.v1.threadDeliveries",
  "mobs.v1.acknowledgeThreadDelivery",
  "mobs.v1.imageUpload",
  "mobs.v1.imageRead",
] as const;

export interface MeerkatBuildIdentity {
  gatewayVersion: string;
  meerkatVersion: string;
  mobkitVersion: string;
  cargoLockSha256: string;
  platform: string;
  arch: string;
}
export interface MeerkatRuntimeManifest {
  format: 1;
  build: MeerkatBuildIdentity;
  files: Record<string, string>;
  binary: string;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export async function hashMeerkatRuntimeFile(file: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function meerkatTarget(
  platform = HostProcessPlatform.defaultValue(),
  arch = HostProcessArchitecture.defaultValue(),
) {
  if (!["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64"].includes(arch)) {
    throw new Error(
      `Meerkat local runtime does not support ${platform}-${arch}. Use a supported macOS, Linux or Windows arm64/x64 build.`,
    );
  }
  return {
    platform: platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform,
    arch: arch === "arm64" ? "aarch64" : "x86_64",
    binary: platform === "win32" ? "meerkat-desktop-stdio.exe" : "meerkat-desktop-stdio",
  };
}

export function validateMeerkatHealth(
  health: unknown,
  capabilities: unknown,
): MeerkatBuildIdentity {
  if (
    !record(health) ||
    health.ok !== true ||
    health.runtime !== "mobkit" ||
    !record(health.build)
  ) {
    throw new Error(
      "The configured executable is not a compatible Meerkat desktop gateway. Install the runtime bundled with this app.",
    );
  }
  const build = health.build;
  for (const field of [
    "gatewayVersion",
    "meerkatVersion",
    "mobkitVersion",
    "cargoLockSha256",
    "platform",
    "arch",
  ]) {
    if (typeof build[field] !== "string" || !build[field])
      throw new Error(
        `Meerkat gateway build identity is missing ${field}. Rebuild the consumer gateway with its released Cargo.lock.`,
      );
  }
  if (!/^[a-f0-9]{64}$/.test(String(build.cargoLockSha256)))
    throw new Error("Meerkat gateway has an invalid lock identity.");
  if (
    !record(capabilities) ||
    capabilities.contractVersion !== "pure-mobkit-runtime-v1" ||
    !Array.isArray(capabilities.methods)
  ) {
    throw new Error(
      "Meerkat gateway protocol is incompatible with this app. Install its matching runtime bundle.",
    );
  }
  const methods = capabilities.methods;
  const missing = MEERKAT_REQUIRED_METHODS.filter((method) => !methods.includes(method));
  if (missing.length)
    throw new Error(
      `Meerkat gateway is missing required methods: ${missing.join(", ")}. Install its matching runtime bundle.`,
    );
  return build as unknown as MeerkatBuildIdentity;
}

export async function verifyMeerkatRuntime(directory: string): Promise<MeerkatRuntimeManifest> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(directory, "manifest.json"), "utf8"),
    );
  } catch {
    throw new Error(
      `Meerkat runtime is missing at ${directory}. Run the Meerkat runtime provisioning step or reinstall the local app.`,
    );
  }
  if (
    !record(manifest) ||
    manifest.format !== 1 ||
    !record(manifest.files) ||
    !record(manifest.build)
  )
    throw new Error("Invalid Meerkat runtime manifest. Reinstall its matching runtime bundle.");
  const target = meerkatTarget();
  if (
    manifest.build.platform !== target.platform ||
    manifest.build.arch !== target.arch ||
    manifest.binary !== target.binary
  ) {
    throw new Error(
      `Meerkat runtime targets ${String(manifest.build.platform)}-${String(manifest.build.arch)}, but this host is ${target.platform}-${target.arch}. Provision the matching native runtime.`,
    );
  }
  for (const name of [target.binary, ...MEERKAT_RUNTIME_FILES]) {
    const expected = manifest.files[name];
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected))
      throw new Error(`Meerkat runtime manifest is missing ${name}.`);
    let actual: string;
    try {
      actual = await hashMeerkatRuntimeFile(NodePath.join(directory, name));
    } catch {
      throw new Error(`Meerkat runtime is missing ${name}. Reinstall its matching runtime bundle.`);
    }
    if (expected !== actual)
      throw new Error(
        `Meerkat runtime file ${name} does not match its manifest. Reinstall its matching runtime bundle.`,
      );
  }
  await NodeFSP.access(
    NodePath.join(directory, target.binary),
    HostProcessPlatform.defaultValue() === "win32" ? NodeFS.constants.F_OK : NodeFS.constants.X_OK,
  ).catch(() => {
    throw new Error(
      "Meerkat runtime gateway is not executable. Reinstall its matching runtime bundle.",
    );
  });
  return manifest as unknown as MeerkatRuntimeManifest;
}

export async function resolveMeerkatRuntime(input: {
  configuredBinary: string;
  env: NodeJS.ProcessEnv;
  bundledDirectory?: string;
}): Promise<{ binaryPath: string; env: NodeJS.ProcessEnv; manifest?: MeerkatRuntimeManifest }> {
  const defaultName = input.configuredBinary === "meerkat-desktop-stdio";
  const directory =
    input.env.MEERKAT_RUNTIME_DIR || (defaultName ? input.bundledDirectory : undefined);
  if (directory && defaultName && !input.env.MEERKAT_GATEWAY_BINARY) {
    const manifest = await verifyMeerkatRuntime(directory);
    return {
      binaryPath: NodePath.join(directory, manifest.binary),
      manifest,
      env: {
        ...input.env,
        MEERKAT_NODE_PATH: input.env.MEERKAT_NODE_PATH || process.execPath,
        MEERKAT_PROJECT_AGENT_PROPOSAL_MCP_SERVER_JS: NodePath.join(
          directory,
          MEERKAT_RUNTIME_FILES[0],
        ),
      },
    };
  }
  return {
    binaryPath: input.env.MEERKAT_GATEWAY_BINARY || input.configuredBinary,
    env: input.env,
  };
}

export function assertMeerkatBundleBuild(
  actual: MeerkatBuildIdentity,
  manifest: MeerkatRuntimeManifest,
) {
  for (const key of Object.keys(manifest.build) as Array<keyof MeerkatBuildIdentity>) {
    if (actual[key] !== manifest.build[key])
      throw new Error(
        `Meerkat gateway ${key} differs from its packaged manifest. Reinstall the matching runtime bundle.`,
      );
  }
}

export { sha256 as meerkatFileHash };

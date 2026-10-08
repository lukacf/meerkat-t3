// @effect-diagnostics nodeBuiltinImport:off - these tests exercise isolated real filesystem bundles and profiles.
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  MEERKAT_REQUIRED_METHODS,
  MEERKAT_RUNTIME_FILES,
  assertMeerkatBundleBuild,
  meerkatFileHash,
  meerkatTarget,
  resolveMeerkatRuntime,
  validateMeerkatHealth,
  verifyMeerkatRuntime,
} from "./meerkatRuntime.ts";
import { configureMeerkatProfile, initializeMeerkatProfile } from "./meerkatProfile.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
const temp = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "meerkat-package-"));
  roots.push(root);
  return root;
};
const identity = () => ({
  gatewayVersion: "0.1.0",
  meerkatVersion: "0.8.42",
  mobkitVersion: "0.8.42",
  cargoLockSha256: "a".repeat(64),
  platform: meerkatTarget().platform,
  arch: meerkatTarget().arch,
});
const health = () => ({ ok: true, runtime: "mobkit", build: identity() });
const capabilities = () => ({
  contractVersion: "pure-mobkit-runtime-v1",
  methods: [...MEERKAT_REQUIRED_METHODS],
});

async function fixture() {
  const root = await temp();
  const files: Record<string, string> = {};
  for (const file of [meerkatTarget().binary, ...MEERKAT_RUNTIME_FILES]) {
    await NodeFSP.writeFile(NodePath.join(root, file), `fixture:${file}`, { mode: 0o755 });
    files[file] = meerkatFileHash(Buffer.from(`fixture:${file}`));
  }
  const manifest = { format: 1, build: identity(), binary: meerkatTarget().binary, files };
  await NodeFSP.writeFile(NodePath.join(root, "manifest.json"), JSON.stringify(manifest));
  return { root, manifest };
}

describe("Meerkat runtime bundle", () => {
  it("resolves a relocated complete runtime and bundled helper without a source checkout", async () => {
    const { root } = await fixture();
    const runtime = await resolveMeerkatRuntime({
      configuredBinary: "meerkat-desktop-stdio",
      env: { MEERKAT_RUNTIME_DIR: root },
    });
    expect(runtime.binaryPath).toBe(NodePath.join(root, meerkatTarget().binary));
    expect(runtime.env.MEERKAT_PROJECT_AGENT_PROPOSAL_MCP_SERVER_JS).toBe(
      NodePath.join(root, MEERKAT_RUNTIME_FILES[0]),
    );
    expect(runtime.env.MEERKAT_NODE_PATH).toBe(process.execPath);
    expect(runtime.manifest?.build.cargoLockSha256).toBe(identity().cargoLockSha256);
  });
  it("rejects altered native bytes and missing helper assets", async () => {
    const first = await fixture();
    await NodeFSP.writeFile(NodePath.join(first.root, meerkatTarget().binary), "changed");
    await expect(verifyMeerkatRuntime(first.root)).rejects.toThrow("does not match");
    const second = await fixture();
    await NodeFSP.rm(NodePath.join(second.root, MEERKAT_RUNTIME_FILES[1]));
    await expect(verifyMeerkatRuntime(second.root)).rejects.toThrow("missing meerkat-project");
  });
  it("rejects foreign platform/arch and unsupported hosts clearly", async () => {
    const { root, manifest } = await fixture();
    manifest.build.arch = "universal";
    await NodeFSP.writeFile(NodePath.join(root, "manifest.json"), JSON.stringify(manifest));
    await expect(verifyMeerkatRuntime(root)).rejects.toThrow("Provision the matching");
    expect(() => meerkatTarget("aix", "ppc64")).toThrow("does not support");
  });
  it("checks exact gateway identity and required capabilities before use", () => {
    expect(validateMeerkatHealth(health(), capabilities())).toEqual(identity());
    expect(() => validateMeerkatHealth({}, capabilities())).toThrow("not a compatible");
    const old = capabilities();
    old.methods = old.methods.filter((method) => method !== "mobs.v1.domainRevise");
    expect(() => validateMeerkatHealth(health(), old)).toThrow("mobs.v1.domainRevise");
    expect(() =>
      assertMeerkatBundleBuild(identity(), {
        format: 1,
        build: { ...identity(), mobkitVersion: "0.1.0" },
        files: {},
        binary: "gateway",
      }),
    ).toThrow("mobkitVersion");
  });
  it("preserves explicit executable overrides", async () => {
    const resolved = await resolveMeerkatRuntime({
      configuredBinary: "/custom/gateway",
      env: { MEERKAT_RUNTIME_DIR: "/missing" },
    });
    expect(resolved.binaryPath).toBe("/custom/gateway");
    expect(resolved.manifest).toBeUndefined();
  });
});

describe("Meerkat profile startup and upgrade", () => {
  it("initializes a clean isolated home with bundled runtime resolution", async () => {
    const root = await temp();
    await initializeMeerkatProfile(root, { desktop: true });
    const settings = JSON.parse(
      await NodeFSP.readFile(NodePath.join(root, "userdata/settings.json"), "utf8"),
    );
    expect(settings.providerInstances.meerkat).toMatchObject({
      driver: "meerkat",
      enabled: true,
      config: { gatewayBinaryPath: "meerkat-desktop-stdio" },
    });
    expect(settings.enableAgentBrowserAccess).toBe(true);
    expect(settings.providerInstances.codex.enabled).toBe(false);
  });
  it("upgrades populated profile configuration in place without changing history, identities, connections or images", async () => {
    const root = await temp();
    const nativeState = NodePath.join(root, "native-existing");
    const old = {
      theme: "dark",
      defaultModelSelection: { instanceId: "meerkat", model: "openai:existing" },
      providerInstances: {
        meerkat: {
          driver: "meerkat",
          enabled: false,
          config: {
            gatewayBinaryPath: "/old/checkout/gateway",
            stateRoot: nativeState,
            projectPath: "/existing/project",
          },
        },
        custom: { driver: "custom", enabled: true, config: {} },
      },
    };
    await NodeFSP.mkdir(NodePath.join(root, "userdata"), { recursive: true });
    await NodeFSP.mkdir(nativeState, { recursive: true });
    const fixtures = {
      "conversation.json": JSON.stringify({ session: "stable", messages: ["original"] }),
      "connections.json": JSON.stringify({ from: "stable", to: "peer" }),
      "image.png": "image-bytes",
    };
    for (const [name, bytes] of Object.entries(fixtures))
      await NodeFSP.writeFile(NodePath.join(nativeState, name), bytes);
    await NodeFSP.writeFile(NodePath.join(root, "userdata/settings.json"), JSON.stringify(old));
    await initializeMeerkatProfile(root, { desktop: true });
    const settings = JSON.parse(
      await NodeFSP.readFile(NodePath.join(root, "userdata/settings.json"), "utf8"),
    );
    expect(settings).toMatchObject({
      theme: "dark",
      defaultModelSelection: old.defaultModelSelection,
      providerInstances: {
        meerkat: {
          enabled: false,
          config: {
            gatewayBinaryPath: "meerkat-desktop-stdio",
            stateRoot: nativeState,
            projectPath: "/existing/project",
          },
        },
        custom: old.providerInstances.custom,
      },
    });
    for (const [name, bytes] of Object.entries(fixtures))
      expect(await NodeFSP.readFile(NodePath.join(nativeState, name), "utf8")).toBe(bytes);
    const before = await NodeFSP.readFile(NodePath.join(root, "userdata/settings.json"), "utf8");
    await initializeMeerkatProfile(root, { desktop: false, onlyIfMissing: true });
    expect(await NodeFSP.readFile(NodePath.join(root, "userdata/settings.json"), "utf8")).toBe(
      before,
    );
  });
  it("refuses corrupt settings instead of replacing them", async () => {
    expect(() => configureMeerkatProfile([], { desktop: true })).toThrow("JSON object");
    const root = await temp();
    await NodeFSP.mkdir(NodePath.join(root, "userdata"));
    const file = NodePath.join(root, "userdata/settings.json");
    await NodeFSP.writeFile(file, "broken");
    await expect(initializeMeerkatProfile(root, { desktop: true })).rejects.toThrow();
    expect(await NodeFSP.readFile(file, "utf8")).toBe("broken");
  });
});

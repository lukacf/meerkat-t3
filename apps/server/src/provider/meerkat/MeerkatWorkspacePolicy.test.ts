// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { MeerkatGatewayClient } from "./MeerkatGatewayClient.ts";
import { createMeerkatWorkspacePreparer } from "./MeerkatWorkspacePolicy.ts";

const roots: string[] = [];
async function fixture() {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "meerkat-policy-")),
  );
  roots.push(root);
  const stateRoot = NodePath.join(root, "private-state");
  await NodeFSP.mkdir(stateRoot);
  const request = vi.fn<MeerkatGatewayClient["request"]>(async (_method, params) => ({
    host: {
      placement: "local",
      stateRoot: params?.stateRoot,
      realmId: params?.projectPath === "/project-b" ? "ws-native-b" : "ws-native-a",
    },
  }));
  const client: MeerkatGatewayClient = {
    pid: undefined,
    request,
    subscribe: () => () => {},
    onClose: () => () => {},
    close: async () => {},
  };
  return { root, stateRoot, client, request };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("MeerkatWorkspacePolicy", () => {
  it("requires explicit opt-in before looking up or writing configuration", async () => {
    const f = await fixture();
    await createMeerkatWorkspacePreparer(f.client)("/project-a", f.stateRoot);
    expect(f.request).not.toHaveBeenCalled();
    expect(await NodeFSP.readdir(f.stateRoot)).toEqual([]);
  });

  it("uses native realm identities and keeps each project and shared config isolated", async () => {
    const f = await fixture();
    const globalPath = NodePath.join(f.root, "shared-config.toml");
    const shared = "[model_fallback]\nenabled = true\n";
    await NodeFSP.writeFile(globalPath, shared);
    const prepare = createMeerkatWorkspacePreparer(f.client, "selected-model-only");
    await Promise.all([prepare("/project-a", f.stateRoot), prepare("/project-b", f.stateRoot)]);
    for (const realm of ["ws-native-a", "ws-native-b"]) {
      const configPath = NodePath.join(f.stateRoot, realm, "config.toml");
      expect(await NodeFSP.readFile(configPath, "utf8")).toBe(
        "[model_fallback]\nenabled = false\n",
      );
      expect((await NodeFSP.stat(configPath)).mode & 0o777).toBe(0o600);
      expect(await NodeFSP.readdir(NodePath.dirname(configPath))).toEqual(["config.toml"]);
    }
    expect(await NodeFSP.readFile(globalPath, "utf8")).toBe(shared);
  });

  it("preserves customized realm bytes across repeated and concurrent initialization", async () => {
    const f = await fixture();
    const realmRoot = NodePath.join(f.stateRoot, "ws-native-a");
    await NodeFSP.mkdir(realmRoot);
    const custom =
      "# operator policy\n[model_fallback]\nenabled = true\n[[model_fallback.chain]]\nmodel = 'backup'\n";
    const configPath = NodePath.join(realmRoot, "config.toml");
    await NodeFSP.writeFile(configPath, custom);
    const prepare = createMeerkatWorkspacePreparer(f.client, "selected-model-only");
    await Promise.all(Array.from({ length: 8 }, () => prepare("/project-a", f.stateRoot)));
    await prepare("/project-a", f.stateRoot);
    expect(await NodeFSP.readFile(configPath, "utf8")).toBe(custom);
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it("publishes complete config once when independent preparers race", async () => {
    const f = await fixture();
    await Promise.all(
      Array.from({ length: 12 }, () =>
        createMeerkatWorkspacePreparer(f.client, "selected-model-only")("/project-a", f.stateRoot),
      ),
    );
    const realmRoot = NodePath.join(f.stateRoot, "ws-native-a");
    expect(await NodeFSP.readdir(realmRoot)).toEqual(["config.toml"]);
    expect(await NodeFSP.readFile(NodePath.join(realmRoot, "config.toml"), "utf8")).toBe(
      "[model_fallback]\nenabled = false\n",
    );
  });

  it("propagates native lookup failure without writing and permits a later explicit retry", async () => {
    const f = await fixture();
    f.request.mockRejectedValueOnce(new Error("Native identity unavailable"));
    const prepare = createMeerkatWorkspacePreparer(f.client, "selected-model-only");
    await expect(prepare("/project-a", f.stateRoot)).rejects.toThrow("Native identity unavailable");
    expect(await NodeFSP.readdir(f.stateRoot)).toEqual([]);
    await prepare("/project-a", f.stateRoot);
    expect(await NodeFSP.readdir(f.stateRoot)).toEqual(["ws-native-a"]);
  });

  it("rejects a global or escaping native realm and a symlinked realm directory", async () => {
    const f = await fixture();
    for (const realmId of ["global", "../outside", "/outside"]) {
      f.request.mockResolvedValueOnce({
        host: { placement: "local", stateRoot: f.stateRoot, realmId },
      });
      await expect(
        createMeerkatWorkspacePreparer(f.client, "selected-model-only")("/project-a", f.stateRoot),
      ).rejects.toThrow("invalid private workspace configuration location");
    }
    const outside = NodePath.join(f.root, "outside");
    await NodeFSP.mkdir(outside);
    await NodeFSP.symlink(outside, NodePath.join(f.stateRoot, "ws-native-a"));
    await expect(
      createMeerkatWorkspacePreparer(f.client, "selected-model-only")("/project-a", f.stateRoot),
    ).rejects.toThrow("must not be a symlink");
    expect(await NodeFSP.readdir(outside)).toEqual([]);
  });
});

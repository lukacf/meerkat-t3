// @effect-diagnostics nodeBuiltinImport:off - isolated executable fixtures exercise the real stdio transport and bundle filesystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  MEERKAT_REQUIRED_METHODS,
  MEERKAT_RUNTIME_FILES,
  meerkatFileHash,
  meerkatTarget,
  verifyMeerkatRuntime,
} from "@t3tools/shared/meerkatRuntime";
import { stageMeerkatRuntime } from "./build-meerkat-runtime.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
async function fixture(
  change: "none" | "lock" | "methods" | "mobkit-version" = "none",
  mobkitPackage: "meerkat-meta" | "meerkat-mobkit" = "meerkat-meta",
) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "meerkat-stage-"));
  roots.push(root);
  const version = mobkitPackage === "meerkat-meta" ? "0.9.1" : "0.8.42";
  const lock = ["meerkat", mobkitPackage]
    .map(
      (name) =>
        `[[package]]\nname = "${name}"\nversion = "${version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${"a".repeat(64)}"\n`,
    )
    .join("\n");
  await NodeFSP.mkdir(NodePath.join(root, "consumer/core"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, "consumer/core/Cargo.lock"), lock);
  const build = {
    gatewayVersion: "0.1.0",
    meerkatVersion: version,
    mobkitVersion: change === "mobkit-version" ? "0.8.49" : version,
    cargoLockSha256: change === "lock" ? "b".repeat(64) : meerkatFileHash(Buffer.from(lock)),
    platform: meerkatTarget().platform,
    arch: meerkatTarget().arch,
  };
  const executable = NodePath.join(root, "fixture-gateway");
  const responses = {
    "system.v1.health": { ok: true, runtime: "mobkit", build },
    "system.v1.capabilities": {
      contractVersion: "pure-mobkit-runtime-v1",
      methods: change === "methods" ? [] : MEERKAT_REQUIRED_METHODS,
      capabilities: { projectAgentProposalTool: true },
    },
  };
  await NodeFSP.writeFile(
    executable,
    `#!${process.execPath}\nconst readline=require('node:readline');\nconst results=${JSON.stringify(responses)};\nconst lines=readline.createInterface({input:process.stdin});\nlines.on('line',(line)=>{const m=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:results[m.method]})+'\\n');});\nlines.on('close',()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'system.v1.shutdownComplete',params:{cleanupCompleted:true}})+'\\n'));\n`,
    { mode: 0o755 },
  );
  return {
    root,
    sourceRoot: NodePath.join(root, "consumer"),
    binary: executable,
    output: NodePath.join(root, "bundle"),
  };
}

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")("Meerkat runtime staging", () => {
  it("stages a released meerkat-meta gateway with the existing MobKit wire identity", async () => {
    const input = await fixture();
    const staged = await stageMeerkatRuntime(input);
    const verified = await verifyMeerkatRuntime(input.output);
    expect(verified).toEqual(staged);
    expect(verified.build.mobkitVersion).toBe("0.9.1");
    for (const name of MEERKAT_RUNTIME_FILES)
      expect(await NodeFSP.readFile(NodePath.join(input.output, name), "utf8")).toContain(
        name.endsWith(".json") ? '"' : "export",
      );
    expect(JSON.stringify(verified)).not.toContain(input.root);
    const relocated = NodePath.join(input.root, "relocated");
    await NodeFSP.rename(input.output, relocated);
    await NodeFSP.rm(input.sourceRoot, { recursive: true });
    expect(await verifyMeerkatRuntime(relocated)).toEqual(staged);
  });
  it("can still stage an exact legacy MobKit gateway", async () => {
    const input = await fixture("none", "meerkat-mobkit");
    const staged = await stageMeerkatRuntime(input);
    expect(staged.build.mobkitVersion).toBe("0.8.42");
    expect(await verifyMeerkatRuntime(input.output)).toEqual(staged);
  });
  for (const change of ["lock", "methods", "mobkit-version"] as const)
    it(`keeps an existing bundle when ${change} validation fails`, async () => {
      const input = await fixture(change);
      await NodeFSP.mkdir(input.output);
      await NodeFSP.writeFile(NodePath.join(input.output, "existing"), "preserve");
      await expect(stageMeerkatRuntime(input)).rejects.toThrow(
        change === "methods" ? "missing required methods" : "Cargo.lock",
      );
      expect(await NodeFSP.readFile(NodePath.join(input.output, "existing"), "utf8")).toBe(
        "preserve",
      );
      expect((await NodeFSP.readdir(input.root)).some((name) => name.includes(".staging-"))).toBe(
        false,
      );
    });
});

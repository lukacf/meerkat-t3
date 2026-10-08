// @effect-diagnostics nodeBuiltinImport:off - private prototype configuration bootstrap uses atomic no-replace filesystem publication.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

import type { MeerkatGatewayClient } from "./MeerkatGatewayClient.ts";

export const MeerkatWorkspacePolicy = Schema.Literal("selected-model-only");
export type MeerkatWorkspacePolicy = typeof MeerkatWorkspacePolicy.Type;
export type MeerkatWorkspacePreparer = (projectPath: string, stateRoot: string) => Promise<void>;

const decodeRuntimeInfo = Schema.decodeUnknownSync(
  Schema.Struct({
    host: Schema.Struct({
      placement: Schema.Literal("local"),
      stateRoot: Schema.String,
      realmId: Schema.String,
    }),
  }),
);
const hasCode = Schema.is(Schema.Struct({ code: Schema.String }));
const initialConfig = "[model_fallback]\nenabled = false\n";

/** Explicit prototype bootstrap only; existing realm policy remains operator-owned. */
export function createMeerkatWorkspacePreparer(
  client: MeerkatGatewayClient,
  policy?: MeerkatWorkspacePolicy,
): MeerkatWorkspacePreparer {
  const pending = new Map<string, Promise<void>>();
  const prepare = async (projectPath: string, stateRoot: string) => {
    const { host } = decodeRuntimeInfo(
      await client.request("system.v1.projectRuntimeInfo", {
        projectPath,
        executionPath: projectPath,
        executionMode: "local",
        stateRoot,
      }),
    );
    if (
      !NodePath.isAbsolute(host.stateRoot) ||
      host.stateRoot !== (await NodeFSP.realpath(stateRoot)) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(host.realmId) ||
      host.realmId === "global"
    ) {
      throw new Error("Meerkat returned an invalid private workspace configuration location.");
    }
    const realmRoot = NodePath.join(host.stateRoot, host.realmId);
    const configPath = NodePath.join(realmRoot, "config.toml");
    try {
      await NodeFSP.lstat(configPath);
      return;
    } catch (error) {
      if (!hasCode(error) || error.code !== "ENOENT") throw error;
    }
    await NodeFSP.mkdir(realmRoot, { recursive: true, mode: 0o700 });
    if ((await NodeFSP.realpath(realmRoot)) !== realmRoot) {
      throw new Error("Meerkat private realm configuration directory must not be a symlink.");
    }
    const temporaryPath = NodePath.join(realmRoot, `.config-bootstrap-${NodeCrypto.randomUUID()}`);
    const file = await NodeFSP.open(temporaryPath, "wx", 0o600);
    try {
      try {
        await file.writeFile(initialConfig, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        // link publishes complete bytes atomically and cannot replace a winner.
        await NodeFSP.link(temporaryPath, configPath);
      } catch (error) {
        if (!hasCode(error) || error.code !== "EEXIST") throw error;
      }
    } finally {
      await NodeFSP.unlink(temporaryPath);
    }
  };
  return (projectPath, stateRoot) => {
    if (policy === undefined) return Promise.resolve();
    const key = JSON.stringify([projectPath, stateRoot]);
    const existing = pending.get(key);
    if (existing) return existing;
    const operation = prepare(projectPath, stateRoot).finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  };
}

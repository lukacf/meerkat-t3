// @effect-diagnostics nodeBuiltinImport:off - this opt-in integration test owns an isolated native child and its temporary account store.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { MeerkatAuthConnection, MeerkatAuthOverview } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { projectMeerkatModels } from "../Drivers/MeerkatDriver.ts";
import { createMeerkatGatewayClient, MeerkatGatewayRpcError } from "./MeerkatGatewayClient.ts";

const binaryPath = process.env.T3CODE_TEST_MEERKAT_BINARY;
const decodeOverview = Schema.decodeUnknownSync(
  Schema.Struct({
    ...MeerkatAuthOverview.fields,
    contractVersion: Schema.String,
    realmId: Schema.String,
  }),
);
const decodeConfigured = Schema.decodeUnknownSync(
  Schema.Struct({ connection: MeerkatAuthConnection }),
);
const decodeChecked = Schema.decodeUnknownSync(
  Schema.Struct({ checked: Schema.Literal(true), connection: MeerkatAuthConnection }),
);

const fixtureSecrets = [
  "native-auth-fixture-work-first",
  "native-auth-fixture-work-second",
  "native-auth-fixture-work-replacement",
  "native-auth-fixture-azure",
  "native-auth-fixture-rejected",
] as const;

function expectSecretFree(value: unknown): void {
  const serialized = JSON.stringify(value, (_key, item: unknown) =>
    item instanceof Error
      ? { ...item, name: item.name, message: item.message, stack: item.stack, cause: item.cause }
      : item,
  );
  for (const secret of fixtureSecrets) {
    expect(serialized?.includes(secret) ?? false, "Native auth must not return credentials").toBe(
      false,
    );
  }
}

function identity(connection: MeerkatAuthConnection) {
  return {
    provider: connection.provider,
    realmId: connection.realmId,
    bindingId: connection.bindingId,
    profileId: connection.profileId,
  };
}

async function filesContain(directory: string, value: string): Promise<boolean> {
  const entries = await NodeFSP.readdir(directory, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    },
  );
  for (const entry of entries) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory() && (await filesContain(path, value))) return true;
    if (entry.isFile() && (await NodeFSP.readFile(path)).includes(value)) return true;
  }
  return false;
}

async function nativeAuthFixture() {
  if (!binaryPath) throw new Error("Set T3CODE_TEST_MEERKAT_BINARY to the native test executable");
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "meerkat-auth-native-")),
  );
  const home = NodePath.join(root, "home");
  const authRoot = NodePath.join(root, "credentials");
  const workspace = NodePath.join(root, "workspace");
  const temporary = NodePath.join(root, "tmp");
  await Promise.all([home, workspace, temporary].map((path) => NodeFSP.mkdir(path)));
  // Deliberately do not inherit provider keys, proxy settings, or user config.
  // The debug-only native file-store override fails closed in release builds.
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: NodePath.join(root, "config"),
    XDG_DATA_HOME: NodePath.join(root, "data"),
    XDG_CACHE_HOME: NodePath.join(root, "cache"),
    TMPDIR: temporary,
    MEERKAT_DESKTOP_TEST_AUTH_ROOT: authRoot,
  };
  const events: unknown[] = [];
  const start = () => {
    const child = createMeerkatGatewayClient({
      binaryPath,
      cwd: workspace,
      env,
      requestTimeoutMs: 10_000,
      shutdownTimeoutMs: 5_000,
    });
    child.subscribe((event) => events.push(event));
    return child;
  };
  let client = start();
  const request = async (method: string, params: Readonly<Record<string, unknown>> = {}) => {
    try {
      const result = await client.request(method, params);
      expectSecretFree(result);
      return result;
    } catch (error) {
      expectSecretFree(error);
      throw error;
    }
  };
  const overview = async () => decodeOverview(await request("auth.v1.status"));
  return {
    root,
    home,
    workspace,
    request,
    overview,
    configure: async (params: Readonly<Record<string, unknown>>) =>
      decodeConfigured(await request("auth.v1.configure", params)).connection,
    check: async (connection: MeerkatAuthConnection) =>
      decodeChecked(await request("auth.v1.check", identity(connection))).connection,
    models: async () => projectMeerkatModels(await request("models.v1.catalog"), await overview()),
    stored: (secret: string) => filesContain(authRoot, secret),
    config: () => NodeFSP.readFile(NodePath.join(home, ".rkat", "config.toml"), "utf8"),
    restart: async () => {
      await client.close();
      client = start();
    },
    close: async () => {
      try {
        await client.close();
        expectSecretFree(events);
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  };
}

describe.skipIf(!binaryPath)("native provider account authentication", () => {
  it("discovers native account methods before any project without writing configuration", async () => {
    const fixture = await nativeAuthFixture();
    try {
      const status = await fixture.overview();
      expect(status).toMatchObject({
        contractVersion: "desktop-provider-auth.v2",
        realmId: "global",
        connections: [],
      });
      expect(status.methods?.map(({ id, flow }) => ({ id, flow }))).toEqual(
        expect.arrayContaining([
          { id: "openai-chatgpt", flow: "browser" },
          { id: "anthropic-claude", flow: "browser" },
          { id: "google-account", flow: "browser" },
          { id: "github-copilot", flow: "device" },
          { id: "openai-api-key", flow: "secret" },
          { id: "anthropic-api-key", flow: "secret" },
          { id: "google-api-key", flow: "secret" },
          { id: "azure-openai-api-key", flow: "secret" },
          { id: "bedrock-bearer", flow: "secret" },
          { id: "foundry-api-key", flow: "secret" },
        ]),
      );
      expect(
        status.methods?.every((method) => method.fields.some((field) => field.key === "name")),
      ).toBe(true);
      expect(status.methods?.find((method) => method.id === "openai-chatgpt")?.callback).toEqual({
        redirectHost: "localhost",
        path: "/auth/callback",
        ports: [1455, 1457],
      });
      expect(
        status.methods
          ?.filter((method) => method.flow !== "browser")
          .every((method) => method.callback === undefined),
      ).toBe(true);
      expect((await fixture.models()).some((model) => model.credentialState === "connected")).toBe(
        false,
      );
      await expect(fixture.config()).rejects.toMatchObject({ code: "ENOENT" });
      expect(await NodeFSP.readdir(fixture.workspace)).toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("persists named accounts, exact replacements and default-bound model access across restart", async () => {
    const fixture = await nativeAuthFixture();
    try {
      const first = await fixture.configure({
        methodId: "openai-api-key",
        fields: { name: "Work account" },
        secret: fixtureSecrets[0],
      });
      const second = await fixture.configure({
        methodId: "openai-api-key",
        fields: { name: "Work account" },
        secret: fixtureSecrets[1],
      });
      expect(first).toMatchObject({
        realmId: "global",
        accountLabel: "Work account",
        profileId: "Work-account",
        state: "connected",
        isDefault: true,
        modelsVerified: false,
      });
      expect(second).toMatchObject({
        accountLabel: "Work account 2",
        profileId: "Work-account-2",
        state: "connected",
        isDefault: false,
        modelsVerified: false,
      });
      expect(second.bindingId).not.toBe(first.bindingId);
      expect(first.models?.length).toBeGreaterThan(0);
      expect(first.models?.some((model) => model.recommended)).toBe(true);
      expect(await fixture.stored(fixtureSecrets[0])).toBe(true);
      expect(await fixture.stored(fixtureSecrets[1])).toBe(true);
      expectSecretFree(await fixture.config());

      await expect(fixture.request("auth.v1.default", identity(second))).resolves.toEqual({
        updated: true,
      });
      expect(
        (await fixture.overview()).connections
          .filter((connection) => connection.isDefault)
          .map(identity),
      ).toEqual([identity(second)]);
      const replaced = await fixture.configure({
        methodId: "openai-api-key",
        ...identity(second),
        secret: fixtureSecrets[2],
      });
      expect(identity(replaced)).toEqual(identity(second));
      expect(replaced.state).toBe("connected");
      expect(await fixture.stored(fixtureSecrets[1])).toBe(false);
      expect(await fixture.stored(fixtureSecrets[2])).toBe(true);
      expect(await fixture.stored(fixtureSecrets[0])).toBe(true);

      const azure = await fixture.configure({
        methodId: "azure-openai-api-key",
        fields: {
          name: "Deployment account",
          endpoint: "https://fixture.invalid",
          model: "fixture-deployment",
        },
        secret: fixtureSecrets[3],
      });
      expect(azure.models?.map((model) => model.id)).toEqual(["fixture-deployment"]);
      await fixture.request("auth.v1.default", identity(azure));
      const usableOpenAiModels = async () =>
        (await fixture.models())
          .filter(
            (model) => model.subProvider === "openai" && model.credentialState === "connected",
          )
          .map((model) => model.slug);
      expect(await usableOpenAiModels()).toEqual(["openai:fixture-deployment"]);

      await fixture.restart();
      let status = await fixture.overview();
      expect(status.connections).toHaveLength(3);
      expect(status.connections.map(identity)).toEqual(
        expect.arrayContaining([identity(first), identity(second), identity(azure)]),
      );
      expect(status.connections.find((connection) => connection.isDefault)?.bindingId).toBe(
        azure.bindingId,
      );
      expect(status.connections.every((connection) => connection.state === "connected")).toBe(true);
      expect(await usableOpenAiModels()).toEqual(["openai:fixture-deployment"]);
      expect(await fixture.stored(fixtureSecrets[2])).toBe(true);
      // File-backed status remains noninteractive and can observe credentials
      // across processes. Explicit checks also restore the exact native lease.
      const configBeforeCheck = await fixture.config();
      const checked = await fixture.check(second);
      expect(identity(checked)).toEqual(identity(second));
      expect(checked.state).toBe("connected");
      expect(await fixture.config()).toBe(configBeforeCheck);
      expect(await fixture.stored(fixtureSecrets[2])).toBe(true);

      expect(azure.supportsRemoval).toBe(true);
      await expect(fixture.request("auth.v1.delete", identity(azure))).resolves.toMatchObject({
        deleted: true,
      });
      expect(await fixture.stored(fixtureSecrets[3])).toBe(false);
      await fixture.restart();
      status = await fixture.overview();
      expect(status.connections).toHaveLength(2);
      expect(
        status.connections.find((connection) => connection.bindingId === azure.bindingId),
      ).toBeUndefined();
      expect(
        status.connections.find((connection) => connection.bindingId === second.bindingId)?.state,
      ).toBe("connected");
      expect(await usableOpenAiModels()).not.toContain("openai:fixture-deployment");

      await fixture.request("auth.v1.default", identity(first));
      expect((await usableOpenAiModels()).length).toBeGreaterThan(0);
      expect(await usableOpenAiModels()).not.toContain("openai:fixture-deployment");
      await fixture.request("auth.v1.logout", identity(first));
      await fixture.restart();
      status = await fixture.overview();
      expect(
        status.connections.find((connection) => connection.bindingId === first.bindingId),
      ).toMatchObject({ state: "needs_auth", isDefault: true });
      expect(await fixture.check(first)).toMatchObject({ state: "needs_auth", isDefault: true });
      expect(await fixture.stored(fixtureSecrets[0])).toBe(false);
      expect(
        status.connections.find((connection) => connection.bindingId === second.bindingId)?.state,
      ).toBe("connected");
      expect(await usableOpenAiModels()).toEqual([]);
      await fixture.request("auth.v1.default", identity(second));
      expect((await usableOpenAiModels()).length).toBeGreaterThan(0);
      expectSecretFree(await fixture.config());
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it("rejects invalid forms and mismatched identity without leaking or changing credentials", async () => {
    const fixture = await nativeAuthFixture();
    try {
      for (const input of [
        { methodId: "openai-api-key" },
        { methodId: "openai-chatgpt", secret: fixtureSecrets[4] },
        {
          methodId: "openai-api-key",
          secret: fixtureSecrets[4],
          fields: { unexpected: fixtureSecrets[4] },
        },
        {
          methodId: "azure-openai-api-key",
          secret: fixtureSecrets[4],
          fields: {
            endpoint: `https://fixture.invalid?key=${fixtureSecrets[4]}`,
            model: "fixture-deployment",
          },
        },
      ]) {
        await expect(fixture.request("auth.v1.configure", input)).rejects.toBeInstanceOf(
          MeerkatGatewayRpcError,
        );
      }
      expect((await fixture.overview()).connections).toEqual([]);
      await expect(fixture.config()).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fixture.stored(fixtureSecrets[4])).toBe(false);

      const connected = await fixture.configure({
        methodId: "openai-api-key",
        secret: fixtureSecrets[0],
      });
      const config = await fixture.config();
      for (const wrongTarget of [
        { ...identity(connected), provider: "anthropic" },
        { ...identity(connected), profileId: "different-profile" },
      ]) {
        for (const method of [
          "auth.v1.logout",
          "auth.v1.delete",
          "auth.v1.default",
          "auth.v1.check",
        ]) {
          await expect(fixture.request(method, wrongTarget)).rejects.toBeInstanceOf(
            MeerkatGatewayRpcError,
          );
        }
        await expect(
          fixture.request("auth.v1.configure", {
            ...wrongTarget,
            methodId: "openai-api-key",
            secret: fixtureSecrets[4],
          }),
        ).rejects.toBeInstanceOf(MeerkatGatewayRpcError);
      }
      expect(await fixture.config()).toBe(config);
      expect((await fixture.overview()).connections).toEqual([connected]);
      expect(await fixture.stored(fixtureSecrets[0])).toBe(true);
      expect(await fixture.stored(fixtureSecrets[4])).toBe(false);
    } finally {
      await fixture.close();
    }
  }, 30_000);
});

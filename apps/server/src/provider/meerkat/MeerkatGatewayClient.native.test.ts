// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - this opt-in transport proof owns a native child, local HTTP fixture and bounded failure deadlines.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createMeerkatGatewayClient } from "./MeerkatGatewayClient.ts";

const binaryPath = process.env.T3CODE_TEST_MEERKAT_BINARY;

async function bounded<T>(work: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(!binaryPath)("native Meerkat writing cancellation", () => {
  it("closes only the cancelled HTTP stream, preserves a concurrent helper and enforces model budgets", async () => {
    if (!binaryPath) throw new Error("Native test executable was not supplied");
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "meerkat-writing-cancel-")),
    );
    const projectPath = NodePath.join(root, "project");
    const stateRoot = NodePath.join(root, "state");
    await NodeFSP.mkdir(projectPath);
    const slowAdmitted = Promise.withResolvers<void>();
    const slowClosed = Promise.withResolvers<void>();
    const fastAdmitted = Promise.withResolvers<void>();
    const releaseFast = Promise.withResolvers<void>();
    const errors: unknown[] = [];
    const requests: string[] = [];
    // Each receipt also participates in a bounded assertion below. Register a
    // rejection handler before dispatch so fixture failures cannot be unhandled.
    void slowAdmitted.promise.catch(() => {});
    void fastAdmitted.promise.catch(() => {});
    const provider = NodeHttp.createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const text = Buffer.concat(chunks).toString("utf8");
        const payload: unknown = JSON.parse(text);
        expect(request.url).toBe("/v1/responses");
        expect(request.headers.authorization).toBe("Bearer cancel-fixture-key");
        const operation = ["slow", "fast", "small"].find((key) => text.includes(`fixture:${key}`));
        if (!operation) throw new Error("Missing fixture request marker");
        expect(payload).not.toHaveProperty("tools.0");
        expect(payload).toMatchObject({
          model: operation === "small" ? "remote-small" : "gpt-5.4-mini",
          max_output_tokens: operation === "small" ? 512 : 16_384,
        });
        requests.push(operation);
        if (operation === "slow") {
          response.once("close", slowClosed.resolve);
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write('data: {"type":"response.created","response":{"id":"response_slow"}}\n\n');
          slowAdmitted.resolve();
          return;
        }
        if (operation === "fast") {
          fastAdmitted.resolve();
          await releaseFast.promise;
        }
        const item = {
          type: "message",
          id: `message_${operation}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: JSON.stringify({ title: operation }) }],
        };
        const events = [
          { type: "response.created", response: { id: `response_${operation}` } },
          { type: "response.output_item.added", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: `response_${operation}`,
              status: "completed",
              output: [item],
              usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
            },
          },
        ];
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      } catch (error) {
        errors.push(error);
        slowAdmitted.reject(error);
        fastAdmitted.reject(error);
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Writing fixture assertion failed" } }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", resolve);
    });
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Fixture has no TCP address");
    let hash = 0xcbf29ce484222325n;
    for (const byte of Buffer.from(projectPath)) {
      hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
    }
    const realm = `ws-${hash.toString(16).padStart(16, "0")}`;
    const configDir = NodePath.join(stateRoot, realm);
    await NodeFSP.mkdir(configDir, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(configDir, "config.toml"),
      `
max_tokens = 32768
[realm.${realm}]
default_binding = "fixture"
[realm.${realm}.backend.fixture]
provider = "openai"
backend_kind = "openai_api"
base_url = "http://127.0.0.1:${address.port}"
[realm.${realm}.auth.fixture]
provider = "openai"
auth_method = "api_key"
source = { kind = "env", env = "MEERKAT_CANCEL_FIXTURE_KEY" }
[realm.${realm}.binding.fixture]
backend_profile = "fixture"
auth_profile = "fixture"
provider_default = true
[realm.${realm}.backend.local]
provider = "self_hosted"
backend_kind = "self_hosted"
base_url = "http://127.0.0.1:${address.port}"
server = "local"
[realm.${realm}.auth.local]
provider = "self_hosted"
auth_method = "api_key"
source = { kind = "env", env = "MEERKAT_CANCEL_FIXTURE_KEY" }
[realm.${realm}.binding.local]
backend_profile = "local"
auth_profile = "local"
provider_default = true
[self_hosted.servers.local]
base_url = "http://127.0.0.1:${address.port}"
api_style = "responses"
[self_hosted.models.small-writer]
server = "local"
remote_model = "remote-small"
context_window = 2048
max_output_tokens = 512
[model_fallback]
enabled = false
`,
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MEERKAT_CANCEL_FIXTURE_KEY: "cancel-fixture-key",
    };
    for (const key of Object.keys(env)) {
      if (/OPENAI|ANTHROPIC|GEMINI|GOOGLE|AZURE|PROXY/.test(key)) delete env[key];
    }
    const client = createMeerkatGatewayClient({ binaryPath, cwd: projectPath, env });
    const input = (operation: string) => ({
      projectPath,
      configStateRoot: stateRoot,
      model: "gpt-5.4-mini",
      provider: "openai",
      prompt: `Title this change: fixture:${operation}`,
      outputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
    });
    try {
      const control = new AbortController();
      const slow = expect(
        client.request("text.v1.generate", input("slow"), { signal: control.signal }),
      ).rejects.toMatchObject({ kind: "request_aborted" });
      await bounded(slowAdmitted.promise, "Slow provider request was not admitted");
      const fast = client.request("text.v1.generate", input("fast"));
      await bounded(fastAdmitted.promise, "Concurrent provider request was not admitted");
      control.abort();
      await slow;
      await bounded(slowClosed.promise, "Cancelled native request retained its HTTP stream");
      await expect(client.request("system.v1.health")).resolves.toMatchObject({ ok: true });
      releaseFast.resolve();
      await expect(bounded(fast, "Concurrent writing request did not complete")).resolves.toEqual({
        output: { title: "fast" },
      });
      await expect(
        client.request("text.v1.generate", {
          ...input("small"),
          model: "small-writer",
          provider: "self_hosted",
        }),
      ).resolves.toEqual({ output: { title: "small" } });
      expect(errors).toEqual([]);
      expect(requests).toEqual(["slow", "fast", "small"]);
      expect(await NodeFSP.readdir(projectPath)).toEqual([]);
    } finally {
      releaseFast.resolve();
      try {
        await client.close();
      } finally {
        provider.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          provider.close((error) => (error ? reject(error) : resolve())),
        );
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    }
  }, 30_000);
});

// @effect-diagnostics nodeBuiltinImport:off - this opt-in test owns a native process and a loopback provider fixture.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import { createMeerkatGatewayClient } from "./MeerkatGatewayClient.ts";
import { makeMeerkatTextGeneration } from "./MeerkatTextGeneration.ts";

// Default unit tests do not build or require the native runtime. The caller
// must explicitly supply a freshly staged executable for this boundary proof.
const binaryPath = process.env.T3CODE_TEST_MEERKAT_BINARY;

describe.skipIf(!binaryPath)("native Meerkat writing helpers", () => {
  it.effect(
    "uses the workspace model and credentials for all four helpers without agent tools",
    () =>
      Effect.gen(function* () {
        if (!binaryPath) throw new Error("Native test executable was not supplied");
        const root = yield* Effect.promise(async () =>
          NodeFSP.realpath(
            await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "meerkat-writing-test-")),
          ),
        );
        const projectPath = NodePath.join(root, "project");
        yield* Effect.promise(() => NodeFSP.mkdir(projectPath));
        const replies = {
          commit: { subject: " Fix peer delivery. ", body: " Keep recipient identity. " },
          pr: { title: " Fix peer delivery ", body: " Review findings reach the requester. " },
          branch: { branch: "Fix Peer Delivery" },
          title: { title: '"Fix peer delivery"', needsRefinement: false },
        };
        const requests: string[] = [];
        const errors: unknown[] = [];
        const provider = NodeHttp.createServer(async (request, response) => {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const text = Buffer.concat(chunks).toString("utf8");
            const payload: unknown = JSON.parse(text);
            expect(request.url).toBe("/v1/responses");
            expect(request.headers.authorization).toBe("Bearer writing-fixture-key");
            expect(payload).toMatchObject({ model: "gpt-5.6-sol" });
            expect(payload).not.toHaveProperty("tools.0");
            expect(text).toContain("json_schema");
            const operation = (Object.keys(replies) as Array<keyof typeof replies>).find((key) =>
              text.includes(`fixture:${key}`),
            );
            if (!operation) throw new Error("Writing helper lost its supplied context");
            requests.push(operation);
            const item = {
              type: "message",
              id: `message_${operation}`,
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: JSON.stringify(replies[operation]) }],
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
            response.writeHead(500, { "content-type": "application/json" });
            response.end(
              JSON.stringify({ error: { message: "Writing fixture assertion failed" } }),
            );
          }
        });
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              provider.once("error", reject);
              provider.listen(0, "127.0.0.1", resolve);
            }),
        );
        const address = provider.address();
        if (!address || typeof address === "string") throw new Error("Fixture has no TCP address");
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          MEERKAT_WRITING_FIXTURE_KEY: "writing-fixture-key",
        };
        for (const key of Object.keys(env)) {
          if (/OPENAI|ANTHROPIC|GEMINI|GOOGLE|AZURE|PROXY/.test(key)) delete env[key];
        }
        const client = createMeerkatGatewayClient({ binaryPath, cwd: projectPath, env });
        try {
          const instanceId = ProviderInstanceId.make("meerkat-writing-test");
          const modelSelection = createModelSelection(instanceId, "openai:gpt-5.6-sol");
          let preparations = 0;
          const service = yield* makeMeerkatTextGeneration({
            client,
            instanceId,
            stateRoot: NodePath.join(root, "state"),
            enabled: true,
            attachmentsDir: NodePath.join(root, "attachments"),
            prepareWorkspace: async (workspacePath, configStateRoot) => {
              expect(workspacePath).toBe(projectPath);
              preparations++;
              let hash = 0xcbf29ce484222325n;
              for (const byte of Buffer.from(projectPath)) {
                hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
              }
              const realm = `ws-${hash.toString(16).padStart(16, "0")}`;
              const configDir = NodePath.join(configStateRoot, realm);
              await NodeFSP.mkdir(configDir, { recursive: true });
              await NodeFSP.writeFile(
                NodePath.join(configDir, "config.toml"),
                `[realm.${realm}]
default_binding = "fixture"
[realm.${realm}.backend.fixture]
provider = "openai"
backend_kind = "openai_api"
base_url = "http://127.0.0.1:${address.port}"
[realm.${realm}.auth.fixture]
provider = "openai"
auth_method = "api_key"
source = { kind = "env", env = "MEERKAT_WRITING_FIXTURE_KEY" }
[realm.${realm}.binding.fixture]
backend_profile = "fixture"
auth_profile = "fixture"
provider_default = true
[model_fallback]
enabled = false
`,
              );
            },
          }).pipe(Effect.provide(Path.layer));
          expect(
            yield* service.generateCommitMessage({
              cwd: projectPath,
              modelSelection,
              branch: "main",
              stagedSummary: "fixture:commit",
              stagedPatch: "+ preserve recipient",
            }),
          ).toEqual({ subject: "Fix peer delivery", body: "Keep recipient identity." });
          expect(
            yield* service.generatePrContent({
              cwd: projectPath,
              modelSelection,
              baseBranch: "main",
              headBranch: "fix-peer-delivery",
              commitSummary: "fixture:pr",
              diffSummary: "one changed file",
              diffPatch: "+ preserve recipient",
            }),
          ).toEqual({ title: "Fix peer delivery", body: "Review findings reach the requester." });
          expect(
            yield* service.generateBranchName({
              cwd: projectPath,
              modelSelection,
              message: "fixture:branch",
            }),
          ).toEqual({ branch: "fix-peer-delivery" });
          expect(
            yield* service.generateThreadTitle({
              cwd: projectPath,
              modelSelection,
              message: "fixture:title",
            }),
          ).toEqual({ title: "Fix peer delivery" });
          expect(errors).toEqual([]);
          expect(requests).toEqual(["commit", "pr", "branch", "title"]);
          expect(preparations).toBe(4);
          expect(yield* Effect.promise(() => NodeFSP.readdir(projectPath))).toEqual([]);
        } finally {
          yield* Effect.promise(async () => {
            try {
              await client.close();
            } finally {
              provider.closeAllConnections();
              await new Promise<void>((resolve, reject) =>
                provider.close((error) => (error ? reject(error) : resolve())),
              );
              await NodeFSP.rm(root, { recursive: true, force: true });
            }
          });
        }
      }),
  );
});

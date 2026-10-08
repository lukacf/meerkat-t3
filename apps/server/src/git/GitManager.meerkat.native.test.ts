// @effect-diagnostics nodeBuiltinImport:off - this opt-in test owns private Git repositories, a native child and loopback fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type GitActionProgressEvent,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { describe, expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import { MeerkatDriver } from "../provider/Drivers/MeerkatDriver.ts";
import { makeProviderInstanceRegistry } from "../provider/Layers/ProviderInstanceRegistryLive.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubSourceControlProvider from "../sourceControl/GitHubSourceControlProvider.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";

const binaryPath = process.env.T3CODE_TEST_MEERKAT_BINARY;
const disabledDrivers = ["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"];
const decodeProviderInput = Schema.decodeUnknownSync(
  Schema.Struct({
    model: Schema.String,
    input: Schema.Unknown,
    tools: Schema.optional(Schema.Array(Schema.Unknown)),
  }),
);
const decodeGhCalls = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      args: Schema.Array(Schema.String),
      body: Schema.optional(Schema.String),
    }),
  ),
);
const commitReply = {
  subject: "fix: preserve peer review recipients",
  body: "Keep the requesting identity when delivering a peer review.\n\nVerified with node --test review.test.mjs.",
};
const prReply = {
  title: "Preserve peer review recipients",
  body: "## Changes\nPreserve the requesting identity when delivering reviews.\n\n## Verification\nnode --test review.test.mjs passed.",
};

// Only this external CLI is simulated. GitHub argument construction, temporary
// body files, response decoding and provider orchestration remain production code.
const ghFixture = `
import { readFileSync, appendFileSync, existsSync, writeFileSync } from "node:fs";
const [log, stateFile, ...args] = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : [];
const body = args.includes("--body-file") ? readFileSync(value("--body-file"), "utf8") : undefined;
appendFileSync(log, JSON.stringify({args, ...(body === undefined ? {} : {body})}) + "\\n");
if (args[0] === "api" && args[1] === "rate_limit") {
  console.log(JSON.stringify({data:{rateLimit:{cost:1,limit:5000,remaining:4999,resetAt:"2099-01-01T00:00:00Z"}}}));
} else if (args[0] === "repo" && args[1] === "view") {
  console.log("main");
} else if (args[0] === "pr" && args[1] === "list") {
  console.log(JSON.stringify(state.filter(pr => pr.headRefName === value("--head"))));
} else if (args[0] === "pr" && args[1] === "create") {
  const number = state.length + 1;
  state.push({number,title:value("--title"),url:"https://github.com/fixture/meerkat-finish/pull/"+number,
    baseRefName:value("--base"),headRefName:value("--head"),state:"OPEN",isDraft:args.includes("--draft")});
  writeFileSync(stateFile, JSON.stringify(state));
  console.log(state.at(-1).url);
} else {
  console.error("Unexpected GitHub fixture command: " + JSON.stringify(args));
  process.exitCode = 1;
}
`;

describe.skipIf(!binaryPath)("Meerkat-only native finish work", () => {
  it.live(
    "generates a commit and draft PR from tested changes, pushes real Git objects and preserves supplied content",
    () =>
      Effect.gen(function* () {
        if (!binaryPath) throw new Error("Native test executable was not supplied");
        const root = yield* Effect.promise(async () =>
          NodeFSP.realpath(
            await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "meerkat-finish-work-")),
          ),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
        );
        const projectPath = NodePath.join(root, "project");
        const originPath = NodePath.join(root, "origin.git");
        const privateHome = NodePath.join(root, "home");
        const stateRoot = NodePath.join(root, "native");
        const ghScript = NodePath.join(root, "gh-fixture.mjs");
        const ghLog = NodePath.join(root, "gh.jsonl");
        const ghState = NodePath.join(root, "gh-state.json");
        yield* Effect.promise(async () => {
          await Promise.all(
            [projectPath, originPath, privateHome].map((path) => NodeFSP.mkdir(path)),
          );
          await NodeFSP.writeFile(ghScript, ghFixture);
        });
        const fixtureErrors: unknown[] = [];
        const modelRequests: string[] = [];
        const provider = NodeHttp.createServer(async (request, response) => {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const text = Buffer.concat(chunks).toString("utf8");
            const payload = decodeProviderInput(JSON.parse(text));
            expect(request.url).toBe("/v1/responses");
            expect(request.headers.authorization).toBe("Bearer finish-fixture-key");
            expect(payload.model).toBe("gpt-5.6-sol");
            expect(payload.tools ?? []).toEqual([]);
            const prompt = JSON.stringify(payload.input);
            expect(prompt).toContain("review.mjs");
            expect(prompt).toContain("return requestingPeer");
            expect(prompt).toContain("node --test review.test.mjs");
            const phase = modelRequests.length === 0 ? "commit" : "pr";
            expect(modelRequests.length).toBeLessThan(2);
            if (phase === "pr") expect(prompt).toContain(commitReply.subject);
            modelRequests.push(phase);
            const item = {
              type: "message",
              id: `message_${phase}`,
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(phase === "commit" ? commitReply : prReply),
                },
              ],
            };
            const events = [
              { type: "response.created", response: { id: `response_${phase}` } },
              { type: "response.output_item.added", output_index: 0, item },
              {
                type: "response.completed",
                response: {
                  id: `response_${phase}`,
                  status: "completed",
                  output: [item],
                  usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
                },
              },
            ];
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
          } catch (error) {
            fixtureErrors.push(error);
            response.writeHead(500, { "content-type": "application/json" });
            response.end(
              JSON.stringify({ error: { message: "Finish-work fixture assertion failed" } }),
            );
          }
        });
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            provider.closeAllConnections();
            if (provider.listening)
              await new Promise<void>((resolve, reject) =>
                provider.close((error) => (error ? reject(error) : resolve())),
              );
          }),
        );
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              provider.once("error", reject);
              provider.listen(0, "127.0.0.1", resolve);
            }),
        );
        const address = provider.address();
        if (!address || typeof address === "string") throw new Error("Fixture has no TCP address");
        let hash = 0xcbf29ce484222325n;
        for (const byte of Buffer.from(projectPath))
          hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
        const realm = `ws-${hash.toString(16).padStart(16, "0")}`;
        const configDir = NodePath.join(
          stateRoot,
          "projects",
          NodeCrypto.createHash("sha256").update(projectPath).digest("hex"),
          realm,
        );
        yield* Effect.promise(async () => {
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
source = { kind = "env", env = "MEERKAT_FINISH_FIXTURE_KEY" }
[realm.${realm}.binding.fixture]
backend_profile = "fixture"
auth_profile = "fixture"
provider_default = true
[model_fallback]
enabled = false
`,
          );
        });
        const env = {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: privateHome,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: NodePath.join(privateHome, "absent-gitconfig"),
          GIT_TERMINAL_PROMPT: "0",
          GIT_ALLOW_PROTOCOL: "file",
          MEERKAT_FINISH_FIXTURE_KEY: "finish-fixture-key",
        };
        const environment = [
          ...Object.keys(process.env)
            .filter((key) =>
              /OPENAI|ANTHROPIC|GEMINI|GOOGLE|AZURE|PROXY|GH_TOKEN|GITHUB_TOKEN/.test(key),
            )
            .map((name) => ({ name, value: "", sensitive: true })),
          ...Object.entries(env).map(([name, value]) => ({
            name,
            value,
            sensitive: name.endsWith("KEY"),
          })),
        ];
        const commands: string[] = [];
        const hostSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const isolatedSpawner = ChildProcessSpawner.make((command) => {
          if (command._tag !== "StandardCommand")
            return Effect.die("No process pipeline is expected");
          commands.push(command.command);
          if (!["git", "gh", process.execPath].includes(command.command)) {
            return Effect.die(`Unexpected executable: ${command.command}`);
          }
          return hostSpawner.spawn(
            ChildProcess.make(
              command.command === "gh" ? process.execPath : command.command,
              command.command === "gh" ? [ghScript, ghLog, ghState, ...command.args] : command.args,
              { ...command.options, env, extendEnv: false },
            ),
          );
        });
        yield* Effect.gen(function* () {
          const git = yield* GitVcsDriver.make;
          const runGit = (cwd: string, args: readonly string[]) =>
            git.execute({ cwd, args, operation: "MeerkatFinishWorkTest.git" });
          yield* runGit(projectPath, ["init", "--initial-branch=main"]);
          yield* runGit(projectPath, ["config", "user.name", "Fixture"]);
          yield* runGit(projectPath, ["config", "user.email", "fixture@example.invalid"]);
          yield* runGit(projectPath, ["config", "commit.gpgsign", "false"]);
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(projectPath, "review.mjs"),
              "export const recipient = requestingPeer => 'wrong-peer';\n",
            ),
          );
          yield* runGit(projectPath, ["add", "review.mjs"]);
          yield* runGit(projectPath, ["commit", "-m", "Initial fixture"]);
          yield* runGit(originPath, ["init", "--bare", "--initial-branch=main"]);
          const visibleOrigin = "https://github.com/fixture/meerkat-finish.git";
          yield* runGit(projectPath, ["remote", "add", "origin", visibleOrigin]);
          yield* runGit(projectPath, ["config", "remote.origin.pushurl", originPath]);
          yield* runGit(projectPath, ["push", "-u", "origin", "main"]);
          yield* runGit(projectPath, ["checkout", "-b", "fix/peer-recipient"]);
          yield* Effect.promise(async () => {
            await NodeFSP.writeFile(
              NodePath.join(projectPath, "review.mjs"),
              "export const recipient = requestingPeer => { return requestingPeer; };\n",
            );
            await NodeFSP.writeFile(
              NodePath.join(projectPath, "review.test.mjs"),
              "import { test } from 'node:test';\nimport { strict as assert } from 'node:assert';\nimport { recipient } from './review.mjs';\ntest('returns the requesting peer', () => assert.equal(recipient('coordinator'), 'coordinator'));\n",
            );
          });
          const processRunner = yield* ProcessRunner.make();
          const tested = yield* processRunner.run({
            command: process.execPath,
            args: ["--test", "review.test.mjs"],
            cwd: projectPath,
          });
          expect(tested.code).toBe(0);
          expect(tested.stdout).toContain("pass 1");
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(projectPath, "verification.txt"),
              "node --test review.test.mjs\nPassed: returns the requesting peer (1 test).\n",
            ),
          );

          const instanceId = ProviderInstanceId.make("meerkat");
          const modelSelection = createModelSelection(instanceId, "openai:gpt-5.6-sol");
          const configMap = {
            ...Object.fromEntries(
              disabledDrivers.map((driver) => [
                driver,
                { driver: ProviderDriverKind.make(driver), enabled: false },
              ]),
            ),
            meerkat: {
              driver: ProviderDriverKind.make("meerkat"),
              enabled: true,
              environment,
              config: {
                gatewayBinaryPath: binaryPath,
                projectPath,
                stateRoot,
                workspacePolicy: "selected-model-only",
              },
            },
          };
          const { registry } = yield* makeProviderInstanceRegistry({
            drivers: [MeerkatDriver],
            configMap,
          });
          const instances = yield* registry.listInstances;
          expect(instances.map((instance) => instance.instanceId)).toEqual([instanceId]);
          const snapshots = yield* Effect.forEach(
            instances,
            (instance) => instance.snapshot.getSnapshot,
          );
          expect(snapshots[0]).toMatchObject({
            installed: true,
            status: "ready",
            supportsTextGeneration: true,
          });
          const github = yield* GitHubSourceControlProvider.make.pipe(
            Effect.provide(GitHubCli.layer),
          );
          const sourceControl = yield* SourceControlProviderRegistry.makeWithProviders([
            { kind: "github", provider: github, discovery: GitHubSourceControlProvider.discovery },
          ]).pipe(Effect.provide(VcsDriverRegistry.layer));
          const generation = yield* TextGeneration.make.pipe(
            Effect.provideService(ProviderInstanceRegistry, registry),
            Effect.provideService(
              SourceControlProviderRegistry.SourceControlProviderRegistry,
              sourceControl,
            ),
          );
          const settingsLayer = ServerSettings.layerTest({
            providerInstances: configMap,
            textGenerationModelSelection: modelSelection,
            sourceControlWriterModelSelection: modelSelection,
          });
          const manager = yield* GitManager.make.pipe(
            Effect.provideService(GitVcsDriver.GitVcsDriver, git),
            Effect.provideService(TextGeneration.TextGeneration, generation),
            Effect.provideService(
              SourceControlProviderRegistry.SourceControlProviderRegistry,
              sourceControl,
            ),
            Effect.provide(
              Layer.mergeAll(
                Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(snapshots) }),
                Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
                  runForThread: () => Effect.die("Finish work must not run project setup"),
                }),
                settingsLayer,
              ),
            ),
          );
          const progress: GitActionProgressEvent[] = [];
          const result = yield* manager.runStackedAction(
            {
              actionId: "native-finish",
              cwd: projectPath,
              action: "commit_push_pr",
              pullRequest: { draft: true },
            },
            {
              progressReporter: {
                publish: (event) =>
                  Effect.sync(() => {
                    progress.push(event);
                  }),
              },
            },
          );
          expect(result.commit).toMatchObject({ status: "created", subject: commitReply.subject });
          expect(result.push.status).toBe("pushed");
          expect(result.pr).toMatchObject({ status: "created", title: prReply.title, number: 1 });
          expect(progress.at(-1)).toMatchObject({ kind: "action_finished" });
          const head = (yield* runGit(projectPath, ["rev-parse", "HEAD"])).stdout.trim();
          expect(
            (yield* runGit(originPath, [
              "rev-parse",
              "refs/heads/fix/peer-recipient",
            ])).stdout.trim(),
          ).toBe(head);
          expect((yield* runGit(originPath, ["show", `${head}:review.mjs`])).stdout).toContain(
            "return requestingPeer",
          );
          expect((yield* runGit(projectPath, ["log", "-1", "--format=%B"])).stdout.trim()).toBe(
            `${commitReply.subject}\n\n${commitReply.body}`,
          );
          expect((yield* runGit(projectPath, ["status", "--porcelain"])).stdout).toBe("");
          expect(modelRequests).toEqual(["commit", "pr"]);
          expect(fixtureErrors).toEqual([]);
          const readGhCalls = () =>
            Effect.promise(async () =>
              decodeGhCalls(
                (await NodeFSP.readFile(ghLog, "utf8"))
                  .trim()
                  .split("\n")
                  .map((line) => JSON.parse(line)),
              ),
            );
          const generatedPayload = (yield* readGhCalls()).find(
            (call) => call.args[0] === "pr" && call.args[1] === "create",
          );
          if (!generatedPayload?.body) throw new Error("Generated PR has no recorded body");
          const generatedTitle =
            generatedPayload.args[generatedPayload.args.indexOf("--title") + 1];
          if (!generatedTitle) throw new Error("Generated PR has no recorded title");

          // Supplied content remains compatible and must not call a writing model.
          yield* runGit(projectPath, ["checkout", "-b", "fix/peer-recipient-draft"]);
          const draft = yield* manager.runStackedAction({
            actionId: "native-finish-draft",
            cwd: projectPath,
            action: "create_pr",
            pullRequest: { title: generatedTitle, body: generatedPayload.body, draft: true },
          });
          expect(draft.pr).toMatchObject({ status: "created", title: prReply.title, number: 2 });
          expect(
            (yield* runGit(originPath, [
              "rev-parse",
              "refs/heads/fix/peer-recipient-draft",
            ])).stdout.trim(),
          ).toBe(head);
          const calls = yield* readGhCalls();
          const creations = calls.filter(
            (call) => call.args[0] === "pr" && call.args[1] === "create",
          );
          expect(creations).toHaveLength(2);
          expect(creations[0]?.args).toContain("--draft");
          expect(creations[1]?.args).toContain("--draft");
          expect(creations.map((call) => call.body)).toEqual([prReply.body, prReply.body]);
          for (const call of creations) {
            expect(call.args[call.args.indexOf("--title") + 1]).toBe(prReply.title);
            const bodyFile = call.args[call.args.indexOf("--body-file") + 1];
            if (!bodyFile) throw new Error("PR has no body file");
            yield* Effect.promise(() =>
              expect(NodeFSP.stat(bodyFile)).rejects.toMatchObject({ code: "ENOENT" }),
            );
          }
          expect(modelRequests).toEqual(["commit", "pr"]);
          expect(new Set(commands)).toEqual(new Set(["git", "gh", process.execPath]));
        }).pipe(
          Effect.provide(
            Layer.merge(
              VcsProcess.layer,
              ServerConfig.layerTest(projectPath, NodePath.join(root, "server")),
            ),
          ),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, isolatedSpawner),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 60_000 },
  );
});

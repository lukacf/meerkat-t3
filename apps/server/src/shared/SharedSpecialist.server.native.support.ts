// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - disposable native acceptance fixtures own their loopback server and Git repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { AuthPairingCredentialResult, AuthSharedParticipantScopes } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { expect } from "@effect/vitest";
import { workflowKey } from "../provider/meerkat/MeerkatWorkflow.server.native.support.ts";
import { controlledPeerTraffic } from "./SharedSpecialist.server.native.peer.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeInput = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      model: Schema.String,
      input: Schema.Array(Schema.Unknown),
      tools: Schema.Array(Schema.Unknown),
    }),
  ),
);
const decodeUser = Schema.decodeUnknownOption(
  Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Union([
      Schema.String,
      Schema.Array(Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String })),
    ]),
  }),
);
const decodeTool = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("function"), name: Schema.String }),
);
const decodeToolOutput = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("function_call_output"),
    call_id: Schema.String,
    output: Schema.Union([
      Schema.String,
      Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
    ]),
  }),
);
const decodeRepositoryRead = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      kind: Schema.Literal("committed_file"),
      sharedProjectId: Schema.String,
      commit: Schema.String,
      path: Schema.String,
      content: Schema.String,
    }),
  ),
);
export const markers = [
  "SHARED_ALICE_REQUEST",
  "SHARED_BOB_REQUEST",
  "UNRELATED_NATIVE_REQUEST",
  "SHARED_AFTER_RESTART",
] as const;
export const answers = [
  "ALICE_EXACT_RESULT",
  "BOB_EXACT_RESULT",
  "UNRELATED_NATIVE_RESULT",
  "RESTART_EXACT_RESULT",
] as const;

export function controlledSharedProvider() {
  const peer = controlledPeerTraffic();
  const requests: string[] = [];
  const nativeSteps = new Map<number, number>();
  const errors: string[] = [];
  let expectedRepository: { sharedProjectId: string; commit: string } | undefined;
  let repositoryReadVerified = false;
  let inferenceCount = 0;
  const entered = markers.map(() => Promise.withResolvers<void>());
  const release = markers.map(() => Promise.withResolvers<void>());
  const provider = NodeHttp.createServer(async (request, response) => {
    try {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/responses");
      expect(request.headers.authorization).toBe(`Bearer ${workflowKey}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = decodeInput(Buffer.concat(chunks).toString("utf8"));
      expect(body.model).toBe("gpt-5.6-sol");
      const user = body.input
        .toReversed()
        .map((item) => decodeUser(item))
        .find((item) => item._tag === "Some");
      if (!user || user._tag !== "Some") throw new Error("No user input");
      const text =
        typeof user.value.content === "string"
          ? user.value.content
          : user.value.content.map((item) => item.text).join("");
      const responseId = `shared-response-${inferenceCount++}`;
      if (peer.matches(text)) {
        await peer.respond(body, text, response, responseId);
        return;
      }
      const index = markers.findIndex((marker) => text.includes(marker));
      if (index < 0) throw new Error("Unexpected native request marker");
      const step = nativeSteps.get(index) ?? 0;
      nativeSteps.set(index, step + 1);
      const toolContinuation = index === 0 && step === 1;
      if (step > (index === 0 ? 1 : 0)) throw new Error("Unexpected duplicate native inference");
      if (!toolContinuation) requests.push(text);
      expect(text).toContain(markers[index]);
      if (toolContinuation) {
        expect(repositoryReadVerified).toBe(false);
        const outputs = body.input.flatMap((item) => {
          const value = decodeToolOutput(item);
          return value._tag === "Some" && value.value.call_id === "shared-repository-read"
            ? [value.value]
            : [];
        });
        expect(outputs).toHaveLength(1);
        const raw = outputs[0]!.output;
        const result = decodeRepositoryRead(
          typeof raw === "string" ? raw : raw.map((part) => part.text ?? "").join("\n"),
        );
        expect(result).toEqual({
          ...expectedRepository,
          kind: "committed_file",
          path: "src/api.ts",
          content: "export const version = 'alice';",
        });
        repositoryReadVerified = true;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${encode({ type: "response.created", response: { id: responseId } })}\n\n`,
      );
      response.flushHeaders();
      entered[index]!.resolve();
      await release[index]!.promise;
      const final = {
        type: "message",
        id: `shared-message-${index}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: answers[index] }],
      };
      if (index === 0 && !toolContinuation) {
        expect(expectedRepository).toBeDefined();
        const tools = body.tools.flatMap((item) => {
          const value = decodeTool(item);
          return value._tag === "Some" ? [value.value.name] : [];
        });
        expect(tools.filter((name) => name === "shared_workspace")).toHaveLength(1);
      }
      const item =
        index === 0 && !toolContinuation
          ? {
              type: "function_call",
              id: "fc_shared_repository_read",
              call_id: "shared-repository-read",
              name: "shared_workspace",
              status: "completed",
              arguments: encode({
                action: "repository.read",
                arguments: { ...expectedRepository, path: "src/api.ts" },
              }),
            }
          : final;
      response.end(
        [
          { type: "response.output_item.added", output_index: 0, item },
          ...("call_id" in item
            ? [{ ...item, type: "response.function_call_arguments.done", item_id: item.id }]
            : []),
          {
            type: "response.completed",
            response: {
              id: responseId,
              status: "completed",
              output: [item],
              usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
            },
          },
        ]
          .map((event) => `data: ${encode(event)}\n\n`)
          .join(""),
      );
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Unknown fixture failure");
      for (const barrier of entered) barrier.reject(new Error("Shared provider fixture failed"));
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(encode({ error: { message: "Shared provider fixture failed" } }));
    }
  });
  for (const barrier of entered) void barrier.promise.catch(() => undefined);
  return {
    provider,
    peer,
    requests,
    errors,
    entered,
    release,
    setRepository: (sharedProjectId: string, commit: string) => {
      expectedRepository = { sharedProjectId, commit };
    },
    repositoryReadVerified: () => repositoryReadVerified,
    inferenceCount: () => inferenceCount,
  };
}

export async function initializeSharedRepository(path: string, env: NodeJS.ProcessEnv) {
  const git = (args: string[], cwd = path) =>
    new Promise<string>((resolve, reject) => {
      NodeChildProcess.execFile("/usr/bin/git", args, { cwd, env }, (error, stdout) =>
        error ? reject(error) : resolve(stdout.trim()),
      );
    });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Shared specialist fixture"]);
  await git(["config", "user.email", "shared@example.invalid"]);
  await git(["remote", "add", "origin", "https://github.com/example/shared-api"]);
  await NodeFSP.mkdir(NodePath.join(path, "src"));
  await NodeFSP.writeFile(NodePath.join(path, "src", "api.ts"), "export const version = 'base';\n");
  await git(["add", "src/api.ts"]);
  await git(["commit", "-m", "Initialize fixture"]);
  const base = await git(["rev-parse", "HEAD"]);
  const branches = [];
  for (const name of ["alice", "bob"]) {
    await git(["checkout", "-b", `feature/${name}`, base]);
    await NodeFSP.writeFile(
      NodePath.join(path, "src", "api.ts"),
      `export const version = '${name}';\n`,
    );
    await git(["commit", "-am", `Change ${name} branch`]);
    const commit = await git(["rev-parse", "HEAD"]);
    const checkout = NodePath.join(NodePath.dirname(path), `${name}-checkout`);
    await git(["clone", "--no-hardlinks", "--branch", `feature/${name}`, path, checkout]);
    expect(await git(["rev-parse", "HEAD"], checkout)).toBe(commit);
    branches.push({ branch: `feature/${name}`, commit, checkout });
  }
  await git(["checkout", "main"]);
  return { alice: branches[0]!, bob: branches[1]!, base };
}

export const issueSharedPairing = Effect.fnUntraced(
  function* (origin: string, bearer: string, label: string) {
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(`${origin}/api/auth/pairing-token`).pipe(
        HttpClientRequest.bearerToken(bearer),
        HttpClientRequest.bodyJsonUnsafe({ label, scopes: AuthSharedParticipantScopes }),
      ),
    );
    expect(response.status).toBe(200);
    return (yield* HttpClientResponse.schemaBodyJson(AuthPairingCredentialResult)(response))
      .credential;
  },
  Effect.provide(NodeHttpClient.layerUndici),
  Effect.scoped,
  Effect.timeout("15 seconds"),
);

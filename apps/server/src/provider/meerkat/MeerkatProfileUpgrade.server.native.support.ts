// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - opt-in package acceptance owns bounded child processes and a loopback provider.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import { hashMeerkatRuntimeFile, verifyMeerkatRuntime } from "@t3tools/shared/meerkatRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect } from "@effect/vitest";
import { workflowKey } from "./MeerkatWorkflow.server.native.support.ts";

export const upgradeImage =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
export const encodeUpgradeEvidence = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Canonicalize the complete bundle so historical helpers also work through /tmp symlinks. */
export async function inspectPackage(appPath: string) {
  if (!NodePath.isAbsolute(appPath) || !appPath.endsWith(".app"))
    throw new Error("An absolute extracted macOS application bundle is required");
  const app = await NodeFSP.realpath(appPath);
  const resources = NodePath.join(app, "Contents", "Resources");
  const archive = NodePath.join(resources, "app.asar");
  const runtime = NodePath.join(resources, "meerkat-runtime");
  const executables = await NodeFSP.readdir(NodePath.join(app, "Contents", "MacOS"));
  expect(executables).toHaveLength(1);
  const executable = NodePath.join(app, "Contents", "MacOS", executables[0]!);
  await NodeFSP.access(executable);
  const manifest = await verifyMeerkatRuntime(runtime);
  return {
    app,
    archive,
    runtime,
    executable,
    entry: NodePath.join(archive, "apps", "server", "dist", "bin.mjs"),
    manifest,
    archiveSha256: await hashMeerkatRuntimeFile(archive),
    executableSha256: await hashMeerkatRuntimeFile(executable),
  };
}
export type UpgradePackage = Awaited<ReturnType<typeof inspectPackage>>;

export async function initializeUpgradeRepository(path: string, env: NodeJS.ProcessEnv) {
  const git = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      NodeChildProcess.execFile("/usr/bin/git", args, { cwd: path, env }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Profile upgrade fixture"]);
  await git(["config", "user.email", "upgrade@example.invalid"]);
  await NodeFSP.writeFile(NodePath.join(path, "README.md"), "Private profile upgrade fixture.\n");
  await git(["add", "README.md"]);
  await git(["commit", "-m", "Initialize private upgrade fixture"]);
}

const decodeRequest = Schema.decodeUnknownSync(
  Schema.Struct({
    model: Schema.String,
    input: Schema.Array(Schema.Unknown),
    tools: Schema.Array(Schema.Unknown),
  }),
);
const decodeUser = Schema.decodeUnknownOption(
  Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
  }),
);
const decodeText = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String }),
);
const decodeFunction = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("function"), name: Schema.String }),
);
const decodeOutput = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("function_call_output"),
    call_id: Schema.String,
    output: Schema.Union([
      Schema.String,
      Schema.Array(Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String })),
    ]),
  }),
);
const decodePeers = Schema.decodeUnknownOption(
  Schema.Struct({ peers: Schema.Array(Schema.Struct({ peer_id: Schema.String })) }),
);
const phases = ["FIRST_COORD", "FIRST_REVIEW", "CONTINUE_COORD", "CONTINUE_REVIEW"] as const;
export type UpgradePhase = (typeof phases)[number];

/** Real Responses wire protocol; it calls only the native peers tool then supplies controlled text. */
export function upgradeProvider() {
  const calls: { phase: UpgradePhase; step: number; hasImage: boolean }[] = [];
  const completed = new Set<UpgradePhase>();
  const peers = new Map<"COORD" | "REVIEW", string>();
  const progress = new Map<UpgradePhase, number>();
  const failed = Promise.withResolvers<never>();
  void failed.promise.catch(() => undefined);
  const provider = NodeHttp.createServer(async (request, response) => {
    try {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/responses");
      expect(request.headers.authorization).toBe(`Bearer ${workflowKey}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = decodeRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      expect(payload.model).toBe("gpt-5.6-sol");
      const users = payload.input.flatMap((item) => {
        const user = decodeUser(item);
        if (Option.isNone(user)) return [];
        if (typeof user.value.content === "string") return [user.value.content];
        return [
          user.value.content
            .flatMap((part) => {
              const text = decodeText(part);
              return Option.isSome(text) ? [text.value.text] : [];
            })
            .join("\n"),
        ];
      });
      const latest = users.at(-1) ?? "";
      const matches = phases.filter((phase) => latest.includes(`UPGRADE_${phase}`));
      expect(matches).toHaveLength(1);
      const phase = matches[0]!;
      const role = phase.endsWith("COORD") ? "COORD" : "REVIEW";
      const opposite = role === "COORD" ? "REVIEW" : "COORD";
      const input = JSON.stringify(payload.input);
      expect(input).not.toContain(`UPGRADE_FIRST_${opposite}`);
      const hasImage = input.includes(`data:image/png;base64,${upgradeImage}`);
      expect(hasImage).toBe(true);
      if (phase.startsWith("CONTINUE")) {
        expect(input).toContain(`UPGRADE_FIRST_${role}`);
        expect(input).toContain(`UPGRADE_FIRST_${role}_COMPLETE`);
      }
      const step = progress.get(phase) ?? 0;
      const callId = `upgrade_${phase}_peers`;
      let item: object;
      if (step === 0) {
        expect(
          payload.tools.flatMap((tool) => {
            const decoded = decodeFunction(tool);
            return Option.isSome(decoded) && decoded.value.name === "peers" ? [decoded.value] : [];
          }),
        ).toHaveLength(1);
        item = {
          type: "function_call",
          id: `fc_${callId}`,
          call_id: callId,
          name: "peers",
          arguments: "{}",
          status: "completed",
        };
      } else if (step === 1) {
        const outputs = payload.input.flatMap((entry) => {
          const decoded = decodeOutput(entry);
          return Option.isSome(decoded) && decoded.value.call_id === callId
            ? [decoded.value.output]
            : [];
        });
        expect(outputs).toHaveLength(1);
        const output = outputs[0]!;
        const values = (
          typeof output === "string" ? [output] : output.map((part) => part.text)
        ).flatMap((text) => {
          try {
            const decoded = decodePeers(JSON.parse(text));
            return Option.isSome(decoded) ? [decoded.value.peers] : [];
          } catch {
            return [];
          }
        });
        expect(values).toHaveLength(1);
        expect(values[0]).toHaveLength(1);
        const peer = values[0]![0]!.peer_id;
        if (phase.startsWith("FIRST")) peers.set(role, peer);
        else expect(peer).toBe(peers.get(role));
        expect(completed.has(phase)).toBe(false);
        completed.add(phase);
        item = {
          type: "message",
          id: `msg_${phase}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: `UPGRADE_${phase}_COMPLETE` }],
        };
      } else throw new Error(`Unexpected repeated phase ${phase}`);
      progress.set(phase, step + 1);
      calls.push({ phase, step, hasImage });
      const responseId = `response_upgrade_${calls.length}`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [
          { type: "response.created", response: { id: responseId } },
          { type: "response.output_item.added", output_index: 0, item },
          ...("call_id" in item
            ? [{ ...item, type: "response.function_call_arguments.done", item_id: `fc_${callId}` }]
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
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
      );
    } catch (error) {
      failed.reject(error);
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "Profile upgrade fixture assertion failed" } }),
      );
    }
  });
  return { provider, calls, completed, peers, failed: failed.promise };
}

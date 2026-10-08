// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - private packaged-server acceptance uses real Git and a bounded loopback provider.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect } from "@effect/vitest";
import { bounded, workflowKey } from "./MeerkatWorkflow.server.native.support.ts";

export const checkpointPhases = [
  "OWNER_READY",
  "SAME_READY",
  "SIBLING_READY",
  "BUSY",
  "CONTINUE",
] as const;
export type CheckpointPhase = (typeof checkpointPhases)[number];
const decodeRequest = Schema.decodeUnknownSync(
  Schema.Struct({ model: Schema.String, input: Schema.Array(Schema.Unknown) }),
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

/** Hold an actual provider request so a different idle conversation observes native workspace work. */
export function checkpointProvider() {
  const failed = Promise.withResolvers<never>();
  void failed.promise.catch(() => undefined);
  const busyStarted = Promise.withResolvers<void>();
  const busyRelease = Promise.withResolvers<void>();
  const calls: CheckpointPhase[] = [];
  let tearingDown = false;
  const provider = NodeHttp.createServer(async (request, response) => {
    try {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/responses");
      expect(request.headers.authorization).toBe(`Bearer ${workflowKey}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = decodeRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      expect(payload.model).toBe("gpt-5.6-sol");
      const latest = payload.input
        .flatMap((entry) => {
          const user = decodeUser(entry);
          return Option.isSome(user)
            ? [
                typeof user.value.content === "string"
                  ? user.value.content
                  : user.value.content.map((part) => part.text).join("\n"),
              ]
            : [];
        })
        .at(-1);
      const matches = checkpointPhases.filter((phase) => latest === `CHECKPOINT_${phase}`);
      expect(matches).toHaveLength(1);
      const phase = matches[0]!;
      expect(calls).not.toContain(phase);
      calls.push(phase);
      const serialized = JSON.stringify(payload.input);
      if (phase === "BUSY") {
        expect(serialized).toContain("CHECKPOINT_SAME_READY_COMPLETE");
        expect(serialized).not.toContain("CHECKPOINT_OWNER_READY");
        busyStarted.resolve();
        await bounded(busyRelease.promise, "checkpoint busy request release", 60_000);
        if (tearingDown) {
          response.destroy();
          return;
        }
      }
      if (phase === "CONTINUE") {
        expect(serialized).toContain("CHECKPOINT_OWNER_READY_COMPLETE");
        expect(serialized).not.toContain("CHECKPOINT_SAME_READY");
        expect(serialized).not.toContain("CHECKPOINT_SIBLING_READY");
      }
      const id = `response_checkpoint_${phase}`;
      const item = {
        type: "message",
        id: `message_checkpoint_${phase}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: `CHECKPOINT_${phase}_COMPLETE` }],
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [
          { type: "response.created", response: { id } },
          { type: "response.output_item.added", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id,
              status: "completed",
              output: [item],
              usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
            },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
      );
    } catch (cause) {
      failed.reject(new Error("Controlled checkpoint provider assertion failed", { cause }));
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Checkpoint fixture failed" } }));
    }
  });
  return {
    provider,
    failed: failed.promise,
    calls,
    busyStarted: busyStarted.promise,
    releaseBusy: () => busyRelease.resolve(),
    beginTeardown: () => {
      tearingDown = true;
      busyRelease.resolve();
    },
  };
}

export function checkpointGit(cwd: string, env: NodeJS.ProcessEnv, args: string[]) {
  return new Promise<string>((resolve, reject) =>
    NodeChildProcess.execFile("/usr/bin/git", args, { cwd, env }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  );
}
export async function initializeCheckpointRepository(workspace: string, env: NodeJS.ProcessEnv) {
  await checkpointGit(workspace, env, ["init", "-b", "main"]);
  await checkpointGit(workspace, env, ["config", "user.name", "Checkpoint acceptance fixture"]);
  await checkpointGit(workspace, env, ["config", "user.email", "checkpoint@example.invalid"]);
  await NodeFSP.writeFile(NodePath.join(workspace, "selected.txt"), "Committed selected file\n");
  await NodeFSP.writeFile(NodePath.join(workspace, "other.txt"), "Committed other file\n");
  await checkpointGit(workspace, env, ["add", "selected.txt", "other.txt"]);
  await checkpointGit(workspace, env, ["commit", "-m", "Initialize private checkpoint fixture"]);
}

export async function checkpointFiles(workspace: string) {
  return Object.fromEntries(
    await Promise.all(
      ["selected.txt", "other.txt"].map(async (name) => {
        const path = NodePath.join(workspace, name);
        const bytes = await NodeFSP.readFile(path);
        const stat = await NodeFSP.stat(path);
        return [
          name,
          {
            text: bytes.toString("utf8"),
            sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
            mode: stat.mode & 0o777,
          },
        ];
      }),
    ),
  );
}

export async function expectedCheckpointCurrent(workspace: string, relative: string) {
  const path = NodePath.join(workspace, relative);
  const bytes = await NodeFSP.readFile(path);
  const stat = await NodeFSP.stat(path);
  const mode = stat.mode & 0o100 ? 0o100755 : 0o100644;
  return NodeCrypto.createHash("sha256").update(`${mode}:`).update(bytes).digest("hex");
}

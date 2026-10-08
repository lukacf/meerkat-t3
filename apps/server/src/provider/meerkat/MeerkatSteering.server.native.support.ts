// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - isolated opt-in native boundary evidence and controlled loopback provider.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { bounded, workflowKey } from "./MeerkatWorkflow.server.native.support.ts";

export const startText = "STEERING_BOUNDARY_START: continue through the controlled tool boundary.";
export const steerText =
  "STEERING_BOUNDARY_APPEND: include exactly this instruction in the current run.";
export const finalText = "STEERING_BOUNDARY_COMPLETE";
export const survivorText = "STEERING_INDEPENDENT_START";
export const survivorFinal = "STEERING_INDEPENDENT_COMPLETE";
export const childMobId = "steering-boundary-child-mob";
export const childMemberId = "steering-boundary-child";
export const childSpawnText = "STEERING_SPAWN_CHILD";
export const childSpawnFinal = "STEERING_CHILD_CREATED";

const decodeRequest = Schema.decodeUnknownSync(
  Schema.Struct({
    model: Schema.String,
    input: Schema.Array(Schema.Unknown),
    tools: Schema.Array(Schema.Unknown),
  }),
);
const decodeMessage = Schema.decodeUnknownOption(
  Schema.Struct({
    role: Schema.String,
    content: Schema.Union([
      Schema.String,
      Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
    ]),
  }),
);
const decodeTool = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("function"),
    name: Schema.String,
    parameters: Schema.Record(Schema.String, Schema.Unknown),
  }),
);
const decodeToolOutput = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("function_call_output"),
    call_id: Schema.String,
    output: Schema.Unknown,
  }),
);
const decodeInputRow = Schema.decodeUnknownSync(
  Schema.Struct({
    input_id: Schema.String,
    current_state: Schema.String,
    last_run_id: Schema.optional(Schema.String),
    terminal_outcome: Schema.optional(Schema.Unknown),
    terminal_completion: Schema.optional(
      Schema.Struct({
        input_id: Schema.String,
        batch_key: Schema.Struct({ scope: Schema.String, run_id: Schema.optional(Schema.String) }),
        owner_input_id: Schema.String,
        phase: Schema.Struct({
          phase: Schema.String,
          finalization: Schema.optional(Schema.String),
        }),
      }),
    ),
    persisted_input: Schema.optional(Schema.Unknown),
    history: Schema.optional(Schema.Array(Schema.Unknown)),
  }),
);
export type NativeInputEvidence = ReturnType<typeof decodeInputRow>;

/** Read-only fixture evidence, never an admission or recovery implementation. */
export function readNativeInputs(databasePath: string, sessionId: string): NativeInputEvidence[] {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    // The native process is still writing. Wait only for SQLite's lock, with
    // the same bounded busy policy as the production read-only history path.
    database.exec("PRAGMA busy_timeout = 2000");
    return database
      .prepare(
        "SELECT input_id, state_json FROM runtime_input_states WHERE runtime_id = ? ORDER BY input_id LIMIT 128",
      )
      .all(`rt:session:${sessionId}`)
      .map((row) => {
        const bytes = row.state_json;
        NodeAssert.ok(typeof bytes === "string" || bytes instanceof Uint8Array);
        const result = decodeInputRow(
          JSON.parse(typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8")),
        );
        NodeAssert.equal(result.input_id, row.input_id);
        return result;
      });
  } finally {
    database.close();
  }
}

export async function locateNativeInputs(nativeRoot: string, sessionId: string) {
  const pending = [nativeRoot];
  const matches: string[] = [];
  let scanned = 0;
  while (pending.length) {
    NodeAssert.ok(++scanned <= 256, "Fixture native directory traversal must remain bounded");
    const directory = pending.pop()!;
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const path = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (
        entry.isFile() &&
        entry.name === "runtime.sqlite" &&
        readNativeInputs(path, sessionId).length
      )
        matches.push(path);
    }
  }
  NodeAssert.equal(matches.length, 1, "The exact session must have one native input store");
  return matches[0]!;
}

export function inputWithMarker(rows: readonly NativeInputEvidence[], marker: string) {
  const matches = rows.filter((row) => JSON.stringify(row.persisted_input)?.includes(marker));
  NodeAssert.equal(matches.length, 1, `Expected one native admitted input for ${marker}`);
  return matches[0]!;
}

export async function waitFor<A>(read: () => A, accepted: (value: A) => boolean, label: string) {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const value = read();
    if (accepted(value)) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Deadline waiting for ${label}`);
}

function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function messages(input: readonly unknown[], role: string) {
  return input.flatMap((item) => {
    const decoded = decodeMessage(item);
    if (Option.isNone(decoded) || decoded.value.role !== role) return [];
    return [
      typeof decoded.value.content === "string"
        ? decoded.value.content
        : decoded.value.content.map((part) => part.text ?? "").join(""),
    ];
  });
}
export function transcriptUserCount(input: readonly unknown[], marker: string) {
  return messages(input, "user").filter((text) => text.includes(marker)).length;
}

export function controlledSteeringProvider() {
  const started = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const observed = Promise.withResolvers<void>();
  const releaseFinal = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const survivor = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<never>();
  void failed.promise.catch(() => undefined);
  const boundaries: {
    boundary: number;
    exactUserAppends: number;
    original: NativeInputEvidence;
    steering: NativeInputEvidence;
  }[] = [];
  const errors: string[] = [];
  let observeNative:
    | (() => { original: NativeInputEvidence; steering: NativeInputEvidence })
    | undefined;
  let step = 0;
  let spawnStep = 0;
  let serial = 0;
  let tearingDown = false;
  let survivorRequests = 0;
  let finished = false;
  const provider = NodeHttp.createServer(async (request, response) => {
    try {
      NodeAssert.equal(request.method, "POST");
      NodeAssert.equal(request.url, "/v1/responses");
      NodeAssert.equal(request.headers.authorization, `Bearer ${workflowKey}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = decodeRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      NodeAssert.equal(payload.model, "gpt-5.6-sol");
      const users = messages(payload.input, "user");
      const latest = users.at(-1) ?? "";
      const id = `call_steering_boundary_${serial++}`;
      const call = (name: string, args: object) => {
        const catalog = payload.tools.flatMap((tool) => {
          const decoded = decodeTool(tool);
          return Option.isSome(decoded) ? [decoded.value.name] : [];
        });
        NodeAssert.equal(
          catalog.filter((candidate) => candidate === name).length,
          1,
          `Missing native tool ${name}: ${catalog.join(",")}`,
        );
        return {
          type: "function_call",
          id: `fc_${id}`,
          call_id: id,
          name,
          arguments: JSON.stringify(args),
          status: "completed",
        };
      };
      const final = (text: string) => ({
        type: "message",
        id: `message_${id}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      });
      let item: object | undefined;
      if (latest.includes(survivorText)) {
        NodeAssert.equal(++survivorRequests, 1, "Independent input must dispatch exactly once");
        NodeAssert.equal(
          users.some((text) => text.includes(startText) || text.includes(steerText)),
          false,
        );
        item = final(survivorFinal);
        survivor.resolve();
      } else if (latest.includes(childSpawnText)) {
        if (spawnStep === 0)
          item = call("mob_create", {
            definition: {
              id: childMobId,
              profiles: {
                worker: {
                  model: "gpt-5.6-sol",
                  provider: "openai",
                  runtime_mode: "autonomous_host",
                  tools: { builtins: true, shell: true, comms: true },
                },
              },
            },
          });
        else if (spawnStep === 1)
          item = call("mob_spawn_member", {
            mob_id: childMobId,
            member_id: childMemberId,
            profile: "worker",
            initial_message: startText,
            runtime_mode: "autonomous_host",
            auto_wire_parent: false,
          });
        else if (spawnStep === 2) item = final(childSpawnFinal);
        else throw new Error("Child bootstrap dispatched twice");
        spawnStep++;
      } else {
        NodeAssert.ok(
          users.some((text) => text.includes(startText)),
          "Target request has no original input",
        );
        NodeAssert.equal(
          finished,
          false,
          "Steering dispatched again after the original completion",
        );
        if (step === 0) {
          started.resolve();
          await bounded(
            releaseFirst.promise,
            "native steering admission before first model response",
            45_000,
          );
        } else {
          const outputs = payload.input.flatMap((value) => {
            const decoded = decodeToolOutput(value);
            return Option.isSome(decoded) ? [decoded.value] : [];
          });
          NodeAssert.ok(
            outputs.some((output) =>
              JSON.stringify(output.output).includes(`STEERING_TOOL_BOUNDARY_${step - 1}`),
            ),
            "The actual native tool result must precede this model boundary",
          );
          NodeAssert.ok(
            observeNative,
            "Native identity observation must be installed before releasing the model",
          );
          const native = observeNative();
          const count = users.filter((text) => text.includes(steerText)).length;
          boundaries.push({ boundary: step, exactUserAppends: count, ...native });
          if (count > 0) {
            NodeAssert.equal(count, 1, "Exactly one User append must reach the original run");
            NodeAssert.equal(
              users.filter((text) => text === steerText).length,
              1,
              "The steering body must be its own exact typed User message",
            );
            observed.resolve();
            await bounded(
              releaseFinal.promise,
              "independent session and exact native run assertions",
              45_000,
            );
            item = final(finalText);
            finished = true;
          } else
            NodeAssert.ok(
              step < 8,
              "Accepted steering did not reach eight actual tool boundaries in the original run",
            );
        }
        if (!finished)
          item = call("shell", {
            command: `${quote(process.execPath)} -e ${quote(`console.log('STEERING_TOOL_BOUNDARY_${step}')`)}`,
            timeout_secs: 10,
          });
        step++;
      }
      NodeAssert.ok(item, "Controlled provider must produce one response item");
      const responseId = `response_${id}`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [
          { type: "response.created", response: { id: responseId } },
          { type: "response.output_item.added", output_index: 0, item },
          ...("call_id" in item
            ? [{ ...item, type: "response.function_call_arguments.done", item_id: `fc_${id}` }]
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
      if (finished && latest !== survivorText && !latest.includes(childSpawnText))
        completed.resolve();
    } catch (error) {
      if (!tearingDown) {
        errors.push(error instanceof Error ? error.message : String(error));
        failed.reject(error);
      }
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "Controlled native steering fixture failed" } }),
      );
    }
  });
  return {
    provider,
    started: started.promise,
    observed: observed.promise,
    completed: completed.promise,
    survivor: survivor.promise,
    failed: failed.promise,
    boundaries,
    errors,
    installObservation: (read: NonNullable<typeof observeNative>) => {
      observeNative = read;
    },
    releaseFirst: () => releaseFirst.resolve(),
    releaseFinal: () => releaseFinal.resolve(),
    beginTeardown: () => {
      tearingDown = true;
      releaseFirst.resolve();
      releaseFinal.resolve();
    },
  };
}

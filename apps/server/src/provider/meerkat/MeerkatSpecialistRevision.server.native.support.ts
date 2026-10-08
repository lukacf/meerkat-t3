// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - isolated opt-in native acceptance evidence and controlled loopback provider.
import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { MeerkatTeamAgent, ProviderInstanceId } from "@t3tools/contracts";
import { createMeerkatGatewayClient } from "./MeerkatGatewayClient.ts";
import { makeMeerkatTeamReader } from "./MeerkatTeamReader.ts";
import { bounded, workflowKey } from "./MeerkatWorkflow.server.native.support.ts";

export const originalInstructions = "SPECIALIST_ORIGINAL_POLICY: own the original core behavior.";
export const revisedInstructions =
  "SPECIALIST_REVISED_POLICY: own core compatibility and inspect current dirty files before advice.";
export const revisedFocus = "Current core compatibility";
export const revisedCharter =
  "Own src/core.ts and replace stale assumptions with inspected evidence.";
export const specialistLabel = "Core specialist";
export const busyText =
  "SPECIALIST_BUSY_START: inspect your connected peer and complete this task.";
export const busyFinal = "SPECIALIST_BUSY_COMPLETE";
export const coordinatorBefore = "SPECIALIST_COORDINATOR_BEFORE";
export const coordinatorAfter = "SPECIALIST_COORDINATOR_AFTER";
export const brief = (version: number) =>
  `SPECIALIST_BRIEF_${version}: src/core.ts exports version ${version}.`;
export const fileContents = (version: number) => `export const version = ${version};\n`;

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
const decodeSavedAssistant = Schema.decodeUnknownOption(
  Schema.Struct({
    role: Schema.Literal("block_assistant"),
    blocks: Schema.Array(
      Schema.Struct({
        block_type: Schema.String,
        data: Schema.Struct({ text: Schema.optional(Schema.String) }),
      }),
    ),
  }),
);
const decodeTool = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("function"), name: Schema.String }),
);
const decodeOutput = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("function_call_output"),
    call_id: Schema.String,
    output: Schema.Union([
      Schema.String,
      Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
    ]),
  }),
);
const decodeObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));
const decodePeers = Schema.decodeUnknownOption(
  Schema.Struct({ peers: Schema.Array(Schema.Struct({ peer_id: Schema.String })) }),
);
const decodeProbe = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.String,
    current: Schema.String,
    head: Schema.String,
    status: Schema.String,
  }),
);
const decodePersistence = Schema.decodeUnknownSync(
  Schema.Struct({
    state_root: Schema.String,
    revision_version: Schema.Number,
    pending_revision_json: Schema.NullOr(Schema.String),
  }),
);
const decodeStudy = Schema.decodeUnknownSync(
  Schema.Struct({
    request_id: Schema.String,
    preparation_json: Schema.String,
  }),
);

export function messageTexts(input: readonly unknown[], role: string) {
  return input.flatMap((item) => {
    const parsed = decodeMessage(item);
    if (Option.isNone(parsed) || parsed.value.role !== role) return [];
    return [
      typeof parsed.value.content === "string"
        ? parsed.value.content
        : parsed.value.content.map((part) => part.text ?? "").join(""),
    ];
  });
}

export function savedAssistantTexts(input: readonly unknown[]) {
  return input.flatMap((item) => {
    const parsed = decodeSavedAssistant(item);
    return Option.isSome(parsed)
      ? [
          parsed.value.blocks
            .filter((block) => block.block_type === "text")
            .map((block) => block.data.text ?? "")
            .join(""),
        ]
      : [];
  });
}

function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function toolResult(input: readonly unknown[], callId: string) {
  const matches = input.flatMap((item) => {
    const parsed = decodeOutput(item);
    return Option.isSome(parsed) && parsed.value.call_id === callId ? [parsed.value] : [];
  });
  NodeAssert.equal(matches.length, 1, `Expected the actual native output for ${callId}`);
  const output = matches[0]!.output;
  const texts = typeof output === "string" ? [output] : output.map((part) => part.text ?? "");
  const values: unknown[] = [];
  const parse = (text: string) => {
    try {
      values.push(JSON.parse(text));
    } catch {
      /* Native shell includes plain status text. */
    }
  };
  for (const text of texts) {
    parse(text);
    for (const line of text.split("\n")) parse(line);
  }
  for (const value of [...values]) {
    const object = decodeObject(value);
    if (Option.isSome(object)) {
      NodeAssert.equal(object.value.error, undefined);
      NodeAssert.notEqual(object.value.is_error, true);
      NodeAssert.notEqual(object.value.isError, true);
      if (typeof object.value.stdout === "string")
        for (const line of object.value.stdout.split("\n")) parse(line);
    }
  }
  return values;
}

/** Read-only evidence from the exact fixture database, never admission or recovery. */
export function persistedSpecialist(databasePath: string, projectId: string, agentId: string) {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const agent = decodePersistence(
      database
        .prepare(
          "SELECT state_root, revision_version, pending_revision_json FROM meerkat_project_agents WHERE project_id = ? AND agent_id = ?",
        )
        .get(projectId, agentId),
    );
    const revisions = database
      .prepare(
        "SELECT revision_id, version, instructions FROM meerkat_project_agent_revisions WHERE agent_id = ? ORDER BY version",
      )
      .all(agentId);
    const studies = database
      .prepare(
        "SELECT request_id, preparation_json FROM meerkat_project_agent_studies WHERE agent_id = ? ORDER BY request_id",
      )
      .all(agentId)
      .map((row) => {
        const study = decodeStudy(row);
        return {
          requestId: study.request_id,
          preparation: JSON.parse(study.preparation_json) as unknown,
        };
      });
    return { agent, revisions, studies };
  } finally {
    database.close();
  }
}

/** Public native saved-history read for the exact domain state root, with no runtime load. */
export const readSpecialistHistory = Effect.fnUntraced(
  function* (input: {
    binaryPath: string;
    projectPath: string;
    nativeRoot: string;
    stateRoot: string;
    instanceId: ProviderInstanceId;
    env: NodeJS.ProcessEnv;
    agent: MeerkatTeamAgent;
  }) {
    const gateway = yield* Effect.acquireRelease(
      Effect.sync(() =>
        createMeerkatGatewayClient({
          binaryPath: input.binaryPath,
          cwd: input.projectPath,
          env: input.env,
          shutdownTimeoutMs: 15_000,
        }),
      ),
      (client) => Effect.promise(() => client.close()),
    );
    const reader = makeMeerkatTeamReader({
      client: gateway,
      path: yield* Path.Path,
      stateRoot: input.nativeRoot,
      instanceId: input.instanceId,
    });
    return yield* reader.history!({
      projectPath: input.projectPath,
      stateRoot: input.stateRoot,
      mobId: input.agent.mobId,
      identity: input.agent.record.identity,
      record: input.agent.record,
      limit: 100,
    });
  },
  Effect.scoped,
  Effect.provide(Path.layer),
);

export function controlledSpecialistProvider() {
  const busyStarted = Promise.withResolvers<void>();
  const releaseBusy = Promise.withResolvers<void>();
  const studyStarted = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const releaseStudy = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const failed = Promise.withResolvers<never>();
  void failed.promise.catch(() => undefined);
  const errors: string[] = [];
  const steps = new Map<string, number>();
  const studies: {
    prompt: string;
    fingerprint: string;
    probe?: { cwd: string; current: string; head: string; status: string };
  }[] = [];
  const peers = new Map<string, string>();
  const checkedTools: { key: string; step: number; name: string }[] = [];
  const completed = new Set<string>();
  let workspace: string | undefined;
  let tearingDown = false;
  let requests = 0;
  const provider = NodeHttp.createServer(async (request, response) => {
    try {
      NodeAssert.equal(request.method, "POST");
      NodeAssert.equal(request.url, "/v1/responses");
      NodeAssert.equal(request.headers.authorization, `Bearer ${workflowKey}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = decodeRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      NodeAssert.equal(payload.model, "gpt-5.6-sol");
      NodeAssert.ok(workspace, "Workspace must be installed before any native model request");
      requests++;
      const users = messageTexts(payload.input, "user");
      const assistants = messageTexts(payload.input, "assistant");
      const systems = [
        ...messageTexts(payload.input, "system"),
        ...messageTexts(payload.input, "developer"),
      ];
      const latest = users.at(-1) ?? "";
      let key: string;
      let studyIndex = -1;
      if (latest === coordinatorBefore || latest === coordinatorAfter) key = latest;
      else if (latest === busyText) key = "busy";
      else if (latest.startsWith(`Refresh the domain study for ${specialistLabel}.\n`)) {
        studyIndex = studies.findIndex((study) => study.prompt === latest);
        if (studyIndex < 0) {
          NodeAssert.ok(
            studies.length < 2,
            "Unexpected extra study: revision or in-flight refresh was replayed",
          );
          const fingerprint = /Study snapshot: ([a-f0-9]{64}) captured /.exec(latest)?.[1];
          NodeAssert.ok(fingerprint, "Study must carry a concrete captured content fingerprint");
          studies.push({ prompt: latest, fingerprint });
          studyIndex = studies.length - 1;
        }
        key = `study-${studyIndex + 1}`;
      } else throw new Error("Unexpected specialist fixture input");
      NodeAssert.equal(completed.has(key), false, `Duplicate native completion for ${key}`);
      const step = steps.get(key) ?? 0;
      const id = `call_specialist_${key}_${step}`;
      const previous = () => toolResult(payload.input, `call_specialist_${key}_${step - 1}`);
      const call = (name: string, args: object) => {
        const catalog = payload.tools.flatMap((tool) => {
          const parsed = decodeTool(tool);
          return Option.isSome(parsed) ? [parsed.value.name] : [];
        });
        NodeAssert.equal(
          catalog.filter((candidate) => candidate === name).length,
          1,
          `Missing native tool ${name}: ${catalog.join(",")}`,
        );
        checkedTools.push({ key, step, name });
        return {
          type: "function_call",
          id: `fc_${id}`,
          call_id: id,
          name,
          arguments: JSON.stringify(args),
          status: "completed",
        };
      };
      const final = (text: string) => {
        completed.add(key);
        return {
          type: "message",
          id: `message_${id}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text }],
        };
      };
      const observePeer = () => {
        const candidates = previous().flatMap((value) => {
          const parsed = decodePeers(value);
          return Option.isSome(parsed) ? [parsed.value.peers] : [];
        });
        // A single JSON string can also be its own line, so deduplicate identical decoded lists.
        const unique = [
          ...new Map(candidates.map((value) => [JSON.stringify(value), value])).values(),
        ];
        NodeAssert.equal(unique.length, 1);
        NodeAssert.equal(
          unique[0]!.length,
          1,
          "The fixture must have exactly one real connected peer",
        );
        peers.set(key, unique[0]![0]!.peer_id);
      };
      let item: object;
      if (key === coordinatorBefore || key === coordinatorAfter) {
        NodeAssert.equal(
          users.some((text) => text === busyText),
          false,
          "Specialist history leaked into coordinator",
        );
        if (key === coordinatorAfter)
          NodeAssert.equal(
            assistants.filter((text) => text === `${coordinatorBefore}_COMPLETE`).length,
            1,
          );
        if (step === 0) item = call("peers", {});
        else {
          NodeAssert.equal(step, 1);
          observePeer();
          if (key === coordinatorAfter)
            NodeAssert.equal(peers.get(key), peers.get(coordinatorBefore));
          item = final(`${key}_COMPLETE`);
        }
      } else if (key === "busy") {
        NodeAssert.ok(systems.some((text) => text.includes(originalInstructions)));
        NodeAssert.equal(
          systems.some((text) => text.includes(revisedInstructions)),
          false,
        );
        if (step === 0) item = call("peers", {});
        else {
          NodeAssert.equal(step, 1);
          observePeer();
          busyStarted.resolve();
          await bounded(
            releaseBusy.promise,
            "stage pending revision during actual specialist work",
            45_000,
          );
          item = final(busyFinal);
        }
      } else {
        NodeAssert.equal(
          systems.filter((text) => text.includes(revisedInstructions)).length,
          1,
          "Exactly one revised system instruction must reach the actual provider",
        );
        const revised = systems.find((text) => text.includes(revisedInstructions))!;
        for (const marker of [
          revisedFocus,
          revisedCharter,
          "Owned paths: src/core.ts",
          "supersedes older assignment text",
        ])
          NodeAssert.ok(revised.includes(marker), `Revised system instruction omitted ${marker}`);
        NodeAssert.equal(users.filter((text) => text === busyText).length, 1);
        NodeAssert.equal(assistants.filter((text) => text === busyFinal).length, 1);
        NodeAssert.equal(
          users.some((text) => text === coordinatorBefore),
          false,
          "Coordinator history leaked into specialist",
        );
        if (studyIndex === 1)
          NodeAssert.equal(assistants.filter((text) => text === brief(1)).length, 1);
        if (step === 0) {
          studyStarted[studyIndex]!.resolve();
          await bounded(
            releaseStudy[studyIndex]!.promise,
            "assert revision and deduplicated in-flight study",
            45_000,
          );
          const script =
            "const fs=require('node:fs'),cp=require('node:child_process'); console.log(JSON.stringify({cwd:fs.realpathSync('.'),current:fs.readFileSync('src/core.ts','utf8'),head:cp.execFileSync('/usr/bin/git',['show','HEAD:src/core.ts'],{encoding:'utf8'}),status:cp.execFileSync('/usr/bin/git',['status','--porcelain','--','src/core.ts'],{encoding:'utf8'})}));";
          item = call("shell", {
            command: `${quote(process.execPath)} -e ${quote(script)}`,
            timeout_secs: 10,
          });
        } else if (step === 1) {
          const candidates = previous().flatMap((value) => {
            const parsed = decodeProbe(value);
            return Option.isSome(parsed) ? [parsed.value] : [];
          });
          const expected = {
            cwd: workspace,
            current: fileContents(studyIndex + 1),
            head: fileContents(1),
            status: studyIndex === 0 ? "" : " M src/core.ts\n",
          };
          NodeAssert.ok(
            candidates.some((value) => JSON.stringify(value) === JSON.stringify(expected)),
            "Actual native shell did not observe the expected dirty worktree and unchanged HEAD",
          );
          studies[studyIndex]!.probe = expected;
          item = call("peers", {});
        } else {
          NodeAssert.equal(step, 2);
          observePeer();
          NodeAssert.equal(
            peers.get(key),
            peers.get("busy"),
            "Responsibility activation or study changed the native connected peer",
          );
          item = final(brief(studyIndex + 1));
        }
      }
      steps.set(key, step + 1);
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
    } catch (error) {
      if (!tearingDown) {
        errors.push(error instanceof Error ? error.message : String(error));
        failed.reject(error);
      }
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "Controlled specialist revision fixture failed" } }),
      );
    }
  });
  return {
    provider,
    errors,
    studies,
    peers,
    checkedTools,
    completed,
    failed: failed.promise,
    busyStarted: busyStarted.promise,
    studyStarted: studyStarted.map((signal) => signal.promise),
    setWorkspace: (path: string) => {
      workspace = path;
    },
    releaseBusy: () => releaseBusy.resolve(),
    releaseStudy: (index: number) => releaseStudy[index]!.resolve(),
    requestCount: () => requests,
    beginTeardown: () => {
      tearingDown = true;
      releaseBusy.resolve();
      for (const signal of releaseStudy) signal.resolve();
    },
  };
}

// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - opt-in actual server/native integration with private child processes and bounded failure deadlines.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  CommandId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type MeerkatTeamAgent,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";
import {
  availablePort,
  bounded,
  configureWorkspace,
  exchangeToken,
  ownedServer,
  prepareFixture,
  readRetainedNativeHistory,
  watch,
  withClient,
  workflowKey,
  workflowModel,
} from "./MeerkatWorkflow.server.native.support.ts";

const serverEntry = process.env.T3CODE_TEST_MEERKAT_SERVER_ENTRY;
const runtimeDirectory = process.env.T3CODE_TEST_MEERKAT_RUNTIME_DIR;
const activeDeleteOnly = process.env.T3CODE_TEST_MEERKAT_WORKFLOW_ACTIVE_DELETE_ONLY === "1";
const instanceId = ProviderInstanceId.make("meerkat");
const projectId = ProjectId.make("workflow-project");
const modelSelection = { instanceId, model: workflowModel };
const lanes = ["A", "B"] as const;
type Lane = (typeof lanes)[number];
type Workspace = { path: string; branch: string; contents: string; sha256: string };
const threadId = (lane: Lane) => ThreadId.make(`workflow-${lane}`);
const now = () => DateTime.formatIso(DateTime.nowUnsafe());
const encodeDiagnostic = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeInput = Schema.decodeUnknownSync(
  Schema.Struct({
    model: Schema.String,
    input: Schema.Array(Schema.Unknown),
    tools: Schema.Array(Schema.Unknown),
  }),
);
const decodeToolTag = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.String }));
const decodeFunctionTool = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("function"),
    name: Schema.String,
    parameters: Schema.Record(Schema.String, Schema.Unknown),
  }),
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
const decodeObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));
const decodeProbe = Schema.decodeUnknownOption(
  Schema.Struct({ cwd: Schema.String, branch: Schema.String, sha256: Schema.String }),
);
const decodeAnswer = Schema.decodeUnknownOption(
  Schema.Struct({
    dismissed: Schema.Literal(false),
    answers: Schema.Array(
      Schema.Struct({
        questionId: Schema.String,
        selectedOptionIds: Schema.Array(Schema.String),
        customText: Schema.String,
      }),
    ),
  }),
);

function toolCatalogMetadata(tools: readonly unknown[]) {
  const identifier = (value: unknown) =>
    typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,128}$/.test(value)
      ? value
      : "[absent-or-invalid]";
  return {
    total: tools.length,
    entries: tools.slice(0, 96).map((tool, index) => {
      const object = decodeObject(tool);
      return {
        index,
        type: identifier(Option.isSome(object) ? object.value.type : undefined),
        name: identifier(Option.isSome(object) ? object.value.name : undefined),
      };
    }),
  };
}

function userInputs(input: readonly unknown[]) {
  return input.flatMap((item) => {
    const result = decodeUser(item);
    return Option.isSome(result)
      ? [
          typeof result.value.content === "string"
            ? result.value.content
            : result.value.content.map((part) => part.text).join(""),
        ]
      : [];
  });
}

function toolResult(input: readonly unknown[], callId: string) {
  const matches = input.flatMap((item) => {
    const result = decodeOutput(item);
    return Option.isSome(result) && result.value.call_id === callId ? [result.value] : [];
  });
  expect(matches).toHaveLength(1);
  const output = matches[0]!.output;
  const texts = typeof output === "string" ? [output] : output.map((part) => part.text);
  const values: unknown[] = [];
  for (const text of texts) {
    try {
      values.push(JSON.parse(text));
    } catch {
      // Shell and native tool results can carry text alongside structured blocks.
    }
  }
  for (const value of values) {
    const object = decodeObject(value);
    if (Option.isSome(object)) {
      expect(object.value.error).toBeUndefined();
      expect(object.value.is_error).not.toBe(true);
      expect(object.value.isError).not.toBe(true);
    }
  }
  return { text: texts.join("\n"), values };
}

function shellQuote(text: string) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function probeCommand(workspace?: Workspace) {
  const script = `${workspace ? `process.chdir(${JSON.stringify(workspace.path)});` : ""}
const fs = require('node:fs'), cp = require('node:child_process'), crypto = require('node:crypto');
console.log(JSON.stringify({cwd: fs.realpathSync('.'), branch: cp.execFileSync('/usr/bin/git', ['branch', '--show-current'], {encoding:'utf8'}).trim(), sha256: crypto.createHash('sha256').update(fs.readFileSync('scope.txt')).digest('hex')}));`;
  return `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
}

function verifyProbe(result: ReturnType<typeof toolResult>, workspace: Workspace) {
  const candidates: unknown[] = [...result.values];
  // Native shell presents a compact exit-status line followed by literal stdout.
  for (const line of result.text.split("\n")) {
    try {
      candidates.push(JSON.parse(line));
    } catch {
      /* Status lines are not the probe. */
    }
  }
  for (const value of result.values) {
    const object = decodeObject(value);
    if (Option.isSome(object) && typeof object.value.stdout === "string") {
      for (const line of object.value.stdout.trim().split("\n")) {
        try {
          candidates.push(JSON.parse(line));
        } catch {
          /* Non-JSON diagnostics are not evidence. */
        }
      }
    }
  }
  const probes = candidates.flatMap((value) => {
    const probe = decodeProbe(value);
    return Option.isSome(probe) ? [probe.value] : [];
  });
  expect(probes).toContainEqual({
    cwd: workspace.path,
    branch: workspace.branch,
    sha256: workspace.sha256,
  });
}

const steeringText = "WF_CONTROL_STEER_A: inspect the actual steering message before continuing.";
const childMobId = "workflow-active-child-mob";

function controlledProvider() {
  const workspaces = new Map<Lane, Workspace>();
  const progress = new Map<string, number>();
  const peers = new Map<Lane, string>();
  const completed = new Set<string>();
  const errors: unknown[] = [];
  const checkedTools: { callId: string; name: string }[] = [];
  const toolCatalogs: ReturnType<typeof toolCatalogMetadata>[] = [];
  const steeringBoundaries: { boundary: number; exactSteeringMessages: number }[] = [];
  const deletionBoundaries: {
    event: string;
    at: string;
    writableEnded?: boolean;
  }[] = [];
  const noteDeletion = (event: string, response?: NodeHttp.ServerResponse) => {
    deletionBoundaries.push({
      event,
      at: now(),
      ...(response ? { writableEnded: response.writableEnded } : {}),
    });
  };
  const failed = Promise.withResolvers<never>();
  const releaseReviews = new Map(lanes.map((lane) => [lane, Promise.withResolvers<void>()]));
  void failed.promise.catch(() => undefined);
  const control = {
    originSettled: Promise.withResolvers<void>(),
    peerStarted: Promise.withResolvers<void>(),
    steerAccepted: Promise.withResolvers<void>(),
    steerObserved: Promise.withResolvers<void>(),
    peerStopped: Promise.withResolvers<void>(),
    reviewerWaiting: Promise.withResolvers<void>(),
    releaseReviewer: Promise.withResolvers<void>(),
  };
  const deletion = {
    childStarted: Promise.withResolvers<void>(),
    childStopped: Promise.withResolvers<void>(),
    toolStarted: Promise.withResolvers<void>(),
    toolStopped: Promise.withResolvers<void>(),
    toolPath: `/tracked-tool/${NodeCrypto.randomUUID()}`,
  };
  const holdUntilDisconnected = async (response: NodeHttp.ServerResponse, label: string) => {
    if (!response.destroyed)
      await bounded(new Promise<void>((resolve) => response.once("close", resolve)), label, 45_000);
    expect(response.writableEnded, `${label} must be cancellation, not a fixture response`).toBe(
      false,
    );
  };
  const blockingToolCommand = () => {
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Provider is not listening");
    // The ordinary foreground tool holds its own HTTP connection. Its closure,
    // observed before fixture teardown, is evidence that native deletion ended it.
    const script = `const http = require('node:http');
const request = http.request({host:'127.0.0.1',port:${address.port},path:${JSON.stringify(deletion.toolPath)},method:'POST'}, () => process.exit(92));
request.on('error', () => process.exit(93));
request.end(JSON.stringify({cwd:require('node:fs').realpathSync('.')}));
setTimeout(() => { request.destroy(); process.exit(94); }, 120000);`;
    return `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
  };
  let serial = 0;
  const provider = NodeHttp.createServer(async (request, response) => {
    try {
      expect(request.method).toBe("POST");
      if (request.url === deletion.toolPath) {
        response.once("close", () => noteDeletion("ordinary-tool-closed", response));
        const body: Buffer[] = [];
        for await (const chunk of request) body.push(Buffer.from(chunk));
        expect(JSON.parse(Buffer.concat(body).toString("utf8"))).toEqual({
          cwd: workspaces.get("A")!.path,
        });
        noteDeletion("ordinary-tool-started", response);
        deletion.toolStarted.resolve();
        await holdUntilDisconnected(response, "ordinary tracked tool closes after thread deletion");
        deletion.toolStopped.resolve();
        return;
      }
      expect(request.url).toBe("/v1/responses");
      expect(request.headers.authorization).toBe(`Bearer ${workflowKey}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = decodeInput(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const catalog = toolCatalogMetadata(payload.tools);
      toolCatalogs.push(catalog);
      if (toolCatalogs.length > 4) toolCatalogs.shift();
      const functions = payload.tools.flatMap((tool) => {
        const tag = decodeToolTag(tool);
        if (Option.isNone(tag))
          throw new Error(`Missing Responses tool discriminator: ${JSON.stringify(catalog)}`);
        // The released provider also adds hosted web_search entries without names.
        // Only a validated top-level function definition authorizes our function_call output.
        if (tag.value.type !== "function") return [];
        const definition = decodeFunctionTool(tool);
        if (Option.isNone(definition))
          throw new Error(`Invalid Responses function definition: ${JSON.stringify(catalog)}`);
        return [definition.value];
      });
      expect(payload.model).toBe("gpt-5.6-sol");
      const users = userInputs(payload.input);
      const latest = users.at(-1) ?? "";
      const match =
        /WF_(START|REVIEW_REQUEST|REVIEW_RESULT|CONTROL_START|CONTROL_REQUEST|CONTROL_RESULT|CONTROL_STEER|DELETE_ACTIVE|DELETE_CHILD|AFTER_ARCHIVE|AFTER_DELETE|SPECIALIST_ALIVE)_([AB])/.exec(
          latest,
        );
      if (!match) throw new Error(`Unexpected native input: ${latest.slice(0, 200)}`);
      const kind = match[1] === "CONTROL_STEER" ? "CONTROL_RESULT" : match[1]!,
        lane = match[2] as Lane,
        key = `${kind}_${lane}`;
      const step = progress.get(key) ?? 0;
      const workspace = workspaces.get(lane);
      if (!workspace) throw new Error("Native input arrived before its actual worktree existed");
      const id = `call_workflow_${key}_${step}`;
      const previous = () => toolResult(payload.input, `call_workflow_${key}_${step - 1}`);
      let item: object;
      const call = (name: string, args: object) => {
        expect(
          functions.filter((tool) => tool.name === name),
          `Missing or duplicate native function ${name}: ${JSON.stringify(catalog)}`,
        ).toHaveLength(1);
        checkedTools.push({ callId: id, name });
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
        expect(completed.has(key), `Duplicate completion ${key}`).toBe(false);
        completed.add(key);
        return {
          type: "message",
          id: `message_workflow_${key}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text }],
        };
      };
      const sendReceipt = () => expect(previous().text).toContain("peer_message_sent");
      if (kind === "START") {
        if (step === 0) item = call("shell", { command: probeCommand(), timeout_secs: 10 });
        else if (step === 1) {
          verifyProbe(previous(), workspace);
          item = call("peers", {});
        } else if (step === 2) {
          const lists = previous().values.flatMap((value) => {
            const result = decodePeers(value);
            return Option.isSome(result) ? [result.value.peers] : [];
          });
          expect(lists).toHaveLength(1);
          expect(lists[0]).toHaveLength(1);
          const peerId = lists[0]![0]!.peer_id;
          peers.set(lane, peerId);
          if (peers.size === 2) expect(peers.get("A")).toBe(peers.get("B"));
          item = call("send_message", {
            peer_id: peerId,
            body: `WF_REVIEW_REQUEST_${lane} ${JSON.stringify(workspace)}`,
            handling_mode: "queue",
          });
        } else if (step === 3) {
          sendReceipt();
          item = final(`WF_REQUESTED_${lane}`);
        } else throw new Error(`Unexpected coordinator step ${step}`);
      } else if (kind === "REVIEW_REQUEST") {
        expect(latest).toContain("Peer message from ");
        expect(users.some((user) => /WF_START_[AB]/.test(user))).toBe(false);
        expect(latest).toContain(workspace.path);
        if (step === 0) {
          await bounded(
            releaseReviews.get(lane)!.promise,
            `originating ${lane} turn completion before review`,
          );
          item = call("shell", { command: probeCommand(workspace), timeout_secs: 10 });
        } else if (step === 1) {
          verifyProbe(previous(), workspace);
          item =
            lane === "B"
              ? call("ui_multiple_choice", {
                  title: "Workflow review approval",
                  questions: [
                    {
                      id: "review",
                      question: "Return this worktree review?",
                      options: [
                        { id: "return-review", label: "Return review" },
                        { id: "hold", label: "Hold" },
                      ],
                      allowCustom: false,
                      multiSelect: false,
                    },
                  ],
                })
              : call("reply_to_peer", {
                  body: `WF_REVIEW_RESULT_${lane} ${workspace.sha256}`,
                  handling_mode: "queue",
                });
        } else if (lane === "B" && step === 2) {
          const answers = previous().values.flatMap((value) => {
            const answer = decodeAnswer(value);
            return Option.isSome(answer) ? [answer.value] : [];
          });
          expect(answers).toEqual([
            {
              dismissed: false,
              answers: [
                { questionId: "review", selectedOptionIds: ["return-review"], customText: "" },
              ],
            },
          ]);
          item = call("reply_to_peer", {
            body: `WF_REVIEW_RESULT_${lane} ${workspace.sha256}`,
            handling_mode: "queue",
          });
        } else if (step === (lane === "B" ? 3 : 2)) {
          sendReceipt();
          item = final(`WF_REVIEW_SENT_${lane}`);
        } else throw new Error(`Unexpected reviewer step ${step}`);
      } else if (kind === "REVIEW_RESULT") {
        expect(step).toBe(0);
        expect(latest).toContain("Peer message from ");
        expect(latest).toContain(workspace.sha256);
        expect(users.some((user) => user.startsWith(`WF_START_${lane}`))).toBe(true);
        expect(users.some((user) => user.startsWith(`WF_START_${lane === "A" ? "B" : "A"}`))).toBe(
          false,
        );
        item = final(`WF_RECEIVED_${lane}`);
      } else if (kind === "CONTROL_START") {
        expect(lane).toBe("A");
        if (step === 0) {
          const peer = peers.get(lane);
          expect(peer).toBeTruthy();
          item = call("send_message", {
            peer_id: peer,
            body: "WF_CONTROL_REQUEST_A",
            handling_mode: "queue",
          });
        } else if (step === 1) {
          sendReceipt();
          item = final("WF_CONTROL_REQUESTED_A");
        } else throw new Error(`Unexpected control requester step ${step}`);
      } else if (kind === "CONTROL_REQUEST") {
        expect(latest).toContain("Peer message from ");
        if (step === 0) {
          await bounded(control.originSettled.promise, "T3 turn settled before control reply");
          item = call("reply_to_peer", {
            body: "WF_CONTROL_RESULT_A",
            handling_mode: "queue",
          });
        } else if (step === 1) {
          sendReceipt();
          control.reviewerWaiting.resolve();
          await bounded(control.releaseReviewer.promise, "independent reviewer release after Stop");
          item = final("WF_CONTROL_REVIEWER_FINISHED_A");
        } else throw new Error(`Unexpected control reviewer step ${step}`);
      } else if (kind === "CONTROL_RESULT") {
        expect(
          users.some(
            (user) => user.includes("Peer message from ") && user.includes("WF_CONTROL_RESULT_A"),
          ),
        ).toBe(true);
        if (step === 0) {
          control.peerStarted.resolve();
          await bounded(control.steerAccepted.promise, "public steering receipt");
          item = call("peers", {});
        } else {
          previous();
          const exactSteeringMessages = users.filter((user) => user.includes(steeringText)).length;
          steeringBoundaries.push({ boundary: step, exactSteeringMessages });
          if (exactSteeringMessages === 0) {
            // Console acceptance precedes its asynchronous native dispatch. Exercise
            // actual cooperative boundaries until that input reaches this running turn.
            // The public work assertion below still requires the original input/run;
            // a separate queued follow-up run cannot satisfy this proof.
            expect(step, "accepted steering never reached a cooperative boundary").toBeLessThan(20);
            item = call("peers", {});
          } else {
            expect(exactSteeringMessages).toBe(1);
            control.steerObserved.resolve();
            await holdUntilDisconnected(
              response,
              "steered native coordinator request cancellation",
            );
            control.peerStopped.resolve();
            return;
          }
        }
      } else if (kind === "DELETE_ACTIVE") {
        expect(lane).toBe("A");
        if (step === 0)
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
        else if (step === 1) {
          expect(previous().values).toContainEqual({ mob_id: childMobId });
          item = call("mob_spawn_member", {
            mob_id: childMobId,
            member_id: "workflow-active-child",
            profile: "worker",
            initial_message: "WF_DELETE_CHILD_A",
            runtime_mode: "autonomous_host",
            auto_wire_parent: false,
          });
        } else if (step === 2) {
          previous();
          await bounded(deletion.childStarted.promise, "owned native child performing work");
          item = call("shell", { command: blockingToolCommand(), timeout_secs: 120 });
        } else throw new Error(`Deleted ordinary tool unexpectedly continued at step ${step}`);
      } else if (kind === "DELETE_CHILD") {
        expect(lane).toBe("A");
        if (step === 0)
          item = call("shell", { command: probeCommand(workspace), timeout_secs: 10 });
        else if (step === 1) {
          verifyProbe(previous(), workspace);
          response.once("close", () => noteDeletion("owned-child-closed", response));
          noteDeletion("owned-child-started", response);
          deletion.childStarted.resolve();
          await holdUntilDisconnected(response, "owned native child request cancellation");
          deletion.childStopped.resolve();
          return;
        } else throw new Error(`Unexpected child step ${step}`);
      } else if (kind === "SPECIALIST_ALIVE") {
        expect(step).toBe(0);
        expect(users.join("\n")).toContain("WF_REVIEW_REQUEST_A");
        expect(users.join("\n")).toContain("WF_REVIEW_REQUEST_B");
        item = final("WF_SPECIALIST_ALIVE_COMPLETE");
      } else {
        expect(step).toBe(0);
        expect(users.some((user) => user.startsWith(`WF_START_${lane}`))).toBe(true);
        expect(users.join("\n")).toContain(`WF_REVIEW_RESULT_${lane}`);
        item = final(`WF_${kind}_COMPLETE_${lane}`);
      }
      progress.set(key, step + 1);
      const responseId = `response_workflow_${serial++}`;
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
      errors.push(error);
      failed.reject(error);
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Native workflow fixture failed" } }));
    }
  });
  return {
    provider,
    failed: failed.promise,
    workspaces,
    completed,
    errors,
    checkedTools,
    toolCatalogs,
    steeringBoundaries,
    deletionBoundaries,
    noteDeletion,
    peers,
    releaseReviews,
    control,
    deletion,
  };
}

async function initializeRepository(path: string, env: NodeJS.ProcessEnv) {
  const git = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      NodeChildProcess.execFile("/usr/bin/git", args, { cwd: path, env }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Native workflow fixture"]);
  await git(["config", "user.email", "workflow@example.invalid"]);
  await NodeFSP.writeFile(NodePath.join(path, "scope.txt"), "PROJECT_ROOT\n");
  await git(["add", "scope.txt"]);
  await git(["commit", "-m", "Initialize private workflow fixture"]);
}

function coordinator(agents: readonly MeerkatTeamAgent[], lane: Lane) {
  const matches = agents.filter(
    (agent) =>
      agent.threadId === threadId(lane) &&
      agent.mobKind === "thread" &&
      agent.record.runtime_member_id === "ingress" &&
      !agent.record.labels.source_mob_id,
  );
  expect(matches).toHaveLength(1);
  expect(matches[0]!.record.session_id).toBeTruthy();
  return matches[0]!;
}

function threadFailure(item: OrchestrationThreadStreamItem) {
  const session =
    item.kind === "snapshot"
      ? item.snapshot.thread.session
      : item.kind === "event" && item.event.type === "thread.session-set"
        ? item.event.payload.session
        : undefined;
  if (session?.status === "error")
    return new Error(
      `Native thread ${session.threadId} failed: ${session.lastError ?? "unknown error"}`,
    );
  if (
    item.kind === "event" &&
    item.event.type === "thread.activity-appended" &&
    item.event.payload.activity.kind === "provider.turn.start.failed"
  )
    return new Error(`Native thread ${item.event.payload.threadId} failed to start a turn`);
  return undefined;
}

describe.skipIf(!serverEntry || !runtimeDirectory)(
  "actual server native multi-worktree workflow",
  () => {
    it.live(
      activeDeleteOnly
        ? "routes reviews and deletes an active tool and child while preserving siblings (peer controls excluded)"
        : "routes reviews, steers and stops peer work, and deletes an active tool and child while preserving siblings",
      () =>
        Effect.gen(function* () {
          if (!serverEntry || !runtimeDirectory)
            throw new Error("Supply the prebuilt server entry and packaged runtime");
          if (!NodePath.isAbsolute(serverEntry) || !NodePath.isAbsolute(runtimeDirectory))
            throw new Error("Artifact paths must be absolute");
          const executable = process.env.T3CODE_TEST_MEERKAT_SERVER_EXECUTABLE;
          // Electron resolves files inside app.asar; ordinary Node cannot stat those entries.
          if (executable) {
            if (!NodePath.isAbsolute(executable))
              throw new Error("Server executable must be absolute");
            yield* Effect.promise(() => NodeFSP.access(executable));
          } else yield* Effect.promise(() => NodeFSP.access(serverEntry));
          const root = yield* Effect.promise(async () =>
            NodeFSP.realpath(
              await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-native-workflow-")),
            ),
          );
          yield* Effect.promise(() => NodeFSP.chmod(root, 0o700));
          const fixture = controlledProvider();
          let server: ReturnType<typeof ownedServer> | undefined;
          yield* Effect.addFinalizer((exit) =>
            Effect.gen(function* () {
              let cleanupComplete = false;
              yield* Effect.promise(async () => {
                // Persist closure observations before fixture teardown can close
                // either request. A post-teardown close cannot prove disposal.
                if (Exit.isFailure(exit)) {
                  const evidence = NodePath.join(root, "evidence");
                  await NodeFSP.mkdir(evidence, { recursive: true, mode: 0o700 });
                  await NodeFSP.writeFile(
                    NodePath.join(evidence, "workflow-deletion-boundaries.json"),
                    encodeDiagnostic(fixture.deletionBoundaries),
                    { mode: 0o600 },
                  );
                }
                for (const release of fixture.releaseReviews.values()) release.resolve();
                fixture.control.originSettled.resolve();
                fixture.control.steerAccepted.resolve();
                fixture.control.releaseReviewer.resolve();
                try {
                  await server?.close();
                  cleanupComplete = true;
                } finally {
                  fixture.provider.closeAllConnections();
                  if (fixture.provider.listening)
                    await new Promise<void>((resolve, reject) =>
                      fixture.provider.close((error) => (error ? reject(error) : resolve())),
                    );
                  if (Exit.isFailure(exit)) {
                    const evidence = NodePath.join(root, "evidence");
                    await NodeFSP.mkdir(evidence, { recursive: true, mode: 0o700 });
                    await NodeFSP.writeFile(
                      NodePath.join(evidence, "provider-tool-catalogs.json"),
                      encodeDiagnostic(fixture.toolCatalogs),
                      { mode: 0o600 },
                    );
                    await NodeFSP.writeFile(
                      NodePath.join(evidence, "workflow-steering-boundaries.json"),
                      encodeDiagnostic(fixture.steeringBoundaries),
                      { mode: 0o600 },
                    );
                  }
                  const evidence = NodePath.join(root, "evidence");
                  await NodeFSP.mkdir(evidence, { recursive: true, mode: 0o700 });
                  await NodeFSP.writeFile(
                    NodePath.join(evidence, "workflow-acceptance.json"),
                    encodeDiagnostic({
                      passed: Exit.isSuccess(exit) && cleanupComplete,
                      cleanupComplete,
                      peerControlsExercised: !activeDeleteOnly,
                      completed: [...fixture.completed].sort(),
                      checkedTools: fixture.checkedTools,
                      deletionBoundaries: fixture.deletionBoundaries,
                    }),
                    { mode: 0o600 },
                  );
                }
              }).pipe(
                Effect.ensuring(
                  Effect.suspend(() =>
                    Exit.isFailure(exit) || !cleanupComplete
                      ? Effect.logError(
                          `Native workflow failed; private evidence retained at ${root}`,
                        )
                      : Effect.logInfo(`Native workflow evidence retained at ${root}`),
                  ),
                ),
              );
            }),
          );
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                fixture.provider.once("error", reject);
                fixture.provider.listen(0, "127.0.0.1", resolve);
              }),
          );
          const address = fixture.provider.address();
          if (!address || typeof address === "string") throw new Error("No fixture provider port");
          const prepared = yield* Effect.promise(() =>
            prepareFixture(root, runtimeDirectory, address.port),
          );
          yield* Effect.promise(() => initializeRepository(prepared.projectPath, prepared.env));
          const port = yield* Effect.promise(availablePort);
          expect(port).not.toBe(52258);
          const origin = `http://127.0.0.1:${port}`;
          server = ownedServer(
            serverEntry,
            prepared.projectPath,
            prepared.baseDir,
            port,
            prepared.env,
            NodePath.join(prepared.evidenceRoot, "server-diagnostics.json"),
          );
          const ready = server.ready;
          const bearer = yield* exchangeToken(
            origin,
            yield* Effect.promise(() => bounded(ready, "actual T3 server readiness", 60_000)),
          );
          yield* withClient(origin, bearer, (client) =>
            Effect.gen(function* () {
              const config = yield* client[WS_METHODS.serverGetConfig]({});
              expect(
                config.providers
                  .filter((provider) => provider.enabled)
                  .map((provider) => provider.instanceId),
              ).toEqual([instanceId]);
              const provider = config.providers.find(
                (candidate) => candidate.instanceId === instanceId,
              );
              expect(provider?.status, provider?.message).toBe("ready");
              expect(provider?.models.some((candidate) => candidate.slug === workflowModel)).toBe(
                true,
              );
              expect(provider?.version).toBe(
                `${prepared.manifest.build.meerkatVersion} / MobKit ${prepared.manifest.build.mobkitVersion}`,
              );
              yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "project.create",
                commandId: CommandId.make("workflow-create-project"),
                projectId,
                title: "Native worktree workflow",
                workspaceRoot: prepared.projectPath,
                createdAt: now(),
              });
              for (const lane of lanes) {
                const branch = `codex/workflow-${lane.toLowerCase()}`;
                const result = yield* client[WS_METHODS.vcsCreateWorktree]({
                  cwd: prepared.projectPath,
                  refName: "main",
                  newRefName: branch,
                  path: NodePath.join(root, `worktree-${lane}`),
                });
                const path = yield* Effect.promise(() => NodeFSP.realpath(result.worktree.path));
                const contents = `WORKTREE_${lane}\n`;
                fixture.workspaces.set(lane, {
                  path,
                  branch,
                  contents,
                  sha256: NodeCrypto.createHash("sha256").update(contents).digest("hex"),
                });
                // Configure only isolated credentials. All thread, roster and topology state is created by public RPC.
                yield* Effect.promise(() =>
                  configureWorkspace(
                    path,
                    prepared.nativeRoot,
                    runtimeDirectory,
                    address.port,
                    prepared.env,
                  ),
                );
                yield* client[WS_METHODS.projectsWriteFile]({
                  cwd: path,
                  relativePath: "scope.txt",
                  contents,
                });
                yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                  type: "thread.create",
                  commandId: CommandId.make(`workflow-create-${lane}`),
                  threadId: threadId(lane),
                  projectId,
                  title: `Worktree ${lane} review`,
                  modelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch,
                  worktreePath: path,
                  createdAt: now(),
                });
              }
              const reviewer = yield* client[WS_METHODS.meerkatProjectAgentCreate]({
                accessMode: "full-access",
                projectId,
                instanceId,
                requestId: "workflow-reviewer",
                label: "Shared reviewer",
                role: "reviewer",
                instructions:
                  "Review the exact worktree specified by a requesting peer. Read its real file and reply using reply_to_peer. Ask a user question when required.",
                model: workflowModel,
              });
              expect(reviewer.connectionStatus, reviewer.error ?? undefined).toBe("connected");
              if (!reviewer.agentRef) throw new Error("Reviewer has no native reference");
              const reviewerTarget = { projectId, instanceId, agentRef: reviewer.agentRef };
              for (const lane of lanes)
                yield* client[WS_METHODS.meerkatThreadConnectionsSet]({
                  projectId,
                  instanceId,
                  threadId: threadId(lane),
                  agentIds: [reviewer.agentId],
                  requestId: `workflow-select-${lane}`,
                });
              const shell = yield* watch(
                client[ORCHESTRATION_WS_METHODS.subscribeShell]({ requestCompletionMarker: true }),
              );
              const attention = yield* watch(
                client[WS_METHODS.meerkatAttentionSubscribe]({ projectId }),
              );
              yield* shell.waitFor((item) => item.kind === "synchronized", "shell initialized");
              yield* attention.waitFor(
                (item) => item.kind === "synchronized",
                "attention initialized",
              );
              const readThread = (lane: Lane) =>
                client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId: threadId(lane) }).pipe(
                  Stream.filter((item) => item.kind === "snapshot"),
                  Stream.runHead,
                  Effect.map(Option.getOrThrow),
                  Effect.map((item) => item.snapshot.thread),
                );
              const send = (lane: Lane, text: string) =>
                client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                  type: "thread.turn.start",
                  commandId: CommandId.make(`command-${text}`),
                  threadId: threadId(lane),
                  message: {
                    messageId: MessageId.make(`message-${text}`),
                    role: "user",
                    text,
                    attachments: [],
                  },
                  modelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  createdAt: now(),
                });
              const awaitFinal = (lane: Lane, text: string) =>
                Effect.gen(function* () {
                  const stream = yield* watch(
                    client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId: threadId(lane) }),
                    threadFailure,
                  );
                  yield* stream.waitFor(
                    (item) =>
                      item.kind === "snapshot"
                        ? item.snapshot.thread.messages.some(
                            (message) =>
                              message.role === "assistant" &&
                              message.text === text &&
                              !message.streaming,
                          )
                        : item.kind === "event" &&
                          item.event.type === "thread.message-sent" &&
                          item.event.payload.role === "assistant" &&
                          item.event.payload.text === text &&
                          !item.event.payload.streaming,
                    `committed ${text}`,
                  );
                  const snapshot = yield* readThread(lane);
                  expect(
                    snapshot.messages.filter(
                      (message) => message.role === "assistant" && message.text === text,
                    ),
                  ).toHaveLength(1);
                  return snapshot;
                });
              const awaitIdle = (lane: Lane, afterIndex: number) =>
                shell.waitFor(
                  (item) =>
                    item.kind === "thread-upserted" &&
                    item.thread.id === threadId(lane) &&
                    item.thread.latestTurn?.state === "completed" &&
                    item.thread.session?.status === "ready",
                  `completed thread ${lane}`,
                  afterIndex,
                );
              const aIndex = shell.index();
              yield* send("A", "WF_START_A");
              yield* awaitFinal("A", "WF_REQUESTED_A");
              yield* awaitIdle("A", aIndex);
              fixture.releaseReviews.get("A")!.resolve();
              yield* awaitFinal("A", "WF_RECEIVED_A");
              yield* attention.waitFor(
                (item) =>
                  item.kind === "snapshot" &&
                  item.snapshot.items.some(
                    (entry) =>
                      entry.agentRef === reviewer.agentRef &&
                      entry.kind === "completion" &&
                      entry.detail === "WF_REVIEW_SENT_A" &&
                      entry.completionStatus === "completed",
                  ),
                "reviewer A completion before next independent review",
              );
              const bIndex = shell.index();
              yield* send("B", "WF_START_B");
              yield* awaitFinal("B", "WF_REQUESTED_B");
              yield* awaitIdle("B", bIndex);
              fixture.releaseReviews.get("B")!.resolve();
              const questionEvent = yield* attention.waitFor(
                (item) =>
                  item.kind === "snapshot" &&
                  item.snapshot.items.some(
                    (entry) =>
                      entry.agentRef === reviewer.agentRef &&
                      entry.kind === "question" &&
                      entry.active,
                  ),
                "offscreen reviewer question",
              );
              if (questionEvent.kind !== "snapshot") throw new Error("Expected attention snapshot");
              const questionItem = questionEvent.snapshot.items.find(
                (entry) =>
                  entry.agentRef === reviewer.agentRef && entry.kind === "question" && entry.active,
              );
              const question = questionItem?.question;
              if (!question) throw new Error("Actual native question missing");
              expect(question.toolCallId).toBe("call_workflow_REVIEW_REQUEST_B_1");
              const team = yield* client[WS_METHODS.meerkatProjectTeam]({ projectId });
              const nativeAgents = team.providers.flatMap((provider) => provider.agents);
              const ownerA = coordinator(nativeAgents, "A"),
                ownerB = coordinator(nativeAgents, "B");
              const nativeReviewer = nativeAgents.find(
                (agent) => agent.agentRef === reviewer.agentRef,
              );
              expect(question.sessionId).toBe(nativeReviewer?.record.session_id);
              expect(
                new Set([ownerA.record.session_id, ownerB.record.session_id, question.sessionId])
                  .size,
              ).toBe(3);
              const answer = {
                requestId: question.requestId,
                sessionId: question.sessionId,
                answers: [
                  { questionId: "review", selectedOptionIds: ["return-review"], customText: "" },
                ],
                dismissed: false,
              };
              const wrongOwner = yield* client[WS_METHODS.meerkatQuestionAnswer]({
                projectId,
                instanceId,
                threadId: threadId("B"),
                ...answer,
              }).pipe(Effect.result);
              expect(wrongOwner._tag).toBe("Failure");
              expect(
                (yield* client[WS_METHODS.meerkatQuestionAnswer]({ ...reviewerTarget, ...answer }))
                  .accepted,
              ).toBe(true);
              yield* awaitFinal("B", "WF_RECEIVED_B");
              yield* awaitIdle("B", bIndex);
              yield* attention.waitFor(
                (item) =>
                  item.kind === "snapshot" &&
                  item.snapshot.items.some(
                    (entry) =>
                      entry.agentRef === reviewer.agentRef &&
                      entry.kind === "completion" &&
                      entry.detail === "WF_REVIEW_SENT_B" &&
                      entry.completionStatus === "completed",
                  ),
                "reviewer B completion before roster mutation",
              );
              expect(
                (yield* client[WS_METHODS.meerkatQuestions](reviewerTarget)).requests,
              ).toHaveLength(0);
              for (const lane of lanes) {
                const links = yield* client[WS_METHODS.meerkatThreadConnections]({
                  projectId,
                  instanceId,
                  threadId: threadId(lane),
                });
                expect(
                  links.connections.find((connection) => connection.agentId === reviewer.agentId)
                    ?.status,
                ).toBe("connected");
                const snapshot = yield* readThread(lane);
                expect(
                  snapshot.messages.some(
                    (message) => message.text === `WF_RECEIVED_${lane === "A" ? "B" : "A"}`,
                  ),
                ).toBe(false);
              }
              // Both peer reviews have durable completion receipts. Read the
              // actual native-written stores before admitting more work.
              const firstUsage = yield* client[WS_METHODS.meerkatUsageSnapshot]({ instanceId });
              expect(firstUsage.coverage, encodeDiagnostic(firstUsage.issues)).toBe("complete");
              expect(firstUsage.sessions).toBeGreaterThanOrEqual(3);
              expect(firstUsage.totals?.inputTokens).toBeGreaterThan(0);
              expect(firstUsage.totals?.outputTokens).toBeGreaterThan(0);
              const repeatedUsage = yield* client[WS_METHODS.meerkatUsageSnapshot]({ instanceId });
              expect(repeatedUsage.coverage, encodeDiagnostic(repeatedUsage.issues)).toBe(
                "complete",
              );
              expect(repeatedUsage.sessions).toBe(firstUsage.sessions);
              expect(repeatedUsage.totals).toEqual(firstUsage.totals);
              const controlTarget = { projectId, instanceId, threadId: threadId("A") };
              if (!activeDeleteOnly) {
                const controlIndex = shell.index();
                yield* send("A", "WF_CONTROL_START_A");
                yield* awaitFinal("A", "WF_CONTROL_REQUESTED_A");
                yield* awaitIdle("A", controlIndex);
                const settledControlThread = yield* readThread("A");
                expect(settledControlThread.session?.activeTurnId).toBeNull();
                fixture.control.originSettled.resolve();
                yield* Effect.promise(() =>
                  bounded(
                    Promise.all([
                      fixture.control.peerStarted.promise,
                      fixture.control.reviewerWaiting.promise,
                    ]),
                    "peer coordinator and independent reviewer both active",
                  ),
                );
                const peerWork = yield* client[WS_METHODS.meerkatCoordinatorWork](controlTarget);
                expect(peerWork.busy).toBe(true);
                expect(peerWork.sessionId).toBe(ownerA.record.session_id);
                expect(peerWork.inputs).toHaveLength(1);
                const peerInput = peerWork.inputs[0]!;
                const selectedWork = {
                  ...controlTarget,
                  sessionId: peerWork.sessionId,
                  inputId: peerInput.inputId,
                  nativeRunId: peerInput.runId,
                };
                const steered = yield* client[WS_METHODS.meerkatCoordinatorSteer]({
                  ...selectedWork,
                  message: {
                    messageId: MessageId.make("workflow-peer-steer"),
                    text: steeringText,
                    attachments: [],
                  },
                  createdAt: now(),
                });
                expect(steered.status).toBe("accepted");
                fixture.control.steerAccepted.resolve();
                yield* Effect.promise(() =>
                  bounded(
                    fixture.control.steerObserved.promise,
                    "actual same-run model request contains accepted steering",
                  ),
                );
                const afterSteer = yield* readThread("A");
                expect(afterSteer.latestTurn?.turnId).toBe(settledControlThread.latestTurn?.turnId);
                expect(afterSteer.latestTurn?.state).toBe("completed");
                expect(afterSteer.session?.activeTurnId).toBeNull();
                expect(
                  afterSteer.messages.filter(
                    (message) => message.role === "user" && message.text === steeringText,
                  ),
                ).toHaveLength(1);
                expect(
                  (yield* client[WS_METHODS.meerkatCoordinatorWork](controlTarget)).inputs,
                ).toContainEqual(peerInput);
                // The released steering admission is session-bound after its exact input/run
                // precheck. This held-request proof does not claim an atomic run-bound API.
                expect(yield* client[WS_METHODS.meerkatCoordinatorStop](selectedWork)).toEqual({
                  accepted: true,
                  sessionId: peerWork.sessionId,
                  inputId: peerInput.inputId,
                  nativeRunId: peerInput.runId,
                });
                yield* Effect.promise(() =>
                  bounded(
                    fixture.control.peerStopped.promise,
                    "selected native peer request was cancelled",
                  ),
                );
                fixture.control.releaseReviewer.resolve();
                yield* attention.waitFor(
                  (item) =>
                    item.kind === "snapshot" &&
                    item.snapshot.items.some(
                      (entry) =>
                        entry.agentRef === reviewer.agentRef &&
                        entry.kind === "completion" &&
                        entry.detail === "WF_CONTROL_REVIEWER_FINISHED_A" &&
                        entry.completionStatus === "completed",
                    ),
                  "independent reviewer completes after coordinator Stop",
                );
                yield* Effect.gen(function* () {
                  for (;;) {
                    if (!(yield* client[WS_METHODS.meerkatCoordinatorWork](controlTarget)).busy)
                      return;
                    yield* Effect.sleep("25 millis");
                  }
                }).pipe(Effect.timeout("10 seconds"));
                const afterStop = yield* readThread("A");
                expect(afterStop.latestTurn?.turnId).toBe(settledControlThread.latestTurn?.turnId);
                expect(afterStop.session?.activeTurnId).toBeNull();
              }

              const extra = yield* client[WS_METHODS.meerkatProjectAgentCreate]({
                accessMode: "full-access",
                projectId,
                instanceId,
                requestId: "workflow-disposable",
                label: "Disposable specialist",
                role: "specialist",
                instructions: "Answer user messages directly.",
                model: workflowModel,
              });
              expect(extra.connectionStatus, extra.error ?? undefined).toBe("connected");
              for (const lane of lanes)
                yield* client[WS_METHODS.meerkatThreadConnectionsSet]({
                  projectId,
                  instanceId,
                  threadId: threadId(lane),
                  agentIds: [reviewer.agentId, extra.agentId],
                  requestId: `workflow-add-disposable-${lane}`,
                });
              yield* client[WS_METHODS.meerkatProjectAgentLifecycle]({
                projectId,
                agentId: extra.agentId,
                action: "archive",
              });
              const archiveIndex = shell.index();
              yield* send("B", "WF_AFTER_ARCHIVE_B");
              yield* awaitFinal("B", "WF_AFTER_ARCHIVE_COMPLETE_B");
              yield* awaitIdle("B", archiveIndex);
              for (const lane of lanes) {
                const links = yield* client[WS_METHODS.meerkatThreadConnections]({
                  projectId,
                  instanceId,
                  threadId: threadId(lane),
                });
                expect(links.desiredAgentIds).toEqual([reviewer.agentId]);
                expect(
                  links.connections.find((connection) => connection.agentId === reviewer.agentId)
                    ?.status,
                ).toBe("connected");
              }
              yield* send("A", "WF_DELETE_ACTIVE_A");
              yield* Effect.promise(() =>
                bounded(
                  Promise.all([
                    fixture.deletion.childStarted.promise,
                    fixture.deletion.toolStarted.promise,
                  ]),
                  "ordinary foreground shell and owned native child are both active",
                ),
              );
              expect((yield* client[WS_METHODS.meerkatCoordinatorWork](controlTarget)).busy).toBe(
                true,
              );
              const beforeDelete = yield* client[WS_METHODS.meerkatProjectTeam]({ projectId });
              const activeChildren = beforeDelete.providers
                .flatMap((provider) => provider.agents)
                .filter(
                  (agent) =>
                    agent.threadId === threadId("A") &&
                    agent.record.labels.source_mob_id === childMobId,
                );
              expect(activeChildren).toHaveLength(1);
              const ownedChild = activeChildren[0]!;
              expect(ownedChild.availability).toBe("live");
              expect(ownedChild.record.session_id).toBeTruthy();
              const childHistoryTarget = {
                projectId,
                instanceId,
                agentRef: ownedChild.agentRef,
                limit: 100,
              };
              const childBeforeDelete =
                yield* client[WS_METHODS.meerkatAgentActivity](childHistoryTarget);
              expect(childBeforeDelete.agent?.record.session_id).toBe(ownedChild.record.session_id);
              expect(childBeforeDelete.timeline.frames.length).toBeGreaterThan(0);
              const [childCommittedBeforeDelete] = yield* readRetainedNativeHistory({
                binaryPath: NodePath.join(runtimeDirectory, prepared.manifest.binary),
                projectPath: fixture.workspaces.get("A")!.path,
                nativeRoot: prepared.nativeRoot,
                instanceId,
                env: prepared.env,
                agents: [ownedChild],
              });
              expect(childCommittedBeforeDelete!.transcript).toBeDefined();
              expect(childCommittedBeforeDelete!.transcript!.sessionId).toBe(
                ownedChild.record.session_id,
              );
              expect(childCommittedBeforeDelete!.transcript!.storeRevision).toBeDefined();
              expect(fixture.deletionBoundaries.map(({ event }) => event)).toEqual([
                "owned-child-started",
                "ordinary-tool-started",
              ]);
              fixture.noteDeletion("deletion-dispatched");
              yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "thread.delete",
                commandId: CommandId.make("workflow-delete-A"),
                threadId: threadId("A"),
              });
              yield* shell.waitFor(
                (item) => item.kind === "thread-removed" && item.threadId === threadId("A"),
                "thread A removed",
              );
              fixture.noteDeletion("thread-removed");
              // The existing public create receipt drains prior deletion cleanup; a delete receipt alone does not.
              yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "thread.create",
                commandId: CommandId.make("workflow-delete-fence"),
                threadId: ThreadId.make("workflow-empty-fence"),
                projectId,
                title: "Deletion cleanup fence",
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt: now(),
              });
              fixture.noteDeletion("cleanup-fence-dispatched");
              // Observe actual resource closure before any test cleanup can close the provider.
              yield* Effect.promise(() =>
                Promise.all([
                  bounded(
                    fixture.deletion.toolStopped.promise,
                    "deletion cleanup closes the ordinary tool request",
                  ),
                  bounded(
                    fixture.deletion.childStopped.promise,
                    "deletion cleanup closes the owned child request",
                  ),
                ]),
              );
              const deletionEvents = fixture.deletionBoundaries.map(({ event }) => event);
              for (const closure of ["ordinary-tool-closed", "owned-child-closed"]) {
                expect(deletionEvents.filter((event) => event === closure)).toHaveLength(1);
                expect(deletionEvents.indexOf(closure)).toBeGreaterThan(
                  deletionEvents.indexOf("deletion-dispatched"),
                );
                expect(deletionEvents.indexOf(closure)).toBeLessThan(
                  deletionEvents.indexOf("cleanup-fence-dispatched"),
                );
                expect(
                  fixture.deletionBoundaries.find(({ event }) => event === closure)?.writableEnded,
                ).toBe(false);
              }
              const afterDelete = yield* client[WS_METHODS.meerkatProjectTeam]({ projectId });
              const survivors = afterDelete.providers.flatMap((provider) => provider.agents);
              expect(
                survivors.some(
                  (agent) => agent.threadId === threadId("A") && agent.availability === "live",
                ),
              ).toBe(false);
              expect(
                survivors.some(
                  (agent) =>
                    agent.agentRef === ownedChild.agentRef && agent.availability === "live",
                ),
              ).toBe(false);
              expect(survivors.some((agent) => agent.threadId === threadId("A"))).toBe(false);
              // Deletion hides conversations in T3, but it must not destroy their native stores.
              // The interrupted child's first turn is saved event evidence, not committed transcript.
              const [retainedChild, retainedOwner] = yield* readRetainedNativeHistory({
                binaryPath: NodePath.join(runtimeDirectory, prepared.manifest.binary),
                projectPath: fixture.workspaces.get("A")!.path,
                nativeRoot: prepared.nativeRoot,
                instanceId,
                env: prepared.env,
                agents: [ownedChild, ownerA],
              });
              expect(retainedChild!.transcript?.sessionId).toBe(ownedChild.record.session_id);
              expect(retainedChild!.transcript?.storeRevision).toBe(
                childCommittedBeforeDelete!.transcript!.storeRevision,
              );
              expect(retainedChild!.transcript?.messages).toEqual(
                childCommittedBeforeDelete!.transcript!.messages,
              );
              expect(encodeDiagnostic(retainedChild!.timeline.frames)).toContain(
                "WF_DELETE_CHILD_A",
              );
              expect(encodeDiagnostic(retainedChild!.timeline.frames)).toContain(
                "call_workflow_DELETE_CHILD_A_0",
              );
              expect(retainedOwner!.transcript?.sessionId).toBe(ownerA.record.session_id);
              expect(encodeDiagnostic(retainedOwner!.transcript?.messages)).toContain("WF_START_A");
              expect(
                (yield* client[WS_METHODS.meerkatProjectTeam]({ projectId })).providers
                  .flatMap((provider) => provider.agents)
                  .some((agent) => agent.threadId === threadId("A")),
              ).toBe(false);
              expect(coordinator(survivors, "B").record.session_id).toBe(ownerB.record.session_id);
              expect(
                survivors.find((agent) => agent.agentRef === reviewer.agentRef)?.record.session_id,
              ).toBe(question.sessionId);
              const survivorIndex = shell.index();
              yield* send("B", "WF_AFTER_DELETE_B");
              yield* awaitFinal("B", "WF_AFTER_DELETE_COMPLETE_B");
              yield* awaitIdle("B", survivorIndex);
              expect(
                (yield* client[WS_METHODS.meerkatAgentSend]({
                  ...reviewerTarget,
                  requestId: "workflow-specialist-alive",
                  text: "WF_SPECIALIST_ALIVE_B",
                  handlingMode: "queue",
                })).status,
              ).toBe("accepted");
              yield* attention.waitFor(
                (item) =>
                  item.kind === "snapshot" &&
                  item.snapshot.items.some(
                    (entry) =>
                      entry.agentRef === reviewer.agentRef &&
                      entry.kind === "completion" &&
                      entry.detail === "WF_SPECIALIST_ALIVE_COMPLETE" &&
                      entry.completionStatus === "completed",
                  ),
                "same specialist continues after unrelated thread deletion",
              );
              const reviewerHistory = yield* client[WS_METHODS.meerkatAgentActivity]({
                ...reviewerTarget,
                limit: 100,
              });
              expect(reviewerHistory.agent?.record.session_id).toBe(question.sessionId);
              const finalB = yield* readThread("B");
              for (const text of ["WF_START_B", "WF_AFTER_ARCHIVE_B", "WF_AFTER_DELETE_B"])
                expect(
                  finalB.messages.filter(
                    (message) => message.role === "user" && message.text === text,
                  ),
                ).toHaveLength(1);
              expect(fixture.peers.size).toBe(2);
              expect([...fixture.completed].sort()).toEqual(
                [
                  "START_A",
                  "REVIEW_REQUEST_A",
                  "REVIEW_RESULT_A",
                  "START_B",
                  "REVIEW_REQUEST_B",
                  "REVIEW_RESULT_B",
                  "AFTER_ARCHIVE_B",
                  "AFTER_DELETE_B",
                  "SPECIALIST_ALIVE_B",
                  ...(!activeDeleteOnly ? ["CONTROL_START_A", "CONTROL_REQUEST_A"] : []),
                ].sort(),
              );
              expect(fixture.errors).toEqual([]);
              expect(
                yield* Effect.promise(() =>
                  NodeFSP.readFile(NodePath.join(prepared.projectPath, "scope.txt"), "utf8"),
                ),
              ).toBe("PROJECT_ROOT\n");
            }),
          ).pipe(Effect.raceFirst(Effect.promise(() => fixture.failed)));
        }).pipe(Effect.scoped, Effect.timeout("240 seconds")),
      250_000,
    );
  },
);

// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - this opt-in test owns native children, a loopback fixture, real-process timing evidence and bounded failure deadlines.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ConsoleIdentityRecord,
  ConsoleTimelineWindowPage,
  MeerkatImageRead,
  MeerkatImageUpload,
  MeerkatSavedTranscript,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  createMeerkatGatewayClient,
  decodeMeerkatGatewayEvent,
  type MeerkatGatewayClient,
  type MeerkatGatewayEvent,
} from "./MeerkatGatewayClient.ts";

const binaryPath = process.env.T3CODE_TEST_MEERKAT_BINARY;
const previousBinaryPath = process.env.T3CODE_TEST_MEERKAT_PREVIOUS_BINARY;
const creationTimeoutMs = 60_000;
const maximumShutdownBudgetMs = 420_000;
// At most four distinct processes close sequentially in the upgrade case.
// This outer ceiling must not interrupt an owned process's native cleanup.
const fixtureTimeoutMs = 4 * (maximumShutdownBudgetMs + 5_000) + 5 * creationTimeoutMs + 180_000;
const decodeHealth = Schema.decodeUnknownSync(
  Schema.Struct({
    ok: Schema.Literal(true),
    shutdownHorizonMs: Schema.Number,
    build: Schema.Struct({
      gatewayVersion: Schema.String,
      meerkatVersion: Schema.String,
      mobkitVersion: Schema.String,
      cargoLockSha256: Schema.String,
      platform: Schema.String,
      arch: Schema.String,
    }),
  }),
);

async function executableIdentity(path: string) {
  const realPath = await NodeFSP.realpath(path);
  const before = await NodeFSP.stat(realPath);
  const hash = NodeCrypto.createHash("sha256");
  for await (const bytes of NodeFS.createReadStream(realPath)) hash.update(bytes);
  const after = await NodeFSP.stat(realPath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
    throw new Error("Native executable changed while recording its identity");
  }
  return { path: realPath, sha256: hash.digest("hex"), bytes: after.size };
}

function failureEvidence(error: unknown) {
  const fields = record(error);
  const details = record(fields?.details);
  const safeMessage = (message: string) =>
    message.replaceAll("cold-fixture-key", "[fixture credential]").slice(0, 4_000);
  return {
    name: error instanceof Error ? error.name : "UnknownFailure",
    // This fixture owns synthetic data only. Never retain request parameters,
    // provider payloads, the inherited environment, or credentials in evidence.
    message: safeMessage(error instanceof Error ? error.message : "Non-Error failure"),
    ...(typeof details?.error === "string" ? { nativeError: safeMessage(details.error) } : {}),
    ...(Array.isArray(details?.errors)
      ? {
          cleanupErrors: details.errors
            .filter((value): value is string => typeof value === "string")
            .slice(0, 16)
            .map(safeMessage),
        }
      : {}),
    ...(typeof fields?.kind === "string" ? { kind: fields.kind } : {}),
    ...(typeof fields?.typedCode === "string" ? { typedCode: fields.typedCode } : {}),
    ...(typeof fields?.outcomeUnknown === "boolean"
      ? { outcomeUnknown: fields.outcomeUnknown }
      : {}),
  };
}

type ProcessEvidence = {
  phase: string;
  pid: number | null;
  executable: Awaited<ReturnType<typeof executableIdentity>>;
  health?: ReturnType<typeof decodeHealth>;
  shutdownBudgetMs?: number;
  cleanup?: "settled" | "failed";
  closeObservation?: {
    kind: string;
    cleanupCompleted: boolean | null;
    trigger: string | null;
  };
};
const imageBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const decodeSnapshot = Schema.decodeUnknownSync(
  Schema.Struct({
    loaded: Schema.Boolean,
    mobs: Schema.Array(
      Schema.Struct({ mobId: Schema.String, identities: Schema.Array(ConsoleIdentityRecord) }),
    ),
  }),
);
const decodeHistory = Schema.decodeUnknownSync(
  Schema.Struct({ transcript: MeerkatSavedTranscript, timeline: ConsoleTimelineWindowPage }),
);
const decodeTimeline = Schema.decodeUnknownSync(
  Schema.Struct({ timeline: ConsoleTimelineWindowPage }),
);
const decodeAssistant = Schema.decodeUnknownSync(
  Schema.Struct({
    role: Schema.Literal("block_assistant"),
    assistant_message_id: Schema.String,
    blocks: Schema.Array(
      Schema.Struct({
        block_type: Schema.String,
        data: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  }),
);
const decodeReceipt = Schema.decodeUnknownSync(Schema.Struct({ runId: Schema.String }));
const decodeDeliveryPage = Schema.decodeUnknownSync(
  Schema.Struct({ events: Schema.Array(Schema.Unknown) }),
);
const decodeProviderInput = Schema.decodeUnknownSync(
  Schema.Struct({ model: Schema.String, input: Schema.Array(Schema.Unknown) }),
);
const decodeImageUpload = Schema.decodeUnknownSync(MeerkatImageUpload);
const decodeImageRead = Schema.decodeUnknownSync(MeerkatImageRead);

async function bounded<T>(work: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function savedTarget(snapshot: ReturnType<typeof decodeSnapshot>, mobId: string, name: string) {
  const identity = snapshot.mobs
    .find((mob) => mob.mobId === mobId)
    ?.identities.find((record) => record.identity === name);
  if (!identity?.session_id) throw new Error(`Missing saved session for ${mobId}/${name}`);
  return {
    identity: identity.identity,
    runtimeKey: identity.runtime_key,
    runtimeMemberId: identity.runtime_member_id,
    sessionId: identity.session_id,
    sourceMobId: identity.labels.source_mob_id ?? null,
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function assistantMessages(transcript: MeerkatSavedTranscript) {
  return transcript.messages.flatMap(({ message }) =>
    record(message)?.role === "block_assistant" ? [decodeAssistant(message)] : [],
  );
}

function assistantText(message: ReturnType<typeof decodeAssistant>) {
  return message.blocks
    .flatMap((block) =>
      ["text", "transcript"].includes(block.block_type) && typeof block.data.text === "string"
        ? [block.data.text]
        : [],
    )
    .join("");
}

async function readAssistantOccurrenceEvidence(
  client: MeerkatGatewayClient,
  target: Readonly<Record<string, unknown>>,
  expected: ReturnType<typeof savedTarget>,
  replies: readonly string[],
) {
  let active = true;
  try {
    return await bounded(
      (async () => {
        // Console forwarding is independent of turn admission/termination. Wait for
        // the actual console_event rows, never substitute the history projection.
        for (;;) {
          if (!active) throw new Error("Native occurrence observation deadline elapsed");
          const { timeline } = decodeTimeline(
            await client.request("mobs.v1.consoleTimeline", {
              ...target,
              identity: expected.identity,
              expected,
              limit: 100,
            }),
          );
          const { transcript } = decodeHistory(
            await client.request("mobs.v1.consoleHistory", { ...target, expected }),
          );
          expect(transcript.sessionId).toBe(expected.sessionId);
          const messages = assistantMessages(transcript);
          const live = timeline.frames.filter(
            (frame) =>
              frame.source.kind === "console_event" &&
              ["text_complete", "interaction_complete"].includes(frame.kind),
          );
          if (
            messages.length !== replies.length ||
            messages.some((message) =>
              ["text_complete", "interaction_complete"].some(
                (kind) =>
                  !live.some(
                    (frame) =>
                      frame.kind === kind &&
                      record(frame.payload)?.assistant_message_id === message.assistant_message_id,
                  ),
              ),
            )
          ) {
            await new Promise<void>((resolve) => setTimeout(resolve, 25));
            continue;
          }
          expect(messages.map(assistantText)).toEqual(replies);
          const ids = messages.map((message) => message.assistant_message_id);
          expect(new Set(ids).size).toBe(replies.length);
          for (const id of ids) {
            expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
          }
          for (const frame of live) {
            expect(frame.runtime_key).toBe(expected.runtimeKey);
            expect(frame.identity).toBe(expected.identity);
            expect(frame.session_id).toBe(expected.sessionId);
            expect(ids).toContain(record(frame.payload)?.assistant_message_id);
            const message = messages.find(
              (item) => item.assistant_message_id === record(frame.payload)?.assistant_message_id,
            )!;
            expect(
              record(frame.payload)?.[frame.kind === "text_complete" ? "content" : "result"],
            ).toBe(assistantText(message));
          }
          return { transcript, messages, live };
        }
      })(),
      `Native assistant occurrence did not reach console/history for ${expected.identity}/${expected.sessionId}`,
    );
  } finally {
    active = false;
  }
}

async function completeTurn(
  client: MeerkatGatewayClient,
  target: Readonly<Record<string, unknown>>,
  input: unknown,
) {
  const terminal = Promise.withResolvers<MeerkatGatewayEvent>();
  const events: MeerkatGatewayEvent[] = [];
  let runId: string | undefined;
  const accept = (event: MeerkatGatewayEvent) => {
    if (
      runId !== undefined &&
      event.run_id === runId &&
      ["run.completed", "run.failed", "run.cancelled"].includes(event.kind)
    ) {
      terminal.resolve(event);
    }
  };
  const unsubscribe = client.subscribe((event) => {
    events.push(event);
    accept(event);
  });
  try {
    const receipt = decodeReceipt(
      await client.request("mobs.v1.turnStart", {
        ...target,
        input,
        ingressKind: "desktop_interactive_turn",
      }),
    );
    runId = receipt.runId;
    // A fast fixture can finish before the admission response reaches Node.
    for (const event of events) accept(event);
    const final = await bounded(terminal.promise, `Native turn ${runId} did not terminate`);
    expect(final.kind, JSON.stringify(final)).toBe("run.completed");
    return { receipt, events: events.filter((event) => event.run_id === runId) };
  } finally {
    unsubscribe();
  }
}

describe.skipIf(!binaryPath)("native Meerkat cold restart", () => {
  it.each([
    { scenario: "same-version restart", initialBinary: binaryPath },
    ...(previousBinaryPath
      ? [{ scenario: "released runtime upgrade", initialBinary: previousBinaryPath }]
      : []),
  ])(
    "$scenario preserves exact assistant occurrences, sessions, images and unacknowledged output",
    async ({ scenario, initialBinary }) => {
      if (!binaryPath) throw new Error("Native test executable was not supplied");
      const root = await NodeFSP.realpath(
        await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "meerkat-cold-restart-test-")),
      );
      const projectPath = NodePath.join(root, "project");
      const stateRoot = NodePath.join(root, "state");
      const errors: unknown[] = [];
      const requests: Array<{ phase: string; hasImage: boolean }> = [];
      const provider = NodeHttp.createServer(async (request, response) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const payload = decodeProviderInput(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          expect(request.url).toBe("/v1/responses");
          expect(request.headers.authorization).toBe("Bearer cold-fixture-key");
          expect(payload.model).toBe("gpt-5.6-sol");
          const input = JSON.stringify(payload.input);
          const phase = input.includes("CONTINUE_COLD")
            ? "continue"
            : input.includes("REVIEW_COLD")
              ? "review"
              : input.includes("FIRST_COLD")
                ? "first"
                : undefined;
          if (!phase) throw new Error("Provider request has no explicit fixture input");
          if (phase === "continue") {
            expect(input).toContain("FIRST_COLD");
            expect(input).toContain("FIRST_COMPLETE");
            expect(input).toContain(`data:image/png;base64,${imageBase64}`);
            expect(input).not.toContain("REVIEW_COLD");
          }
          if (phase === "review") {
            expect(input).not.toContain("FIRST_COLD");
            expect(input).not.toContain("FIRST_COMPLETE");
            expect(input).not.toContain("data:image/png;base64,");
          }
          requests.push({ phase, hasImage: input.includes("data:image/png;base64,") });
          const item = {
            type: "message",
            id: `message_${requests.length}`,
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text:
                  phase === "first"
                    ? "FIRST_COMPLETE"
                    : phase === "review"
                      ? "REVIEW_COMPLETE"
                      : "FIRST_COMPLETE",
              },
            ],
          };
          const events = [
            { type: "response.created", response: { id: `response_${requests.length}` } },
            { type: "response.output_item.added", output_index: 0, item },
            {
              type: "response.completed",
              response: {
                id: `response_${requests.length}`,
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
            JSON.stringify({ error: { message: "Cold restart fixture assertion failed" } }),
          );
        }
      });
      let client: MeerkatGatewayClient | undefined;
      let stage = "prepare fixture";
      let primaryFailure: unknown;
      let failed = false;
      const cleanupFailures: unknown[] = [];
      const evidenceFailures: unknown[] = [];
      const ownedClients = new Set<MeerkatGatewayClient>();
      const processes: ProcessEvidence[] = [];
      const steps: Array<{
        stage: string;
        operation: string;
        pid: number | null;
        startedAt: string;
        elapsedMs?: number;
        status: "pending" | "passed" | "failed";
        error?: ReturnType<typeof failureEvidence>;
      }> = [];
      const evidencePath = NodePath.join(root, "restart-evidence.json");
      let evidenceWrites = Promise.resolve();
      const persistEvidence = () => {
        const contents =
          JSON.stringify(
            {
              scenario,
              stage,
              status:
                failed || cleanupFailures.length > 0 || evidenceFailures.length > 0
                  ? "failed"
                  : stage === "finished"
                    ? "passed"
                    : "running",
              creationTimeoutMs,
              maximumShutdownBudgetMs,
              processes,
              steps,
              requests,
              providerErrors: errors.map(failureEvidence),
              ...(failed ? { failure: failureEvidence(primaryFailure) } : {}),
              cleanupFailures: cleanupFailures.map(failureEvidence),
              evidenceFailures: evidenceFailures.map(failureEvidence),
            },
            null,
            2,
          ) + "\n";
        // Serialize atomic replacements when failure cleanup closes two owners
        // together. An evidence write failure must never prevent native cleanup.
        evidenceWrites = evidenceWrites.then(async () => {
          try {
            const temporary = `${evidencePath}.tmp`;
            await NodeFSP.writeFile(temporary, contents, { mode: 0o600 });
            await NodeFSP.rename(temporary, evidencePath);
          } catch (error) {
            evidenceFailures.push(error);
          }
        });
        return evidenceWrites;
      };
      const observe = async <T>(
        pid: number | undefined,
        operation: string,
        work: () => Promise<T>,
      ) => {
        const step: (typeof steps)[number] = {
          stage,
          operation,
          pid: pid ?? null,
          startedAt: new Date().toISOString(),
          status: "pending",
        };
        steps.push(step);
        const started = Date.now();
        await persistEvidence();
        try {
          const result = await work();
          step.status = "passed";
          return result;
        } catch (error) {
          step.status = "failed";
          step.error = failureEvidence(error);
          throw error;
        } finally {
          step.elapsedMs = Date.now() - started;
          await persistEvidence();
        }
      };
      try {
        await NodeFSP.mkdir(projectPath);
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
          `[realm.${realm}]
default_binding = "fixture"
[realm.${realm}.backend.fixture]
provider = "openai"
backend_kind = "openai_api"
base_url = "http://127.0.0.1:${address.port}"
[realm.${realm}.auth.fixture]
provider = "openai"
auth_method = "api_key"
source = { kind = "env", env = "MEERKAT_COLD_FIXTURE_KEY" }
[realm.${realm}.binding.fixture]
backend_profile = "fixture"
auth_profile = "fixture"
provider_default = true
[model_fallback]
enabled = false
`,
        );
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          MEERKAT_COLD_FIXTURE_KEY: "cold-fixture-key",
        };
        for (const key of Object.keys(env)) {
          if (/OPENAI|ANTHROPIC|GEMINI|GOOGLE|AZURE|PROXY/.test(key)) delete env[key];
        }
        const start = async (phase: string, executable = binaryPath) => {
          stage = phase;
          const executableBuild = await executableIdentity(executable);
          const native = createMeerkatGatewayClient({
            binaryPath: executableBuild.path,
            cwd: projectPath,
            env,
            requestTimeoutMs: 15_000,
            // Omit the override: the production client uses health's native
            // horizon plus its 15s margin (currently 337s + 15s = 352s).
          });
          const processEvidence: ProcessEvidence = {
            phase,
            pid: native.pid ?? null,
            executable: executableBuild,
          };
          processes.push(processEvidence);
          native.onClose((error) => {
            const details = record(error.details);
            const trigger = record(details?.trigger);
            processEvidence.closeObservation = {
              kind: error.kind,
              cleanupCompleted:
                typeof details?.cleanupCompleted === "boolean" ? details.cleanupCompleted : null,
              trigger: typeof trigger?.kind === "string" ? trigger.kind : null,
            };
          });
          let closing: Promise<void> | undefined;
          const tracked: MeerkatGatewayClient = {
            pid: native.pid,
            request: (method, params, options) =>
              observe(native.pid, method, () => native.request(method, params, options)),
            subscribe: (listener) => native.subscribe(listener),
            onClose: (listener) => native.onClose(listener),
            close: () => {
              closing ??= observe(
                native.pid,
                "close: native receipt and process exit",
                async () => {
                  try {
                    await native.close();
                    processEvidence.cleanup = "settled";
                  } catch (error) {
                    processEvidence.cleanup = "failed";
                    throw error;
                  } finally {
                    ownedClients.delete(tracked);
                  }
                },
              );
              return closing;
            },
          };
          ownedClients.add(tracked);
          const health = decodeHealth(await tracked.request("system.v1.health"));
          processEvidence.health = health;
          processEvidence.shutdownBudgetMs = Math.max(342_000, health.shutdownHorizonMs + 15_000);
          expect(Number.isSafeInteger(health.shutdownHorizonMs)).toBe(true);
          expect(health.shutdownHorizonMs).toBeGreaterThan(0);
          expect(processEvidence.shutdownBudgetMs).toBeLessThanOrEqual(maximumShutdownBudgetMs);
          expect(health.build.cargoLockSha256).toMatch(/^[0-9a-f]{64}$/);
          const sameExecutable = processes.find(
            (item) => item !== processEvidence && item.executable.path === executableBuild.path,
          );
          if (sameExecutable) {
            expect(executableBuild).toEqual(sameExecutable.executable);
            expect(health.build).toEqual(sameExecutable.health?.build);
          }
          await persistEvidence();
          return tracked;
        };
        const create = (
          owner: MeerkatGatewayClient,
          method: string,
          params: Readonly<Record<string, unknown>>,
        ) => owner.request(method, params, { timeoutMs: creationTimeoutMs });
        const scope = { projectPath, executionPath: projectPath, stateRoot, model: "gpt-5.6-sol" };
        const thread = {
          ...scope,
          mobId: "cold-thread",
          threadId: "cold-thread",
          agentIdentity: "ingress",
          includeNativeWorkers: true,
        };
        const reviewer = {
          ...scope,
          mobId: "cold-reviewer",
          agentIdentity: "reviewer",
          label: "Cold reviewer",
          role: "reviewer",
        };
        client = await start("initial runtime startup", initialBinary);
        const firstPid = client.pid;
        expect(firstPid).toBeTypeOf("number");
        await create(client, "mobs.v1.createThreadMob", thread);
        await create(client, "mobs.v1.createDomainMob", reviewer);
        stage = "initial conversations and durable evidence";
        const uploaded = decodeImageUpload(
          await client.request("mobs.v1.imageUpload", {
            ...thread,
            mediaType: "image/png",
            dataBase64: imageBase64,
          }),
        );
        const first = await completeTurn(client, thread, [
          { type: "text", text: "FIRST_COLD: remember this image and reply." },
          {
            type: "image",
            media_type: "image/png",
            source: "blob",
            blob_id: uploaded.blob.blobId,
          },
        ]);
        await completeTurn(
          client,
          { ...reviewer, threadId: "reviewer-conversation" },
          "REVIEW_COLD: record the independent review.",
        );
        const snapshot = decodeSnapshot(await client.request("mobs.v1.teamSnapshot", scope));
        const targets = [
          {
            target: thread,
            expected: savedTarget(snapshot, thread.mobId, "ingress"),
            marker: "FIRST",
          },
          {
            target: reviewer,
            expected: savedTarget(snapshot, reviewer.mobId, "reviewer"),
            marker: "REVIEW",
          },
        ];
        expect(targets[0]?.expected.sessionId).not.toBe(targets[1]?.expected.sessionId);
        const warmOccurrences: Awaited<ReturnType<typeof readAssistantOccurrenceEvidence>>[] = [];
        for (const { target, expected, marker } of targets) {
          warmOccurrences.push(
            await readAssistantOccurrenceEvidence(client, target, expected, [`${marker}_COMPLETE`]),
          );
        }
        const before = await client.request("mobs.v1.threadDeliveries", thread);
        const pending = decodeDeliveryPage(before).events.map(decodeMeerkatGatewayEvent);
        expect(pending.map((event) => event.kind)).toEqual([
          "run.output.complete",
          "run.completed",
        ]);
        expect(pending).toEqual(
          first.events.filter((event) =>
            ["run.output.complete", "run.completed"].includes(event.kind),
          ),
        );
        expect(pending[0]?.payload.text).toBe("FIRST_COMPLETE");
        expect(new Set(pending.map((event) => event.event_id)).size).toBe(2);

        if (initialBinary !== binaryPath) {
          // An idle predecessor still owns its SQLite connection. Upgrade must
          // refuse that exact owner, even when no database write is in flight.
          const competing = await start("competing owner refusal");
          await expect(create(competing, "mobs.v1.createThreadMob", thread)).rejects.toMatchObject({
            typedCode: "POLICY_ERROR",
            details: {
              error: expect.stringContaining("Cannot upgrade saved conversation storage"),
            },
          });
          const stillOwned = decodeHistory(
            await client.request("mobs.v1.consoleHistory", {
              ...thread,
              expected: targets[0]!.expected,
            }),
          );
          expect(assistantMessages(stillOwned.transcript)).toEqual(warmOccurrences[0]!.messages);
          await competing.close();
        }

        // close() awaits child exit. The next client owns a distinct process and
        // can learn these identities only from the saved workspace state.
        stage = "first shutdown";
        await client.close();
        client = await start("first cold restart and retained reads");
        expect(client.pid).toBeTypeOf("number");
        expect(client.pid).not.toBe(firstPid);
        expect(decodeSnapshot(await client.request("mobs.v1.teamSnapshot", scope)).loaded).toBe(
          false,
        );
        for (const [index, { target, expected, marker }] of targets.entries()) {
          const { transcript, timeline } = decodeHistory(
            await client.request("mobs.v1.consoleHistory", { ...target, expected }),
          );
          expect(transcript.sessionId).toBe(expected.sessionId);
          const messages = JSON.stringify(transcript.messages);
          expect(messages).toContain(`${marker}_COLD`);
          expect(messages).toContain(`${marker}_COMPLETE`);
          expect(messages).not.toContain(marker === "FIRST" ? "REVIEW_COLD" : "FIRST_COLD");
          expect(assistantMessages(transcript)).toEqual(warmOccurrences[index]!.messages);
          for (const live of warmOccurrences[index]!.live) {
            expect(timeline.frames.find((frame) => frame.id === live.id)).toEqual(live);
          }
        }
        const restoredImage = decodeImageRead(
          await client.request("mobs.v1.imageRead", { ...thread, blobId: uploaded.blob.blobId }),
        );
        expect(restoredImage.dataBase64).toBe(imageBase64);
        expect(restoredImage.blob).toEqual(uploaded.blob);
        expect(decodeSnapshot(await client.request("mobs.v1.teamSnapshot", scope)).loaded).toBe(
          false,
        );
        expect(requests).toHaveLength(2);

        const replay = await client.request("mobs.v1.threadDeliveries", thread);
        expect(replay).toEqual(before);
        for (const event of pending) {
          const acknowledgement = { ...thread, eventId: event.event_id };
          await expect(
            client.request("mobs.v1.acknowledgeThreadDelivery", acknowledgement),
          ).resolves.toMatchObject({ acknowledged: true });
          await expect(
            client.request("mobs.v1.acknowledgeThreadDelivery", acknowledgement),
          ).resolves.toMatchObject({ acknowledged: true });
        }
        expect(
          decodeDeliveryPage(await client.request("mobs.v1.threadDeliveries", thread)).events,
        ).toEqual([]);
        await expect(
          client.request("mobs.v1.runStatus", { ...thread, runId: first.receipt.runId }),
        ).resolves.toMatchObject({ status: "completed", runId: first.receipt.runId });
        expect(decodeSnapshot(await client.request("mobs.v1.teamSnapshot", scope)).loaded).toBe(
          false,
        );
        expect(requests).toHaveLength(2);

        stage = "resume saved runtimes";
        await create(client, "mobs.v1.createThreadMob", thread);
        await create(client, "mobs.v1.createDomainMob", reviewer);
        stage = "continued conversation and exact occurrence evidence";
        const resumed = decodeSnapshot(await client.request("mobs.v1.teamSnapshot", scope));
        for (const { target, expected } of targets) {
          expect(savedTarget(resumed, target.mobId, expected.identity)).toEqual(expected);
        }
        await completeTurn(
          client,
          thread,
          "CONTINUE_COLD: continue the same conversation after process restart.",
        );
        const threadTarget = targets[0]!.expected;
        const repeated = await readAssistantOccurrenceEvidence(client, thread, threadTarget, [
          "FIRST_COMPLETE",
          "FIRST_COMPLETE",
        ]);
        expect(repeated.messages[0]?.assistant_message_id).toBe(
          warmOccurrences[0]!.messages[0]?.assistant_message_id,
        );
        expect(repeated.messages[1]?.assistant_message_id).not.toBe(
          repeated.messages[0]?.assistant_message_id,
        );
        expect(errors).toEqual([]);
        expect(requests).toEqual([
          { phase: "first", hasImage: true },
          { phase: "review", hasImage: false },
          { phase: "continue", hasImage: true },
        ]);
        const secondPid = client.pid;
        stage = "second shutdown";
        await client.close();
        client = await start("second cold restart and retained reads");
        expect(client.pid).not.toBe(secondPid);
        expect(decodeSnapshot(await client.request("mobs.v1.teamSnapshot", scope)).loaded).toBe(
          false,
        );
        const afterSecondRestart = decodeHistory(
          await client.request("mobs.v1.consoleHistory", { ...thread, expected: threadTarget }),
        );
        expect(afterSecondRestart.transcript.sessionId).toBe(threadTarget.sessionId);
        expect(assistantMessages(afterSecondRestart.transcript)).toEqual(repeated.messages);
        for (const live of repeated.live) {
          expect(afterSecondRestart.timeline.frames.find((frame) => frame.id === live.id)).toEqual(
            live,
          );
        }
        expect(decodeSnapshot(await client.request("mobs.v1.teamSnapshot", scope)).loaded).toBe(
          false,
        );
        expect(requests).toHaveLength(3);
        expect(errors).toEqual([]);
        stage = "final shutdown";
        await client.close();
        client = undefined;
      } catch (error) {
        failed = true;
        primaryFailure = error;
      } finally {
        // Close every retained owner, including a competing process or a startup
        // whose health request failed. Cleanup never replaces the original error.
        const settlements = await Promise.allSettled(
          [...ownedClients].map((owner) => owner.close()),
        );
        for (const settlement of settlements) {
          if (settlement.status === "rejected") cleanupFailures.push(settlement.reason);
        }
        provider.closeAllConnections();
        try {
          if (provider.listening) {
            await new Promise<void>((resolve, reject) =>
              provider.close((error) => (error ? reject(error) : resolve())),
            );
          }
        } catch (error) {
          cleanupFailures.push(error);
        }
        if (!failed && cleanupFailures.length === 0 && evidenceFailures.length === 0)
          stage = "finished";
        await persistEvidence();
        // Retain only synthetic fixture state, outside the repository, so an
        // unknown admission or restoration failure can be diagnosed precisely.
        process.stderr.write(`Cold restart evidence (${scenario}): ${evidencePath}\n`);
      }
      if (failed || cleanupFailures.length > 0 || evidenceFailures.length > 0) {
        throw new AggregateError(
          [...(failed ? [primaryFailure] : []), ...cleanupFailures, ...evidenceFailures],
          `Native cold restart failed during ${stage}; retained evidence: ${evidencePath}`,
          failed ? { cause: primaryFailure } : undefined,
        );
      }
    },
    fixtureTimeoutMs,
  );
});

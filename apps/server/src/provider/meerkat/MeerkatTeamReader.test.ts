import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ConsoleIdentityRecord } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { MeerkatGatewayRpcError, type MeerkatGatewayClient } from "./MeerkatGatewayClient.ts";
import { makeMeerkatTeamReader } from "./MeerkatTeamReader.ts";

const record: ConsoleIdentityRecord = {
  identity: "worker",
  display_name: "Worker",
  runtime_key: "default",
  runtime_member_id: "internal-worker",
  visibility: "retired_readable",
  addressable: false,
  health: "unreachable",
  labels: { source_mob_id: "child" },
};
const frame = {
  id: "frame",
  cursor: "2",
  dedupe_key: "key",
  timestamp_ms: 10,
  runtime_key: "default",
  identity: "worker",
  kind: "replay_unavailable",
  status: "completed",
  frame_version: 4,
  updated_at_ms: 11,
  source: { kind: "synthetic" },
  payload: { arbitrary: [1, null, { text: "native" }] },
  parent_frame_id: "parent",
  caused_by_frame_id: "cause",
  source_event_id: "source-event",
};

const make = Effect.fnUntraced(function* (reply: (method: string) => unknown) {
  const calls: Array<{ method: string; params: Readonly<Record<string, unknown>> | undefined }> =
    [];
  const client: MeerkatGatewayClient = {
    pid: undefined,
    request: async (method, params) => {
      calls.push({ method, params });
      return reply(method);
    },
    subscribe: () => () => {},
    onClose: () => () => {},
    close: async () => {},
  };
  const reader = makeMeerkatTeamReader({
    client,
    path: yield* Path.Path,
    stateRoot: "/native-state",
    instanceId: ProviderInstanceId.make("meerkat-test"),
  });
  return { reader, calls };
});

describe("Meerkat native Team reader", () => {
  it.effect(
    "carries exact console skill keys without activating selections in quoted context",
    () =>
      Effect.gen(function* () {
        const { reader, calls } = yield* make(() => ({
          receipt: { input_frame_id: "native-frame" },
        }));
        const skill = { source_uuid: "b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64", skill_name: "review" };
        const other = { ...skill, source_uuid: "4fa3e1a2-5b6c-47d8-9012-3456789abcde" };
        const selected = `[review](meerkat-skill://${skill.source_uuid}/review)`;
        const text = `日本語: Use ${selected} and [review](meerkat-skill://${other.source_uuid}/review). Again ${selected}`;
        const target = {
          projectPath: "/project",
          mobId: "domain",
          record,
          requestId: "selected",
          text,
        };
        const image = {
          type: "image" as const,
          source: "blob" as const,
          media_type: "image/png" as const,
          blob_id: `sha256:${"a".repeat(64)}`,
        };
        yield* reader.send!({ ...target, images: [image], handlingMode: "queue" });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          method: "mobs.v1.consoleSend",
          params: {
            content: [{ type: "text", text }, image],
            skillReferences: [skill, other],
            handlingMode: "queue",
            idempotencyKey: "selected",
          },
        });
        yield* reader.send!({
          ...target,
          requestId: "quoted-context",
          skillSelectionText: "Explain this terminal output",
          handlingMode: "queue",
        });
        expect(calls).toHaveLength(2);
        expect(calls[1]?.params).toMatchObject({ content: text });
        expect(calls[1]?.params).not.toHaveProperty("skillReferences");
        yield* reader.send!({
          ...target,
          text: `${text}\nQuoted context: [quoted](meerkat-skill://00000000-0000-0000-0000-000000000000/quoted)`,
          skillSelectionText: selected,
          handlingMode: "queue",
        });
        expect(calls[2]?.params).toMatchObject({ skillReferences: [skill] });
      }).pipe(Effect.provide(Path.layer)),
  );
  it.effect("refuses steering and malformed console selections before native dispatch", () =>
    Effect.gen(function* () {
      const { reader, calls } = yield* make(() => ({}));
      const target = {
        projectPath: "/project",
        mobId: "domain",
        record,
        requestId: "refused",
      };
      for (const [handlingMode, text, message] of [
        [
          "steer",
          "[review](meerkat-skill://b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64/review)",
          "Skills start with a new turn",
        ],
        ["queue", "[review](meerkat-skill://missing/review)", "selection is invalid"],
      ] as const) {
        const refused = yield* Effect.result(reader.send!({ ...target, text, handlingMode }));
        Result.match(refused, {
          onFailure: (error) => expect(error.detail).toContain(message),
          onSuccess: () => expect.fail("Unsupported selection reached native dispatch"),
        });
      }
      expect(calls).toHaveLength(0);
    }).pipe(Effect.provide(Path.layer)),
  );
  it.effect("reads the exact saved native acceptance without sending or loading a runtime", () =>
    Effect.gen(function* () {
      const original = { ...record, session_id: "original" };
      const receipt = {
        interaction_id: "interaction",
        identity: original.identity,
        session_id: "original",
        input_frame_id: "input",
        cursor: "7",
        status: "delivered",
      };
      const { reader, calls } = yield* make(() => ({
        mobId: "domain",
        identity: original.identity,
        found: true,
        receipt,
      }));
      const target = {
        projectPath: "/project",
        stateRoot: "/saved-root",
        mobId: "domain",
        record: original,
        requestId: "exact-request",
      };
      expect(yield* reader.receipt!(target)).toEqual(receipt);
      const completion = {
        id: "done",
        cursor: "8",
        dedupe_key: "done",
        timestamp_ms: 8,
        runtime_key: original.runtime_key,
        identity: original.identity,
        session_id: "original",
        interaction_id: "interaction",
        kind: "interaction_complete",
        status: "completed",
        frame_version: 1,
        payload: {},
        source: { kind: "console_event" },
      };
      const cold = yield* make(() => ({
        mobId: "domain",
        identity: original.identity,
        found: true,
        receipt,
        completion,
      }));
      expect(yield* cold.reader.receipt!(target)).toEqual({ ...receipt, completion });
      const completionBinding = {
        source: "native-console-exact-interaction",
        identity: original.identity,
        runtimeKey: original.runtime_key,
        sessionId: "original",
        interactionId: "interaction",
        frameId: "done",
      };
      const sessionless = { ...completion, session_id: undefined };
      const anchored = yield* make(() => ({
        mobId: "domain",
        identity: original.identity,
        found: true,
        receipt,
        completion: sessionless,
        completionBinding,
      }));
      expect(yield* anchored.reader.receipt!(target)).toEqual({
        ...receipt,
        completion: sessionless,
        completionBinding,
      });
      for (const wrong of [
        { ...completionBinding, sessionId: "replacement" },
        { ...completionBinding, interactionId: "other-request" },
        { ...completionBinding, frameId: "other-frame" },
      ]) {
        const mismatched = yield* make(() => ({
          mobId: "domain",
          identity: original.identity,
          found: true,
          receipt,
          completion: sessionless,
          completionBinding: wrong,
        }));
        expect((yield* Effect.flip(mismatched.reader.receipt!(target))).detail).toContain(
          "different native interaction",
        );
      }
      for (const wrong of [
        { ...completion, session_id: "replacement" },
        { ...completion, interaction_id: "unrelated" },
        { ...completion, runtime_key: "another" },
        { ...completion, kind: "tool_complete" },
        { ...completion, payload: { reason: "steer_delivered" } },
        { ...completion, source: { kind: "session_history" } },
      ]) {
        const invalid = yield* make(() => ({
          mobId: "domain",
          identity: original.identity,
          found: true,
          receipt,
          completion: wrong,
        }));
        expect((yield* Effect.flip(invalid.reader.receipt!(target))).detail).toContain(
          "different native interaction",
        );
      }

      expect(calls).toEqual([
        {
          method: "mobs.v1.consoleReceipt",
          params: {
            projectPath: "/project",
            stateRoot: "/saved-root",
            mobId: "domain",
            idempotencyKey: "exact-request",
            expected: {
              identity: original.identity,
              runtimeKey: original.runtime_key,
              runtimeMemberId: original.runtime_member_id,
              sessionId: "original",
              sourceMobId: "child",
            },
          },
        },
      ]);
      const absent = yield* make(() => ({
        mobId: "domain",
        identity: original.identity,
        found: false,
      }));
      expect(yield* absent.reader.receipt!(target)).toBeUndefined();
      const mismatch = yield* make(() => ({
        mobId: "domain",
        identity: original.identity,
        found: true,
        receipt: { ...receipt, session_id: "replacement" },
      }));
      expect((yield* Effect.flip(mismatch.reader.receipt!(target))).detail).toContain(
        "different native session",
      );
      const foreign = yield* make(() => ({
        mobId: "other",
        identity: original.identity,
        found: true,
        receipt,
      }));
      expect((yield* Effect.flip(foreign.reader.receipt!(target))).detail).toContain(
        "different native target",
      );
      expect((yield* Effect.flip(reader.receipt!({ ...target, record }))).detail).toContain(
        "original native session",
      );
      expect(calls).toHaveLength(1);
    }).pipe(Effect.provide(Path.layer)),
  );

  it.effect("recovers typed steering admission without inventing a console interaction", () =>
    Effect.gen(function* () {
      const target = {
        projectPath: "/project",
        mobId: "mob",
        record: { ...record, session_id: "session-a" },
        requestId: "steer-a",
      };
      const receipt = {
        kind: "runtime_input" as const,
        status: "accepted" as const,
        identity: record.identity,
        sessionId: "session-a",
        inputId: "native-input",
        requestId: "steer-a",
        idempotencyKey: "meerkat-app:steer:v1:exact-native-key",
        handling_mode: "steer" as const,
      };
      const response = { mobId: "mob", identity: record.identity, found: true, receipt };
      const valid = yield* make(() => response);
      expect(yield* valid.reader.receipt!(target)).toEqual(receipt);
      for (const wrong of [
        { ...receipt, sessionId: "replacement" },
        { ...receipt, identity: "another-member" },
        { ...receipt, requestId: "another-request" },
        { ...receipt, idempotencyKey: "another-input-kind" },
      ]) {
        const invalid = yield* make(() => ({ ...response, receipt: wrong }));
        expect((yield* invalid.reader.receipt!(target).pipe(Effect.result))._tag).toBe("Failure");
      }
    }).pipe(Effect.provide(Path.layer)),
  );

  it.effect("searches the exact persisted native session and rejects another incarnation", () =>
    Effect.gen(function* () {
      const match = {
        sessionId: "session-a",
        storeRevision: "7",
        offset: 12,
        source: "assistant",
        snippet: "needle",
      };
      const { reader, calls } = yield* make(() => ({ match }));
      const target = {
        projectPath: "/worktree",
        stateRoot: "/owner-state",
        mobId: "mob",
        record: { ...record, session_id: "session-a" },
        query: "needle",
      };
      expect(yield* reader.search!(target)).toEqual(match);
      expect(calls[0]).toMatchObject({
        method: "mobs.v1.consoleSearch",
        params: {
          query: "needle",
          stateRoot: "/owner-state",
          expected: { sessionId: "session-a" },
        },
      });
      const wrong = yield* make(() => ({ match: { ...match, sessionId: "replacement" } }));
      expect((yield* wrong.reader.search!(target).pipe(Effect.result))._tag).toBe("Failure");
    }).pipe(Effect.provide(Path.layer)),
  );

  it.effect("preserves exact native owner-bound crew observations", () =>
    Effect.gen(function* () {
      const response = {
        observation: "loaded_runtimes",
        loaded: true,
        mobs: [
          {
            mobId: "root",
            kind: "thread",
            label: "Thread",
            consoleStatus: "ready",
            identities: [record],
            ownerBoundCrewIds: ["child"],
            stoppedCrewIds: ["child"],
          },
        ],
      };
      const { reader } = yield* make(() => response);
      expect(yield* reader.snapshot("/worktree")).toEqual(response);
    }).pipe(Effect.provide(Path.layer)),
  );

  it.effect(
    "keeps committed native messages and partial history separate from console frames",
    () =>
      Effect.gen(function* () {
        const transcript = {
          sessionId: "session-a",
          storeRevision: "7",
          totalMessages: 3,
          exhausted: false,
          nextBefore: 1,
          messages: [
            {
              offset: 1,
              message: { role: "user", content: "original input", native: { untouched: true } },
            },
            {
              offset: 2,
              message: {
                role: "block_assistant",
                blocks: [{ type: "text", text: "native reply" }],
              },
            },
          ],
        };
        const response = {
          mobId: "mob",
          identity: "worker",
          timeline: { frames: [frame] },
          transcript,
          historyStatus: "partial",
        };
        const { reader, calls } = yield* make(() => response);
        const query = {
          projectPath: "/worktree",
          stateRoot: "/owner-state",
          mobId: "mob",
          identity: "worker",
          record: { ...record, session_id: "session-a" },
          limit: 2,
          transcriptBefore: 3,
          transcriptRevision: "7",
        };
        expect(yield* reader.history!(query)).toEqual({
          timeline: response.timeline,
          transcript,
          historyStatus: "partial",
        });
        expect(calls[0]?.params).toMatchObject({
          transcriptBefore: 3,
          transcriptRevision: "7",
          stateRoot: "/owner-state",
          expected: { sessionId: "session-a" },
        });
        for (const bad of [
          { ...transcript, sessionId: "replacement" },
          { ...transcript, storeRevision: "8" },
        ]) {
          const broken = yield* make(() => ({ ...response, transcript: bad }));
          const result = yield* broken.reader.history!(query).pipe(
            Effect.match({ onFailure: (error) => error.detail, onSuccess: () => null }),
          );
          expect(result).toContain("different saved session or transcript revision");
        }
        const absent = yield* make(() => ({
          mobId: "mob",
          identity: "worker",
          timeline: response.timeline,
        }));
        const unavailable = yield* absent.reader.history!(query).pipe(
          Effect.match({ onFailure: (error) => error.detail, onSuccess: () => null }),
        );
        expect(unavailable).toContain("saved transcript is unavailable");
      }).pipe(Effect.provide(Path.layer)),
  );

  it.effect("preserves the native lifecycle refusal reason from older gateways", () =>
    Effect.gen(function* () {
      for (const message of [
        "Native crew resume failed",
        "Native crew resume failed: canonical resume refusal",
      ]) {
        const { reader } = yield* make(() => {
          throw new MeerkatGatewayRpcError({
            message,
            rpcCode: -32009,
            typedCode: "CONFLICT",
            details: { error: "canonical resume refusal" },
          });
        });
        const target = { projectPath: "/worktree", mobId: "root", record };
        const result = yield* reader.resume!(target).pipe(
          Effect.match({ onFailure: (error) => error.detail, onSuccess: () => null }),
        );
        expect(result).toBe("Native crew resume failed: canonical resume refusal");
      }
    }).pipe(Effect.provide(Path.layer)),
  );

  it.effect(
    "keeps crew lifecycle distinct from turn cancellation and forwards exact ownership",
    () =>
      Effect.gen(function* () {
        const { reader, calls } = yield* make((method) =>
          method === "mobs.v1.consoleStop"
            ? {
                mobId: "root",
                identity: record.identity,
                nativeRunId: "observed-run",
                accepted: true,
                receipt: { outcome: "stopped" },
              }
            : { stopped: true },
        );
        const target = {
          projectPath: "/worktree",
          stateRoot: "/exact-private-root",
          mobId: "root",
          record: { ...record, session_id: "session-a" },
        };
        yield* reader.stopCrew!(target);
        yield* reader.stop!({ ...target, nativeRunId: "observed-run" });
        expect(calls.map((call) => call.method)).toEqual([
          "mobs.v1.consoleStopCrew",
          "mobs.v1.consoleStop",
        ]);
        expect(calls[0]!.params).toEqual({
          projectPath: "/worktree",
          stateRoot: "/exact-private-root",
          mobId: "root",
          expected: {
            identity: "worker",
            runtimeKey: "default",
            runtimeMemberId: "internal-worker",
            sessionId: "session-a",
            sourceMobId: "child",
          },
        });
        expect(calls[1]!.params).toEqual({ ...calls[0]!.params, nativeRunId: "observed-run" });
      }).pipe(Effect.provide(Path.layer)),
  );
  it.effect(
    "only observes cold snapshots on the supplied connection and hashes the execution scope",
    () =>
      Effect.gen(function* () {
        const { reader, calls } = yield* make(() => ({
          observation: "loaded_runtimes",
          loaded: false,
          mobs: [],
        }));
        expect(yield* reader.snapshot("/workspace")).toEqual({
          observation: "loaded_runtimes",
          loaded: false,
          mobs: [],
        });
        yield* reader.snapshot("/other-worktree");
        expect(calls.map((call) => call.method)).toEqual([
          "mobs.v1.teamSnapshot",
          "mobs.v1.teamSnapshot",
        ]);
        expect(calls[0]?.params?.projectPath).toBe("/workspace");
        expect(calls[0]?.params?.stateRoot).toMatch(/^\/native-state\/projects\/[0-9a-f]{64}$/);
        expect(calls[0]?.params?.stateRoot).not.toBe(calls[1]?.params?.stateRoot);
      }).pipe(Effect.provide(Path.layer)),
  );

  it.effect(
    "preserves native identity and full activity envelope without inventing payload meaning",
    () =>
      Effect.gen(function* () {
        const page = { frames: [frame], latest_cursor: "2", next_cursor: "1" };
        const { reader, calls } = yield* make((method) =>
          method === "mobs.v1.teamSnapshot"
            ? {
                observation: "loaded_runtimes",
                loaded: true,
                mobs: [
                  {
                    mobId: "mob",
                    label: "Native",
                    kind: "thread",
                    consoleStatus: "ready",
                    identities: [record],
                  },
                ],
              }
            : { mobId: "mob", identity: "worker", timeline: page },
        );
        expect((yield* reader.snapshot("/workspace")).mobs[0]?.identities[0]).toEqual(record);
        expect(
          yield* reader.activity({
            projectPath: "/workspace",
            mobId: "mob",
            identity: "worker",
            limit: 50,
          }),
        ).toEqual(page);
        expect(calls[1]?.params).toMatchObject({
          projectPath: "/workspace",
          mobId: "mob",
          identity: "worker",
          mode: "recent",
          limit: 50,
        });
      }).pipe(Effect.provide(Path.layer)),
  );

  it.effect(
    "rejects malformed native identities instead of returning an empty healthy roster",
    () =>
      Effect.gen(function* () {
        const { reader } = yield* make(() => ({
          observation: "loaded_runtimes",
          loaded: true,
          mobs: [
            {
              mobId: "mob",
              label: "Native",
              kind: "thread",
              consoleStatus: "ready",
              identities: [{ ...record, runtime_member_id: 17 }],
            },
          ],
        }));
        expect((yield* Effect.flip(reader.snapshot("/workspace"))).detail).toContain(
          "runtime_member_id",
        );
      }).pipe(Effect.provide(Path.layer)),
  );

  it.effect("retains exact native-input completion and refuses a replacement session", () =>
    Effect.gen(function* () {
      const latestCompletion = {
        kind: "runtime_input",
        sessionId: "original",
        inputId: "input",
        runId: "run",
        status: "completed",
        timestampMs: 100,
      };
      const { reader, calls } = yield* make(() => ({ busy: false, latestCompletion }));
      const target = {
        projectPath: "/workspace",
        mobId: "mob",
        record: { ...record, session_id: "original" },
      };
      expect(yield* reader.work!(target)).toEqual({ status: "idle", latestCompletion });
      expect(calls.map((call) => call.method)).toEqual(["mobs.v1.consoleStatus"]);
      expect(
        (yield* Effect.flip(
          reader.work!({ ...target, record: { ...record, session_id: "replacement" } }),
        )).detail,
      ).toContain("different session");
    }).pipe(Effect.provide(Path.layer)),
  );

  it.effect("uses exact history scope and enriched native work fields", () =>
    Effect.gen(function* () {
      const { reader, calls } = yield* make((method) =>
        method === "mobs.v1.consoleStatus"
          ? {
              busy: true,
              interactionId: "active",
              nativeRunId: "observed-run",
              latestCompletion: {
                interactionId: "finished",
                status: "completed",
                timestampMs: 100,
              },
              objective: "Review",
              outcome: "Ready",
              model: "native-model",
              modelProvider: "openai",
              reasoning: {
                kind: "configured",
                values: [{ parameter: "reasoning_effort", value: "xhigh" }],
              },
            }
          : { mobId: "mob", identity: "worker", timeline: { frames: [] } },
      );
      const target = {
        projectPath: "/workspace",
        mobId: "mob",
        record: { ...record, session_id: "historic" },
      };
      yield* reader.history!({ ...target, identity: record.identity, limit: 10 });
      expect(calls[0]?.method).toBe("mobs.v1.consoleHistory");
      expect(calls[0]?.params?.expected).toMatchObject({
        sessionId: "historic",
        sourceMobId: "child",
      });
      expect(yield* reader.work!(target)).toMatchObject({
        status: "running",
        interactionId: "active",
        nativeRunId: "observed-run",
        objective: "Review",
        model: "native-model",
        modelProvider: "openai",
        reasoning: {
          kind: "configured",
          values: [{ parameter: "reasoning_effort", value: "xhigh" }],
        },
        latestCompletion: { interactionId: "finished" },
      });
      expect(calls.map((call) => call.method)).toEqual([
        "mobs.v1.consoleHistory",
        "mobs.v1.consoleStatus",
      ]);
    }).pipe(Effect.provide(Path.layer)),
  );

  it.effect("does not infer native reasoning when an older gateway omits it", () =>
    Effect.gen(function* () {
      for (const reasoning of [undefined, { kind: "unknown" }, { kind: "default" }]) {
        const { reader } = yield* make(() => ({
          busy: false,
          model: "same-model",
          ...(reasoning ? { reasoning } : {}),
          latestCompletion: { interactionId: "finished", status: "completed", timestampMs: 100 },
        }));
        const work = yield* reader.work!({ projectPath: "/workspace", mobId: "mob", record });
        if (reasoning) expect(work.reasoning).toEqual(reasoning);
        else expect(work).not.toHaveProperty("reasoning");
      }
    }).pipe(Effect.provide(Path.layer)),
  );

  it.effect("passes the session's native account observation without using provider defaults", () =>
    Effect.gen(function* () {
      for (const state of [
        undefined,
        "connected",
        "needs_auth",
        "reauth_required",
        "host_managed",
        "unknown",
      ] as const) {
        const modelAuth = state
          ? {
              state,
              source: "pinned",
              provider: "openai",
              realmId: "global",
              bindingId: "nondefault",
              profileId: "work",
            }
          : undefined;
        const { reader, calls } = yield* make(() => ({
          busy: false,
          model: "retained-model",
          ...(modelAuth ? { modelAuth } : {}),
          latestCompletion: { interactionId: "finished", status: "completed", timestampMs: 100 },
        }));
        const work = yield* reader.work!({
          projectPath: "/workspace",
          mobId: "mob",
          record: { ...record, session_id: "pinned-session" },
        });
        if (modelAuth) expect(work.modelAuth).toEqual(modelAuth);
        else expect(work).not.toHaveProperty("modelAuth");
        expect(calls.map((call) => call.method)).toEqual(["mobs.v1.consoleStatus"]);
        expect(calls[0]?.params?.expected).toMatchObject({ sessionId: "pinned-session" });
      }
    }).pipe(Effect.provide(Path.layer)),
  );

  it.effect("converts native queued model options and omits overrides from steering", () =>
    Effect.gen(function* () {
      const { reader, calls } = yield* make(() => ({ accepted: true }));
      const request = {
        projectPath: "/workspace",
        mobId: "mob",
        record,
        text: "Next",
        requestId: "request",
        modelSelection: {
          instanceId: ProviderInstanceId.make("meerkat-test"),
          model: "anthropic:claude-model",
          options: [{ id: "thinking", value: "adaptive" }],
        },
      };
      yield* reader.send!({ ...request, handlingMode: "queue" });
      expect(calls[0]?.params).toMatchObject({
        provider: "anthropic",
        model: "claude-model",
        providerParams: { thinking: { type: "adaptive" } },
      });
      yield* reader.send!({ ...request, handlingMode: "steer" });
      expect(calls[1]?.params).not.toHaveProperty("model");
      expect(calls[1]?.params).not.toHaveProperty("providerParams");
      yield* reader.send!({
        ...request,
        modelSelection: {
          instanceId: request.modelSelection.instanceId,
          model: request.modelSelection.model,
        },
        handlingMode: "queue",
      });
      expect(calls[2]?.params).toMatchObject({
        provider: "anthropic",
        model: "claude-model",
        providerParams: null,
      });
    }).pipe(Effect.provide(Path.layer)),
  );

  for (const effort of ["low", "high"] as const) {
    it.effect(
      `delegates cache defaults for an explicit specialist/worker model with ${effort} reasoning`,
      () =>
        Effect.gen(function* () {
          const { reader, calls } = yield* make((method) =>
            method === "models.v1.catalog"
              ? {
                  catalog: {
                    providers: [
                      {
                        provider: "openai",
                        models: [
                          {
                            id: "gpt-native",
                            profile: {
                              params_schema: {
                                properties: {
                                  reasoning_effort: { type: "string", enum: ["low", "high"] },
                                  prompt_cache_enabled: { type: "boolean" },
                                },
                              },
                            },
                          },
                        ],
                      },
                    ],
                  },
                }
              : { accepted: true },
          );
          const selection = {
            instanceId: ProviderInstanceId.make("meerkat-test"),
            model: "openai:gpt-native",
            options: [
              { id: "reasoning_effort", value: effort },
              { id: "prompt_cache_enabled", value: false },
            ],
          };
          const input = {
            projectPath: "/workspace",
            stateRoot: "/exact-domain-root",
            mobId: "mob",
            record,
            text: "Review",
            requestId: "immutable-request",
            handlingMode: "queue" as const,
            modelSelection: selection,
          };
          const prepared = yield* reader.prepareSend!(input);
          expect(calls).toHaveLength(1);
          expect(calls[0]?.method).toBe("models.v1.catalog");
          yield* prepared.dispatch();
          expect(calls[0]).toEqual({
            method: "models.v1.catalog",
            params: {
              projectPath: "/workspace",
              configStateRoot: expect.stringContaining("/native-state/projects/"),
            },
          });
          expect(calls[1]?.params).toMatchObject({
            provider: "openai",
            model: "gpt-native",
            stateRoot: "/exact-domain-root",
            idempotencyKey: "immutable-request",
          });
          expect(calls[1]?.params?.providerParams).toEqual({ reasoning_effort: effort });
          expect(selection.options[1]?.value).toBe(false);
          yield* reader.send!({ ...input, handlingMode: "steer" });
          expect(calls).toHaveLength(3);
          expect(calls[2]?.params).not.toHaveProperty("providerParams");
        }).pipe(Effect.provide(Path.layer)),
    );
  }

  it.effect("rejects malformed timeline frames and a response for another target", () =>
    Effect.gen(function* () {
      for (const response of [
        {
          mobId: "mob",
          identity: "worker",
          timeline: { frames: [{ ...frame, status: "invented" }] },
        },
        { mobId: "other-mob", identity: "worker", timeline: { frames: [frame] } },
        { mobId: "mob", identity: "other-worker", timeline: { frames: [frame] } },
      ]) {
        const { reader } = yield* make(() => response);
        const error = yield* Effect.flip(
          reader.activity({
            projectPath: "/workspace",
            mobId: "mob",
            identity: "worker",
            limit: 50,
          }),
        );
        expect(error._tag).toBe("ProviderDriverError");
      }
    }).pipe(Effect.provide(Path.layer)),
  );

  it.effect("forwards native since cursors for preparation history recovery", () =>
    Effect.gen(function* () {
      const { reader, calls } = yield* make(() => ({
        mobId: "domain",
        identity: "architect",
        timeline: { frames: [], exhausted: true },
      }));
      yield* reader.activity({
        projectPath: "/workspace",
        stateRoot: "/domain-state",
        mobId: "domain",
        identity: "architect",
        limit: 100,
        mode: "since",
        after: "opaque-cursor",
      });
      expect(calls[0]?.params).toMatchObject({
        mode: "since",
        after: "opaque-cursor",
        stateRoot: "/domain-state",
      });
      expect(calls[0]?.params).not.toHaveProperty("before");
    }).pipe(Effect.provide(Path.layer)),
  );

  it.effect(
    "uses the private domain root for activity and the complete canonical tuple for controls",
    () =>
      Effect.gen(function* () {
        const { reader, calls } = yield* make((method) =>
          method === "mobs.v1.consoleTimeline"
            ? { mobId: "domain", identity: "architect", timeline: { frames: [] } }
            : method === "mobs.v1.consoleStop"
              ? {
                  mobId: "domain",
                  identity: "architect",
                  nativeRunId: "observed-run",
                  accepted: true,
                  receipt: { outcome: "stopped" },
                }
              : { receipt: { input_frame_id: "native-frame" } },
        );
        const target = {
          projectPath: "/workspace",
          stateRoot: "/private-domain",
          mobId: "domain",
          record: {
            ...record,
            identity: "architect",
            session_id: "current-session",
            visibility: "addressable",
            addressable: true,
          } as ConsoleIdentityRecord,
        };
        yield* reader.activity({
          ...target,
          identity: "architect",
          limit: 20,
          before: "console:42",
        });
        yield* reader.send!({
          ...target,
          text: "Review",
          handlingMode: "steer",
          requestId: "delivery",
        });
        yield* reader.stop!({ ...target, nativeRunId: "observed-run" });
        expect(calls.map((call) => call.method)).toEqual([
          "mobs.v1.consoleTimeline",
          "mobs.v1.consoleSend",
          "mobs.v1.consoleStop",
        ]);
        expect(calls.every((call) => call.params?.stateRoot === "/private-domain")).toBe(true);
        expect(calls[0]?.params).toMatchObject({ mode: "recent", before: "console:42" });
        expect(calls[1]?.params).toMatchObject({
          content: "Review",
          handlingMode: "steer",
          idempotencyKey: "delivery",
          expected: {
            identity: "architect",
            runtimeKey: "default",
            runtimeMemberId: "internal-worker",
            sessionId: "current-session",
            sourceMobId: "child",
          },
        });
        expect(calls[2]?.params?.expected).toEqual(calls[1]?.params?.expected);
        expect(calls[2]?.params?.nativeRunId).toBe("observed-run");
      }).pipe(Effect.provide(Path.layer)),
  );

  it.effect(
    "rejects stale or mismatched native Stop receipts without stopping the latest run",
    () =>
      Effect.gen(function* () {
        const stopped = {
          mobId: "domain",
          identity: record.identity,
          nativeRunId: "observed-run",
          accepted: true,
          receipt: { outcome: "stopped" },
        };
        for (const response of [
          { ...stopped, accepted: false, receipt: { outcome: "not_current" } },
          { ...stopped, mobId: "other-mob" },
          { ...stopped, identity: "other-agent" },
          { ...stopped, nativeRunId: "newer-run" },
        ]) {
          const { reader, calls } = yield* make(() => response);
          const result = yield* Effect.result(
            reader.stop!({
              projectPath: "/project",
              mobId: "domain",
              record,
              nativeRunId: "observed-run",
            }),
          );
          Result.match(result, {
            onFailure: (error) =>
              expect(error.detail).toContain(
                response.accepted ? "different work" : "no longer stoppable",
              ),
            onSuccess: () => expect.fail("Stale or mismatched native Stop was accepted"),
          });
          expect(calls.map((call) => call.method)).toEqual(["mobs.v1.consoleStop"]);
          expect(calls[0]?.params?.nativeRunId).toBe("observed-run");
        }
      }).pipe(Effect.provide(Path.layer)),
  );

  it.effect(
    "creates read-only domain workers with durable project configuration and no prompt",
    () =>
      Effect.gen(function* () {
        const { reader, calls } = yield* make(() => ({ mob: { mobId: "domain" } }));
        yield* reader.connectDomain!({
          projectPath: "/workspace",
          stateRoot: "/private-domain",
          mobId: "domain",
          identity: "architect",
          label: "Architect",
          role: "architect",
          instructions: "Review design",
          model: "anthropic:claude-haiku-4-5",
          accessMode: "read-only",
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.method).toBe("mobs.v1.createDomainMob");
        expect(calls[0]?.params).toMatchObject({
          stateRoot: "/private-domain",
          agentIdentity: "architect",
          includeNativeWorkers: true,
          provider: "anthropic",
          model: "claude-haiku-4-5",
          providerParams: null,
          accessMode: "read-only",
        });
        expect(calls[0]?.params?.configStateRoot).toMatch(
          /^\/native-state\/projects\/[0-9a-f]{64}$/,
        );
        expect(calls[0]?.params).not.toHaveProperty("prompt");
      }).pipe(Effect.provide(Path.layer)),
  );

  it.effect(
    "forwards exact model options and lets native creation distinguish fresh sessions from resume",
    () =>
      Effect.gen(function* () {
        for (const selection of [
          {
            options: [
              { id: "reasoning_effort", value: "high" },
              { id: "prompt_cache_enabled", value: false },
            ],
            params: { reasoning_effort: "high" },
          },
          { options: [], params: null },
        ]) {
          const { reader, calls } = yield* make((method) => {
            if (method === "models.v1.catalog")
              throw new Error("The original model is no longer advertised.");
            return { mob: { mobId: "domain" } };
          });
          yield* reader.connectDomain!({
            projectPath: "/workspace",
            stateRoot: "/private-domain",
            mobId: "domain",
            identity: "architect",
            label: "Architect",
            role: "architect",
            instructions: "Review design",
            model: "openai:exact-model",
            accessMode: "read-only",
            options: selection.options,
          });
          expect(calls.map((call) => call.method)).toEqual(["mobs.v1.createDomainMob"]);
          expect(calls[0]?.params?.projectPath).toBe("/workspace");
          expect(calls[0]?.params?.configStateRoot).toMatch(
            /^\/native-state\/projects\/[0-9a-f]{64}$/,
          );
          expect(calls[0]?.params).toMatchObject({
            projectPath: "/workspace",
            stateRoot: "/private-domain",
            provider: "openai",
            model: "exact-model",
            providerParams: selection.params,
          });
          expect(calls[0]?.params).not.toHaveProperty("prompt");
        }
      }).pipe(Effect.provide(Path.layer)),
  );

  it.effect("rejects malformed models and invalid reasoning before native domain admission", () =>
    Effect.gen(function* () {
      for (const selection of [
        { model: "anthropic:claude-haiku-4-5", options: [{ id: "thinking", value: "invalid" }] },
        { model: "unqualified-model", options: [] },
      ]) {
        const { reader, calls } = yield* make(() => ({
          catalog: { providers: [{ provider: "openai", models: [{ id: "other-model" }] }] },
        }));
        const result = yield* Effect.result(
          reader.connectDomain!({
            projectPath: "/workspace",
            stateRoot: "/private-domain",
            mobId: "domain",
            identity: "architect",
            label: "Architect",
            role: "architect",
            instructions: "Review design",
            accessMode: "read-only",
            ...selection,
          }),
        );
        expect(result._tag).toBe("Failure");
        expect(calls.some((call) => call.method === "mobs.v1.createDomainMob")).toBe(false);
      }
    }).pipe(Effect.provide(Path.layer)),
  );
});

it.effect("derives proposal availability from the native nested capability flag", () =>
  Effect.gen(function* () {
    const { reader, calls } = yield* make(() => ({
      capabilities: { projectAgentProposalTool: true },
    }));
    expect(yield* reader.proposalAvailable!()).toBe(true);
    expect(calls[0]?.method).toBe("system.v1.capabilities");
    const missing = yield* make(() => ({ capabilities: {} }));
    expect(yield* missing.reader.proposalAvailable!()).toBe(false);
  }).pipe(Effect.provide(Path.layer)),
);

it.effect(
  "reads busy state through the exact native console target and rejects missing evidence",
  () =>
    Effect.gen(function* () {
      const { reader, calls } = yield* make(() => ({ busy: true }));
      const target = { projectPath: "/workspace", stateRoot: "/domain", mobId: "domain", record };
      expect(yield* reader.busy!(target)).toBe(true);
      expect(calls[0]?.method).toBe("mobs.v1.consoleStatus");
      expect(calls[0]?.params?.expected).toEqual({
        identity: record.identity,
        runtimeKey: record.runtime_key,
        runtimeMemberId: record.runtime_member_id,
        sessionId: null,
        sourceMobId: "child",
      });
      const missing = yield* make(() => ({}));
      expect((yield* Effect.flip(missing.reader.busy!(target)))._tag).toBe("ProviderDriverError");
    }).pipe(Effect.provide(Path.layer)),
);

// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - opt-in controlled native provider, disposable Git repositories, no real credentials.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import {
  SharedActivity,
  SharedCompositionOperation,
  SharedDiscoveryResult,
  SharedInbox,
  SharedKnowledge,
  SharedKnowledgeSearchResult,
  SharedSpecialistRequest,
  SharedSnapshot,
  type SharedCompositionInput,
  type SharedDelegation,
  type SharedSpecialist,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect } from "@effect/vitest";
import { workflowKey } from "../provider/meerkat/MeerkatWorkflow.server.native.support.ts";

export type ExpansionLane = "A" | "B";
export const expansionLanes = ["A", "B"] as const;
export const expansionMarker = (kind: "BOOT" | "RUN" | "REQUEST" | "DENIED", lane: ExpansionLane) =>
  `EXPANSION_${kind}_${lane}`;
export const expansionFinal = (kind: "BOOT" | "RUN" | "REQUEST" | "DENIED", lane: ExpansionLane) =>
  `${expansionMarker(kind, lane)}_DONE`;
export const growthMarker = "EXPANSION_GROW";
export const growthFinal = "EXPANSION_GROW_DONE";
export const selfRevisionMarker = "EXPANSION_SELF_REVISE";
export const selfRevisionFinal = "EXPANSION_SELF_REVISION_SAVED";
export const selfRevisionObserveMarker = "EXPANSION_OBSERVE_SELF_REVISION";
export const selfRevisionObservedFinal = "EXPANSION_SELF_REVISION_APPLIED";
export const inboxPeerSenderMarker = "EXPANSION_INBOX_PEER_SENDER";
export const inboxPeerMarker = "EXPANSION_INBOX_PEER_OBSERVATION";
export const inboxPeerFinal = "EXPANSION_INBOX_PEER_OBSERVATION_DONE";
export const snapshotPatchMarker = "EXPANSION_RETAINED_PATCH_A";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const input = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      model: Schema.String,
      input: Schema.Array(Schema.Unknown),
      tools: Schema.Array(Schema.Unknown),
    }),
  ),
);
const user = Schema.decodeUnknownOption(
  Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Union([
      Schema.String,
      Schema.Array(Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String })),
    ]),
  }),
);
const toolOutput = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("function_call_output"),
    call_id: Schema.String,
    output: Schema.Union([
      Schema.String,
      Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
    ]),
  }),
);
const tool = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("function"), name: Schema.String }),
);
const result = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.String }));
const acknowledgement = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ acknowledged: Schema.Literal(true) })),
);
const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, text: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema))(text);

export interface ExpansionObservation {
  request?: SharedSpecialistRequest;
  activity?: SharedActivity;
  original?: SharedKnowledge;
  correction?: SharedKnowledge;
  inbox?: SharedInbox;
  acknowledged: boolean;
  completed: boolean;
  denied: boolean;
  actions: string[];
  inspectedSnapshot?: { snapshot: SharedSnapshot; content: string; applied: false };
}
interface LaneState {
  grant: SharedDelegation;
  specialist: SharedSpecialist;
  phase: number;
  serial: number;
  lastCallId?: string;
  polls: number;
  observation: ExpansionObservation;
}

export async function expansionGit(cwd: string, env: NodeJS.ProcessEnv, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      "/usr/bin/git",
      args,
      { cwd, env, timeout: 15_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
  });
}

/** Model behavior is deterministic, while all grants, tool dispatch, storage and native identities are real. */
export function controlledExpansionProvider() {
  const lanes = new Map<ExpansionLane, LaneState>();
  const errors: string[] = [];
  const completed = new Set<string>();
  let serial = 0;
  const inboxObservation: {
    senderStep: number;
    step: number;
    lastCallId?: string;
    peerId?: string;
    inbox?: SharedInbox;
    source?: SharedActivity;
    activity?: SharedActivity;
    knowledge?: SharedKnowledge;
    unchangedInbox?: SharedInbox;
    participantWriteRejected: boolean;
  } = { senderStep: 0, step: 0, participantWriteRejected: false };
  let growth:
    | {
        plan: SharedCompositionInput;
        calls: number;
        lastCallId?: string;
        phase: number;
        operation?: SharedCompositionOperation;
      }
    | undefined;
  let selfRevision:
    | {
        plan: SharedCompositionInput;
        pending?: SharedCompositionOperation;
        completed?: SharedCompositionOperation;
        submitted: boolean;
        observing: boolean;
      }
    | undefined;
  const previous = (body: ReturnType<typeof input>, callId: string) => {
    const values = body.input.flatMap((item) => {
      const value = toolOutput(item);
      return value._tag === "Some" && value.value.call_id === callId ? [value.value.output] : [];
    });
    expect(values).toHaveLength(1);
    const value = values[0]!;
    return typeof value === "string" ? value : value.map((part) => part.text ?? "").join("\n");
  };
  const verifyAttribution = (state: LaneState, value: SharedActivity | SharedKnowledge) => {
    expect(value.author).toEqual(state.grant.participant);
    expect(value.author.kind).toBe("local_agent");
    expect(value.author.provenance?.ownerParticipantId).toBe(state.grant.ownerParticipantId);
    expect(value.author.provenance?.localThreadId).toBe(state.grant.binding.threadId);
    expect(value.contextId).toBe(state.grant.context.contextId);
    expect(value.contextVersion).toBe(state.grant.context.contextVersion);
    expect(value.revision).toEqual(state.grant.context.revision);
  };
  const provider = NodeHttp.createServer(async (request, response) => {
    try {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/responses");
      expect(request.headers.authorization).toBe(`Bearer ${workflowKey}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
        if (chunks.reduce((sum, value) => sum + value.length, 0) > 4 * 1024 * 1024)
          throw new Error("Provider fixture input exceeded bound");
      }
      const body = input(Buffer.concat(chunks).toString("utf8"));
      expect(body.model).toBe("gpt-5.6-sol");
      const last = body.input
        .toReversed()
        .map((value) => user(value))
        .find((value) => value._tag === "Some");
      if (!last || last._tag !== "Some") throw new Error("No controlled user input");
      const text =
        typeof last.value.content === "string"
          ? last.value.content
          : last.value.content.map((value) => value.text).join("");
      const responseId = `expansion-response-${serial++}`;
      const nativeCall = (
        callId: string,
        name: string,
        argumentsValue: Record<string, unknown>,
      ) => {
        expect(
          body.tools
            .flatMap((value) => {
              const decoded = tool(value);
              return decoded._tag === "Some" ? [decoded.value.name] : [];
            })
            .filter((candidate) => candidate === name),
        ).toHaveLength(1);
        return {
          type: "function_call",
          id: `fc_${callId}`,
          call_id: callId,
          name,
          status: "completed",
          arguments: encode(argumentsValue),
        };
      };
      const call = (callId: string, action: string, argumentsValue: Record<string, unknown>) =>
        nativeCall(callId, "shared_workspace", { action, arguments: argumentsValue });
      const final = (value: string) => {
        completed.add(value);
        return {
          type: "message",
          id: `msg_${responseId}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: value }],
        };
      };
      let item: ReturnType<typeof call> | ReturnType<typeof final>;
      const lane = expansionLanes.find((candidate) =>
        ["BOOT", "RUN", "REQUEST", "DENIED"].some((kind) =>
          text.includes(`EXPANSION_${kind}_${candidate}`),
        ),
      );
      if (text.includes(inboxPeerSenderMarker)) {
        const step = inboxObservation.senderStep++;
        if (step === 0) item = nativeCall("inbox-peer-list", "peers", {});
        else if (step === 1) {
          const peers = decode(
            Schema.Struct({ peers: Schema.Array(Schema.Struct({ peer_id: Schema.String })) }),
            previous(body, "inbox-peer-list"),
          ).peers;
          expect(peers).toHaveLength(1);
          inboxObservation.peerId = peers[0]!.peer_id;
          item = nativeCall("inbox-peer-send", "send_message", {
            peer_id: inboxObservation.peerId,
            body: inboxPeerMarker,
            handling_mode: "queue",
          });
        } else {
          expect(step).toBe(2);
          expect(previous(body, "inbox-peer-send")).toContain("peer_message_sent");
          item = final("EXPANSION_INBOX_PEER_SENT");
        }
      } else if (text.includes(inboxPeerMarker)) {
        expect(text).toContain("Peer message from ");
        const state = inboxObservation;
        const laneA = lanes.get("A")!;
        if (state.lastCallId) {
          const output = previous(body, state.lastCallId);
          if (state.step === 0) {
            state.inbox = decode(SharedInbox, output);
            expect(state.inbox.recipientId).toBe(laneA.specialist.specialistId);
            expect(state.inbox.batchId).toBeTruthy();
            const source = state.inbox.events.find((event) => event.eventId === "briefing-A");
            if (!source) {
              throw new Error("Expected retained API briefing in the specialist inbox");
            }
            state.source = source;
            expect(source.revision).toEqual(laneA.grant.context.revision);
          } else if (state.step === 1) {
            state.activity = decode(SharedActivity, output);
            expect(state.activity.author).toMatchObject({
              kind: "specialist",
              participantId: laneA.specialist.specialistId,
            });
            expect(state.activity.context.participantId).toBe(laneA.specialist.specialistId);
            expect(state.activity.context.contextId).not.toBe(laneA.grant.context.contextId);
            expect(state.activity.context.source).toMatchObject({
              kind: "specialist_observation",
              specialistId: laneA.specialist.specialistId,
              batchId: state.inbox!.batchId,
              eventId: state.source!.eventId,
              sourceContextId: state.source!.contextId,
              sourceContextVersion: state.source!.contextVersion,
            });
            expect(state.activity.revision).toEqual(state.source!.revision);
            expect(state.activity.sources).toEqual(state.source!.sources);
          } else if (state.step === 2) {
            state.knowledge = decode(SharedKnowledge, output);
            expect(state.knowledge.observationSource).toEqual(state.activity!.context.source);
            expect(state.knowledge.author).toEqual(state.activity!.author);
            expect(state.knowledge.revision).toEqual(state.source!.revision);
          } else if (state.step === 3) {
            state.unchangedInbox = decode(SharedInbox, output);
            expect(state.unchangedInbox).toEqual(state.inbox);
          } else if (state.step === 4) {
            expect(output).toMatch(
              /forbidden|unavailable|participant-request binding|retained shared request/i,
            );
            state.participantWriteRejected = true;
          }
          state.step++;
        }
        const invoke = (action: string, args: Record<string, unknown>) => {
          state.lastCallId = `inbox-observe-${state.step}`;
          return call(state.lastCallId, action, args);
        };
        const source = { batchId: state.inbox?.batchId, eventId: state.source?.eventId };
        if (state.step === 0) item = invoke("inbox.list", {});
        else if (state.step === 1)
          item = invoke("activity.publish_from_inbox", {
            source,
            eventId: "native-peer-derived-activity",
            kind: "briefing",
            summary: "The retained API patch is relevant to the integration specialists.",
          });
        else if (state.step === 2)
          item = invoke("knowledge.record_from_inbox", {
            source,
            evidenceId: "native-peer-derived-knowledge",
            kind: "finding",
            title: "Retained patch observation",
            body: "This is specialist-authored evidence from the retained API briefing, not a participant request result.",
            supersedes: [],
            state: "open",
          });
        else if (state.step === 3) item = invoke("inbox.list", {});
        else if (state.step === 4)
          item = invoke("activity.publish", {
            eventId: "forbidden-peer-human-context",
            contextId: laneA.grant.context.contextId,
            contextVersion: laneA.grant.context.contextVersion,
            revision: laneA.grant.context.revision,
            kind: "finding",
            summary: "This must be rejected.",
            paths: [],
            tags: [],
            sources: [],
          });
        else item = final(inboxPeerFinal);
      } else if (text.includes(selfRevisionMarker)) {
        if (!selfRevision) throw new Error("Self revision plan not configured");
        const callId = "self-revision-submit";
        if (!selfRevision.submitted) {
          selfRevision.submitted = true;
          item = call(callId, "specialists.update", { ...selfRevision.plan });
        } else {
          const pending = decode(SharedCompositionOperation, previous(body, callId));
          expect(pending.status).toBe("pending");
          expect(pending.actor).toEqual({
            kind: "specialist",
            id: selfRevision.plan.revisions[0]!.specialistId,
          });
          expect(pending.operationId).toBe(selfRevision.plan.operationId);
          expect(pending.evidence).toEqual([]);
          selfRevision.pending = pending;
          // End this native turn. Retrying the revision from inside it would remain busy.
          item = final(selfRevisionFinal);
        }
      } else if (text.includes(selfRevisionObserveMarker)) {
        if (!selfRevision?.pending) throw new Error("No admitted self revision");
        const callId = "self-revision-observe";
        if (!selfRevision.observing) {
          selfRevision.observing = true;
          item = call(callId, "operations.get", { operationId: selfRevision.plan.operationId });
        } else {
          const completedRevision = decode(SharedCompositionOperation, previous(body, callId));
          expect(completedRevision).toMatchObject({
            operationKey: selfRevision.pending.operationKey,
            operationId: selfRevision.pending.operationId,
            actor: selfRevision.pending.actor,
            status: "completed",
          });
          expect(completedRevision.evidence).toHaveLength(1);
          expect(completedRevision.evidence[0]!.kind).toBe("native_revision");
          selfRevision.completed = completedRevision;
          item = final(selfRevisionObservedFinal);
        }
      } else if (text.includes(growthMarker)) {
        if (!growth) throw new Error("Growth plan not configured");
        if (growth.lastCallId) {
          growth.operation = decode(SharedCompositionOperation, previous(body, growth.lastCallId));
          expect(growth.operation.actor.kind).toBe("specialist");
          expect(growth.operation.status).not.toBe("conflict");
          if (growth.operation.status === "completed") growth.phase++;
        }
        if (growth.phase >= 2) {
          expect(growth.operation?.evidence.map((entry) => entry.kind)).toEqual([
            "native_identity",
            "native_peer",
          ]);
          item = final(growthFinal);
        } else {
          if (growth.calls++ >= 8) throw new Error("Growth composition never completed");
          growth.lastCallId = `growth-${growth.calls}`;
          item =
            growth.phase === 0
              ? call(growth.lastCallId, "specialists.create", { ...growth.plan })
              : call(growth.lastCallId, "operations.get", { operationId: growth.plan.operationId });
        }
      } else if (lane && text.includes(expansionMarker("BOOT", lane))) {
        item = final(expansionFinal("BOOT", lane));
      } else if (lane && text.includes(expansionMarker("REQUEST", lane))) {
        const state = lanes.get(lane)!;
        const snapshotId = state.grant.context.revision.snapshotId;
        const callId = "request-snapshot-A";
        if (!snapshotId) item = final(expansionFinal("REQUEST", lane));
        else if (
          !body.input.some((value) => {
            const output = toolOutput(value);
            return output._tag === "Some" && output.value.call_id === callId;
          })
        ) {
          item = call(callId, "repository.read", {
            sharedProjectId: state.grant.context.sharedProjectId,
            commit: state.grant.context.revision.commit,
            snapshotId,
          });
        } else {
          const snapshot = decode(
            Schema.Struct({
              kind: Schema.Literal("snapshot_evidence"),
              applied: Schema.Literal(false),
              snapshot: SharedSnapshot,
              content: Schema.String,
            }),
            previous(body, callId),
          );
          expect(snapshot.snapshot.snapshotId).toBe(snapshotId);
          expect(snapshot.snapshot.checkoutId).toBe(state.grant.context.checkoutId);
          expect(snapshot.content).toContain(snapshotPatchMarker);
          state.observation.inspectedSnapshot = snapshot;
          item = final(expansionFinal("REQUEST", lane));
        }
      } else if (lane && text.includes(expansionMarker("DENIED", lane))) {
        const state = lanes.get(lane);
        if (!state) throw new Error("No configured denied lane");
        const id = `denied-${lane}`;
        const outputs = body.input.flatMap((value) => {
          const output = toolOutput(value);
          return output._tag === "Some" && output.value.call_id === id ? [output] : [];
        });
        if (!outputs.length) item = call(id, "projects.list", {});
        else {
          expect(previous(body, id)).toMatch(
            /forbidden|revoked|no unambiguous enabled local delegation/i,
          );
          state.observation.denied = true;
          item = final(expansionFinal("DENIED", lane));
        }
      } else if (lane && text.includes(expansionMarker("RUN", lane))) {
        const state = lanes.get(lane);
        if (!state) throw new Error("Local task grant not configured");
        if (state.lastCallId) {
          const output = previous(body, state.lastCallId);
          if (state.phase === 0) {
            const directory = decode(SharedDiscoveryResult, output);
            expect(
              directory.items.some((entry) => entry.specialistId === state.specialist.specialistId),
            ).toBe(true);
          } else if (state.phase === 1 || state.phase === 2) {
            const request = decode(SharedSpecialistRequest, output);
            expect(request.author).toEqual(state.grant.participant);
            expect(request.context).toEqual(state.grant.context);
            expect(request.specialistId).toBe(state.specialist.specialistId);
            expect(request.outcome.status).not.toBe("failed");
            state.observation.request = request;
            if (state.phase === 2 && request.outcome.status !== "completed") {
              if (++state.polls >= 80)
                throw new Error("Exact delegated request outcome remained unresolved");
              await new Promise((resolve) => setTimeout(resolve, 100));
              state.phase--;
            } else if (state.phase === 2) {
              expect(request.outcome.receipt?.requestId).toBe(request.nativeRequestId);
              expect(result(request.outcome.completion?.payload).result).toBe(
                expansionFinal("REQUEST", lane),
              );
            }
          } else if (state.phase === 3) {
            state.observation.activity = decode(SharedActivity, output);
            verifyAttribution(state, state.observation.activity);
          } else if (state.phase === 4 || state.phase === 5) {
            const evidence = decode(SharedKnowledge, output);
            verifyAttribution(state, evidence);
            if (state.phase === 4) state.observation.original = evidence;
            else {
              expect(evidence.supersedes).toEqual([state.observation.original!.evidenceId]);
              state.observation.correction = evidence;
            }
          } else if (state.phase === 6) {
            const found = decode(SharedKnowledgeSearchResult, output);
            expect(found.records).toHaveLength(1);
            expect(found.records[0]!.evidenceId).toBe(state.observation.original!.evidenceId);
            expect(found.records[0]!.corrections.map((entry) => entry.evidenceId)).toEqual([
              state.observation.correction!.evidenceId,
            ]);
            expect(found.records[0]!.hasMoreCorrections).toBe(false);
          } else if (state.phase === 7) {
            const found = decode(SharedKnowledgeSearchResult, output);
            expect(found.records).toHaveLength(1);
            expect(found.records[0]).toMatchObject(state.observation.correction!);
          } else if (state.phase === 8 || state.phase === 9) {
            const inbox = decode(SharedInbox, output);
            expect(inbox.recipientId).toBe(state.grant.participant.participantId);
            const briefing = inbox.events.find((event) => event.eventId === `briefing-${lane}`);
            expect(briefing).toBeDefined();
            expect(briefing?.recipientIds).toBeUndefined();
            expect(inbox.batchId).not.toBeNull();
            if (state.phase === 8) state.observation.inbox = inbox;
            else expect(inbox).toEqual(state.observation.inbox);
          } else if (state.phase === 10) {
            acknowledgement(output);
            state.observation.acknowledged = true;
          }
          state.phase++;
        }
        const invoke = (action: string, args: Record<string, unknown>) => {
          for (const forbidden of [
            "credential",
            "delegationId",
            "participantId",
            "contextId",
            "contextVersion",
            "revision",
          ])
            expect(args).not.toHaveProperty(forbidden);
          state.observation.actions.push(action);
          state.lastCallId = `local-${lane}-${state.serial++}`;
          return call(state.lastCallId, action, args);
        };
        switch (state.phase) {
          case 0:
            item = invoke("specialists.list", {
              sharedProjectId: state.grant.context.sharedProjectId,
              tags: [lane === "A" ? "api" : "storefront"],
            });
            break;
          case 1:
            item = invoke("specialists.send", {
              specialistId: state.specialist.specialistId,
              requestId: "same-local-request-id",
              text: expansionMarker("REQUEST", lane),
            });
            break;
          case 2:
            item = invoke("specialists.request", {
              requestId: state.observation.request!.requestId,
            });
            break;
          case 3:
            item = invoke("activity.publish", {
              eventId: `local-activity-${lane}`,
              kind: "finding",
              summary: `Local ${lane} found a compatibility constraint`,
              paths: ["src/api.ts"],
              tags: ["integration"],
              sources: [],
            });
            break;
          case 4:
          case 5:
            item = invoke(state.phase === 4 ? "knowledge.record" : "knowledge.supersede", {
              evidenceId: `local-evidence-${lane}-${state.phase}`,
              kind: "finding",
              title: state.phase === 4 ? `Legacy ${lane} protocol` : `Replacement ${lane} contract`,
              body: state.phase === 4 ? "Original finding" : "Corrected finding",
              sources: [],
              supersedes: state.phase === 4 ? [] : [state.observation.original!.evidenceId],
              state: "open",
            });
            break;
          case 6:
            item = invoke("knowledge.search", { query: `Legacy ${lane} protocol` });
            break;
          case 7:
            item = invoke("knowledge.search", {
              evidenceId: state.observation.correction!.evidenceId,
            });
            break;
          case 8:
          case 9:
            item = invoke("inbox.list", { limit: 100 });
            break;
          case 10:
            item = invoke("inbox.ack", { batchId: state.observation.inbox!.batchId });
            break;
          default:
            state.observation.completed = true;
            item = final(expansionFinal("RUN", lane));
        }
      } else throw new Error("Unknown expansion fixture marker");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [
          { type: "response.created", response: { id: responseId } },
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
    } catch (cause) {
      errors.push(cause instanceof Error ? cause.message : "Controlled expansion provider failed");
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(encode({ error: { message: "Controlled expansion provider failed" } }));
    }
  });
  return {
    provider,
    errors,
    completed,
    configureLane: (lane: ExpansionLane, grant: SharedDelegation, specialist: SharedSpecialist) =>
      lanes.set(lane, {
        grant,
        specialist,
        phase: 0,
        serial: 0,
        polls: 0,
        observation: { completed: false, denied: false, acknowledged: false, actions: [] },
      }),
    observation: (lane: ExpansionLane) => lanes.get(lane)!.observation,
    configureGrowth: (plan: SharedCompositionInput) => {
      growth = { plan, calls: 0, phase: 0 };
    },
    growth: () => growth?.operation,
    configureSelfRevision: (plan: SharedCompositionInput) => {
      selfRevision = { plan, submitted: false, observing: false };
    },
    selfRevision: () => selfRevision,
    inboxObservation: () => inboxObservation,
    inferenceCount: () => serial,
  };
}

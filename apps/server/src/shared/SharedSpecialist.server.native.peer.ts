// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - controlled native peer traffic in the owned acceptance fixture.
import type * as NodeHttp from "node:http";
import { expect } from "@effect/vitest";
import {
  WS_METHODS,
  WsRpcGroup,
  type ProjectId,
  type ProviderInstanceId,
  type SharedSpecialistSendInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RpcClient } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import {
  bounded,
  workflowModel,
} from "../provider/meerkat/MeerkatWorkflow.server.native.support.ts";

export const peerBoundPrompt = "SHARED_PEER_BOUND_REQUEST";
export const peerSenderPrompt = "SHARED_PEER_SENDER";
export const peerBackgroundPrompt = "SHARED_PEER_BACKGROUND";
export const peerBoundAnswer = "SHARED_BOUND_ANSWER";
export const peerBackgroundAnswer = "SHARED_BACKGROUND_ANSWER";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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
const decodePeers = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      peers: Schema.Array(Schema.Struct({ peer_id: Schema.String })),
    }),
  ),
);
const decodeTool = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("function"), name: Schema.String }),
);

/** The sender's actual native peers/send_message tools generate the background turn. */
export function controlledPeerTraffic() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const sent = Promise.withResolvers<void>();
  const received = Promise.withResolvers<void>();
  const counts = new Map<string, number>();
  let peerId: string | undefined;
  const matches = (text: string) =>
    [peerBoundPrompt, peerSenderPrompt, peerBackgroundPrompt].some((marker) =>
      text.includes(marker),
    );
  const respond = async (
    body: { input: readonly unknown[]; tools: readonly unknown[] },
    text: string,
    response: NodeHttp.ServerResponse,
    responseId: string,
  ) => {
    const key = text.includes(peerBackgroundPrompt)
      ? "background"
      : text.includes(peerSenderPrompt)
        ? "sender"
        : "bound";
    const step = counts.get(key) ?? 0;
    counts.set(key, step + 1);
    const callId = `peer-${key}-${step}`;
    const previous = () => {
      const outputs = body.input.flatMap((item) => {
        const value = decodeOutput(item);
        return value._tag === "Some" && value.value.call_id === `peer-${key}-${step - 1}`
          ? [value.value]
          : [];
      });
      expect(outputs).toHaveLength(1);
      const value = outputs[0]!.output;
      return typeof value === "string" ? value : value.map((part) => part.text ?? "").join("\n");
    };
    const call = (name: string, argumentsValue: unknown) => {
      const names = body.tools.flatMap((item) => {
        const value = decodeTool(item);
        return value._tag === "Some" ? [value.value.name] : [];
      });
      expect(names.filter((candidate) => candidate === name)).toHaveLength(1);
      return {
        type: "function_call",
        id: `fc_${callId}`,
        call_id: callId,
        name,
        arguments: encode(argumentsValue),
        status: "completed",
      };
    };
    const final = (value: string) => ({
      type: "message",
      id: `msg_${callId}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: value }],
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${encode({ type: "response.created", response: { id: responseId } })}\n\n`,
    );
    response.flushHeaders();
    let item: ReturnType<typeof call> | ReturnType<typeof final>;
    if (key === "bound") {
      expect(step).toBe(0);
      entered.resolve();
      await release.promise;
      item = final(peerBoundAnswer);
    } else if (key === "sender") {
      if (step === 0) item = call("peers", {});
      else if (step === 1) {
        const peers = decodePeers(previous()).peers;
        expect(peers).toHaveLength(1);
        peerId = peers[0]!.peer_id;
        item = call("send_message", {
          peer_id: peerId,
          body: peerBackgroundPrompt,
          handling_mode: "queue",
        });
      } else {
        expect(step).toBe(2);
        expect(previous()).toContain("peer_message_sent");
        sent.resolve();
        item = final("SHARED_PEER_SENT");
      }
    } else {
      expect(step).toBe(0);
      expect(text).toContain("Peer message from ");
      received.resolve();
      item = final(peerBackgroundAnswer);
    }
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
  };
  return {
    matches,
    respond,
    entered,
    release,
    sent,
    received,
    observation: () => ({ counts: Object.fromEntries(counts), peerId }),
  };
}

type Client = RpcClient.FromGroup<typeof WsRpcGroup, RpcClientError>;
const decodeAnswer = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.String }));

export const exerciseLivePeerIsolation = Effect.fnUntraced(function* (input: {
  admin: Client;
  participant: Client;
  fixture: ReturnType<typeof controlledPeerTraffic>;
  projectId: ProjectId;
  instanceId: ProviderInstanceId;
  agentId: string;
  agentRef: string;
  boundRequest: SharedSpecialistSendInput;
}) {
  const { admin, participant, fixture, projectId, instanceId, agentId, agentRef } = input;
  const sender = yield* admin[WS_METHODS.meerkatProjectAgentCreate]({
    projectId,
    instanceId,
    requestId: "shared-peer-sender-create",
    label: "Independent peer",
    role: "peer-fixture",
    instructions: "Send the requested peer observation.",
    accessMode: "full-access",
    model: workflowModel,
  });
  expect(sender.connectionStatus, sender.error ?? undefined).toBe("connected");
  expect(sender.agentId).not.toBe(agentId);
  expect(sender.agentRef).not.toBe(agentRef);
  const connected = yield* admin[WS_METHODS.meerkatPeerConnectionSet]({
    source: { kind: "project-agent", projectId, instanceId, agentId: sender.agentId },
    target: { kind: "project-agent", projectId, instanceId, agentId },
    connected: true,
    requestId: "shared-peer-link",
  });
  expect(connected.connections).toHaveLength(1);
  expect(connected.connections[0]!.status, connected.connections[0]!.error ?? undefined).toBe(
    "connected",
  );
  const bound = yield* participant[WS_METHODS.sharedSpecialistSend]({
    ...input.boundRequest,
    requestId: "pending-during-native-peer",
    text: peerBoundPrompt,
  });
  yield* Effect.promise(() =>
    bounded(fixture.entered.promise, "participant native turn before peer"),
  );
  yield* admin[WS_METHODS.meerkatAgentSend]({
    projectId,
    instanceId,
    agentRef: sender.agentRef!,
    requestId: "independent-peer-trigger",
    text: peerSenderPrompt,
    handlingMode: "queue",
  });
  yield* Effect.promise(() => bounded(fixture.sent.promise, "native peer send_message receipt"));
  const pending = yield* participant[WS_METHODS.sharedSpecialistRequest]({
    requestId: bound.requestId,
  });
  expect(pending.outcome.completion).toBeNull();
  expect(["accepted", "unresolved"]).toContain(pending.outcome.status);
  fixture.release.resolve();
  const completed = yield* Effect.gen(function* () {
    for (;;) {
      const value = yield* participant[WS_METHODS.sharedSpecialistRequest]({
        requestId: bound.requestId,
      });
      if (value.outcome.status === "failed")
        throw new Error("Participant turn failed during peer proof");
      if (value.outcome.status === "completed") return value;
      expect(value.outcome.completion).toBeNull();
      yield* Effect.sleep("100 millis");
    }
  }).pipe(Effect.timeout("30 seconds"));
  expect(decodeAnswer(completed.outcome.completion?.payload).result).toBe(peerBoundAnswer);
  expect(completed.context).toEqual(bound.context);
  expect(completed.author).toEqual(bound.author);
  expect(completed.outcome.receipt?.requestId).toBe(completed.nativeRequestId);
  yield* Effect.promise(() => bounded(fixture.received.promise, "actual native peer message turn"));
  yield* Effect.gen(function* () {
    for (;;) {
      const team = yield* admin[WS_METHODS.meerkatProjectTeam]({ projectId });
      const native = team.providers
        .flatMap((provider) => provider.agents)
        .find((agent) => agent.agentRef === agentRef);
      if (native?.work?.status === "idle" && native.work.outcome === peerBackgroundAnswer) return;
      yield* Effect.sleep("100 millis");
    }
  }).pipe(Effect.timeout("30 seconds"));
  const afterPeer = yield* participant[WS_METHODS.sharedSpecialistRequest]({
    requestId: bound.requestId,
  });
  expect(afterPeer.outcome.completion).toEqual(completed.outcome.completion);
  expect(decodeAnswer(afterPeer.outcome.completion?.payload).result).toBe(peerBoundAnswer);
  expect(fixture.observation().counts).toEqual({ bound: 1, sender: 3, background: 1 });
  return {
    requestId: bound.requestId,
    nativeRequestId: bound.nativeRequestId,
    peer: fixture.observation(),
  };
});

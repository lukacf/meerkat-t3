// @effect-diagnostics nodeBuiltinImport:off - owns one synthetic loopback model provider for an opt-in native restart test.
import * as NodeHttp from "node:http";
import * as NodeSqlite from "node:sqlite";
import { SharedCompositionOperation } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect } from "@effect/vitest";
import { workflowKey } from "../provider/meerkat/MeerkatWorkflow.server.native.support.ts";

export const compositionMarkers = {
  original: "COMPOSITION_ORIGINAL_ADMITTED",
  blocker: "COMPOSITION_REVISION_BLOCKER",
  successor: "COMPOSITION_SUCCESSOR_ADMITTED",
  final: "COMPOSITION_CONSOLIDATED_WORK",
} as const;
export type CompositionLane = keyof typeof compositionMarkers;
export const compositionAnswer = (lane: CompositionLane) => `${compositionMarkers[lane]}_DONE`;
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const input = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ model: Schema.String, input: Schema.Array(Schema.Unknown) }),
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

/** Offline, read-only evidence from the owned host after exit, never a recovery action. */
export function persistedComposition(databasePath: string, operationKey: string) {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = Schema.decodeUnknownSync(Schema.Struct({ definition_json: Schema.String }))(
      database
        .prepare(
          "SELECT definition_json FROM shared_composition_operations WHERE operation_key = ?",
        )
        .get(operationKey),
    );
    return Schema.decodeSync(Schema.fromJsonString(SharedCompositionOperation))(
      row.definition_json,
    );
  } finally {
    database.close();
  }
}

/** Only inference timing is controlled. Composition, identities, persistence and routing are real. */
export function controlledCompositionProvider() {
  const lanes = Object.keys(compositionMarkers) as CompositionLane[];
  const gates = new Map(lanes.map((lane) => [lane, Promise.withResolvers<void>()]));
  const entered = new Map(lanes.map((lane) => [lane, Promise.withResolvers<void>()]));
  const cancellations = new Map(lanes.map((lane) => [lane, Promise.withResolvers<void>()]));
  const counts = Object.fromEntries(lanes.map((lane) => [lane, 0])) as Record<
    CompositionLane,
    number
  >;
  const canceled = Object.fromEntries(lanes.map((lane) => [lane, 0])) as Record<
    CompositionLane,
    number
  >;
  const released = new Set<CompositionLane>();
  const errors: string[] = [];
  let serial = 0;
  const provider = NodeHttp.createServer(async (request, response) => {
    try {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/responses");
      expect(request.headers.authorization).toBe(`Bearer ${workflowKey}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = input(Buffer.concat(chunks).toString("utf8"));
      expect(body.model).toBe("gpt-5.6-sol");
      const latest = body.input
        .toReversed()
        .map((value) => user(value))
        .find((value) => value._tag === "Some");
      if (!latest || latest._tag !== "Some") throw new Error("No native user input");
      const text =
        typeof latest.value.content === "string"
          ? latest.value.content
          : latest.value.content.map((part) => part.text).join("");
      const lane = lanes.find((candidate) => text.includes(compositionMarkers[candidate]));
      if (!lane) throw new Error("Unexpected composition fixture inference");
      counts[lane]++;
      const responseId = `composition-response-${serial++}`;
      const closed = Promise.withResolvers<void>();
      response.once("close", () => closed.resolve());
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${encode({ type: "response.created", response: { id: responseId } })}\n\n`,
      );
      response.flushHeaders();
      entered.get(lane)!.resolve();
      await Promise.race([gates.get(lane)!.promise, closed.promise]);
      if (response.destroyed) {
        if (!released.has(lane)) {
          canceled[lane]++;
          cancellations.get(lane)!.resolve();
        }
        return;
      }
      const item = {
        type: "message",
        id: `composition-message-${serial}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: compositionAnswer(lane) }],
      };
      response.end(
        [
          { type: "response.output_item.added", output_index: 0, item },
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
      errors.push(cause instanceof Error ? cause.message : "Composition provider failed");
      for (const barrier of entered.values())
        barrier.reject(new Error("Composition provider failed"));
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(encode({ error: { message: "Composition provider failed" } }));
    }
  });
  for (const barrier of entered.values()) void barrier.promise.catch(() => undefined);
  const release = (lane: CompositionLane) => {
    released.add(lane);
    gates.get(lane)!.resolve();
  };
  return {
    provider,
    errors,
    counts,
    canceled,
    entered: (lane: CompositionLane) => entered.get(lane)!.promise,
    canceledRequest: (lane: CompositionLane) => cancellations.get(lane)!.promise,
    release,
    releaseAll: () => lanes.forEach(release),
  };
}

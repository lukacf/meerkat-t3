import type { ConsoleFrame } from "@t3tools/contracts";
import type { ConversationActivity } from "./agentActivity.logic";
import { canonicalAssistantMessage } from "./nativeAssistantOccurrence.logic";

type Tool = Extract<ConversationActivity, { kind: "tool" }>;
export type NativeToolInvocation = {
  id: string;
  activity: ConversationActivity;
  records: ConversationActivity[];
};
type ToolRequest = { tool: Tool; frame: ConsoleFrame };
type RequestWitness = { count: number; request: ToolRequest };
export type NativeToolInvocationIndex = {
  lineages: ReadonlyMap<
    string,
    Partial<Record<"console_event" | "session_history", RequestWitness>>
  >;
  history: ReadonlyMap<string, RequestWitness>;
  historyLineages: ReadonlyMap<string, RequestWitness>;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function callId(frame: ConsoleFrame) {
  const payload = record(frame.payload);
  const id = payload.tool_call_id ?? payload.id;
  return typeof id === "string" && id ? id : null;
}

function lane(frame: ConsoleFrame) {
  return JSON.stringify([frame.runtime_key, frame.identity, frame.session_id]);
}

function lineage(frame: ConsoleFrame) {
  if (!frame.session_id || !(frame.run_id || frame.interaction_id || frame.turn_id)) return null;
  return JSON.stringify([
    lane(frame),
    frame.run_id,
    frame.interaction_id,
    frame.turn_id,
    callId(frame),
  ]);
}

function historyPosition(frame: ConsoleFrame) {
  if (frame.source.kind !== "session_history" || !frame.session_id) return null;
  const prefix = `${frame.session_id}:`;
  const cursor = frame.source.source_cursor;
  if (!cursor?.startsWith(prefix)) return null;
  const offset = cursor.slice(prefix.length).split(":")[0];
  return offset && /^\d+$/.test(offset) ? Number(offset) : null;
}

function historyKey(frame: ConsoleFrame, position: number, id: string) {
  return JSON.stringify([lane(frame), position, id]);
}

function toolRequests(tools: readonly Tool[]): ToolRequest[] {
  return tools.flatMap((tool) =>
    tool.frames
      .filter((frame) => frame.kind === "tool_call_requested" && callId(frame))
      .map((frame) => ({ tool, frame })),
  );
}

/** Count all available witnesses once; a bounded display group cannot prove global uniqueness. */
export function nativeToolInvocationIndex(
  activities: readonly ConversationActivity[],
): NativeToolInvocationIndex {
  const lineages = new Map<
    string,
    Partial<Record<"console_event" | "session_history", RequestWitness>>
  >();
  const history = new Map<string, RequestWitness>();
  const historyLineages = new Map<string, RequestWitness>();
  const add = (index: Map<string, RequestWitness>, key: string, request: ToolRequest) => {
    const witness = index.get(key);
    if (witness) witness.count++;
    else index.set(key, { count: 1, request });
  };
  const tools = activities.filter((activity): activity is Tool => activity.kind === "tool");
  for (const request of toolRequests(tools)) {
    const key = lineage(request.frame);
    const source = request.frame.source.kind;
    if (key && (source === "console_event" || source === "session_history")) {
      const siblings = lineages.get(key) ?? {};
      const witness = siblings[source];
      if (witness) witness.count++;
      else siblings[source] = { count: 1, request };
      lineages.set(key, siblings);
    }
    const position = historyPosition(request.frame);
    if (position !== null) {
      const at = historyKey(request.frame, position, callId(request.frame)!);
      add(history, at, request);
      if (key) add(historyLineages, JSON.stringify([at, key]), request);
    }
  }
  return { lineages, history, historyLineages };
}

/** Compact exact native call witnesses for display, retaining every original record.
 * Missing or ambiguous lineage stays separate. No matching by text, label or time.
 */
export function nativeToolInvocations(
  activities: readonly ConversationActivity[],
  index = nativeToolInvocationIndex(activities),
): NativeToolInvocation[] {
  const tools = activities.filter((activity): activity is Tool => activity.kind === "tool");
  const parent = new Map(tools.map((tool) => [tool.id, tool.id]));
  const root = (id: string): string => {
    const next = parent.get(id);
    return next && next !== id ? root(next) : id;
  };
  for (const request of toolRequests(tools)) {
    const key = lineage(request.frame);
    if (!key || request.frame.source.kind !== "session_history") continue;
    const siblings = index.lineages.get(key);
    const live = siblings?.console_event;
    if (
      live?.count === 1 &&
      siblings?.session_history?.count === 1 &&
      parent.has(live.request.tool.id)
    )
      parent.set(request.tool.id, root(live.request.tool.id));
  }
  for (const tool of tools) {
    if (tool.frames.some((frame) => frame.kind === "tool_call_requested")) continue;
    const frame = tool.frames[0];
    if (!frame || !callId(frame)) continue;
    const position = historyPosition(frame);
    if (position === null) continue;
    const at = historyKey(frame, position - 1, callId(frame)!);
    const key = lineage(frame);
    const preceding =
      key === null ? index.history.get(at) : index.historyLineages.get(JSON.stringify([at, key]));
    if (preceding?.count === 1 && parent.has(preceding.request.tool.id))
      parent.set(tool.id, root(preceding.request.tool.id));
  }
  const groups = new Map<string, NativeToolInvocation>();
  for (const activity of activities) {
    let id = activity.kind === "tool" ? root(activity.id) : activity.id;
    if (activity.kind === "frame") {
      const message = record(canonicalAssistantMessage(activity.frame));
      const blocks = Array.isArray(message.blocks) ? message.blocks : [];
      // A singleton saved tool-use message and its explicit call frame share a
      // committed message position. Mixed prose and parallel calls remain visible.
      if (blocks.length === 1 && record(blocks[0]).block_type === "tool_use") {
        const block = record(record(blocks[0]).data);
        const position = historyPosition(activity.frame);
        const match =
          position !== null && typeof block.id === "string"
            ? index.history.get(historyKey(activity.frame, position, block.id))
            : undefined;
        if (match?.count === 1 && parent.has(match.request.tool.id))
          id = root(match.request.tool.id);
      }
    }
    const group = groups.get(id);
    if (group) group.records.push(activity);
    else groups.set(id, { id, activity, records: [activity] });
  }
  for (const group of groups.values()) {
    const candidates = group.records.filter((row): row is Tool => row.kind === "tool");
    // A failure always remains visible. Prefer a terminal result, then the
    // observed live lifecycle, without rewriting any underlying status.
    const primary =
      candidates.find((row) => row.status === "Failed" || row.status === "Stopped") ??
      candidates.find((row) => row.status === "Completed") ??
      candidates.find((row) => row.frames.some((frame) => frame.source.kind === "console_event")) ??
      candidates[0];
    if (primary) {
      const named = candidates.find((row) => row.label !== "Tool");
      group.activity =
        primary.label === "Tool" && named ? { ...primary, label: named.label } : primary;
    }
  }
  return [...groups.values()];
}

import type { ConsoleFrame, MeerkatTeamAgent } from "@t3tools/contracts";
import {
  assistantOccurrenceRowId,
  hasAssistantIdentityField,
  reconcileAssistantOccurrences,
} from "./nativeAssistantOccurrence.logic";

export function nativeLabel(value: string) {
  return value.replaceAll("_", " ");
}

export function frameText(payload: unknown): string | null {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  for (const key of ["text", "content", "delta", "result", "body", "message", "output"]) {
    const value: unknown = Reflect.get(payload, key);
    if (typeof value === "string" && value.trim()) return value;
    if (key === "content" && Array.isArray(value)) {
      const text = value
        .flatMap((block: unknown) => {
          if (!block || typeof block !== "object") return [];
          const part: unknown = Reflect.get(block, "text");
          return typeof part === "string" ? [part] : [];
        })
        .join("\n");
      if (text) return text;
    }
  }
  return null;
}

/** These are presentation choices only. Native frame status always owns delivery/completion. */
export function mergeActivityFrames(frames: ReadonlyArray<ConsoleFrame>) {
  const newest = new Map<string, ConsoleFrame>();
  for (const frame of frames) {
    const previous = newest.get(frame.id);
    if (!previous || previous.frame_version <= frame.frame_version) newest.set(frame.id, frame);
  }
  // Native console cursors carry append order. Paging overlaps and may include older anchors.
  return [...newest.values()].sort((a, b) => {
    const left = /^console:(\d+)$/.exec(a.cursor)?.[1];
    const right = /^console:(\d+)$/.exec(b.cursor)?.[1];
    if (left && right)
      return BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
    return a.timestamp_ms - b.timestamp_ms;
  });
}

type LaterText = { hasText: boolean; terminalTexts: Set<string> };
type LaterInteraction = {
  all: LaterText;
  withoutSession: LaterText;
  sessions: Map<string, LaterText>;
};

const EMPTY_LATER_TEXT = (): LaterText => ({ hasText: false, terminalTexts: new Set() });
const HIDDEN_CONVERSATION_KINDS = new Set([
  "frame_updated",
  "reasoning_delta",
  "run_started",
  "turn_started",
  "turn_completed",
]);

export function conversationFrames(frames: ReadonlyArray<ConsoleFrame>) {
  const reconciled = reconcileUserInputs(mergeActivityFrames(frames));
  return displayConversationFrames(reconciled.frames, reconciled.history);
}

/** A console send and its committed history entry share native interaction identity. */
function reconcileUserInputs(frames: readonly ConsoleFrame[]) {
  const inputs = new Map<string, { sends: ConsoleFrame[]; history: ConsoleFrame[] }>();
  for (const frame of frames) {
    if (
      frame.kind !== "user_input" ||
      !frame.runtime_key ||
      !frame.identity ||
      !frame.session_id ||
      !frame.interaction_id ||
      (frame.source.kind !== "send" && frame.source.kind !== "session_history")
    )
      continue;
    const key = JSON.stringify([
      frame.runtime_key,
      frame.identity,
      frame.session_id,
      frame.interaction_id,
    ]);
    let input = inputs.get(key);
    if (!input) {
      input = { sends: [], history: [] };
      inputs.set(key, input);
    }
    (frame.source.kind === "send" ? input.sends : input.history).push(frame);
  }
  const repeated = new Set<string>();
  const positions = new Map<string, ConsoleFrame>();
  for (const { sends, history } of inputs.values()) {
    // An ambiguous or failed delivery remains inspectable. Never associate by text,
    // time, run ID, or a sessionless fallback, and never rewrite native delivery status.
    if (sends.length !== 1 || history.length !== 1) continue;
    const sent = sends[0]!;
    const saved = history[0]!;
    if (
      (sent.status === "delivered" || sent.status === "completed") &&
      saved.status === "completed" &&
      record(record(saved.payload).message).role === "user"
    ) {
      repeated.add(saved.id);
      positions.set(sent.id, saved);
    }
  }
  // The original send keeps its native ID, content and delivery status. Only
  // presentation can use the exact committed twin's position in history.
  return { frames: frames.filter((frame) => !repeated.has(frame.id)), history: positions };
}

function isEmptyRuntimeNoticeSnapshot(frame: ConsoleFrame): boolean {
  if (
    frame.kind !== "runtime_notice_snapshot" ||
    frame.source.kind !== "session_history" ||
    frame.status !== "completed"
  )
    return false;
  const payload = record(frame.payload);
  return (
    payload.complete === true &&
    typeof frame.session_id === "string" &&
    payload.session_id === frame.session_id &&
    frameText(payload) === null &&
    ["notices", "history_positions", "settled_attempts"].every(
      (key) => Array.isArray(payload[key]) && payload[key].length === 0,
    )
  );
}

function displayConversationFrames(
  frames: readonly ConsoleFrame[],
  userHistory: ReadonlyMap<string, ConsoleFrame>,
) {
  const canonical = reconcileAssistantOccurrences(frames, userHistory);
  const later = new Map<string, LaterInteraction>();
  const visible: ConsoleFrame[] = [];
  // Index the suffix once. Long-lived project agents can retain days of native
  // activity; scanning the entire suffix for each text fragment stalls typing.
  for (let index = canonical.length - 1; index >= 0; index--) {
    const frame = canonical[index]!;
    if (HIDDEN_CONVERSATION_KINDS.has(frame.kind) || isEmptyRuntimeNoticeSnapshot(frame)) continue;
    if (hasAssistantIdentityField(frame)) {
      visible.push(frame);
      continue;
    }
    const text = frameText(frame.payload);
    const key = frame.interaction_id
      ? JSON.stringify([frame.runtime_key, frame.identity, frame.interaction_id])
      : null;
    let interaction = key === null ? undefined : later.get(key);
    const matching = frame.session_id
      ? [interaction?.sessions.get(frame.session_id), interaction?.withoutSession]
      : [interaction?.all];
    const hidden =
      (frame.kind === "text_delta" && matching.some((entry) => entry?.hasText)) ||
      (frame.kind === "text_complete" &&
        text !== null &&
        matching.some((entry) => entry?.terminalTexts.has(text)));
    if (!hidden) visible.push(frame);
    if (
      key !== null &&
      text !== null &&
      (frame.kind === "text_complete" || frame.kind === "interaction_complete")
    ) {
      if (!interaction) {
        interaction = {
          all: EMPTY_LATER_TEXT(),
          withoutSession: EMPTY_LATER_TEXT(),
          sessions: new Map(),
        };
        later.set(key, interaction);
      }
      let scoped = frame.session_id
        ? interaction.sessions.get(frame.session_id)
        : interaction.withoutSession;
      if (!scoped) {
        scoped = EMPTY_LATER_TEXT();
        interaction.sessions.set(frame.session_id!, scoped);
      }
      for (const entry of [interaction.all, scoped]) {
        entry.hasText = true;
        if (frame.kind === "interaction_complete") entry.terminalTexts.add(text);
      }
    }
  }
  visible.reverse();
  // Coalesce adjacent streaming fragments for display; the raw activity retains every native frame.
  const messages: ConsoleFrame[] = [];
  for (const frame of visible) {
    const previous = messages.at(-1);
    // Tool-spawned workers currently omit interaction IDs on stream events. Collapse only
    // adjacent matching text, so repeated replies in separate turns remain distinct.
    if (
      previous &&
      !hasAssistantIdentityField(frame) &&
      !hasAssistantIdentityField(previous) &&
      frame.runtime_key === previous.runtime_key &&
      frame.identity === previous.identity &&
      (!frame.session_id || !previous.session_id || frame.session_id === previous.session_id) &&
      (!frame.interaction_id ||
        !previous.interaction_id ||
        frame.interaction_id === previous.interaction_id) &&
      frameText(frame.payload) === frameText(previous.payload) &&
      frameText(frame.payload) !== null &&
      ((frame.kind === "text_complete" && previous.kind === "text_delta") ||
        (frame.kind === "interaction_complete" && previous.kind === "text_complete"))
    ) {
      messages[messages.length - 1] = frame;
      continue;
    }
    if (
      frame.kind === "text_delta" &&
      previous?.kind === "text_delta" &&
      !hasAssistantIdentityField(frame) &&
      !hasAssistantIdentityField(previous) &&
      frame.runtime_key === previous.runtime_key &&
      frame.identity === previous.identity &&
      frame.session_id === previous.session_id &&
      frame.interaction_id === previous.interaction_id &&
      frame.turn_id === previous.turn_id
    ) {
      messages[messages.length - 1] = {
        ...previous,
        payload: { delta: `${frameText(previous.payload) ?? ""}${frameText(frame.payload) ?? ""}` },
      };
    } else messages.push(frame);
  }
  return messages;
}

export function isThreadCoordinator(agent: MeerkatTeamAgent) {
  return (
    agent.mobKind === "thread" &&
    !agent.record.labels.source_mob_id &&
    agent.record.runtime_member_id === "ingress"
  );
}

export type ConversationActivity =
  | { kind: "frame"; id: string; frame: ConsoleFrame }
  | {
      kind: "tool";
      id: string;
      label: string;
      status: "Requested" | "Running" | "Completed" | "Failed" | "Stopped";
      frames: ConsoleFrame[];
      input: string | null;
      output: string | null;
    };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const TOOL_STAGES = new Set([
  "tool_call_requested",
  "tool_execution_started",
  "tool_execution_completed",
  "tool_execution_failed",
  "tool_result_received",
]);

function toolOutput(payload: Record<string, unknown>): string | null {
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  const structured = blocks.flatMap((block: unknown) => {
    const data = record(record(block).data);
    return [data.stdout, data.stderr].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
  });
  if (structured.length) return structured.join("\n");
  return typeof payload.error === "string" ? payload.error : frameText(payload);
}

function toolStageStatus(
  frame: ConsoleFrame,
): Extract<ConversationActivity, { kind: "tool" }>["status"] {
  const payload = record(frame.payload);
  if (record(payload.error_report).class === "cancelled") return "Stopped";
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  const commandFailed = blocks.some((block: unknown) => {
    const data = record(record(block).data);
    return data.timed_out === true || (typeof data.exit_code === "number" && data.exit_code !== 0);
  });
  if (
    payload.is_error === true ||
    commandFailed ||
    frame.kind === "tool_execution_failed" ||
    frame.status === "delivery_failed"
  )
    return "Failed";
  if (frame.kind === "tool_execution_completed" || frame.kind === "tool_result_received")
    return "Completed";
  return frame.kind === "tool_execution_started" ? "Running" : "Requested";
}

/** Group presentation only; the original native frames remain intact in the raw view. */
export function conversationActivities(
  frames: ReadonlyArray<ConsoleFrame>,
): ConversationActivity[] {
  const activities: ConversationActivity[] = [];
  const groups = new Map<string, Extract<ConversationActivity, { kind: "tool" }>>();
  const reconciled = reconcileUserInputs(mergeActivityFrames(frames));
  const canonical = reconciled.frames;
  const boundaries = new Map<string, number>();
  const frameBoundaries = new Map<string, number>();
  // Message reconciliation may hide a repeated run result; its native boundary still
  // separates legacy tool activity whose events have no interaction/run/turn lineage.
  for (const frame of canonical) {
    const lane = JSON.stringify([frame.runtime_key, frame.identity]);
    if (
      ["user_input", "interaction_started", "interaction_complete", "interaction_failed"].includes(
        frame.kind,
      )
    )
      boundaries.set(lane, (boundaries.get(lane) ?? 0) + 1);
    frameBoundaries.set(frame.id, boundaries.get(lane) ?? 0);
  }
  for (const frame of displayConversationFrames(canonical, reconciled.history)) {
    const lane = JSON.stringify([frame.runtime_key, frame.identity]);
    const payload = record(frame.payload);
    const callId = typeof payload.tool_call_id === "string" ? payload.tool_call_id : payload.id;
    if (!TOOL_STAGES.has(frame.kind) || typeof callId !== "string" || !callId) {
      activities.push({ kind: "frame", id: assistantOccurrenceRowId(frame) ?? frame.id, frame });
      continue;
    }
    const key = JSON.stringify([
      lane,
      frame.interaction_id || frame.run_id || frame.turn_id ? null : frameBoundaries.get(frame.id),
      frame.session_id ?? null,
      frame.interaction_id ?? null,
      frame.run_id ?? null,
      frame.turn_id ?? null,
      callId,
    ]);
    let activity = groups.get(key);
    // An explicit new request owns another call even if a provider reuses its ID.
    if (
      frame.kind === "tool_call_requested" &&
      activity?.frames.some((item) => item.kind === "tool_call_requested")
    )
      activity = undefined;
    const status = toolStageStatus(frame);
    if (!activity) {
      const name = typeof payload.name === "string" ? nativeLabel(payload.name) : "Tool";
      activity = {
        kind: "tool",
        id: frame.id,
        label: name.charAt(0).toUpperCase() + name.slice(1),
        status,
        frames: [],
        input: null,
        output: null,
      };
      groups.set(key, activity);
      activities.push(activity);
    }
    const alreadyFailed = activity.status === "Failed" || activity.status === "Stopped";
    activity.frames.push(frame);
    if (activity.status !== "Failed" && activity.status !== "Stopped") activity.status = status;
    const args = record(payload.args);
    if (payload.args !== undefined)
      activity.input =
        typeof args.command === "string" ? args.command : JSON.stringify(payload.args, null, 2);
    if (
      ["tool_execution_completed", "tool_execution_failed", "tool_result_received"].includes(
        frame.kind,
      ) &&
      (!alreadyFailed || status === "Failed" || status === "Stopped")
    )
      activity.output = toolOutput(payload) ?? activity.output;
  }
  return activities;
}

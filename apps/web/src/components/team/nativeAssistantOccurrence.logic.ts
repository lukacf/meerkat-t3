import type { ConsoleFrame } from "@t3tools/contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_TEXT = new Set([
  "text_delta",
  "text_complete",
  "interaction_complete",
  "assistant_message",
]);
const MESSAGE_CONTENT = new Set([
  ...MESSAGE_TEXT,
  "reasoning_delta",
  "reasoning_complete",
  "server_tool_content",
  "assistant_image_appended",
]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function messageId(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value) ? value : undefined;
}

function sequence(value: unknown): bigint | undefined {
  const match = typeof value === "string" ? /^console:(\d+)$/.exec(value) : null;
  return match ? BigInt(match[1]!) : undefined;
}

function sessionKey(frame: ConsoleFrame): string | undefined {
  return frame.runtime_key && frame.identity && frame.session_id
    ? JSON.stringify([frame.runtime_key, frame.identity, frame.session_id])
    : undefined;
}

function occurrence(frame: ConsoleFrame) {
  const session = sessionKey(frame);
  const id = messageId(record(frame.payload).assistant_message_id);
  return session && id ? { session, id, key: JSON.stringify([session, id]) } : undefined;
}

/** A supplied but unusable ID must not fall back to a text-derived association. */
export function hasAssistantIdentityField(frame: ConsoleFrame): boolean {
  return Object.hasOwn(record(frame.payload), "assistant_message_id");
}

export function assistantOccurrenceRowId(frame: ConsoleFrame): string | undefined {
  const owner = occurrence(frame);
  return owner &&
    MESSAGE_TEXT.has(frame.kind) &&
    (frame.kind !== "assistant_message" || canonicalAssistantMessage(frame))
    ? `assistant:${owner.key}`
    : undefined;
}

export function canonicalAssistantMessage(frame: ConsoleFrame) {
  const owner = occurrence(frame);
  const message = record(record(frame.payload).message);
  return owner &&
    frame.source.kind === "session_history" &&
    (frame.kind === "text_complete" || frame.kind === "assistant_message") &&
    message.role === "block_assistant" &&
    message.assistant_message_id === owner.id
    ? message
    : undefined;
}

type PositionedFrame = { frame: ConsoleFrame; index: number };
type MessageState = {
  index: number;
  canonical?: ConsoleFrame;
  complete?: ConsoleFrame;
  delta?: ConsoleFrame;
  deltas: string[];
  content: PositionedFrame[];
};

type HistoryPosition = readonly (bigint | string)[];
type HistorySnapshot = {
  cursor: bigint;
  through: bigint;
  sparse: boolean;
  positions: ReadonlyMap<string, HistoryPosition>;
  removed: ReadonlySet<string>;
  notices: ReadonlyMap<string, HistoryPosition> | undefined;
};

function runtimeNoticeKey(value: unknown, session: string): string | undefined {
  const message = record(value);
  const origin = record(message.runtime_origin);
  return message.role === "system_notice" &&
    origin.session_id === session &&
    messageId(origin.session_id) &&
    messageId(origin.run_id) &&
    messageId(origin.input_id) &&
    typeof origin.append_ordinal === "number" &&
    Number.isSafeInteger(origin.append_ordinal) &&
    origin.append_ordinal >= 0
    ? JSON.stringify([origin.session_id, origin.run_id, origin.input_id, origin.append_ordinal])
    : undefined;
}

function noticePositions(
  value: unknown,
  session: string,
): ReadonlyMap<string, HistoryPosition> | undefined {
  if (!Array.isArray(value)) return undefined;
  const positions = new Map<string, HistoryPosition>();
  for (const valueRow of value) {
    const row = record(valueRow);
    const key = runtimeNoticeKey(row.message, session);
    if (
      !key ||
      positions.has(key) ||
      typeof row.offset !== "number" ||
      !Number.isSafeInteger(row.offset) ||
      row.offset < 0
    )
      return undefined;
    positions.set(key, [BigInt(row.offset)]);
  }
  return positions;
}

/** Match native numeric cursor components, including projected tool/image children. */
function historyPosition(session: string, cursor: unknown): HistoryPosition | undefined {
  if (typeof cursor !== "string" || !cursor.startsWith(`${session}:`)) return undefined;
  const suffix = cursor.slice(session.length + 1);
  if (
    !/^(\d+)(?::(?:\d+(?::image:\d+)?|(?:tool-call|comms-out):\d+|spawn-initial:\d+:\d+))?$/.test(
      suffix,
    )
  )
    return undefined;
  const position = suffix.split(":").map((part) => (/^\d+$/.test(part) ? BigInt(part) : part));
  return position.some((part) => typeof part === "bigint" && part > 18_446_744_073_709_551_615n)
    ? undefined
    : position;
}

function compareHistoryPosition(left: HistoryPosition, right: HistoryPosition): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const a = left[index]!;
    const b = right[index]!;
    if (a === b) continue;
    if (typeof a === "bigint") return typeof b === "string" || a < b ? -1 : 1;
    if (typeof b === "bigint") return 1;
    return a < b ? -1 : 1;
  }
  return left.length - right.length;
}

function historySnapshots(frames: readonly ConsoleFrame[]): Map<string, HistorySnapshot[]> {
  const sessions = new Map<string, HistorySnapshot[]>();
  for (const frame of frames) {
    if (
      frame.kind !== "runtime_notice_snapshot" ||
      frame.source.kind !== "session_history" ||
      frame.status !== "completed"
    )
      continue;
    const session = sessionKey(frame);
    const cursor = sequence(frame.cursor);
    const payload = record(frame.payload);
    const through = sequence(payload.observed_through);
    if (
      !session ||
      cursor === undefined ||
      through === undefined ||
      through > cursor ||
      payload.session_id !== frame.session_id ||
      payload.complete !== true ||
      (payload.history_positions_mode !== undefined &&
        payload.history_positions_mode !== "sparse") ||
      !Array.isArray(payload.history_positions) ||
      (payload.removed_history_frame_ids !== undefined &&
        (!Array.isArray(payload.removed_history_frame_ids) ||
          !payload.removed_history_frame_ids.every(
            (id) => typeof id === "string" && id.length > 0,
          )))
    )
      continue;
    const positions = new Map<string, HistoryPosition>();
    let valid = true;
    for (const value of payload.history_positions) {
      const row = record(value);
      const position = historyPosition(frame.session_id!, row.source_cursor);
      const previous = typeof row.frame_id === "string" ? positions.get(row.frame_id) : undefined;
      if (
        typeof row.frame_id !== "string" ||
        row.frame_id.length === 0 ||
        !position ||
        (previous && compareHistoryPosition(previous, position) !== 0)
      ) {
        valid = false;
        break;
      }
      positions.set(row.frame_id, position);
    }
    if (!valid) continue;
    const snapshots = sessions.get(session) ?? [];
    snapshots.push({
      cursor,
      through,
      sparse: payload.history_positions_mode === "sparse",
      positions,
      removed: new Set((payload.removed_history_frame_ids as string[] | undefined) ?? []),
      notices: noticePositions(payload.notices, frame.session_id!),
    });
    sessions.set(session, snapshots);
  }
  for (const snapshots of sessions.values())
    snapshots.sort((left, right) =>
      left.cursor < right.cursor ? -1 : left.cursor > right.cursor ? 1 : 0,
    );
  return sessions;
}

function historyCoordinates(
  entries: readonly PositionedFrame[],
  userHistory: ReadonlyMap<string, ConsoleFrame>,
  snapshots: readonly HistorySnapshot[],
): (HistoryPosition | undefined)[] {
  const rows = entries.map(({ frame }) => {
    const twin = userHistory.get(frame.id);
    const history = twin && sessionKey(twin) === sessionKey(frame) ? twin : frame;
    const message = record(record(history.payload).message);
    // Runtime-origin notices use a complete, separately positioned notice image.
    // A supplied but malformed origin cannot inherit ordinary history authority.
    const isRuntimeNotice =
      history.kind === "system_notice" &&
      message.runtime_origin !== undefined &&
      message.runtime_origin !== null;
    const noticeKey =
      isRuntimeNotice && history.session_id
        ? runtimeNoticeKey(message, history.session_id)
        : undefined;
    const eligible =
      history.source.kind === "session_history" &&
      history.status !== "redacted" &&
      history.kind !== "runtime_notice_snapshot" &&
      history.kind !== "assistant_history_snapshot";
    return {
      frame: history,
      cursor: eligible ? sequence(history.cursor) : undefined,
      isRuntimeNotice,
      noticeKey,
      position:
        history.source.kind === "session_history" &&
        history.status !== "redacted" &&
        history.session_id &&
        (!isRuntimeNotice || noticeKey)
          ? historyPosition(history.session_id, history.source.source_cursor)
          : undefined,
    };
  });
  const byId = new Map(rows.map((row) => [row.frame.id, row]));
  const noticeRows = rows.filter((row) => row.isRuntimeNotice);
  for (const snapshot of snapshots) {
    if (!snapshot.sparse) {
      for (const row of rows) {
        if (!row.isRuntimeNotice && row.cursor !== undefined && row.cursor <= snapshot.through)
          row.position = snapshot.positions.get(row.frame.id);
      }
    } else {
      for (const [id, position] of snapshot.positions) {
        const row = byId.get(id);
        if (!row?.isRuntimeNotice && row?.cursor !== undefined && row.cursor <= snapshot.through)
          row.position = position;
      }
      for (const id of snapshot.removed) {
        const row = byId.get(id);
        if (
          !row?.isRuntimeNotice &&
          row?.cursor !== undefined &&
          row.cursor <= snapshot.through &&
          !snapshot.positions.has(id)
        )
          row.position = undefined;
      }
    }
    for (const row of noticeRows) {
      if (row.cursor !== undefined && row.cursor <= snapshot.through)
        row.position = row.noticeKey ? snapshot.notices?.get(row.noticeKey) : undefined;
    }
  }
  return rows.map((row) => row.position);
}

/** Order committed messages together, retaining live stages beside their native stream anchors. */
function orderHistory(
  frames: PositionedFrame[],
  userHistory: ReadonlyMap<string, ConsoleFrame>,
  snapshots: ReadonlyMap<string, readonly HistorySnapshot[]>,
): ConsoleFrame[] {
  const ordered = frames.sort((left, right) => left.index - right.index);
  const sessions = new Map<string, PositionedFrame[]>();
  for (const frame of ordered) {
    const session = sessionKey(frame.frame);
    if (!session) continue;
    const entries = sessions.get(session) ?? [];
    entries.push(frame);
    sessions.set(session, entries);
  }
  const reordered = new Map<string, ConsoleFrame[]>();
  for (const [session, entries] of sessions) {
    const offsets = historyCoordinates(entries, userHistory, snapshots.get(session) ?? []);
    const first = offsets.find((offset) => offset !== undefined);
    if (first === undefined) continue;
    let frontier: HistoryPosition | undefined;
    const positions = entries.map((entry, index) => {
      const offset = offsets[index];
      // Canonical replies retain their earlier live index. Later saved tool rows
      // can have lower offsets, but must not pull the next live input behind them.
      if (
        offset !== undefined &&
        (frontier === undefined || compareHistoryPosition(offset, frontier) > 0)
      )
        frontier = offset;
      return {
        ...entry,
        offset: offset ?? frontier ?? first,
        // A live stage follows the preceding committed frontier. Before the
        // first occurrence it remains a prefix; no content/time matching is used.
        side: offset !== undefined ? 0 : frontier === undefined ? -1 : 1,
      };
    });
    positions.sort(
      (left, right) =>
        compareHistoryPosition(left.offset, right.offset) ||
        left.side - right.side ||
        left.index - right.index,
    );
    reordered.set(
      session,
      positions.map(({ frame }) => frame),
    );
  }
  const next = new Map<string, number>();
  return ordered.map(({ frame }) => {
    const session = sessionKey(frame);
    const entries = session ? reordered.get(session) : undefined;
    if (!session || !entries) return frame;
    const index = next.get(session) ?? 0;
    next.set(session, index + 1);
    return entries[index]!;
  });
}

/** Present native message occurrences without changing the raw console log or tool ownership. */
export function reconcileAssistantOccurrences(
  frames: readonly ConsoleFrame[],
  userHistory: ReadonlyMap<string, ConsoleFrame> = new Map(),
): ConsoleFrame[] {
  const snapshots = new Map<string, { cursor: bigint; through: bigint; ids: Set<string> }>();
  // Timelines arrive in cursor order. Start at the newest end so a valid snapshot
  // supersedes older full ID arrays before we read or validate their bodies.
  for (let index = frames.length - 1; index >= 0; index--) {
    const frame = frames[index]!;
    if (frame.kind !== "assistant_history_snapshot" || frame.source.kind !== "session_history")
      continue;
    const session = sessionKey(frame);
    const cursor = sequence(frame.cursor);
    if (!session || cursor === undefined) continue;
    const previous = snapshots.get(session);
    if (previous && cursor < previous.cursor) continue;
    const payload = record(frame.payload);
    const through = sequence(payload.observed_through);
    const ids = payload.assistant_message_ids;
    if (
      frame.status === "redacted" ||
      payload.session_id !== frame.session_id ||
      payload.complete !== true ||
      through === undefined ||
      through > cursor ||
      !Array.isArray(ids) ||
      !ids.every((id): id is string => messageId(id) !== undefined)
    )
      continue;
    snapshots.set(session, { cursor, through, ids: new Set(ids) });
  }

  const output: PositionedFrame[] = [];
  const messages = new Map<string, MessageState>();
  for (const [index, frame] of frames.entries()) {
    // The snapshot is reconciliation metadata, including when its body was redacted.
    if (frame.kind === "assistant_history_snapshot") continue;
    const owner = occurrence(frame);
    const reset = frame.kind === "turn_started" || frame.kind === "retrying";
    if (!owner || (!MESSAGE_CONTENT.has(frame.kind) && !reset)) {
      output.push({ frame, index });
      continue;
    }
    const snapshot = snapshots.get(owner.session);
    const cursor = sequence(frame.cursor);
    if (
      snapshot &&
      cursor !== undefined &&
      cursor <= snapshot.through &&
      !snapshot.ids.has(owner.id)
    )
      continue;
    let message = messages.get(owner.key);
    if (!message) {
      message = { index, deltas: [], content: [] };
      messages.set(owner.key, message);
    }
    if (reset && frame.source.kind === "console_event") {
      // Retries/re-polls reuse the native ID, but replace that attempt's provisional output.
      delete message.complete;
      delete message.delta;
      message.deltas = [];
      message.content = [];
      if (frame.kind === "retrying") output.push({ frame, index });
    } else if (canonicalAssistantMessage(frame)) {
      message.canonical = frame;
    } else if (frame.kind === "text_delta") {
      const delta = record(frame.payload).delta;
      if (!message.complete && typeof delta === "string") {
        message.delta ??= frame;
        message.deltas.push(delta);
      }
    } else if (frame.kind === "text_complete" || frame.kind === "interaction_complete") {
      // A run result can repeat an older message. It is not a new message or a commit.
      if (frame.kind === "text_complete" || message.complete?.kind !== "text_complete")
        message.complete = frame;
    } else if (!reset) {
      message.content.push({ frame, index });
    }
  }
  for (const message of messages.values()) {
    const frame =
      message.canonical ??
      message.complete ??
      (message.delta
        ? {
            ...message.delta,
            payload: { ...record(message.delta.payload), delta: message.deltas.join("") },
          }
        : undefined);
    if (frame) output.push({ index: message.index, frame });
    // Canonical ordered blocks replace provisional reasoning/images, not independent tool stages.
    if (!message.canonical) output.push(...message.content);
  }
  return orderHistory(output, userHistory, historySnapshots(frames));
}

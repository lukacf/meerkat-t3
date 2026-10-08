import type { ConsoleFrame } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { conversationActivities, conversationFrames, frameText } from "./agentActivity.logic";
import {
  canonicalAssistantMessage,
  reconcileAssistantOccurrences,
} from "./nativeAssistantOccurrence.logic";
import { savedMessageView } from "./nativeTranscript.logic";
import heldTurnFrames from "./nativeAssistantOccurrence.chronology.fixture.json";

const A = "01995a90-f000-7000-8000-000000000001";
const B = "01995a90-f000-7000-8000-000000000002";
function frame(
  seq: number,
  kind: string,
  payload: Record<string, unknown> = {},
  extra: Partial<ConsoleFrame> = {},
): ConsoleFrame {
  return {
    id: `frame-${seq}`,
    cursor: `console:${seq}`,
    dedupe_key: `frame-${seq}`,
    timestamp_ms: seq,
    runtime_key: "runtime",
    identity: "agent",
    session_id: "session",
    interaction_id: "interaction",
    kind,
    payload: { assistant_message_id: A, ...payload },
    status: "delivered",
    frame_version: 1,
    source: { kind: "console_event" },
    ...extra,
  };
}
function history(seq: number, id = A, text = "Answer", offset = seq) {
  return frame(
    seq,
    "text_complete",
    {
      assistant_message_id: id,
      text,
      message: {
        role: "block_assistant",
        assistant_message_id: id,
        blocks: [{ block_type: "text", data: { text } }],
      },
    },
    {
      source: { kind: "session_history", source_cursor: `session:${offset}` },
      status: "completed",
    },
  );
}
function snapshot(seq: number, through: number, ids: string[], extra: Partial<ConsoleFrame> = {}) {
  return frame(
    seq,
    "assistant_history_snapshot",
    {
      session_id: "session",
      complete: true,
      observed_through: `console:${through}`,
      assistant_message_ids: ids,
    },
    { source: { kind: "session_history" }, ...extra },
  );
}
function positionSnapshot(
  seq: number,
  through: number,
  positions: [ConsoleFrame, string][],
  payload: Record<string, unknown> = {},
  extra: Partial<ConsoleFrame> = {},
) {
  return frame(
    seq,
    "runtime_notice_snapshot",
    {},
    {
      source: { kind: "session_history" },
      status: "completed",
      payload: {
        session_id: "session",
        complete: true,
        observed_through: `console:${through}`,
        history_positions: positions.map(([entry, source_cursor]) => ({
          frame_id: entry.id,
          source_cursor,
        })),
        ...payload,
      },
      ...extra,
    },
  );
}
function withoutPositionSnapshots(frames: ConsoleFrame[]) {
  return conversationFrames(frames).filter((entry) => entry.kind !== "runtime_notice_snapshot");
}
function noticeCompactionFixture() {
  const session = "01995a90-f000-7000-8000-000000000003";
  const call = frame(
    1,
    "tool_call_requested",
    {},
    {
      session_id: session,
      status: "completed",
      source: { kind: "session_history", source_cursor: `${session}:10:tool-call:0` },
      payload: {
        tool_call_id: "retained-tool",
        name: "lookup_delivery",
        args: { request: "plan" },
      },
    },
  );
  const result = frame(
    2,
    "tool_execution_completed",
    {},
    {
      session_id: session,
      status: "completed",
      source: { kind: "session_history", source_cursor: `${session}:11:0` },
      payload: { tool_call_id: "retained-tool", result: "Delivery is ready." },
    },
  );
  const message = {
    role: "system_notice",
    kind: "generic",
    body: "Exact boundary notice.",
    runtime_origin: { session_id: session, run_id: A, input_id: B, append_ordinal: 0 },
  };
  const notice = frame(
    3,
    "system_notice",
    {},
    {
      session_id: session,
      status: "completed",
      source: { kind: "session_history", source_cursor: `${session}:12` },
      payload: { message },
    },
  );
  const answer: ConsoleFrame = {
    ...history(4, A, "The delivery plan is ready."),
    session_id: session,
    source: { kind: "session_history", source_cursor: `${session}:13` },
  };
  const snapshot = positionSnapshot(
    5,
    4,
    [
      [call, `${session}:1:tool-call:0`],
      [result, `${session}:2:0`],
      [answer, `${session}:4`],
    ],
    { session_id: session, notices: [{ offset: 3, message }] },
    { session_id: session },
  );
  return { session, call, result, notice, answer, message, snapshot };
}

describe("native assistant occurrence reconciliation", () => {
  it("keeps the observed completed answer before the next live input when saved tools arrive late", () => {
    // Exact console rows from the packaged UI question/queue run AJsI3e.
    // The answer's live occurrence precedes its saved tool result and canonical twin.
    const native = heldTurnFrames as ConsoleFrame[];
    const answer = native.find((entry) => entry.cursor === "console:23")!;
    const result = native.find((entry) => entry.cursor === "console:22")!;
    const nextInput = native.find((entry) => entry.cursor === "console:27")!;
    const before = conversationActivities(native.slice(0, -1));
    const shown = conversationFrames(native);
    expect(shown).toEqual([result, answer, nextInput]);
    expect(shown[1]).toBe(answer);
    expect(shown[2]).toBe(nextInput);
    const after = conversationActivities(native);
    expect(after.slice(0, -1).map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(nextInput.status).toBe("delivered");
    expect(answer.source.source_cursor).toBe(`${answer.session_id}:4`);
  });

  it("keeps identical text with different native IDs, including within one interaction", () => {
    const shown = conversationFrames([
      history(1),
      history(2, B),
      frame(3, "interaction_complete", { assistant_message_id: B, result: "Answer" }),
    ]);
    expect(shown.map((entry) => entry.id)).toEqual(["frame-1", "frame-2"]);
  });

  it("replaces streaming text with exact canonical content and keeps a stable presentation key", () => {
    const live = [
      frame(1, "turn_started"),
      frame(2, "text_delta", { delta: "Outdated" }),
      frame(3, "text_complete", { content: "Outdated" }),
    ];
    const before = conversationActivities(live);
    const committed = history(4, A, "Canonical content");
    const after = conversationActivities([
      ...live,
      committed,
      frame(5, "interaction_complete", { result: "Outdated" }, { run_id: "another-run" }),
    ]);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]).toMatchObject({ kind: "frame", frame: committed });
    expect(conversationActivities([committed])[0]?.id).toBe(before[0]?.id);
    expect(live[1]?.payload).toEqual({ assistant_message_id: A, delta: "Outdated" });
  });

  it("resets provisional text and reasoning on retry and repeated turn start", () => {
    const shown = conversationFrames([
      frame(1, "turn_started"),
      frame(2, "text_delta", { delta: "discard" }),
      frame(3, "reasoning_complete", { content: "old reasoning" }),
      frame(4, "retrying", { retry: { attempt: 1 } }),
      frame(5, "text_delta", { delta: "also discard" }),
      frame(6, "turn_started"),
      frame(7, "text_delta", { delta: "New " }),
      frame(8, "text_delta", { delta: "attempt" }),
    ]);
    expect(
      shown.filter((item) => item.kind === "text_delta").map((item) => frameText(item.payload)),
    ).toEqual(["New attempt"]);
    expect(shown.some((item) => item.kind === "reasoning_complete")).toBe(false);
    expect(shown.some((item) => item.kind === "retrying")).toBe(true);
    expect(shown.find((item) => item.kind === "text_delta")?.payload).toMatchObject({
      assistant_message_id: A,
    });
  });

  it("keeps the final committed reply after older messages backfilled in a recent page", () => {
    const finalDelta = frame(650, "text_delta", { assistant_message_id: B, delta: "Final report" });
    const finalComplete = frame(728, "text_complete", {
      assistant_message_id: B,
      text: "Final report",
    });
    const earlier = history(747, A, "Let me check the documentation.", 10);
    const tool = frame(
      750,
      "tool_execution_completed",
      {},
      {
        source: { kind: "session_history", source_cursor: "session:11:0" },
        payload: { id: "read-docs", result: "Documentation" },
      },
    );
    const final = history(751, B, "Final report", 12);
    const before = conversationActivities([finalDelta, finalComplete]);
    const after = conversationActivities([
      finalDelta,
      finalComplete,
      snapshot(731, 730, [A, B]),
      earlier,
      tool,
      final,
    ]);
    expect(after.map((row) => (row.kind === "frame" ? row.frame.id : row.frames[0]?.id))).toEqual([
      earlier.id,
      tool.id,
      final.id,
    ]);
    expect(after.at(-1)?.id).toBe(before[0]?.id);
    expect(conversationFrames([finalDelta, finalComplete, earlier, tool, final]).at(-1)).toBe(
      final,
    );
  });

  it("keeps two delayed turns paired while preserving each original send and delivery status", () => {
    const input = (seq: number, interaction: string, committed = false) =>
      frame(
        seq,
        "user_input",
        {},
        {
          interaction_id: interaction,
          payload: committed
            ? { content: "same prompt", message: { role: "user" } }
            : { content: "same prompt", handling_mode: "queue" },
          source: committed
            ? { kind: "session_history", source_cursor: `session:${interaction === "a" ? 0 : 2}` }
            : { kind: "send" },
          status: committed ? "completed" : "delivered",
        },
      );
    const first = input(1, "a");
    const second = input(3, "b");
    const replyA = { ...history(6, A, "First answer", 1), interaction_id: "a" };
    const replyB = { ...history(8, B, "Second answer", 3), interaction_id: "b" };
    const frames = [
      first,
      frame(2, "text_delta", { delta: "First" }, { interaction_id: "a" }),
      second,
      frame(4, "text_delta", { assistant_message_id: B, delta: "Second" }, { interaction_id: "b" }),
      input(5, "a", true),
      replyA,
      input(7, "b", true),
      replyB,
    ];
    const shown = conversationFrames(frames);
    expect(shown).toEqual([first, replyA, second, replyB]);
    expect(shown[0]).toBe(first);
    expect(shown[2]).toBe(second);
    expect(
      shown.filter((entry) => entry.kind === "user_input").map((entry) => entry.status),
    ).toEqual(["delivered", "delivered"]);
    const before = conversationActivities(frames.slice(0, 4));
    const after = conversationActivities(frames);
    expect(after.map((entry) => entry.id)).toEqual(before.map((entry) => entry.id));
    expect(conversationFrames(frames.filter((entry) => entry.kind !== "text_delta"))).toEqual([
      first,
      replyA,
      second,
      replyB,
    ]);
  });

  it("keeps live tool stages between their introducing message and the next committed reply", () => {
    const request = frame(
      2,
      "tool_call_requested",
      {},
      {
        payload: { id: "read", tool_call_id: "read", name: "read_file" },
      },
    );
    const completed = frame(
      3,
      "tool_execution_completed",
      {},
      {
        payload: { id: "read", tool_call_id: "read", result: "File contents" },
      },
    );
    const first = history(5, A, "Reading the file", 2);
    const result = frame(
      6,
      "tool_execution_completed",
      {},
      {
        source: { kind: "session_history", source_cursor: "session:3:0" },
        payload: { id: "read", tool_call_id: "read", result: "File contents" },
        interaction_id: undefined,
      },
    );
    const final = history(7, B, "Final answer", 4);
    const frames = [
      frame(1, "text_delta", { delta: "Reading" }),
      request,
      completed,
      frame(4, "text_delta", { assistant_message_id: B, delta: "Answer" }),
      first,
      result,
      final,
    ];
    expect(conversationFrames(frames)).toEqual([first, request, completed, result, final]);
    const rows = conversationActivities(frames);
    expect(rows.map((row) => row.kind)).toEqual(["frame", "tool", "tool", "frame"]);
    expect(rows[1]).toMatchObject({ id: request.id, frames: [request, completed] });
    expect(rows.at(-1)).toMatchObject({ kind: "frame", frame: final });
  });

  it("uses exact same-session native offsets rather than append time or message text", () => {
    const later = history(1, B, "Same", 10);
    const earlier = history(2, A, "Same", 2);
    expect(conversationFrames([later, earlier])).toEqual([earlier, later]);
    for (const source_cursor of ["foreign:2", "session:not-an-offset", "session:2:unknown"]) {
      const unpositioned = {
        ...earlier,
        source: { kind: "session_history" as const, source_cursor },
      };
      expect(conversationFrames([later, unpositioned])).toEqual([later, unpositioned]);
    }
  });

  it("orders native child indices numerically within each projected history message", () => {
    const cursors = [
      "session:10:tool-call:10",
      "session:10:2:image:10",
      "session:10:10",
      "session:10:spawn-initial:10:2",
      "session:10:2:image:2",
      "session:10:tool-call:2",
      "session:10:comms-out:2",
      "session:10:spawn-initial:2:10",
      "session:10:2",
      "session:10:spawn-initial:2:2",
      "session:10",
    ];
    const rows = cursors.map((source_cursor, index) =>
      frame(
        index + 1,
        "tool_execution_completed",
        {},
        {
          payload: { tool_call_id: `call-${index}`, result: "Same result" },
          source: { kind: "session_history", source_cursor },
        },
      ),
    );
    expect(conversationFrames(rows).map((entry) => entry.source.source_cursor)).toEqual([
      "session:10",
      "session:10:2",
      "session:10:2:image:2",
      "session:10:2:image:10",
      "session:10:10",
      "session:10:comms-out:2",
      "session:10:spawn-initial:2:2",
      "session:10:spawn-initial:2:10",
      "session:10:spawn-initial:10:2",
      "session:10:tool-call:2",
      "session:10:tool-call:10",
    ]);
  });

  it("relocates exact covered durable IDs without changing frames, statuses or row identities", () => {
    const first = history(1, A, "Same", 20);
    const second = history(2, B, "Same", 30);
    const relocated = positionSnapshot(4, 2, [
      [first, "session:3"],
      [second, "session:1"],
    ]);
    const shown = withoutPositionSnapshots([first, second, relocated]);
    expect(shown).toEqual([second, first]);
    expect(shown[0]).toBe(second);
    expect(shown[1]).toBe(first);
    expect(first.source.source_cursor).toBe("session:20");
    expect(second.source.source_cursor).toBe("session:30");
    expect(
      conversationActivities([first, second, relocated])
        .filter((row) => row.kind === "frame" && row.frame.kind !== "runtime_notice_snapshot")
        .map((row) => row.id),
    ).toEqual([conversationActivities([second])[0]?.id, conversationActivities([first])[0]?.id]);
  });

  it("keeps prior relocation through sparse updates and replaces it with later full images", () => {
    const first = history(1, A, "First", 20);
    const second = history(2, B, "Second", 30);
    const full = positionSnapshot(3, 2, [
      [first, "session:1"],
      [second, "session:4"],
    ]);
    const sparse = positionSnapshot(4, 2, [[second, "session:0"]], {
      history_positions_mode: "sparse",
    });
    const unchanged = positionSnapshot(5, 4, [], { history_positions_mode: "sparse" });
    expect(withoutPositionSnapshots([first, second, full, sparse, unchanged])).toEqual([
      second,
      first,
    ]);
    const replaced = positionSnapshot(6, 5, [
      [first, "session:0"],
      [second, "session:1"],
    ]);
    expect(withoutPositionSnapshots([first, second, full, sparse, unchanged, replaced])).toEqual([
      first,
      second,
    ]);
    // Snapshot cursor order, not array arrival order, owns successive updates.
    expect(
      reconcileAssistantOccurrences([first, second, replaced, full, unchanged, sparse]).filter(
        (entry) => entry.kind !== "runtime_notice_snapshot",
      ),
    ).toEqual([first, second]);
  });

  it("clears omitted or explicitly removed coordinates without restoring obsolete source offsets", () => {
    const first = history(1, A, "First", 20);
    const second = history(2, B, "Second", 30);
    const full = positionSnapshot(3, 2, [
      [first, "session:1"],
      [second, "session:0"],
    ]);
    expect(withoutPositionSnapshots([first, second, full])).toEqual([second, first]);
    for (const cleared of [
      positionSnapshot(4, 2, [[second, "session:2"]]),
      positionSnapshot(4, 2, [[second, "session:2"]], {
        history_positions_mode: "sparse",
        removed_history_frame_ids: [first.id],
      }),
    ]) {
      // The original row remains available; only native coordinates are replaced.
      expect(withoutPositionSnapshots([first, second, full, cleared])).toEqual([first, second]);
      const restored = positionSnapshot(5, 4, [
        [first, "session:3"],
        [second, "session:2"],
      ]);
      expect(withoutPositionSnapshots([first, second, full, cleared, restored])).toEqual([
        second,
        first,
      ]);
    }
  });

  it("applies relocation to the exact committed user twin while preserving original send delivery", () => {
    const sent = frame(
      1,
      "user_input",
      {},
      { source: { kind: "send" }, payload: { content: "Prompt" } },
    );
    const reply = history(2, A, "Reply", 1);
    const committed = frame(
      3,
      "user_input",
      {},
      {
        source: { kind: "session_history", source_cursor: "session:4" },
        status: "completed",
        payload: { message: { role: "user" }, content: "Prompt" },
      },
    );
    const relocated = positionSnapshot(4, 3, [
      [committed, "session:0"],
      [reply, "session:1"],
    ]);
    const shown = withoutPositionSnapshots([sent, reply, committed, relocated]);
    expect(shown).toEqual([sent, reply]);
    expect(shown[0]).toBe(sent);
    expect(shown[0]?.status).toBe("delivered");
    expect(shown[0]?.source).toEqual({ kind: "send" });
  });

  it("leaves rows beyond the exact snapshot frontier at their native coordinates", () => {
    const first = history(1, A, "First", 20);
    const second = history(4, B, "Second", 2);
    const relocated = positionSnapshot(5, 1, [
      [first, "session:1"],
      [second, "session:0"],
    ]);
    expect(withoutPositionSnapshots([first, second, relocated])).toEqual([first, second]);
  });

  it("does not lend history coordinates to live rows or runtime-origin notices", () => {
    const live = frame(
      1,
      "tool_execution_completed",
      {},
      {
        payload: { tool_call_id: "read", result: "Result" },
      },
    );
    const notice = frame(
      2,
      "system_notice",
      {},
      {
        source: { kind: "session_history", source_cursor: "session:1" },
        payload: { message: { role: "system_notice", runtime_origin: {}, body: "Notice" } },
      },
    );
    const answer = history(3, A, "Answer", 20);
    const relocated = positionSnapshot(4, 3, [
      [live, "session:4"],
      [notice, "session:3"],
      [answer, "session:2"],
    ]);
    expect(withoutPositionSnapshots([live, notice, answer, relocated])).toEqual([
      live,
      notice,
      answer,
    ]);
  });

  it("moves a retained tool call, result, boundary notice and answer together after compaction", () => {
    const { session, call, result, notice, answer, snapshot } = noticeCompactionFixture();
    const shown = withoutPositionSnapshots([call, result, notice, answer, snapshot]);
    expect(shown).toEqual([call, result, notice, answer]);
    expect(shown[2]).toBe(notice);
    expect(shown.at(-1)).toBe(answer);
    expect(notice.source.source_cursor).toBe(`${session}:12`);
    expect(notice.status).toBe("completed");
    expect(
      conversationActivities([call, result, notice, answer, snapshot]).findLast(
        (row) => row.kind !== "frame" || row.frame.kind !== "runtime_notice_snapshot",
      ),
    ).toMatchObject({ kind: "frame", frame: answer });
  });

  it("replaces notice positions even when canonical history positions are a sparse delta", () => {
    const { session, call, result, notice, answer, message, snapshot } = noticeCompactionFixture();
    const moved = positionSnapshot(
      6,
      4,
      [],
      {
        session_id: session,
        history_positions_mode: "sparse",
        notices: [{ offset: 0, message: { ...message, body: "Updated body" } }],
      },
      { session_id: session },
    );
    expect(withoutPositionSnapshots([call, result, notice, answer, snapshot, moved])).toEqual([
      notice,
      call,
      result,
      answer,
    ]);
    expect(notice.payload).toEqual({ message });
  });

  it("clears covered notice coordinates when the current notice image is absent or unusable", () => {
    const { session, call, result, notice, answer, message, snapshot } = noticeCompactionFixture();
    const moved = positionSnapshot(
      6,
      4,
      [],
      {
        session_id: session,
        history_positions_mode: "sparse",
        notices: [{ offset: 0, message }],
      },
      { session_id: session },
    );
    const origins = [
      { ...message.runtime_origin, session_id: A },
      { ...message.runtime_origin, run_id: "invalid" },
      { ...message.runtime_origin, input_id: "invalid" },
      { ...message.runtime_origin, append_ordinal: -1 },
      { ...message.runtime_origin, append_ordinal: 0.5 },
      { ...message.runtime_origin, append_ordinal: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const notices of [
      undefined,
      null,
      [],
      [{ offset: -1, message }],
      [{ offset: 0.5, message }],
      [{ offset: Number.MAX_SAFE_INTEGER + 1, message }],
      [{ offset: "0", message }],
      [{ offset: 0, message: { ...message, role: "user" } }],
      [
        { offset: 0, message },
        { offset: 1, message },
      ],
      ...origins.map((runtime_origin) => [{ offset: 0, message: { ...message, runtime_origin } }]),
    ]) {
      const unavailable = positionSnapshot(
        7,
        4,
        [],
        {
          session_id: session,
          history_positions_mode: "sparse",
          notices,
        },
        { session_id: session },
      );
      expect(
        withoutPositionSnapshots([call, result, notice, answer, snapshot, moved, unavailable]),
      ).toEqual([call, result, notice, answer]);
    }
  });

  it("does not match a different runtime notice attempt or ordinal by identical content", () => {
    const { session, call, result, notice, answer, message, snapshot } = noticeCompactionFixture();
    for (const runtime_origin of [
      { ...message.runtime_origin, run_id: B },
      { ...message.runtime_origin, input_id: A },
      { ...message.runtime_origin, append_ordinal: 1 },
    ]) {
      const different = positionSnapshot(
        6,
        4,
        [],
        {
          session_id: session,
          history_positions_mode: "sparse",
          notices: [{ offset: 0, message: { ...message, runtime_origin } }],
        },
        { session_id: session },
      );
      expect(withoutPositionSnapshots([call, result, notice, answer, snapshot, different])).toEqual(
        [call, result, notice, answer],
      );
    }
  });

  it("leaves boundary notices beyond the snapshot frontier at their original position", () => {
    const { session, call, result, notice, answer, message } = noticeCompactionFixture();
    const beforeNotice = positionSnapshot(
      5,
      2,
      [
        [call, `${session}:1:tool-call:0`],
        [result, `${session}:2:0`],
      ],
      {
        session_id: session,
        notices: [{ offset: 14, message }],
      },
      { session_id: session },
    );
    expect(withoutPositionSnapshots([call, result, notice, answer, beforeNotice])).toEqual([
      call,
      result,
      notice,
      answer,
    ]);
  });

  it("rejects malformed, redacted or foreign relocation metadata and keeps the last valid map", () => {
    const first = history(1, A, "First", 20);
    const second = history(2, B, "Second", 30);
    const previous = positionSnapshot(3, 2, [
      [first, "session:2"],
      [second, "session:1"],
    ]);
    const newest = positionSnapshot(5, 2, [
      [first, "session:0"],
      [second, "session:1"],
    ]);
    const payload = newest.payload as Record<string, unknown>;
    const cases: ConsoleFrame[] = [
      { ...newest, payload: { ...payload, complete: false } },
      { ...newest, payload: { ...payload, observed_through: "console:6" } },
      { ...newest, payload: { ...payload, observed_through: "invalid" } },
      { ...newest, payload: { ...payload, session_id: "foreign" } },
      { ...newest, payload: { ...payload, history_positions_mode: "unknown" } },
      {
        ...newest,
        payload: {
          ...payload,
          history_positions: [{ frame_id: first.id, source_cursor: "foreign:0" }],
        },
      },
      {
        ...newest,
        payload: {
          ...payload,
          history_positions: [{ frame_id: first.id, source_cursor: "session:0:unknown" }],
        },
      },
      {
        ...newest,
        payload: {
          ...payload,
          history_positions: [
            { frame_id: first.id, source_cursor: "session:18446744073709551616" },
          ],
        },
      },
      {
        ...newest,
        payload: {
          ...payload,
          history_positions: [
            { frame_id: first.id, source_cursor: "session:0" },
            { frame_id: first.id, source_cursor: "session:1" },
          ],
        },
      },
      { ...newest, payload: { ...payload, removed_history_frame_ids: [1] } },
      { ...newest, status: "redacted" },
      { ...newest, status: "delivery_failed" },
      { ...newest, source: { kind: "console_event" } },
      { ...newest, runtime_key: "foreign" },
      { ...newest, identity: "foreign" },
      { ...newest, session_id: "foreign", payload: { ...payload, session_id: "foreign" } },
      { ...newest, cursor: "invalid" },
    ];
    for (const invalid of cases) {
      expect(withoutPositionSnapshots([first, second, previous, invalid])).toEqual([second, first]);
    }
  });

  it("scopes inherited IDs by runtime, agent identity and session", () => {
    const shown = conversationFrames([
      history(1),
      { ...history(2), runtime_key: "other-runtime" },
      { ...history(3), identity: "other-agent" },
      { ...history(4), session_id: "fork-session" },
    ]);
    expect(shown).toHaveLength(4);
    expect(new Set(conversationActivities(shown).map((item) => item.id)).size).toBe(4);
  });

  it("uses only a complete same-session snapshot and only its covered cursor prefix", () => {
    const shown = conversationFrames([
      frame(1, "text_delta", { delta: "abandoned" }),
      frame(2, "text_delta", { assistant_message_id: B, delta: "retained, history page missing" }),
      frame(3, "text_delta", { delta: "other session" }, { session_id: "other" }),
      snapshot(5, 3, [B]),
      frame(6, "text_delta", { delta: "after frontier" }),
    ]);
    expect(shown.map((item) => frameText(item.payload))).toEqual([
      "retained, history page missing",
      "other session",
      "after frontier",
    ]);
    expect(shown.some((item) => item.kind === "assistant_history_snapshot")).toBe(false);
  });

  it("retires covered old canonical rows when a later exact snapshot removes them", () => {
    expect(
      conversationFrames([history(1), snapshot(2, 1, [A]), snapshot(4, 3, []), history(5, B)]).map(
        (item) => item.id,
      ),
    ).toEqual(["frame-5"]);
  });

  it("does not infer missing IDs from partial, malformed, redacted or foreign snapshots", () => {
    const text = frame(1, "text_delta", { delta: "keep" });
    const valid = snapshot(3, 1, []);
    const cases = [
      { ...valid, payload: { ...(valid.payload as object), complete: false } },
      { ...valid, payload: { ...(valid.payload as object), assistant_message_ids: ["invalid"] } },
      { ...valid, payload: { ...(valid.payload as object), observed_through: "console:9" } },
      { ...valid, payload: { ...(valid.payload as object), session_id: "foreign" } },
      { ...valid, status: "redacted" as const },
      { ...valid, source: { kind: "console_event" as const } },
      { ...valid, runtime_key: "foreign" },
      { ...valid, identity: "foreign" },
      { ...valid, cursor: "malformed" },
    ];
    for (const invalid of cases) expect(conversationFrames([text, invalid])).toEqual([text]);
  });

  it("falls back to the previous valid snapshot when newer candidates are unusable", () => {
    const removed = frame(1, "text_delta", { delta: "removed" });
    const retained = frame(2, "text_delta", { assistant_message_id: B, delta: "retained" });
    const previous = snapshot(3, 2, [B]);
    const newest = snapshot(5, 4, []);
    const cases = [
      { ...newest, payload: { ...(newest.payload as object), complete: false } },
      { ...newest, payload: { ...(newest.payload as object), assistant_message_ids: ["invalid"] } },
      { ...newest, payload: { ...(newest.payload as object), observed_through: "console:9" } },
      { ...newest, payload: { ...(newest.payload as object), session_id: "foreign" } },
      { ...newest, status: "redacted" as const },
      { ...newest, source: { kind: "console_event" as const } },
      { ...newest, runtime_key: "foreign" },
      { ...newest, identity: "foreign" },
      {
        ...newest,
        session_id: "foreign",
        payload: { ...(newest.payload as object), session_id: "foreign" },
      },
      { ...newest, cursor: "malformed" },
    ];
    for (const invalid of cases)
      expect(conversationFrames([removed, retained, previous, invalid])).toEqual([retained]);
  });

  it("does not read ID arrays from snapshots superseded in the same exact scope", () => {
    let reads = 0;
    const snapshots = Array.from({ length: 1000 }, (_, index) => {
      const entry = snapshot(index + 2, 1, [A]);
      return {
        ...entry,
        payload: {
          ...(entry.payload as object),
          get assistant_message_ids() {
            reads++;
            return [A];
          },
        },
      };
    });
    const text = frame(1, "text_delta", { delta: "kept" });
    expect(conversationFrames([text, ...snapshots])).toEqual([text]);
    expect(reads).toBe(1);
  });

  it("selects snapshots by cursor without depending on input position", () => {
    const text = frame(1, "text_delta", { delta: "removed" });
    expect(reconcileAssistantOccurrences([text, snapshot(5, 4, []), snapshot(3, 2, [A])])).toEqual(
      [],
    );
  });

  it("does not promote an invalid or sessionless ID to text-based identity", () => {
    for (const value of ["not-an-id", null, 7, A]) {
      const extra = value === A ? { session_id: undefined } : {};
      const delta = frame(1, "text_delta", { assistant_message_id: value, delta: "Same" }, extra);
      const complete = frame(
        2,
        "text_complete",
        { assistant_message_id: value, text: "Same" },
        extra,
      );
      expect(conversationFrames([delta, complete])).toEqual([delta, complete]);
      expect(conversationActivities([delta, complete]).map((item) => item.id)).toEqual([
        "frame-1",
        "frame-2",
      ]);
    }
  });

  it("keeps ID-less output separate from an identified equal-text message", () => {
    const old = frame(1, "text_complete", {}, { payload: { text: "Answer" } });
    expect(conversationFrames([old, history(2)])).toEqual([old, history(2)]);
  });

  it("keeps malformed rich carriers visible without aliasing the assistant row key", () => {
    const malformed = frame(
      1,
      "assistant_message",
      {
        message: { role: "block_assistant", assistant_message_id: B, blocks: [] },
      },
      { source: { kind: "session_history" } },
    );
    const delta = frame(2, "text_delta", { delta: "valid stream" });
    const activities = conversationActivities([malformed, delta]);
    expect(activities).toHaveLength(2);
    expect(new Set(activities.map((item) => item.id)).size).toBe(2);
    expect(canonicalAssistantMessage(malformed)).toBeUndefined();
  });

  it("keeps rich canonical blocks and independent tool siblings", () => {
    const rich = frame(
      5,
      "assistant_message",
      {
        message: {
          role: "block_assistant",
          assistant_message_id: A,
          blocks: [
            { block_type: "reasoning", data: { text: "reasoning" } },
            {
              block_type: "tool_use",
              data: { id: "call", name: "shell", args: { command: "ls" } },
            },
            {
              block_type: "image",
              data: { blob_ref: { blob_id: `sha256:${"a".repeat(64)}`, media_type: "image/png" } },
            },
          ],
        },
      },
      { source: { kind: "session_history" } },
    );
    const tool = frame(
      6,
      "tool_call_requested",
      { id: "call", name: "shell" },
      {
        source: { kind: "session_history" },
      },
    );
    const shown = conversationFrames([
      frame(1, "reasoning_complete", { content: "provisional" }),
      frame(2, "assistant_image_appended", { image: {} }),
      rich,
      tool,
    ]);
    expect(shown).toEqual([rich, tool]);
    expect(
      savedMessageView(canonicalAssistantMessage(rich), "Agent")?.parts.map((part) => part.kind),
    ).toEqual(["reasoning", "tool", "image"]);
  });

  it("preserves repeated provider tool IDs and hidden native run boundaries", () => {
    const tool = (seq: number, kind: string) =>
      frame(
        seq,
        kind,
        {},
        {
          payload: { tool_call_id: "reused", name: "shell" },
          interaction_id: undefined,
        },
      );
    const shown = conversationActivities([
      tool(1, "tool_execution_completed"),
      history(2),
      frame(3, "interaction_complete", { result: "Answer" }),
      tool(4, "tool_execution_completed"),
      frame(5, "tool_call_requested", { tool_call_id: "reused", name: "shell" }),
      frame(6, "tool_call_requested", {
        assistant_message_id: B,
        tool_call_id: "reused",
        name: "shell",
      }),
    ]);
    expect(
      shown
        .filter((item) => item.kind === "tool")
        .map((item) => item.frames.map((entry) => entry.id)),
    ).toEqual([["frame-1"], ["frame-4"], ["frame-5"], ["frame-6"]]);
  });
});

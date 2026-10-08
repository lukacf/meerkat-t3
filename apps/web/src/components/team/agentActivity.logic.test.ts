import { describe, expect, it } from "vite-plus/test";
import type { ConsoleFrame } from "@t3tools/contracts";
import {
  conversationActivities,
  conversationFrames,
  frameText,
  mergeActivityFrames,
} from "./agentActivity.logic";
const frame = (
  id: string,
  kind: string,
  payload: unknown,
  extra: Partial<ConsoleFrame> = {},
): ConsoleFrame => ({
  id,
  cursor: id,
  dedupe_key: id,
  timestamp_ms: 1,
  runtime_key: "runtime",
  identity: "agent",
  kind,
  status: "completed",
  frame_version: 1,
  payload,
  source: { kind: "console_event" },
  session_id: "session",
  interaction_id: "turn-1",
  ...extra,
});
describe("native agent conversation presentation", () => {
  it("renders four native tool stages as one activity with structured output and explicit completion", () => {
    const call = { tool_call_id: "shell-one", name: "shell" };
    const frames = [
      frame(
        "request",
        "tool_call_requested",
        { ...call, args: { command: "cat src/catalog.ts" } },
        { status: "delivered" },
      ),
      frame("start", "tool_execution_started", call, { status: "delivered" }),
      frame(
        "complete",
        "tool_execution_completed",
        {
          ...call,
          is_error: false,
          content: [
            {
              type: "structured",
              data: { stdout: "export const catalog = [];", stderr: "", exit_code: 0 },
            },
          ],
        },
        { status: "delivered" },
      ),
      frame(
        "result",
        "tool_result_received",
        { ...call, is_error: false },
        { status: "delivered" },
      ),
    ];
    const shown = conversationActivities(frames);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      kind: "tool",
      label: "Shell",
      status: "Completed",
      input: "cat src/catalog.ts",
      output: "export const catalog = [];",
      frames,
    });
    expect(conversationActivities(frames.slice(0, 1))[0]).toMatchObject({ status: "Requested" });
    expect(conversationActivities(frames.slice(0, 2))[0]).toMatchObject({ status: "Running" });
    expect(frames.map((entry) => entry.status)).toEqual([
      "delivered",
      "delivered",
      "delivered",
      "delivered",
    ]);
  });
  it("keeps parallel calls, repeated requests and separate sessions or turns distinct", () => {
    const tool = (id: string, kind: string, call: string, extra: Partial<ConsoleFrame> = {}) =>
      frame(id, kind, { tool_call_id: call, name: "shell" }, extra);
    const shown = conversationActivities([
      tool("a", "tool_call_requested", "one"),
      tool("b", "tool_call_requested", "two"),
      tool("b-done", "tool_execution_completed", "two"),
      tool("a-done", "tool_execution_completed", "one"),
      tool("repeat", "tool_call_requested", "one"),
      tool("repeat-done", "tool_execution_completed", "one"),
      tool("session", "tool_execution_started", "one", { session_id: "another" }),
      tool("turn", "tool_execution_started", "one", { interaction_id: "turn-2" }),
    ]);
    expect(
      shown
        .filter((item) => item.kind === "tool")
        .map((item) => item.frames.map((entry) => entry.id)),
    ).toEqual([["a", "a-done"], ["b", "b-done"], ["repeat", "repeat-done"], ["session"], ["turn"]]);
  });
  it("retains typed tool failures and does not infer success or failure from prose", () => {
    const call = { tool_call_id: "one", name: "shell" };
    expect(
      conversationActivities([
        frame("failed", "tool_execution_completed", {
          ...call,
          is_error: true,
          error: "Permission denied",
        }),
        frame("received", "tool_result_received", { ...call, is_error: false }),
      ])[0],
    ).toMatchObject({ kind: "tool", status: "Failed", output: "Permission denied" });
    expect(
      conversationActivities([
        frame("exit", "tool_execution_completed", {
          ...call,
          content: [{ type: "structured", data: { exit_code: 2, stderr: "Invalid option" } }],
        }),
      ])[0],
    ).toMatchObject({ kind: "tool", status: "Failed", output: "Invalid option" });
    expect(
      conversationActivities([
        frame("start", "tool_execution_started", { ...call, result: "Completed successfully" }),
      ])[0],
    ).toMatchObject({ kind: "tool", status: "Running" });
    const stopped = frame("stop", "interaction_failed", { error_report: { class: "cancelled" } });
    expect(conversationActivities([stopped])[0]).toMatchObject({ kind: "frame", frame: stopped });
  });
  it("keeps calls with missing interaction ids separate across user turns and keeps uncorrelatable stages visible", () => {
    const worker = { interaction_id: undefined, session_id: undefined };
    const shown = conversationActivities([
      frame("first", "tool_execution_completed", { tool_call_id: "reused", name: "shell" }, worker),
      frame("next-input", "user_input", { text: "Next task" }, worker),
      frame(
        "second",
        "tool_execution_completed",
        { tool_call_id: "reused", name: "shell" },
        worker,
      ),
      frame("missing-id", "tool_execution_started", { name: "shell" }, worker),
    ]);
    expect(shown.map((activity) => activity.id)).toEqual([
      "first",
      "next-input",
      "second",
      "missing-id",
    ]);
    expect(shown.at(-1)?.kind).toBe("frame");
  });
  it("reads native block content without treating arbitrary objects as human text", () => {
    expect(
      frameText({
        content: [
          { type: "text", text: "hello" },
          { type: "image", source: {} },
          { type: "text", text: "world" },
        ],
      }),
    ).toBe("hello\nworld");
    expect(frameText({ result: { secret: "object" } })).toBeNull();
  });
  it("replaces deltas and an identical final fragment with the same interaction's canonical answer", () => {
    const frames = [
      frame("delta", "text_delta", { delta: "Answer" }),
      frame("text", "text_complete", { text: "Answer" }),
      frame("done", "interaction_complete", { result: "Answer" }),
    ];
    expect(conversationFrames(frames).map((entry) => entry.id)).toEqual(["done"]);
  });
  it("preserves distinct tool-step text and other sessions, without allowing steering acknowledgements to erase text", () => {
    const frames = [
      frame("step", "text_complete", { text: "Checking..." }),
      frame("other", "text_complete", { text: "Answer" }, { session_id: "another" }),
      frame("done", "interaction_complete", { result: "Answer" }),
      frame("steer", "interaction_complete", { reason: "steer_delivered" }),
      frame("next", "text_delta", { delta: "Working" }, { interaction_id: "turn-2" }),
    ];
    expect(conversationFrames(frames).map((entry) => entry.id)).toEqual([
      "step",
      "other",
      "done",
      "steer",
      "next",
    ]);
  });
  it("deduplicates native text events without a session id against the terminal for the same interaction", () => {
    expect(
      conversationFrames([
        frame("start", "run_started", {}),
        frame("text", "text_complete", { content: "SAVED" }, { session_id: undefined }),
        frame("turn", "turn_completed", { stop_reason: "end_turn" }),
        frame("done", "interaction_complete", { result: "SAVED" }),
      ]).map((entry) => entry.id),
    ).toEqual(["done"]);
  });
  it("merges overlapping history pages in native append order and retains updated delivery status", () => {
    const older = frame("older", "user_input", { text: "old" }, { cursor: "console:2" });
    const middle = frame("middle", "text_complete", { text: "middle" }, { cursor: "console:9" });
    const newest = frame(
      "newest",
      "user_input",
      { text: "new" },
      { cursor: "console:10", status: "accepted" },
    );
    expect(
      mergeActivityFrames([
        older,
        newest,
        middle,
        { ...newest, frame_version: 2, status: "delivered" },
      ]).map((item) => [item.id, item.status]),
    ).toEqual([
      ["older", "completed"],
      ["middle", "completed"],
      ["newest", "delivered"],
    ]);
  });
  it("collapses worker stream and terminal text without interaction ids while preserving repeated replies", () => {
    const worker = { interaction_id: undefined, session_id: undefined };
    const shown = conversationFrames([
      frame("a", "text_delta", { delta: "Checking" }, worker),
      frame("b", "text_complete", { content: "Checking" }, worker),
      frame("tool", "tool_execution_completed", { result: "file contents" }, worker),
      frame("c", "text_delta", { delta: "Do" }, worker),
      frame("d", "text_delta", { delta: "ne" }, worker),
      frame("e", "text_complete", { content: "Done" }, worker),
      frame("turn", "turn_completed", {}, worker),
      frame("f", "interaction_complete", { result: "Done" }, worker),
      frame("input", "user_input", { content: "Again" }, worker),
      frame("repeat", "text_complete", { content: "Done" }, worker),
    ]);
    expect(shown.map((entry) => entry.id)).toEqual(["b", "tool", "f", "input", "repeat"]);
  });
  it("joins adjacent streaming fragments but keeps separate tool steps and sessions", () => {
    const frames = [
      frame("a", "text_delta", { delta: "Hello " }),
      frame("b", "text_delta", { delta: "world" }),
      frame("tool", "tool_call", { name: "read_file" }),
      frame("c", "text_delta", { delta: "Next" }),
      frame("d", "text_delta", { delta: "Other" }, { session_id: "other" }),
    ];
    const shown = conversationFrames(frames);
    expect(shown.map((entry) => entry.id)).toEqual(["a", "tool", "c", "d"]);
    expect(frameText(shown[0]!.payload)).toBe("Hello world");
  });
  it("does not hide a later streaming step behind an earlier completed step", () => {
    const frames = [
      frame("first", "text_complete", { text: "Checking" }),
      frame("tool", "tool_call", { name: "read_file" }),
      frame("next", "text_delta", { delta: "Found" }),
    ];
    expect(conversationFrames(frames).map((entry) => entry.id)).toEqual(["first", "tool", "next"]);
  });
  it("keeps delivery failure and the highest native frame version", () => {
    const frames = [
      frame("input", "user_input", { content: "Task" }, { status: "accepted" }),
      frame(
        "input",
        "user_input",
        { content: "Task" },
        { status: "delivery_failed", frame_version: 3 },
      ),
      frame("input", "user_input", { content: "Task" }, { status: "delivered", frame_version: 2 }),
    ];
    expect(conversationFrames(frames)).toHaveLength(1);
    expect(conversationFrames(frames)[0]!.status).toBe("delivery_failed");
  });
});

describe("long-lived native conversation isolation", () => {
  it("matches sessionless terminals within their identity and interaction only", () => {
    const shown = conversationFrames([
      frame("a-stream", "text_delta", { delta: "A" }, { session_id: "a" }),
      frame("b-answer", "text_complete", { text: "B" }, { session_id: "b" }),
      frame("a-done", "interaction_complete", { result: "A" }, { session_id: "a" }),
      frame("b-done", "interaction_complete", { result: "B" }, { session_id: undefined }),
      frame("other-agent", "text_delta", { delta: "Independent" }, { identity: "other" }),
      frame("other-turn", "text_delta", { delta: "Still writing" }, { interaction_id: "turn-2" }),
      frame("empty-terminal", "interaction_complete", { reason: "steer_delivered" }),
    ]);
    expect(shown.map((entry) => entry.id)).toEqual([
      "a-done",
      "b-done",
      "other-agent",
      "other-turn",
      "empty-terminal",
    ]);
  });

  it("retains one completed answer per native input across many days of overlapping history", () => {
    const history = Array.from({ length: 2_500 }, (_, turn) => {
      const metadata = { interaction_id: `review-${turn}`, session_id: `reviewer-${turn % 3}` };
      const text = `Review ${turn} complete`;
      return [
        frame(`input-${turn}`, "user_input", { text: `Review ${turn}` }, metadata),
        frame(`delta-${turn}`, "text_delta", { delta: "Reviewing" }, metadata),
        frame(`text-${turn}`, "text_complete", { text }, metadata),
        frame(`done-${turn}`, "interaction_complete", { result: text }, metadata),
      ].map((entry, step) => ({ ...entry, cursor: `console:${turn * 4 + step}` }));
    }).flat();
    const shown = conversationFrames([...history.slice(500), ...history]);
    expect(shown).toHaveLength(5_000);
    expect(shown.filter((entry) => entry.kind === "interaction_complete")).toHaveLength(2_500);
    expect(shown[0]?.id).toBe("input-0");
    expect(shown.at(-1)?.id).toBe("done-2499");
  });
});

describe("native user input occurrence reconciliation", () => {
  const send = (id: string, extra: Partial<ConsoleFrame> = {}) =>
    frame(
      id,
      "user_input",
      { content: "Review this change", handling_mode: "queue" },
      {
        source: { kind: "send" },
        status: "delivered",
        ...extra,
      },
    );
  const history = (id: string, extra: Partial<ConsoleFrame> = {}) =>
    frame(
      id,
      "user_input",
      {
        content: [{ type: "text", text: "Review this change" }],
        message: { role: "user", content: "Review this change" },
      },
      {
        source: { kind: "session_history" },
        ...extra,
      },
    );
  const emptyNotice = (extra: Partial<ConsoleFrame> = {}) =>
    frame(
      "notice",
      "runtime_notice_snapshot",
      {
        complete: true,
        session_id: "session",
        observed_through: "console:76",
        history_positions: [],
        notices: [],
        settled_attempts: [],
      },
      { source: { kind: "session_history" }, ...extra },
    );

  it("keeps one input in its original position when committed history arrives after the answer", () => {
    const input = send("sent", { cursor: "console:2", frame_version: 3 });
    const answer = frame(
      "answer",
      "text_complete",
      { content: "Review complete" },
      {
        cursor: "console:77",
      },
    );
    const notice = emptyNotice({ cursor: "console:78" });
    const committed = history("saved", { cursor: "console:81", run_id: "native-run" });
    const frames = [input, answer, notice, committed];

    expect(conversationFrames(frames)).toEqual([input, answer]);
    expect(conversationActivities(frames).map((item) => item.id)).toEqual(["sent", "answer"]);
    expect(conversationActivities([input])[0]?.id).toBe(conversationActivities(frames)[0]?.id);
    expect(conversationFrames(frames)[0]).toBe(input);
    expect(conversationFrames(frames)[0]?.status).toBe("delivered");
    expect(mergeActivityFrames(frames)).toEqual(frames);
  });

  it("retains identical user text sent in separate native interactions", () => {
    const first = send("first", { interaction_id: "first-interaction", cursor: "console:1" });
    const second = send("second", { interaction_id: "second-interaction", cursor: "console:4" });
    const frames = [
      first,
      history("first-saved", { interaction_id: "first-interaction", cursor: "console:3" }),
      second,
      history("second-saved", { interaction_id: "second-interaction", cursor: "console:6" }),
    ];
    expect(conversationFrames(frames)).toEqual([first, second]);
  });

  it("requires exact runtime, agent, session, and interaction identity without content matching", () => {
    const input = send("sent");
    const mismatches: Partial<ConsoleFrame>[] = [
      { runtime_key: "different-runtime" },
      { identity: "different-agent" },
      { session_id: "different-session" },
      { interaction_id: "different-interaction" },
      { session_id: undefined },
      { interaction_id: undefined },
      { interaction_id: "" },
      { source: { kind: "console_event" } },
    ];
    for (const mismatch of mismatches) {
      const unrelated = history("saved", mismatch);
      expect(conversationFrames([input, unrelated])).toEqual([input, unrelated]);
    }
    const differentText = history("saved", {
      payload: { content: "Committed representation", message: { role: "user" } },
    });
    expect(conversationFrames([input, differentText])).toEqual([input]);
  });

  it("keeps standalone history and ambiguous multiple inputs rather than guessing a twin", () => {
    const first = send("first");
    const second = send("second");
    const saved = history("saved");
    const otherSaved = history("other-saved");
    expect(conversationFrames([saved])).toEqual([saved]);
    expect(conversationFrames([first, second, saved])).toEqual([first, second, saved]);
    expect(conversationFrames([first, saved, otherSaved])).toEqual([first, saved, otherSaved]);
  });

  it("preserves pending, failed, redacted, and malformed records with their native statuses", () => {
    const saved = history("saved");
    for (const status of ["accepted", "dispatching", "delivery_failed", "redacted"] as const) {
      const input = send("sent", { status });
      expect(conversationFrames([input, saved])).toEqual([input, saved]);
    }
    const input = send("sent");
    for (const altered of [
      history("saved", { status: "redacted" }),
      history("saved", { status: "delivery_failed" }),
      history("saved", { payload: { content: "No canonical role" } }),
    ])
      expect(conversationFrames([input, altered])).toEqual([input, altered]);
  });

  it("reconciles overlapping pages only after choosing the latest native delivery revision", () => {
    const accepted = send("sent", { status: "accepted", frame_version: 1 });
    const delivered = send("sent", { status: "delivered", frame_version: 3 });
    const saved = history("saved");
    expect(conversationFrames([delivered, saved, accepted, saved])).toEqual([delivered]);
    const failed = send("sent", { status: "delivery_failed", frame_version: 4 });
    expect(conversationFrames([delivered, saved, failed])).toEqual([failed, saved]);
  });

  it("hides only an empty completed runtime notice snapshot in the normal projection", () => {
    const empty = emptyNotice();
    expect(conversationFrames([empty])).toEqual([]);
    expect(conversationActivities([empty])).toEqual([]);
    expect(mergeActivityFrames([empty])).toEqual([empty]);
    const payload = empty.payload as Record<string, unknown>;
    const meaningful = [
      emptyNotice({
        payload: { ...payload, notices: [{ type: "auth", body: "Sign in required" }] },
      }),
      emptyNotice({ payload: { ...payload, history_positions: [4] } }),
      emptyNotice({ payload: { ...payload, settled_attempts: ["attempt"] } }),
      emptyNotice({ payload: { ...payload, complete: false } }),
      emptyNotice({ payload: { ...payload, session_id: "another" } }),
      emptyNotice({ payload: { ...payload, notices: null } }),
      emptyNotice({ payload: { ...payload, body: "Attention needed" } }),
      emptyNotice({ status: "delivery_failed" }),
      emptyNotice({ status: "redacted" }),
      emptyNotice({ source: { kind: "console_event" } }),
    ];
    for (const notice of meaningful) expect(conversationFrames([notice])).toEqual([notice]);
  });
});

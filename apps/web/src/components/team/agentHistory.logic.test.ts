import type { ConsoleFrame } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { advanceAgentHistory, INITIAL_AGENT_HISTORY } from "./agentHistory.logic";
import { mergeActivityFrames } from "./agentActivity.logic";

const frame = (id: string, cursor: string, version = 1): ConsoleFrame => ({
  id,
  cursor,
  dedupe_key: id,
  timestamp_ms: 1,
  runtime_key: "runtime",
  identity: "agent",
  kind: "text_complete",
  status: "completed",
  frame_version: version,
  payload: { text: id },
  source: { kind: "console_event" },
});

describe("agent full-history progress", () => {
  it("loads from the beginning and merges with an exhausted recent preview without losing newer frame versions", () => {
    const recent = {
      frames: [frame("last", "console:629", 2), frame("anchor", "console:1", 2)],
      exhausted: true,
      next_cursor: "console:629",
    };
    expect(INITIAL_AGENT_HISTORY).toMatchObject({
      started: false,
      after: undefined,
      exhausted: false,
    });
    const first = {
      frames: [frame("anchor", "console:1"), frame("middle", "console:100")],
      next_cursor: "opaque-forward-100",
      exhausted: false,
    };
    const progress = advanceAgentHistory(INITIAL_AGENT_HISTORY, first);
    expect(progress).toMatchObject({
      started: true,
      after: "opaque-forward-100",
      exhausted: false,
    });
    expect(
      mergeActivityFrames([...recent.frames, ...first.frames]).map((entry) => [
        entry.id,
        entry.frame_version,
      ]),
    ).toEqual([
      ["anchor", 2],
      ["middle", 1],
      ["last", 2],
    ]);
    const last = advanceAgentHistory(progress, {
      frames: [recent.frames[0]!],
      next_cursor: "opaque-forward-629",
      exhausted: true,
    });
    expect(last.exhausted).toBe(true);
  });
  it("continues over filtered empty pages with forward progress and stops on repeated or missing cursors", () => {
    const first = advanceAgentHistory(INITIAL_AGENT_HISTORY, {
      frames: [],
      next_cursor: "a",
      exhausted: false,
    });
    expect(first.exhausted).toBe(false);
    const second = advanceAgentHistory(first, { frames: [], next_cursor: "b", exhausted: false });
    expect(second.exhausted).toBe(false);
    expect(
      advanceAgentHistory(second, { frames: [], next_cursor: "b", exhausted: false }).exhausted,
    ).toBe(true);
    expect(
      advanceAgentHistory(second, { frames: [], next_cursor: "a", exhausted: false }).exhausted,
    ).toBe(true);
    expect(advanceAgentHistory(second, { frames: [], exhausted: false }).exhausted).toBe(true);
  });
});

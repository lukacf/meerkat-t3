import type { ConsoleFrame } from "@t3tools/contracts";
import { bench, describe } from "vite-plus/test";
import { conversationActivities } from "./agentActivity.logic";

function multiDayHistory(turns: number): ConsoleFrame[] {
  return Array.from({ length: turns }, (_, turn) => {
    const text = `Review ${turn}: findings and file references.`;
    const events = [
      ["user_input", { text: `Review change ${turn}` }],
      ["text_delta", { delta: "Inspecting " }],
      ["text_delta", { delta: "the implementation" }],
      ["text_complete", { text: "Checking source and tests." }],
      [
        "tool_call_requested",
        { tool_call_id: `shell-${turn}`, name: "shell", args: { command: "git diff --check" } },
      ],
      [
        "tool_execution_completed",
        { tool_call_id: `shell-${turn}`, name: "shell", result: "Checks passed" },
      ],
      ["text_complete", { text }],
      ["interaction_complete", { result: text }],
    ] as const;
    return events.map(([kind, payload], step) => ({
      id: `frame-${turn}-${step}`,
      cursor: `console:${turn * events.length + step}`,
      dedupe_key: `frame-${turn}-${step}`,
      timestamp_ms: 1_790_000_000_000 + turn * 60_000 + step,
      runtime_key: "project-runtime",
      identity: "reviewer",
      session_id: "persistent-reviewer",
      interaction_id: `review-${turn}`,
      turn_id: `turn-${turn}`,
      frame_version: 1,
      status: "completed" as const,
      source: { kind: "console_event" as const },
      kind,
      payload,
    }));
  }).flat();
}

const recent = multiDayHistory(125);
const multiDay = multiDayHistory(2_500);

describe("native project-agent history", () => {
  bench("render activity model for 1,000 recent native frames", () => {
    conversationActivities(recent);
  });
  bench("render activity model for 20,000 native frames over 2,500 inputs", () => {
    conversationActivities(multiDay);
  });
});

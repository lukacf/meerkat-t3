import { describe, expect, it } from "vite-plus/test";
import type { ConsoleFrame, ConsoleIdentityRecord } from "@t3tools/contracts";
import { nativeWorkCompletion } from "./MeerkatWork.ts";
const record: ConsoleIdentityRecord = {
  identity: "worker",
  display_name: "Worker",
  runtime_key: "default",
  runtime_member_id: "member",
  session_id: "session",
  visibility: "addressable",
  addressable: true,
  health: "ready",
  labels: {},
};
const frame = (kind: string, overrides: Partial<ConsoleFrame> = {}): ConsoleFrame => ({
  id: "frame",
  cursor: "console:1",
  dedupe_key: "event",
  timestamp_ms: 100,
  runtime_key: "default",
  identity: "worker",
  session_id: "session",
  interaction_id: "native-interaction",
  kind,
  status: "completed",
  frame_version: 1,
  source: { kind: "console_event" },
  payload: {},
  ...overrides,
});
describe("nativeWorkCompletion", () => {
  it("only reports terminal native interactions, never tools or foreign sessions", () => {
    expect(
      nativeWorkCompletion(
        [
          frame("tool_call_completed"),
          frame("interaction_complete", { payload: { source_event_type: "session_history" } }),
          frame("interaction_complete", { payload: { type: "session_history" } }),
          frame("interaction_complete", {
            payload: { reason: "steer_delivered", handling_mode: "steer" },
          }),
          frame("interaction_complete", { session_id: "other" }),
          frame("interaction_complete", { interaction_id: undefined }),
        ],
        record,
      ),
    ).toBeUndefined();
    expect(
      nativeWorkCompletion(
        [
          frame("interaction_complete"),
          frame("interaction_failed", { interaction_id: "failed", timestamp_ms: 200 }),
        ],
        record,
      ),
    ).toEqual({ interactionId: "failed", status: "failed", timestampMs: 200 });
  });
});

import type { ConsoleFrame } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import frames from "./nativeToolInvocations.fixture.json";
import { conversationActivities } from "./agentActivity.logic";
import { nativeToolInvocations } from "./nativeToolInvocations";

// Captured from the packaged native preview fixture. The same call appears in
// live lifecycle, committed assistant block, request and result records.
const native = frames as ConsoleFrame[];

it("shows one completed invocation for the packaged native call and retains every display record", () => {
  const activities = conversationActivities(native);
  const displayed = nativeToolInvocations(activities);
  expect(activities).toHaveLength(4);
  expect(displayed).toHaveLength(1);
  expect(displayed[0]!.activity).toMatchObject({
    kind: "tool",
    label: "Preview status",
    status: "Completed",
  });
  expect(displayed[0]!.records).toEqual(activities);
});

it("does not merge separate native runs that reuse the same call ID", () => {
  const later = native.map((frame) => ({
    ...frame,
    id: `later:${frame.id}`,
    cursor: `console:${Number(frame.cursor.split(":")[1]) + 500}`,
    run_id: frame.run_id ? "later-run" : undefined,
    interaction_id: frame.interaction_id ? "later-input" : undefined,
    source: {
      ...frame.source,
      source_cursor: frame.source.source_cursor?.replace(":33", ":53").replace(":34", ":54"),
    },
  }));
  const displayed = nativeToolInvocations(conversationActivities([...native, ...later]));
  expect(displayed).toHaveLength(2);
  expect(displayed.map((row) => row.activity)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ status: "Completed" }),
      expect.objectContaining({ status: "Completed" }),
    ]),
  );
});

it("leaves ambiguous repeated requests inspectable instead of choosing a matching live call", () => {
  const request = native[0]!;
  const second = {
    ...request,
    id: "second-request",
    cursor: "console:9999",
    timestamp_ms: request.timestamp_ms + 1,
  };
  const activities = conversationActivities([...native, second]);
  const displayed = nativeToolInvocations(activities);
  expect(displayed.length).toBeGreaterThan(1);
  expect(
    displayed
      .flatMap((row) => row.records)
      .map((row) => row.id)
      .sort(),
  ).toEqual(activities.map((row) => row.id).sort());
});

it("does not join a missing or contradictory result lineage using only a call ID", () => {
  const moved = native.map((frame) =>
    frame.source.source_cursor?.endsWith(":34:0")
      ? { ...frame, run_id: "unrelated-run", interaction_id: "unrelated-input" }
      : frame,
  );
  expect(nativeToolInvocations(conversationActivities(moved))).toHaveLength(2);
  const missing = native.filter((frame) => !frame.source.source_cursor?.includes(":33:tool-call:"));
  expect(nativeToolInvocations(conversationActivities(missing)).length).toBeGreaterThan(1);
});

it("keeps failures visible even when another witness reports completion", () => {
  const failed = native.map((frame) =>
    frame.kind === "tool_execution_completed" && frame.source.kind === "console_event"
      ? {
          ...frame,
          kind: "tool_execution_failed",
          payload: { ...(frame.payload as object), is_error: true, error: "Access revoked" },
        }
      : frame,
  );
  expect(nativeToolInvocations(conversationActivities(failed))[0]!.activity).toMatchObject({
    status: "Failed",
    output: "Access revoked",
  });
});

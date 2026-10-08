import type { ConsoleFrame } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { conversationActivities, type ConversationActivity } from "./agentActivity.logic";
import questionFrames from "./nativeToolActivity.question.fixture.json";
import { nativeToolInvocations } from "./nativeToolInvocations";
import {
  currentNativeToolActivity,
  groupNativeToolActivity,
  nativeToolActivityPartitions,
  type NativeActivityRow,
} from "./nativeToolActivity.logic";

const session = "01900000-0000-0000-0000-000000000001";
const message = "01900000-0000-0000-0000-000000000002";
function frame(
  index: number,
  kind: string,
  payload: unknown,
  extra: Partial<ConsoleFrame> = {},
): ConsoleFrame {
  return {
    id: `frame-${index}`,
    cursor: `console:${index}`,
    dedupe_key: `frame-${index}`,
    timestamp_ms: index,
    runtime_key: "runtime",
    identity: "specialist",
    session_id: session,
    interaction_id: "interaction",
    run_id: "run",
    kind,
    status: "completed",
    frame_version: 1,
    source: { kind: "console_event" },
    payload,
    ...extra,
  };
}
function tool(
  index: number,
  status: "Requested" | "Running" | "Completed" | "Failed" | "Stopped" = "Completed",
): Extract<ConversationActivity, { kind: "tool" }> {
  return {
    kind: "tool",
    id: `tool-${index}`,
    label: "Shell",
    status,
    frames: [frame(index, "tool_execution_completed", { tool_call_id: `call-${index}` })],
    input: `command-${index}`,
    output: `output-${index}`,
  };
}
const flatten = (rows: ReturnType<typeof groupNativeToolActivity>) =>
  rows.flatMap((row) => (row.kind === "tool-group" ? row.activities : [row]));

it("keeps one real question invocation together when its saved witnesses arrive before the live group", () => {
  const native = questionFrames as ConsoleFrame[];
  const first = conversationActivities(
    native.filter((item) => Number(item.cursor.split(":")[1]) <= 9),
  );
  const before = groupNativeToolActivity(first);
  const activities = conversationActivities(native);
  const after = groupNativeToolActivity(activities, nativeToolActivityPartitions(before));
  const groups = after.filter((row) => row.kind === "tool-group");
  expect(groups).toHaveLength(1);
  expect(nativeToolInvocations(groups[0]!.activities)).toHaveLength(1);
  expect(flatten(after)).toEqual(activities);
});

it("groups the live lifecycle and separate saved tool records without equating their identities or statuses", () => {
  const native = [
    frame(1, "user_input", { content: "Check the preview" }),
    frame(
      2,
      "assistant_message",
      {
        assistant_message_id: message,
        message: {
          role: "block_assistant",
          assistant_message_id: message,
          blocks: [
            {
              block_type: "tool_use",
              data: { name: "preview_status", id: "call", args: { tabId: "tab_1" } },
            },
          ],
        },
      },
      { source: { kind: "session_history", source_cursor: `${session}:1` } },
    ),
    frame(3, "tool_call_requested", { name: "preview_status", tool_call_id: "call" }),
    frame(4, "tool_execution_completed", {
      name: "preview_status",
      tool_call_id: "call",
      content: [{ type: "text", text: "preview response" }],
    }),
    frame(
      5,
      "tool_call_requested",
      { name: "preview_status", tool_call_id: "call" },
      { source: { kind: "session_history", source_cursor: `${session}:1:tool-call:0` } },
    ),
    frame(
      6,
      "tool_execution_completed",
      { tool_call_id: "call", result: "saved preview result" },
      {
        interaction_id: undefined,
        run_id: undefined,
        source: { kind: "session_history", source_cursor: `${session}:2:0` },
      },
    ),
    frame(7, "text_complete", { content: "Preview is ready" }),
  ];
  const activities = conversationActivities(native);
  const grouped = groupNativeToolActivity(activities);
  expect(grouped.map((row) => row.kind)).toEqual(["frame", "tool-group", "frame"]);
  const group = grouped[1]!;
  expect(group.kind).toBe("tool-group");
  if (group.kind !== "tool-group") throw Error("Expected tool disclosure");
  expect(group.activities).toHaveLength(4);
  expect(group.labels).toEqual(["Preview status"]);
  expect(group.activities.filter((row) => row.kind === "tool").map((row) => row.status)).toEqual([
    "Completed",
    "Requested",
    "Completed",
  ]);
  expect(flatten(grouped)).toEqual(activities);
  flatten(grouped).forEach((row, index) => expect(row).toBe(activities[index]));
  expect(native[5]?.interaction_id).toBeUndefined();
});

it("never puts user messages, prose, images, mixed assistant blocks or notices inside a tool disclosure", () => {
  const boundaries = [
    frame(2, "user_input", { content: "Next" }),
    frame(2, "text_complete", { content: "Found a problem" }),
    frame(2, "assistant_image", { blob_id: "blob" }),
    frame(2, "system_notice", { body: "Native permission changed" }),
    frame(
      2,
      "assistant_message",
      {
        assistant_message_id: message,
        message: {
          role: "block_assistant",
          assistant_message_id: message,
          blocks: [
            { block_type: "text", data: { text: "Checking the preview" } },
            { block_type: "tool_use", data: { name: "preview_status", args: {} } },
          ],
        },
      },
      { source: { kind: "session_history" } },
    ),
  ];
  for (const boundary of boundaries) {
    const row: ConversationActivity = { kind: "frame", id: boundary.id, frame: boundary };
    const grouped = groupNativeToolActivity([tool(1), row, tool(3)]);
    expect(grouped.map((entry) => entry.kind)).toEqual(["tool-group", "frame", "tool-group"]);
    expect(grouped[1]).toBe(row);
  }
});

it("retains failed and stopped records explicitly without downgrading them to later success", () => {
  const failed = tool(2, "Failed"),
    stopped = tool(3, "Stopped");
  const group = groupNativeToolActivity([tool(1), failed, stopped, tool(4)])[0]!;
  if (group.kind !== "tool-group") throw Error("Expected tool disclosure");
  expect(group.failures).toEqual([failed, stopped]);
  expect(group.activities).toHaveLength(4);
  expect(group.failures[0]).toBe(failed);
});

it("preserves exact ordering across scope changes, limits expanded work and leaves raw details alone", () => {
  const rows: NativeActivityRow[] = Array.from({ length: 45 }, (_, index) => tool(index));
  const foreign = tool(45);
  foreign.frames = [{ ...foreign.frames[0]!, session_id: "other-session" }];
  const raw: NativeActivityRow = {
    kind: "raw",
    id: "raw",
    frame: frame(46, "tool_execution_completed", {}),
  };
  rows.push(foreign, raw, tool(47));
  const grouped = groupNativeToolActivity(rows);
  expect(
    grouped.filter((row) => row.kind === "tool-group").map((row) => row.activities.length),
  ).toEqual([20, 20, 5, 1, 1]);
  expect(grouped[4]).toBe(raw);
  expect(flatten(grouped)).toEqual(rows);
});

it("retains exact group membership on prepend and append while refreshing every record from native projection", () => {
  const original = Array.from({ length: 40 }, (_, index) => tool(index + 21));
  const first = groupNativeToolActivity(original);
  const updated = {
    ...original[0]!,
    label: "Updated label",
    status: "Failed" as const,
    output: "Native error",
  };
  const nextRows = [
    tool(20),
    updated,
    ...original.slice(1),
    ...Array.from({ length: 25 }, (_, index) => tool(index + 61)),
  ];
  const next = groupNativeToolActivity(nextRows, nativeToolActivityPartitions(first));
  expect(next.map((row) => row.id)).toEqual([
    "tool-20",
    "tool-21",
    "tool-41",
    "tool-61",
    "tool-81",
  ]);
  const groups = next.filter((row) => row.kind === "tool-group");
  expect(groups.map((row) => row.activities.length)).toEqual([1, 20, 20, 20, 5]);
  expect(groups[1]!.activities.map((row) => row.id)).toEqual(
    original.slice(0, 20).map((row) => row.id),
  );
  expect(groups[1]!.failures).toEqual([updated]);
  expect(groups[1]!.labels).toEqual(["Updated label", "Shell"]);
  flatten(next).forEach((row, index) => expect(row).toBe(nextRows[index]));
});

it("invalidates only a partition changed by native ordering instead of moving a message inside tools", () => {
  const original = Array.from({ length: 40 }, (_, index) => tool(index + 21));
  const first = groupNativeToolActivity(original);
  const notice: NativeActivityRow = {
    kind: "frame",
    id: "notice",
    frame: frame(999, "system_notice", { text: "Permission changed" }),
  };
  const nextRows = [...original.slice(0, 5), notice, ...original.slice(5)];
  const next = groupNativeToolActivity(nextRows, nativeToolActivityPartitions(first));
  expect(next.map((row) => row.id)).toEqual(["tool-21", "notice", "tool-26", "tool-41"]);
  expect(nativeToolActivityPartitions(next).at(-1)).toEqual(
    nativeToolActivityPartitions(first).at(-1),
  );
  expect(flatten(next)).toEqual(nextRows);
});

it("fills a stable trailing disclosure as tools stream instead of creating a card for every poll", () => {
  const rows: NativeActivityRow[] = [];
  let shown: ReturnType<typeof groupNativeToolActivity> = [];
  for (let index = 0; index < 45; index++) {
    rows.push(tool(index));
    const previous = nativeToolActivityPartitions(shown);
    shown = groupNativeToolActivity(rows, previous);
    const next = nativeToolActivityPartitions(shown);
    previous.forEach(({ members }, groupIndex) =>
      expect(next[groupIndex]?.members.slice(0, members.length)).toEqual(members),
    );
  }
  expect(shown.map((row) => row.id)).toEqual(["tool-0", "tool-20", "tool-40"]);
  expect(nativeToolActivityPartitions(shown).map(({ members }) => members.length)).toEqual([
    20, 20, 5,
  ]);
  expect(flatten(shown)).toEqual(rows);
});

it("exposes only current-run native live progress and keeps saved or unproven Requested records historical", () => {
  const current = tool(1, "Running");
  const requested = tool(2, "Requested");
  const saved = tool(3, "Requested");
  saved.frames = [{ ...saved.frames[0]!, source: { kind: "session_history" } }];
  const prior = tool(4, "Running");
  prior.frames = [{ ...prior.frames[0]!, run_id: "previous-run" }];
  const unknown = tool(5, "Requested");
  unknown.frames = [{ ...unknown.frames[0]!, run_id: undefined }];
  const first = groupNativeToolActivity([current, requested, saved, prior, unknown, tool(6)])[0]!;
  if (first.kind !== "tool-group") throw Error("Expected tool disclosure");
  expect(currentNativeToolActivity(first, "run")).toEqual([current, requested]);
  expect(currentNativeToolActivity(first, undefined)).toEqual([]);
  expect(currentNativeToolActivity(first, "other-run")).toEqual([]);
});

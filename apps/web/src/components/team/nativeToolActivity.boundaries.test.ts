import { createElement, act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { ConsoleFrame } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { conversationActivities, type ConversationActivity } from "./agentActivity.logic";
import questionFrames from "./nativeToolActivity.question.fixture.json";
import {
  groupNativeToolActivity,
  nativeToolActivityPartitions,
  type NativeActivityDisplayRow,
  type NativeActivityRow,
} from "./nativeToolActivity.logic";
import { nativeToolInvocations } from "./nativeToolInvocations";
import { NativeToolActivityGroup } from "./NativeToolActivityGroup";
import { useNativeHistoryDisclosures } from "./nativeHistoryDisclosures";
import { useNativeToolActivity } from "./useNativeToolActivity";

type Tool = Extract<ConversationActivity, { kind: "tool" }>;
function tool(
  id: string,
  source: "console_event" | "session_history",
  extra: Partial<ConsoleFrame> = {},
): Tool {
  return {
    kind: "tool",
    id,
    label: "Shell",
    status: "Requested",
    input: "pwd",
    output: "",
    frames: [
      {
        id,
        dedupe_key: id,
        cursor: `console:${id}`,
        timestamp_ms: 1,
        runtime_key: "runtime",
        identity: "worker",
        session_id: "session",
        run_id: "run",
        interaction_id: "interaction",
        turn_id: "turn",
        kind: "tool_call_requested",
        status: "completed",
        frame_version: 1,
        source: {
          kind: source,
          ...(source === "session_history" ? { source_cursor: "session:4:tool-call:0" } : {}),
        },
        payload: { name: "shell", tool_call_id: "same-call" },
        ...extra,
      },
    ],
  };
}
const groups = (rows: readonly NativeActivityDisplayRow[]) =>
  rows.filter((row) => row.kind === "tool-group");
const flatten = (rows: readonly NativeActivityDisplayRow[]) =>
  rows.flatMap((row) => (row.kind === "tool-group" ? row.activities : [row]));
const separated = (...batches: NativeActivityRow[][]) =>
  nativeToolActivityPartitions(batches.flatMap((batch) => groupNativeToolActivity(batch)));

it("keeps the real live disclosure ID after saved witnesses merge and subsequent polls", () => {
  const native = questionFrames as ConsoleFrame[];
  const first = groupNativeToolActivity(
    conversationActivities(native.filter((frame) => Number(frame.cursor.split(":")[1]) <= 9)),
  );
  const liveId = groups(first)[0]!.id;
  let shown = groupNativeToolActivity(
    conversationActivities(native),
    nativeToolActivityPartitions(first),
  );
  expect(groups(shown)).toHaveLength(1);
  expect(groups(shown)[0]!.id).toBe(liveId);
  expect(groups(shown)[0]!.activities[0]!.id).not.toBe(liveId);
  for (let poll = 0; poll < 3; poll++) {
    const fresh = conversationActivities(native.map((frame) => ({ ...frame })));
    shown = groupNativeToolActivity(fresh, nativeToolActivityPartitions(shown));
    expect(groups(shown)[0]!.id).toBe(liveId);
    expect(nativeToolInvocations(groups(shown)[0]!.activities)).toHaveLength(1);
    expect(flatten(shown)).toEqual(fresh);
  }
});

it("does not merge reused call IDs across native scope or incomplete lineage", () => {
  const saved = tool("saved", "session_history");
  for (const extra of [
    { session_id: "other-session" },
    { runtime_key: "other-runtime" },
    { identity: "other-worker" },
    { run_id: "other-run" },
    { interaction_id: "other-interaction" },
    { turn_id: "other-turn" },
    { run_id: undefined, interaction_id: undefined, turn_id: undefined },
  ]) {
    const live = tool("live", "console_event", extra);
    const shown = groupNativeToolActivity([saved, live], separated([saved], [live]));
    expect(groups(shown)).toHaveLength(2);
    expect(flatten(shown)).toEqual([saved, live]);
  }
});

it("does not use ambiguous saved call witnesses to collapse retained disclosures", () => {
  const saved = tool("saved", "session_history");
  const duplicate = tool("duplicate", "session_history");
  const live = tool("live", "console_event");
  const rows = [saved, duplicate, live];
  const shown = groupNativeToolActivity(rows, separated([saved], [duplicate], [live]));
  expect(groups(shown)).toHaveLength(3);
  expect(flatten(shown)).toEqual(rows);
});

it("does not join even an exact invocation across prose or raw details", () => {
  const saved = tool("saved", "session_history");
  const live = tool("live", "console_event");
  for (const kind of ["frame", "raw"] as const) {
    const boundary: NativeActivityRow = {
      kind,
      id: `boundary-${kind}`,
      frame: {
        ...saved.frames[0]!,
        id: `boundary-${kind}`,
        kind: "text_complete",
        payload: { content: "Visible explanation" },
      },
    };
    const rows = [saved, boundary, live];
    const shown = groupNativeToolActivity(rows, separated([saved], [live]));
    expect(groups(shown)).toHaveLength(2);
    expect(shown[1]).toBe(boundary);
    expect(flatten(shown)).toEqual(rows);
  }
});

it("preserves the 20-record bound when one exact invocation spans two large disclosures", () => {
  const filler = (id: number) =>
    tool(`other-${id}`, "console_event", { payload: { tool_call_id: `other-call-${id}` } });
  const first = [
    tool("saved", "session_history"),
    ...Array.from({ length: 9 }, (_, id) => filler(id)),
  ];
  const second = [
    tool("live", "console_event"),
    ...Array.from({ length: 10 }, (_, id) => filler(id + 9)),
  ];
  const rows = [...first, ...second];
  const shown = groupNativeToolActivity(rows, separated(first, second));
  expect(groups(shown).map((group) => group.activities.length)).toEqual([10, 11]);
  expect(flatten(shown)).toEqual(rows);
});

it("retains the exact failed record when compacting matching native witnesses", () => {
  const saved = tool("saved", "session_history");
  const live: Tool = {
    ...tool("live", "console_event"),
    status: "Failed",
    output: "Permission denied",
  };
  const shown = groupNativeToolActivity([saved, live], separated([saved], [live]));
  expect(groups(shown)).toHaveLength(1);
  expect(groups(shown)[0]!.failures).toEqual([live]);
  expect(groups(shown)[0]!.failures[0]).toBe(live);
  expect(nativeToolInvocations(groups(shown)[0]!.activities)[0]!.activity).toBe(live);
  expect(flatten(shown)).toEqual([saved, live]);
});

function Harness({ identity, rows }: { identity: string; rows: readonly NativeActivityRow[] }) {
  const shown = useNativeToolActivity(identity, rows);
  const disclosures = useNativeHistoryDisclosures(identity);
  return createElement(
    "section",
    null,
    shown.map((group) =>
      group.kind === "tool-group"
        ? createElement(NativeToolActivityGroup, {
            key: group.id,
            group,
            disclosures,
            renderActivity: (row) => createElement("p", null, row.id),
          })
        : createElement("p", { key: group.id }, group.id),
    ),
  );
}
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it.each(["prose", "group limit"])(
  "keeps globally ambiguous witnesses separate inside an opened group across %s",
  async (boundary) => {
    const saved = tool("saved", "session_history");
    const live = tool("live", "console_event");
    const duplicate = tool("duplicate", "session_history");
    const between: NativeActivityRow[] =
      boundary === "prose"
        ? [
            {
              kind: "frame",
              id: "explanation",
              frame: {
                ...saved.frames[0]!,
                id: "explanation",
                kind: "text_complete",
                payload: { content: "Visible explanation" },
              },
            },
          ]
        : Array.from({ length: 18 }, (_, index) =>
            tool(`other-${index}`, "console_event", {
              payload: { tool_call_id: `other-call-${index}` },
            }),
          );
    const rows = [saved, live, ...between, duplicate];
    await act(async () => {
      renderer = create(createElement(Harness, { identity: `ambiguous-render-${boundary}`, rows }));
    });
    const article = renderer!.root.findByProps({ "data-agent-tool-group-id": saved.id });
    await act(async () =>
      article.findByType("details").props.onToggle({ currentTarget: { open: true } }),
    );
    const visible = article.findAllByType("p").map((node) => node.children.join(""));
    expect(visible.slice(0, 2)).toEqual(["saved", "live"]);
    expect(article.findAllByType("details")).toHaveLength(1);
  },
);

it("retains an opened real invocation across merge, poll, raw mode and remount", async () => {
  const identity = "real-invocation-retained-membership";
  const native = questionFrames as ConsoleFrame[];
  const live = conversationActivities(
    native.filter((frame) => Number(frame.cursor.split(":")[1]) <= 9),
  );
  const all = conversationActivities(native);
  const liveId = groups(groupNativeToolActivity(live))[0]!.id;
  const article = () => renderer!.root.findByProps({ "data-agent-tool-group-id": liveId });
  const isOpen = () => article().findByType("details").props.open;
  await act(async () => {
    renderer = create(createElement(Harness, { identity, rows: live }));
  });
  await act(async () =>
    article()
      .findByType("details")
      .props.onToggle({ currentTarget: { open: true } }),
  );
  await act(async () => renderer!.update(createElement(Harness, { identity, rows: all })));
  expect(isOpen()).toBe(true);
  await act(async () => renderer!.update(createElement(Harness, { identity, rows: [...all] })));
  expect(isOpen()).toBe(true);
  const raw = native.map((frame) => ({ kind: "raw" as const, id: frame.id, frame }));
  await act(async () => renderer!.update(createElement(Harness, { identity, rows: raw })));
  await act(async () => renderer!.update(createElement(Harness, { identity, rows: all })));
  expect(isOpen()).toBe(true);
  await act(async () => renderer!.unmount());
  await act(async () => {
    renderer = create(createElement(Harness, { identity, rows: all }));
  });
  expect(isOpen()).toBe(true);
});

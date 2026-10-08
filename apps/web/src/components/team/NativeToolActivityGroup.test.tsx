import { act, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ConversationActivity } from "./agentActivity.logic";
import type { NativeHistoryDisclosures } from "./nativeHistoryDisclosures";
import { NativeToolActivityGroup } from "./NativeToolActivityGroup";
import type { NativeToolActivityGroup as Group } from "./nativeToolActivity.logic";
import { nativeToolInvocationIndex } from "./nativeToolInvocations";

const completed: Extract<ConversationActivity, { kind: "tool" }> = {
  kind: "tool",
  id: "call-1",
  label: "Preview status",
  status: "Completed",
  frames: [],
  input: "original input",
  output: "original result",
};
const failed = {
  ...completed,
  id: "call-2",
  status: "Failed" as const,
  output: "Browser permission was revoked.",
};
const group: Group = {
  kind: "tool-group",
  id: completed.id,
  activities: [completed, failed],
  invocationIndex: nativeToolInvocationIndex([completed, failed]),
  labels: ["Preview status"],
  failures: [failed],
};
function Harness({
  value = group,
  nativeRunId,
  questions,
}: {
  value?: Group;
  nativeRunId?: string;
  questions?: ReadonlySet<string>;
} = {}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const disclosures: NativeHistoryDisclosures = {
    expanded,
    toggle: (id, open) => setExpanded(open ? new Set([id]) : new Set()),
    prepare: () => {},
    settling: false,
    shouldRestorePosition: () => true,
  };
  return (
    <NativeToolActivityGroup
      group={value}
      disclosures={disclosures}
      nativeRunId={nativeRunId}
      pendingQuestionToolCallIds={questions}
      renderActivity={(activity) =>
        activity.kind === "tool" ? (
          <p>
            {activity.id}: {activity.input} - {activity.output}
          </p>
        ) : null
      }
    />
  );
}
let renderer: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("shows the native answer wait without presenting a historical question as current work", async () => {
  const pending = {
    ...completed,
    id: "question-tool",
    label: "Ui multiple choice",
    status: "Running" as const,
    frames: [
      {
        id: "question-frame",
        cursor: "1",
        dedupe_key: "question-frame",
        timestamp_ms: 1,
        runtime_key: "runtime",
        identity: "agent",
        session_id: "session",
        run_id: "current-run",
        kind: "tool_execution_started",
        status: "accepted" as const,
        frame_version: 1,
        source: { kind: "console_event" as const },
        payload: { tool_call_id: "question-call" },
      },
    ],
  };
  const value: Group = {
    kind: "tool-group",
    id: pending.id,
    activities: [pending],
    invocationIndex: nativeToolInvocationIndex([pending]),
    labels: [pending.label],
    failures: [],
  };
  await act(async () => {
    renderer = create(
      <Harness value={value} nativeRunId="current-run" questions={new Set(["question-call"])} />,
    );
  });
  expect(content()).toContain("Waiting for your answer");
  expect(content()).toContain("Needs input");
  expect(content()).not.toContain("Running");
  expect(content()).not.toContain("Ui multiple choice");
  await act(async () =>
    renderer!.update(
      <Harness
        value={value}
        nativeRunId="replacement-run"
        questions={new Set(["question-call"])}
      />,
    ),
  );
  expect(content()).not.toContain("Needs input");
  expect(content()).not.toContain("Waiting for your answer");
  expect(pending.status).toBe("Running");
});
const content = () => JSON.stringify(renderer?.toJSON());
it("collapses routine records, retains the visible failure and restores ordered record details on expansion", async () => {
  await act(async () => {
    renderer = create(<Harness />);
  });
  expect(content()).toContain("Tool activity");
  expect(content()).toContain("Browser permission was revoked.");
  expect(content()).not.toContain("original input");
  expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(1);
  await act(async () =>
    renderer!.root.findByType("details").props.onToggle({ currentTarget: { open: true } }),
  );
  const details = renderer!.root.findAllByType("p").map((node) => node.children.join(""));
  expect(details).toEqual([
    "call-1: original input - original result",
    "call-2: original input - Browser permission was revoked.",
  ]);
  await act(async () =>
    renderer!.root.findByType("details").props.onToggle({ currentTarget: { open: false } }),
  );
  expect(content()).not.toContain("original input");
  expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(1);
});

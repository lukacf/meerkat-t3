import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { ConsoleFrame } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ConversationActivity } from "./agentActivity.logic";
import { NativeToolActivityGroup } from "./NativeToolActivityGroup";
import { useNativeHistoryDisclosures } from "./nativeHistoryDisclosures";
import { useNativeToolActivity } from "./useNativeToolActivity";
import type { NativeActivityRow } from "./nativeToolActivity.logic";

function tool(
  index: number,
  status: "Requested" | "Running" | "Completed" = "Completed",
  source: "console_event" | "session_history" = "console_event",
): Extract<ConversationActivity, { kind: "tool" }> {
  const frame: ConsoleFrame = {
    id: `frame-${index}`,
    cursor: `console:${index}`,
    dedupe_key: `frame-${index}`,
    timestamp_ms: index,
    runtime_key: "runtime",
    identity: "specialist",
    session_id: "session",
    interaction_id: "interaction",
    run_id: "run",
    kind: "tool_call_requested",
    status: "completed",
    frame_version: 1,
    source: { kind: source },
    payload: { tool_call_id: `call-${index}` },
  };
  return {
    kind: "tool",
    id: `tool-${index}`,
    label: `Shell ${index}`,
    status,
    frames: [frame],
    input: `input-${index}`,
    output: `result-${index}`,
  };
}
function Harness({
  identity,
  rows,
  nativeRunId,
}: {
  identity: string;
  rows: readonly NativeActivityRow[];
  nativeRunId?: string;
}) {
  const shown = useNativeToolActivity(identity, rows);
  const disclosures = useNativeHistoryDisclosures(identity);
  return (
    <section>
      {shown.map((group) =>
        group.kind === "tool-group" ? (
          <NativeToolActivityGroup
            key={group.id}
            group={group}
            disclosures={disclosures}
            nativeRunId={nativeRunId}
            renderActivity={(activity) => <p>{activity.id}</p>}
          />
        ) : (
          <p key={group.id}>{group.id}</p>
        ),
      )}
    </section>
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

it("keeps an open disclosure on the same native records through pagination, raw-view changes and navigation", async () => {
  const identity = "tool-partition-retention";
  const original = Array.from({ length: 40 }, (_, index) => tool(index + 21));
  await act(async () => {
    renderer = create(<Harness identity={identity} rows={original} />);
  });
  const article = () => renderer!.root.findByProps({ "data-agent-tool-group-id": "tool-21" });
  await act(async () =>
    article()
      .findByType("details")
      .props.onToggle({ currentTarget: { open: true } }),
  );
  const memberIds = () =>
    article()
      .findAllByType("p")
      .map((node) => node.children.join(""));
  const expected = original.slice(0, 20).map((row) => row.id);
  expect(memberIds()).toEqual(expected);
  const paged = [
    tool(20),
    ...original,
    ...Array.from({ length: 25 }, (_, index) => tool(index + 61)),
  ];
  await act(async () => renderer!.update(<Harness identity={identity} rows={paged} />));
  expect(memberIds()).toEqual(expected);
  expect(renderer!.root.findAllByType("details").filter((node) => node.props.open)).toHaveLength(1);

  const raw: NativeActivityRow[] = paged.map((row) => ({
    kind: "raw",
    id: row.id,
    frame: row.frames[0]!,
  }));
  await act(async () => renderer!.update(<Harness identity={identity} rows={raw} />));
  await act(async () => renderer!.update(<Harness identity={identity} rows={paged} />));
  expect(memberIds()).toEqual(expected);
  await act(async () => renderer!.unmount());
  await act(async () => {
    renderer = create(<Harness identity={identity} rows={paged} />);
  });
  expect(memberIds()).toEqual(expected);
  expect(renderer!.root.findAllByType("details").filter((node) => node.props.open)).toHaveLength(1);
  await act(async () => renderer!.unmount());
  await act(async () => {
    renderer = create(<Harness identity="other-native-session" rows={paged} />);
  });
  expect(renderer!.root.findAllByType("details").filter((node) => node.props.open)).toHaveLength(0);
});

it("shows current native progress while collapsed and retires it on completion or run replacement", async () => {
  const saved = tool(2, "Requested", "session_history");
  const statuses = () =>
    renderer!.root.findAllByProps({ role: "status" }).map((node) => node.children.join(""));
  await act(async () => {
    renderer = create(
      <Harness
        identity="tool-live-progress"
        rows={[tool(1, "Running"), saved]}
        nativeRunId="run"
      />,
    );
  });
  expect(statuses()).toEqual(["Shell 1: Running"]);
  await act(async () =>
    renderer!.update(
      <Harness identity="tool-live-progress" rows={[tool(1), saved]} nativeRunId="run" />,
    ),
  );
  expect(statuses()).toEqual([]);
  await act(async () =>
    renderer!.update(
      <Harness
        identity="tool-live-progress"
        rows={[tool(1, "Requested"), saved]}
        nativeRunId="next-run"
      />,
    ),
  );
  expect(statuses()).toEqual([]);
  await act(async () =>
    renderer!.update(
      <Harness
        identity="tool-live-progress"
        rows={[tool(1, "Requested"), saved]}
        nativeRunId="run"
      />,
    ),
  );
  expect(statuses()).toEqual(["Shell 1: Requested"]);
  await act(async () =>
    renderer!.root.findByType("details").props.onToggle({ currentTarget: { open: true } }),
  );
  expect(statuses()).toEqual([]);
  expect(renderer!.root.findAllByType("p").map((node) => node.children.join(""))).toEqual([
    "tool-1",
    "tool-2",
  ]);
});

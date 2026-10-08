import type { ConsoleFrame } from "@t3tools/contracts";
import { nativeLabel, type ConversationActivity } from "./agentActivity.logic";
import { canonicalAssistantMessage } from "./nativeAssistantOccurrence.logic";
import { savedMessageView } from "./nativeTranscript.logic";
import {
  nativeToolInvocationIndex,
  nativeToolInvocations,
  type NativeToolInvocationIndex,
} from "./nativeToolInvocations";

export type NativeActivityRow =
  | ConversationActivity
  | { kind: "raw"; id: string; frame: ConsoleFrame };
export type NativeToolActivityGroup = {
  kind: "tool-group";
  id: string;
  activities: ConversationActivity[];
  invocationIndex: NativeToolInvocationIndex;
  labels: string[];
  failures: Extract<ConversationActivity, { kind: "tool" }>[];
};
export type NativeActivityDisplayRow = NativeActivityRow | NativeToolActivityGroup;
export type NativeToolActivityPartitions = readonly {
  id: string;
  members: readonly string[];
}[];

function toolLabels(activity: NativeActivityRow): string[] | null {
  if (activity.kind === "tool") return [activity.label];
  if (activity.kind !== "frame") return null;
  if (activity.frame.status === "delivery_failed" || activity.frame.status === "redacted")
    return null;
  const message = canonicalAssistantMessage(activity.frame);
  const view = message ? savedMessageView(message, "Agent") : null;
  if (!view?.parts.length || view.parts.some((part) => part.kind !== "tool")) return null;
  return view.parts.flatMap((part) => {
    if (part.kind !== "tool") return [];
    const label = nativeLabel(part.label);
    return [label.charAt(0).toUpperCase() + label.slice(1)];
  });
}

function toolLane(row: NativeActivityRow): string {
  const frame = row.kind === "tool" ? row.frames[0] : row.frame;
  return frame ? JSON.stringify([frame.runtime_key, frame.identity, frame.session_id]) : row.id;
}

export function nativeToolActivityPartitions(
  rows: readonly NativeActivityDisplayRow[],
): NativeToolActivityPartitions {
  return rows.flatMap((row) =>
    row.kind === "tool-group"
      ? [{ id: row.id, members: row.activities.map((activity) => activity.id) }]
      : [],
  );
}

/** Only observed live events from the current native run can advertise current progress. */
export function currentNativeToolActivity(
  group: NativeToolActivityGroup,
  nativeRunId: string | undefined,
) {
  return group.activities.filter(
    (activity): activity is Extract<ConversationActivity, { kind: "tool" }> =>
      nativeRunId !== undefined &&
      activity.kind === "tool" &&
      (activity.status === "Requested" || activity.status === "Running") &&
      activity.frames.some(
        (frame) => frame.source.kind === "console_event" && frame.run_id === nativeRunId,
      ),
  );
}

/** Keep existing disclosure membership intact when adjacent history pages arrive. */
export function groupNativeToolActivity(
  rows: readonly NativeActivityRow[],
  previous: NativeToolActivityPartitions = [],
): NativeActivityDisplayRow[] {
  const labelsByIndex = rows.map(toolLabels);
  const invocationIndex = nativeToolInvocationIndex(
    rows.filter((row): row is ConversationActivity => row.kind !== "raw"),
  );
  const indices = new Map(rows.map((row, index) => [row.id, index]));
  const retained = new Map<number, { id: string; length: number }>();
  for (const { id: groupId, members } of previous) {
    const start = members[0] === undefined ? undefined : indices.get(members[0]);
    if (start === undefined || members.length > 20 || !members.includes(groupId)) continue;
    const lane = toolLane(rows[start]!);
    // A real insertion, removal or scope change inside a group invalidates only
    // that partition. Native records are never reordered to preserve a disclosure.
    if (
      members.every(
        (id, offset) =>
          rows[start + offset]?.id === id &&
          labelsByIndex[start + offset] !== null &&
          toolLane(rows[start + offset]!) === lane,
      )
    )
      retained.set(start, { id: groupId, length: members.length });
  }
  const shown: NativeActivityDisplayRow[] = [];
  let group: NativeToolActivityGroup | null = null;
  let lane: string | null = null;
  let retainedEnd = -1;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const labels = labelsByIndex[index];
    if (!labels || row.kind === "raw") {
      shown.push(row);
      group = null;
      lane = null;
      continue;
    }
    const nextLane = toolLane(row);
    // Keep an expanded group bounded so long tool-only histories stay virtualized.
    if (
      !group ||
      group.activities.length >= 20 ||
      lane !== nextLane ||
      retained.has(index) ||
      index === retainedEnd
    ) {
      const partition = retained.get(index);
      group = {
        kind: "tool-group",
        id: partition?.id ?? row.id,
        activities: [],
        invocationIndex,
        labels: [],
        failures: [],
      };
      shown.push(group);
      lane = nextLane;
      // New tail records can fill the last group without moving its existing
      // members. Otherwise streamed tools would create one disclosure per poll.
      retainedEnd =
        partition && previous.at(-1)?.id !== partition.id ? index + partition.length : -1;
    }
    group.activities.push(row);
    for (const label of labels)
      if (label !== "Tool" && !group.labels.includes(label)) group.labels.push(label);
    if (row.kind === "tool" && (row.status === "Failed" || row.status === "Stopped"))
      group.failures.push(row);
  }
  const compact: NativeActivityDisplayRow[] = [];
  const previousIds = new Set(previous.map(({ id }) => id));
  for (const row of shown) {
    const preceding = compact.at(-1);
    if (
      row.kind === "tool-group" &&
      preceding?.kind === "tool-group" &&
      preceding.activities.length + row.activities.length <= 20
    ) {
      const activities = [...preceding.activities, ...row.activities];
      const precedingIds = new Set(preceding.activities.map((activity) => activity.id));
      const joinsBoundary = nativeToolInvocations(activities, invocationIndex).some(
        (invocation) =>
          invocation.records.some((activity) => precedingIds.has(activity.id)) &&
          invocation.records.some((activity) => !precedingIds.has(activity.id)),
      );
      if (joinsBoundary) {
        // Saved witnesses may arrive before an already visible live call. Keep
        // that disclosure's ID while joining only an exact native invocation.
        // Original records stay in order, and real conversation rows still fence it.
        compact[compact.length - 1] = {
          kind: "tool-group",
          id: previousIds.has(row.id) && !previousIds.has(preceding.id) ? row.id : preceding.id,
          activities,
          invocationIndex,
          labels: [...new Set([...preceding.labels, ...row.labels])],
          failures: [...preceding.failures, ...row.failures],
        };
        continue;
      }
    }
    compact.push(row);
  }
  return compact;
}

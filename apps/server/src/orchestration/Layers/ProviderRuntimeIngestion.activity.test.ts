import {
  EventId,
  ProviderDriverKind,
  RuntimeTaskId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

const base = {
  provider: ProviderDriverKind.make("codex"),
  createdAt: "2026-08-06T00:00:00.000Z",
  threadId: ThreadId.make("thread-1"),
};

describe("runtimeEventToActivities native skill receipts", () => {
  const keys = [
    { source_uuid: "b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64", skill_name: "review" },
    { source_uuid: "97e07e7d-4641-43c6-b49d-a8827225fa24", skill_name: "review" },
  ];
  const nativeEnvelope = {
    event_id: "f9422cca-aa96-4f06-b9ba-a6550d1c811c",
    source: { type: "session", session_id: "native-session" },
    seq: 11,
    mob_id: "native-mob",
    timestamp_ms: Date.parse(base.createdAt),
  };
  const receipt = {
    nativeSourceEventId: `evt-agent-${nativeEnvelope.event_id}`,
    nativeSessionId: "native-session",
    nativeDeliveryId: `meerkat-output:run:native-session:evt-agent-${nativeEnvelope.event_id}`,
  };

  it("shows names but retains both exact source keys and the untouched envelope", () => {
    const nativeEvent = {
      ...nativeEnvelope,
      payload: { type: "skills_resolved", skills: keys, injection_bytes: 789 },
    };
    const event = {
      ...base,
      provider: ProviderDriverKind.make("meerkat"),
      type: "skills.resolved",
      eventId: EventId.make(receipt.nativeDeliveryId),
      payload: { ...receipt, nativeEvent },
    } satisfies ProviderRuntimeEvent;
    const [activity] = runtimeEventToActivities(event);
    expect(activity).toEqual({
      id: event.eventId,
      createdAt: event.createdAt,
      tone: "info",
      kind: "skills.resolved",
      summary: "Skills resolved: review, review",
      turnId: null,
      payload: {
        ...receipt,
        nativeEvent,
        detail: `${keys[0]!.source_uuid}/review\n${keys[1]!.source_uuid}/review\nInjected bytes: 789`,
      },
    });
    expect(activity?.payload).not.toHaveProperty("data");
    expect(activity?.payload).not.toHaveProperty("itemType");
    expect(activity?.payload).not.toHaveProperty("nativeSegmentId");
  });

  it("keeps a failure reason structured and displays an absent optional key honestly", () => {
    const reason = { reason_type: "not_found", key: keys[1] };
    const nativeEvent = {
      ...nativeEnvelope,
      payload: { type: "skill_resolution_failed", skill_key: null, reason },
    };
    const event = {
      ...base,
      provider: ProviderDriverKind.make("meerkat"),
      type: "skills.resolution-failed",
      eventId: EventId.make(receipt.nativeDeliveryId),
      payload: { ...receipt, nativeEvent },
    } satisfies ProviderRuntimeEvent;
    const [activity] = runtimeEventToActivities(event);
    expect(activity).toMatchObject({
      tone: "error",
      kind: "skills.resolution-failed",
      summary: "Skill resolution failed",
    });
    expect(activity?.payload).toEqual({
      ...receipt,
      nativeEvent,
      detail: `No skill key was supplied by the runtime.\nReason:\n${JSON.stringify(reason, null, 2)}`,
    });
    const futureNativeEvent = {
      ...nativeEnvelope,
      payload: {
        type: "skill_resolution_failed",
        skill_key: keys[0],
        reason: { reason_type: "future_native_variant", nested: { values: [1, { exact: true }] } },
      },
    };
    const [future] = runtimeEventToActivities({
      ...event,
      payload: { ...receipt, nativeEvent: futureNativeEvent },
    });
    expect(future?.payload).toMatchObject({ nativeEvent: futureNativeEvent });
    expect(future?.payload).not.toHaveProperty("data");
  });
});

describe("runtimeEventToActivities task progress", () => {
  it("persists usage independently from replaceable activity", () => {
    const taskId = RuntimeTaskId.make("agent-1");
    const usageOnly = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-usage"),
      payload: {
        taskId,
        description: "Agent one",
        typedUsage: { totalTokens: 73_700_000 },
      },
    } satisfies ProviderRuntimeEvent;
    const command = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-command"),
      payload: {
        taskId,
        description: "Agent one",
        summary: "Running tests",
        lastToolName: "exec_command",
      },
    } satisfies ProviderRuntimeEvent;

    const usageActivities = runtimeEventToActivities(usageOnly);
    const commandActivities = runtimeEventToActivities(command);

    expect(usageActivities.map((activity) => activity.id)).toEqual(["task-usage:thread-1:agent-1"]);
    expect(commandActivities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-1",
    ]);
    const usagePayload = usageActivities[0]?.payload as Record<string, unknown> | undefined;
    expect(usagePayload?.typedUsage).toEqual({ totalTokens: 73_700_000 });
    expect(usagePayload?.usageSnapshot).toBe(true);
  });

  it("splits combined progress and usage into their independent snapshots", () => {
    const event = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-combined"),
      payload: {
        taskId: RuntimeTaskId.make("agent-2"),
        description: "Agent two",
        summary: "Inspecting the panel",
        typedUsage: { totalTokens: 4_200, toolUses: 7 },
        status: "running",
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);
    const progressPayload = activities[0]?.payload as Record<string, unknown>;
    const usagePayload = activities[1]?.payload as Record<string, unknown>;

    expect(activities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-2",
      "task-usage:thread-1:agent-2",
    ]);
    expect(progressPayload.summary).toBe("Inspecting the panel");
    expect(progressPayload.status).toBe("running");
    expect(progressPayload).not.toHaveProperty("typedUsage");
    expect(usagePayload.typedUsage).toEqual({ totalTokens: 4_200, toolUses: 7 });
    expect(usagePayload.usageSnapshot).toBe(true);
    expect(usagePayload).not.toHaveProperty("status");
  });
});
describe("runtimeEventToActivities tool streaming persistence", () => {
  const accumulatedStdout = [
    "first line of output",
    ...Array.from({ length: 500 }, (_, index) => `Capturing frame ${index}/9028`),
  ].join("\n");
  const streamingData = {
    toolCallId: "tool-call-1",
    kind: "execute",
    command: "blender --render",
    rawOutput: { stdout: accumulatedStdout },
    content: [{ type: "content", content: { type: "text", text: accumulatedStdout } }],
  };

  it("persists tool.updated with the wire projection of data, not the accumulated stream", () => {
    const event = {
      ...base,
      type: "item.updated",
      eventId: EventId.make("evt-tool-streaming-updated"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Render",
        detail: accumulatedStdout,
        data: streamingData,
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);

    expect(activities).toHaveLength(1);
    const payload = activities[0]?.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    expect(payload.status).toBe("inProgress");
    expect(data.toolCallId).toBe("tool-call-1");
    expect(data.command).toBe("blender --render");
    expect(data.rawOutput).toEqual({ content: "first line of output" });
    expect(data.content).toBeUndefined();
    expect(JSON.stringify(data).length).toBeLessThan(1_000);
  });

  it("persists the full terminal payload on tool.completed", () => {
    const event = {
      ...base,
      type: "item.completed",
      eventId: EventId.make("evt-tool-streaming-completed"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Render",
        data: streamingData,
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);

    expect(activities).toHaveLength(1);
    const payload = activities[0]?.payload as Record<string, unknown>;
    expect(payload.data).toEqual(streamingData);
  });
});

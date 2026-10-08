import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type MeerkatAgentQueue,
  type MeerkatAgentQueueItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  agentQueueImportPayload,
  confirmedAgentQueueImport,
  nextAgentQueueImport,
} from "./agentQueueMigration";
import { createAgentUnsentQueueStore, type UnsentAgentMessage } from "./agentUnsentQueueStore";

describe("server queue draft migration", () => {
  it("never converts an uncertain native delivery into a fresh queue item", () => {
    const rows = [
      { id: "attempted", text: "May already be running" },
      { id: "unsent", text: "Next task" },
    ];
    expect(nextAgentQueueImport(rows, [{ queueId: "attempted" }])?.id).toBe("unsent");
    expect(
      nextAgentQueueImport(rows, [{ queueId: "attempted" }, { queueId: "unsent" }]),
    ).toBeUndefined();
  });
  it("keeps an immutable enqueue request across navigation until server acknowledgement", () => {
    const entries = new Map<string, string>();
    const storage = {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      },
    };
    const first = createAgentUnsentQueueStore(storage);
    first
      .getState()
      .add("environment/project/provider/agent", { id: "enqueue-request", text: "Exact snapshot" });
    const restarted = createAgentUnsentQueueStore(storage);
    const request = nextAgentQueueImport(
      restarted.getState().byTarget["environment/project/provider/agent"]!,
      [],
    );
    expect(request).toEqual({ id: "enqueue-request", text: "Exact snapshot" });
    expect(
      nextAgentQueueImport(restarted.getState().byTarget["other-environment"] ?? [], []),
    ).toBeUndefined();
    restarted.getState().remove("environment/project/provider/agent", request!.id);
    expect(
      createAgentUnsentQueueStore(storage).getState().byTarget[
        "environment/project/provider/agent"
      ],
    ).toEqual([]);
  });
});

describe("recorded agent queue imports", () => {
  const environmentId = EnvironmentId.make("environment");
  const target = {
    projectId: ProjectId.make("project"),
    instanceId: ProviderInstanceId.make("meerkat_work"),
    agentRef: "original-agent",
  };
  const row: UnsentAgentMessage = {
    id: "original-request",
    text: "Review this image",
    images: [
      {
        type: "image",
        media_type: "image/png",
        source: "blob",
        blob_id: `sha256:${"a".repeat(64)}`,
      },
    ],
    modelSelection: {
      instanceId: target.instanceId,
      model: "openai:example",
      options: [{ id: "reasoning", value: "high" }],
    },
    context: { version: 1, records: [] },
  };
  const item: MeerkatAgentQueueItem = {
    id: "native-item",
    requestId: `import-${row.id}`,
    payload: agentQueueImportPayload(row),
    status: "queued",
    error: null,
    receipt: null,
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
  };
  const queue: MeerkatAgentQueue = {
    revision: 1,
    durableId: "durable-agent",
    items: [item],
    waitingReason: null,
  };
  const expected = { environmentId, target, durableId: queue.durableId };
  const observed = { environmentId, target, queue, isPending: false, hasError: false };

  it.each([
    "queued",
    "dispatching",
    "accepted",
    "failed",
    "uncertain",
    "completed",
    "cancelled",
  ] as const)(
    "recognizes exact recorded %s items without reinterpreting their delivery status",
    (status) => {
      const recorded = { ...item, status };
      expect(
        confirmedAgentQueueImport(row, expected, {
          ...observed,
          queue: { ...queue, items: [recorded] },
        }),
      ).toBe(recorded);
    },
  );

  it("requires an available observation of the exact environment, project, provider, agent, and durable identity", () => {
    for (const observation of [
      { ...observed, queue: undefined },
      { ...observed, isPending: true },
      { ...observed, hasError: true },
      { ...observed, environmentId: EnvironmentId.make("other-environment") },
      { ...observed, target: { ...target, projectId: ProjectId.make("other-project") } },
      {
        ...observed,
        target: { ...target, instanceId: ProviderInstanceId.make("meerkat_personal") },
      },
      { ...observed, target: { ...target, agentRef: "replacement-agent" } },
      { ...observed, queue: { ...queue, durableId: "other-durable-agent" } },
    ])
      expect(confirmedAgentQueueImport(row, expected, observation)).toBeUndefined();
    expect(
      confirmedAgentQueueImport(row, { ...expected, durableId: undefined }, observed),
    ).toBeUndefined();
    expect(
      confirmedAgentQueueImport(row, { ...expected, durableId: "" }, observed),
    ).toBeUndefined();
  });

  it("retains local evidence when any original request or payload field differs, including later server edits", () => {
    const changedItems: ReadonlyArray<MeerkatAgentQueueItem> = [
      { ...item, requestId: "other-request" },
      { ...item, payload: { ...item.payload, text: "Edited on another client" } },
      { ...item, payload: { ...item.payload, images: [] } },
      {
        ...item,
        payload: {
          ...item.payload,
          modelSelection: { ...row.modelSelection!, options: [{ id: "reasoning", value: "low" }] },
        },
      },
      { ...item, payload: { ...item.payload, context: undefined } },
    ];
    for (const changed of changedItems)
      expect(
        confirmedAgentQueueImport(row, expected, {
          ...observed,
          queue: { ...queue, items: [changed] },
        }),
      ).toBeUndefined();
  });
});

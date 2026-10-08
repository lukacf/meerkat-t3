import { ProviderInstanceId, type MeerkatImageRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { canSendAgentQueue, createAgentUnsentQueueStore } from "./agentUnsentQueueStore";
const image: MeerkatImageRef = {
  type: "image",
  media_type: "image/png",
  source: "blob",
  blob_id: `sha256:${"a".repeat(64)}`,
};
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
describe("unsent agent queue", () => {
  it("waits for an authoritative fresh idle observation", () => {
    const now = Date.parse("2026-09-26T00:00:00Z");
    expect(canSendAgentQueue(undefined, now)).toBe(false);
    expect(
      canSendAgentQueue({ status: "running", observedAt: new Date(now).toISOString() }, now),
    ).toBe(false);
    expect(
      canSendAgentQueue({ status: "idle", observedAt: new Date(now - 31_000).toISOString() }, now),
    ).toBe(false);
    expect(
      canSendAgentQueue({ status: "idle", observedAt: new Date(now).toISOString() }, now),
    ).toBe(true);
  });
  it("retains ordered editable image messages and model settings across pane close/reopen", () => {
    const saved = storage();
    const store = createAgentUnsentQueueStore(saved);
    store.getState().add("architect", {
      id: "first",
      text: "Review this",
      images: [image],
      modelSelection: {
        instanceId: ProviderInstanceId.make("native"),
        model: "model-a",
        options: [{ id: "reasoning", value: "high" }],
      },
    });
    store.getState().add("architect", { id: "second", text: "Then summarize" });
    store.getState().move("architect", "second", -1);
    store.getState().edit("architect", "first", "");
    const restored = createAgentUnsentQueueStore(saved);
    expect(restored.getState().byTarget.architect?.map((row) => row.id)).toEqual([
      "second",
      "first",
    ]);
    expect(restored.getState().byTarget.architect?.[1]).toMatchObject({
      text: "",
      images: [image],
      modelSelection: { model: "model-a" },
    });
    restored.getState().remove("architect", "second");
    expect(restored.getState().byTarget.architect?.map((row) => row.id)).toEqual(["first"]);
    expect(restored.getState().byTarget.worker).toBeUndefined();
  });
  it("leaves the draft with the caller when persistent queuing fails", () => {
    const store = createAgentUnsentQueueStore({
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    });
    expect(store.getState().add("target", { id: "one", text: "Preserve me" })).toBe(false);
    expect(store.getState().byTarget.target).toBeUndefined();
  });
  it("migrates ordered unacknowledged staging to durable storage without minting import IDs", () => {
    const session = storage();
    const durable = storage();
    const old = createAgentUnsentQueueStore(session);
    old
      .getState()
      .add("target", { id: "first", text: "First", images: [image], sendWhenIdle: true });
    old.getState().add("target", { id: "second", text: "Second" });
    old.getState().move("target", "second", -1);
    const migrated = createAgentUnsentQueueStore(durable, session);
    expect(migrated.getState().byTarget.target?.map((row) => row.id)).toEqual(["second", "first"]);
    expect(session.getItem("t3code:meerkat-unsent-queue:v1")).toBeNull();
    const cold = createAgentUnsentQueueStore(durable, storage());
    expect(cold.getState().byTarget).toEqual(migrated.getState().byTarget);
    cold.getState().remove("target", "first");
    expect(createAgentUnsentQueueStore(durable).getState().byTarget.target).toEqual([
      { id: "second", text: "Second" },
    ]);
  });
  it("retains the session copy when migration cannot persist and rejects new volatile rows", () => {
    const session = storage();
    const old = createAgentUnsentQueueStore(session);
    old.getState().add("target", { id: "original", text: "Keep this" });
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    const migrated = createAgentUnsentQueueStore(broken, session);
    expect(migrated.getState().byTarget.target?.[0]?.id).toBe("original");
    expect(session.getItem("t3code:meerkat-unsent-queue:v1")).not.toBeNull();
    expect(migrated.getState().add("target", { id: "new", text: "Not durable" })).toBe(false);
    expect(
      createAgentUnsentQueueStore().getState().add("target", { id: "new", text: "Not durable" }),
    ).toBe(false);
  });
  it("does not replace an unreadable saved queue with a new empty queue", () => {
    const durable = storage();
    const key = "t3code:meerkat-unsent-queue:v1";
    durable.setItem(key, "{broken");
    const store = createAgentUnsentQueueStore(durable);
    expect(store.getState().add("target", { id: "new", text: "Keep original evidence" })).toBe(
      false,
    );
    expect(durable.getItem(key)).toBe("{broken");
  });
  it("preserves other windows' staging rows and never resurrects a removed import", () => {
    const durable = storage();
    const first = createAgentUnsentQueueStore(durable);
    const second = createAgentUnsentQueueStore(durable);
    first.getState().add("first-target", { id: "first", text: "First" });
    second.getState().add("second-target", { id: "second", text: "Second" });
    expect(second.getState().readTarget("first-target")).toEqual([{ id: "first", text: "First" }]);
    second.getState().add("first-target", { id: "later", text: "Later" });
    expect(first.getState().remove("first-target", "first")).toBe(true);
    second.getState().edit("first-target", "later", "Latest");
    expect(first.getState().readTarget("first-target")).toEqual([{ id: "later", text: "Latest" }]);
    expect(createAgentUnsentQueueStore(durable).getState().byTarget).toEqual({
      "first-target": [{ id: "later", text: "Latest" }],
      "second-target": [{ id: "second", text: "Second" }],
    });
  });
});

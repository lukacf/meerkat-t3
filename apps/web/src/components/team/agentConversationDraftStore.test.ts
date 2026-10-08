import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  agentConversationDraftKey,
  createAgentConversationDraftStore,
  findAgentSendAttempt,
} from "./agentConversationDraftStore";

function memoryStorage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
}
const target = {
  environmentId: EnvironmentId.make("environment"),
  projectId: ProjectId.make("project"),
  instanceId: ProviderInstanceId.make("meerkat"),
  identity: {
    kind: "native-agent" as const,
    durableId: "architect",
    agentRef: "architect-session",
  },
};

describe("agent draft failed write recovery", () => {
  it("retains unsaved mode changes when a later edit can be persisted", () => {
    const durable = memoryStorage();
    let fail = false;
    const storage = {
      ...durable,
      setItem: (key: string, value: string) => {
        if (fail) throw new Error("quota");
        durable.setItem(key, value);
      },
    };
    const store = createAgentConversationDraftStore(storage);
    store.getState().setText("target", "Original");
    fail = true;
    store.getState().setMode("target", "steer");
    fail = false;
    store.getState().setText("target", "Changed");
    expect(createAgentConversationDraftStore(durable).getState().byTarget.target).toMatchObject({
      text: "Changed",
      mode: "steer",
    });
  });
});

describe("agent conversation draft recovery", () => {
  it("reopens the same target draft and uncertain request after navigation and reload", () => {
    const storage = memoryStorage();
    const key = agentConversationDraftKey(target);
    const firstView = createAgentConversationDraftStore(storage);
    firstView.getState().setText(key, "Check the runtime boundaries");
    firstView.getState().setMode(key, "steer");
    const attempt = firstView.getState().beginSend(key, () => "request-one")!;
    firstView.getState().finishSend(key, attempt.requestId);

    const reopenedView = createAgentConversationDraftStore(storage);
    expect(reopenedView.getState().byTarget[key]).toMatchObject({
      text: "Check the runtime boundaries",
      mode: "steer",
    });
    const createRequestId = vi.fn(() => "unwanted-duplicate");
    expect(reopenedView.getState().beginSend(key, createRequestId)?.requestId).toBe("request-one");
    expect(createRequestId).not.toHaveBeenCalled();
    expect(
      reopenedView.getState().byTarget[
        agentConversationDraftKey({
          ...target,
          identity: { ...target.identity, durableId: "worker" },
        })
      ],
    ).toBeUndefined();
    expect(
      reopenedView.getState().byTarget[
        agentConversationDraftKey({ ...target, projectId: ProjectId.make("other") })
      ],
    ).toBeUndefined();
  });

  it("blocks a second view while delivery is pending and clears only the acknowledged attempt", () => {
    const store = createAgentConversationDraftStore(memoryStorage());
    const key = agentConversationDraftKey(target);
    store.getState().setText(key, "First message");
    store.getState().beginSend(key, () => "first");
    expect(store.getState().beginSend(key, () => "duplicate")).toBeNull();
    store.getState().finishSend(key, "first");
    store.getState().setText(key, "Second message");
    store.getState().beginSend(key, () => "second");
    store.getState().acknowledge(key, "first");
    expect(store.getState().byTarget[key]?.text).toBe("Second message");
    expect(store.getState().byTarget[key]?.attempts.map((attempt) => attempt.requestId)).toEqual([
      "second",
    ]);
    store.getState().acknowledge(key, "second");
    expect(store.getState().byTarget[key]).toMatchObject({ text: "", attempts: [] });
  });

  it("retains an uncertain request while the user edits then returns to that message", () => {
    const store = createAgentConversationDraftStore(memoryStorage());
    const key = agentConversationDraftKey(target);
    store.getState().setText(key, "Original request");
    store.getState().beginSend(key, () => "original");
    store.getState().finishSend(key, "original");
    store.getState().setText(key, "Follow-up request");
    store.getState().beginSend(key, () => "follow-up");
    store.getState().finishSend(key, "follow-up");
    store.getState().setText(key, "Original request");
    expect(store.getState().beginSend(key, () => "duplicate")?.requestId).toBe("original");
  });
});

describe("agent queued delivery payload", () => {
  it("reuses an uncertain image-only request with its model and exact incarnation after reload", () => {
    const saved = memoryStorage();
    const store = createAgentConversationDraftStore(saved);
    const payload = {
      text: "",
      mode: "queue" as const,
      images: [
        {
          type: "image" as const,
          media_type: "image/png" as const,
          source: "blob" as const,
          blob_id: `sha256:${"b".repeat(64)}`,
        },
      ],
      modelSelection: { instanceId: target.instanceId, model: "model-a" },
      agentRef: "session-a",
      queueId: "queued-one",
    };
    const attempt = store.getState().beginSend("agent", () => "request-one", payload)!;
    store.getState().finishSend("agent", attempt.requestId);
    const restored = createAgentConversationDraftStore(saved);
    expect(restored.getState().beginSend("agent", () => "duplicate", payload)?.requestId).toBe(
      "request-one",
    );
    restored.getState().finishSend("agent", "request-one");
    const retried = restored
      .getState()
      .beginSend("agent", () => "changed-session", { ...payload, agentRef: "session-b" });
    expect(retried).toMatchObject({ requestId: "request-one", agentRef: "session-a" });
  });
  it("does not clear a matching new draft when a queued message is acknowledged", () => {
    const store = createAgentConversationDraftStore(memoryStorage());
    store.getState().setText("agent", "Same text");
    store.getState().beginSend("agent", () => "queued", {
      text: "Same text",
      mode: "queue",
      queueId: "queue-one",
    });
    store.getState().acknowledge("agent", "queued");
    expect(store.getState().byTarget.agent?.text).toBe("Same text");
    expect(store.getState().byTarget.agent?.attempts).toEqual([]);
  });
});

describe("cold restart delivery recovery", () => {
  it("migrates session state once and recovers the original request and native target without dispatch", () => {
    const session = memoryStorage();
    const durable = memoryStorage();
    const key = agentConversationDraftKey(target);
    const old = createAgentConversationDraftStore(session);
    old.getState().setText(key, "Review this");
    old.getState().setMode(key, "steer");
    old.getState().setModel(key, { instanceId: target.instanceId, model: "model-a" });
    const original = old.getState().beginSend(key, () => "original-request", {
      text: "Review this",
      mode: "steer",
      agentRef: "original-incarnation",
    });
    const migrated = createAgentConversationDraftStore(durable, session);
    expect(migrated.getState().byTarget[key]).toMatchObject({
      text: "Review this",
      mode: "steer",
      modelSelection: { model: "model-a" },
      attempts: [original],
    });
    expect(session.getItem("t3code:meerkat-agent-drafts:v1")).toBeNull();

    const restarted = createAgentConversationDraftStore(durable, memoryStorage());
    expect(restarted.getState().pendingByTarget).toEqual({});
    expect(
      findAgentSendAttempt(restarted.getState().byTarget[key]!.attempts, {
        text: " Review this ",
        mode: "steer",
        agentRef: "new-incarnation",
      }),
    ).toEqual(original);
    const allocate = vi.fn(() => "duplicate");
    expect(
      restarted.getState().beginSend(key, allocate, {
        text: "Review this",
        mode: "steer",
        agentRef: "new-incarnation",
      }),
    ).toEqual(original);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("does not revive acknowledged attempts from an uncleared legacy session copy", () => {
    const session = memoryStorage();
    const durable = memoryStorage();
    const old = createAgentConversationDraftStore(session);
    old.getState().setText("target", "Already delivered");
    old.getState().beginSend("target", () => "original");
    const staleSession = {
      ...session,
      removeItem: () => {
        throw new Error("read only");
      },
    };
    const migrated = createAgentConversationDraftStore(durable, staleSession);
    expect(migrated.getState().acknowledge("target", "original")).toBe(true);
    const reopened = createAgentConversationDraftStore(durable, staleSession);
    expect(reopened.getState().byTarget.target).toMatchObject({ text: "", attempts: [] });
  });

  it("does not authorize an unpersisted send or discard an unpersisted confirmation", () => {
    const durable = memoryStorage();
    let fail = false;
    const storage = {
      ...durable,
      setItem: (key: string, value: string) => {
        if (fail) throw new Error("quota");
        durable.setItem(key, value);
      },
    };
    const store = createAgentConversationDraftStore(storage);
    store.getState().setText("target", "Keep this draft");
    fail = true;
    expect(store.getState().beginSend("target", () => "not-sent")).toBeNull();
    expect(store.getState().byTarget.target).toMatchObject({
      text: "Keep this draft",
      attempts: [],
    });
    expect(store.getState().pendingByTarget.target).toBeUndefined();
    expect(store.getState().sendErrorByTarget.target).toContain("Could not save");

    fail = false;
    const sent = store.getState().beginSend("target", () => "sent")!;
    expect(sent.requestId).toBe("sent");
    fail = true;
    expect(store.getState().acknowledge("target", "sent")).toBe(false);
    expect(store.getState().byTarget.target?.attempts).toEqual([sent]);
    const restarted = createAgentConversationDraftStore(durable);
    expect(restarted.getState().byTarget.target?.attempts).toEqual([sent]);
    expect(store.getState().sendErrorByTarget.target).toContain("confirmation could not be saved");
  });

  it("keeps an unresolved native intent independent from caller mutations", () => {
    const store = createAgentConversationDraftStore(memoryStorage());
    const sent = store.getState().beginSend("target", () => "request", {
      text: "Original",
      mode: "queue",
      agentRef: "original-agent",
    })!;
    sent.text = "Changed";
    sent.agentRef = "new-agent";
    expect(store.getState().byTarget.target?.attempts[0]).toMatchObject({
      text: "Original",
      agentRef: "original-agent",
    });
  });

  it("requires writable storage for new submissions", () => {
    const store = createAgentConversationDraftStore();
    store.getState().setText("target", "Still visible");
    expect(store.getState().beginSend("target", () => "not-sent")).toBeNull();
    expect(store.getState().byTarget.target?.text).toBe("Still visible");
    const ignored = createAgentConversationDraftStore({ getItem: () => null, setItem: () => {} });
    ignored.getState().setText("target", "Also visible");
    expect(ignored.getState().beginSend("target", () => "silently-lost")).toBeNull();
  });

  it("does not overwrite unreadable recovery evidence or mint a replacement request", () => {
    const saved = memoryStorage();
    const key = "t3code:meerkat-agent-drafts:v1";
    saved.setItem(
      key,
      '{"target":{"text":"Original","mode":"queue","attempts":[{"requestId":"original","text":"Original","mode":"queue","images":"broken"}]}}',
    );
    const original = saved.getItem(key);
    const store = createAgentConversationDraftStore(saved);
    store.getState().setText("target", "New text");
    const allocate = vi.fn(() => "replacement");
    expect(store.getState().beginSend("target", allocate)).toBeNull();
    expect(allocate).not.toHaveBeenCalled();
    expect(store.getState().sendErrorByTarget.target).toContain("could not be read");
    expect(saved.getItem(key)).toBe(original);
  });

  it("preserves requests across two stale windows and applies changes to the latest target row", () => {
    const durable = memoryStorage();
    const first = createAgentConversationDraftStore(durable);
    const second = createAgentConversationDraftStore(durable);
    const attempt = first.getState().beginSend("first-target", () => "first-request", {
      text: "First",
      mode: "queue",
      agentRef: "native-a",
    })!;
    second.getState().setText("second-target", "Second");
    second.getState().setMode("first-target", "steer");
    expect(
      createAgentConversationDraftStore(durable).getState().byTarget["first-target"]?.attempts,
    ).toEqual([attempt]);
    expect(
      second.getState().findSendAttempt("first-target", {
        text: "First",
        mode: "queue",
        agentRef: "new-incarnation",
      }),
    ).toEqual(attempt);
    first.getState().acknowledge("first-target", attempt.requestId);
    second
      .getState()
      .setModel("first-target", { instanceId: target.instanceId, model: "new-model" });
    const restored = createAgentConversationDraftStore(durable);
    expect(restored.getState().byTarget["first-target"]?.attempts).toEqual([]);
    expect(restored.getState().byTarget["second-target"]?.text).toBe("Second");
  });
});

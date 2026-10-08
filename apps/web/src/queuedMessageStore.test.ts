import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ComposerContextId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MeerkatCoordinatorSteer,
} from "@t3tools/contracts";

import {
  COORDINATOR_DELIVERY_STORAGE_KEY,
  createQueuedMessageStore,
  isQueuedMessageDue,
  checkQueuedCoordinatorDelivery,
  latestCompletedToolActivityId,
  takeQueuedMessageForDispatch,
  useQueuedMessageStore,
  type QueuedComposerMessage,
} from "./queuedMessageStore";
import { useComposerDraftStore } from "./composerDraftStore";

function makeMessage(prompt: string): Omit<QueuedComposerMessage, "id"> {
  return {
    prompt,
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    submissionIntent: "foreground",
    queuedAfterToolActivityId: null,
    createdAt: "2026-09-11T00:00:00.000Z",
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("queuedMessageStore", () => {
  beforeEach(() => {
    useQueuedMessageStore.setState({ queuesByThreadKey: {}, drainGenerationsByThreadKey: {} });
  });

  it("keeps messages in submission order per thread", () => {
    const { enqueue } = useQueuedMessageStore.getState();
    enqueue("thread-a", makeMessage("first"));
    enqueue("thread-a", makeMessage("second"));
    enqueue("thread-b", makeMessage("other"));

    const queues = useQueuedMessageStore.getState().queuesByThreadKey;
    expect(queues["thread-a"]?.map((message) => message.prompt)).toEqual(["first", "second"]);
    expect(queues["thread-b"]?.map((message) => message.prompt)).toEqual(["other"]);
  });

  it("take hands the message to exactly one caller", () => {
    const { enqueue, take } = useQueuedMessageStore.getState();
    const entry = enqueue("thread-a", makeMessage("first"));

    expect(take("thread-a", entry.id, null)?.prompt).toBe("first");
    expect(take("thread-a", entry.id, null)).toBeNull();
    expect(useQueuedMessageStore.getState().queuesByThreadKey["thread-a"]).toBeUndefined();
  });

  it("take re-anchors the remaining messages to the current tool boundary", () => {
    const { enqueue, take } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    enqueue("thread-a", makeMessage("second"));

    take("thread-a", first.id, "tool-2");

    const [second] = useQueuedMessageStore.getState().queuesByThreadKey["thread-a"] ?? [];
    expect(second?.queuedAfterToolActivityId).toBe("tool-2");
    expect(
      isQueuedMessageDue({ message: second!, phase: "running", latestToolActivityId: "tool-2" }),
    ).toBe(false);
  });

  it("remove keeps the other messages' anchors", () => {
    const { enqueue, remove } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", { ...makeMessage("first"), queuedAfterToolActivityId: "t1" });
    const second = enqueue("thread-a", makeMessage("second"));

    expect(remove("thread-a", second.id)?.prompt).toBe("second");
    expect(remove("thread-a", second.id)).toBeNull();
    expect(useQueuedMessageStore.getState().queuesByThreadKey["thread-a"]).toEqual([first]);
  });

  it("holdAtFront returns a failed message to the head, held", () => {
    const { enqueue, take, holdAtFront } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    enqueue("thread-a", makeMessage("second"));
    const taken = take("thread-a", first.id, "t1")!;

    holdAtFront("thread-a", taken);

    const queue = useQueuedMessageStore.getState().queuesByThreadKey["thread-a"] ?? [];
    expect(queue.map((message) => message.prompt)).toEqual(["first", "second"]);
    expect(queue[0]?.holdUntilUserAction).toBe(true);
    expect(
      isQueuedMessageDue({ message: queue[0]!, phase: "ready", latestToolActivityId: null }),
    ).toBe(false);
  });

  it("drain empties one thread's queue in order", () => {
    const { enqueue, drain } = useQueuedMessageStore.getState();
    enqueue("thread-a", makeMessage("first"));
    enqueue("thread-a", makeMessage("second"));
    enqueue("thread-b", makeMessage("other"));

    expect(drain("thread-a").map((message) => message.prompt)).toEqual(["first", "second"]);
    expect(useQueuedMessageStore.getState().drainGenerationsByThreadKey).toEqual({ "thread-a": 1 });
    expect(drain("thread-a")).toEqual([]);
    expect(useQueuedMessageStore.getState().drainGenerationsByThreadKey).toEqual({ "thread-a": 2 });
    expect(useQueuedMessageStore.getState().queuesByThreadKey["thread-b"]).toHaveLength(1);
  });
});

describe("queued send cancellation", () => {
  it.each(["local:other-thread", "remote:thread"])(
    "Stop in local:thread does not cancel the deferred send from %s",
    async (sendingThreadKey) => {
      const store = createQueuedMessageStore();
      const message = store.getState().enqueue(sendingThreadKey, makeMessage("Send this"));
      store.getState().enqueue("local:thread", makeMessage("Stop this"));
      const pending = takeQueuedMessageForDispatch({
        store,
        threadKey: sendingThreadKey,
        messageId: message.id,
        toolActivityId: null,
      })!;
      const preparation = deferred();
      const dispatch = vi.fn(() => "sent");
      const result = preparation.promise.then(() => pending.dispatch(dispatch));

      store.getState().drain("local:thread");
      preparation.resolve();

      expect(await result).toEqual({ status: "dispatched", result: "sent" });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(store.getState().queuesByThreadKey[sendingThreadKey]).toBeUndefined();
    },
  );

  it("Stop cancels the last taken row and retains its complete snapshot for explicit retry", async () => {
    const store = createQueuedMessageStore();
    const file = new File(["image bytes"], "image.png", { type: "image/png" });
    const message = store.getState().enqueue("local:thread", {
      ...makeMessage("Keep exactly this text\nincluding this line"),
      images: [
        {
          type: "image",
          id: "image",
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          previewUrl: "blob:original-preview",
          file,
        },
      ],
    });
    const pending = takeQueuedMessageForDispatch({
      store,
      threadKey: "local:thread",
      messageId: message.id,
      toolActivityId: null,
    })!;
    const upload = deferred();
    const dispatch = vi.fn();
    const result = upload.promise.then(() => pending.dispatch(dispatch));
    expect(store.getState().queuesByThreadKey["local:thread"]).toBeUndefined();
    expect(store.getState().drain("local:thread")).toEqual([]);
    upload.resolve();

    expect(await result).toEqual({ status: "cancelled" });
    expect(dispatch).not.toHaveBeenCalled();
    const held = store.getState().queuesByThreadKey["local:thread"]![0]!;
    expect(held).toEqual({ ...message, holdUntilUserAction: true });
    expect(held.images[0]?.file).toBe(file);
    expect(isQueuedMessageDue({ message: held, phase: "ready", latestToolActivityId: null })).toBe(
      false,
    );

    const retry = takeQueuedMessageForDispatch({
      store,
      threadKey: "local:thread",
      messageId: message.id,
      toolActivityId: null,
    })!;
    expect(retry.dispatch(dispatch).status).toBe("dispatched");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("rechecks at dispatch when Stop follows an earlier preparation check", async () => {
    const store = createQueuedMessageStore();
    const message = store.getState().enqueue("local:thread", makeMessage("After preparation"));
    const pending = takeQueuedMessageForDispatch({
      store,
      threadKey: "local:thread",
      messageId: message.id,
      toolActivityId: null,
    })!;
    expect(pending.restoreIfCancelled()).toBe(false);
    const settingsWrite = deferred();
    const dispatch = vi.fn();
    const result = settingsWrite.promise.then(() => pending.dispatch(dispatch));
    store.getState().drain("local:thread");
    settingsWrite.resolve();

    expect(await result).toEqual({ status: "cancelled" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.getState().queuesByThreadKey["local:thread"]).toEqual([
      { ...message, holdUntilUserAction: true },
    ]);
  });

  it("retains a cancelled send only in its origin queue while another composer is edited", async () => {
    const origin = scopeThreadRef(EnvironmentId.make("queue-origin"), ThreadId.make("thread"));
    const other = scopeThreadRef(EnvironmentId.make("queue-other"), ThreadId.make("thread"));
    const drafts = useComposerDraftStore.getState();
    drafts.setPrompt(origin, "Unsent original draft");
    drafts.setPrompt(other, "Other draft");
    const store = createQueuedMessageStore();
    const message = store
      .getState()
      .enqueue(scopedThreadKey(origin), makeMessage("Queued original"));
    const pending = takeQueuedMessageForDispatch({
      store,
      threadKey: scopedThreadKey(origin),
      messageId: message.id,
      toolActivityId: null,
    })!;
    const preparation = deferred();
    const dispatch = vi.fn();
    const result = preparation.promise.then(() => pending.dispatch(dispatch));
    store.getState().drain(scopedThreadKey(origin));
    drafts.setPrompt(other, "New text after navigation");
    preparation.resolve();

    expect(await result).toEqual({ status: "cancelled" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getComposerDraft(origin)?.prompt).toBe(
      "Unsent original draft",
    );
    expect(useComposerDraftStore.getState().getComposerDraft(other)?.prompt).toBe(
      "New text after navigation",
    );
    expect(store.getState().queuesByThreadKey).toEqual({
      [scopedThreadKey(origin)]: [{ ...message, holdUntilUserAction: true }],
    });
  });
});

describe("queued message dispatch timing", () => {
  const activities = [
    { id: "a1", kind: "tool.started", sequence: 1, createdAt: "2026-01-01T00:00:01Z" },
    { id: "a2", kind: "tool.completed", sequence: 2, createdAt: "2026-01-01T00:00:02Z" },
    { id: "a3", kind: "tool.updated", sequence: 3, createdAt: "2026-01-01T00:00:03Z" },
  ];

  it("finds the newest completed tool call by sequence, not position", () => {
    expect(latestCompletedToolActivityId(activities)).toBe("a2");
    expect(latestCompletedToolActivityId([])).toBeNull();
    expect(
      latestCompletedToolActivityId([
        { id: "late", kind: "tool.completed", sequence: 9, createdAt: "2026-01-01T00:00:09Z" },
        { id: "early", kind: "tool.completed", sequence: 4, createdAt: "2026-01-01T00:00:04Z" },
      ]),
    ).toBe("late");
  });

  it("waits mid-turn until a tool call finishes after the message was queued", () => {
    const message = { queuedAfterToolActivityId: "a2" };
    expect(isQueuedMessageDue({ message, phase: "running", latestToolActivityId: "a2" })).toBe(
      false,
    );
    expect(isQueuedMessageDue({ message, phase: "running", latestToolActivityId: "a4" })).toBe(
      true,
    );
  });

  it("never auto-sends a message held for user action", () => {
    const message = { queuedAfterToolActivityId: null, holdUntilUserAction: true };
    expect(isQueuedMessageDue({ message, phase: "ready", latestToolActivityId: "a4" })).toBe(false);
  });

  it("is due as soon as the turn is over, but not while a send is connecting", () => {
    const message = { queuedAfterToolActivityId: "a2" };
    expect(isQueuedMessageDue({ message, phase: "ready", latestToolActivityId: "a2" })).toBe(true);
    expect(isQueuedMessageDue({ message, phase: "connecting", latestToolActivityId: "a4" })).toBe(
      false,
    );
  });
});

function noticeStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("uncertain coordinator delivery", () => {
  const original: MeerkatCoordinatorSteer = {
    projectId: ProjectId.make("p"),
    instanceId: ProviderInstanceId.make("native"),
    threadId: ThreadId.make("thread"),
    sessionId: "old-session",
    inputId: "old-input",
    nativeRunId: "old-run",
    message: {
      messageId: MessageId.make("original-message"),
      text: "Review once",
      attachments: [],
    },
    createdAt: "2026-09-28T10:00:00.000Z",
  };
  it("checks the same prepared request after native work ends without creating a new send", async () => {
    const store = createQueuedMessageStore(noticeStorage());
    const message: QueuedComposerMessage = {
      ...makeMessage("Review once"),
      id: "row",
      nativeSteeringRequest: original,
    };
    store.getState().holdAtFront("scope:thread", message);
    expect(isQueuedMessageDue({ message, phase: "ready", latestToolActivityId: null })).toBe(false);
    const requests: MeerkatCoordinatorSteer[] = [];
    let accepted = false;
    const check = async (request: MeerkatCoordinatorSteer) => {
      requests.push(request);
      return {
        status: accepted ? ("accepted" as const) : ("uncertain" as const),
        requestId: "original",
        receipt: null,
        message: null,
      };
    };
    await checkQueuedCoordinatorDelivery({ threadKey: "scope:thread", message, check, store });
    expect(store.getState().queuesByThreadKey["scope:thread"]).toHaveLength(1);
    accepted = true;
    await checkQueuedCoordinatorDelivery({ threadKey: "scope:thread", message, check, store });
    expect(requests).toEqual([
      { ...original, receiptOnly: true },
      { ...original, receiptOnly: true },
    ]);
    expect(store.getState().queuesByThreadKey["scope:thread"]).toBeUndefined();
  });
  it("keeps the row on a failed lookup and never removes a replacement row after a late result", async () => {
    const store = createQueuedMessageStore(noticeStorage());
    const message: QueuedComposerMessage = {
      ...makeMessage("Review once"),
      id: "row",
      nativeSteeringRequest: original,
    };
    store.getState().holdAtFront("scope:thread", message);
    await expect(
      checkQueuedCoordinatorDelivery({
        threadKey: "scope:thread",
        store,
        message,
        check: async () => {
          throw Error("Disconnected");
        },
      }),
    ).rejects.toThrow("Disconnected");
    const replacement = {
      ...message,
      nativeSteeringRequest: { ...original, sessionId: "replacement" },
    };
    await checkQueuedCoordinatorDelivery({
      threadKey: "scope:thread",
      store,
      message,
      check: async () => {
        store.getState().holdAtFront("scope:thread", replacement);
        return { status: "accepted", requestId: "original", receipt: null, message: null };
      },
    });
    expect(store.getState().queuesByThreadKey["scope:thread"]?.[0]?.nativeSteeringRequest).toBe(
      replacement.nativeSteeringRequest,
    );
  });
  it("recovers in-flight submissions across client closure as receipt-only notices", async () => {
    const storage = noticeStorage();
    const store = createQueuedMessageStore(storage);
    const message: QueuedComposerMessage = {
      ...makeMessage("Review once"),
      id: "row",
      nativeSteeringRequest: original,
    };
    // ChatView persists before calling native send, so this also models closing
    // while the native request is pending, before its reply can be handled.
    store.getState().holdAtFront("scope:thread", message);
    store.getState().enqueue("scope:thread", makeMessage("Unsent next message"));
    const reopened = createQueuedMessageStore(storage);
    const recovered = reopened.getState().queuesByThreadKey["scope:thread"]![0]!;
    expect(reopened.getState().queuesByThreadKey["scope:thread"]).toHaveLength(1);
    expect(recovered.nativeSteeringRequest).toEqual(original);
    expect(
      isQueuedMessageDue({ message: recovered, phase: "ready", latestToolActivityId: "next" }),
    ).toBe(false);
    expect(reopened.getState().take("scope:thread", recovered.id, "next")).toBeNull();
    expect(
      takeQueuedMessageForDispatch({
        store: reopened,
        threadKey: "scope:thread",
        messageId: recovered.id,
        toolActivityId: "next",
      }),
    ).toBeNull();
    reopened.getState().enqueue("scope:thread", makeMessage("Not submitted"));
    expect(
      reopened
        .getState()
        .drain("scope:thread")
        .map((entry) => entry.prompt),
    ).toEqual(["Not submitted"]);
    expect(
      createQueuedMessageStore(storage).getState().queuesByThreadKey["scope:thread"],
    ).toHaveLength(1);
    const checked: MeerkatCoordinatorSteer[] = [];
    await checkQueuedCoordinatorDelivery({
      threadKey: "scope:thread",
      message: recovered,
      store: reopened,
      check: async (request) => {
        checked.push(request);
        return { status: "accepted", requestId: "original", receipt: null, message: null };
      },
    });
    expect(checked).toEqual([{ ...original, receiptOnly: true }]);
    expect(createQueuedMessageStore(storage).getState().queuesByThreadKey).toEqual({});
  });
  it("cancels an unsent row without changing the persisted native delivery notice", async () => {
    const storage = noticeStorage();
    const store = createQueuedMessageStore(storage);
    const notice = { ...makeMessage("Submitted"), id: "notice", nativeSteeringRequest: original };
    store.getState().holdAtFront("scope:thread", notice);
    const saved = storage.getItem(COORDINATOR_DELIVERY_STORAGE_KEY);
    const message = store.getState().enqueue("scope:thread", makeMessage("Not submitted"));
    const pending = takeQueuedMessageForDispatch({
      store,
      threadKey: "scope:thread",
      messageId: message.id,
      toolActivityId: null,
    })!;
    const preparation = deferred();
    const dispatch = vi.fn();
    const result = preparation.promise.then(() => pending.dispatch(dispatch));
    expect(store.getState().drain("scope:thread")).toEqual([]);
    preparation.resolve();

    expect(await result).toEqual({ status: "cancelled" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(storage.getItem(COORDINATOR_DELIVERY_STORAGE_KEY)).toBe(saved);
    expect(store.getState().queuesByThreadKey["scope:thread"]).toEqual([
      { ...message, holdUntilUserAction: true },
      { ...notice, holdUntilUserAction: true },
    ]);
    expect(
      createQueuedMessageStore(storage).getState().queuesByThreadKey["scope:thread"]?.[0]
        ?.nativeSteeringRequest,
    ).toEqual(original);
  });
  it("keeps colliding thread ids isolated by environment and preserves original project/provider/session", async () => {
    const storage = noticeStorage();
    const store = createQueuedMessageStore(storage);
    const other = {
      ...original,
      projectId: ProjectId.make("other-project"),
      instanceId: ProviderInstanceId.make("other-native"),
      sessionId: "other-session",
    };
    store.getState().holdAtFront("first:thread", {
      ...makeMessage("First"),
      id: "same",
      nativeSteeringRequest: original,
    });
    store.getState().holdAtFront("second:thread", {
      ...makeMessage("Second"),
      id: "same",
      nativeSteeringRequest: other,
    });
    const reopened = createQueuedMessageStore(storage);
    const first = reopened.getState().queuesByThreadKey["first:thread"]![0]!;
    const second = reopened.getState().queuesByThreadKey["second:thread"]![0]!;
    expect(first.nativeSteeringRequest).toEqual(original);
    expect(second.nativeSteeringRequest).toEqual(other);
    let called = false;
    await expect(
      checkQueuedCoordinatorDelivery({
        threadKey: "second:thread",
        message: first,
        store: reopened,
        check: async () => {
          called = true;
          throw Error("Must not look up another environment");
        },
      }),
    ).rejects.toThrow("original environment");
    expect(called).toBe(false);
    reopened.getState().remove("first:thread", first.id);
    expect(
      createQueuedMessageStore(storage).getState().queuesByThreadKey["second:thread"]![0]!
        .nativeSteeringRequest,
    ).toEqual(other);
    expect(() => reopened.getState().holdAtFront("first:wrong-thread", first)).toThrow(
      "original environment and thread",
    );
  });
  it("preserves prepared attachments and contexts without persisting File or preview handles", () => {
    const storage = noticeStorage();
    const store = createQueuedMessageStore(storage);
    const inline = {
      type: "image" as const,
      id: "inline-image",
      name: "inline.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,YWJj",
    };
    const file = {
      type: "file" as const,
      id: "uploaded-file",
      name: "source.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
    };
    const request: MeerkatCoordinatorSteer = {
      ...original,
      message: {
        ...original.message,
        attachments: [inline, file],
        context: {
          version: 1,
          records: [
            {
              version: 1,
              kind: "terminal",
              contextId: ComposerContextId.make("term-context"),
              label: "Output",
              terminalId: "terminal",
              terminalLabel: "Shell",
              lineStart: 0,
              lineEnd: 1,
              text: "Original terminal context",
            },
          ],
        },
      },
    };
    store.getState().holdAtFront("scope:thread", {
      ...makeMessage("Attachments"),
      id: "row",
      nativeSteeringRequest: request,
      images: [
        {
          ...inline,
          id: "preview",
          previewUrl: "blob:private-preview",
          file: new File(["raw-private-composer-bytes"], "source.png"),
        },
      ],
      files: [{ ...file, file: new File(["raw-private-file-bytes"], "source.txt") }],
    });
    const raw = storage.getItem(COORDINATOR_DELIVERY_STORAGE_KEY)!;
    expect(raw).toContain(inline.dataUrl);
    expect(raw).toContain("uploaded-file");
    expect(raw).not.toContain("blob:private-preview");
    expect(raw).not.toContain("raw-private");
    const reopened = createQueuedMessageStore(storage);
    const notice = reopened.getState().queuesByThreadKey["scope:thread"]![0]!;
    expect(notice.nativeSteeringRequest).toEqual(request);
    expect(notice.images).toEqual([]);
    expect(notice.files).toEqual([]);
  });
  it("rejects legacy or malformed identities without hiding valid notices", () => {
    const storage = noticeStorage();
    for (const raw of [
      "broken",
      JSON.stringify({
        version: 0,
        queuesByThreadKey: { "scope:thread": [{ ...makeMessage("Old") }] },
      }),
      JSON.stringify({ version: 2, notices: [] }),
    ]) {
      storage.setItem(COORDINATOR_DELIVERY_STORAGE_KEY, raw);
      expect(createQueuedMessageStore(storage).getState().queuesByThreadKey).toEqual({});
    }
    storage.setItem(
      COORDINATOR_DELIVERY_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        notices: [
          { environmentId: "scope", id: "row", prompt: "Good", request: original },
          {
            environmentId: "invalid:environment",
            id: "bad-scope",
            prompt: "Bad",
            request: original,
          },
          {
            environmentId: "scope",
            id: "bad",
            prompt: "Bad",
            request: { ...original, sessionId: "" },
          },
          { environmentId: "", id: "missing-scope", prompt: "Missing", request: original },
        ],
      }),
    );
    const restored = createQueuedMessageStore(storage).getState().queuesByThreadKey;
    expect(Object.keys(restored)).toEqual(["scope:thread"]);
    expect(restored["scope:thread"]?.map((row) => row.id)).toEqual(["row"]);
  });
  it("fails before publication if notice persistence is unavailable or full", () => {
    for (const storage of [
      undefined,
      {
        getItem: () => null,
        setItem: () => {
          throw Error("quota");
        },
      },
    ]) {
      const store = createQueuedMessageStore(storage);
      expect(() =>
        store.getState().holdAtFront("scope:thread", {
          ...makeMessage("Preserve"),
          id: "row",
          nativeSteeringRequest: original,
        }),
      ).toThrow("Could not save the delivery notice");
      expect(store.getState().queuesByThreadKey).toEqual({});
      // Ordinary unsent messages keep their established in-memory behavior.
      expect(store.getState().enqueue("scope:thread", makeMessage("Unsent")).prompt).toBe("Unsent");
    }
  });

  it("keeps the durable notice if storage fails when clearing a confirmed receipt", async () => {
    const values = noticeStorage();
    let full = false;
    const storage = {
      getItem: values.getItem,
      setItem: (key: string, value: string) => {
        if (full) throw Error("storage unavailable");
        values.setItem(key, value);
      },
    };
    const store = createQueuedMessageStore(storage);
    const message: QueuedComposerMessage = {
      ...makeMessage("Review once"),
      id: "row",
      nativeSteeringRequest: original,
    };
    store.getState().holdAtFront("scope:thread", message);
    full = true;
    await expect(
      checkQueuedCoordinatorDelivery({
        threadKey: "scope:thread",
        message,
        store,
        check: async () => ({
          status: "accepted",
          requestId: "original",
          receipt: null,
          message: null,
        }),
      }),
    ).rejects.toThrow("Could not save the delivery notice");
    expect(store.getState().queuesByThreadKey["scope:thread"]).toHaveLength(1);
    expect(
      createQueuedMessageStore(storage).getState().queuesByThreadKey["scope:thread"],
    ).toHaveLength(1);
    full = false;
    await checkQueuedCoordinatorDelivery({
      threadKey: "scope:thread",
      message,
      store,
      check: async () => ({
        status: "accepted",
        requestId: "original",
        receipt: null,
        message: null,
      }),
    });
    expect(createQueuedMessageStore(storage).getState().queuesByThreadKey).toEqual({});
  });
});

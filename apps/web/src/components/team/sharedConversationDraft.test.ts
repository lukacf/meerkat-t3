import type { SharedSpecialistSendInput, SharedWorkContext } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  deliverSharedRequest,
  readSharedDraft,
  saveSharedDraft,
  type SharedPendingRequest,
} from "./sharedConversationDraft";

const pending: SharedPendingRequest = {
  requestId: "alice-request",
  participantId: "alice",
  workspaceId: "workspace",
  contextVersion: null,
  text: "Review inventory migration",
  context: {
    contextId: "alice-context",
    checkoutId: "alice-checkout",
    source: { kind: "project_conversation" },
    objective: "Review inventory migration",
    revision: { branch: "feature/inventory", commit: "a".repeat(40), applicability: "branch" },
    paths: [],
    tags: [],
  },
};
const context: SharedWorkContext = {
  ...pending.context,
  contextVersion: "version-a",
  participantId: "alice",
  sharedProjectId: "catalog",
  updatedAt: "2026-10-16T12:00:00.000Z",
};
afterEach(() => vi.unstubAllGlobals());

describe("shared request retry binding", () => {
  it("persists the returned immutable context version before sending", async () => {
    const calls: string[] = [];
    const send = vi.fn(async () => {
      calls.push("send");
      return "accepted";
    });
    const persist = vi.fn((bound: SharedPendingRequest) => {
      calls.push("persist");
      expect(bound.contextVersion).toBe("version-a");
      return true;
    });
    await expect(
      deliverSharedRequest(pending, "inventory", {
        putContext: async () => {
          calls.push("context");
          return context;
        },
        persist,
        send,
      }),
    ).resolves.toBe("accepted");
    expect(calls).toEqual(["context", "persist", "send"]);
    expect(send).toHaveBeenCalledWith({
      specialistId: "inventory",
      requestId: "alice-request",
      contextId: "alice-context",
      contextVersion: "version-a",
      text: "Review inventory migration",
    });
  });

  it("retries the same bound request after a lost response without rereading a changed context", async () => {
    let retained = pending;
    const first = {
      putContext: vi.fn(async () => context),
      persist: (value: SharedPendingRequest) => {
        retained = value;
        return true;
      },
      send: vi.fn(async (_input: SharedSpecialistSendInput) => {
        throw new Error("connection lost");
      }),
    };
    await expect(deliverSharedRequest(pending, "inventory", first)).rejects.toThrow(
      "connection lost",
    );
    const putContext = vi.fn(async () => ({
      ...context,
      contextVersion: "version-b",
      revision: { ...context.revision, branch: "main", commit: "b".repeat(40) },
    }));
    const send = vi.fn(async (_input: SharedSpecialistSendInput) => "existing-request");
    await expect(
      deliverSharedRequest(retained, "inventory", { putContext, persist: () => true, send }),
    ).resolves.toBe("existing-request");
    expect(putContext).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[0]).toEqual(first.send.mock.calls[0]?.[0]);
    expect(retained.context.revision.branch).toBe("feature/inventory");
  });

  it("does not send if durable context binding fails", async () => {
    const send = vi.fn();
    await expect(
      deliverSharedRequest(pending, "inventory", {
        putContext: async () => context,
        persist: () => false,
        send,
      }),
    ).rejects.toThrow("could not be saved");
    expect(send).not.toHaveBeenCalled();
  });

  it.each([{ contextId: "bob-context" }, { participantId: "bob" }])(
    "does not send a response with mismatched identity %j",
    async (differentIdentity) => {
      const send = vi.fn();
      await expect(
        deliverSharedRequest(pending, "inventory", {
          putContext: async () => ({ ...context, ...differentIdentity }),
          persist: () => true,
          send,
        }),
      ).rejects.toThrow("different request context");
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("keeps a bound request across reloads and fails closed on a corrupt saved identity", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
    const value = {
      text: "A new unsent draft",
      pending: { ...pending, contextVersion: "version-a" },
    };
    expect(saveSharedDraft("draft", value)).toBe(true);
    expect(readSharedDraft("draft")).toEqual(value);
    store.set("draft", JSON.stringify({ text: "draft", pending: { requestId: "lost" } }));
    expect(() => readSharedDraft("draft")).toThrow();
  });
});

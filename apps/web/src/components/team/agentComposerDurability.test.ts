import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const durable = vi.hoisted(() => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  vi.stubGlobal("localStorage", storage);
  return storage;
});

import {
  COMPOSER_DRAFT_STORAGE_KEY,
  DraftId,
  flushComposerDraftPersistence,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { createAgentConversationDraftStore } from "./agentConversationDraftStore";
import { clearAcknowledgedAgentComposerDurably } from "./agentComposerContext";

const initial = useComposerDraftStore.getState();
afterEach(() => {
  vi.restoreAllMocks();
  useComposerDraftStore.setState(initial, true);
  flushComposerDraftPersistence();
});

describe("specialist acknowledged draft durability", () => {
  it("flushes the cleared composer before the immutable request can be retired", () => {
    const id = DraftId.make("native-durable-clear");
    useComposerDraftStore.getState().setPrompt(id, "Already delivered");
    expect(flushComposerDraftPersistence()).toBe(true);
    expect(durable.getItem(COMPOSER_DRAFT_STORAGE_KEY)).toContain("Already delivered");
    const requests = createAgentConversationDraftStore(durable);
    const original = requests.getState().beginSend("target", () => "original", {
      text: "Already delivered",
      mode: "queue",
      agentRef: "native-a",
    })!;
    expect(clearAcknowledgedAgentComposerDurably(id, original)).toBe(true);
    expect(durable.getItem(COMPOSER_DRAFT_STORAGE_KEY)).not.toContain("Already delivered");
    // A crash between cleanup and acknowledgement still leaves the original receipt key.
    const afterCrash = createAgentConversationDraftStore(durable);
    expect(afterCrash.getState().byTarget.target?.attempts).toEqual([original]);
    expect(afterCrash.getState().acknowledge("target", original.requestId)).toBe(true);
    expect(createAgentConversationDraftStore(durable).getState().byTarget.target?.attempts).toEqual(
      [],
    );
  });

  it("does not report a failed or silently dropped flush as durable cleanup", () => {
    const id = DraftId.make("native-failed-clear");
    useComposerDraftStore.getState().setPrompt(id, "Preserve recovery");
    expect(flushComposerDraftPersistence()).toBe(true);
    const saved = durable.getItem(COMPOSER_DRAFT_STORAGE_KEY);
    const write = vi.spyOn(durable, "setItem").mockImplementation(() => {});
    expect(clearAcknowledgedAgentComposerDurably(id, { text: "Preserve recovery" })).toBe(false);
    expect(durable.getItem(COMPOSER_DRAFT_STORAGE_KEY)).toBe(saved);
    write.mockImplementation(() => {
      throw new Error("quota");
    });
    expect(clearAcknowledgedAgentComposerDurably(id, { text: "Preserve recovery" })).toBe(false);
    write.mockRestore();
    expect(clearAcknowledgedAgentComposerDurably(id, { text: "Preserve recovery" })).toBe(true);
    expect(durable.getItem(COMPOSER_DRAFT_STORAGE_KEY)).not.toContain("Preserve recovery");
  });

  it("persists later edits without clearing them when an older request is confirmed", () => {
    const id = DraftId.make("native-later-edit");
    useComposerDraftStore.getState().setPrompt(id, "A later task");
    expect(clearAcknowledgedAgentComposerDurably(id, { text: "Earlier task" })).toBe(true);
    expect(useComposerDraftStore.getState().getComposerDraft(id)?.prompt).toBe("A later task");
    expect(durable.getItem(COMPOSER_DRAFT_STORAGE_KEY)).toContain("A later task");
  });
});

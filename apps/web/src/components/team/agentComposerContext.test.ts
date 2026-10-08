import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  });
});
import { ThreadId } from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { extractMeerkatConsoleSkillSelections } from "@t3tools/shared/meerkatSkills";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { buildFileReviewComment } from "../../reviewCommentContext";
import {
  createAgentConversationDraftStore,
  useAgentConversationDraftStore,
} from "./agentConversationDraftStore";
import { createAgentUnsentQueueStore } from "./agentUnsentQueueStore";
import {
  clearAcknowledgedAgentComposer,
  migrateAgentComposerDraft,
  snapshotAgentComposer,
  updateAgentComposerPrompt,
  createRetainedAgentContext,
} from "./agentComposerContext";

const initialComposer = useComposerDraftStore.getState();
const initialAgent = useAgentConversationDraftStore.getState();
afterEach(() => {
  useComposerDraftStore.setState(initialComposer, true);
  useAgentConversationDraftStore.setState(initialAgent, true);
});
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
function selectedContext(id: DraftId) {
  const store = useComposerDraftStore.getState();
  store.setPrompt(id, "Review the failing worktree test.");
  store.addTerminalContext(id, {
    id: "shell-context",
    threadId: ThreadId.make("worker-a"),
    terminalId: "term-2",
    terminalLabel: "tests",
    lineStart: 7,
    lineEnd: 8,
    text: "FAIL worktree-a\nexpected 42",
    createdAt: "2026-09-28T13:00:00Z",
  });
  store.addReviewComment(
    id,
    buildFileReviewComment({
      id: "line-review",
      filePath: "src/worker.ts",
      startLine: 2,
      endLine: 3,
      text: "Check the return boundary",
      contents: "header\nreturn candidate;\nthrow unexpected;\nfooter",
    }),
  );
  return snapshotAgentComposer(useComposerDraftStore.getState().getComposerDraft(id));
}

describe("native composer context delivery", () => {
  it("retains the exact skill draft and context after steering refusal for a later new turn", () => {
    const id = DraftId.make("native-skill-rejected");
    selectedContext(id);
    const store = useComposerDraftStore.getState();
    const prompt = `${store.getComposerDraft(id)?.prompt}\nUse [review](meerkat-skill://b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64/review)`;
    store.setPrompt(id, prompt);
    const before = snapshotAgentComposer(store.getComposerDraft(id));
    expect(() => extractMeerkatConsoleSkillSelections(before.text, "steer")).toThrow(
      "Skills start with a new turn",
    );
    expect(snapshotAgentComposer(useComposerDraftStore.getState().getComposerDraft(id))).toEqual(
      before,
    );
    expect(before.context?.records.length).toBeGreaterThan(0);
    const queue = createAgentUnsentQueueStore(storage());
    queue.getState().add("target", { id: "skill-turn", ...before, sendWhenIdle: true });
    const queued = queue.getState().byTarget.target![0]!;
    expect(extractMeerkatConsoleSkillSelections(queued.text, "queue").skillReferences).toEqual([
      { source_uuid: "b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64", skill_name: "review" },
    ]);
    expect(queued.context).toEqual(before.context);
  });

  it("moves the old plain draft once without discarding workspace selections", () => {
    const id = DraftId.make("native-a");
    const selected = selectedContext(id);
    useAgentConversationDraftStore.getState().setText("old-key", "Existing unfinished task");
    migrateAgentComposerDraft("old-key", id);
    migrateAgentComposerDraft("old-key", id);
    const current = snapshotAgentComposer(useComposerDraftStore.getState().getComposerDraft(id));
    expect(current.text).toBe(`Existing unfinished task\n\n${selected.text}`);
    expect(current.context).toEqual(selected.context);
    expect(useAgentConversationDraftStore.getState().byTarget["old-key"]?.text).toBe("");
  });

  it("preserves exact code and terminal snapshots across queued edits, navigation and uncertain retries", () => {
    const id = DraftId.make("native-a");
    const snapshot = selectedContext(id);
    const queuedStorage = storage();
    const queue = createAgentUnsentQueueStore(queuedStorage);
    queue.getState().add("target-a", { id: "queued", ...snapshot, sendWhenIdle: true });
    clearAcknowledgedAgentComposer(id, snapshot);
    useComposerDraftStore.getState().setPrompt(id, "An unrelated later task");
    const restoredQueue = createAgentUnsentQueueStore(queuedStorage);
    restoredQueue.getState().edit("target-a", "queued", `Investigate this first. ${snapshot.text}`);
    const queued = restoredQueue.getState().byTarget["target-a"]![0]!;
    const attemptsStorage = storage();
    const attemptStore = createAgentConversationDraftStore(attemptsStorage);
    const original = attemptStore.getState().beginSend("target-a", () => "request-a", {
      ...queued,
      mode: "queue",
      queueId: queued.id,
      agentRef: "exact-runtime-a",
    })!;
    attemptStore.getState().finishSend("target-a", original.requestId);
    const restoredAttempts = createAgentConversationDraftStore(attemptsStorage);
    const { context: _context, ...queuedWithoutContext } = queued;
    const retried = restoredAttempts.getState().beginSend("target-a", () => "unwanted", {
      ...queuedWithoutContext,
      mode: "queue",
      queueId: queued.id,
      agentRef: "different-runtime",
    })!;
    expect(retried.requestId).toBe("request-a");
    expect(retried.agentRef).toBe("exact-runtime-a");
    expect(retried.context).toEqual(snapshot.context);
    const nativeText = projectComposerContextForProvider({
      text: retried.text,
      records: retried.context?.records ?? [],
    });
    expect(nativeText).toContain("FAIL worktree-a");
    expect(nativeText).toContain("expected 42");
    expect(nativeText).toContain("return candidate;");
    expect(nativeText).toContain("Check the return boundary");
    expect(nativeText).not.toContain("t3-context://");
    expect(restoredAttempts.getState().byTarget["target-b"]).toBeUndefined();
    expect(restoredQueue.getState().byTarget["target-b"]).toBeUndefined();
    expect(useComposerDraftStore.getState().getComposerDraft(id)?.prompt).toBe(
      "An unrelated later task",
    );
  });

  it("cannot alias a queued or pending context when live draft records change", () => {
    const snapshot = selectedContext(DraftId.make("native-a"));
    const queue = createAgentUnsentQueueStore(storage());
    const attempts = createAgentConversationDraftStore(storage());
    queue.getState().add("a", { id: "q", ...snapshot });
    attempts.getState().beginSend("a", () => "request", { ...snapshot, mode: "queue" });
    const terminal = snapshot.context!.records.find((record) => record.kind === "terminal")!;
    Object.assign(terminal, { text: "changed after enqueue" });
    expect(JSON.stringify(queue.getState().byTarget.a)).toContain("FAIL worktree-a");
    expect(JSON.stringify(attempts.getState().byTarget.a?.attempts)).toContain("FAIL worktree-a");
  });

  it("does not send deleted context chips or erase selections added before an acknowledgement", () => {
    const id = DraftId.make("native-a");
    const snapshot = selectedContext(id);
    useComposerDraftStore.getState().addReviewComment(
      id,
      buildFileReviewComment({
        id: "new-selection",
        filePath: "other.ts",
        startLine: 1,
        endLine: 1,
        text: "Next review",
        contents: "const next = 1;",
      }),
    );
    expect(clearAcknowledgedAgentComposer(id, snapshot)).toBe(false);
    useComposerDraftStore.getState().setPrompt(id, "Only this sentence");
    const plain = snapshotAgentComposer(useComposerDraftStore.getState().getComposerDraft(id));
    expect(plain).toEqual({ text: "Only this sentence" });
    expect(clearAcknowledgedAgentComposer(id, plain)).toBe(true);
    expect(useComposerDraftStore.getState().getComposerDraft(id)?.terminalContexts ?? []).toEqual(
      [],
    );
  });

  it("persists context deletion and restores payloads on editor undo without reviving removed chips", () => {
    const id = DraftId.make("native-a");
    const snapshot = selectedContext(id);
    const retained = createRetainedAgentContext();
    updateAgentComposerPrompt(id, "No selections now", retained);
    const deleted = useComposerDraftStore.getState().getComposerDraft(id)!;
    expect(deleted.terminalContexts).toEqual([]);
    expect(deleted.reviewComments).toEqual([]);
    updateAgentComposerPrompt(id, snapshot.text, retained);
    expect(snapshotAgentComposer(useComposerDraftStore.getState().getComposerDraft(id))).toEqual(
      snapshot,
    );
  });
});

import { afterEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { buildFileReviewComment } from "../../reviewCommentContext";
import { partializeComposerDraftStoreState, useComposerDraftStore } from "../../composerDraftStore";
import { agentWorkspaceDraftId, projectAgentWorkspaceDraftId } from "./agentWorkspaceContext";

const initial = useComposerDraftStore.getState();
afterEach(() => useComposerDraftStore.setState(initial, true));
const target = {
  environmentId: EnvironmentId.make("env-a"),
  projectId: ProjectId.make("project-a"),
  instanceId: ProviderInstanceId.make("meerkat"),
  identity: { kind: "native-agent" as const, durableId: "reviewer", agentRef: "reviewer-session" },
};

describe("native workspace context", () => {
  it("keeps exact selected code and terminal content isolated from coordinator and other agents", () => {
    const reviewer = agentWorkspaceDraftId(target);
    const builder = agentWorkspaceDraftId({
      ...target,
      identity: { ...target.identity, durableId: "builder" },
    });
    const store = useComposerDraftStore.getState();
    store.addReviewComment(
      reviewer,
      buildFileReviewComment({
        id: "review-1",
        filePath: "src/main.ts",
        startLine: 2,
        endLine: 3,
        text: "Check this boundary",
        contents: "one\ntwo\nthree\nfour",
      }),
    );
    store.addTerminalContext(reviewer, {
      id: "terminal-1",
      threadId: ThreadId.make("worker-a"),
      terminalId: "term-1",
      terminalLabel: "tests",
      lineStart: 11,
      lineEnd: 12,
      text: "1 test failed\nexpected true",
      createdAt: "2026-09-28T12:00:00Z",
    });
    const review = useComposerDraftStore.getState().getComposerDraft(reviewer);
    expect(review?.reviewComments[0]).toMatchObject({
      filePath: "src/main.ts",
      diff: "two\nthree",
      rangeLabel: "L2 to L3",
    });
    expect(review?.terminalContexts[0]).toMatchObject({
      threadId: "worker-a",
      text: "1 test failed\nexpected true",
      lineStart: 11,
      lineEnd: 12,
    });
    expect(review?.prompt).toContain("t3-context:");
    expect(useComposerDraftStore.getState().getComposerDraft(builder)).toBeNull();
    expect(
      useComposerDraftStore.getState().getComposerDraft({
        environmentId: target.environmentId,
        threadId: ThreadId.make("worker-a"),
      }),
    ).toBeNull();
    const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());
    expect(persisted.draftsByThreadKey[reviewer]?.terminalContexts?.[0]?.text).toBe(
      "1 test failed\nexpected true",
    );
    expect(persisted.draftsByThreadKey[reviewer]?.reviewComments?.[0]?.diff).toBe("two\nthree");
  });

  it("stores project-shell snapshots without inventing a thread and deduplicates repeated selection", () => {
    const draftId = agentWorkspaceDraftId(target);
    const selection = {
      id: "project-output",
      terminalId: "project-shell-1",
      terminalLabel: "zsh",
      lineStart: 1,
      lineEnd: 2,
      text: "project test passed",
      createdAt: "2026-09-28T12:00:00Z",
    };
    useComposerDraftStore.getState().addTerminalContext(draftId, selection);
    useComposerDraftStore.getState().addTerminalContext(draftId, selection);
    const state = useComposerDraftStore.getState();
    expect(state.getComposerDraft(draftId)?.terminalContexts).toHaveLength(1);
    const persisted = partializeComposerDraftStoreState(state);
    expect(persisted.draftsByThreadKey[draftId]?.terminalContexts?.[0]).toMatchObject({
      text: "project test passed",
      terminalId: "project-shell-1",
    });
    expect(persisted.draftsByThreadKey[draftId]?.terminalContexts?.[0]?.threadId).toBeUndefined();
    const merge = useComposerDraftStore.persist.getOptions().merge!;
    // Exercise the actual persisted shape, identical to the donor hydration path.
    const direct = merge(persisted, initial);
    expect(direct.draftsByThreadKey[draftId]?.terminalContexts?.[0]?.text).toBe(
      "project test passed",
    );
  });

  it("keeps a project specialist draft stable while its native runtime is unloaded or recreated", () => {
    const saved = {
      environmentId: target.environmentId,
      projectId: target.projectId,
      instanceId: target.instanceId,
      agentId: "project-reviewer",
    };
    const unloaded = projectAgentWorkspaceDraftId(saved);
    const live = agentWorkspaceDraftId({
      ...target,
      identity: { kind: "project-agent", projectAgentId: saved.agentId },
    });
    const reloaded = agentWorkspaceDraftId({
      ...target,
      identity: { kind: "project-agent", projectAgentId: saved.agentId },
    });
    expect(live).toBe(unloaded);
    expect(reloaded).toBe(unloaded);
  });

  it("separates projects, environments, providers and native incarnations", () => {
    const keys = [
      target,
      { ...target, environmentId: EnvironmentId.make("env-b") },
      { ...target, projectId: ProjectId.make("project-b") },
      { ...target, instanceId: ProviderInstanceId.make("other") },
      { ...target, identity: { ...target.identity, durableId: "thread-worker" } },
      { ...target, identity: { ...target.identity, durableId: "builder" } },
    ].map(agentWorkspaceDraftId);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

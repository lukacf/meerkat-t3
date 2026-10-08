import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { agentConversationDraftKey, type AgentDraftScope } from "./agentDraftIdentity";
import { agentWorkspaceDraftId, projectAgentWorkspaceDraftId } from "./agentWorkspaceContext";
import { createAgentConversationDraftStore } from "./agentConversationDraftStore";
import { createAgentUnsentQueueStore } from "./agentUnsentQueueStore";
import { createNativeImageDraftStore, nativeImageDraftStorageKey } from "./nativeImageDraftStore";

const scope: AgentDraftScope = {
  environmentId: EnvironmentId.make("environment"),
  projectId: ProjectId.make("project"),
  instanceId: ProviderInstanceId.make("meerkat"),
};
const primary = {
  ...scope,
  identity: { kind: "project-agent" as const, projectAgentId: "architect" },
};
const worker = (durableId?: string, agentRef = "session-a") => ({
  ...scope,
  identity: { kind: "native-agent" as const, durableId, agentRef },
});
const memoryStorage = () => {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
};

describe("canonical agent draft identity", () => {
  it("isolates same-alias children and their primary specialist while following native durable identity", () => {
    const first = worker("source-a/worker");
    const second = worker("source-b/worker");
    expect(new Set([primary, first, second].map(agentConversationDraftKey)).size).toBe(3);
    expect(agentConversationDraftKey(first)).toBe(
      agentConversationDraftKey(worker("source-a/worker", "new-session")),
    );
    expect(agentConversationDraftKey(worker(undefined))).not.toBe(
      agentConversationDraftKey(worker(undefined, "new-session")),
    );
    expect(agentConversationDraftKey(worker("architect"))).not.toBe(
      agentConversationDraftKey(primary),
    );
  });

  it("scopes native identity to each environment, project and provider instance", () => {
    const target = worker("shared-native-id");
    const keys = [
      target,
      { ...target, environmentId: EnvironmentId.make("other-environment") },
      { ...target, projectId: ProjectId.make("other-project") },
      { ...target, instanceId: ProviderInstanceId.make("other-provider") },
    ].map(agentConversationDraftKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("uses the same primary composer before and after loading without granting helpers its identity", () => {
    const offline = projectAgentWorkspaceDraftId({ ...scope, agentId: "architect" });
    expect(agentWorkspaceDraftId(primary)).toBe(offline);
    expect(agentWorkspaceDraftId(worker("architect"))).not.toBe(offline);
  });

  it("retains old alias drafts, images, queues and immutable attempts without hydrating any new target", () => {
    const storage = memoryStorage();
    const oldKey = JSON.stringify([...Object.values(scope), "mob", "worker"]);
    const original = {
      requestId: "old-request",
      text: "Check this",
      mode: "queue",
      agentRef: "old-session",
    };
    storage.setItem(
      "t3code:meerkat-agent-drafts:v1",
      JSON.stringify({ [oldKey]: { text: "Check this", mode: "steer", attempts: [original] } }),
    );
    storage.setItem(
      "t3code:meerkat-unsent-queue:v1",
      JSON.stringify({ [oldKey]: [{ id: "queued", text: "Later" }] }),
    );
    const drafts = createAgentConversationDraftStore(storage);
    const queue = createAgentUnsentQueueStore(storage);
    const first = agentConversationDraftKey(worker("source-a/worker"));
    const second = agentConversationDraftKey(worker("source-b/worker"));
    expect(drafts.getState().byTarget[first]).toBeUndefined();
    expect(drafts.getState().byTarget[second]).toBeUndefined();
    expect(queue.getState().readTarget(first)).toEqual([]);
    expect(queue.getState().readTarget(second)).toEqual([]);
    const image = {
      type: "image",
      source: "blob",
      blob_id: `sha256:${"a".repeat(64)}`,
      media_type: "image/png",
    };
    const media = { ...scope, agentRef: "old-session" };
    const imageKey = nativeImageDraftStorageKey(media, oldKey);
    storage.setItem(imageKey, JSON.stringify([image]));
    const images = createNativeImageDraftStore(
      nativeImageDraftStorageKey(media, first),
      "unused",
      storage,
    );
    expect(images.getState().images).toEqual([]);
    drafts.getState().setMode(first, "queue");
    expect(drafts.getState().byTarget[oldKey]?.attempts).toEqual([original]);
    expect(queue.getState().readTarget(oldKey)).toEqual([{ id: "queued", text: "Later" }]);
    expect(storage.getItem(imageKey)).toBe(JSON.stringify([image]));
  });
});

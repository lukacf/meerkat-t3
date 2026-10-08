import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { agentConversationDraftKey, type AgentDraftScope } from "./agentDraftIdentity";
import {
  earlierAgentDeliveryInput,
  readEarlierAgentDrafts,
  readEarlierAgentSendAttempt,
} from "./earlierAgentDraftRecovery";
import { nativeImageDraftStorageKey } from "./nativeImageDraftStore";

const scope: AgentDraftScope = {
  environmentId: EnvironmentId.make("environment"),
  projectId: ProjectId.make("project"),
  instanceId: ProviderInstanceId.make("meerkat"),
};
const legacy = JSON.stringify([
  scope.environmentId,
  scope.projectId,
  scope.instanceId,
  "mob",
  "worker",
]);
const canonical = agentConversationDraftKey({
  ...scope,
  identity: { kind: "native-agent", durableId: "source-a/worker", agentRef: "new-session" },
});
const image = {
  type: "image" as const,
  source: "blob" as const,
  blob_id: `sha256:${"a".repeat(64)}`,
  media_type: "image/png" as const,
};
const attempt = {
  requestId: "original-request",
  text: "Review changes",
  mode: "queue" as const,
  agentRef: "original-session",
  queueId: "original-row",
  images: [image],
  modelSelection: { instanceId: scope.instanceId, model: "openai:test" },
};
const storage = (initial: Record<string, string> = {}) => {
  const entries = new Map(Object.entries(initial));
  return {
    get length() {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      entries.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      entries.delete(key);
    }),
    snapshot: () => [...entries],
  };
};
const savedDraft = { text: "Unfinished draft", mode: "steer", attempts: [attempt] };

describe("earlier saved agent drafts", () => {
  it("recovers all older storage shapes without promoting, deleting, or changing any source", () => {
    const local = storage({
      "t3code:meerkat-agent-drafts:v1": JSON.stringify({
        [legacy]: savedDraft,
        [canonical]: savedDraft,
      }),
      "t3code:meerkat-unsent-queue:v1": JSON.stringify({
        [legacy]: [{ id: "original-row", text: "Queued", images: [image], sendWhenIdle: true }],
        [canonical]: [{ id: "new-row", text: "Current" }],
      }),
      "t3code:composer-drafts:v1": JSON.stringify({
        state: {
          draftsByThreadKey: {
            [`native-agent:${legacy}`]: {
              prompt: "Old helper draft",
              terminalContexts: [{ text: "Selected output" }],
            },
            [`native-project-agent:${JSON.stringify([scope.environmentId, scope.projectId, scope.instanceId, "architect"])}`]:
              { prompt: "Old primary or inherited helper draft" },
            [`native-agent:${canonical}`]: { prompt: "Current draft" },
          },
        },
      }),
      [nativeImageDraftStorageKey({ ...scope, agentRef: "old-session" }, legacy)]: JSON.stringify([
        image,
      ]),
      [nativeImageDraftStorageKey({ ...scope, agentRef: "new-session" }, canonical)]:
        JSON.stringify([image]),
    });
    const session = storage({
      [`meerkat-image-draft:${JSON.stringify({ ...scope, agentRef: "original-session" })}`]:
        JSON.stringify([image]),
    });
    const before = [local.snapshot(), session.snapshot()];
    const result = readEarlierAgentDrafts(scope, { local, session });
    expect(result.errors).toEqual([]);
    expect(result.entries.map((entry) => entry.kind)).toEqual([
      "draft",
      "queue",
      "composer",
      "composer",
      "images",
      "images",
    ]);
    expect(result.entries.find((entry) => entry.kind === "draft")?.attempts).toEqual([attempt]);
    expect(
      result.entries.find((entry) => entry.kind === "images" && entry.source === "local")
        ?.imagePreview,
    ).toBeUndefined();
    expect(
      result.entries.find((entry) => entry.kind === "images" && entry.source === "session")
        ?.imagePreview,
    ).toEqual({ agentRef: "original-session", images: [image] });
    expect(JSON.stringify(result.entries)).not.toContain("Current draft");
    expect([local.snapshot(), session.snapshot()]).toEqual(before);
    expect(local.setItem).not.toHaveBeenCalled();
    expect(session.removeItem).not.toHaveBeenCalled();
  });

  it("does not expose another environment, project or provider's old data", () => {
    const local = storage({
      "t3code:meerkat-agent-drafts:v1": JSON.stringify({ [legacy]: savedDraft }),
    });
    for (const other of [
      { ...scope, environmentId: EnvironmentId.make("other") },
      { ...scope, projectId: ProjectId.make("other") },
      { ...scope, instanceId: ProviderInstanceId.make("other") },
    ])
      expect(readEarlierAgentDrafts(other, { local }).entries).toEqual([]);
  });

  it("re-reads exact original request data without mutating or retargeting it", () => {
    const local = storage({
      "t3code:meerkat-agent-drafts:v1": JSON.stringify({ [legacy]: savedDraft }),
    });
    const entry = readEarlierAgentDrafts(scope, { local }).entries[0]!;
    const before = local.snapshot();
    const original = readEarlierAgentSendAttempt(scope, { local }, entry, attempt.requestId)!;
    expect(earlierAgentDeliveryInput(scope, original)).toEqual({
      environmentId: scope.environmentId,
      input: {
        projectId: scope.projectId,
        instanceId: scope.instanceId,
        agentRef: "original-session",
        requestId: "original-request",
        text: attempt.text,
        handlingMode: "queue",
        images: [image],
        modelSelection: attempt.modelSelection,
      },
    });
    expect(
      readEarlierAgentSendAttempt(scope, { local }, entry, "different-request"),
    ).toBeUndefined();
    expect(local.snapshot()).toEqual(before);
    // A stale panel cannot resurrect a request removed by an earlier app window.
    local.setItem(
      "t3code:meerkat-agent-drafts:v1",
      JSON.stringify({ [legacy]: { ...savedDraft, attempts: [] } }),
    );
    expect(readEarlierAgentSendAttempt(scope, { local }, entry, attempt.requestId)).toBeUndefined();
    expect(
      earlierAgentDeliveryInput(scope, { requestId: "unattributed", text: "Old", mode: "queue" }),
    ).toBeNull();
  });

  it("reports unreadable data while preserving raw bytes and other readable sources", () => {
    const local = storage({
      "t3code:meerkat-agent-drafts:v1": "{corrupt",
      "t3code:meerkat-unsent-queue:v1": JSON.stringify({
        [legacy]: [{ id: "queued", text: "Keep this" }],
      }),
    });
    const before = local.snapshot();
    const result = readEarlierAgentDrafts(scope, { local });
    expect(result.errors).toHaveLength(1);
    expect(result.entries[0]?.kind).toBe("queue");
    expect(local.snapshot()).toEqual(before);
    expect(local.setItem).not.toHaveBeenCalled();
  });
});

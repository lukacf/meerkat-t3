import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MeerkatAttentionItem,
  type MeerkatTeamAgent,
  type MeerkatTeamProvider,
} from "@t3tools/contracts";
import {
  attentionLabel,
  attentionConversationTarget,
  matchingAttention,
  nativeAttentionDestination,
  validateNativeAttentionLocation,
} from "./meerkatAttention.logic";
export const attentionItem: MeerkatAttentionItem = {
  id: "question-id",
  projectId: ProjectId.make("project"),
  instanceId: ProviderInstanceId.make("native-provider"),
  agentRef: "exact-agent",
  sessionId: "exact-session",
  projectAgentId: "saved-agent",
  threadId: null,
  coordinator: false,
  label: "Reviewer",
  kind: "question",
  title: "Choose approach",
  detail: "Your answer is needed",
  question: null,
  completionStatus: null,
  active: true,
  unread: true,
  createdAt: "2026-09-28T12:00:00.000Z",
  updatedAt: "2026-09-28T12:00:00.000Z",
};
describe("native attention identity and priority", () => {
  it("navigates exact environment, project, instance and worker identity", () => {
    expect(nativeAttentionDestination(EnvironmentId.make("remote"), attentionItem)).toEqual({
      to: "/$environmentId/agents/$agentId",
      params: { environmentId: "remote", agentId: "saved-agent" },
      search: {
        project: "project",
        attention: "question-id",
        attentionInstance: "native-provider",
      },
    });
    expect(
      nativeAttentionDestination(EnvironmentId.make("remote"), {
        ...attentionItem,
        threadId: ThreadId.make("thread"),
      }),
    ).toEqual({
      to: "/$environmentId/$threadId",
      params: { environmentId: "remote", threadId: "thread" },
      search: {
        member: "exact-agent",
        attention: "question-id",
        attentionInstance: "native-provider",
      },
    });
  });
  it("preserves needs-input after reading and prioritizes failures before unread completion", () => {
    expect(attentionLabel([{ ...attentionItem, unread: false }])).toBe("Needs input");
    expect(attentionLabel([{ ...attentionItem, kind: "approval", unread: false }])).toBe(
      "Needs input",
    );
    expect(attentionLabel([{ ...attentionItem, kind: "query-error" }])).toBe("Needs attention");
    expect(attentionLabel([{ ...attentionItem, kind: "completion" }])).toBe("Unread");
    expect(attentionLabel([{ ...attentionItem, active: false, unread: false }])).toBeNull();
  });
  it("never marks replacement or foreign-instance activity as read", () => {
    expect(
      matchingAttention([attentionItem], "native-provider", "exact-agent", "exact-session"),
    ).toEqual([attentionItem]);
    expect(
      matchingAttention([attentionItem], "native-provider", "exact-agent", "replacement"),
    ).toEqual([]);
    expect(
      matchingAttention([attentionItem], "other-provider", "exact-agent", "exact-session"),
    ).toEqual([]);
    expect(validateNativeAttentionLocation({ attention: "id" })).toEqual({});
  });

  it("opens a completion's exact project agent even when saved transcript is not supplied", () => {
    const agent: MeerkatTeamAgent = {
      agentRef: "exact-agent",
      mobId: "domain",
      mobLabel: "Domain",
      mobKind: "project",
      scopeLabel: "Project",
      projectAgentId: "saved-agent",
      availability: "live",
      record: {
        identity: "architect",
        display_name: "Architect",
        runtime_key: "default",
        runtime_member_id: "architect",
        session_id: "exact-session",
        visibility: "addressable",
        addressable: true,
        health: "ready",
        labels: {},
      },
    };
    const provider: MeerkatTeamProvider = {
      instanceId: ProviderInstanceId.make("native-provider"),
      label: "Meerkat",
      status: "ready",
      errors: [],
      totalScopeCount: 1,
      unloadedScopeCount: 0,
      loadedMobCount: 1,
      agents: [agent],
    };
    const completion = { ...attentionItem, kind: "completion" as const };
    expect(attentionConversationTarget(completion, [provider])).toEqual({
      provider,
      agent,
      historical: false,
    });
    for (const wrong of [
      { ...agent, agentRef: "replacement" },
      { ...agent, projectAgentId: "other-owner" },
      { ...agent, record: { ...agent.record, session_id: "replacement" } },
    ]) {
      expect(
        attentionConversationTarget(completion, [{ ...provider, agents: [wrong] }]),
      ).toBeNull();
      expect(
        attentionConversationTarget(completion, [{ ...provider, agents: [] }], wrong),
      ).toBeNull();
    }
    expect(
      attentionConversationTarget(completion, [
        { ...provider, instanceId: ProviderInstanceId.make("another-provider") },
      ]),
    ).toBeNull();
    expect(attentionConversationTarget({ ...completion, sessionId: null }, [provider])).toBeNull();

    const historyProvider = { ...provider, agents: [] };
    const historical = { ...agent, availability: "retired" as const };
    expect(attentionConversationTarget(completion, [historyProvider], historical)).toEqual({
      provider: historyProvider,
      agent: historical,
      historical: true,
    });
    const worker = { ...agent, threadId: ThreadId.make("thread") };
    expect(
      attentionConversationTarget({ ...completion, threadId: ThreadId.make("thread") }, [
        { ...provider, agents: [worker] },
      ])?.agent,
    ).toBe(worker);
    expect(
      attentionConversationTarget({ ...completion, threadId: ThreadId.make("other-thread") }, [
        { ...provider, agents: [worker] },
      ]),
    ).toBeNull();
  });
});

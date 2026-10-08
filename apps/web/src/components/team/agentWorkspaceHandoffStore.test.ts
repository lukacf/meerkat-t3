import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  agentWorkspaceOriginDestination,
  agentWorkspaceOriginPath,
  createAgentWorkspaceHandoffStore,
  handoffKey,
  type AgentWorkspaceAttentionOrigin,
  type AgentWorkspaceHandoff,
} from "./agentWorkspaceHandoffStore";
import { validateNativeAttentionLocation } from "./meerkatAttention.logic";

const environmentId = EnvironmentId.make("remote");
const projectId = ProjectId.make("project");
const instanceId = ProviderInstanceId.make("native");
const helperOrigin: AgentWorkspaceAttentionOrigin = {
  kind: "project-agent-attention",
  environmentId,
  projectId,
  agentId: "reviewer/owner",
  attentionId: "completion/helper?one",
  instanceId,
  agentRef: "helper-one",
  sessionId: "session-one",
  label: "Review helper",
};
const record = (origin: AgentWorkspaceHandoff["origin"], host: string): AgentWorkspaceHandoff => ({
  purpose: "browser",
  origin,
  target: { projectId, instanceId, agentRef: "helper-one" },
  hostThreadId: ThreadId.make(host),
  cwd: "/repo",
  branch: "review",
});
const memoryStorage = (initial: AgentWorkspaceHandoff[] = []) => {
  let value = JSON.stringify(initial);
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
};

it("retains legacy primary and thread origins without inventing a helper identity", () => {
  const primary = record(
    { kind: "project-agent", environmentId, projectId, agentId: "reviewer", label: "Reviewer" },
    "primary-host",
  );
  const worker = record(
    {
      kind: "thread",
      environmentId,
      projectId,
      threadId: ThreadId.make("owner"),
      member: "worker/ref",
      label: "Worker",
    },
    "worker-host",
  );
  const store = createAgentWorkspaceHandoffStore(memoryStorage([primary, worker]));
  expect(store.getState().records).toEqual({
    [handoffKey(environmentId, primary.hostThreadId)]: primary,
    [handoffKey(environmentId, worker.hostThreadId)]: worker,
  });
  expect(agentWorkspaceOriginPath(primary.origin)).toBe("/remote/agents/reviewer?project=project");
  expect(agentWorkspaceOriginPath(worker.origin)).toBe("/remote/owner?member=worker%2Fref");
  expect(agentWorkspaceOriginDestination(worker.origin)).toEqual({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: "owner" },
    search: { member: "worker/ref" },
  });
});

it("preserves distinct helper sessions across reload and returns through the validated attention route", () => {
  const storage = memoryStorage();
  const first = createAgentWorkspaceHandoffStore(storage);
  const one = record(helperOrigin, "host-one");
  const two = {
    ...record(
      {
        ...helperOrigin,
        attentionId: "completion-two",
        agentRef: "helper-two",
        sessionId: "session-two",
      },
      "host-two",
    ),
    target: { projectId, instanceId, agentRef: "helper-two" },
  };
  first.getState().save(one);
  first.getState().save(two);
  const restored = createAgentWorkspaceHandoffStore(storage);
  expect(restored.getState().records[handoffKey(environmentId, one.hostThreadId)]).toEqual(one);
  expect(restored.getState().records[handoffKey(environmentId, two.hostThreadId)]).toEqual(two);
  expect(
    restored.getState().records[handoffKey(EnvironmentId.make("other"), one.hostThreadId)],
  ).toBeUndefined();
  const origin = restored.getState().records[handoffKey(environmentId, one.hostThreadId)]!.origin;
  const destination = agentWorkspaceOriginDestination(origin);
  expect(destination).toEqual({
    to: "/$environmentId/agents/$agentId",
    params: { environmentId, agentId: "reviewer/owner" },
    search: {
      project: projectId,
      attention: helperOrigin.attentionId,
      attentionInstance: instanceId,
    },
  });
  const path = agentWorkspaceOriginPath(origin);
  const url = new URL(path, "https://example.invalid");
  expect(url.pathname).toBe("/remote/agents/reviewer%2Fowner");
  expect(validateNativeAttentionLocation(Object.fromEntries(url.searchParams))).toEqual({
    attention: helperOrigin.attentionId,
    attentionInstance: instanceId,
  });
});

it("does not downgrade an incomplete saved helper origin to the primary specialist", () => {
  const storage = memoryStorage([record(helperOrigin, "helper-host")]);
  const incomplete = JSON.parse(storage.getItem()) as Array<{ origin: { sessionId?: string } }>;
  delete incomplete[0]!.origin.sessionId;
  storage.setItem("ignored", JSON.stringify(incomplete));
  expect(createAgentWorkspaceHandoffStore(storage).getState().records).toEqual({});
});

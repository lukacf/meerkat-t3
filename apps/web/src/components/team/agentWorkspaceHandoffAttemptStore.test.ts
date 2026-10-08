import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import {
  agentWorkspaceHandoffAttemptKey,
  createAgentWorkspaceHandoffAttemptStore,
  type AgentWorkspaceHandoffAttempt,
} from "./agentWorkspaceHandoffAttemptStore";

const record = {
  purpose: "delivery" as const,
  origin: {
    kind: "project-agent" as const,
    environmentId: EnvironmentId.make("remote"),
    projectId: ProjectId.make("project"),
    agentId: "reviewer",
    label: "Reviewer",
  },
  target: {
    projectId: ProjectId.make("project"),
    instanceId: ProviderInstanceId.make("native"),
    agentRef: "reviewer",
  },
  hostThreadId: ThreadId.make("original-thread"),
  cwd: "/repo",
  branch: "review",
};
const attempt: AgentWorkspaceHandoffAttempt = {
  record,
  command: {
    type: "thread.create",
    commandId: CommandId.make("native-workspace-handoff:original-thread"),
    threadId: record.hostThreadId,
    projectId: record.origin.projectId,
    title: "Delivery from Reviewer",
    modelSelection: {
      instanceId: record.target.instanceId,
      model: "model",
      options: [{ id: "reasoning_effort", value: "high" }],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: record.branch,
    worktreePath: null,
    createdAt: "2026-10-05T06:00:00.000Z",
  },
  prompt: "Original context",
  accepted: false,
  contextSaved: false,
};
const memoryStorage = () => {
  const rows = new Map<string, string>();
  return {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => {
      rows.set(key, value);
    },
  };
};
const key = agentWorkspaceHandoffAttemptKey(record);

it("locks the complete attempt across reload and a stale second view", () => {
  const storage = memoryStorage();
  const first = createAgentWorkspaceHandoffAttemptStore(key, storage);
  const stale = createAgentWorkspaceHandoffAttemptStore(key, storage);
  expect(first.getState().prepare(() => attempt)).toEqual(attempt);
  const allocate = vi.fn(() => ({ ...attempt, prompt: "Changed context" }));
  expect(stale.getState().prepare(allocate)).toEqual(attempt);
  expect(allocate).not.toHaveBeenCalled();
  expect(createAgentWorkspaceHandoffAttemptStore(key, storage).getState().attempt).toEqual(attempt);
  expect(stale.getState().accept(record.hostThreadId)).toBe(true);
  expect(first.getState().prepare(allocate)?.accepted).toBe(true);
  expect(allocate).not.toHaveBeenCalled();
});

it("isolates purpose, environment, owner and helper session without using mutable labels", () => {
  expect(
    agentWorkspaceHandoffAttemptKey({ ...record, origin: { ...record.origin, label: "Renamed" } }),
  ).toBe(key);
  expect(agentWorkspaceHandoffAttemptKey({ ...record, purpose: "browser" })).not.toBe(key);
  expect(
    agentWorkspaceHandoffAttemptKey({
      ...record,
      origin: { ...record.origin, environmentId: EnvironmentId.make("other") },
    }),
  ).not.toBe(key);
  const helper = {
    ...record,
    origin: {
      ...record.origin,
      kind: "project-agent-attention" as const,
      attentionId: "attention",
      instanceId: record.target.instanceId,
      agentRef: "helper",
      sessionId: "session",
    },
  };
  expect(agentWorkspaceHandoffAttemptKey(helper)).not.toBe(key);
  expect(
    agentWorkspaceHandoffAttemptKey({
      ...helper,
      origin: { ...helper.origin, sessionId: "other" },
    }),
  ).not.toBe(agentWorkspaceHandoffAttemptKey(helper));
});

it("blocks malformed or mismatched durable identity instead of replacing it with a new attempt", () => {
  const storage = memoryStorage();
  for (const value of [
    "not json",
    JSON.stringify({ ...attempt, command: { ...attempt.command, threadId: "different" } }),
    JSON.stringify({
      ...attempt,
      record: { ...record, origin: { ...record.origin, environmentId: "other" } },
    }),
  ]) {
    storage.setItem(key, value);
    const store = createAgentWorkspaceHandoffAttemptStore(key, storage);
    const allocate = vi.fn(() => attempt);
    expect(store.getState().prepare(allocate)).toBeNull();
    expect(allocate).not.toHaveBeenCalled();
    expect(storage.getItem(key)).toBe(value);
    expect(store.getState().error).toContain("Could not read");
  }
});

it("requires durable readback before admitting even an otherwise valid attempt", () => {
  const store = createAgentWorkspaceHandoffAttemptStore(key, {
    getItem: () => null,
    setItem: () => {},
  });
  expect(store.getState().prepare(() => attempt)).toBeNull();
  expect(store.getState().attempt).toBeNull();
  expect(store.getState().error).toContain("Could not save");
});

it("does not discard accepted identity when a later local progress write fails", () => {
  const storage = memoryStorage();
  const store = createAgentWorkspaceHandoffAttemptStore(key, storage);
  store.getState().prepare(() => attempt);
  expect(store.getState().accept(record.hostThreadId)).toBe(true);
  const failed = createAgentWorkspaceHandoffAttemptStore(key, {
    ...storage,
    setItem: () => {
      throw new Error("disk full");
    },
  });
  expect(failed.getState().markContextSaved(record.hostThreadId)).toBe(false);
  expect(createAgentWorkspaceHandoffAttemptStore(key, storage).getState().attempt).toMatchObject({
    accepted: true,
    contextSaved: false,
  });
});

it("retires only the fully recovered exact task and then allows another intentional handoff", () => {
  const storage = memoryStorage();
  const store = createAgentWorkspaceHandoffAttemptStore(key, storage);
  store.getState().prepare(() => attempt);
  expect(store.getState().complete(record.hostThreadId)).toBe(false);
  store.getState().markContextSaved(record.hostThreadId);
  expect(store.getState().complete(ThreadId.make("different"))).toBe(false);
  expect(store.getState().complete(record.hostThreadId)).toBe(true);
  expect(createAgentWorkspaceHandoffAttemptStore(key, storage).getState().attempt).toBeNull();
  const next: AgentWorkspaceHandoffAttempt = {
    ...attempt,
    record: { ...record, hostThreadId: ThreadId.make("next-thread") },
    command: {
      ...attempt.command,
      threadId: ThreadId.make("next-thread"),
      commandId: CommandId.make("native-workspace-handoff:next-thread"),
    },
  };
  expect(store.getState().prepare(() => next)).toEqual(next);
});

it("does not allocate another ID if a prepared identity disappears while its response is pending", () => {
  const storage = memoryStorage();
  const store = createAgentWorkspaceHandoffAttemptStore(key, storage);
  store.getState().prepare(() => attempt);
  storage.setItem(key, "null");
  expect(store.getState().accept(record.hostThreadId)).toBe(false);
  const allocate = vi.fn(() => attempt);
  expect(store.getState().prepare(allocate)).toBeNull();
  expect(allocate).not.toHaveBeenCalled();
  expect(store.getState().attempt?.record.hostThreadId).toBe(record.hostThreadId);
});

it("lets a mounted view follow confirmed completion without letting an old receipt retire newer work", () => {
  const storage = memoryStorage();
  const first = createAgentWorkspaceHandoffAttemptStore(key, storage);
  first.getState().prepare(() => attempt);
  const stale = createAgentWorkspaceHandoffAttemptStore(key, storage);
  const older = createAgentWorkspaceHandoffAttemptStore(key, storage);
  first.getState().markContextSaved(record.hostThreadId);
  expect(first.getState().complete(record.hostThreadId)).toBe(true);
  const next: AgentWorkspaceHandoffAttempt = {
    ...attempt,
    record: { ...record, hostThreadId: ThreadId.make("next-thread") },
    command: {
      ...attempt.command,
      threadId: ThreadId.make("next-thread"),
      commandId: CommandId.make("native-workspace-handoff:next-thread"),
    },
  };
  expect(stale.getState().prepare(() => next)).toEqual(next);
  expect(first.getState().complete(record.hostThreadId)).toBe(false);
  expect(createAgentWorkspaceHandoffAttemptStore(key, storage).getState().attempt).toEqual(next);
  stale.getState().markContextSaved(next.record.hostThreadId);
  expect(stale.getState().complete(next.record.hostThreadId)).toBe(true);
  // This view still remembers the first request, but another valid task completed later.
  expect(older.getState().refresh()).toBeNull();
  expect(older.getState().error).toBeNull();
  expect(older.getState().attempt).toBeNull();
});

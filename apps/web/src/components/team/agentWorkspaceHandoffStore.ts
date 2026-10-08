import {
  EnvironmentId,
  MeerkatMediaTarget,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { browserAgentDraftStorage, writeAgentDraftStorage } from "./agentDraftStorage";

const ProjectAgentAttentionOrigin = Schema.Struct({
  kind: Schema.Literal("project-agent-attention"),
  environmentId: EnvironmentId,
  projectId: ProjectId,
  agentId: Schema.String,
  attentionId: Schema.String,
  instanceId: ProviderInstanceId,
  agentRef: Schema.String,
  sessionId: Schema.String,
  label: Schema.String,
});
export type AgentWorkspaceAttentionOrigin = typeof ProjectAgentAttentionOrigin.Type;

const Origin = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project-agent"),
    environmentId: EnvironmentId,
    projectId: ProjectId,
    agentId: Schema.String,
    label: Schema.String,
  }),
  ProjectAgentAttentionOrigin,
  Schema.Struct({
    kind: Schema.Literal("thread"),
    environmentId: EnvironmentId,
    projectId: ProjectId,
    threadId: ThreadId,
    member: Schema.optional(Schema.String),
    label: Schema.String,
  }),
]);
export type AgentWorkspaceOrigin = typeof Origin.Type;
export const AgentWorkspaceHandoff = Schema.Struct({
  purpose: Schema.Literals(["browser", "delivery"]),
  origin: Origin,
  target: MeerkatMediaTarget,
  hostThreadId: ThreadId,
  cwd: Schema.String,
  branch: Schema.NullOr(Schema.String),
  context: Schema.optional(Schema.String),
});
export type AgentWorkspaceHandoff = typeof AgentWorkspaceHandoff.Type;
const decode = Schema.decodeUnknownSync(AgentWorkspaceHandoff);
const STORAGE_KEY = "t3code:native-workspace-handoffs:v1";
type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function handoffKey(environmentId: EnvironmentId, threadId: ThreadId) {
  return JSON.stringify([environmentId, threadId]);
}

export function agentWorkspaceOriginDestination(origin: AgentWorkspaceOrigin) {
  if (origin.kind === "thread") {
    return {
      to: "/$environmentId/$threadId" as const,
      params: { environmentId: origin.environmentId, threadId: origin.threadId },
      search: origin.member ? { member: origin.member } : {},
    };
  }
  return {
    to: "/$environmentId/agents/$agentId" as const,
    params: { environmentId: origin.environmentId, agentId: origin.agentId },
    search: {
      project: origin.projectId,
      ...(origin.kind === "project-agent-attention"
        ? { attention: origin.attentionId, attentionInstance: origin.instanceId }
        : {}),
    },
  };
}

export function agentWorkspaceOriginPath(origin: AgentWorkspaceOrigin): string {
  const environment = encodeURIComponent(origin.environmentId);
  const pathname =
    origin.kind === "thread"
      ? `/${environment}/${encodeURIComponent(origin.threadId)}`
      : `/${environment}/agents/${encodeURIComponent(origin.agentId)}`;
  const search = Object.entries(agentWorkspaceOriginDestination(origin).search)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `${pathname}${search ? `?${search}` : ""}`;
}

export function createAgentWorkspaceHandoffStore(storage?: StorageLike) {
  const records: Record<string, AgentWorkspaceHandoff> = {};
  try {
    const saved: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "[]");
    if (Array.isArray(saved)) {
      for (const value of saved) {
        try {
          const record = decode(value);
          records[handoffKey(record.origin.environmentId, record.hostThreadId)] = record;
        } catch {
          // A stale record never makes an unrelated workspace a browser host.
        }
      }
    }
  } catch {
    // The current session remains usable when local storage is unavailable.
  }
  return create<{
    records: Record<string, AgentWorkspaceHandoff>;
    save: (record: AgentWorkspaceHandoff) => void;
    saveContext: (record: AgentWorkspaceHandoff, context: string) => boolean;
    remove: (environmentId: EnvironmentId, threadId: ThreadId) => void;
  }>((set, get) => {
    const update = (
      change: (
        current: Record<string, AgentWorkspaceHandoff>,
      ) => Record<string, AgentWorkspaceHandoff>,
      requireDurable = false,
    ) => {
      let next = change(get().records);
      const durableStorage = storage ?? browserAgentDraftStorage("localStorage");
      try {
        if (!durableStorage) throw new Error("Local storage is unavailable.");
        const saved: unknown = JSON.parse(durableStorage.getItem(STORAGE_KEY) ?? "[]");
        if (!Array.isArray(saved)) throw new Error("The saved handoffs are invalid.");
        const durable: Record<string, AgentWorkspaceHandoff> = {};
        const opaque: unknown[] = [];
        for (const value of saved) {
          try {
            const row = decode(value);
            durable[handoffKey(row.origin.environmentId, row.hostThreadId)] = row;
          } catch {
            // Preserve unreadable legacy rows without letting them block another handoff.
            opaque.push(value);
          }
        }
        // A stale view must not discard another task's saved context on save or dismiss.
        next = change(durable);
        const values = Object.values(next);
        // Recovered context is user content. Only context-free navigation aids expire.
        const retained = [
          ...values.filter((record) => record.context !== undefined),
          ...values.filter((record) => record.context === undefined).slice(-50),
          ...opaque,
        ];
        if (!writeAgentDraftStorage(durableStorage, STORAGE_KEY, retained))
          throw new Error("Could not save handoffs.");
      } catch {
        // Ordinary source links remain usable in memory. Recovery must confirm durability.
        if (requireDurable) return false;
      }
      set({ records: next });
      return true;
    };
    return {
      records,
      save: (record) => {
        update((current) => ({
          ...current,
          [handoffKey(record.origin.environmentId, record.hostThreadId)]: {
            ...current[handoffKey(record.origin.environmentId, record.hostThreadId)],
            ...record,
          },
        }));
      },
      saveContext: (record, context) =>
        update(
          (current) => ({
            ...current,
            [handoffKey(record.origin.environmentId, record.hostThreadId)]: { ...record, context },
          }),
          true,
        ),
      remove: (environmentId, threadId) => {
        update((current) => {
          const next = { ...current };
          delete next[handoffKey(environmentId, threadId)];
          return next;
        });
      },
    };
  });
}

export const useAgentWorkspaceHandoffStore = createAgentWorkspaceHandoffStore(
  typeof localStorage === "undefined" ? undefined : localStorage,
);

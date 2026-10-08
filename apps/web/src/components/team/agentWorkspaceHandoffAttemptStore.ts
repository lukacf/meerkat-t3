import { ClientOrchestrationCommand, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { createStore } from "zustand/vanilla";
import {
  browserAgentDraftStorage,
  writeAgentDraftStorage,
  type AgentDraftStorage,
} from "./agentDraftStorage";
import { AgentWorkspaceHandoff } from "./agentWorkspaceHandoffStore";

export type AgentWorkspaceHandoffScope = Pick<AgentWorkspaceHandoff, "purpose" | "origin">;
type CreateCommand = Extract<ClientOrchestrationCommand, { type: "thread.create" }>;
export interface AgentWorkspaceHandoffAttempt {
  record: AgentWorkspaceHandoff;
  command: CreateCommand;
  prompt: string;
  accepted: boolean;
  contextSaved: boolean;
}

const SavedAttempt = Schema.Struct({
  record: AgentWorkspaceHandoff,
  command: ClientOrchestrationCommand,
  prompt: Schema.String,
  accepted: Schema.Boolean,
  contextSaved: Schema.Boolean,
});
const decode = Schema.decodeUnknownSync(SavedAttempt);
const CompletedAttempt = Schema.Struct({ status: Schema.Literal("completed"), threadId: ThreadId });
const decodeCompleted = Schema.decodeUnknownSync(CompletedAttempt);

/** Mutable model, label, context and checkout values cannot allocate another uncertain task. */
export function agentWorkspaceHandoffAttemptKey(scope: AgentWorkspaceHandoffScope) {
  const { origin } = scope;
  return `t3code:native-workspace-handoff-attempt:v1:${JSON.stringify([
    scope.purpose,
    origin.environmentId,
    origin.projectId,
    origin.kind,
    ...(origin.kind === "thread"
      ? [origin.threadId, origin.member ?? null]
      : origin.kind === "project-agent-attention"
        ? [origin.agentId, origin.attentionId, origin.instanceId, origin.agentRef, origin.sessionId]
        : [origin.agentId]),
  ])}`;
}

function readAttempt(value: string, key: string): AgentWorkspaceHandoffAttempt {
  const saved = decode(JSON.parse(value));
  const { record, command } = saved;
  if (
    command.type !== "thread.create" ||
    agentWorkspaceHandoffAttemptKey(record) !== key ||
    command.threadId !== record.hostThreadId ||
    command.commandId !== `native-workspace-handoff:${record.hostThreadId}` ||
    command.projectId !== record.origin.projectId ||
    command.projectId !== record.target.projectId ||
    command.modelSelection.instanceId !== record.target.instanceId ||
    command.branch !== record.branch ||
    (saved.contextSaved && !saved.accepted)
  )
    throw new Error("The saved handoff identity is inconsistent.");
  return { ...saved, command };
}

export function createAgentWorkspaceHandoffAttemptStore(
  key: string | null,
  storage: AgentDraftStorage | undefined = browserAgentDraftStorage("localStorage"),
) {
  const read = () => {
    if (!key) return null;
    if (!storage) throw new Error("Local recovery storage is unavailable.");
    const saved = storage.getItem(key);
    if (saved === null || saved === "null") return null;
    const value: unknown = JSON.parse(saved);
    if (typeof value === "object" && value !== null && "status" in value)
      return decodeCompleted(value);
    return readAttempt(saved, key);
  };
  let initial: AgentWorkspaceHandoffAttempt | null = null;
  let initialError: string | null = null;
  try {
    const saved = read();
    initial = saved && "record" in saved ? saved : null;
  } catch {
    initialError =
      "Could not read the saved workspace request. Restore local storage access before retrying.";
  }
  return createStore<{
    attempt: AgentWorkspaceHandoffAttempt | null;
    error: string | null;
    prepare: (build: () => AgentWorkspaceHandoffAttempt) => AgentWorkspaceHandoffAttempt | null;
    refresh: () => AgentWorkspaceHandoffAttempt | null;
    accept: (threadId: ThreadId) => boolean;
    markContextSaved: (threadId: ThreadId) => boolean;
    complete: (threadId: ThreadId) => boolean;
  }>((set, get) => {
    const fail = (message: string) => {
      set({ error: message });
      return null;
    };
    const readCurrent = () => {
      const saved = read();
      const previous = get().attempt;
      // A confirmed tombstone permits a new handoff from another still-mounted view.
      // Unexplained removal cannot erase a request whose outcome is still uncertain.
      if (saved && "status" in saved) {
        return null;
      }
      if (previous && saved === null)
        throw new Error("The saved workspace request changed in another window.");
      return saved;
    };
    const latest = () => {
      try {
        const attempt = readCurrent();
        set({ attempt, error: null });
        return attempt;
      } catch {
        return fail(
          "Could not read the saved workspace request. Restore local storage access before retrying.",
        );
      }
    };
    const write = (attempt: AgentWorkspaceHandoffAttempt) => {
      if (!key) return false;
      try {
        attempt = readAttempt(JSON.stringify(attempt), key);
      } catch {
        fail("Could not validate the saved workspace request. No new request was sent.");
        return false;
      }
      if (!writeAgentDraftStorage(storage, key, attempt)) {
        fail(
          "Could not save the workspace request locally. Keep this page open and retry after local storage is available.",
        );
        return false;
      }
      set({ attempt, error: null });
      return true;
    };
    const update = (
      threadId: ThreadId,
      patch: Partial<Pick<AgentWorkspaceHandoffAttempt, "accepted" | "contextSaved">>,
    ) => {
      const saved = latest();
      return saved?.record.hostThreadId === threadId && write({ ...saved, ...patch });
    };
    return {
      attempt: initial,
      error: initialError,
      refresh: latest,
      prepare: (build) => {
        let saved: AgentWorkspaceHandoffAttempt | null;
        try {
          saved = readCurrent();
        } catch {
          return fail(
            "Could not read the saved workspace request. Restore local storage access before retrying.",
          );
        }
        set({ attempt: saved, error: null });
        const attempt = saved ?? build();
        if (!write(attempt)) return null;
        const persisted = get().attempt;
        return persisted ? structuredClone(persisted) : null;
      },
      accept: (threadId) => update(threadId, { accepted: true }),
      markContextSaved: (threadId) => update(threadId, { accepted: true, contextSaved: true }),
      complete: (threadId) => {
        const saved = latest();
        if (
          !key ||
          saved?.record.hostThreadId !== threadId ||
          !saved.accepted ||
          !saved.contextSaved
        )
          return false;
        if (!writeAgentDraftStorage(storage, key, { status: "completed", threadId })) {
          fail(
            "The task opened, but its recovery record could not be cleared. Reopen the saved task before starting another handoff.",
          );
          return false;
        }
        set({ attempt: null, error: null });
        return true;
      },
    };
  });
}

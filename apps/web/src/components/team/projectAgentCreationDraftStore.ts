import type {
  EnvironmentId,
  MeerkatProjectAgent,
  MeerkatProjectAgentAccessMode,
  MeerkatProjectAgentCreateInput,
  ProjectId,
  ProviderInstanceId,
  ProviderOptionSelections,
} from "@t3tools/contracts";
import { createStore } from "zustand/vanilla";
import { randomUUID } from "../../lib/utils";
import { writeAgentDraftStorage } from "./agentDraftStorage";
import { isProjectAgentOptionSelections } from "./projectAgentSetup.logic";

export interface ProjectAgentCreationScope {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  cwd?: string | undefined;
}
export interface ProjectAgentCreationDraft {
  custom: boolean;
  label: string;
  role: string;
  instructions: string;
  instanceId: ProviderInstanceId | null;
  chosenModel: string | null;
  options?: ProviderOptionSelections | undefined;
  accessMode: MeerkatProjectAgentAccessMode;
}
export type CreatedProjectAgent = Pick<MeerkatProjectAgent, "agentId" | "projectId" | "instanceId">;
export interface ProjectAgentCreationAttempt {
  origin: "custom" | "preset";
  input: MeerkatProjectAgentCreateInput;
  accepted: CreatedProjectAgent | null;
  error: string | null;
}
export function findProjectAgentCreationPreset(
  attempts: ReadonlyArray<ProjectAgentCreationAttempt>,
  preset: { role: string; label: string },
): ProjectAgentCreationAttempt | undefined {
  return attempts.find(
    (attempt) =>
      attempt.input.role === preset.role ||
      attempt.input.label.toLowerCase() === preset.label.toLowerCase(),
  );
}
type DraftRow = { intentId: string | null; value: ProjectAgentCreationDraft };
export type ProjectAgentCreationStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem">;

const emptyDraft = (): ProjectAgentCreationDraft => ({
  custom: true,
  label: "",
  role: "",
  instructions: "",
  instanceId: null,
  chosenModel: null,
  accessMode: "read-and-collaborate",
});
const emptyRow = (): DraftRow => ({ intentId: null, value: emptyDraft() });
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const nullableString = (value: unknown) => value === null || nonempty(value);
const accessMode = (value: unknown) =>
  value === "read-only" || value === "read-and-collaborate" || value === "full-access";
function isDraft(value: unknown): value is ProjectAgentCreationDraft {
  return (
    record(value) &&
    typeof value.custom === "boolean" &&
    typeof value.label === "string" &&
    typeof value.role === "string" &&
    typeof value.instructions === "string" &&
    nullableString(value.instanceId) &&
    nullableString(value.chosenModel) &&
    (value.options === undefined || isProjectAgentOptionSelections(value.options)) &&
    accessMode(value.accessMode)
  );
}
function isInput(value: unknown): value is MeerkatProjectAgentCreateInput {
  return (
    record(value) &&
    ["projectId", "instanceId", "requestId", "label", "role", "instructions", "model"].every(
      (key) => nonempty(value[key]),
    ) &&
    (value.options === undefined || isProjectAgentOptionSelections(value.options)) &&
    accessMode(value.accessMode)
  );
}
function isAttempt(value: unknown, projectId: ProjectId): value is ProjectAgentCreationAttempt {
  return (
    record(value) &&
    (value.origin === "custom" || value.origin === "preset") &&
    isInput(value.input) &&
    value.input.projectId === projectId &&
    (value.error === null || typeof value.error === "string") &&
    (value.accepted === null ||
      (record(value.accepted) &&
        nonempty(value.accepted.agentId) &&
        value.accepted.projectId === value.input.projectId &&
        value.accepted.instanceId === value.input.instanceId))
  );
}
export function projectAgentCreationScopeKey(scope: ProjectAgentCreationScope): string {
  return `t3code:project-agent-creation:v1:${JSON.stringify([scope.environmentId, scope.projectId, scope.cwd ?? null])}:`;
}
function browserStorage(): ProjectAgentCreationStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export interface CreationState {
  draft: DraftRow;
  attempts: ReadonlyArray<ProjectAgentCreationAttempt>;
  pendingIds: ReadonlyArray<string>;
  error: string | null;
  refresh: () => boolean;
  updateDraft: (patch: Partial<ProjectAgentCreationDraft>) => boolean;
  newDraft: (keepInput: boolean) => boolean;
  beginCustom: (
    input: Omit<MeerkatProjectAgentCreateInput, "requestId">,
  ) => ProjectAgentCreationAttempt | null;
  beginPreset: (
    input: Omit<MeerkatProjectAgentCreateInput, "requestId">,
  ) => ProjectAgentCreationAttempt | null;
  retry: (requestId: string) => ProjectAgentCreationAttempt | null;
  accept: (requestId: string, agent: CreatedProjectAgent) => boolean;
  finish: (requestId: string, error?: string) => void;
}

export function createProjectAgentCreationDraftStore(
  scope: ProjectAgentCreationScope,
  storage: ProjectAgentCreationStorage | undefined = browserStorage(),
  allocateId: () => string = randomUUID,
) {
  const prefix = projectAgentCreationScopeKey(scope);
  const draftKey = `${prefix}draft`;
  const attemptKey = (id: string) => `${prefix}request:${id}`;
  const read = () => {
    if (!storage)
      throw new Error(
        "Local storage is unavailable. Agent creation is paused until its request can be saved.",
      );
    const raw = storage.getItem(draftKey);
    const draft: unknown = raw === null ? emptyRow() : JSON.parse(raw);
    if (!record(draft) || !nullableString(draft.intentId) || !isDraft(draft.value))
      throw new Error(
        "The saved agent setup cannot be read. Its saved data has been kept; creation is paused.",
      );
    const attempts: ProjectAgentCreationAttempt[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key?.startsWith(`${prefix}request:`)) continue;
      const saved = storage.getItem(key);
      const attempt: unknown = saved === null ? null : JSON.parse(saved);
      if (!isAttempt(attempt, scope.projectId) || key !== attemptKey(attempt.input.requestId))
        throw new Error(
          "A saved creation request cannot be read. Its saved data has been kept; creation is paused.",
        );
      attempts.push(attempt);
    }
    return { draft: draft as DraftRow, attempts };
  };
  // Each request has its own key. Editing a form or finishing another request cannot erase it.
  let unsavedPatch: Partial<ProjectAgentCreationDraft> = {};
  return createStore<CreationState>((set, get) => {
    const fail = (cause: unknown) => {
      set({ error: cause instanceof Error ? cause.message : String(cause) });
      return false;
    };
    const latest = () => {
      try {
        const saved = read();
        if (saved.draft.intentId !== get().draft.intentId) unsavedPatch = {};
        set({
          ...saved,
          draft: { ...saved.draft, value: { ...saved.draft.value, ...unsavedPatch } },
          error: null,
        });
        return saved;
      } catch (cause) {
        fail(cause);
        return null;
      }
    };
    const write = (key: string, value: unknown) => {
      if (writeAgentDraftStorage(storage, key, value)) return true;
      return fail(
        "Could not save this agent setup locally. Keep this page open and retry saving before creating an agent.",
      );
    };
    const persistDraft = (draft: DraftRow) => {
      if (!write(draftKey, draft)) return false;
      unsavedPatch = {};
      set({ draft, error: null });
      return true;
    };
    const begin = (attempt: ProjectAgentCreationAttempt) => {
      if (get().pendingIds.includes(attempt.input.requestId)) return null;
      attempt = structuredClone(attempt);
      // Even retries re-read and verify their saved identity before invoking the server.
      if (!write(attemptKey(attempt.input.requestId), attempt)) return null;
      set({
        attempts: [
          ...get().attempts.filter((entry) => entry.input.requestId !== attempt.input.requestId),
          attempt,
        ],
        pendingIds: [...get().pendingIds, attempt.input.requestId],
        error: null,
      });
      return structuredClone(attempt);
    };
    let initial: { draft: DraftRow; attempts: ProjectAgentCreationAttempt[] } = {
      draft: emptyRow(),
      attempts: [],
    };
    let initialError: string | null = null;
    try {
      initial = read();
    } catch (cause) {
      initialError = cause instanceof Error ? cause.message : String(cause);
    }
    return {
      ...initial,
      pendingIds: [],
      error: initialError,
      refresh: () => latest() !== null,
      updateDraft: (patch) => {
        const expectedIntent = get().draft.intentId;
        const saved = latest();
        if (!saved) return false;
        if (saved.draft.intentId !== expectedIntent)
          return fail(
            "This setup changed in another window. Review the saved form before editing it.",
          );
        if (saved.attempts.some((entry) => entry.input.requestId === expectedIntent))
          return fail(
            "This request is locked. Retry it unchanged or explicitly start a new request.",
          );
        unsavedPatch = { ...unsavedPatch, ...patch };
        const draft = {
          intentId: saved.draft.intentId ?? allocateId(),
          value: { ...saved.draft.value, ...unsavedPatch },
        };
        if (persistDraft(draft)) return true;
        // Retain visible typing after quota failure, without treating it as a durable submission.
        set({ draft: { ...saved.draft, value: draft.value } });
        return false;
      },
      newDraft: (keepInput) => {
        if (!latest()) return false;
        const value = keepInput ? get().draft.value : emptyDraft();
        return persistDraft({ intentId: allocateId(), value });
      },
      beginCustom: (input) => {
        const expectedIntent = get().draft.intentId;
        const expectedDraft = JSON.stringify(get().draft.value);
        const saved = latest();
        if (!saved || input.projectId !== scope.projectId) return null;
        if (saved.draft.intentId !== expectedIntent) {
          fail(
            "This setup changed in another window. Review the saved form before creating an agent.",
          );
          return null;
        }
        const existing = saved.attempts.find((entry) => entry.input.requestId === expectedIntent);
        if (existing) return begin(existing);
        if (JSON.stringify(get().draft.value) !== expectedDraft) {
          fail(
            "This setup was edited in another window. Review its saved settings before creating an agent.",
          );
          return null;
        }
        const requestId = saved.draft.intentId ?? allocateId();
        const value = {
          ...get().draft.value,
          instanceId: input.instanceId,
          chosenModel: input.model,
          ...(input.options !== undefined ? { options: structuredClone(input.options) } : {}),
        };
        if (!persistDraft({ intentId: requestId, value })) return null;
        return begin({
          origin: "custom",
          input: { ...input, requestId },
          accepted: null,
          error: null,
        });
      },
      beginPreset: (input) => {
        const saved = latest();
        if (!saved || input.projectId !== scope.projectId) return null;
        // A stale roster or changed picker cannot turn an unresolved preset into a new creation.
        const existing = findProjectAgentCreationPreset(saved.attempts, input);
        return begin(
          existing ?? {
            origin: "preset",
            input: { ...input, requestId: allocateId() },
            accepted: null,
            error: null,
          },
        );
      },
      retry: (requestId) => {
        const saved = latest();
        const attempt = saved?.attempts.find((entry) => entry.input.requestId === requestId);
        return attempt ? begin(attempt) : null;
      },
      accept: (requestId, agent) => {
        const saved = latest();
        const attempt = saved?.attempts.find((entry) => entry.input.requestId === requestId);
        if (!attempt) return false;
        if (
          !agent.agentId ||
          agent.projectId !== attempt.input.projectId ||
          agent.instanceId !== attempt.input.instanceId
        )
          return fail(
            "The creation response does not match this request. Keep the original request and retry it unchanged.",
          );
        if (attempt.accepted && attempt.accepted.agentId !== agent.agentId)
          return fail(
            "The creation response changed its saved agent identity. The original receipt has been kept.",
          );
        const accepted = {
          ...attempt,
          accepted: {
            agentId: agent.agentId,
            projectId: agent.projectId,
            instanceId: agent.instanceId,
          },
          error: null,
        };
        if (!write(attemptKey(requestId), accepted)) return false;
        set({
          attempts: saved!.attempts.map((entry) =>
            entry.input.requestId === requestId ? accepted : entry,
          ),
          error: null,
        });
        return true;
      },
      finish: (requestId, error) => {
        set({ pendingIds: get().pendingIds.filter((id) => id !== requestId) });
        if (!error) return;
        const saved = latest();
        const attempt = saved?.attempts.find((entry) => entry.input.requestId === requestId);
        if (!attempt || attempt.accepted) return;
        const next = { ...attempt, error };
        if (write(attemptKey(requestId), next))
          set({
            attempts: saved!.attempts.map((entry) =>
              entry.input.requestId === requestId ? next : entry,
            ),
            error,
          });
      },
    };
  });
}

export type ProjectAgentCreationDraftStore = ReturnType<
  typeof createProjectAgentCreationDraftStore
>;

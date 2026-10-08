import { MeerkatImageRef, OrchestrationMessageContext, ModelSelection } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import {
  browserAgentDraftStorage,
  migrateAgentDraftStorage,
  writeAgentDraftStorage,
  type AgentDraftStorage,
} from "./agentDraftStorage";
export { agentConversationDraftKey } from "./agentDraftIdentity";

type HandlingMode = "queue" | "steer";
export type AgentSendPayload = {
  text: string;
  mode: HandlingMode;
  context?: OrchestrationMessageContext;
  images?: ReadonlyArray<MeerkatImageRef>;
  modelSelection?: ModelSelection;
  queueId?: string;
  agentRef?: string;
};
export type SendAttempt = AgentSendPayload & { requestId: string };

const decodeImages = Schema.decodeUnknownSync(Schema.Array(MeerkatImageRef));
const decodeModel = Schema.decodeUnknownSync(ModelSelection);
const decodeContext = Schema.decodeUnknownSync(OrchestrationMessageContext);

export function readAgentMessageExtras(
  value: object,
): Pick<AgentSendPayload, "images" | "modelSelection" | "queueId" | "agentRef" | "context"> {
  const result: Pick<
    AgentSendPayload,
    "images" | "modelSelection" | "queueId" | "agentRef" | "context"
  > = {};
  const context: unknown = Reflect.get(value, "context");
  if (context !== undefined) result.context = decodeContext(context);
  const images: unknown = Reflect.get(value, "images");
  const model: unknown = Reflect.get(value, "modelSelection");
  const queueId: unknown = Reflect.get(value, "queueId");
  const agentRef: unknown = Reflect.get(value, "agentRef");
  if (images !== undefined) result.images = decodeImages(images);
  if (model !== undefined) result.modelSelection = decodeModel(model);
  if (typeof queueId === "string") result.queueId = queueId;
  if (typeof agentRef === "string") result.agentRef = agentRef;
  return result;
}
function payloadIdentity(payload: AgentSendPayload): string {
  return JSON.stringify([
    payload.text.trim(),
    payload.mode,
    payload.context ?? null,
    payload.images ?? [],
    payload.modelSelection ?? null,
    payload.queueId ?? null,
  ]);
}

/** Match the stable draft intent while retaining its original native incarnation for receipts. */
export function findAgentSendAttempt(
  attempts: ReadonlyArray<SendAttempt>,
  payload: AgentSendPayload,
): SendAttempt | undefined {
  return attempts.find((item) =>
    payload.queueId
      ? item.queueId === payload.queueId
      : payloadIdentity(item) === payloadIdentity(payload),
  );
}
export type AgentConversationDraft = {
  text: string;
  mode: HandlingMode;
  attempts: ReadonlyArray<SendAttempt>;
  modelSelection?: ModelSelection;
};
const STORAGE_KEY = "t3code:meerkat-agent-drafts:v1";
export const EMPTY_AGENT_DRAFT: AgentConversationDraft = { text: "", mode: "queue", attempts: [] };

export function readAgentConversationDrafts(
  storage: Pick<AgentDraftStorage, "getItem"> | undefined,
): Record<string, AgentConversationDraft> {
  const value: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "{}");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid saved drafts");
  return Object.fromEntries(
    Object.entries(value).map(([key, draft]: [string, unknown]) => {
      if (!draft || typeof draft !== "object") throw new Error("Invalid saved draft");
      const text: unknown = Reflect.get(draft, "text");
      const mode: unknown = Reflect.get(draft, "mode");
      const attempts: unknown = Reflect.get(draft, "attempts");
      if (typeof text !== "string" || (mode !== "queue" && mode !== "steer"))
        throw new Error("Invalid saved draft");
      if (attempts !== undefined && !Array.isArray(attempts))
        throw new Error("Invalid saved attempts");
      const validAttempts: SendAttempt[] = Array.isArray(attempts)
        ? attempts.map((attempt: unknown) => {
            if (!attempt || typeof attempt !== "object") throw new Error("Invalid saved attempt");
            const content: unknown = Reflect.get(attempt, "text");
            const handling: unknown = Reflect.get(attempt, "mode");
            const requestId: unknown = Reflect.get(attempt, "requestId");
            if (
              typeof content !== "string" ||
              (handling !== "queue" && handling !== "steer") ||
              typeof requestId !== "string" ||
              !requestId.trim()
            )
              throw new Error("Invalid saved attempt");
            return { text: content, mode: handling, requestId, ...readAgentMessageExtras(attempt) };
          })
        : [];
      const model: unknown = Reflect.get(draft, "modelSelection");
      return [
        key,
        {
          text,
          mode,
          attempts: validAttempts,
          ...(model !== undefined ? { modelSelection: decodeModel(model) } : {}),
        },
      ];
    }),
  );
}

type AgentConversationDraftState = {
  byTarget: Record<string, AgentConversationDraft>;
  pendingByTarget: Record<string, string | undefined>;
  sendErrorByTarget: Record<string, string | undefined>;
  setText: (key: string, text: string) => void;
  setMode: (key: string, mode: HandlingMode) => void;
  setModel: (key: string, modelSelection: ModelSelection | undefined) => void;
  findSendAttempt: (key: string, payload: AgentSendPayload) => SendAttempt | undefined;
  findSendAttemptById: (key: string, requestId: string) => SendAttempt | undefined;
  beginSend: (
    key: string,
    createRequestId: () => string,
    submission?: AgentSendPayload,
  ) => SendAttempt | null;
  acknowledge: (key: string, requestId: string) => boolean;
  finishSend: (key: string, requestId: string) => void;
};

/** A durable target survives runtime reincarnation; only UI draft state is stored here. */
export function createAgentConversationDraftStore(
  storage?: AgentDraftStorage,
  legacyStorage?: AgentDraftStorage,
) {
  return create<AgentConversationDraftState>((set, get) => {
    let byTarget: Record<string, AgentConversationDraft> = {};
    let recoveryError: string | undefined;
    const pendingDraftChanges = new Map<
      string,
      Array<(draft: AgentConversationDraft) => AgentConversationDraft>
    >();
    try {
      byTarget = migrateAgentDraftStorage(
        storage,
        legacyStorage,
        STORAGE_KEY,
        readAgentConversationDrafts,
      );
    } catch {
      recoveryError =
        "Saved send recovery data could not be read. The saved copy has been kept. Reload before sending.";
    }
    function latestDrafts() {
      if (recoveryError) return null;
      try {
        const latest = { ...get().byTarget, ...readAgentConversationDrafts(storage) };
        for (const [key, changes] of pendingDraftChanges)
          latest[key] = changes.reduce(
            (draft, change) => change(draft),
            latest[key] ?? EMPTY_AGENT_DRAFT,
          );
        return latest;
      } catch {
        recoveryError =
          "Saved send recovery data could not be read. The saved copy has been kept. Reload before sending.";
        return null;
      }
    }
    function update(
      key: string,
      change: (draft: AgentConversationDraft) => AgentConversationDraft,
      requirePersistence = false,
    ) {
      const latest = latestDrafts();
      const byTarget = {
        ...(latest ?? get().byTarget),
        [key]: change(latest?.[key] ?? get().byTarget[key] ?? EMPTY_AGENT_DRAFT),
      };
      const saved = !recoveryError && writeAgentDraftStorage(storage, STORAGE_KEY, byTarget);
      if (saved) pendingDraftChanges.clear();
      else if (!requirePersistence)
        pendingDraftChanges.set(key, [...(pendingDraftChanges.get(key) ?? []), change]);
      if (saved || !requirePersistence) set({ byTarget });
      return saved;
    }
    return {
      byTarget,
      pendingByTarget: {},
      sendErrorByTarget: {},
      setText: (key, text) => update(key, (draft) => ({ ...draft, text })),
      setMode: (key, mode) => update(key, (draft) => ({ ...draft, mode })),
      setModel: (key, modelSelection) => {
        const selection = structuredClone(modelSelection);
        update(key, (draft) => {
          const next = { ...draft };
          if (selection) next.modelSelection = selection;
          else delete next.modelSelection;
          return next;
        });
      },
      findSendAttempt: (key, payload) => {
        const latest = latestDrafts();
        if (!latest) {
          set({ sendErrorByTarget: { ...get().sendErrorByTarget, [key]: recoveryError } });
          return undefined;
        }
        set({
          byTarget: latest,
          sendErrorByTarget: { ...get().sendErrorByTarget, [key]: undefined },
        });
        const found = findAgentSendAttempt(latest[key]?.attempts ?? [], payload);
        return found ? structuredClone(found) : undefined;
      },
      findSendAttemptById: (key, requestId) => {
        const latest = latestDrafts();
        if (!latest) {
          set({ sendErrorByTarget: { ...get().sendErrorByTarget, [key]: recoveryError } });
          return undefined;
        }
        set({
          byTarget: latest,
          sendErrorByTarget: { ...get().sendErrorByTarget, [key]: undefined },
        });
        const found = latest[key]?.attempts.find((attempt) => attempt.requestId === requestId);
        return found ? structuredClone(found) : undefined;
      },
      beginSend: (key, createRequestId, submission) => {
        const latest = latestDrafts();
        if (recoveryError) {
          set({ sendErrorByTarget: { ...get().sendErrorByTarget, [key]: recoveryError } });
          return null;
        }
        if (get().pendingByTarget[key]) return null;
        const draft = latest?.[key] ?? get().byTarget[key] ?? EMPTY_AGENT_DRAFT;
        const payload: AgentSendPayload = {
          ...structuredClone(submission),
          text: (submission?.text ?? draft.text).trim(),
          mode: submission?.mode ?? draft.mode,
        };
        if (!payload.text && !payload.images?.length) return null;
        const attempt = findAgentSendAttempt(draft.attempts, payload) ?? {
          ...payload,
          requestId: createRequestId(),
        };
        // Persist before native dispatch. A failed write leaves the draft untouched and
        // cannot create an apparent delivery attempt for a request that was never sent.
        const saved = update(
          key,
          (current) => ({
            ...current,
            attempts: current.attempts.some((item) => item.requestId === attempt.requestId)
              ? current.attempts
              : [...current.attempts, attempt],
          }),
          true,
        );
        set({
          sendErrorByTarget: {
            ...get().sendErrorByTarget,
            [key]: saved
              ? undefined
              : "Could not save this send for recovery. Your draft is unchanged. Free local storage and try again.",
          },
        });
        if (!saved) return null;
        set({ pendingByTarget: { ...get().pendingByTarget, [key]: attempt.requestId } });
        return structuredClone(attempt);
      },
      acknowledge: (key, requestId) => {
        const saved = update(
          key,
          (draft) => {
            const attempt = draft.attempts.find((item) => item.requestId === requestId);
            if (!attempt) return draft;
            return {
              ...draft,
              text:
                !attempt.queueId &&
                draft.text.trim() === attempt.text &&
                draft.mode === attempt.mode
                  ? ""
                  : draft.text,
              attempts: draft.attempts.filter((item) => item.requestId !== requestId),
            };
          },
          true,
        );
        set({
          sendErrorByTarget: {
            ...get().sendErrorByTarget,
            [key]: saved
              ? undefined
              : "Delivery was confirmed, but its confirmation could not be saved locally. Check delivery before sending again.",
          },
        });
        return saved;
      },
      finishSend: (key, requestId) => {
        if (get().pendingByTarget[key] === requestId)
          set({ pendingByTarget: { ...get().pendingByTarget, [key]: undefined } });
      },
    };
  });
}

export const useAgentConversationDraftStore = createAgentConversationDraftStore(
  browserAgentDraftStorage("localStorage"),
  browserAgentDraftStorage("sessionStorage"),
);

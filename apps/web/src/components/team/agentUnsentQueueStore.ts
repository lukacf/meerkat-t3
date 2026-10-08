import { create } from "zustand";
import { readAgentMessageExtras, type AgentSendPayload } from "./agentConversationDraftStore";
import {
  browserAgentDraftStorage,
  migrateAgentDraftStorage,
  writeAgentDraftStorage,
  type AgentDraftStorage,
} from "./agentDraftStorage";

export type UnsentAgentMessage = { id: string; text: string; sendWhenIdle?: boolean } & Pick<
  AgentSendPayload,
  "images" | "modelSelection" | "context"
>;
const STORAGE_KEY = "t3code:meerkat-unsent-queue:v1";
export const EMPTY_AGENT_QUEUE: ReadonlyArray<UnsentAgentMessage> = [];
type QueueState = {
  byTarget: Record<string, ReadonlyArray<UnsentAgentMessage>>;
  readTarget: (key: string) => ReadonlyArray<UnsentAgentMessage> | null;
  add: (key: string, item: UnsentAgentMessage) => boolean;
  edit: (key: string, id: string, text: string) => void;
  remove: (key: string, id: string) => boolean;
  move: (key: string, id: string, direction: -1 | 1) => void;
};
export function readAgentUnsentQueue(
  storage?: Pick<AgentDraftStorage, "getItem">,
): QueueState["byTarget"] {
  const value: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "{}");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid saved queue");
  return Object.fromEntries(
    Object.entries(value).map(([key, rows]: [string, unknown]) => {
      if (!Array.isArray(rows)) throw new Error("Invalid saved queue rows");
      return [
        key,
        rows.map((row: unknown): UnsentAgentMessage => {
          if (!row || typeof row !== "object") throw new Error("Invalid saved queue row");
          const id: unknown = Reflect.get(row, "id");
          const text: unknown = Reflect.get(row, "text");
          if (typeof id !== "string" || typeof text !== "string")
            throw new Error("Invalid saved queue row");
          const { images, modelSelection, context } = readAgentMessageExtras(row);
          return {
            id,
            text,
            ...(images ? { images } : {}),
            ...(modelSelection ? { modelSelection } : {}),
            ...(context ? { context } : {}),
            ...(Reflect.get(row, "sendWhenIdle") === true ? { sendWhenIdle: true } : {}),
          };
        }),
      ];
    }),
  );
}
export function canSendAgentQueue(
  work: { status: string; observedAt: string } | undefined,
  now: number,
) {
  const observed = work ? Date.parse(work.observedAt) : Number.NaN;
  return (
    work?.status === "idle" &&
    Number.isFinite(observed) &&
    now >= observed &&
    now - observed < 30_000
  );
}
export function createAgentUnsentQueueStore(
  storage?: AgentDraftStorage,
  legacyStorage?: AgentDraftStorage,
) {
  return create<QueueState>((set, get) => {
    let byTarget: QueueState["byTarget"] = {};
    let readable = true;
    try {
      byTarget = migrateAgentDraftStorage(
        storage,
        legacyStorage,
        STORAGE_KEY,
        readAgentUnsentQueue,
      );
    } catch {
      readable = false;
    }
    const update = (
      key: string,
      change: (rows: ReadonlyArray<UnsentAgentMessage>) => ReadonlyArray<UnsentAgentMessage>,
    ) => {
      if (!readable) return false;
      try {
        const durable = readAgentUnsentQueue(storage);
        const byTarget = {
          ...get().byTarget,
          ...durable,
          [key]: change(durable[key] ?? get().byTarget[key] ?? []),
        };
        if (!writeAgentDraftStorage(storage, STORAGE_KEY, byTarget)) return false;
        set({ byTarget });
        return true;
      } catch {
        readable = false;
        return false;
      }
    };
    return {
      byTarget,
      readTarget: (key) => {
        if (!readable) return null;
        try {
          const byTarget = { ...get().byTarget, ...readAgentUnsentQueue(storage) };
          set({ byTarget });
          return structuredClone(byTarget[key] ?? []);
        } catch {
          readable = false;
          return null;
        }
      },
      add: (key, item) =>
        update(key, (rows) =>
          rows.some((row) => row.id === item.id) ? rows : [...rows, structuredClone(item)],
        ),
      edit: (key, id, text) => {
        update(key, (rows) =>
          rows.map((row) =>
            row.id === id && (text.trim() || row.images?.length)
              ? { ...row, text: text.trim() }
              : row,
          ),
        );
      },
      remove: (key, id) => update(key, (rows) => rows.filter((row) => row.id !== id)),
      move: (key, id, direction) => {
        update(key, (rows) => {
          const next = [...rows];
          const index = next.findIndex((row) => row.id === id);
          const dest = index + direction;
          if (index >= 0 && dest >= 0 && dest < next.length)
            [next[index], next[dest]] = [next[dest]!, next[index]!];
          return next;
        });
      },
    };
  });
}
export const useAgentUnsentQueueStore = createAgentUnsentQueueStore(
  browserAgentDraftStorage("localStorage"),
  browserAgentDraftStorage("sessionStorage"),
);

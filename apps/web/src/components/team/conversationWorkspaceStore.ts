import { create } from "zustand";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

export type ConversationTarget =
  | {
      kind: "thread";
      environmentId: EnvironmentId;
      projectId: ProjectId;
      threadId: ThreadId;
      member?: string;
      label: string;
    }
  | {
      kind: "project-agent";
      environmentId: EnvironmentId;
      projectId: ProjectId;
      agentId: string;
      label: string;
    };
export type ConversationLayout = {
  secondary: ConversationTarget | null;
  closed: ConversationTarget | null;
  direction: "columns" | "rows";
};
export interface ProjectWorkspaceTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly projectName: string;
  readonly openFile: (path: string, line?: number) => void;
}

export interface MountedWorkspaceTarget {
  readonly routeKey: string;
  readonly target: ProjectWorkspaceTarget | null;
}
export const EMPTY_CONVERSATION_LAYOUT: ConversationLayout = {
  secondary: null,
  closed: null,
  direction: "columns",
};
const STORAGE_KEY = "t3code:conversation-workspaces:v1";
type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function conversationTargetKey(target: ConversationTarget): string {
  return JSON.stringify(
    target.kind === "thread"
      ? [
          target.kind,
          target.environmentId,
          target.projectId,
          target.threadId,
          target.member ?? null,
        ]
      : [target.kind, target.environmentId, target.projectId, target.agentId],
  );
}

function isTarget(value: unknown): value is ConversationTarget {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.environmentId === "string" &&
    typeof t.projectId === "string" &&
    typeof t.label === "string" &&
    ((t.kind === "thread" &&
      typeof t.threadId === "string" &&
      (t.member === undefined || typeof t.member === "string")) ||
      (t.kind === "project-agent" && typeof t.agentId === "string"))
  );
}

function readLayouts(storage?: StorageLike): Record<string, ConversationLayout> {
  try {
    const value: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, row]: [string, unknown]) => {
        if (!row || typeof row !== "object") return [];
        const secondary: unknown = Reflect.get(row, "secondary");
        const closed: unknown = Reflect.get(row, "closed");
        const direction: unknown = Reflect.get(row, "direction");
        if (
          (secondary !== null && !isTarget(secondary)) ||
          (closed !== null && !isTarget(closed)) ||
          (direction !== "columns" && direction !== "rows")
        )
          return [];
        return [[key, { secondary, closed, direction }]];
      }),
    );
  } catch {
    return {};
  }
}

type WorkspaceState = {
  layouts: Record<string, ConversationLayout>;
  focusedPane: string | null;
  workspaceTargets: Record<string, MountedWorkspaceTarget>;
  registerWorkspace: (pane: string, target: MountedWorkspaceTarget) => () => void;
  focus: (pane: string) => void;
  open: (key: string, target: ConversationTarget) => void;
  close: (key: string) => void;
  reopen: (key: string) => void;
  direction: (key: string, direction: ConversationLayout["direction"]) => void;
};

export function createConversationWorkspaceStore(storage?: StorageLike) {
  return create<WorkspaceState>((set, get) => {
    const update = (key: string, change: (layout: ConversationLayout) => ConversationLayout) => {
      const layouts = {
        ...get().layouts,
        [key]: change(get().layouts[key] ?? EMPTY_CONVERSATION_LAYOUT),
      };
      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify(layouts));
      } catch {
        /* The open panels remain usable. */
      }
      set({ layouts });
    };
    return {
      layouts: readLayouts(storage),
      focusedPane: null,
      workspaceTargets: {},
      registerWorkspace: (pane, target) => {
        set({ workspaceTargets: { ...get().workspaceTargets, [pane]: target } });
        return () => {
          if (get().workspaceTargets[pane] !== target) return;
          const { [pane]: _removed, ...workspaceTargets } = get().workspaceTargets;
          set({ workspaceTargets });
        };
      },
      focus: (focusedPane) => set({ focusedPane }),
      open: (key, secondary) => update(key, (layout) => ({ ...layout, secondary })),
      close: (key) => {
        update(key, (layout) => ({ ...layout, closed: layout.secondary, secondary: null }));
        set({ focusedPane: `${key}:primary` });
      },
      reopen: (key) =>
        update(key, (layout) => ({ ...layout, secondary: layout.closed, closed: null })),
      direction: (key, direction) => update(key, (layout) => ({ ...layout, direction })),
    };
  });
}

function browserStorage() {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
export const useConversationWorkspaceStore = createConversationWorkspaceStore(browserStorage());

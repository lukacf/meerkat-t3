import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  conversationTargetKey,
  createConversationWorkspaceStore,
  type ConversationTarget,
} from "./conversationWorkspaceStore";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
const thread: ConversationTarget = {
  kind: "thread",
  environmentId: EnvironmentId.make("local"),
  projectId: ProjectId.make("project"),
  threadId: ThreadId.make("thread"),
  member: "exact-worker-session",
  label: "Worker",
};

describe("conversation workspace", () => {
  it("reopens the exact worker and layout after a reload without restoring stale focus", () => {
    const saved = storage();
    const store = createConversationWorkspaceStore(saved);
    store.getState().open("project", thread);
    store.getState().direction("project", "rows");
    store.getState().focus("project:secondary");
    store.getState().close("project");
    expect(store.getState().focusedPane).toBe("project:primary");
    const restored = createConversationWorkspaceStore(saved);
    expect(restored.getState().focusedPane).toBeNull();
    expect(restored.getState().layouts.project).toEqual({
      secondary: null,
      closed: thread,
      direction: "rows",
    });
    restored.getState().reopen("project");
    expect(restored.getState().layouts.project?.secondary).toEqual(thread);
  });

  it("keeps other projects intact and distinguishes workers sharing a coordinator", () => {
    const store = createConversationWorkspaceStore();
    const other = { ...thread, member: "different-worker-session" };
    store.getState().open("first", thread);
    store.getState().open("second", other);
    store.getState().close("first");
    expect(store.getState().layouts.second?.secondary).toEqual(other);
    expect(conversationTargetKey(thread)).not.toEqual(conversationTargetKey(other));
    expect(conversationTargetKey(thread)).not.toEqual(
      conversationTargetKey({ ...thread, environmentId: EnvironmentId.make("remote") }),
    );
    expect(conversationTargetKey(thread)).toEqual(
      conversationTargetKey({ ...thread, label: "Renamed" }),
    );
  });

  it("recovers to an empty layout from malformed persisted data", () => {
    const store = createConversationWorkspaceStore({
      getItem: () => '{"project":{"secondary":{"kind":"thread"},"closed":null,"direction":"rows"}}',
      setItem: () => {},
    });
    expect(store.getState().layouts).toEqual({});
  });

  it("keeps mounted search destinations transient and ignores stale cleanup", () => {
    const saved = storage();
    const store = createConversationWorkspaceStore(saved);
    const first = {
      routeKey: "/first",
      target: {
        environmentId: thread.environmentId,
        projectId: thread.projectId,
        cwd: "/first",
        projectName: "First",
        openFile: () => {},
      },
    };
    const second = { ...first, routeKey: "/second", target: { ...first.target, cwd: "/second" } };
    const oldUnmount = store.getState().registerWorkspace("primary", first);
    const currentUnmount = store.getState().registerWorkspace("primary", second);
    oldUnmount();
    expect(store.getState().workspaceTargets.primary).toBe(second);
    store.getState().open("project", thread);
    expect(createConversationWorkspaceStore(saved).getState().workspaceTargets).toEqual({});
    currentUnmount();
    expect(store.getState().workspaceTargets).toEqual({});
  });
});

import { act, useLayoutEffect, useMemo } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ConversationWorkspaceChrome } from "../components/team/ConversationWorkspaceChrome";
import {
  useConversationWorkspaceStore,
  type ProjectWorkspaceTarget,
} from "../components/team/conversationWorkspaceStore";

const location = vi.hoisted(() => ({ pathname: "/env/agents/one", searchStr: "?project=project" }));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (value: typeof location) => unknown }) => select(location),
}));
import { useActiveProjectTarget, useRegisterProjectWorkspace } from "./useActiveProjectTarget";

const environmentId = EnvironmentId.make("env");
const projectId = ProjectId.make("project");
const workspaceKey = JSON.stringify([environmentId, projectId]);
const primaryId = `${workspaceKey}:primary`;
const secondaryId = `${workspaceKey}:secondary`;
let renderer: ReactTestRenderer | undefined;
let active: ProjectWorkspaceTarget | null = null;
const initial = useConversationWorkspaceStore.getState();

function Pane({
  id,
  cwd,
  openFile,
  enabled = true,
}: {
  id: string;
  cwd: string | null;
  openFile: ProjectWorkspaceTarget["openFile"];
  enabled?: boolean;
}) {
  const target = useMemo(
    () => (cwd ? { environmentId, projectId, projectName: "Project", cwd, openFile } : null),
    [cwd, openFile],
  );
  return (
    <ConversationWorkspaceChrome
      value={{ paneId: id, split: true, secondary: id === secondaryId, controls: null }}
    >
      <Registration target={target} enabled={enabled} />
    </ConversationWorkspaceChrome>
  );
}
function Registration({
  target,
  enabled,
}: {
  target: ProjectWorkspaceTarget | null;
  enabled: boolean;
}) {
  useRegisterProjectWorkspace(target, enabled);
  return null;
}
function Dialog() {
  const target = useActiveProjectTarget();
  useLayoutEffect(() => {
    active = target;
  }, [target]);
  return null;
}
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  useConversationWorkspaceStore.setState(initial, true);
  location.pathname = "/env/agents/one";
  active = null;
  vi.unstubAllGlobals();
});

it("opens search results in the focused exact workspace without a thread identity", async () => {
  const primary = vi.fn();
  const secondary = vi.fn();
  await act(async () => {
    useConversationWorkspaceStore.getState().focus(secondaryId);
    renderer = create(
      <>
        <Pane id={primaryId} cwd="/repo" openFile={primary} />
        <Pane id={secondaryId} cwd="/worktrees/review" openFile={secondary} />
        <Dialog />
      </>,
    );
  });
  expect(active).toMatchObject({ environmentId, projectId, cwd: "/worktrees/review" });
  active!.openFile("src/index.ts", 42);
  expect(secondary).toHaveBeenCalledWith("src/index.ts", 42);
  expect(primary).not.toHaveBeenCalled();
  await act(async () => useConversationWorkspaceStore.getState().focus(primaryId));
  expect(active?.cwd).toBe("/repo");
  active!.openFile("README.md");
  expect(primary).toHaveBeenCalledWith("README.md");
});

it("does not search the main checkout when the focused worker workspace is unavailable", async () => {
  await act(async () => {
    useConversationWorkspaceStore.getState().focus(secondaryId);
    renderer = create(
      <>
        <Pane id={primaryId} cwd="/repo" openFile={vi.fn()} />
        <Pane id={secondaryId} cwd={null} openFile={vi.fn()} />
        <Dialog />
      </>,
    );
  });
  expect(active).toBeNull();
  await act(async () => renderer!.update(<Dialog />));
  expect(active).toBeNull();
  expect(useConversationWorkspaceStore.getState().workspaceTargets).toEqual({});
});

it("replaces the coordinator destination when its selected worker owns the same pane", async () => {
  const coordinator = vi.fn();
  const worker = vi.fn();
  function Conversation({ selectedWorker }: { selectedWorker: boolean }) {
    return (
      <>
        {selectedWorker ? <Pane id={primaryId} cwd="/worktrees/worker" openFile={worker} /> : null}
        <Pane id={primaryId} cwd="/repo" openFile={coordinator} enabled={!selectedWorker} />
        <Dialog />
      </>
    );
  }
  await act(async () => {
    useConversationWorkspaceStore.getState().focus(primaryId);
    renderer = create(<Conversation selectedWorker={false} />);
  });
  await act(async () => renderer!.update(<Conversation selectedWorker />));
  active!.openFile("worker.ts", 7);
  expect(worker).toHaveBeenCalledWith("worker.ts", 7);
  expect(coordinator).not.toHaveBeenCalled();
  await act(async () => renderer!.update(<Conversation selectedWorker={false} />));
  active!.openFile("coordinator.ts");
  expect(coordinator).toHaveBeenCalledWith("coordinator.ts");
});

it("does not reuse the previous route's target before its next conversation mounts", async () => {
  const routeKey = JSON.stringify([location.pathname, location.searchStr]);
  const dispose = useConversationWorkspaceStore.getState().registerWorkspace(primaryId, {
    routeKey,
    target: { environmentId, projectId, cwd: "/old", projectName: "Old", openFile: vi.fn() },
  });
  useConversationWorkspaceStore.getState().focus(primaryId);
  location.pathname = "/other/agents/two";
  await act(async () => {
    renderer = create(<Dialog />);
  });
  expect(active).toBeNull();
  dispose();
});

it("preserves a mounted standalone draft destination without workspace chrome", async () => {
  const openFile = vi.fn();
  const target = {
    environmentId,
    projectId,
    cwd: "/draft-worktree",
    projectName: "Draft",
    openFile,
  };
  await act(async () => {
    renderer = create(
      <>
        <Registration target={target} enabled />
        <Dialog />
      </>,
    );
  });
  expect(active?.cwd).toBe("/draft-worktree");
  active!.openFile("draft.md");
  expect(openFile).toHaveBeenCalledWith("draft.md");
});

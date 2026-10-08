import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  isWorkspaceFileRestoring,
  publishWorkspaceMutation,
  setWorkspaceFileEditPending,
  useWorkspaceMutationId,
  withWorkspaceRestore,
} from "./workspaceMutations";

const environmentId = EnvironmentId.make("restore-refresh-tests");
const target = { environmentId, cwd: "/workspace" };
let renderer: ReactTestRenderer | null = null;

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<A>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("workspace restore coordination", () => {
  it("guards and locks the server-verified workspace alias without broadening environment scope", async () => {
    const workspace = { environmentId, cwd: "/physical/repo", aliases: ["/linked/repo"] };
    const editor = Symbol("alias-editor");
    const alias = { environmentId, cwd: "/linked/repo" };
    setWorkspaceFileEditPending(alias, "file.txt", editor, true);
    try {
      await expect(
        withWorkspaceRestore(
          workspace,
          ["file.txt"],
          () => false,
          async () => {},
        ),
      ).rejects.toThrow("Wait for pending edits");
    } finally {
      setWorkspaceFileEditPending(alias, "file.txt", editor, false);
    }
    const readBack = deferred<void>();
    const hasPending = vi.fn<(path: string, cwd: string) => boolean>(() => false);
    const restore = withWorkspaceRestore(
      workspace,
      ["file.txt"],
      hasPending,
      () => readBack.promise,
    );
    expect(hasPending.mock.calls).toEqual([
      ["file.txt", "/physical/repo"],
      ["file.txt", "/linked/repo"],
    ]);
    expect(isWorkspaceFileRestoring(alias, "file.txt")).toBe(true);
    expect(isWorkspaceFileRestoring(workspace, "file.txt")).toBe(true);
    expect(
      isWorkspaceFileRestoring(
        { ...alias, environmentId: EnvironmentId.make("elsewhere") },
        "file.txt",
      ),
    ).toBe(false);
    readBack.resolve();
    await restore;
    expect(isWorkspaceFileRestoring(alias, "file.txt")).toBe(false);
  });

  it("waits for every editor's pending save, including another pane with the same contents", async () => {
    const firstEditor = Symbol("first");
    const secondEditor = Symbol("second");
    const restore = vi.fn().mockResolvedValue(undefined);
    setWorkspaceFileEditPending(target, "shared.txt", firstEditor, true);
    setWorkspaceFileEditPending(target, "shared.txt", secondEditor, true);
    setWorkspaceFileEditPending(target, "shared.txt", firstEditor, false);
    try {
      await expect(
        withWorkspaceRestore(target, ["shared.txt"], () => false, restore),
      ).rejects.toThrow("Wait for pending edits");
      expect(restore).not.toHaveBeenCalled();
    } finally {
      setWorkspaceFileEditPending(target, "shared.txt", secondEditor, false);
    }
    await withWorkspaceRestore(target, ["shared.txt"], () => false, restore);
    expect(restore).toHaveBeenCalledOnce();
  });

  it("does not call restore while a selected file has pending local edits", async () => {
    const restore = vi.fn();
    await expect(withWorkspaceRestore(target, ["a.txt"], () => true, restore)).rejects.toThrow(
      "Wait for pending edits in a.txt",
    );
    expect(restore).not.toHaveBeenCalled();
    expect(isWorkspaceFileRestoring(target, "a.txt")).toBe(false);
  });

  it("keeps only the selected files locked until restore and read-back finish", async () => {
    const readBack = deferred<string>();
    const restore = withWorkspaceRestore(
      target,
      ["a.txt"],
      () => false,
      () => readBack.promise,
    );
    expect(isWorkspaceFileRestoring({ ...target, cwd: "/workspace/" }, "a.txt")).toBe(true);
    expect(isWorkspaceFileRestoring(target, "other.txt")).toBe(false);
    expect(isWorkspaceFileRestoring({ ...target, cwd: "/worktree" }, "a.txt")).toBe(false);
    expect(
      isWorkspaceFileRestoring({ ...target, environmentId: EnvironmentId.make("remote") }, "a.txt"),
    ).toBe(false);
    const secondRestore = vi.fn();
    await expect(
      withWorkspaceRestore(target, ["a.txt"], () => false, secondRestore),
    ).rejects.toThrow("already in progress");
    expect(secondRestore).not.toHaveBeenCalled();
    readBack.resolve("fresh contents");
    await expect(restore).resolves.toBe("fresh contents");
    expect(isWorkspaceFileRestoring(target, "a.txt")).toBe(false);
  });

  it("releases its lock on failure without affecting a different active restore", async () => {
    const first = deferred<void>();
    const other = deferred<void>();
    const firstRestore = withWorkspaceRestore(
      target,
      ["a.txt"],
      () => false,
      () => first.promise,
    );
    const otherRestore = withWorkspaceRestore(
      target,
      ["other.txt"],
      () => false,
      () => other.promise,
    );
    first.reject(new Error("Restore failed"));
    await expect(firstRestore).rejects.toThrow("Restore failed");
    expect(isWorkspaceFileRestoring(target, "a.txt")).toBe(false);
    expect(isWorkspaceFileRestoring(target, "other.txt")).toBe(true);
    other.resolve();
    await otherRestore;
  });

  it("refreshes coordinator and specialist subscribers only for the mutated workspace", () => {
    const revisions = new Map<string, string | null>();
    const workspace = {
      environmentId,
      cwd: "/revision-workspace",
      aliases: ["/linked-revision-workspace"],
    };
    function Surface({
      name,
      cwd,
      environment = environmentId,
    }: {
      name: string;
      cwd: string;
      environment?: EnvironmentId;
    }) {
      revisions.set(name, useWorkspaceMutationId(environment, cwd, "provider-activity"));
      return null;
    }
    act(() => {
      renderer = create(
        <>
          <Surface name="coordinator" cwd={workspace.cwd} />
          <Surface name="specialist" cwd={`${workspace.cwd}/`} />
          <Surface name="alias" cwd="/linked-revision-workspace" />
          <Surface name="worktree" cwd="/other-worktree" />
          <Surface name="remote" cwd={workspace.cwd} environment={EnvironmentId.make("remote")} />
        </>,
      );
    });
    act(() => publishWorkspaceMutation(workspace));
    expect(revisions.get("coordinator")).not.toBe("provider-activity");
    expect(revisions.get("specialist")).toBe(revisions.get("coordinator"));
    expect(revisions.get("alias")).toBe(revisions.get("coordinator"));
    expect(revisions.get("worktree")).toBe("provider-activity");
    expect(revisions.get("remote")).toBe("provider-activity");
    const firstRevision = revisions.get("coordinator");
    act(() => publishWorkspaceMutation(workspace));
    expect(revisions.get("coordinator")).not.toBe(firstRevision);
  });
});

import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import {
  createPaletteCloneRecovery,
  usePaletteCloneScope,
  type PaletteCloneInput,
} from "./paletteCloneRecovery";

const environmentId = EnvironmentId.make("computer-a");
const input: PaletteCloneInput = {
  projectId: ProjectId.make("original-project"),
  title: "example",
  createdAt: "2026-10-06T09:00:00.000Z",
  remoteUrl: "https://example.com/owner/example.git",
  destinationPath: "/work/example",
};
const result = { projectId: input.projectId, cwd: input.destinationPath };
function memoryStorage() {
  const rows = new Map<string, string>();
  return {
    rows,
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => {
      rows.set(key, value);
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const operations = () => ({
  build: vi.fn(() => input),
  readProject: vi.fn((): { workspaceRoot: string } | null => null),
  start: vi.fn(async (_input: PaletteCloneInput) => result),
  open: vi.fn(async (_projectId: ProjectId, _cwd: string, _isCurrent: () => boolean) => true),
  isCurrent: () => true,
});

it("recovers a lost admission reply after remount using only the original exact project", async () => {
  const storage = memoryStorage();
  const first = createPaletteCloneRecovery(environmentId, storage);
  const lost = operations();
  lost.start.mockImplementation(async () => {
    expect([...storage.rows.values()][0]).toContain(input.projectId);
    throw new Error("reply lost");
  });
  await first.getState().run(lost);
  expect(first.getState().attempt?.admittedCwd).toBeNull();
  expect(lost.open).not.toHaveBeenCalled();

  const reloaded = createPaletteCloneRecovery(environmentId, storage);
  const recover = operations();
  recover.build.mockReturnValue({
    ...input,
    projectId: ProjectId.make("wrong-new-project"),
    destinationPath: "/changed",
  });
  recover.readProject.mockImplementation((projectId?: ProjectId) =>
    projectId === input.projectId ? { workspaceRoot: input.destinationPath } : null,
  );
  await reloaded.getState().run(recover);
  expect(recover.readProject).toHaveBeenCalledWith(input.projectId);
  expect(recover.build).not.toHaveBeenCalled();
  expect(recover.start).not.toHaveBeenCalled();
  expect(recover.open).toHaveBeenCalledWith(
    input.projectId,
    input.destinationPath,
    recover.isCurrent,
  );
  expect(reloaded.getState().attempt).toBeNull();
});

it("retries the immutable input after an unconfirmed preparation failure, even when the form changed", async () => {
  const storage = memoryStorage();
  const first = createPaletteCloneRecovery(environmentId, storage);
  const failed = operations();
  failed.start.mockRejectedValue(new Error("destination rejected before admission"));
  await first.getState().run(failed);
  const reloaded = createPaletteCloneRecovery(environmentId, storage);
  const retry = operations();
  retry.build.mockReturnValue({
    ...input,
    remoteUrl: "https://example.com/different.git",
    destinationPath: "/changed",
  });
  await reloaded.getState().run(retry);
  expect(retry.build).not.toHaveBeenCalled();
  expect(retry.start).toHaveBeenCalledExactlyOnceWith(input);
});

it.each(["write", "readback"])("refuses dispatch when recovery %s fails", async (failure) => {
  const storage = memoryStorage();
  const recovery = createPaletteCloneRecovery(environmentId, storage);
  if (failure === "write")
    storage.setItem = () => {
      throw new Error("full");
    };
  else storage.getItem = () => null;
  const calls = operations();
  await recovery.getState().run(calls);
  expect(calls.start).not.toHaveBeenCalled();
  expect(calls.open).not.toHaveBeenCalled();
  expect(recovery.getState().error).toContain("save clone recovery");
});

it("keeps the durable original when saving confirmed admission fails", async () => {
  const storage = memoryStorage();
  const write = storage.setItem;
  storage.setItem = (key, value) => {
    if (JSON.parse(value).admittedCwd) throw new Error("disk full");
    write(key, value);
  };
  const recovery = createPaletteCloneRecovery(environmentId, storage);
  const calls = operations();
  await recovery.getState().run(calls);
  expect(calls.start).toHaveBeenCalledOnce();
  expect(calls.open).not.toHaveBeenCalled();
  storage.setItem = write;
  const reloaded = createPaletteCloneRecovery(environmentId, storage);
  expect(reloaded.getState().attempt?.input).toEqual(input);
  const retry = operations();
  retry.readProject.mockReturnValue({ workspaceRoot: input.destinationPath });
  await reloaded.getState().run(retry);
  expect(retry.start).not.toHaveBeenCalled();
  expect(retry.open).toHaveBeenCalledOnce();
});

it.each(["closed", "other computer", "different flow"])(
  "does not navigate after the palette becomes %s",
  async () => {
    const storage = memoryStorage();
    const recovery = createPaletteCloneRecovery(environmentId, storage);
    const admission = deferred<typeof result>();
    let current = true;
    const calls = { ...operations(), isCurrent: () => current };
    calls.start.mockReturnValue(admission.promise);
    const pending = recovery.getState().run(calls);
    current = false;
    admission.resolve(result);
    await pending;
    expect(calls.open).not.toHaveBeenCalled();
    expect(recovery.getState().attempt?.admittedCwd).toBe(input.destinationPath);
    const other = createPaletteCloneRecovery(EnvironmentId.make("computer-b"), storage);
    expect(other.getState().attempt).toBeNull();
    const reloaded = createPaletteCloneRecovery(environmentId, storage);
    const reopen = operations();
    await reloaded.getState().run(reopen);
    expect(reopen.start).not.toHaveBeenCalled();
    expect(reopen.open).toHaveBeenCalledWith(
      input.projectId,
      input.destinationPath,
      reopen.isCurrent,
    );
  },
);

it("retains admission when navigation fails or is cancelled during route preparation", async () => {
  const storage = memoryStorage();
  const recovery = createPaletteCloneRecovery(environmentId, storage);
  const calls = operations();
  calls.open.mockRejectedValueOnce(new Error("navigation unavailable"));
  await recovery.getState().run(calls);
  calls.open.mockResolvedValueOnce(false);
  await recovery.getState().run(calls);
  expect(recovery.getState().attempt?.admittedCwd).toBe(input.destinationPath);
  calls.open.mockResolvedValueOnce(true);
  await recovery.getState().run(calls);
  expect(calls.start).toHaveBeenCalledOnce();
  expect(recovery.getState().attempt).toBeNull();
});

it("never persists or resends a sanitized private URL after reload, but can still recover its project", async () => {
  const storage = memoryStorage();
  const privateInput = {
    ...input,
    remoteUrl: "https://name:secret@example.com/repo.git?token=private#ref",
  };
  const recovery = createPaletteCloneRecovery(environmentId, storage);
  const calls = operations();
  calls.build.mockReturnValue(privateInput);
  calls.start.mockRejectedValue(new Error("private remote error"));
  await recovery.getState().run(calls);
  expect(calls.start).toHaveBeenCalledExactlyOnceWith(privateInput);
  const durable = [...storage.rows.values()][0]!;
  expect(durable).not.toMatch(/secret|token|private|name:/);
  const reloaded = createPaletteCloneRecovery(environmentId, storage);
  const retry = operations();
  await reloaded.getState().run(retry);
  expect(retry.start).not.toHaveBeenCalled();
  expect(retry.build).not.toHaveBeenCalled();
  expect(reloaded.getState().error).toContain("private repository URL was not saved");
  retry.readProject.mockReturnValue({ workspaceRoot: input.destinationPath });
  await reloaded.getState().run(retry);
  expect(retry.start).not.toHaveBeenCalled();
  expect(retry.open).toHaveBeenCalledOnce();
});

it("sanitizes a previously stored private URL at the read boundary too", async () => {
  const storage = memoryStorage();
  storage.setItem(
    `t3code:palette-clone:v1:${environmentId}`,
    JSON.stringify({
      input: { ...input, remoteUrl: "https://example.com/repo.git?token=private" },
      admittedCwd: null,
    }),
  );
  const recovery = createPaletteCloneRecovery(environmentId, storage);
  const calls = operations();
  await recovery.getState().run(calls);
  expect(calls.start).not.toHaveBeenCalled();
  expect(recovery.getState().attempt?.input.remoteUrl).toBe("");
});

it("reconciles an arriving exact project without dispatching or navigating", async () => {
  const storage = memoryStorage();
  const recovery = createPaletteCloneRecovery(environmentId, storage);
  const calls = operations();
  calls.start.mockRejectedValue(new Error("reply lost"));
  await recovery.getState().run(calls);
  const read = vi.fn((projectId: ProjectId) =>
    projectId === input.projectId ? { workspaceRoot: input.destinationPath } : null,
  );
  recovery.getState().reconcile(read);
  expect(recovery.getState().attempt?.admittedCwd).toBe(input.destinationPath);
  expect(recovery.getState().error).toBeNull();
  expect(calls.start).toHaveBeenCalledOnce();
  expect(calls.open).not.toHaveBeenCalled();
});

it("guards double Enter and refuses local discard while admission is pending", async () => {
  const recovery = createPaletteCloneRecovery(environmentId, memoryStorage());
  const admission = deferred<typeof result>();
  const calls = operations();
  calls.start.mockReturnValue(admission.promise);
  const first = recovery.getState().run(calls);
  const second = recovery.getState().run(calls);
  expect(recovery.getState().forget(input.projectId)).toBe(false);
  admission.resolve(result);
  await Promise.all([first, second]);
  expect(calls.build).toHaveBeenCalledOnce();
  expect(calls.start).toHaveBeenCalledOnce();
  expect(calls.open).toHaveBeenCalledOnce();
});

it("preserves recovery on failed cleanup and allows a later intentional clone only after completion", async () => {
  const storage = memoryStorage();
  const write = storage.setItem;
  storage.setItem = (key, value) => {
    if (value.includes('"status":"cleared"')) throw new Error("cannot clear");
    write(key, value);
  };
  const recovery = createPaletteCloneRecovery(environmentId, storage);
  const calls = operations();
  await recovery.getState().run(calls);
  expect(recovery.getState().attempt?.admittedCwd).toBe(input.destinationPath);
  expect(recovery.getState().error).toContain("clear clone recovery");
  storage.setItem = write;
  await recovery.getState().run(calls);
  expect(calls.start).toHaveBeenCalledOnce();
  const next = { ...input, projectId: ProjectId.make("next-project"), destinationPath: "/next" };
  calls.build.mockReturnValue(next);
  calls.start.mockResolvedValue({ projectId: next.projectId, cwd: next.destinationPath });
  await recovery.getState().run(calls);
  expect(calls.start).toHaveBeenLastCalledWith(next);
});

it("explicit forgetting permits correction but a stale view cannot forget newer work", async () => {
  const storage = memoryStorage();
  const first = createPaletteCloneRecovery(environmentId, storage);
  const calls = operations();
  calls.start.mockRejectedValue(new Error("unconfirmed"));
  await first.getState().run(calls);
  const stale = createPaletteCloneRecovery(environmentId, storage);
  expect(first.getState().forget(input.projectId)).toBe(true);
  const next = {
    ...input,
    projectId: ProjectId.make("next-project"),
    destinationPath: "/corrected",
  };
  calls.build.mockReturnValue(next);
  await first.getState().run(calls);
  expect(stale.getState().forget(input.projectId)).toBe(false);
  expect(createPaletteCloneRecovery(environmentId, storage).getState().attempt?.input).toEqual(
    next,
  );
});

it("does not accept a receipt for another project or erase unexplained missing recovery", async () => {
  const storage = memoryStorage();
  const recovery = createPaletteCloneRecovery(environmentId, storage);
  const calls = operations();
  calls.start.mockResolvedValue({ ...result, projectId: ProjectId.make("wrong-project") });
  await recovery.getState().run(calls);
  expect(calls.open).not.toHaveBeenCalled();
  expect(recovery.getState().attempt?.admittedCwd).toBeNull();
  storage.rows.clear();
  await recovery.getState().run(calls);
  expect(calls.start).toHaveBeenCalledOnce();
  expect(calls.build).toHaveBeenCalledOnce();
  expect(recovery.getState().forget(input.projectId)).toBe(true);
  expect(recovery.getState().attempt).toBeNull();
});

it("opens an exact project observed after a lost reply without another start", async () => {
  const recovery = createPaletteCloneRecovery(environmentId, memoryStorage());
  const calls = operations();
  let project: { workspaceRoot: string } | null = null;
  calls.readProject.mockImplementation(() => project);
  calls.start.mockImplementation(async () => {
    project = { workspaceRoot: input.destinationPath };
    throw new Error("connection closed after admission");
  });
  await recovery.getState().run(calls);
  expect(calls.start).toHaveBeenCalledOnce();
  expect(calls.open).toHaveBeenCalledWith(input.projectId, input.destinationPath, calls.isCurrent);
  expect(recovery.getState().attempt).toBeNull();
  expect(recovery.getState().error).toBeNull();
});

it.each(["admission", "route preparation"] as const)(
  "fences delayed %s through a mounted dialog close and reopen",
  async (stage) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const recovery = createPaletteCloneRecovery(environmentId, memoryStorage());
    const admission = deferred<typeof result>();
    const route = deferred<void>();
    const enteredRoute = deferred<void>();
    const navigate = vi.fn();
    const calls = operations();
    if (stage === "admission") calls.start.mockReturnValue(admission.promise);
    calls.open.mockImplementation(async (_projectId, _cwd, isCurrent) => {
      enteredRoute.resolve();
      if (stage === "route preparation") await route.promise;
      if (!isCurrent()) return false;
      navigate();
      return true;
    });
    const scope = {};
    function Harness({ open }: { open: boolean }) {
      const isCurrent = usePaletteCloneScope(open, scope);
      return createElement("button", {
        onClick: () => recovery.getState().run({ ...calls, isCurrent }),
      });
    }
    let renderer: ReactTestRenderer | undefined;
    let pending: Promise<void> | undefined;
    try {
      await act(async () => {
        renderer = create(createElement(Harness, { open: true }));
      });
      await act(async () => {
        pending = renderer!.root.findByType("button").props.onClick();
      });
      if (stage === "route preparation") await enteredRoute.promise;
      // The same component remains mounted during the close transition, then opens again.
      await act(async () => {
        renderer!.update(createElement(Harness, { open: false }));
      });
      await act(async () => {
        renderer!.update(createElement(Harness, { open: true }));
      });
      await act(async () => {
        if (stage === "admission") admission.resolve(result);
        else route.resolve();
        await pending;
      });
      expect(navigate).not.toHaveBeenCalled();
      expect(recovery.getState().attempt?.admittedCwd).toBe(input.destinationPath);
      await act(async () => {
        await renderer!.root.findByType("button").props.onClick();
      });
      expect(navigate).toHaveBeenCalledOnce();
      expect(calls.start).toHaveBeenCalledOnce();
      expect(recovery.getState().attempt).toBeNull();
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      vi.unstubAllGlobals();
    }
  },
);

it.each([
  "invalid JSON",
  JSON.stringify({ input: { ...input, createdAt: 42 }, admittedCwd: null }),
])("requires explicit forgetting of an unreadable record before a new clone", async (stored) => {
  const storage = memoryStorage();
  storage.setItem(`t3code:palette-clone:v1:${environmentId}`, stored);
  const recovery = createPaletteCloneRecovery(environmentId, storage);
  const calls = operations();
  expect(recovery.getState().canForgetUnreadable).toBe(true);
  await recovery.getState().run(calls);
  expect(calls.build).not.toHaveBeenCalled();
  expect(calls.start).not.toHaveBeenCalled();
  expect(recovery.getState().forgetUnreadable()).toBe(true);
  await recovery.getState().run(calls);
  expect(calls.start).toHaveBeenCalledExactlyOnceWith(input);
});

it("does not erase a newer valid request when forgetting a previously unreadable record", async () => {
  const storage = memoryStorage();
  const key = `t3code:palette-clone:v1:${environmentId}`;
  storage.setItem(key, "invalid JSON");
  const stale = createPaletteCloneRecovery(environmentId, storage);
  const corrected = JSON.stringify({ input, admittedCwd: null });
  storage.setItem(key, corrected);
  expect(stale.getState().forgetUnreadable()).toBe(false);
  expect(storage.getItem(key)).toBe(corrected);
  expect(stale.getState().attempt?.input).toEqual(input);
  const calls = operations();
  await stale.getState().run(calls);
  expect(calls.build).not.toHaveBeenCalled();
  expect(calls.start).toHaveBeenCalledExactlyOnceWith(input);
});

it("cannot discard inaccessible storage or dispatch a clone through it", async () => {
  const storage = memoryStorage();
  storage.getItem = () => {
    throw new Error("access blocked");
  };
  const recovery = createPaletteCloneRecovery(environmentId, storage);
  const calls = operations();
  expect(recovery.getState().canForgetUnreadable).toBe(false);
  expect(recovery.getState().forgetUnreadable()).toBe(false);
  await recovery.getState().run(calls);
  expect(calls.build).not.toHaveBeenCalled();
  expect(calls.start).not.toHaveBeenCalled();
});

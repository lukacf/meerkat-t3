import { EnvironmentId } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { writeFile, confirmFile, getOptimisticFile, markSaveFailed } = vi.hoisted(() => ({
  writeFile: vi.fn(),
  confirmFile: vi.fn(),
  getOptimisticFile: vi.fn(),
  markSaveFailed: vi.fn(),
}));
vi.mock("~/state/projects", () => ({ projectEnvironment: { writeFile: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => writeFile }));
vi.mock("./projectFilesQueryState", () => ({
  confirmProjectFileQueryData: confirmFile,
  getOptimisticProjectFileQueryData: getOptimisticFile,
  markProjectFileSaveFailed: markSaveFailed,
}));

import { setMarkdownTaskChecked } from "./filePreviewMode";
import { useFileSaveCoordinator } from "./useFileSaveCoordinator";
import * as workspaceMutations from "~/state/workspaceMutations";
import { withWorkspaceRestore } from "~/state/workspaceMutations";

const environmentId = EnvironmentId.make("save-lifecycle-audit");
const onPendingChange = vi.fn();
const defaultProps = {
  environmentId,
  cwd: "/workspace",
  relativePath: "file.txt",
  onPendingChange,
};
let renderer: ReactTestRenderer | null;

function ChangeSource(_props: { onChange: (contents: string) => void }) {
  return null;
}

function FileSurface(props: Parameters<typeof useFileSaveCoordinator>[0]) {
  const coordinator = useFileSaveCoordinator(props);
  return <ChangeSource onChange={(contents) => coordinator.change(contents)} />;
}

function mount(props = defaultProps) {
  act(() => {
    renderer = create(
      <StrictMode>
        <FileSurface {...props} />
      </StrictMode>,
    );
  });
}

function changeHandler(): (contents: string) => void {
  return renderer!.root.findByType(ChangeSource).props.onChange;
}

beforeEach(() => {
  renderer = null;
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  writeFile.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  confirmFile.mockReset();
  getOptimisticFile.mockReset().mockReturnValue({ contents: "current optimistic file" });
  markSaveFailed.mockReset();
  onPendingChange.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("file-save React lifecycle", () => {
  it.each(["success", "failure"] as const)(
    "ignores an older %s after another pane replaces the optimistic edit with identical text",
    async (outcome) => {
      let finishWrite!: (result: AtomCommandResult<void, unknown>) => void;
      writeFile.mockReturnValueOnce(
        new Promise((resolve) => {
          finishWrite = resolve;
        }),
      );
      getOptimisticFile.mockReturnValue({ contents: "same text" });
      mount();
      changeHandler()("same text");
      await vi.advanceTimersByTimeAsync(500);
      // A second pane publishes a distinct edit while the original write is in flight.
      getOptimisticFile.mockReturnValue({ contents: "same text" });
      finishWrite(
        outcome === "success"
          ? AsyncResult.success(undefined)
          : AsyncResult.failure(Cause.fail(new Error("old write refused"))),
      );
      await vi.runAllTimersAsync();
      expect(confirmFile).not.toHaveBeenCalled();
      expect(markSaveFailed).not.toHaveBeenCalled();
      changeHandler()("same text");
      await vi.runAllTimersAsync();
      expect(confirmFile).toHaveBeenCalledExactlyOnceWith(
        environmentId,
        "/workspace",
        "file.txt",
        "same text",
      );
    },
  );

  it("marks only the exact failed file for recovery after the view closes", async () => {
    writeFile.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("write failed"))));
    mount();
    changeHandler()("recover this text");
    await vi.advanceTimersByTimeAsync(500);
    await act(async () => renderer!.unmount());
    renderer = null;
    await vi.runAllTimersAsync();
    expect(markSaveFailed.mock.calls).toEqual([
      [environmentId, "/workspace", "file.txt", "recover this text"],
      [environmentId, "/workspace", "file.txt", "recover this text"],
    ]);
    expect(confirmFile).not.toHaveBeenCalled();
    mount();
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "failure"] as const)(
    "does not let a failed pane overwrite restore after another pane saves (close retry %s)",
    async (retryResult) => {
      let disk = "original";
      let pendingText: string | null = null;
      let attemptsForA = 0;
      let finishRetry!: (result: AtomCommandResult<void, unknown>) => void;
      writeFile.mockImplementation(({ input }: { input: { contents: string } }) => {
        if (input.contents === "pane A") {
          attemptsForA++;
          if (attemptsForA === 1)
            return Promise.resolve(
              AsyncResult.failure(Cause.fail(new Error("first write failed"))),
            );
          return new Promise<AtomCommandResult<void, unknown>>((resolve) => {
            finishRetry = resolve;
          }).then((result) => {
            if (result._tag === "Success") disk = input.contents;
            return result;
          });
        }
        disk = input.contents;
        return Promise.resolve(AsyncResult.success(undefined));
      });
      confirmFile.mockImplementation((_environment, _cwd, _path, contents: string) => {
        if (pendingText === contents) pendingText = null;
      });
      const panes = (includeA: boolean) => (
        <StrictMode>
          {includeA ? <FileSurface key="a" {...defaultProps} /> : null}
          <FileSurface key="b" {...defaultProps} />
        </StrictMode>
      );
      act(() => {
        renderer = create(panes(true));
      });
      const [sourceA, sourceB] = renderer!.root.findAllByType(ChangeSource);
      const retiredA = sourceA!.props.onChange as (contents: string) => void;
      pendingText = "pane A";
      retiredA("pane A");
      await vi.advanceTimersByTimeAsync(500);
      pendingText = "pane B";
      sourceB!.props.onChange("pane B");
      await vi.advanceTimersByTimeAsync(500);
      expect(disk).toBe("pane B");
      expect(pendingText).toBeNull();

      const restore = vi.fn(async () => {
        disk = "restored";
      });
      const tryRestore = () =>
        withWorkspaceRestore(defaultProps, ["file.txt"], () => pendingText !== null, restore);
      await expect(tryRestore()).rejects.toThrow("Wait for pending edits");
      act(() => {
        renderer!.update(panes(false));
      });
      await expect(tryRestore()).rejects.toThrow("Wait for pending edits");
      finishRetry(
        retryResult === "success"
          ? AsyncResult.success(undefined)
          : AsyncResult.failure(Cause.fail(new Error("final retry failed"))),
      );
      await vi.runAllTimersAsync();
      await tryRestore();
      expect(restore).toHaveBeenCalledOnce();
      retiredA("stale callback");
      await act(async () => renderer!.unmount());
      renderer = null;
      await vi.runAllTimersAsync();
      expect(writeFile).toHaveBeenCalledTimes(3);
      expect(disk).toBe("restored");
    },
  );

  it("refuses a close-time retry if restore is already holding the file lock", async () => {
    writeFile.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("write failed"))));
    mount();
    changeHandler()("unsaved contents");
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledOnce();
    const restoring = vi
      .spyOn(workspaceMutations, "isWorkspaceFileRestoring")
      .mockReturnValue(true);
    try {
      await act(async () => renderer!.unmount());
      renderer = null;
      await vi.runAllTimersAsync();
      expect(writeFile).toHaveBeenCalledOnce();
      expect(confirmFile).not.toHaveBeenCalled();
      expect(onPendingChange).not.toHaveBeenCalledWith("file.txt", false);
    } finally {
      restoring.mockRestore();
    }
    await expect(
      withWorkspaceRestore(
        defaultProps,
        ["file.txt"],
        () => false,
        async () => "released",
      ),
    ).resolves.toBe("released");
  });

  it("does not save stale editor callbacks during restore and accepts edits after read-back", async () => {
    mount();
    let finishReadBack!: () => void;
    const readBack = new Promise<void>((resolve) => {
      finishReadBack = resolve;
    });
    const restore = withWorkspaceRestore(
      defaultProps,
      ["file.txt"],
      () => false,
      () => readBack,
    );
    changeHandler()("pre-restore text");
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).not.toHaveBeenCalled();
    expect(onPendingChange).not.toHaveBeenCalled();

    finishReadBack();
    await restore;
    changeHandler()("edit of restored text");
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "file.txt", contents: "edit of restored text" },
    });
  });

  it("blocks restore through a pending save even after the editor unmounts", async () => {
    let finishWrite!: (result: AtomCommandResult<void, never>) => void;
    writeFile.mockReturnValue(
      new Promise<AtomCommandResult<void, never>>((resolve) => {
        finishWrite = resolve;
      }),
    );
    mount();
    changeHandler()("unsaved edit");
    const restore = vi.fn().mockResolvedValue(undefined);
    await expect(
      withWorkspaceRestore(defaultProps, ["file.txt"], () => false, restore),
    ).rejects.toThrow("Wait for pending edits");
    await act(async () => renderer!.unmount());
    renderer = null;
    await expect(
      withWorkspaceRestore(defaultProps, ["file.txt"], () => false, restore),
    ).rejects.toThrow("Wait for pending edits");
    finishWrite(AsyncResult.success(undefined));
    await vi.runAllTimersAsync();
    await withWorkspaceRestore(defaultProps, ["file.txt"], () => false, restore);
    expect(restore).toHaveBeenCalledOnce();
  });

  it("persists editor model changes after StrictMode setup replay", async () => {
    mount();
    changeHandler()("AUDIT7907NATIVE\n");
    expect(onPendingChange).toHaveBeenCalledWith("file.txt", true);
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "file.txt", contents: "AUDIT7907NATIVE\n" },
    });
    expect(confirmFile).toHaveBeenCalledExactlyOnceWith(
      environmentId,
      "/workspace",
      "file.txt",
      "AUDIT7907NATIVE\n",
    );
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("persists rendered Markdown task changes after StrictMode setup replay", async () => {
    mount({ ...defaultProps, relativePath: "README.md" });
    const nextContents = setMarkdownTaskChecked("- [ ] task\n", 2, true);
    changeHandler()(nextContents);
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "README.md", contents: "- [x] task\n" },
    });
  });

  it("keeps the debounce across rerenders of the same file", async () => {
    mount();
    changeHandler()("first");
    await vi.advanceTimersByTimeAsync(300);
    act(() =>
      renderer!.update(
        <StrictMode>
          <FileSurface {...defaultProps} />
        </StrictMode>,
      ),
    );
    changeHandler()("latest");
    await vi.advanceTimersByTimeAsync(499);
    expect(writeFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("latest");
  });

  it("flushes on unmount and ignores a retired editor callback", async () => {
    mount();
    const retiredChange = changeHandler();
    retiredChange("pending edit");
    await act(async () => renderer!.unmount());
    renderer = null;
    retiredChange("stale editor contents");
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("pending edit");
  });

  it.each([
    { relativePath: "other.txt" },
    { cwd: "/other-workspace" },
    { environmentId: EnvironmentId.make("other-environment") },
  ])("retires callbacks when the file identity changes: %j", async (change) => {
    mount();
    const retiredChange = changeHandler();
    retiredChange("old file edit");
    const nextProps = { ...defaultProps, ...change };
    act(() =>
      renderer!.update(
        <StrictMode>
          <FileSurface {...nextProps} />
        </StrictMode>,
      ),
    );
    retiredChange("stale editor contents");
    changeHandler()("new file edit");
    await vi.runAllTimersAsync();
    expect(writeFile.mock.calls.map(([request]) => request)).toEqual([
      {
        environmentId,
        input: { cwd: "/workspace", relativePath: "file.txt", contents: "old file edit" },
      },
      {
        environmentId: nextProps.environmentId,
        input: {
          cwd: nextProps.cwd,
          relativePath: nextProps.relativePath,
          contents: "new file edit",
        },
      },
    ]);
  });

  it("does not reactivate a retired callback when the same file mounts again", async () => {
    mount();
    const retiredChange = changeHandler();
    await act(async () => renderer!.unmount());
    renderer = null;
    mount();
    retiredChange("stale contents");
    changeHandler()("current contents");
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("current contents");
  });
});

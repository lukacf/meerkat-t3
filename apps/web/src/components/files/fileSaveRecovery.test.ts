import { EnvironmentId, type ProjectReadFileResult } from "@t3tools/contracts";
import type { OptimisticProjectFile } from "@t3tools/client-runtime/state/projects";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { writeFile } = vi.hoisted(() => ({ writeFile: vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => writeFile }));

vi.mock("~/rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/unstable/reactivity");
  return {
    appAtomRegistry: AtomRegistry.make({
      scheduleTask: (task) => {
        const timer = setTimeout(task, 0);
        return () => clearTimeout(timer);
      },
    }),
  };
});

vi.mock("~/state/projects", async () => {
  const { Atom, AsyncResult } = await import("effect/unstable/reactivity");
  const optimistic = Atom.family((_key: string) => Atom.make<OptimisticProjectFile | null>(null));
  const read = Atom.make(
    AsyncResult.success({
      relativePath: "file.txt",
      contents: "disk contents",
      byteLength: 13,
      truncated: false,
    }),
  );
  return {
    projectEnvironment: {
      writeFile: {},
      optimisticFile: (target: unknown) => optimistic(JSON.stringify(target)),
      readFile: () => read,
    },
  };
});

vi.mock("~/state/queries", () => ({ useProjectPathSearch: vi.fn() }));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { FileSaveCoordinator } from "./fileSaveCoordinator";
import { useFileSaveCoordinator } from "./useFileSaveCoordinator";
import { createFileEditRecoveryStore } from "./fileEditRecoveryStore";
import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  hasPendingProjectFileEdit,
  markProjectFileSaveFailed,
  optimisticFileAtom,
  resolveProjectFileQueryData,
  setProjectFileQueryData,
} from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("failed-file-save-recovery");
const cwd = "/workspace";
const relativePath = "file.txt";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  writeFile.mockReset();
});

afterEach(async () => {
  clearProjectFileQueryData(environmentId, cwd, relativePath);
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("failed file-save recovery", () => {
  it("recovers persisted text after registry loss without replacing a newer disk query or sending a write", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    });
    setProjectFileQueryData(environmentId, cwd, relativePath, "recover after reload\n");
    markProjectFileSaveFailed(environmentId, cwd, relativePath, "recover after reload\n");
    clearProjectFileQueryData(environmentId, cwd, relativePath);
    const reopened = createFileEditRecoveryStore(() => localStorage, "reopened-renderer");
    const copy = reopened.getSnapshot({ environmentId, cwd, relativePath }).copies[0]!;
    expect(copy.contents).toBe("recover after reload\n");
    const newerDisk = {
      relativePath,
      contents: "external disk edit",
      byteLength: 18,
      truncated: false,
    };
    expect(resolveProjectFileQueryData(environmentId, cwd, relativePath, newerDisk)).toBe(
      newerDisk,
    );
    expect(reopened.discard({ environmentId, cwd, relativePath }, copy)).toBe(true);
    expect(writeFile).not.toHaveBeenCalled();
    expect(newerDisk.contents).toBe("external disk edit");
  });

  it("retains the last X edit when older pane writes X then Y succeed but the final X fails after close", async () => {
    let disk = "original";
    const writes: Array<{
      contents: string;
      finish: (result: AtomCommandResult<void, unknown>) => void;
    }> = [];
    writeFile.mockImplementation(
      ({ input }: { input: { contents: string } }) =>
        new Promise<AtomCommandResult<void, unknown>>((resolve) => {
          writes.push({
            contents: input.contents,
            finish: (result) => {
              if (result._tag === "Success") disk = input.contents;
              resolve(result);
            },
          });
        }),
    );
    const onPendingChange = vi.fn();
    function ChangeSource(_props: { onChange: (contents: string) => void }) {
      return null;
    }
    function Pane() {
      const coordinator = useFileSaveCoordinator({
        environmentId,
        cwd,
        relativePath,
        onPendingChange,
      });
      return createElement(ChangeSource, {
        onChange: (contents) => {
          if (coordinator.change(contents))
            setProjectFileQueryData(environmentId, cwd, relativePath, contents);
        },
      });
    }
    const atom = optimisticFileAtom(environmentId, cwd, relativePath);
    const closeViews = appAtomRegistry.mount(atom);
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(createElement("div", null, createElement(Pane), createElement(Pane)));
    });
    const [paneA, paneB] = renderer.root.findAllByType(ChangeSource);
    paneA!.props.onChange("X");
    await vi.advanceTimersByTimeAsync(500);
    paneB!.props.onChange("Y");
    await vi.advanceTimersByTimeAsync(500);
    paneB!.props.onChange("X");
    await act(async () => renderer.unmount());
    closeViews();
    try {
      expect(writes.map(({ contents }) => contents)).toEqual(["X", "Y"]);
      writes[0]!.finish(AsyncResult.success(undefined));
      await vi.runAllTimersAsync();
      expect(getOptimisticProjectFileQueryData(environmentId, cwd, relativePath)?.contents).toBe(
        "X",
      );
      expect(hasPendingProjectFileEdit(environmentId, cwd, relativePath)).toBe(true);
      writes[1]!.finish(AsyncResult.success(undefined));
      await vi.runAllTimersAsync();
      expect(writes.map(({ contents }) => contents)).toEqual(["X", "Y", "X"]);
      writes[2]!.finish(AsyncResult.failure(Cause.fail(new Error("final write refused"))));
      await vi.runAllTimersAsync();
      expect(disk).toBe("Y");
      expect(appAtomRegistry.get(atom)?.data.contents).toBe("X");
      expect(appAtomRegistry.get(atom)?.saveFailed).toBe(true);
      expect(hasPendingProjectFileEdit(environmentId, cwd, relativePath)).toBe(true);
      act(() => {
        renderer = create(createElement(Pane));
      });
      await vi.runAllTimersAsync();
      expect(writeFile).toHaveBeenCalledTimes(3);
      expect(disk).toBe("Y");
      expect(getOptimisticProjectFileQueryData(environmentId, cwd, relativePath)?.contents).toBe(
        "X",
      );
    } finally {
      await act(async () => renderer.unmount());
    }
  });

  it.each(["my unsaved edit", ""])(
    "retains failed text %j after the last view closes without replaying it over a newer disk edit",
    async (contents) => {
      const atom = optimisticFileAtom(environmentId, cwd, relativePath);
      const closeView = appAtomRegistry.mount(atom);
      const persist = vi
        .fn()
        .mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("write refused"))));
      const makeCoordinator = () =>
        new FileSaveCoordinator({
          debounceMs: 500,
          persist,
          onPendingChange: vi.fn(),
          onConfirmed: (saved) =>
            confirmProjectFileQueryData(environmentId, cwd, relativePath, saved),
          onSaveFailed: (failed) =>
            markProjectFileSaveFailed(environmentId, cwd, relativePath, failed),
        });
      const original = makeCoordinator();
      original.change(contents);
      setProjectFileQueryData(environmentId, cwd, relativePath, contents);
      await vi.advanceTimersByTimeAsync(500);
      original.dispose();
      closeView();
      await vi.runAllTimersAsync();
      expect(persist).toHaveBeenCalledTimes(2);

      const closeReopenedView = appAtomRegistry.mount(atom);
      const reopened = makeCoordinator();
      try {
        expect(getOptimisticProjectFileQueryData(environmentId, cwd, relativePath)?.contents).toBe(
          contents,
        );
        expect(appAtomRegistry.get(atom)?.saveFailed).toBe(true);
        expect(hasPendingProjectFileEdit(environmentId, cwd, relativePath)).toBe(true);
        const newerDiskFile = {
          relativePath,
          contents: "another tool's newer edit",
          byteLength: 25,
          truncated: false,
        } satisfies ProjectReadFileResult;
        expect(
          resolveProjectFileQueryData(environmentId, cwd, relativePath, newerDiskFile)?.contents,
        ).toBe(contents);
        await vi.runAllTimersAsync();
        expect(persist).toHaveBeenCalledTimes(2);
        expect(newerDiskFile.contents).toBe("another tool's newer edit");
      } finally {
        reopened.dispose();
        closeReopenedView();
      }
    },
  );

  it("keeps the newer failed edit when an older in-flight write succeeds after closing", async () => {
    let finishFirst!: (result: AtomCommandResult<void, unknown>) => void;
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, unknown>>>()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
      )
      .mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("latest write refused"))));
    const closeView = appAtomRegistry.mount(optimisticFileAtom(environmentId, cwd, relativePath));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: (contents) =>
        confirmProjectFileQueryData(environmentId, cwd, relativePath, contents),
      onSaveFailed: (contents) =>
        markProjectFileSaveFailed(environmentId, cwd, relativePath, contents),
    });
    coordinator.change("old edit");
    setProjectFileQueryData(environmentId, cwd, relativePath, "old edit");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("newer edit");
    setProjectFileQueryData(environmentId, cwd, relativePath, "newer edit");
    coordinator.dispose();
    closeView();
    finishFirst(AsyncResult.success(undefined));
    await vi.runAllTimersAsync();
    expect(persist.mock.calls.map(([contents]) => contents)).toEqual(["old edit", "newer edit"]);
    const atom = optimisticFileAtom(environmentId, cwd, relativePath);
    expect(appAtomRegistry.get(atom)?.data.contents).toBe("newer edit");
    expect(appAtomRegistry.get(atom)?.saveFailed).toBe(true);
    expect(hasPendingProjectFileEdit(environmentId, cwd, relativePath)).toBe(true);
  });

  it("does not clear a newer retained edit when an earlier confirming read settles", async () => {
    const atom = optimisticFileAtom(environmentId, cwd, relativePath);
    const closeView = appAtomRegistry.mount(atom);
    setProjectFileQueryData(environmentId, cwd, relativePath, "saved edit");
    expect(confirmProjectFileQueryData(environmentId, cwd, relativePath, "saved edit")).toBe(true);
    setProjectFileQueryData(environmentId, cwd, relativePath, "newer unsaved edit");
    markProjectFileSaveFailed(environmentId, cwd, relativePath, "newer unsaved edit");
    closeView();
    await vi.runAllTimersAsync();
    expect(appAtomRegistry.get(atom)?.data.contents).toBe("newer unsaved edit");
    expect(appAtomRegistry.get(atom)?.saveFailed).toBe(true);
    expect(hasPendingProjectFileEdit(environmentId, cwd, relativePath)).toBe(true);
  });

  it("releases the retained buffer after a successful save", async () => {
    const atom = optimisticFileAtom(environmentId, cwd, relativePath);
    const closeView = appAtomRegistry.mount(atom);
    setProjectFileQueryData(environmentId, cwd, relativePath, "edit");
    markProjectFileSaveFailed(environmentId, cwd, relativePath, "edit");
    expect(confirmProjectFileQueryData(environmentId, cwd, relativePath, "edit")).toBe(true);
    expect(appAtomRegistry.get(atom)?.saveFailed).toBe(false);
    expect(hasPendingProjectFileEdit(environmentId, cwd, relativePath)).toBe(false);
    closeView();
    await vi.runAllTimersAsync();
    expect(appAtomRegistry.getNodes().has(atom)).toBe(false);
  });

  it("explicit clearing releases the buffer without affecting another environment", async () => {
    const otherEnvironment = EnvironmentId.make("other-computer");
    const atom = optimisticFileAtom(environmentId, cwd, relativePath);
    const otherAtom = optimisticFileAtom(otherEnvironment, cwd, relativePath);
    setProjectFileQueryData(environmentId, cwd, relativePath, "first computer");
    setProjectFileQueryData(otherEnvironment, cwd, relativePath, "second computer");
    try {
      clearProjectFileQueryData(environmentId, cwd, relativePath);
      await vi.runAllTimersAsync();
      expect(appAtomRegistry.getNodes().has(atom)).toBe(false);
      expect(appAtomRegistry.get(otherAtom)?.data.contents).toBe("second computer");
    } finally {
      clearProjectFileQueryData(otherEnvironment, cwd, relativePath);
    }
    await vi.runAllTimersAsync();
    expect(appAtomRegistry.getNodes().has(otherAtom)).toBe(false);
  });

  it("ignores stale failures and resets the warning when editing resumes", async () => {
    const atom = optimisticFileAtom(environmentId, cwd, relativePath);
    setProjectFileQueryData(environmentId, cwd, relativePath, "current edit");
    markProjectFileSaveFailed(environmentId, cwd, relativePath, "old edit");
    expect(appAtomRegistry.get(atom)?.saveFailed).not.toBe(true);
    markProjectFileSaveFailed(environmentId, cwd, relativePath, "current edit");
    expect(appAtomRegistry.get(atom)?.saveFailed).toBe(true);
    setProjectFileQueryData(environmentId, cwd, relativePath, "new edit");
    expect(appAtomRegistry.get(atom)?.saveFailed).not.toBe(true);
    expect(hasPendingProjectFileEdit(environmentId, cwd, relativePath)).toBe(true);
  });
});

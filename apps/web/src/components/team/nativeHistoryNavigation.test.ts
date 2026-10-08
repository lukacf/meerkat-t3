import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  captureNativeHistoryPosition,
  navigateNativeHistory,
  type NativeHistoryList,
} from "./nativeHistoryNavigation";

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "Element",
    class extends EventTarget {
      closest() {
        return null;
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());
async function paint() {
  await Promise.resolve();
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(0));
}
function fixture() {
  const document = new EventTarget();
  const viewport = Object.assign(new EventTarget(), {
    ownerDocument: document,
    scrollTop: 300,
    scrollHeight: 2000,
    clientHeight: 500,
    getBoundingClientRect: () => ({ top: 0 }),
  });
  let completeIndex!: () => void;
  const focus = vi.fn();
  const finish = vi.fn();
  const scrollToIndex = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        completeIndex = resolve;
      }),
  );
  const scrollToOffset = vi.fn(({ offset }: { offset: number }) => {
    viewport.scrollTop = offset;
    return Promise.resolve();
  });
  const list = {
    scrollToIndex,
    scrollToOffset,
    getScrollableNode: () => viewport,
    getState: () => ({
      start: 0,
      elementAtIndex: () => ({
        getBoundingClientRect: () => ({ top: 600 - viewport.scrollTop, height: 100 }),
      }),
    }),
  } as unknown as NativeHistoryList;
  return {
    viewport,
    document,
    focus,
    finish,
    list,
    scrollToOffset,
    completeIndex: () => completeIndex(),
  };
}

describe("native history navigation", () => {
  it("scrolls to the current end on repeated explicit navigation requests", async () => {
    const f = fixture();
    navigateNativeHistory({ list: f.list, index: -1, atEnd: true, onFinish: f.finish });
    expect(f.viewport.scrollTop).toBe(1500);
    f.viewport.scrollHeight = 2400;
    await paint();
    await paint();
    await paint();
    expect(f.viewport.scrollTop).toBe(1900);
    expect(captureNativeHistoryPosition(f.list, ["saved-message"])?.atEnd).toBe(true);
    expect(f.finish).toHaveBeenCalledTimes(1);
    expect(f.focus).not.toHaveBeenCalled();

    f.viewport.scrollTop = 200;
    navigateNativeHistory({ list: f.list, index: -1, atEnd: true, onFinish: f.finish });
    await paint();
    await paint();
    expect(f.viewport.scrollTop).toBe(1900);
    expect(f.finish).toHaveBeenCalledTimes(2);
  });

  it("does not pull the reader back to latest after they interrupt a refresh scroll", async () => {
    const f = fixture();
    navigateNativeHistory({ list: f.list, index: -1, atEnd: true, onFinish: f.finish });
    f.viewport.scrollTop = 500;
    f.viewport.dispatchEvent(Object.assign(new Event("wheel"), { deltaY: -100, deltaX: 0 }));
    f.viewport.scrollHeight = 3000;
    await paint();
    await paint();
    expect(f.viewport.scrollTop).toBe(500);
    expect(captureNativeHistoryPosition(f.list, ["saved-message"])?.atEnd).toBe(false);
    expect(f.finish).toHaveBeenCalledTimes(1);
    expect(f.focus).not.toHaveBeenCalled();
  });

  it.each(["wheel", "touchmove", "pointerdown", "PageUp", "Tab"])(
    "yields to %s while an estimated scroll is pending and never steals focus afterwards",
    async (gesture) => {
      const f = fixture();
      const cleanup = navigateNativeHistory({
        list: f.list,
        index: 4,
        focus: f.focus,
        onFinish: f.finish,
      });
      if (gesture === "wheel")
        f.viewport.dispatchEvent(Object.assign(new Event("wheel"), { deltaY: -100, deltaX: 0 }));
      else if (gesture === "touchmove") f.viewport.dispatchEvent(new Event("touchmove"));
      else if (gesture === "pointerdown") f.document.dispatchEvent(new Event("pointerdown"));
      else f.document.dispatchEvent(Object.assign(new Event("keydown"), { key: gesture }));
      expect(f.scrollToOffset).toHaveBeenLastCalledWith({ offset: 300, animated: false });
      f.completeIndex();
      await paint();
      await paint();
      expect(f.focus).not.toHaveBeenCalled();
      expect(f.finish).toHaveBeenCalledTimes(1);
      expect(f.scrollToOffset).toHaveBeenCalledTimes(1);
      cleanup();
    },
  );

  it("centers a measured search target then focuses once without leaving gesture listeners", async () => {
    const f = fixture();
    navigateNativeHistory({ list: f.list, index: 4, focus: f.focus, onFinish: f.finish });
    f.completeIndex();
    await paint();
    await paint();
    await paint();
    expect(f.viewport.scrollTop).toBe(400);
    expect(f.focus).toHaveBeenCalledTimes(1);
    expect(f.finish).toHaveBeenCalledTimes(1);
    f.document.dispatchEvent(new Event("pointerdown"));
    expect(f.scrollToOffset).toHaveBeenCalledTimes(1);
  });

  it("restores the same pixel inside a row after prepended content changes its absolute position", async () => {
    const f = fixture();
    navigateNativeHistory({
      list: f.list,
      index: 4,
      position: { rowId: "old", offsetWithinRow: 23, scrollOffset: 90, atEnd: false },
      onFinish: f.finish,
    });
    f.completeIndex();
    await paint();
    await paint();
    await paint();
    expect(f.viewport.scrollTop).toBe(623);
    expect(f.focus).not.toHaveBeenCalled();
    expect(f.finish).toHaveBeenCalledTimes(1);
  });

  it("supersedes an unfinished target when its component unmounts or another search replaces it", async () => {
    const f = fixture();
    const cleanup = navigateNativeHistory({
      list: f.list,
      index: 4,
      focus: f.focus,
      onFinish: f.finish,
    });
    cleanup();
    f.completeIndex();
    await paint();
    expect(f.scrollToOffset).toHaveBeenCalledWith({ offset: 300, animated: false });
    expect(f.focus).not.toHaveBeenCalled();
    expect(f.finish).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });
});

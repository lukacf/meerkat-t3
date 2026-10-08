import type { LegendListRef } from "@legendapp/list/react";
import { StrictMode, act, type RefObject } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  useNativeHistoryViewport,
  type NativeHistoryEndFocusRequest,
} from "./useNativeHistoryViewport";

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let nextIdentity = 0;
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function paint() {
  await act(async () => {
    await Promise.resolve();
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
}

function fixture({ deferred = false } = {}) {
  const body = { isConnected: true };
  const document = Object.assign(new EventTarget(), {
    body,
    documentElement: { isConnected: true },
    activeElement: body as { isConnected: boolean } | null,
  });
  const viewport = Object.assign(new EventTarget(), {
    ownerDocument: document,
    scrollTop: 300,
    scrollHeight: 2000,
    clientHeight: 500,
    getBoundingClientRect: () => ({ top: 0 }),
  });
  const rowIds = ["8", "9", "10"];
  const articles = rowIds.map(() => {
    const article = { ownerDocument: document, isConnected: true, focus: vi.fn() };
    article.focus.mockImplementation(() => {
      document.activeElement = article;
    });
    return article;
  });
  let resolveScroll!: () => void;
  const firstScroll = new Promise<void>((resolve) => {
    resolveScroll = resolve;
  });
  let awaitingScroll = deferred;
  const scrollToOffset = vi.fn(({ offset }: { offset: number }) => {
    viewport.scrollTop = offset;
    if (awaitingScroll) {
      awaitingScroll = false;
      return firstScroll;
    }
    return Promise.resolve();
  });
  const list = {
    scrollToOffset,
    scrollToIndex: vi.fn(() => firstScroll),
    getScrollableNode: () => viewport,
    getState: () => ({
      start: 0,
      elementAtIndex: (index: number) =>
        articles[index]
          ? {
              querySelector: () => articles[index],
              getBoundingClientRect: () => ({
                top: 600 + index * 600 - viewport.scrollTop,
                height: 100,
              }),
            }
          : undefined,
    }),
  } as unknown as LegendListRef;
  const onHandled = vi.fn();
  const request: NativeHistoryEndFocusRequest = { id: "explicit-latest", onHandled };
  return {
    identity: `viewport-focus-${++nextIdentity}`,
    listRef: { current: list } as RefObject<LegendListRef | null>,
    rowIds,
    articles,
    viewport,
    document,
    request,
    onHandled,
    resolveScroll,
  };
}

function Viewport(props: Parameters<typeof useNativeHistoryViewport>[0]) {
  useNativeHistoryViewport(props);
  return null;
}

describe("native history viewport focus", () => {
  it("focuses the latest article once after an explicit action crosses a revision-keyed mount", async () => {
    const f = fixture();
    const render = (revision: string, endRequest: number, focus?: NativeHistoryEndFocusRequest) => (
      <StrictMode>
        <Viewport
          key={revision}
          identity={`${f.identity}:${revision}`}
          listRef={f.listRef}
          rowIds={f.rowIds}
          endRequest={endRequest}
          {...(focus ? { endFocusRequest: focus } : {})}
        />
      </StrictMode>
    );
    await act(() => {
      renderer = create(render("old", 0));
    });
    await act(() => renderer!.update(render("new", 1, f.request)));
    expect(f.articles[2]!.focus).not.toHaveBeenCalled();
    await paint();
    expect(f.articles[2]!.focus).not.toHaveBeenCalled();
    await paint();
    expect(f.viewport.scrollTop).toBe(1500);
    expect(f.articles[2]!.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(f.articles[0]!.focus).not.toHaveBeenCalled();
    expect(f.onHandled).toHaveBeenCalledTimes(1);
    await act(() => renderer!.update(render("new", 1)));
    await paint();
    expect(f.articles[2]!.focus).toHaveBeenCalledTimes(1);
  });

  it("keeps automatic revision following and ordinary refresh focus-neutral", async () => {
    const f = fixture();
    const render = (revision: string, endRequest: number) => (
      <Viewport
        key={revision}
        identity={`${f.identity}:${revision}`}
        listRef={f.listRef}
        rowIds={f.rowIds}
        endRequest={endRequest}
      />
    );
    await act(() => {
      renderer = create(render("old", 0));
    });
    await act(() => renderer!.update(render("new", 0)));
    await act(() => renderer!.update(render("new", 1)));
    await paint();
    await paint();
    expect(f.viewport.scrollTop).toBe(1500);
    expect(f.articles.every((article) => article.focus.mock.calls.length === 0)).toBe(true);
  });

  it.each(["Tab", "wheel", "pointerdown"])(
    "consumes the explicit request when %s cancels a pending latest-message scroll",
    async (gesture) => {
      const f = fixture({ deferred: true });
      await act(() => {
        renderer = create(
          <Viewport
            identity={f.identity}
            listRef={f.listRef}
            rowIds={f.rowIds}
            endRequest={1}
            endFocusRequest={f.request}
          />,
        );
      });
      await act(() => {
        f.viewport.scrollTop = 500;
        if (gesture === "wheel")
          f.viewport.dispatchEvent(Object.assign(new Event("wheel"), { deltaY: -100, deltaX: 0 }));
        else if (gesture === "pointerdown") f.document.dispatchEvent(new Event("pointerdown"));
        else f.document.dispatchEvent(Object.assign(new Event("keydown"), { key: gesture }));
      });
      expect(f.onHandled).toHaveBeenCalledTimes(1);
      f.resolveScroll();
      await paint();
      await paint();
      expect(f.viewport.scrollTop).toBe(500);
      expect(f.articles.every((article) => article.focus.mock.calls.length === 0)).toBe(true);
    },
  );

  it("abandons pending focus on unmount and does not replay the end counter when saved messages reopen", async () => {
    const f = fixture({ deferred: true });
    await act(() => {
      renderer = create(
        <Viewport
          identity={f.identity}
          listRef={f.listRef}
          rowIds={f.rowIds}
          endRequest={1}
          endFocusRequest={f.request}
        />,
      );
    });
    await act(() => renderer!.unmount());
    f.resolveScroll();
    await paint();
    expect(f.articles.every((article) => article.focus.mock.calls.length === 0)).toBe(true);
    // The parent discards the action when leaving saved messages; effect cleanup is not completion.
    expect(f.onHandled).not.toHaveBeenCalled();
    await act(() => {
      renderer = create(
        <Viewport identity={f.identity} listRef={f.listRef} rowIds={f.rowIds} endRequest={1} />,
      );
    });
    await paint();
    expect(f.articles.every((article) => article.focus.mock.calls.length === 0)).toBe(true);
  });

  it("leaves focus on another connected control reached before navigation settles", async () => {
    const f = fixture();
    await act(() => {
      renderer = create(
        <Viewport
          identity={f.identity}
          listRef={f.listRef}
          rowIds={f.rowIds}
          endFocusRequest={f.request}
        />,
      );
    });
    const control = { isConnected: true };
    f.document.activeElement = control;
    await paint();
    await paint();
    expect(f.document.activeElement).toBe(control);
    expect(f.articles.every((article) => article.focus.mock.calls.length === 0)).toBe(true);
    expect(f.onHandled).toHaveBeenCalledTimes(1);
  });

  it("preserves explicit search targeting instead of focusing the latest article", async () => {
    const f = fixture();
    await act(() => {
      renderer = create(
        <Viewport identity={f.identity} listRef={f.listRef} rowIds={f.rowIds} selectedRowId="9" />,
      );
    });
    f.resolveScroll();
    await paint();
    await paint();
    await paint();
    expect(f.articles[1]!.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(f.articles[2]!.focus).not.toHaveBeenCalled();
  });
});

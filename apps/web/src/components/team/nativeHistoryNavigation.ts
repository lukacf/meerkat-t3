import type { LegendListRef } from "@legendapp/list/react";
import type { NativeHistoryPosition } from "./nativeHistoryState";

export type NativeHistoryList = Pick<
  LegendListRef,
  "scrollToIndex" | "scrollToOffset" | "getState" | "getScrollableNode"
>;

export function captureNativeHistoryPosition(
  list: NativeHistoryList,
  rowIds: readonly string[],
): NativeHistoryPosition | undefined {
  const state = list.getState();
  const viewport = list.getScrollableNode();
  const index = state.start;
  const rowId = rowIds[index];
  const row = state.elementAtIndex(index);
  if (!viewport || !row || rowId === undefined) return undefined;
  return {
    rowId,
    offsetWithinRow: viewport.getBoundingClientRect().top - row.getBoundingClientRect().top,
    scrollOffset: viewport.scrollTop,
    atEnd: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 2,
  };
}

/** Supersede estimated virtual-list scrolling as soon as the user takes control. */
export function navigateNativeHistory({
  list,
  index,
  position,
  atEnd = false,
  focus,
  onFinish,
}: {
  list: NativeHistoryList;
  index: number;
  position?: NativeHistoryPosition;
  atEnd?: boolean;
  focus?: () => void;
  onFinish: () => void;
}) {
  const viewport = list.getScrollableNode();
  if (!viewport) return () => {};
  const document = viewport.ownerDocument;
  let active = true;
  let frame: number | undefined;
  let stableFrames = 0;
  let attempts = 0;
  const detach = () => {
    viewport.removeEventListener("wheel", wheel);
    viewport.removeEventListener("touchmove", cancel);
    document.removeEventListener("pointerdown", cancel, true);
    document.removeEventListener("keydown", keydown);
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
  const finish = () => {
    if (!active) return;
    active = false;
    detach();
    onFinish();
  };
  const cancel = () => {
    if (!active) return;
    // LegendList can still be waiting for an estimated target to be measured.
    // A boolean alone suppresses focus but does not stop that pending scroll.
    void list.scrollToOffset({ offset: viewport.scrollTop, animated: false });
    finish();
  };
  const wheel = (event: WheelEvent) => {
    if (event.deltaY !== 0 || event.deltaX !== 0) cancel();
  };
  const keydown = (event: KeyboardEvent) => {
    if (
      ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Escape", "Tab"].includes(
        event.key,
      ) &&
      !(
        event.target instanceof Element &&
        event.target.closest("input, textarea, [contenteditable=true]")
      )
    )
      cancel();
  };
  viewport.addEventListener("wheel", wheel, { passive: true });
  viewport.addEventListener("touchmove", cancel, { passive: true });
  document.addEventListener("pointerdown", cancel, true);
  document.addEventListener("keydown", keydown);
  const settle = () => {
    if (!active) return;
    const row = atEnd ? undefined : list.getState().elementAtIndex(index);
    if (atEnd) {
      const offset = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      if (Math.abs(offset - viewport.scrollTop) > 1) {
        stableFrames = 0;
        void list.scrollToOffset({ offset, animated: false });
      } else stableFrames++;
    } else if (row) {
      const bounds = row.getBoundingClientRect();
      const top = viewport.getBoundingClientRect().top;
      const desired = position
        ? top - position.offsetWithinRow
        : top + Math.max(0, viewport.clientHeight - bounds.height) / 2;
      const offset = Math.max(
        0,
        Math.min(
          viewport.scrollHeight - viewport.clientHeight,
          viewport.scrollTop + bounds.top - desired,
        ),
      );
      if (Math.abs(offset - viewport.scrollTop) > 1) {
        stableFrames = 0;
        void list.scrollToOffset({ offset, animated: false });
      } else stableFrames++;
    }
    if (stableFrames >= 2 || ++attempts >= 12) {
      if (active) focus?.();
      finish();
    } else frame = requestAnimationFrame(settle);
  };
  const scrolling = atEnd
    ? list.scrollToOffset({
        offset: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
        animated: false,
      })
    : index >= 0
      ? list.scrollToIndex({ index, viewPosition: position ? 0 : 0.5, animated: false })
      : list.scrollToOffset({ offset: position?.scrollOffset ?? 0, animated: false });
  void scrolling.then(() => {
    if (!active) return;
    if (index < 0 && !atEnd) finish();
    else frame = requestAnimationFrame(settle);
  }, finish);
  return () => {
    if (!active) return;
    void list.scrollToOffset({ offset: viewport.scrollTop, animated: false });
    active = false;
    detach();
  };
}

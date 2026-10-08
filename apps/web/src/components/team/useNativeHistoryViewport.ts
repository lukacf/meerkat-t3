import type { LegendListRef } from "@legendapp/list/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { captureNativeHistoryPosition, navigateNativeHistory } from "./nativeHistoryNavigation";
import { readNativeHistoryPosition, rememberNativeHistoryPosition } from "./nativeHistoryState";

export type NativeHistoryEndFocusRequest = {
  id: string;
  onHandled: () => void;
};

export function useNativeHistoryViewport({
  identity,
  listRef,
  rowIds,
  selectedRowId,
  endRequest,
  endFocusRequest,
}: {
  identity: string;
  listRef: RefObject<LegendListRef | null>;
  rowIds: readonly string[];
  selectedRowId?: string;
  endRequest?: number;
  endFocusRequest?: NativeHistoryEndFocusRequest;
}) {
  const remembered = useMemo(() => readNativeHistoryPosition(identity), [identity]);
  const target = `${identity}:${selectedRowId ?? "restore"}:${endRequest ?? 0}`;
  // An old request must not replay when the reader returns from live activity.
  // New-revision mounts use their remembered position; only new requests scroll this mount.
  const mountedEndRequest = useRef(endRequest ?? 0).current;
  const focusEnd = endFocusRequest !== undefined;
  const openingEnd = focusEnd || (endRequest ?? 0) !== mountedEndRequest;
  const [finishedTarget, setFinishedTarget] = useState<string | null>(null);
  const positioning =
    finishedTarget !== target &&
    (openingEnd || selectedRowId !== undefined || remembered?.atEnd === false);
  const targetRowId = openingEnd
    ? undefined
    : (selectedRowId ?? (positioning ? remembered?.rowId : undefined));
  const index = targetRowId === undefined ? -1 : rowIds.indexOf(targetRowId);
  const snapshot = useRef({ identity, rowIds, positioning });
  useLayoutEffect(() => {
    snapshot.current = { identity, rowIds, positioning };
  });
  const remember = useCallback(() => {
    const current = snapshot.current;
    if (current.positioning || !listRef.current) return;
    const position = captureNativeHistoryPosition(listRef.current, current.rowIds);
    if (position) rememberNativeHistoryPosition(current.identity, position);
  }, [listRef]);
  useLayoutEffect(() => {
    if (
      !positioning ||
      !listRef.current ||
      (!openingEnd && selectedRowId !== undefined && index < 0)
    )
      return;
    const list = listRef.current;
    const focusLatest = focusEnd;
    return navigateNativeHistory({
      list,
      index,
      ...(openingEnd ? { atEnd: true } : {}),
      ...(!openingEnd && selectedRowId === undefined && remembered ? { position: remembered } : {}),
      ...(focusLatest || (!openingEnd && selectedRowId !== undefined)
        ? {
            focus: () => {
              const row: HTMLElement | null | undefined = list
                .getState()
                .elementAtIndex(focusLatest ? rowIds.length - 1 : index);
              const article = row?.querySelector<HTMLElement>("[data-agent-transcript-offset]");
              if (focusLatest && article) {
                const document = article.ownerDocument;
                const active = document.activeElement;
                if (
                  active?.isConnected &&
                  active !== document.body &&
                  active !== document.documentElement
                )
                  return;
              }
              article?.focus({ preventScroll: true });
            },
          }
        : {}),
      onFinish: () => {
        setFinishedTarget(target);
        if (focusLatest) endFocusRequest!.onHandled();
      },
    });
  }, [
    positioning,
    listRef,
    index,
    selectedRowId,
    remembered,
    target,
    openingEnd,
    focusEnd,
    endFocusRequest,
    rowIds.length,
  ]);
  useLayoutEffect(() => {
    if (finishedTarget === target) remember();
  }, [finishedTarget, target, remember]);
  useLayoutEffect(() => () => remember(), [remember]);
  const measureFrame = useRef<number | null>(null);
  const onItemSizeChanged = useCallback(() => {
    if (measureFrame.current !== null) return;
    measureFrame.current = requestAnimationFrame(() => {
      measureFrame.current = null;
      remember();
    });
  }, [remember]);
  useEffect(
    () => () => {
      if (measureFrame.current !== null) cancelAnimationFrame(measureFrame.current);
    },
    [],
  );
  return {
    positioning,
    initialScrollAtEnd: openingEnd || (selectedRowId === undefined && remembered?.atEnd !== false),
    ...(index >= 0 && positioning
      ? {
          initialScrollIndex: { index, viewPosition: selectedRowId === undefined ? 0 : 0.5 },
          alwaysRender: { keys: [targetRowId!] },
        }
      : {}),
    onLoad: remember,
    onScroll: remember,
    onItemSizeChanged,
    remember,
  };
}

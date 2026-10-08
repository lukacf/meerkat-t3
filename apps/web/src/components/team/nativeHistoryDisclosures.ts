import { useCallback, useEffect, useRef, useState } from "react";
import {
  readNativeHistoryDisclosures,
  rememberNativeHistoryDisclosures,
} from "./nativeHistoryState";

/** Keep disclosure choices outside virtual rows so scrolling does not close them. */
export function useNativeHistoryDisclosures(identity: string) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() =>
    readNativeHistoryDisclosures(identity),
  );
  const [settling, setSettling] = useState(false);
  const anchor = useRef<string | null>(null);
  const frame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  const prepare = useCallback((rowId: string) => {
    anchor.current = rowId;
    setSettling(true);
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = requestAnimationFrame(() => {
        anchor.current = null;
        frame.current = null;
        setSettling(false);
      });
    });
  }, []);
  const toggle = useCallback(
    (id: string, open: boolean, rowId = id) => {
      prepare(rowId);
      setExpanded((previous) => {
        if (previous.has(id) === open) return previous;
        const next = new Set(previous);
        if (open) next.add(id);
        else next.delete(id);
        rememberNativeHistoryDisclosures(identity, next);
        return next;
      });
    },
    [identity, prepare],
  );
  const shouldRestorePosition = useCallback(
    (rowId: string) => anchor.current === null || anchor.current === rowId,
    [],
  );
  return { expanded, toggle, prepare, settling, shouldRestorePosition };
}

export type NativeHistoryDisclosures = ReturnType<typeof useNativeHistoryDisclosures>;

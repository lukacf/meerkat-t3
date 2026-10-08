import { useLayoutEffect, useMemo, useState } from "react";
import { createNativeHistoryCache } from "./nativeHistoryState";
import {
  groupNativeToolActivity,
  nativeToolActivityPartitions,
  type NativeActivityRow,
  type NativeToolActivityPartitions,
} from "./nativeToolActivity.logic";

// IDs only: presentation boundaries share the conversation's disclosure/scroll lifetime.
const partitions = createNativeHistoryCache<NativeToolActivityPartitions>(20, 1024 * 1024);

export function useNativeToolActivity(identity: string, rows: readonly NativeActivityRow[]) {
  const [previous, setPrevious] = useState(() => ({
    identity,
    rows,
    displayRows: groupNativeToolActivity(rows, partitions.get(identity)),
  }));
  let current = previous;
  if (previous.identity !== identity || previous.rows !== rows) {
    current = {
      identity,
      rows,
      displayRows: groupNativeToolActivity(
        rows,
        previous.identity === identity && !previous.rows.some((row) => row.kind === "raw")
          ? nativeToolActivityPartitions(previous.displayRows)
          : partitions.get(identity),
      ),
    };
    setPrevious(current);
  }
  const membership = useMemo(
    () => nativeToolActivityPartitions(current.displayRows),
    [current.displayRows],
  );
  useLayoutEffect(() => {
    // The raw details view has no groups, and must not erase the conversation's partitions.
    if (!rows.some((row) => row.kind === "raw")) partitions.set(identity, membership);
  }, [identity, membership, rows]);
  return current.displayRows;
}

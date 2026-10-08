import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useEffect } from "react";
import { meerkatControlsEnvironment } from "./meerkatControls";
import { useEnvironmentQuery } from "./query";

export function useMeerkatAttention(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  itemId?: string,
  poll = false,
) {
  const query = useEnvironmentQuery(
    meerkatControlsEnvironment.attention({
      environmentId,
      input: { projectId, ...(itemId ? { itemId } : {}) },
    }),
  );
  useEffect(() => {
    if (!poll || query.isPending) return;
    const delay =
      query.dataUpdatedAt === null
        ? 5_000
        : Math.max(1_000, 5_000 - (Date.now() - query.dataUpdatedAt));
    const timer = window.setTimeout(query.refresh, delay);
    return () => window.clearTimeout(timer);
  }, [poll, query.isPending, query.refresh, query.dataUpdatedAt]);
  return query;
}

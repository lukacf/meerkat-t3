import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import { restoreReviewWorkBlock } from "./restoreReviewReadiness";

export function useRestoreReview(environmentId: EnvironmentId | null) {
  const configs = useAtomValue(environmentServerConfigsAtom);
  return environmentId ? configs.get(environmentId)?.restoreReview : undefined;
}

export function useRestoreReviewWorkBlock(environmentId: EnvironmentId | null): string | null {
  return restoreReviewWorkBlock(useRestoreReview(environmentId));
}

/** Event handlers re-read server admission before consuming local draft state. */
export function readRestoreReviewWorkBlock(environmentId: EnvironmentId): string | null {
  return restoreReviewWorkBlock(
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.restoreReview,
  );
}

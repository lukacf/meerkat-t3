import type { RestoreReviewSnapshot, RestoreReviewStatus } from "@t3tools/contracts";

/** Missing status is compatible with servers that predate restore review. */
export function restoreReviewWorkBlock(review: RestoreReviewStatus | undefined): string | null {
  if (!review || review.status === "clear") return null;
  if (review.status === "restart-required")
    return "Restored work is still paused. Restart this environment to apply your review. Your draft is unchanged.";
  if (review.status === "invalid")
    return "Restored work is paused because the restore record could not be verified. Review the restore details. Your draft is unchanged.";
  return "Restored work is paused. Review the restored profile before starting or resuming work. Your draft is unchanged.";
}

export function canConsentRestoreReview(
  status: RestoreReviewStatus,
  snapshot: RestoreReviewSnapshot | null | undefined,
): boolean {
  return (
    status.status === "required" &&
    snapshot?.status === "required" &&
    status.restoreId !== null &&
    snapshot.restoreId === status.restoreId
  );
}

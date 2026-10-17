import type {
  SharedCheckoutPatch,
  SharedCheckoutRevision,
  SharedRevision,
  SharedSnapshot,
} from "@t3tools/contracts";

/** The preview is local evidence, not permission to send its contents. */
export function readySharedPatch(preview: SharedCheckoutPatch, maxBytes: number): void {
  if (
    preview.status !== "ready" ||
    !preview.branch ||
    !preview.patch ||
    !preview.sha256 ||
    preview.filesTruncated ||
    preview.excludedTruncated ||
    preview.excluded.some((item) => item.reason !== "ignored")
  )
    throw new Error(
      "This checkout cannot be shared as a snapshot. Resolve the excluded changes and preview again.",
    );
  if (preview.bytes > maxBytes)
    throw new Error("This patch exceeds the shared workspace's snapshot limit.");
}

export function sharedPatchRevision(preview: SharedCheckoutPatch): SharedRevision {
  if (!preview.branch) throw new Error("Choose a branch before sharing a snapshot.");
  return { branch: preview.branch, commit: preview.commit, applicability: "branch" };
}

export function assertSameSharedPatch(
  reviewed: SharedCheckoutPatch,
  current: SharedCheckoutPatch,
): void {
  if (
    current.status !== "ready" ||
    reviewed.projectId !== current.projectId ||
    reviewed.threadId !== current.threadId ||
    reviewed.branch !== current.branch ||
    reviewed.commit !== current.commit ||
    reviewed.sha256 !== current.sha256 ||
    reviewed.bytes !== current.bytes ||
    reviewed.patch !== current.patch ||
    current.filesTruncated ||
    current.excludedTruncated ||
    JSON.stringify(reviewed.files) !== JSON.stringify(current.files) ||
    JSON.stringify(reviewed.excluded) !== JSON.stringify(current.excluded)
  )
    throw new Error(
      "The checkout changed since this preview. Preview and share a new snapshot before continuing.",
    );
}

export function assertSharedSnapshot(
  preview: SharedCheckoutPatch,
  snapshot: SharedSnapshot,
  checkoutId: string,
  sharedProjectId: string,
): void {
  if (
    snapshot.checkoutId !== checkoutId ||
    snapshot.sharedProjectId !== sharedProjectId ||
    snapshot.sha256 !== preview.sha256 ||
    snapshot.bytes !== preview.bytes ||
    snapshot.revision.branch !== preview.branch ||
    snapshot.revision.commit !== preview.commit ||
    snapshot.revision.applicability !== "branch" ||
    snapshot.revision.snapshotId
  )
    throw new Error(
      "The shared host returned a different snapshot. Nothing has been sent to the specialist.",
    );
}

export function assertSnapshotObservation(
  preview: SharedCheckoutPatch,
  revision: SharedCheckoutRevision,
): void {
  if (
    revision.projectId !== preview.projectId ||
    revision.commit !== preview.commit ||
    revision.branch !== preview.branch
  )
    throw new Error(
      "The checkout revision changed. Preview and share a new snapshot before continuing.",
    );
}

import {
  ProjectId,
  ThreadId,
  type SharedCheckoutPatch,
  type SharedSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  assertSameSharedPatch,
  assertSharedSnapshot,
  assertSnapshotObservation,
  readySharedPatch,
} from "./sharedSnapshot";

const preview: SharedCheckoutPatch = {
  projectId: ProjectId.make("catalog"),
  threadId: ThreadId.make("task"),
  branch: "feature/catalog",
  commit: "a".repeat(40),
  observedAt: "2026-10-17T12:00:00Z",
  status: "ready",
  scope: "tracked_changes",
  patch: "diff --git a/catalog.ts b/catalog.ts\n+new\n",
  sha256: "b".repeat(64),
  bytes: 42,
  files: [{ path: "catalog.ts", change: "modified" }],
  filesTruncated: false,
  excluded: [{ path: "node_modules/", reason: "ignored" }],
  excludedTruncated: false,
  maxBytes: 1_048_576,
  maxFiles: 256,
};
const snapshot: SharedSnapshot = {
  snapshotId: "snapshot-exact",
  sharedProjectId: "shared-catalog",
  checkoutId: "checkout",
  revision: { branch: "feature/catalog", commit: preview.commit, applicability: "branch" },
  sha256: preview.sha256!,
  bytes: preview.bytes,
  createdAt: preview.observedAt,
};

describe("explicit snapshot boundaries", () => {
  it("accepts complete tracked changes while disclosing ignored files", () => {
    expect(() => readySharedPatch(preview, 1024)).not.toThrow();
    expect(() =>
      assertSameSharedPatch(preview, { ...preview, observedAt: "2026-10-17T12:01:00Z" }),
    ).not.toThrow();
    expect(() =>
      assertSharedSnapshot(preview, snapshot, "checkout", "shared-catalog"),
    ).not.toThrow();
  });
  it.each([
    { excluded: [{ path: "new.ts", reason: "untracked" as const }] },
    { excluded: [{ path: "photo.png", reason: "binary" as const }] },
    { filesTruncated: true },
    { excludedTruncated: true },
    { status: "unsupported" as const },
    { patch: null },
    { branch: null },
    { bytes: 1025 },
  ])("rejects an incomplete or disallowed preview: %j", (change) => {
    expect(() => readySharedPatch({ ...preview, ...change }, 1024)).toThrow();
  });
  it.each([
    { projectId: ProjectId.make("other-project") },
    { threadId: ThreadId.make("other-task") },
    { commit: "c".repeat(40) },
    { branch: "other-branch" },
    { sha256: "c".repeat(64) },
    { patch: "different patch" },
    { bytes: 43 },
    { files: [] },
    { excludedTruncated: true },
  ])("rejects a changed capture: %j", (change) => {
    expect(() => assertSameSharedPatch(preview, { ...preview, ...change })).toThrow(
      "checkout changed",
    );
  });
  it.each([
    { checkoutId: "other-checkout" },
    { sharedProjectId: "other-project" },
    { sha256: "c".repeat(64) },
    { bytes: 99 },
    { revision: { ...snapshot.revision, commit: "c".repeat(40) } },
  ])("rejects a mismatched upload receipt: %j", (change) => {
    expect(() =>
      assertSharedSnapshot(preview, { ...snapshot, ...change }, "checkout", "shared-catalog"),
    ).toThrow("different snapshot");
  });
  it("rejects a revision observation from another base commit", () => {
    expect(() =>
      assertSnapshotObservation(preview, {
        projectId: preview.projectId,
        branch: preview.branch,
        commit: "c".repeat(40),
        dirty: true,
        observedAt: preview.observedAt,
      }),
    ).toThrow("revision changed");
  });
});

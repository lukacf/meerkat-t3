import { ProjectId, type SharedCheckoutPatch, type SharedSnapshot } from "@t3tools/contracts";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "span",
  TooltipTrigger: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipPopup: "span",
}));
import { SharedSnapshotPanel } from "./SharedSnapshotPanel";

const preview: SharedCheckoutPatch = {
  projectId: ProjectId.make("catalog"),
  branch: "feature/catalog",
  commit: "a".repeat(40),
  observedAt: "2026-10-17T12:00:00Z",
  status: "ready",
  scope: "tracked_changes",
  patch: "diff --git a/catalog.ts b/catalog.ts\n+updated\n",
  sha256: "b".repeat(64),
  bytes: 42,
  files: [{ path: "catalog.ts", change: "modified" }],
  filesTruncated: false,
  excluded: [],
  excludedTruncated: false,
  maxBytes: 1_048_576,
  maxFiles: 256,
};
const snapshot: SharedSnapshot = {
  snapshotId: "snapshot",
  checkoutId: "checkout",
  sharedProjectId: "shared-catalog",
  revision: { branch: preview.branch!, commit: preview.commit, applicability: "branch" },
  sha256: preview.sha256!,
  bytes: preview.bytes,
  createdAt: preview.observedAt,
};
let rendered: ReactTestRenderer | undefined;
let state: ComponentProps<typeof SharedSnapshotPanel>["state"];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state = {
    preview,
    snapshot: null,
    busy: false,
    error: null,
    previewChanges: vi.fn(async () => {}),
    shareSnapshot: vi.fn(async () => {}),
    resolveRevision: vi.fn(),
  };
});
afterEach(async () => {
  await act(async () => rendered?.unmount());
  rendered = undefined;
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => {
    const panel = (
      <SharedSnapshotPanel state={state} destination="Atlas engineering" maxBytes={1024} />
    );
    if (rendered) rendered.update(panel);
    else rendered = create(panel);
  });
}
function button(label: string) {
  return rendered!.root.findAllByType("button").find((item) => item.children.includes(label))!;
}
async function click(label: string) {
  await act(async () => button(label).props.onClick());
}
function text() {
  return JSON.stringify(rendered!.toJSON());
}

describe("shared snapshot summary", () => {
  it("collapses the reviewed patch only after sharing is confirmed", async () => {
    await render();
    expect(rendered!.root.findAllByType("pre")).toHaveLength(1);
    expect(text()).toContain("Nothing is uploaded");
    state = { ...state, snapshot };
    await render();
    expect(text()).toContain("Snapshot shared");
    expect(text()).toContain("Atlas engineering");
    expect(text()).toContain("42");
    expect(text()).not.toContain("Nothing is uploaded");
    expect(text()).not.toContain("Tracked changes only");
    expect(rendered!.root.findAllByType("pre")).toHaveLength(0);
    expect(rendered!.root.findAllByType("ul")).toHaveLength(0);
    expect(button("View shared snapshot").props["aria-expanded"]).toBe(false);
  });
  it("reopens retained details without uploading or recapturing until explicitly refreshed", async () => {
    state = { ...state, snapshot };
    await render();
    await click("View shared snapshot");
    expect(button("Hide snapshot").props["aria-expanded"]).toBe(true);
    expect(text()).toContain("catalog.ts");
    expect(text()).toContain("feature/catalog");
    expect(text()).toContain("aaaaaaaaaaaa");
    expect(rendered!.root.findAllByType("pre")).toHaveLength(1);
    expect(state.previewChanges).not.toHaveBeenCalled();
    expect(state.shareSnapshot).not.toHaveBeenCalled();
    await click("Hide snapshot");
    expect(rendered!.root.findAllByType("pre")).toHaveLength(0);
    await click("View shared snapshot");
    await click("Refresh preview");
    expect(state.previewChanges).toHaveBeenCalledTimes(1);
    expect(state.shareSnapshot).not.toHaveBeenCalled();
  });
  it("collapses again after a new preview is explicitly shared, even for identical content", async () => {
    state = { ...state, snapshot };
    await render();
    await click("View shared snapshot");
    state = { ...state, snapshot: null };
    await render();
    expect(button("Share snapshot")).toBeDefined();
    state = { ...state, snapshot };
    await render();
    expect(button("View shared snapshot").props["aria-expanded"]).toBe(false);
    expect(rendered!.root.findAllByType("pre")).toHaveLength(0);
  });
  it("keeps an unconfirmed share error with the preview instead of showing success", async () => {
    state = { ...state, error: "The checkout changed since this preview." };
    await render();
    expect(text()).toContain("checkout changed");
    expect(text()).not.toContain("Snapshot shared");
    expect(rendered!.root.findAllByType("pre")).toHaveLength(1);
    expect(button("Refresh preview")).toBeDefined();
  });
});

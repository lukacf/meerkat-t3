import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type SharedCheckout,
  type SharedCheckoutPatch,
} from "@t3tools/contracts";
import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
const commands = vi.hoisted(() => ({ preview: vi.fn(), put: vi.fn() }));
vi.mock("../../state/sharedWorkspace", () => ({
  sharedWorkspaceEnvironment: { previewCheckoutPatch: "preview", putSnapshot: "put" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: "preview" | "put") => commands[name],
}));
vi.mock("../../state/query", () => ({ formatEnvironmentQueryError: (cause: string) => cause }));
import { useSharedSnapshot } from "./useSharedSnapshot";

const at = "2026-10-17T12:00:00Z";
const checkout: SharedCheckout = {
  checkoutId: "checkout",
  participantId: "alice",
  sharedProjectId: "shared-catalog",
  localEnvironmentId: EnvironmentId.make("local"),
  localProjectId: ProjectId.make("catalog"),
  repository: "github.com/example/catalog",
  createdAt: at,
};
const preview: SharedCheckoutPatch = {
  projectId: checkout.localProjectId,
  threadId: ThreadId.make("task"),
  branch: "feature/catalog",
  commit: "a".repeat(40),
  observedAt: at,
  status: "ready",
  scope: "tracked_changes",
  patch: "diff --git a/catalog.ts b/catalog.ts\n+new\n",
  sha256: "b".repeat(64),
  bytes: 42,
  files: [{ path: "catalog.ts", change: "modified" }],
  filesTruncated: false,
  excluded: [],
  excludedTruncated: false,
  maxBytes: 1_048_576,
  maxFiles: 256,
};
const input = {
  hostEnvironmentId: EnvironmentId.make("host"),
  accountKey: "alice",
  checkout,
  threadId: preview.threadId,
  maxBytes: 1000,
};
let view: ReturnType<typeof useSharedSnapshot>;
let rendered: ReactTestRenderer | undefined;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function Harness(props: Parameters<typeof useSharedSnapshot>[0]) {
  const current = useSharedSnapshot(props);
  useEffect(() => {
    view = current;
  }, [current]);
  return <span>{current.snapshot?.snapshotId ?? "No shared snapshot"}</span>;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  commands.preview.mockReset().mockResolvedValue({ _tag: "Success", value: preview });
  commands.put.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      snapshotId: "snapshot",
      checkoutId: checkout.checkoutId,
      sharedProjectId: checkout.sharedProjectId,
      revision: { branch: preview.branch, commit: preview.commit, applicability: "branch" },
      bytes: preview.bytes,
      sha256: preview.sha256,
      createdAt: at,
    },
  });
});
afterEach(async () => {
  await act(async () => rendered?.unmount());
  rendered = undefined;
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => {
    rendered = create(<Harness {...input} />);
  });
  await act(async () => view.previewChanges());
}

describe("snapshot sharing during navigation", () => {
  it.each([
    { accountKey: "bob" },
    { threadId: ThreadId.make("another-task") },
    { checkout: { ...checkout, checkoutId: "another-checkout" } },
    { hostEnvironmentId: EnvironmentId.make("another-host") },
  ])("does not upload after its reviewed scope changes: %j", async (change) => {
    await mount();
    const capture = deferred<{ _tag: "Success"; value: SharedCheckoutPatch }>();
    commands.preview.mockReturnValueOnce(capture.promise);
    let sharing: Promise<void>;
    await act(async () => {
      sharing = view.shareSnapshot();
    });
    await act(async () => rendered!.update(<Harness {...input} {...change} />));
    await act(async () => {
      capture.resolve({ _tag: "Success", value: preview });
      await sharing;
    });
    expect(commands.put).not.toHaveBeenCalled();
    expect(view.preview).toBeNull();
    expect(view.snapshot).toBeNull();
    expect(view.error).toBeNull();
  });
  it("does not upload when the preview closes while local verification is pending", async () => {
    await mount();
    const capture = deferred<{ _tag: "Success"; value: SharedCheckoutPatch }>();
    commands.preview.mockReturnValueOnce(capture.promise);
    let sharing: Promise<void>;
    await act(async () => {
      sharing = view.shareSnapshot();
    });
    await act(async () => rendered!.unmount());
    rendered = undefined;
    await act(async () => {
      capture.resolve({ _tag: "Success", value: preview });
      await sharing;
    });
    expect(commands.put).not.toHaveBeenCalled();
  });
  it("does not revive a pending share by returning to the previous account", async () => {
    await mount();
    const capture = deferred<{ _tag: "Success"; value: SharedCheckoutPatch }>();
    commands.preview.mockReturnValueOnce(capture.promise);
    let sharing: Promise<void>;
    await act(async () => {
      sharing = view.shareSnapshot();
    });
    await act(async () => rendered!.update(<Harness {...input} accountKey="bob" />));
    await act(async () => rendered!.update(<Harness {...input} />));
    await act(async () => {
      capture.resolve({ _tag: "Success", value: preview });
      await sharing;
    });
    expect(commands.put).not.toHaveBeenCalled();
    expect(view.snapshot).toBeNull();
  });
  it("does not install an old account's upload receipt after switching accounts", async () => {
    await mount();
    const upload = deferred<unknown>();
    const receipt = await commands.put();
    commands.put.mockClear().mockReturnValueOnce(upload.promise);
    let sharing: Promise<void>;
    await act(async () => {
      sharing = view.shareSnapshot();
    });
    expect(commands.put).toHaveBeenCalledTimes(1);
    await act(async () => rendered!.update(<Harness {...input} accountKey="bob" />));
    await act(async () => {
      upload.resolve(receipt);
      await sharing;
    });
    expect(view.snapshot).toBeNull();
    expect(view.error).toBeNull();
  });
  it("rejects a clean revision observed for another project", async () => {
    await mount();
    await expect(
      view.resolveRevision({
        projectId: ProjectId.make("another-project"),
        branch: preview.branch,
        commit: preview.commit,
        dirty: false,
        observedAt: at,
      }),
    ).rejects.toThrow("another project's revision");
  });
});

import { act, type PropsWithChildren, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { MeerkatCheckpointPreview, MeerkatWorkspaceCheckpoint } from "@t3tools/contracts";

vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => null }));
vi.mock("@pierre/diffs", () => ({ parseDiffFromFile: () => ({}) }));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/checkbox", () => ({
  Checkbox: ({
    onCheckedChange,
    ...props
  }: ComponentProps<"input"> & {
    onCheckedChange: (value: boolean) => void;
  }) => (
    <input {...props} type="checkbox" onChange={(event) => onCheckedChange(event.target.checked)} />
  ),
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ children, open }: PropsWithChildren<{ open: boolean }>) =>
    open ? <div>{children}</div> : null,
  DialogPopup: ({ children }: PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: PropsWithChildren) => <h2>{children}</h2>,
  DialogDescription: ({ children }: PropsWithChildren) => <p>{children}</p>,
  DialogFooter: ({ children }: PropsWithChildren) => <div>{children}</div>,
}));

import {
  NativeWorkspaceCheckpoints,
  type NativeWorkspaceCheckpointApi,
} from "./NativeWorkspaceCheckpoints";

const checkpoint: MeerkatWorkspaceCheckpoint = {
  id: "before-edits",
  source: "manual",
  sessionId: "session",
  workspace: "/repo",
  startedAt: "2026-10-04T10:00:00.000Z",
  completedAt: "2026-10-04T10:00:01.000Z",
  status: "complete",
  detail: null,
};
const preview: MeerkatCheckpointPreview = {
  checkpoint,
  patch: "",
  sharedWorkspace: true,
  files: ["selected.ts", "untouched.ts"].map((path) => ({
    path,
    status: "modified" as const,
    before: "original",
    current: "changed",
    expectedCurrent: `hash-${path}`,
    restorable: true,
    reason: null,
  })),
};
let renderer: ReactTestRenderer | undefined;
let api: NativeWorkspaceCheckpointApi;
const button = (label: string) =>
  renderer!.root.findAllByType("button").find(
    (node) =>
      node.children
        .filter((child) => typeof child === "string" || typeof child === "number")
        .join("")
        .trim() === label,
  )!;
const renderedText = () => JSON.stringify(renderer!.toJSON());
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api = {
    capture: vi.fn().mockResolvedValue(checkpoint),
    list: vi.fn().mockResolvedValue({ checkpoints: [checkpoint] }),
    preview: vi.fn().mockResolvedValue(preview),
    restore: vi.fn().mockResolvedValue({ restored: ["selected.ts"], conflicts: [] }),
  };
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
const render = async () => {
  await act(async () => {
    renderer = create(<NativeWorkspaceCheckpoints targetKey="agent-one" api={api} offerCapture />);
  });
};

it("captures before edits from the visible recovery action and makes the snapshot reviewable", async () => {
  await render();
  expect(api.capture).not.toHaveBeenCalled();
  await act(async () => button("Save recovery snapshot").props.onClick());
  expect(api.capture).toHaveBeenCalledTimes(1);
  expect(renderedText()).toContain("Saved snapshot");
  await act(async () => button("Review").props.onClick());
  expect(api.preview).toHaveBeenCalledWith("before-edits");
  expect(renderedText()).toContain("Restore selected files");
  expect(button("Restore selected files").props.disabled).toBe(true);
});

it("restores only selected files with the preview's concurrency guard and surfaces a conflict", async () => {
  vi.mocked(api.restore).mockResolvedValue({
    restored: [],
    conflicts: [{ path: "selected.ts", reason: "File changed since preview" }],
  });
  await render();
  await act(async () => button("History").props.onClick());
  await act(async () => button("Review").props.onClick());
  const selected = renderer!.root
    .findAllByType("input")
    .find((node) => node.props["aria-label"] === "Restore selected.ts")!;
  await act(async () => selected.props.onChange({ target: { checked: true } }));
  await act(async () => button("Restore 1 file").props.onClick());
  expect(api.restore).toHaveBeenCalledWith(checkpoint, [
    { path: "selected.ts", expectedCurrent: "hash-selected.ts" },
  ]);
  expect(renderedText()).toContain("No files were restored.");
  expect(renderedText()).toContain("File changed since preview");
});

it("keeps failed capture retryable without presenting a saved snapshot", async () => {
  vi.mocked(api.capture).mockRejectedValueOnce(new Error("Workspace is busy"));
  await render();
  await act(async () => button("Save recovery snapshot").props.onClick());
  expect(renderedText()).toContain("Workspace is busy");
  expect(renderedText()).not.toContain("Saved snapshot");
  expect(api.list).not.toHaveBeenCalled();
  await act(async () => button("Save snapshot").props.onClick());
  expect(api.capture).toHaveBeenCalledTimes(2);
  expect(renderedText()).toContain("Saved snapshot");
  expect(renderedText()).not.toContain("Workspace is busy");
});

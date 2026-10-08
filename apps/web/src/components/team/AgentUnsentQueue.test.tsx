import {
  EnvironmentId,
  type MeerkatAgentQueue,
  type MeerkatAgentQueueItem,
} from "@t3tools/contracts";
import { act, type ButtonHTMLAttributes, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AgentComposerEditor } from "./AgentComposerEditor";

const clipboard = vi.hoisted(() => vi.fn<(text: string, target?: string) => Promise<boolean>>());
vi.mock("../../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: clipboard }));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("./AgentComposerEditor", () => ({
  AgentComposerEditor: ({
    value,
    disabled,
    onChange,
  }: ComponentProps<typeof AgentComposerEditor>) => (
    <textarea
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value, 0, 0, false, [])}
    />
  ),
}));

import { AgentUnsentQueue } from "./AgentUnsentQueue";

const item = (
  id: string,
  status: MeerkatAgentQueueItem["status"] = "queued",
): MeerkatAgentQueueItem => ({
  id,
  requestId: id,
  payload: { text: `Message ${id}` },
  status,
  error: null,
  receipt: null,
  createdAt: "2026-09-29T07:00:00.000Z",
  updatedAt: "2026-09-29T07:00:00.000Z",
});
const queue = (items: MeerkatAgentQueueItem[], revision = 1): MeerkatAgentQueue => ({
  revision,
  durableId: "agent-queue",
  waitingReason: null,
  items,
});
const callbacks = {
  onRefresh: vi.fn(),
  onEdit: vi.fn<(row: MeerkatAgentQueueItem, text: string) => Promise<boolean>>(),
  onMove: vi.fn(),
  onCancel: vi.fn(),
  onRetry: vi.fn(),
};
let renderer: ReactTestRenderer | undefined;
const render = (
  value: MeerkatAgentQueue | undefined,
  state: { loading?: boolean; error?: string | null } = {},
) => {
  act(() => {
    const element = (
      <AgentUnsentQueue
        queue={value}
        environmentId={EnvironmentId.make("environment")}
        cwd="/workspace"
        skills={[]}
        disabled={false}
        loading={state.loading ?? false}
        error={state.error ?? null}
        {...callbacks}
      />
    );
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
};
const button = (label: string) =>
  renderer!.root
    .findAllByType("button")
    .find((node) => node.props["aria-label"] === label || node.children.includes(label))!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  callbacks.onEdit.mockResolvedValue(true);
  clipboard.mockResolvedValue(true);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("AgentUnsentQueue observation", () => {
  it("offers a retry when the first observation fails and clears it after a successful empty result", () => {
    render(undefined, { loading: true });
    expect(renderer!.root.findByProps({ role: "status" }).children).toEqual([
      "Checking queued messages...",
    ]);

    render(undefined, { error: "Connection lost" });
    expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(1);
    act(() => button("Retry queue").props.onClick());
    expect(callbacks.onRefresh).toHaveBeenCalledOnce();

    render(undefined, { loading: true, error: "Connection lost" });
    expect(button("Retry queue").props.disabled).toBe(true);
    render(queue([]));
    expect(renderer!.toJSON()).toBeNull();
  });

  it("retains the last queue through an observation failure and restores controls after retry", () => {
    render(queue([item("first"), item("second", "failed"), item("third", "uncertain")]));
    expect(button("Edit queued message").props.disabled).toBe(false);

    render(undefined, { error: "Connection lost" });
    expect(renderer!.root.findAllByType("li")).toHaveLength(3);
    const mutations = renderer!.root
      .findAllByType("button")
      .filter((node) => !node.children.includes("Retry queue"));
    expect(mutations.length).toBeGreaterThan(0);
    expect(mutations.every((node) => node.props.disabled)).toBe(true);
    act(() => button("Retry queue").props.onClick());

    const recovered = item("replacement", "failed");
    render(queue([recovered], 2));
    expect(renderer!.root.findAllByType("li")).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    act(() => button("Retry").props.onClick());
    expect(callbacks.onRetry).toHaveBeenCalledExactlyOnceWith(recovered);
  });

  it("preserves an in-progress edit while the queue is unavailable and saves against the recovered row", async () => {
    render(queue([item("first")]));
    act(() => button("Edit queued message").props.onClick());
    act(() =>
      renderer!.root
        .findByType("textarea")
        .props.onChange({ target: { value: "Revised message" } }),
    );

    render(undefined, { error: "Connection lost" });
    expect(renderer!.root.findByType("textarea").props.value).toBe("Revised message");
    expect(renderer!.root.findByType("textarea").props.disabled).toBe(true);
    expect(button("Save").props.disabled).toBe(true);
    render(undefined, { loading: true });
    expect(button("Save").props.disabled).toBe(true);

    const recovered = { ...item("first"), updatedAt: "2026-09-29T07:01:00.000Z" };
    render(queue([recovered], 2));
    expect(button("Save").props.disabled).toBe(false);
    await act(async () => button("Save").props.onClick());
    expect(callbacks.onEdit).toHaveBeenCalledExactlyOnceWith(recovered, "Revised message");
    expect(renderer!.root.findAllByType("textarea")).toHaveLength(0);
  });

  it("does not resurrect completed rows after a fresh empty observation", () => {
    render(queue([item("first")]));
    render(queue([], 2));
    expect(renderer!.toJSON()).toBeNull();
    render(undefined, { error: "Connection lost" });
    expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(1);
    expect(renderer!.root.findAllByType("li")).toHaveLength(0);
  });

  it("keeps the same editable draft during background refresh while blocking Save until the new observation", async () => {
    render(queue([item("first")]));
    act(() => button("Edit queued message").props.onClick());
    const editor = renderer!.root.findByType("textarea");
    act(() => editor.props.onChange({ target: { value: "Draft $review" } }));
    render(undefined, { loading: true });
    expect(renderer!.root.findByType("textarea")).toBe(editor);
    expect(editor.props.disabled).toBe(false);
    expect(button("Save").props.disabled).toBe(true);
    act(() => editor.props.onChange({ target: { value: "Draft continues $review" } }));
    const fresh = { ...item("first"), updatedAt: "2026-10-01T12:00:00.000Z" };
    render(queue([fresh], 2));
    expect(renderer!.root.findByType("textarea")).toBe(editor);
    expect(editor.props.value).toBe("Draft continues $review");
    await act(async () => button("Save").props.onClick());
    expect(callbacks.onEdit).toHaveBeenCalledExactlyOnceWith(fresh, "Draft continues $review");
  });
});

describe("queued message edit recovery", () => {
  function edit(text = "Keep this unsaved edit") {
    act(() => button("Edit queued message").props.onClick());
    const editor = renderer!.root.findByType("textarea");
    act(() => editor.props.onChange({ target: { value: text } }));
    return editor;
  }

  it("retains the same editor through dispatch, acceptance, completion and removal without sending it", async () => {
    render(queue([item("first")]));
    const editor = edit("Review this alternative\nwithout changing the original");
    const stages = [
      ["dispatching", "is sending"],
      ["accepted", "was sent"],
      ["completed", "has completed"],
    ] as const;
    for (const [status, message] of stages) {
      render(queue([item("first", status)], 2));
      expect(renderer!.root.findByType("textarea")).toBe(editor);
      expect(editor.props.value).toBe("Review this alternative\nwithout changing the original");
      expect(button("Save").props.disabled).toBe(true);
      expect(JSON.stringify(renderer!.toJSON())).toContain(message);
    }
    render(queue([], 3));
    expect(renderer!.root.findByType("textarea")).toBe(editor);
    expect(JSON.stringify(renderer!.toJSON())).toContain("no longer in the queue");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Retained message edit");
    await act(async () => button("Save").props.onClick());
    expect(callbacks.onEdit).not.toHaveBeenCalled();
    await act(async () => button("Copy edited text").props.onClick());
    expect(clipboard).toHaveBeenCalledExactlyOnceWith(
      "Review this alternative\nwithout changing the original",
      "edited message",
    );
    expect(renderer!.root.findByType("textarea")).toBe(editor);
    expect(callbacks.onRetry).not.toHaveBeenCalled();
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    act(() => button("Discard edit").props.onClick());
    expect(renderer!.toJSON()).toBeNull();
  });

  it.each(["cancelled", "uncertain"] as const)(
    "retains edits and disables saving when the original becomes %s",
    (status) => {
      render(queue([item("first")]));
      const editor = edit();
      render(queue([item("first", status)], 2));
      expect(renderer!.root.findByType("textarea")).toBe(editor);
      expect(editor.props.value).toBe("Keep this unsaved edit");
      expect(button("Save").props.disabled).toBe(true);
      expect(button("Copy edited text")).toBeDefined();
      expect(callbacks.onEdit).not.toHaveBeenCalled();
    },
  );

  it("keeps an absent-row edit through a failed refresh and saves only after that request returns", async () => {
    render(queue([item("first")]));
    const editor = edit();
    render(queue([], 2));
    render(undefined, { error: "Offline" });
    expect(renderer!.root.findByType("textarea")).toBe(editor);
    expect(button("Save").props.disabled).toBe(true);
    render(undefined, { loading: true });
    expect(renderer!.root.findByType("textarea")).toBe(editor);
    const recovered = { ...item("first", "failed"), updatedAt: "2026-10-06T12:00:00.000Z" };
    render(queue([recovered], 3));
    expect(button("Save").props.disabled).toBe(false);
    await act(async () => button("Save").props.onClick());
    expect(callbacks.onEdit).toHaveBeenCalledExactlyOnceWith(recovered, "Keep this unsaved edit");
    expect(renderer!.root.findAllByType("textarea")).toHaveLength(0);
  });

  it.each([false, "throw"] as const)("preserves text after a failed save (%s)", async (outcome) => {
    if (outcome === "throw") callbacks.onEdit.mockRejectedValueOnce(new Error("Disconnected"));
    else callbacks.onEdit.mockResolvedValueOnce(false);
    render(queue([item("first")]));
    const editor = edit();
    await act(async () => button("Save").props.onClick());
    expect(renderer!.root.findByType("textarea")).toBe(editor);
    expect(editor.props.value).toBe("Keep this unsaved edit");
    expect(button("Save").props.disabled).toBe(false);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Changes could not be saved");
  });

  it("keeps an edit when the original starts before a save reply and prevents duplicate saves", async () => {
    let finish!: (saved: boolean) => void;
    callbacks.onEdit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(queue([item("first")]));
    const editor = edit();
    const save = button("Save").props.onClick;
    act(() => {
      save();
      save();
    });
    expect(callbacks.onEdit).toHaveBeenCalledTimes(1);
    render(queue([item("first", "dispatching")], 2));
    await act(async () => finish(true));
    expect(renderer!.root.findByType("textarea")).toBe(editor);
    expect(editor.props.value).toBe("Keep this unsaved edit");
    expect(button("Save").props.disabled).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Changes were saved");
  });

  it("an earlier save reply cannot close another edit opened after explicit cancellation", async () => {
    let finish!: (saved: boolean) => void;
    callbacks.onEdit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(queue([item("first"), item("second")]));
    edit("First edit");
    expect(button("Edit queued message").props.disabled).toBe(true);
    act(() => button("Save").props.onClick());
    act(() => button("Cancel").props.onClick());
    const edits = renderer!.root.findAllByProps({ "aria-label": "Edit queued message" });
    act(() => edits.at(-1)!.props.onClick());
    const second = renderer!.root.findByType("textarea");
    act(() => second.props.onChange({ target: { value: "Second edit" } }));
    await act(async () => finish(true));
    expect(renderer!.root.findByType("textarea")).toBe(second);
    expect(second.props.value).toBe("Second edit");
  });

  it("does not apply retained text to a replacement request that reuses the row ID", async () => {
    render(queue([item("first")]));
    edit();
    render(queue([{ ...item("first"), requestId: "different-request" }], 2));
    expect(button("Save").props.disabled).toBe(true);
    await act(async () => button("Save").props.onClick());
    expect(callbacks.onEdit).not.toHaveBeenCalled();
    expect(renderer!.root.findByType("textarea").props.value).toBe("Keep this unsaved edit");
  });

  it("keeps the edit available when copying fails", async () => {
    clipboard.mockRejectedValueOnce(new Error("Clipboard unavailable"));
    render(queue([item("first")]));
    const editor = edit();
    render(queue([], 2));
    await act(async () => button("Copy edited text").props.onClick());
    expect(renderer!.root.findByType("textarea")).toBe(editor);
    expect(editor.props.value).toBe("Keep this unsaved edit");
    expect(JSON.stringify(renderer!.toJSON())).toContain("select and copy it manually");
    expect(callbacks.onEdit).not.toHaveBeenCalled();
  });
});

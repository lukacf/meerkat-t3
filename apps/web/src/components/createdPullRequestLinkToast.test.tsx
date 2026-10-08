import type { ToastManagerUpdateOptions } from "@base-ui/react/toast";
import {
  EnvironmentId,
  ThreadId,
  type ScopedThreadRef,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { act, StrictMode, useSyncExternalStore } from "react";
import { create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ThreadToastData } from "./ui/toast";

const state = vi.hoisted(() => ({
  toasts: new Map<string, ToastManagerUpdateOptions<ThreadToastData>>(),
  threads: new Map<string, { pullRequests: ReadonlyArray<ThreadPullRequestLink> }>(),
  listeners: new Set<() => void>(),
  revision: 0,
  copy: vi.fn<() => Promise<boolean>>(),
  open: vi.fn(),
}));

function notify() {
  state.revision += 1;
  for (const listener of state.listeners) listener();
}

vi.mock("./ui/toast", async () => ({
  ...(await import("./ui/toastHelpers")),
  toastManager: {
    update: (id: string, update: ToastManagerUpdateOptions<ThreadToastData>) => {
      const previous = state.toasts.get(id);
      if (!previous) return;
      state.toasts.set(id, { ...previous, ...update });
      notify();
    },
  },
}));
vi.mock("~/state/entities", () => ({
  useThreadShell: (ref: ScopedThreadRef) => {
    useSyncExternalStore(subscribe, snapshot);
    return state.threads.get(`${ref.environmentId}/${ref.threadId}`) ?? null;
  },
}));
vi.mock("~/hooks/useCopyToClipboard", () => ({ writeTextToClipboard: state.copy }));

import { showCreatedPullRequestLinkWarning } from "./createdPullRequestLinkToast";

const ref = {
  environmentId: EnvironmentId.make("computer-a"),
  threadId: ThreadId.make("thread-a"),
};
const url = "https://github.com/owner/repository/pull/7";
let renderer: ReactTestRenderer | undefined;

const subscribe = (listener: () => void) => {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
};
const snapshot = () => state.revision;

function ToastHost({ visible }: { visible: boolean }) {
  useSyncExternalStore(subscribe, snapshot);
  if (!visible) return null;
  return [...state.toasts].map(([id, toast]) => (
    <section key={id}>
      <strong>{toast.title}</strong>
      <p>{toast.description}</p>
      <button {...toast.actionProps} />
      <button {...toast.data?.secondaryActionProps} />
    </section>
  ));
}

async function render(visible = true) {
  await act(() => {
    const tree = (
      <StrictMode>
        <ToastHost visible={visible} />
      </StrictMode>
    );
    if (renderer) renderer.update(tree);
    else renderer = create(tree);
  });
}

function renderedText(
  node:
    | ReactTestRendererJSON
    | ReadonlyArray<ReactTestRendererJSON | string>
    | string
    | null = renderer?.toJSON() ?? null,
): string {
  if (node === null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(renderedText).join(" ");
  return renderedText((node as ReactTestRendererJSON).children ?? []);
}

function link(overrides: Partial<ThreadPullRequestLink> = {}): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "owner/repository",
    number: 7,
    url,
    source: "created",
    linkedAt: "2026-10-07T09:00:00.000Z",
    snapshot: null,
    stack: null,
    ...overrides,
  };
}

function setLinks(links: ReadonlyArray<ThreadPullRequestLink>, threadRef = ref) {
  state.threads.set(`${threadRef.environmentId}/${threadRef.threadId}`, { pullRequests: links });
  notify();
}

function show(
  id = "pending-7",
  options: Partial<Parameters<typeof showCreatedPullRequestLinkWarning>[0]> = {},
) {
  state.toasts.set(id, { type: "loading" });
  showCreatedPullRequestLinkWarning({
    toastId: id,
    status: "pending",
    threadRef: ref,
    prUrl: url,
    prNumber: 7,
    actionProps: { children: "Open PR", onClick: state.open },
    data: { threadRef: ref },
    ...options,
  });
}

function copy(id = "pending-7") {
  const onClick = state.toasts.get(id)?.data?.secondaryActionProps?.onClick;
  if (!onClick) throw new Error("Copy action is missing");
  return onClick({} as Parameters<NonNullable<typeof onClick>>[0]);
}

function close(id: string) {
  const toast = state.toasts.get(id);
  state.toasts.delete(id);
  toast?.onClose?.();
  notify();
}

beforeEach(() => {
  state.toasts.clear();
  state.threads.clear();
  state.copy.mockReset().mockResolvedValue(true);
  state.open.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("created pull request link warning recovery", () => {
  it("resolves only the captured thread's exact visible PR and retains Open and Copy", async () => {
    show();
    await render();
    await act(() => {
      setLinks([link()], { ...ref, environmentId: EnvironmentId.make("computer-b") });
      setLinks([link()], { ...ref, threadId: ThreadId.make("thread-b") });
      setLinks([
        link({ host: "other.example" }),
        link({ repository: "owner/other" }),
        link({ number: 8 }),
        link({ source: "stack-dismissed" }),
      ]);
    });
    expect(renderedText()).toContain("server will retry automatically");
    expect(state.toasts.get("pending-7")?.type).toBe("warning");

    await act(() => setLinks([link({ host: "GitHub.COM", repository: "OWNER/REPOSITORY" })]));
    expect(renderedText()).toContain("Pull request link saved");
    expect(renderedText()).not.toContain("pending");
    expect(renderedText()).toContain(url);
    const toast = state.toasts.get("pending-7");
    expect(toast?.type).toBe("success");
    expect(toast?.data?.dismissAfterVisibleMs).toBe(10_000);
    await act(() => {
      renderer?.root.findAllByType("button")[0]?.props.onClick();
    });
    expect(state.open).toHaveBeenCalledOnce();
    await act(async () => {
      await copy();
    });
    expect(state.copy).toHaveBeenCalledWith(url, "pull request URL");
    expect(renderedText()).toContain("PR URL copied.");
    expect(renderedText()).not.toContain("pending");
  });

  it("rechecks the toast-owned identity after hiding and remounting away from the toolbar", async () => {
    show();
    await render();
    await render(false);
    await act(() => setLinks([link()]));
    expect(state.toasts.get("pending-7")?.type).toBe("warning");
    await render(true);
    expect(renderedText()).toContain("Pull request link saved");
    expect(state.toasts.size).toBe(1);
  });

  it("does not resolve separate pending or not-saved warnings", async () => {
    show();
    show("pending-8", { prUrl: url.replace("/7", "/8"), prNumber: 8 });
    show("not-saved", { status: "not_saved" });
    await render();
    await act(() => setLinks([link()]));
    expect(state.toasts.get("pending-7")?.type).toBe("success");
    expect(state.toasts.get("pending-8")?.title).toBe("Pull request link pending");
    expect(state.toasts.get("not-saved")?.title).toBe("Pull request link not saved");
  });

  it.each([true, false])(
    "keeps recovered wording when a pending copy later returns %s",
    async (copied) => {
      let finishCopy!: (copied: boolean) => void;
      state.copy.mockReturnValue(
        new Promise((resolve) => {
          finishCopy = resolve;
        }),
      );
      show();
      await render();
      const copying = copy();
      await act(() => setLinks([link()]));
      await act(async () => {
        finishCopy(copied);
        await copying;
      });
      expect(renderedText()).toContain("its link is saved to this thread");
      expect(renderedText()).not.toContain("server will retry");
      expect(renderedText()).toContain(copied ? "PR URL copied." : "Could not copy.");
    },
  );

  it("never restores a manually closed warning after copy or recovery completes", async () => {
    let finishCopy!: (copied: boolean) => void;
    state.copy.mockReturnValue(
      new Promise((resolve) => {
        finishCopy = resolve;
      }),
    );
    show();
    show("pending-8", { prUrl: url.replace("/7", "/8"), prNumber: 8 });
    await render();
    const copying = copy();
    await act(() => close("pending-7"));
    await act(async () => {
      setLinks([link()]);
      finishCopy(true);
      await copying;
    });
    expect(state.toasts.has("pending-7")).toBe(false);
    expect(state.toasts.get("pending-8")?.type).toBe("warning");
    expect(renderedText()).not.toContain("PR URL copied.");
  });

  it.each([{ prNumber: 8 }, { prUrl: "https://example.com/unknown/7" }, { threadRef: null }])(
    "does not infer missing or inconsistent result identity: %j",
    async (options) => {
      show("pending-7", options);
      await render();
      await act(() => setLinks([link()]));
      expect(state.toasts.get("pending-7")?.type).toBe("warning");
      expect(renderedText()).toContain("server will retry automatically");
    },
  );
});

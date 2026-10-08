import type { MeerkatApproval } from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { PresentationVisibility } from "../../hooks/usePresentationVisibility";
import { NativeToolApprovals, type NativeToolApprovalApi } from "./NativeToolApprovals";

vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const pendingApproval: MeerkatApproval = {
  record: {
    approval_id: "approval-a",
    status: "pending",
    owner: { owner_type: "session", session_id: "session-a" },
    proposed_action: {
      summary: "Read working directory",
      body: { toolName: "shell", arguments: { command: "pwd" } },
    },
    created_at: "2026-09-29T00:00:00.000Z",
  },
  actionable: true,
};
const approved: MeerkatApproval = {
  record: {
    ...pendingApproval.record,
    status: "approved",
    decision: { decision: "approve", decided_at: "2026-09-29T00:01:00.000Z" },
  },
  actionable: false,
};
const api = {
  list: vi.fn<NativeToolApprovalApi["list"]>(),
  decide: vi.fn<NativeToolApprovalApi["decide"]>(),
};
let renderer: ReactTestRenderer | undefined;
let documentState: EventTarget & { visibilityState: DocumentVisibilityState };
const content = () => JSON.stringify(renderer?.toJSON());
const buttons = (label: string) =>
  renderer!.root.findAllByType("button").filter((node) => node.children.includes(label));
const render = async (targetKey = "target-a", selectedApi: NativeToolApprovalApi = api) => {
  await act(async () => {
    renderer = create(<NativeToolApprovals targetKey={targetKey} api={selectedApi} />);
  });
};
const setVisibility = async (visibility: DocumentVisibilityState) => {
  await act(async () => {
    documentState.visibilityState = visibility;
    documentState.dispatchEvent(new Event("visibilitychange"));
  });
};
const advance = async (milliseconds: number) => {
  await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  documentState = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  });
  vi.stubGlobal("document", documentState);
  api.list.mockReset().mockResolvedValue({ approvals: [] });
  api.decide.mockReset().mockResolvedValue(approved);
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("makes no approval requests on a hidden mount and refreshes immediately when visible", async () => {
  documentState.visibilityState = "hidden";
  await render();
  await advance(30_000);
  expect(api.list).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);

  await setVisibility("visible");
  expect(api.list).toHaveBeenCalledOnce();
  await advance(2000);
  expect(api.list).toHaveBeenCalledTimes(2);
});

it("stops scheduled observations while hidden and starts a fresh visible interval", async () => {
  await render();
  expect(api.list).toHaveBeenCalledOnce();
  await advance(1000);
  await setVisibility("hidden");
  expect(vi.getTimerCount()).toBe(0);
  await advance(30_000);
  expect(api.list).toHaveBeenCalledOnce();

  await setVisibility("visible");
  expect(api.list).toHaveBeenCalledTimes(2);
  await advance(1999);
  expect(api.list).toHaveBeenCalledTimes(2);
  await advance(1);
  expect(api.list).toHaveBeenCalledTimes(3);
});

it("serializes a visible refresh behind a pending read across repeated visibility changes", async () => {
  const reading = deferred<Awaited<ReturnType<NativeToolApprovalApi["list"]>>>();
  api.list.mockReturnValueOnce(reading.promise);
  await render();
  await setVisibility("hidden");
  await setVisibility("visible");
  await setVisibility("hidden");
  await setVisibility("visible");
  await advance(30_000);
  expect(api.list).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);

  await act(async () => reading.resolve({ approvals: [] }));
  expect(api.list).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(1);
  await advance(2000);
  expect(api.list).toHaveBeenCalledTimes(3);
});

it("does not schedule or replay reads when an in-flight observation completes while hidden", async () => {
  const reading = deferred<Awaited<ReturnType<NativeToolApprovalApi["list"]>>>();
  api.list.mockReturnValueOnce(reading.promise);
  await render();
  await setVisibility("hidden");
  await setVisibility("visible");
  await setVisibility("hidden");
  await act(async () => reading.resolve({ approvals: [pendingApproval] }));
  await advance(30_000);
  expect(api.list).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);

  await setVisibility("visible");
  expect(api.list).toHaveBeenCalledTimes(2);
});

it("does not let a pre-decision read restore a pending approval after the decision succeeds", async () => {
  const reading = deferred<Awaited<ReturnType<NativeToolApprovalApi["list"]>>>();
  api.list
    .mockResolvedValueOnce({ approvals: [pendingApproval] })
    .mockReturnValueOnce(reading.promise);
  await render();
  await advance(2000);
  expect(api.list).toHaveBeenCalledTimes(2);
  await act(async () => buttons("Allow once")[0]!.props.onClick());
  expect(api.decide).toHaveBeenCalledWith({
    approvalId: "approval-a",
    sessionId: "session-a",
    decision: "approve",
  });
  expect(buttons("Allow once")).toHaveLength(0);
  expect(content()).toContain("approved");

  await act(async () => reading.resolve({ approvals: [pendingApproval] }));
  expect(buttons("Allow once")).toHaveLength(0);
  expect(content()).toContain("approved");
});

it("does not read during a pending decision after a visibility transition", async () => {
  const decision = deferred<MeerkatApproval>();
  api.list.mockResolvedValue({ approvals: [pendingApproval] });
  api.decide.mockReturnValueOnce(decision.promise);
  await render();
  await act(async () => buttons("Allow once")[0]!.props.onClick());
  await setVisibility("hidden");
  await setVisibility("visible");
  await advance(6000);
  expect(api.list).toHaveBeenCalledOnce();
  api.list.mockResolvedValue({ approvals: [approved] });
  await act(async () => decision.resolve(approved));
  await advance(2000);
  expect(api.list).toHaveBeenCalledTimes(2);
  expect(buttons("Allow once")).toHaveLength(0);
});

it("isolates old reads and visibility listeners when the approval target changes", async () => {
  const reading = deferred<Awaited<ReturnType<NativeToolApprovalApi["list"]>>>();
  api.list.mockReturnValueOnce(reading.promise);
  const replacementApi = {
    list: vi.fn<NativeToolApprovalApi["list"]>().mockResolvedValue({ approvals: [] }),
    decide: vi.fn<NativeToolApprovalApi["decide"]>(),
  };
  await render();
  await act(async () => {
    renderer!.update(<NativeToolApprovals targetKey="target-b" api={replacementApi} />);
  });
  expect(replacementApi.list).toHaveBeenCalledOnce();
  await act(async () => reading.resolve({ approvals: [pendingApproval] }));
  expect(content()).not.toContain("Permission to run");
  await setVisibility("hidden");
  await setVisibility("visible");
  expect(api.list).toHaveBeenCalledOnce();
  expect(replacementApi.list).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(1);
});

it("removes timers and listeners on unmount and does not restart from late reads", async () => {
  const reading = deferred<Awaited<ReturnType<NativeToolApprovalApi["list"]>>>();
  api.list.mockResolvedValueOnce({ approvals: [] }).mockReturnValueOnce(reading.promise);
  const removeListener = vi.spyOn(documentState, "removeEventListener");
  await render();
  expect(vi.getTimerCount()).toBe(1);
  await advance(2000);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(removeListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  await act(async () => reading.resolve({ approvals: [pendingApproval] }));
  await setVisibility("hidden");
  await setVisibility("visible");
  await advance(30_000);
  expect(api.list).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("pauses a hidden split pane and serializes refresh on return without losing decisions", async () => {
  const reading = deferred<Awaited<ReturnType<NativeToolApprovalApi["list"]>>>();
  api.list.mockReturnValueOnce(reading.promise).mockResolvedValue({ approvals: [pendingApproval] });
  const view = (visible: boolean) => (
    <PresentationVisibility value={visible}>
      <NativeToolApprovals targetKey="target-a" api={api} />
    </PresentationVisibility>
  );
  await act(async () => {
    renderer = create(view(true));
  });
  await act(async () => {
    renderer!.update(view(false));
  });
  await advance(10_000);
  expect(api.list).toHaveBeenCalledOnce();
  await act(async () => {
    renderer!.update(view(true));
  });
  expect(api.list).toHaveBeenCalledOnce();
  await act(async () => {
    reading.resolve({ approvals: [pendingApproval] });
  });
  expect(api.list).toHaveBeenCalledTimes(2);
  expect(content()).toContain("Allow once");
  await act(async () => {
    renderer!.update(view(false));
  });
  expect(content()).toContain("Allow once");
  await advance(10_000);
  expect(api.list).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => {
    renderer!.update(view(true));
  });
  expect(api.list).toHaveBeenCalledTimes(3);
});

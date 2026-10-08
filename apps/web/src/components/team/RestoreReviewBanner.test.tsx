import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type RestoreReviewDestination,
  type RestoreReviewSnapshot,
  type RestoreReviewStatus,
} from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  status: undefined as RestoreReviewStatus | undefined,
  current: undefined as RestoreReviewStatus | undefined,
  snapshot: null as RestoreReviewSnapshot | null,
  consent: vi.fn(),
  query: vi.fn((input: unknown) => input),
  refresh: vi.fn(),
  navigate: vi.fn(),
  error: null as string | null,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
}));
vi.mock("./useRestoreReview", () => ({ useRestoreReview: () => state.status }));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ label: "Restored laptop" }),
  useEnvironments: () => ({ environments: [] }),
}));
vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: "configs",
  serverEnvironment: { restoreReviewSnapshot: state.query, consentRestoreReview: "consent" },
}));
vi.mock("../../rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => new Map([["restored-env", { restoreReview: state.current }]]) },
}));
vi.mock("../../state/query", () => ({
  formatEnvironmentQueryError: () => "Review could not be saved",
  useEnvironmentQuery: (input: unknown) => ({
    data: input ? state.snapshot : null,
    error: state.error,
    isPending: false,
    refresh: state.refresh,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => {
    if (command !== "consent") throw new Error("Restore review must not dispatch agent work");
    return state.consent;
  },
}));
vi.mock("../ui/button", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button {...props} />
  ),
}));
vi.mock("../ui/dialog", () => {
  const Content = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogPopup: Content,
    DialogHeader: Content,
    DialogTitle: Content,
    DialogDescription: Content,
    DialogPanel: Content,
    DialogFooter: Content,
    DialogClose: Content,
  };
});

import { RestoreReviewBanner } from "./RestoreReviewBanner";

const environmentId = EnvironmentId.make("restored-env");
let renderer: ReactTestRenderer | undefined;
const required = (): RestoreReviewStatus => ({
  status: "required",
  restoreId: "original-restore-id",
  restoredAt: "2026-10-04T10:00:00.000Z",
  backupCreatedAt: "2026-10-03T10:00:00.000Z",
  message: "Review the restored profile before starting work.",
});
function button(label: string) {
  return renderer!.root
    .findAllByType("button")
    .find(
      (entry) => entry.children.filter((child) => typeof child === "string").join("") === label,
    );
}
function mount() {
  act(() => {
    renderer = create(<RestoreReviewBanner environmentId={environmentId} />);
  });
}
function open() {
  act(() => button("Review")!.props.onClick());
}
function text() {
  return JSON.stringify(renderer!.toJSON());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.status = required();
  state.current = required();
  state.snapshot = {
    ...required(),
    nativeMailbox: "unknown-unloaded",
    counts: { queuedMessages: 1, uncertainDeliveries: 1, interruptedSessions: 1, savedAgents: 1 },
    items: [
      {
        kind: "uncertain-delivery",
        id: "original-request-id",
        projectId: "original-project",
        instanceId: "original-provider",
        threadId: "original-thread",
        label: "Review request",
        status: "uncertain",
        detail: "Delivery must be checked using its original identity.",
      },
    ],
    truncated: false,
  };
  state.error = null;
  state.consent.mockReset();
  state.query.mockClear();
  state.refresh.mockClear();
  state.navigate.mockReset();
  state.navigate.mockResolvedValue(undefined);
  state.consent.mockResolvedValue({
    _tag: "Success",
    value: {
      ...required(),
      status: "restart-required",
      message: "Review saved. Restart to resume.",
    },
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("restored environment review", () => {
  it("only reads work after Review and never consents or starts work automatically", () => {
    mount();
    expect(state.query).not.toHaveBeenCalled();
    expect(state.consent).not.toHaveBeenCalled();
    open();
    expect(state.query).toHaveBeenCalledWith({ environmentId, input: {} });
    expect(state.consent).not.toHaveBeenCalled();
    for (const detail of [
      "Restored laptop",
      "original-request-id",
      "original-provider",
      "original-thread",
      "unknown while agents are unloaded",
    ])
      expect(text()).toContain(detail);
  });

  it("consents to the reviewed exact ID and remains held for restart", async () => {
    mount();
    open();
    await act(async () => button("Resume restored work")!.props.onClick());
    expect(state.consent).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { restoreId: "original-restore-id" },
    });
    expect(text()).toContain("Restart required");
    expect(text()).toContain("This running process will stay paused until it exits.");
    expect(button("Resume restored work")).toBeUndefined();
  });

  it.each<{
    destination: RestoreReviewDestination;
    route: object;
  }>([
    {
      destination: {
        kind: "thread",
        label: "Garden / Review delivery / Tests",
        threadId: ThreadId.make("saved-thread"),
        member: "saved-worker-ref",
      },
      route: {
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: "saved-thread" },
        search: { member: "saved-worker-ref" },
      },
    },
    {
      destination: {
        kind: "project-agent",
        label: "Garden / Reviewer",
        agentId: "saved-specialist",
        instanceId: ProviderInstanceId.make("original-provider"),
      },
      route: {
        to: "/$environmentId/agents/$agentId",
        params: { environmentId, agentId: "saved-specialist" },
        search: { project: "original-project" },
      },
    },
    {
      destination: {
        kind: "project-agent",
        label: "Garden / Reviewer / Security reviewer",
        agentId: "saved-specialist",
        instanceId: ProviderInstanceId.make("original-provider"),
        nativeAgent: "saved-child-ref",
      },
      route: {
        to: "/$environmentId/agents/$agentId",
        params: { environmentId, agentId: "saved-specialist" },
        search: {
          project: "original-project",
          nativeAgent: "saved-child-ref",
          nativeInstance: "original-provider",
        },
      },
    },
  ])(
    "opens $destination.label in the restored environment while keeping the hold",
    async ({ destination, route }) => {
      state.snapshot = {
        ...state.snapshot!,
        items: [{ ...state.snapshot!.items[0]!, kind: "queued-message", destination }],
      };
      mount();
      open();
      expect(text()).toContain(destination.label);
      expect(text()).toContain("Opening a conversation does not resume work");
      await act(async () => button("Open conversation")!.props.onClick());
      expect(state.navigate).toHaveBeenCalledExactlyOnceWith(route);
      expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
      expect(state.consent).not.toHaveBeenCalled();
      expect(state.current).toEqual(required());
      expect(text()).toContain("Restored work paused");
      open();
      expect(text()).toContain(destination.label);
      expect(button("Resume restored work")).toBeDefined();
      expect(state.consent).not.toHaveBeenCalled();
    },
  );

  it("retains legacy identifiers without inventing a conversation link", () => {
    mount();
    open();
    expect(text()).toContain("original-thread");
    expect(text()).toContain("Conversation unavailable from these saved records.");
    expect(button("Open conversation")).toBeUndefined();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.consent).not.toHaveBeenCalled();
  });

  it("rechecks the environment at click time and refuses a replaced restore", async () => {
    mount();
    open();
    state.current = { ...required(), restoreId: "new-restore-id" };
    await act(async () => button("Resume restored work")!.props.onClick());
    expect(state.consent).not.toHaveBeenCalled();
    expect(text()).toContain("restore review changed");
  });

  it("does not consent to a stale work snapshot", async () => {
    state.snapshot = { ...state.snapshot!, restoreId: "older-restore-id" };
    mount();
    open();
    await act(async () => button("Resume restored work")!.props.onClick());
    expect(state.consent).not.toHaveBeenCalled();
    expect(text()).not.toContain("original-request-id");
  });

  it("keeps the hold when reading saved work fails", async () => {
    state.error = "Saved work could not be read";
    mount();
    open();
    await act(async () => button("Resume restored work")!.props.onClick());
    expect(state.consent).not.toHaveBeenCalled();
    expect(text()).toContain("Saved work could not be read");
  });

  it("does not offer resumption for an invalid restore record", () => {
    state.status = { ...required(), status: "invalid", message: "Restore marker is invalid." };
    mount();
    open();
    expect(button("Resume restored work")).toBeUndefined();
    expect(text()).toContain("Restore marker is invalid.");
    expect(state.consent).not.toHaveBeenCalled();
  });

  it("retains the hold when saving consent fails", async () => {
    state.consent.mockResolvedValue({ _tag: "Failure", cause: {} });
    mount();
    open();
    await act(async () => button("Resume restored work")!.props.onClick());
    expect(text()).toContain("Review could not be saved");
    expect(button("Resume restored work")).toBeDefined();
    expect(text()).not.toContain("Your review is saved.");
  });

  it.each([undefined, { ...required(), status: "clear" as const }])(
    "does not hold older or clear environments",
    (status) => {
      state.status = status;
      mount();
      expect(renderer!.toJSON()).toBeNull();
      expect(state.query).not.toHaveBeenCalled();
      expect(state.consent).not.toHaveBeenCalled();
    },
  );
});

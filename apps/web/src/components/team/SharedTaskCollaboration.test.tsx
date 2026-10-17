import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type SharedDiscoveryResult,
  type SharedInbox,
  type SharedWorkspaceSnapshot,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  connected: true,
  directoryError: null as string | null,
  snapshot: null as SharedWorkspaceSnapshot | null,
  discovery: { items: [], nextCursor: null } as SharedDiscoveryResult,
  inbox: null as SharedInbox | null,
  discover: vi.fn((input) => ({ kind: "discovery", input })),
  readInbox: vi.fn((input) => ({ kind: "inbox", input })),
  refresh: vi.fn(),
  acknowledge: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../state/entities", () => ({ useProjects: () => [project] }));
vi.mock("../../state/sharedWorkspace", () => ({
  sharedWorkspaceEnvironment: {
    discover: state.discover,
    inbox: state.readInbox,
    acknowledgeInbox: "acknowledge",
  },
  useSharedHosts: () => [
    {
      environmentId: "host",
      label: "Product host",
      connection: { phase: state.connected ? "connected" : "offline" },
      entry: { target: { _tag: "BearerConnectionTarget", connectionId: "paired-host" } },
    },
  ],
  useSharedDirectory: () => ({
    snapshot: state.snapshot,
    connected: state.connected,
    error: state.directoryError,
    isPending: false,
    permissions: { contribute: true },
    refresh: state.refresh,
  }),
}));
vi.mock("../../state/query", () => ({
  formatEnvironmentQueryError: (value: string) => value,
  useEnvironmentQuery: (query: { kind: string } | null) => ({
    data:
      query?.kind === "discovery" ? state.discovery : query?.kind === "inbox" ? state.inbox : null,
    error: null,
    isPending: false,
    refresh: state.refresh,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.acknowledge }));
vi.mock("./SharedTaskAccess", () => ({
  SharedTaskAccess: ({ initialThreadId }: { initialThreadId: string }) => (
    <div data-task-access={initialThreadId}>Task access requires consent</div>
  ),
}));
vi.mock("./SharedSpecialistDiscovery", () => ({
  SharedSpecialistDiscovery: () => <div>Find specialists</div>,
  sharedDiscoveryReasonLabel: () => "Project assignment",
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/popover", () => ({
  Popover: "section",
  PopoverPopup: "div",
  PopoverTitle: "h3",
  PopoverTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "span",
  TooltipTrigger: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipPopup: "span",
}));
import { SharedTaskCollaboration } from "./SharedTaskCollaboration";

const at = "2026-10-17T12:00:00.000Z";
const project = {
  id: ProjectId.make("local-project"),
  environmentId: EnvironmentId.make("local"),
  title: "Catalog",
} as EnvironmentProject;
function snapshot(): SharedWorkspaceSnapshot {
  return {
    workspace: {
      workspaceId: "workspace",
      name: "Product",
      limits: { maxSpecialists: 100, maxSnapshotBytes: 1000 },
      createdAt: at,
    },
    participant: { participantId: "alice", displayName: "Alice", kind: "person", createdAt: at },
    projects: [],
    checkouts: [
      {
        checkoutId: "checkout",
        participantId: "alice",
        sharedProjectId: "catalog",
        localEnvironmentId: project.environmentId,
        localProjectId: project.id,
        repository: "github.com/example/catalog",
        createdAt: at,
      },
    ],
    specialists: [
      {
        specialistId: "contracts",
        label: "Catalog contracts",
        nativeTarget: {
          projectId: ProjectId.make("anchor"),
          instanceId: ProviderInstanceId.make("meerkat"),
          agentId: "native",
        },
        assignments: [
          {
            sharedProjectId: "catalog",
            charter: "Own the catalog compatibility boundary.",
            paths: [],
            tags: [],
          },
        ],
        assignmentVersion: 1,
        supersededAt: null,
        successorId: null,
        createdAt: at,
      },
    ],
  };
}
let rendered: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.connected = true;
  state.directoryError = null;
  state.snapshot = snapshot();
  state.discovery = {
    items: [
      {
        specialistId: "contracts",
        label: "Catalog contracts",
        sharedProjectIds: ["catalog"],
        assignmentVersion: 1,
        supersededAt: null,
        successorId: null,
        matches: [
          {
            sharedProjectId: "catalog",
            charterExcerpt: "Own the catalog compatibility boundary.",
            charterExcerptTruncated: false,
            reasons: [{ kind: "project" }],
          },
        ],
      },
    ],
    nextCursor: null,
  };
  state.inbox = { recipientId: "alice", batchId: "sealed-batch", events: [], hasMore: true };
  state.discover.mockClear();
  state.readInbox.mockClear();
  state.refresh.mockClear();
  state.navigate.mockClear();
  state.acknowledge.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
});
afterEach(async () => {
  await act(async () => rendered?.unmount());
  rendered = undefined;
  vi.unstubAllGlobals();
});
async function render(isDraft = false) {
  await act(async () => {
    rendered = create(
      <SharedTaskCollaboration
        environmentId={project.environmentId}
        projectId={project.id}
        threadId={ThreadId.make("task")}
        isDraft={isDraft}
      />,
    );
  });
}
const tree = () => JSON.stringify(rendered!.toJSON());
const button = (label: string) =>
  rendered!.root.findAllByType("button").find((item) => item.children.includes(label))!;

describe("shared collaboration inside a local task", () => {
  it("automatically discovers project coverage without fetching a briefing or granting authority", async () => {
    await render(true);
    expect(state.discover).toHaveBeenCalledWith({
      environmentId: "host",
      input: { sharedProjectId: "catalog", limit: 6 },
    });
    expect(
      state.discover.mock.calls.every(([query]) => !JSON.stringify(query).includes("task")),
    ).toBe(true);
    expect(state.readInbox).not.toHaveBeenCalled();
    expect(state.acknowledge).not.toHaveBeenCalled();
    expect(tree()).toContain("Catalog contracts");
    expect(tree()).toContain("Found automatically");
    expect(tree()).toContain("Start this task before granting");
  });
  it("opens a suggested specialist with the selected local task context", async () => {
    await render();
    await act(async () => button("Open").props.onClick());
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/$environmentId/agents/$agentId",
      params: { environmentId: "host", agentId: "contracts" },
      search: {
        project: "anchor",
        shared: true,
        checkoutEnvironment: "local",
        checkoutProject: "local-project",
        checkoutId: "checkout",
        checkoutThread: "task",
      },
    });
    expect(rendered!.root.findByProps({ "data-task-access": "task" })).toBeDefined();
  });
  it("fetches the person's full batch only on request and acknowledges exactly that batch", async () => {
    await render();
    await act(async () => button("Fetch briefing").props.onClick());
    expect(state.readInbox).toHaveBeenCalledWith({ environmentId: "host", input: {} });
    expect(state.acknowledge).not.toHaveBeenCalled();
    await act(async () => button("Mark these updates read").props.onClick());
    expect(state.acknowledge).toHaveBeenCalledExactlyOnceWith({
      environmentId: "host",
      input: { batchId: "sealed-batch" },
    });
    expect(tree()).toContain("does not acknowledge an agent's inbox or complete its work");
  });
  it("retains the fetched batch when offline and blocks acknowledgement", async () => {
    await render();
    await act(async () => button("Fetch briefing").props.onClick());
    state.connected = false;
    await act(async () =>
      rendered!.update(
        <SharedTaskCollaboration
          environmentId={project.environmentId}
          projectId={project.id}
          threadId={ThreadId.make("task")}
          isDraft={false}
        />,
      ),
    );
    expect(tree()).toContain("Showing the last fetched batch");
    expect(button("Mark these updates read").props.disabled).toBe(true);
    await act(async () => button("Mark these updates read").props.onClick());
    expect(state.acknowledge).not.toHaveBeenCalled();
  });
  it("does not mistake an offline or unattached checkout for an empty directory", async () => {
    state.connected = false;
    await render();
    expect(state.discover).not.toHaveBeenCalled();
    expect(tree()).toContain("Offline");
    expect(tree()).not.toContain("No current specialists match");
    await act(async () => rendered!.unmount());
    rendered = undefined;
    state.connected = true;
    state.snapshot = { ...snapshot(), checkouts: [] };
    await render();
    expect(state.discover).not.toHaveBeenCalled();
    expect(tree()).toContain("Connect this checkout");
  });
  it("never routes a stale or cross-project suggestion as this task", async () => {
    state.discovery = {
      ...state.discovery,
      items: state.discovery.items.map((item) => ({ ...item, sharedProjectIds: ["payments"] })),
    };
    await render();
    expect(button("Open").props.disabled).toBe(true);
    await act(async () => button("Open").props.onClick());
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("keeps failed acknowledgement distinct from a read receipt", async () => {
    state.acknowledge.mockResolvedValue({ _tag: "Failure", cause: "Host disconnected" });
    await render();
    await act(async () => button("Fetch briefing").props.onClick());
    await act(async () => button("Mark these updates read").props.onClick());
    expect(tree()).toContain("Host disconnected");
    expect(tree()).not.toContain("batch was marked read for you");
  });
});

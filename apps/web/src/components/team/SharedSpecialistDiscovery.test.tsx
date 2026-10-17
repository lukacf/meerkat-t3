import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type SharedCheckout,
  type SharedDiscoveryResult,
  type SharedWorkspaceSnapshot,
} from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentPresentation } from "../../state/environments";

const state = vi.hoisted(() => ({
  result: { items: [], nextCursor: null } as SharedDiscoveryResult,
  error: null as string | null,
  pending: false,
  discover: vi.fn((input) => input),
  refresh: vi.fn(),
  refreshDirectory: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../state/sharedWorkspace", () => ({
  sharedWorkspaceEnvironment: { discover: state.discover },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.result,
    error: state.error,
    isPending: state.pending,
    refresh: state.refresh,
  }),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/checkbox", () => ({ Checkbox: "input" }));
vi.mock("../ui/label", () => ({ Label: "label" }));
vi.mock("../ui/collapsible", () => ({
  Collapsible: "section",
  CollapsibleTrigger: "button",
  CollapsiblePanel: "div",
}));
import { SharedSpecialistDiscovery } from "./SharedSpecialistDiscovery";

const now = "2026-10-17T12:00:00.000Z";
const host = {
  environmentId: EnvironmentId.make("shared-host"),
  label: "Product workspace",
} as unknown as EnvironmentPresentation;
const checkout: SharedCheckout = {
  checkoutId: "alice-checkout",
  participantId: "alice",
  sharedProjectId: "catalog",
  localEnvironmentId: EnvironmentId.make("local"),
  localProjectId: ProjectId.make("my-catalog"),
  repository: "github.com/example/catalog",
  createdAt: now,
};
const snapshot: SharedWorkspaceSnapshot = {
  workspace: {
    workspaceId: "workspace",
    name: "Product",
    limits: { maxSpecialists: 100, maxSnapshotBytes: 1024 },
    createdAt: now,
  },
  participant: { participantId: "alice", kind: "person", displayName: "Alice", createdAt: now },
  projects: ["catalog", "payments"].map((id) => ({
    sharedProjectId: id,
    name: id,
    repository: `github.com/example/${id}`,
    aliases: [],
    forkOf: null,
    hostProjectId: ProjectId.make(`host-${id}`),
    createdAt: now,
  })),
  checkouts: [checkout],
  specialists: ["catalog", "payments"].map((id) => ({
    specialistId: `${id}-specialist`,
    label: `${id} specialist`,
    nativeTarget: {
      projectId: ProjectId.make(`host-${id}`),
      instanceId: ProviderInstanceId.make("meerkat"),
      agentId: `${id}-native`,
    },
    assignments: [
      {
        sharedProjectId: id,
        charter: `Full ${id} charter with retained responsibilities.`,
        paths: [`src/${id}`],
        tags: [id],
      },
    ],
    assignmentVersion: 1,
    supersededAt: null,
    successorId: null,
    createdAt: now,
  })),
};
function match(id: "catalog" | "payments"): SharedDiscoveryResult["items"][number] {
  return {
    specialistId: `${id}-specialist`,
    label: `${id} specialist`,
    sharedProjectIds: [id],
    assignmentVersion: 1,
    supersededAt: null,
    successorId: null,
    matches: [
      {
        sharedProjectId: id,
        reasons: [
          { kind: "path", path: `src/${id}` },
          { kind: "tag", tag: id },
        ],
        charterExcerpt: `Full ${id} charter`,
        charterExcerptTruncated: true,
      },
    ],
  };
}
let rendered: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.result = { items: [], nextCursor: null };
  state.error = null;
  state.pending = false;
  state.discover.mockClear();
  state.refresh.mockClear();
  state.refreshDirectory.mockClear();
  state.navigate.mockClear();
});
afterEach(async () => {
  await act(async () => rendered?.unmount());
  vi.unstubAllGlobals();
});
async function render(connected = true) {
  await act(async () => {
    rendered = create(
      <SharedSpecialistDiscovery
        host={host}
        checkout={checkout}
        snapshot={snapshot}
        connected={connected}
        refreshDirectory={state.refreshDirectory}
      />,
    );
  });
}
async function open() {
  await act(async () => rendered!.root.findAllByType("section")[0]!.props.onOpenChange(true));
}
const tree = () => JSON.stringify(rendered!.toJSON());
const button = (label: string) =>
  rendered!.root.findAllByType("button").find((item) => item.children.includes(label))!;
async function submit() {
  await act(async () =>
    rendered!.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() }),
  );
}

describe("inline shared specialist discovery", () => {
  it("opens within the project and starts with that shared project's directory", async () => {
    await render();
    expect(state.discover).not.toHaveBeenCalled();
    await open();
    expect(state.discover).toHaveBeenLastCalledWith({
      environmentId: "shared-host",
      input: { sharedProjectId: "catalog", limit: 10 },
    });
    expect(tree()).toContain("No specialists match these filters.");
  });

  it("submits literal text, path and tag filters across projects without changing the local checkout", async () => {
    await render();
    await open();
    const inputs = rendered!.root.findAllByType("input");
    await act(async () => {
      inputs
        .find((input) => input.props["aria-label"])!
        .props.onChange({ target: { value: " OAuth_% " } });
      inputs
        .find((input) => input.props.id?.endsWith("-path"))!
        .props.onChange({ target: { value: "src/%_auth" } });
      inputs
        .find((input) => input.props.id?.endsWith("-tag"))!
        .props.onChange({ target: { value: "API_%" } });
      inputs
        .find((input) => input.props.id?.endsWith("-all-projects"))!
        .props.onCheckedChange(true);
    });
    await submit();
    expect(state.discover).toHaveBeenLastCalledWith({
      environmentId: "shared-host",
      input: { query: "OAuth_%", paths: ["src/%_auth"], tags: ["API_%"], limit: 10 },
    });
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("opens cross-project conversations without a send context and labels the restriction", async () => {
    state.result = { items: [match("payments")], nextCursor: null };
    await render();
    await open();
    expect(tree()).toContain("not assigned to this checkout's project");
    await act(async () => button("View conversation").props.onClick());
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/$environmentId/agents/$agentId",
      params: { environmentId: "shared-host", agentId: "payments-specialist" },
      search: { project: "host-payments", shared: true },
    });
  });

  it("keeps an assigned conversation bound to this checkout and shows full charter separately from its excerpt", async () => {
    state.result = { items: [match("catalog")], nextCursor: null };
    await render();
    await open();
    expect(tree()).toContain("Charter excerpt");
    expect(tree()).toContain("Read full charter");
    expect(tree()).toContain(snapshot.specialists[0]!.assignments[0]!.charter);
    expect(tree()).toContain("Path: src/catalog");
    await act(async () => button("Open conversation").props.onClick());
    expect(state.navigate.mock.calls[0]![0].search).toEqual({
      project: "host-catalog",
      shared: true,
      checkoutEnvironment: "local",
      checkoutProject: "my-catalog",
      checkoutId: "alice-checkout",
    });
  });

  it("reports offline, loading and unavailable states without presenting an empty directory", async () => {
    await render(false);
    await open();
    expect(state.discover).not.toHaveBeenCalled();
    expect(tree()).toContain("The host is offline");
    expect(button("Search").props.disabled).toBe(true);
    expect(tree()).not.toContain("No specialists match");
    await act(async () => rendered!.unmount());
    state.pending = true;
    await render();
    await open();
    expect(tree()).toContain("Searching specialists");
    expect(tree()).not.toContain("No specialists match");
    await act(async () => rendered!.unmount());
    state.pending = false;
    state.error = "Host does not support specialist discovery.";
    await render();
    await open();
    expect(tree()).toContain(state.error);
    expect(tree()).not.toContain("No specialists match");
  });

  it("requires a directory refresh when assignments changed before opening a conversation", async () => {
    state.result = { items: [{ ...match("catalog"), assignmentVersion: 2 }], nextCursor: null };
    await render();
    await open();
    expect(button("Open conversation").props.disabled).toBe(true);
    expect(tree()).not.toContain("Read full charter");
    await act(async () => button("Refresh changed directory").props.onClick());
    expect(state.refreshDirectory).toHaveBeenCalledOnce();
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("uses stable next cursors and resets pagination when a new search is submitted", async () => {
    state.result = { items: [match("catalog")], nextCursor: "catalog-specialist" };
    await render();
    await open();
    await act(async () => button("Next results").props.onClick());
    expect(state.discover).toHaveBeenLastCalledWith({
      environmentId: "shared-host",
      input: { sharedProjectId: "catalog", after: "catalog-specialist", limit: 10 },
    });
    await act(async () =>
      rendered!.root
        .findAllByType("input")
        .find((input) => input.props["aria-label"])!
        .props.onChange({ target: { value: "API" } }),
    );
    await submit();
    expect(state.discover).toHaveBeenLastCalledWith({
      environmentId: "shared-host",
      input: { sharedProjectId: "catalog", query: "API", limit: 10 },
    });
  });
});

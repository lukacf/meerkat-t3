import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type SharedCompositionHistory,
  type SharedCompositionHistoryItem,
} from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  pages: {} as Record<string, SharedCompositionHistory>,
  pending: false,
  error: null as string | null,
  query: vi.fn((input) => input),
  refresh: vi.fn(),
}));
vi.mock("../../state/sharedWorkspace", () => ({
  sharedWorkspaceEnvironment: { compositionHistory: state.query },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: { input: { cursor?: string } } | null) => ({
    data:
      query && !state.pending && !state.error ? state.pages[query.input.cursor ?? "first"] : null,
    error: query ? state.error : null,
    isPending: Boolean(query) && state.pending,
    refresh: state.refresh,
  }),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
import { SharedCompositionHistory as History } from "./SharedCompositionHistory";
const environmentId = EnvironmentId.make("shared-host");
const timestamp = "2026-10-17T12:00:00.000Z";
const target = {
  projectId: ProjectId.make("host-project"),
  instanceId: ProviderInstanceId.make("meerkat"),
  agentId: "native-specialist",
};
const item = (status: "pending" | "conflict" | "completed"): SharedCompositionHistoryItem => ({
  authorDisplayName: "Catalog contracts",
  operation: {
    operationKey: `operation-${status}`,
    operationId: `request-${status}`,
    actor: { kind: "specialist", id: "catalog" },
    kind: "split",
    status,
    detail: status === "pending" ? "Native acknowledgement unavailable; operation retained." : null,
    creations: [],
    evidence:
      status === "completed"
        ? [
            {
              step: "revise",
              kind: "native_revision",
              nativeTarget: target,
              revisionId: "native-revision-9",
              observedAt: timestamp,
            },
          ]
        : [],
    lineage:
      status === "completed"
        ? [{ predecessorId: "catalog", successorIds: ["storage"], superseded: true }]
        : [],
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  assignments: [
    {
      specialistId: "storage",
      creationKey: null,
      label: "Storage",
      expectedVersion: 2,
      assignments: [
        {
          sharedProjectId: "catalog-project",
          charter: "Own durable writes",
          paths: ["src/storage"],
          tags: ["durability"],
        },
      ],
    },
  ],
  peers: [],
  transitions: [
    {
      predecessorId: "catalog",
      expectedVersion: 1,
      successors: [{ specialistId: "storage", expectedVersion: 2 }],
      supersede: true,
    },
  ],
});
let rendered: ReactTestRenderer | undefined;
const element = (connected = true, specialistId = "catalog") => (
  <History
    environmentId={environmentId}
    specialistId={specialistId}
    snapshot={null}
    connected={connected}
  />
);
const text = () => JSON.stringify(rendered!.toJSON());
const button = (label: string) =>
  rendered!.root
    .findAllByType("button")
    .find((node) => node.props["aria-label"] === label || node.children.includes(label))!;
async function render(connected = true) {
  await act(async () => {
    rendered = create(element(connected));
  });
}
async function open() {
  await act(async () => {
    rendered!.root.findAllByType("details")[0]!.props.onToggle({ currentTarget: { open: true } });
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.pages = {
    first: {
      items: [item("completed"), item("pending"), item("conflict")],
      nextCursor: "composition:2",
      observedAt: timestamp,
    },
    "composition:2": { items: [], nextCursor: null, observedAt: timestamp },
  };
  state.pending = false;
  state.error = null;
  state.query.mockClear();
  state.refresh.mockClear();
});
afterEach(async () => {
  await act(async () => {
    rendered?.unmount();
  });
  rendered = undefined;
  vi.unstubAllGlobals();
});

describe("responsibility history", () => {
  it("loads only when opened and preserves observed status, lineage and native evidence", async () => {
    await render();
    expect(state.query).not.toHaveBeenCalled();
    await open();
    expect(state.query).toHaveBeenCalledWith({
      environmentId,
      input: { specialistId: "catalog", limit: 5 },
    });
    expect(text()).toContain("Completed");
    expect(text()).toContain("Pending");
    expect(text()).toContain("Conflict");
    expect(text()).toContain("Native acknowledgement unavailable; operation retained.");
    expect(text()).toContain("Completion has not been observed.");
    expect(text()).toContain("Predecessor retained for existing requests.");
    expect(text()).toContain("native-revision-9");
    expect(text()).toContain("Requested from assignment version");
    expect(text()).toContain("Existing requests keep their original specialist");
    expect(state.refresh).not.toHaveBeenCalled();
    expect(rendered!.root.findAllByType("button").flatMap((node) => node.children)).not.toContain(
      "Retry operation",
    );
  });
  it("shows the host's current author name while preserving the retained identity", async () => {
    const record = item("completed");
    state.pages.first = {
      items: [
        {
          ...record,
          authorDisplayName: "Jordan",
          operation: {
            ...record.operation,
            actor: { kind: "participant", id: "retained-participant-id" },
          },
        },
      ],
      nextCursor: null,
      observedAt: timestamp,
    };
    await render();
    await open();
    expect(text()).toContain("Jordan");
    expect(text()).toContain("retained-participant-id");
    expect(text()).not.toContain("Workspace participant");
  });
  it("uses a generic label when the original actor's host record is unavailable", async () => {
    const record = item("completed");
    state.pages.first = {
      items: [
        {
          ...record,
          authorDisplayName: null,
          operation: {
            ...record.operation,
            actor: { kind: "participant", id: "missing-participant-id" },
          },
        },
      ],
      nextCursor: null,
      observedAt: timestamp,
    };
    await render();
    await open();
    expect(text()).toContain("Workspace participant");
    expect(text()).toContain("missing-participant-id");
  });
  it("pages bounded results and scopes a changed specialist back to its newest page", async () => {
    await render();
    await open();
    await act(async () => button("Older changes").props.onClick());
    expect(state.query).toHaveBeenLastCalledWith({
      environmentId,
      input: { specialistId: "catalog", limit: 5, cursor: "composition:2" },
    });
    expect(text()).not.toContain("native-revision-9");
    expect(text()).toContain("Newer changes");
    await act(async () => {
      rendered!.update(element(true, "storage"));
    });
    expect(state.query).toHaveBeenLastCalledWith({
      environmentId,
      input: { specialistId: "storage", limit: 5 },
    });
    expect(text()).not.toContain("Newer changes");
  });
  it("shows offline and read errors without claiming an empty history or issuing mutations", async () => {
    await render(false);
    await open();
    expect(state.query).not.toHaveBeenCalled();
    expect(text()).toContain("Connect to the shared host");
    expect(button("Refresh responsibility history").props.disabled).toBe(true);
    state.error = "Host request denied";
    await act(async () => {
      rendered!.update(element());
    });
    expect(text()).toContain("Host request denied");
    expect(text()).not.toContain("No responsibility changes");
    await act(async () => button("Refresh responsibility history").props.onClick());
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });
  it("labels a conflict's routing as proposed without claiming the predecessor was retired", async () => {
    state.pages.first = { items: [item("conflict")], nextCursor: null, observedAt: timestamp };
    await render();
    await open();
    expect(text()).toContain("Proposed future routing");
    expect(text()).toContain("Not applied.");
    expect(text()).not.toContain("Specialist created");
    expect(text()).not.toContain("Predecessor retired");
  });
});

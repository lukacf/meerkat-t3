import {
  EnvironmentId,
  ThreadId,
  type SharedInbox,
  type SharedKnowledgeSearchHit,
  type SharedParticipant,
  type SharedRevision,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  records: {} as Record<string, SharedKnowledgeSearchHit[]>,
  pending: false,
  error: null as string | null,
  knowledge: vi.fn((input) => input),
  refresh: vi.fn(),
  acknowledge: vi.fn(),
}));
vi.mock("../../state/sharedWorkspace", () => ({
  sharedWorkspaceEnvironment: { knowledge: state.knowledge },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: { input: { evidenceId: string } } | null) => ({
    data:
      query && !state.pending && !state.error
        ? { records: state.records[query.input.evidenceId] ?? [], hasMore: false, nextCursor: null }
        : null,
    error: query ? state.error : null,
    isPending: query !== null && state.pending,
    isSuccess: query !== null && !state.pending && !state.error,
    refresh: state.refresh,
  }),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "span",
  TooltipTrigger: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipPopup: "span",
}));
import { SharedActivityInbox } from "./SharedActivityInbox";

const environmentId = EnvironmentId.make("shared-host");
const createdAt = "2026-10-17T12:00:00.000Z";
const author: SharedParticipant = {
  participantId: "contracts-specialist",
  kind: "specialist",
  displayName: "Catalog contracts",
  createdAt,
};
const oldRevision: SharedRevision = {
  branch: "feature/catalog-v1",
  commit: "a".repeat(40),
  applicability: "proposal",
};
const newRevision: SharedRevision = {
  branch: "feature/catalog-v2",
  commit: "b".repeat(40),
  applicability: "branch",
};
function original(): SharedKnowledgeSearchHit {
  return {
    evidenceId: "finding-original",
    contextId: "task-context",
    contextVersion: "context-v1",
    sharedProjectId: "catalog",
    revision: oldRevision,
    kind: "finding",
    title: "Catalog writes appear synchronous",
    body: "Original observation: writes return only after indexing.",
    sources: [],
    supersedes: [],
    state: "open",
    author,
    createdAt,
    corrections: [
      {
        evidenceId: "finding-correction",
        title: "Indexing runs after commit",
        contextId: "task-context",
        contextVersion: "context-v2",
        revision: newRevision,
        author,
        createdAt,
      },
    ],
    hasMoreCorrections: false,
  };
}
function correction(): SharedKnowledgeSearchHit {
  return {
    ...original(),
    evidenceId: "finding-correction",
    contextVersion: "context-v2",
    revision: newRevision,
    title: "Indexing runs after commit",
    body: "Corrected observation: indexing is asynchronous and may lag behind a committed write.",
    supersedes: ["finding-original"],
    corrections: [],
  };
}
const inbox: SharedInbox = {
  recipientId: "alice",
  batchId: "sealed-human-batch",
  hasMore: false,
  events: [
    {
      eventId: "correction-event",
      contextId: "task-context",
      contextVersion: "context-v2",
      revision: newRevision,
      kind: "correction",
      summary: "Correction: Indexing runs after commit",
      paths: [],
      tags: [],
      sources: [],
      knowledge: { evidenceId: "finding-correction", supersedes: ["finding-original"] },
      sequence: 1,
      author,
      context: {
        contextId: "task-context",
        contextVersion: "context-v2",
        checkoutId: "local-checkout",
        participantId: "alice",
        sharedProjectId: "catalog",
        source: { kind: "thread", threadId: ThreadId.make("local-task") },
        objective: "Check catalog consistency",
        revision: newRevision,
        paths: [],
        tags: [],
        updatedAt: createdAt,
      },
      createdAt,
    },
  ],
};

let rendered: ReactTestRenderer | undefined;
function element(offline = false, recipientId = "alice") {
  return (
    <SharedActivityInbox
      environmentId={environmentId}
      inbox={{ ...inbox, recipientId }}
      snapshot={null}
      busy={false}
      offline={offline}
      error={null}
      onRefresh={state.refresh}
      onAcknowledge={state.acknowledge}
    />
  );
}
const tree = () => JSON.stringify(rendered!.toJSON());
const button = (label: string) =>
  rendered!.root
    .findAllByType("button")
    .find((item) => item.props["aria-label"] === label || item.children.includes(label))!;
async function render(offline = false) {
  await act(async () => {
    rendered = create(element(offline));
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.records = { "finding-original": [original()], "finding-correction": [correction()] };
  state.pending = false;
  state.error = null;
  state.knowledge.mockClear();
  state.refresh.mockClear();
  state.acknowledge.mockClear();
});
afterEach(async () => {
  await act(async () => rendered?.unmount());
  rendered = undefined;
  vi.unstubAllGlobals();
});

describe("reading corrections from a shared inbox", () => {
  it("reads an empty-sources correction and its retained original without acknowledging either", async () => {
    const originalBefore = JSON.stringify(state.records["finding-original"]);
    await render();
    expect(tree()).toContain("View correction");
    expect(state.knowledge).not.toHaveBeenCalled();
    await act(async () => button("View correction").props.onClick());
    expect(state.knowledge).toHaveBeenCalledWith({
      environmentId: "shared-host",
      input: { evidenceId: "finding-correction" },
    });
    expect(tree()).toContain(correction().body);
    expect(tree()).toContain("Supersedes");
    expect(tree()).toContain(
      "Previous findings are kept with their original content and revision.",
    );
    expect(state.acknowledge).not.toHaveBeenCalled();
    await act(async () => button("View retained finding finding-original").props.onClick());
    expect(state.knowledge).toHaveBeenCalledWith({
      environmentId: "shared-host",
      input: { evidenceId: "finding-original" },
    });
    expect(tree()).toContain(original().body);
    expect(tree()).toContain(oldRevision.branch);
    expect(tree()).toContain(oldRevision.commit);
    expect(tree()).toContain(newRevision.branch);
    expect(tree()).toContain(newRevision.commit);
    expect(tree()).toContain("Proposed change");
    expect(tree()).toContain("Branch revision");
    expect(JSON.stringify(state.records["finding-original"])).toBe(originalBefore);
    expect(state.acknowledge).not.toHaveBeenCalled();
    await act(async () => button("Mark these updates read").props.onClick());
    expect(state.acknowledge).toHaveBeenCalledExactlyOnceWith("sealed-human-batch");
  });

  it("shows loading, failure and retry without presenting the summary as the finding", async () => {
    state.pending = true;
    await render();
    await act(async () => button("View correction").props.onClick());
    expect(tree()).toContain("Loading finding...");
    expect(tree()).not.toContain(correction().body);
    state.pending = false;
    state.error = "The host is reconnecting";
    await act(async () => rendered!.update(element()));
    expect(tree()).toContain("The host is reconnecting");
    await act(async () => button("Retry finding").props.onClick());
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.acknowledge).not.toHaveBeenCalled();
    state.error = null;
    await act(async () => rendered!.update(element()));
    expect(tree()).toContain(correction().body);
  });

  it("keeps fetched content readable offline and never fetches an unopened original offline", async () => {
    await render();
    await act(async () => button("View correction").props.onClick());
    state.knowledge.mockClear();
    await act(async () => rendered!.update(element(true)));
    expect(tree()).toContain(correction().body);
    expect(tree()).toContain("Showing the last fetched finding");
    expect(button("Mark these updates read").props.disabled).toBe(true);
    await act(async () => button("View retained finding finding-original").props.onClick());
    expect(tree()).toContain("Reconnect to load this finding.");
    expect(tree()).not.toContain(original().body);
    expect(state.knowledge).not.toHaveBeenCalled();
    expect(state.acknowledge).not.toHaveBeenCalled();
  });

  it("keeps an unavailable reference visible instead of showing a different project or finding", async () => {
    state.records["finding-correction"] = [{ ...correction(), sharedProjectId: "payments" }];
    await render();
    await act(async () => button("View correction").props.onClick());
    expect(tree()).toContain("This finding is not available in this shared project.");
    expect(tree()).not.toContain(correction().body);
    expect(tree()).toContain("View retained finding");
    state.records["finding-correction"] = [{ ...correction(), evidenceId: "another-finding" }];
    await act(async () => rendered!.update(element()));
    expect(tree()).not.toContain(correction().body);
    expect(state.acknowledge).not.toHaveBeenCalled();
  });

  it("does not carry one participant's expanded finding into another participant's briefing", async () => {
    await render();
    await act(async () => button("View correction").props.onClick());
    expect(tree()).toContain(correction().body);
    await act(async () => rendered!.update(element(true, "bob")));
    expect(tree()).not.toContain(correction().body);
    expect(button("View correction").props["aria-expanded"]).toBe(false);
    expect(state.acknowledge).not.toHaveBeenCalled();
  });
});

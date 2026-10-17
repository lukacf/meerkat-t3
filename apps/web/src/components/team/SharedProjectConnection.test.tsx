import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, type SharedWorkspaceSnapshot } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  snapshot: null as SharedWorkspaceSnapshot | null,
  connected: true,
  error: null as string | null,
  pending: false,
  contribute: true,
  phase: "connected",
  join: vi.fn(),
  attach: vi.fn(),
  navigate: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../state/sharedWorkspace", () => ({
  sharedWorkspaceEnvironment: { join: "join", attachCheckout: "attach" },
  useSharedHosts: () => [
    { environmentId: "shared-host", label: "Product host", connection: { phase: state.phase } },
  ],
  useSharedDirectory: () => ({
    snapshot: state.snapshot,
    connected: state.connected,
    error: state.error,
    isPending: state.pending,
    permissions: { contribute: state.contribute },
    refresh: state.refresh,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "join" | "attach") => state[command],
}));
vi.mock("../../state/query", () => ({ formatEnvironmentQueryError: (cause: string) => cause }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
import { SharedProjectConnection } from "./SharedProjectConnection";

const now = "2026-10-16T12:00:00.000Z";
const project: EnvironmentProject = {
  id: ProjectId.make("local-catalog"),
  environmentId: EnvironmentId.make("local"),
  title: "Catalog",
  workspaceRoot: "/work/catalog",
  repositoryIdentity: {
    canonicalKey: "old-display-key-is-not-membership",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:Example/Catalog.git",
    },
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
};
function directory(): SharedWorkspaceSnapshot {
  return {
    workspace: {
      workspaceId: "shared",
      name: "Product",
      limits: { maxSpecialists: 10, maxSnapshotBytes: 1024 },
      createdAt: now,
    },
    participant: null,
    projects: [
      {
        sharedProjectId: "catalog",
        name: "Catalog",
        repository: "github.com/example/catalog",
        aliases: [],
        forkOf: null,
        hostProjectId: ProjectId.make("native-anchor"),
        createdAt: now,
      },
    ],
    checkouts: [],
    specialists: [],
  };
}
let rendered: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.snapshot = directory();
  state.connected = true;
  state.error = null;
  state.pending = false;
  state.contribute = true;
  state.phase = "connected";
  state.join.mockReset().mockResolvedValue({ _tag: "Success", value: { participantId: "alice" } });
  state.attach.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  state.navigate.mockReset();
  state.refresh.mockReset();
});
afterEach(async () => {
  await act(async () => rendered?.unmount());
  vi.unstubAllGlobals();
});
const tree = () => JSON.stringify(rendered!.toJSON());
async function render(value = project) {
  await act(async () => {
    rendered = create(<SharedProjectConnection project={value} />);
  });
}
const connectButton = () =>
  rendered!.root
    .findAllByType("button")
    .find((button) => button.children.includes("Use shared specialists"))!;

describe("attach local checkout to shared specialists", () => {
  it("joins with a participant name, then explicitly attaches the canonical repository", async () => {
    await render();
    await act(async () =>
      rendered!.root.findByType("input").props.onChange({ target: { value: "Alice" } }),
    );
    await act(async () => connectButton().props.onClick());
    expect(state.join).toHaveBeenCalledExactlyOnceWith({
      environmentId: "shared-host",
      input: { displayName: "Alice" },
    });
    expect(state.attach).toHaveBeenCalledExactlyOnceWith({
      environmentId: "shared-host",
      input: {
        localEnvironmentId: "local",
        localProjectId: "local-catalog",
        sharedProjectId: "catalog",
        repository: "github.com/example/catalog",
      },
    });
    expect(state.join.mock.invocationCallOrder[0]!).toBeLessThan(
      state.attach.mock.invocationCallOrder[0]!,
    );
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("does not invent a participant or attach after a failed join", async () => {
    await render();
    await act(async () => connectButton().props.onClick());
    expect(tree()).toContain("Enter your name");
    expect(state.join).not.toHaveBeenCalled();
    await act(async () =>
      rendered!.root.findByType("input").props.onChange({ target: { value: "Alice" } }),
    );
    state.join.mockResolvedValueOnce({ _tag: "Failure", cause: "Invite expired" });
    await act(async () => connectButton().props.onClick());
    expect(tree()).toContain("Invite expired");
    expect(state.attach).not.toHaveBeenCalled();
  });
  it("keeps a cached matching roster visible offline without allowing attachment", async () => {
    state.connected = false;
    state.phase = "offline";
    await render();
    expect(tree()).toContain("Host offline");
    expect(connectButton().props.disabled).toBe(true);
    await act(async () => connectButton().props.onClick());
    expect(state.join).not.toHaveBeenCalled();
  });
  it("does not equate missing or ambiguous repository identity with an existing project", async () => {
    await render({
      ...project,
      repositoryIdentity: {
        ...project.repositoryIdentity!,
        locator: { source: "git-remote", remoteName: "origin", remoteUrl: "/private/local-copy" },
      },
    });
    expect(tree()).toContain("Add an unambiguous Git remote");
    expect(rendered!.root.findAllByType("button")).toHaveLength(0);
  });
  it("distinguishes an unregistered repository from unavailable host data", async () => {
    state.snapshot = { ...directory(), projects: [] };
    await render();
    expect(tree()).toContain("has not been registered");
    state.snapshot = null;
    state.error = "This host does not support shared specialists.";
    await act(async () => rendered!.update(<SharedProjectConnection project={project} />));
    expect(tree()).toContain("does not support shared specialists");
    expect(tree()).not.toContain("has not been registered");
  });
  it("explains read-only connections instead of offering a working send path", async () => {
    state.contribute = false;
    await render();
    expect(tree()).toContain("Ask the workspace owner for a participant invitation");
    expect(connectButton().props.disabled).toBe(true);
    await act(async () => connectButton().props.onClick());
    expect(state.attach).not.toHaveBeenCalled();
  });
});

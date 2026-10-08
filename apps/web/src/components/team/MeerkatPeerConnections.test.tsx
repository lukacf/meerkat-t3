import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MeerkatPeerConnections,
  type MeerkatProjectAgent,
} from "@t3tools/contracts";
import { act, type PropsWithChildren } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  data: null as MeerkatPeerConnections | null,
  observedAt: 1,
  threads: [] as unknown[],
  providers: [] as unknown[],
  agents: [] as MeerkatProjectAgent[],
  agentsPending: false,
  environmentId: "local",
  change: vi.fn(),
  lifecycle: vi.fn(),
  refresh: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => [],
}));
vi.mock("../../lib/utils", () => ({ randomUUID: () => "request" }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [],
  useThreadShells: () => state.threads,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: state.environmentId,
        serverConfig: { providers: state.providers },
      },
    ],
  }),
}));
vi.mock("../../state/meerkatTeam", () => ({
  meerkatTeamEnvironment: {
    peerConnections: () => "connections",
    peerConnectionSet: "change",
    projectAgents: () => "agents",
    projectAgentLifecycle: "lifecycle",
  },
  useVisibleTeamRefresh: () => {},
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: string | null) => ({
    data:
      query === "connections" ? state.data : query === "agents" ? { agents: state.agents } : null,
    dataUpdatedAt: state.observedAt,
    error: null,
    isPending: query === "agents" && state.agentsPending,
    isSuccess: query !== null,
    refresh: state.refresh,
  }),
  formatEnvironmentQueryError: (cause: unknown) => String(cause),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "lifecycle" ? state.lifecycle : state.change),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/popover", () => ({
  Popover: "div",
  PopoverPopup: "div",
  PopoverTitle: "div",
  PopoverTrigger: "button",
}));
vi.mock("../ui/dialog", async () => {
  const { createContext, useContext } = await import("react");
  const Context = createContext(false);
  const Container = ({ children }: PropsWithChildren) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: PropsWithChildren<{ open: boolean }>) => (
      <Context value={open}>{children}</Context>
    ),
    DialogPopup: ({ children }: PropsWithChildren) =>
      useContext(Context) ? <div role="dialog">{children}</div> : null,
    DialogHeader: Container,
    DialogTitle: Container,
    DialogDescription: Container,
    DialogPanel: Container,
    DialogFooter: Container,
  };
});

import {
  MeerkatPeerConnectionsProvider,
  useMeerkatPeerConnections,
  type PeerItem,
} from "./MeerkatPeerConnections";

const environmentId = EnvironmentId.make("local");
const instanceId = ProviderInstanceId.make("meerkat");
const source: PeerItem = {
  environmentId,
  endpoint: {
    kind: "thread",
    projectId: ProjectId.make("source-project"),
    instanceId,
    threadId: ThreadId.make("source-thread"),
  },
  label: "Source task",
  projectTitle: "Source project",
};
const target = {
  kind: "thread" as const,
  projectId: ProjectId.make("peer-project"),
  instanceId,
  threadId: ThreadId.make("peer-thread"),
};
const connection = {
  edgeId: "edge",
  source: source.endpoint,
  target,
  desired: true,
  status: "connected" as const,
  error: null,
};
function OpenManager() {
  const connections = useMeerkatPeerConnections();
  return <button onClick={() => connections?.choosePeer(source)}>Manage</button>;
}
let renderer: ReactTestRenderer | undefined;
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((node) => node.children.includes(label))!;
const current = () => renderer!.root.findByProps({ "aria-label": "Current connections" });
const available = () => renderer!.root.findByProps({ "aria-label": "Available connections" });
const render = () =>
  act(() => {
    const element = (
      <MeerkatPeerConnectionsProvider>
        <OpenManager />
      </MeerkatPeerConnectionsProvider>
    );
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.data = { endpoint: source.endpoint, connections: [connection] };
  state.observedAt = 1;
  state.threads = [
    {
      environmentId,
      projectId: target.projectId,
      id: target.threadId,
      title: "Peer task",
      archivedAt: null,
      session: { providerInstanceId: instanceId },
      modelSelection: { instanceId, model: "openai:model" },
    },
  ];
  state.providers = [{ driver: "meerkat", instanceId }];
  state.agents = [];
  state.agentsPending = false;
  state.change.mockReset();
  state.lifecycle.mockReset();
  state.refresh.mockReset();
  state.navigate.mockReset();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("retains an unloaded disconnect for retry and excludes it from choices until confirmed disconnected", async () => {
  state.change.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      endpoint: source.endpoint,
      connections: [{ ...connection, desired: false, status: "unloaded" }],
    },
  });
  render();
  act(() => button("Manage").props.onClick());
  await act(async () => {
    current().findByProps({ "aria-label": "Disconnect Peer task" }).props.onClick();
  });
  expect(state.change).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { source: source.endpoint, target, connected: false, requestId: "request" },
  });
  expect(JSON.stringify(renderer!.toJSON())).toContain("Cleanup pending");
  expect(current().findByProps({ "aria-label": "Retry disconnect Peer task" })).toBeDefined();
  expect(available().findAllByType("button")).toHaveLength(0);
  expect(state.navigate).not.toHaveBeenCalled();

  state.data = {
    endpoint: source.endpoint,
    connections: [{ ...connection, desired: false, status: "disconnected" }],
  };
  state.observedAt = Number.MAX_SAFE_INTEGER;
  render();
  expect(current().findAllByType("button")).toHaveLength(0);
  expect(available().findAllByType("button")).toHaveLength(1);
  expect(JSON.stringify(renderer!.toJSON())).toContain("Peer task");
  expect(state.change).toHaveBeenCalledOnce();
});

const specialist: MeerkatProjectAgent = {
  agentId: "core-specialist",
  projectId: ProjectId.make("peer-project"),
  instanceId,
  label: "Core specialist",
  role: "core",
  instructions: "Inspect core behavior.",
  model: "openai:model",
  enabled: false,
  archived: false,
  connectionStatus: "disabled",
  error: null,
  agentRef: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const specialistTarget = {
  kind: "project-agent" as const,
  projectId: specialist.projectId,
  instanceId,
  agentId: specialist.agentId,
};
const specialistConnection = {
  ...connection,
  target: specialistTarget,
  status: "unloaded" as const,
  error: "Paused. Connect specialist.",
};
const showSpecialist = (agent = specialist) => {
  state.agents = [agent];
  state.data = { endpoint: source.endpoint, connections: [specialistConnection] };
  render();
  act(() => button("Manage").props.onClick());
};
const connectedSpecialist = {
  ...specialist,
  enabled: true,
  connectionStatus: "connected" as const,
};
const connectedPeers = {
  endpoint: source.endpoint,
  connections: [{ ...specialistConnection, status: "connected" as const, error: null }],
};

it("explicitly restores a paused specialist before retrying its saved edge in the same environment", async () => {
  type RestoreResult = { _tag: "Success"; value: MeerkatProjectAgent };
  let resolveRestore!: (value: RestoreResult) => void;
  const restored = new Promise<RestoreResult>((resolve) => {
    resolveRestore = resolve;
  });
  state.lifecycle.mockReturnValue(restored);
  state.change.mockResolvedValue({ _tag: "Success", value: connectedPeers });
  showSpecialist();
  const connect = button("Connect agent").props.onClick;
  await act(async () => {
    connect();
    connect();
  });
  expect(state.lifecycle).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { projectId: specialist.projectId, agentId: specialist.agentId, action: "connect" },
  });
  expect(state.change).not.toHaveBeenCalled();
  expect(button("Connect agent").props.disabled).toBe(true);

  await act(async () => {
    state.agents = [connectedSpecialist];
    resolveRestore({ _tag: "Success", value: connectedSpecialist });
  });
  expect(state.change).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      source: source.endpoint,
      target: specialistTarget,
      connected: true,
      requestId: "request",
    },
  });
  expect(JSON.stringify(renderer!.toJSON())).toContain("Connected.");
  expect(state.refresh).toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
});

it.each([
  { _tag: "Failure", cause: "Native restore failed" },
  {
    _tag: "Success",
    value: { ...specialist, connectionStatus: "error", error: "Native restore failed" },
  },
])("preserves a failed specialist restore and does not retry the edge: $._tag", async (result) => {
  state.lifecycle.mockResolvedValue(result);
  showSpecialist();
  await act(async () => button("Connect agent").props.onClick());
  expect(state.change).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
  expect(JSON.stringify(renderer!.toJSON())).toContain("Native restore failed");
  expect(button("Connect agent").props.disabled).toBe(false);
});

it("keeps native unload recovery on the existing edge retry for enabled specialists", async () => {
  state.change.mockResolvedValue({ _tag: "Success", value: connectedPeers });
  showSpecialist({ ...specialist, enabled: true, connectionStatus: "unloaded" });
  expect(button("Connect agent")).toBeUndefined();
  await act(async () => button("Retry connect").props.onClick());
  expect(state.change).toHaveBeenCalledOnce();
  expect(state.lifecycle).not.toHaveBeenCalled();
});

it("opens archived specialists for explicit restoration without an ineffective edge retry", async () => {
  showSpecialist({ ...specialist, archived: true });
  expect(button("Connect agent")).toBeUndefined();
  expect(button("Retry connect")).toBeUndefined();
  act(() => button("Open to restore").props.onClick());
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith({
    to: "/$environmentId/agents/$agentId",
    params: { environmentId, agentId: specialist.agentId },
    search: { project: specialist.projectId },
  });
  expect(state.lifecycle).not.toHaveBeenCalled();
  expect(state.change).not.toHaveBeenCalled();
});

it("does not restore from a stale or mismatched saved agent definition", () => {
  state.agentsPending = true;
  showSpecialist();
  expect(button("Connect agent")).toBeUndefined();
  expect(button("Retry connect").props.disabled).toBe(true);
  state.agentsPending = false;
  state.agents = [{ ...specialist, instanceId: ProviderInstanceId.make("another-provider") }];
  render();
  expect(button("Connect agent")).toBeUndefined();
  expect(button("Retry connect").props.disabled).toBe(true);
  expect(state.lifecycle).not.toHaveBeenCalled();
});

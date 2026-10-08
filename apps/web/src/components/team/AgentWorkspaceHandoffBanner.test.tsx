import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MeerkatCoordinatorWork,
  type MeerkatProjectTeam,
  type OrchestrationSession,
} from "@t3tools/contracts";
import type { EnvironmentQueryView } from "../../state/query";
import { handoffKey, useAgentWorkspaceHandoffStore } from "./agentWorkspaceHandoffStore";

const state = vi.hoisted(() => ({
  grant: vi.fn(),
  navigate: vi.fn(),
  session: null as OrchestrationSession | null,
  connectionPhase: "connected",
  team: null as EnvironmentQueryView<MeerkatProjectTeam> | null,
  work: null as EnvironmentQueryView<MeerkatCoordinatorWork> | null,
  observe: vi.fn(() => "work"),
  refreshWork: vi.fn(),
}));
vi.mock("../../state/entities", () => ({ useThreadShell: () => ({ session: state.session }) }));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: state.connectionPhase } }),
}));
vi.mock("@t3tools/client-runtime/state/meerkatMedia", () => ({
  createMeerkatMediaAtoms: () => ({ browserGrant: "grant" }),
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.grant }));
vi.mock("../../state/meerkatTeam", () => ({
  meerkatTeamEnvironment: { projectTeam: () => "team" },
  useVisibleTeamRefresh: () => {},
}));
vi.mock("../../state/meerkatControls", () => ({
  meerkatControlsEnvironment: { coordinatorWork: state.observe },
}));
vi.mock("../../state/query", () => ({
  formatEnvironmentQueryError: () => "Browser host is unavailable",
  useEnvironmentQuery: (atom: string | null) =>
    atom === "team"
      ? state.team
      : atom === "work"
        ? state.work
        : {
            data: null,
            dataUpdatedAt: null,
            error: null,
            isPending: false,
            isSuccess: false,
            refresh: () => {},
          },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate, Link: "a" }));
vi.mock("../ui/button", () => ({
  Button: ({
    render: _render,
    children,
    ...props
  }: {
    render?: ReactNode;
    children?: ReactNode;
  }) => <button {...props}>{children}</button>,
}));
import { AgentWorkspaceHandoffBanner } from "./AgentWorkspaceHandoffBanner";

const environmentId = EnvironmentId.make("remote");
const threadId = ThreadId.make("host-thread");
const session: OrchestrationSession = {
  threadId,
  providerInstanceId: ProviderInstanceId.make("native"),
  providerName: "meerkat",
  status: "ready",
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-10-04T00:00:00.000Z",
};
const team: MeerkatProjectTeam = {
  projectId: ProjectId.make("project"),
  observation: "loaded_runtimes",
  observedAt: "2026-10-04T00:00:00.000Z",
  projectAgents: [],
  providers: [
    {
      instanceId: ProviderInstanceId.make("native"),
      label: "Native",
      status: "ready",
      errors: [],
      totalScopeCount: 1,
      unloadedScopeCount: 0,
      loadedMobCount: 1,
      agents: [
        {
          agentRef: "coordinator",
          mobId: "host-mob",
          mobLabel: "Browser workspace",
          mobKind: "thread",
          scopeLabel: "project",
          threadId,
          availability: "live",
          record: {
            identity: "coordinator",
            display_name: "Coordinator",
            runtime_key: "host-mob/ingress",
            runtime_member_id: "ingress",
            visibility: "addressable",
            addressable: true,
            health: "ready",
            labels: {},
          },
        },
      ],
    },
  ],
};
const view = <A,>(data: A | null, error: string | null = null): EnvironmentQueryView<A> => ({
  data,
  error,
  dataUpdatedAt: data ? 1 : null,
  isPending: !data && !error,
  isSuccess: data !== null && error === null,
  refresh: state.refreshWork,
});
let renderer: ReactTestRenderer | undefined;
const share = () =>
  renderer!.root
    .findAllByType("button")
    .find((button) => button.children.includes("Share browser and return"))!;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("window", globalThis);
  vi.useFakeTimers();
  state.grant.mockReset().mockResolvedValue({ _tag: "Success", value: { enabled: true } });
  state.navigate.mockReset().mockResolvedValue(undefined);
  state.observe.mockClear();
  state.refreshWork.mockClear();
  state.session = session;
  state.connectionPhase = "connected";
  state.team = view(team);
  state.work = view({ sessionId: "native-session", busy: false, inputs: [] });
  useAgentWorkspaceHandoffStore.setState({ records: {} });
  useAgentWorkspaceHandoffStore.getState().save({
    purpose: "browser",
    origin: {
      kind: "project-agent",
      environmentId,
      projectId: ProjectId.make("project"),
      agentId: "reviewer",
      label: "Reviewer",
    },
    target: {
      projectId: ProjectId.make("project"),
      instanceId: ProviderInstanceId.make("native"),
      agentRef: "native-agent",
    },
    hostThreadId: threadId,
    cwd: "/repo",
    branch: "main",
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const render = async () =>
  act(async () => {
    const element = (
      <AgentWorkspaceHandoffBanner environmentId={environmentId} threadId={threadId} persisted />
    );
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });

it("shares the exact originating agent and navigates back only after a successful grant", async () => {
  await render();
  await act(async () => share().props.onClick());
  expect(state.grant).toHaveBeenCalledWith({
    environmentId,
    input: {
      projectId: "project",
      instanceId: "native",
      agentRef: "native-agent",
      hostThreadId: threadId,
      enabled: true,
    },
  });
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/agents/$agentId",
    params: { environmentId, agentId: "reviewer" },
    search: { project: "project" },
  });
});

it("keeps recovered handoff context available in a collapsed disclosure", async () => {
  const rows = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => {
      rows.set(key, value);
    },
  });
  const record =
    useAgentWorkspaceHandoffStore.getState().records[handoffKey(environmentId, threadId)]!;
  expect(
    useAgentWorkspaceHandoffStore
      .getState()
      .saveContext(record, "Original review findings retained without replacing my draft."),
  ).toBe(true);
  await render();
  const disclosure = renderer!.root.findByType("details");
  expect(disclosure.props.open).not.toBe(true);
  expect(disclosure.findByType("summary").children).toEqual(["Saved handoff context"]);
  expect(disclosure.findByType("p").children).toEqual([
    "Original review findings retained without replacing my draft.",
  ]);
  await act(async () => share().props.onClick());
  expect(state.grant).toHaveBeenCalledOnce();
});

it("returns to the exact domain helper attention after granting its browser, not to the primary specialist", async () => {
  const saved =
    useAgentWorkspaceHandoffStore.getState().records[handoffKey(environmentId, threadId)]!;
  useAgentWorkspaceHandoffStore.getState().save({
    ...saved,
    origin: {
      kind: "project-agent-attention",
      environmentId,
      projectId: saved.target.projectId,
      agentId: "reviewer",
      attentionId: "helper-completion",
      instanceId: saved.target.instanceId,
      agentRef: "domain-helper",
      sessionId: "helper-session",
      label: "Review helper",
    },
    target: { ...saved.target, agentRef: "domain-helper" },
  });
  await render();
  await act(async () => share().props.onClick());
  expect(state.grant).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      projectId: "project",
      instanceId: "native",
      agentRef: "domain-helper",
      hostThreadId: threadId,
      enabled: true,
    },
  });
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith({
    to: "/$environmentId/agents/$agentId",
    params: { environmentId, agentId: "reviewer" },
    search: { project: "project", attention: "helper-completion", attentionInstance: "native" },
  });
});

it("waits for a real matching provider session before offering share-and-return", async () => {
  state.session = null;
  await render();
  expect(share().props.disabled).toBe(true);
  expect(JSON.stringify(renderer!.toJSON())).toContain("Send a first message below");
  await act(async () => share().props.onClick());
  expect(state.grant).not.toHaveBeenCalled();
  for (const nextSession of [
    { ...session, status: "starting" as const },
    { ...session, status: "stopped" as const },
    { ...session, status: "error" as const },
    { ...session, providerInstanceId: ProviderInstanceId.make("other") },
  ]) {
    state.session = nextSession;
    await act(async () =>
      renderer!.update(
        <AgentWorkspaceHandoffBanner environmentId={environmentId} threadId={threadId} persisted />,
      ),
    );
    expect(share().props.disabled).toBe(true);
  }
  state.session = session;
  state.connectionPhase = "reconnecting";
  await act(async () =>
    renderer!.update(
      <AgentWorkspaceHandoffBanner environmentId={environmentId} threadId={threadId} persisted />,
    ),
  );
  expect(share().props.disabled).toBe(true);
  state.connectionPhase = "connected";
  await act(async () =>
    renderer!.update(
      <AgentWorkspaceHandoffBanner environmentId={environmentId} threadId={threadId} persisted />,
    ),
  );
  expect(share().props.disabled).toBe(false);
  expect(state.grant).not.toHaveBeenCalled();
});

it("keeps a cold-restored ready session unshareable until its native coordinator resumes", async () => {
  state.team = view<MeerkatProjectTeam>(null);
  await render();
  expect(JSON.stringify(renderer!.toJSON())).toContain("Checking this task's agent session");
  await act(async () => share().props.onClick());
  expect(state.grant).not.toHaveBeenCalled();

  const provider = team.providers[0]!;
  for (const agents of [
    [],
    provider.agents.map((agent) => ({ ...agent, availability: "unloaded" as const })),
  ]) {
    state.team = view({ ...team, providers: [{ ...provider, agents }] });
    await render();
    expect(share().props.disabled).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Send a message below to resume");
    await act(async () => share().props.onClick());
  }
  expect(state.observe).not.toHaveBeenCalled();
  expect(state.grant).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();

  state.team = view(team);
  state.work = view<MeerkatCoordinatorWork>(null);
  await render();
  expect(share().props.disabled).toBe(true);
  expect(JSON.stringify(renderer!.toJSON())).toContain("Checking this task's agent session");
  state.work = view({ sessionId: "resumed-session", busy: false, inputs: [] });
  await render();
  expect(share().props.disabled).toBe(false);
  await act(async () => share().props.onClick());
  expect(state.grant).toHaveBeenCalledOnce();
  expect(state.navigate).toHaveBeenCalledOnce();
});

it("waits for a readiness refresh even when the previous live observation succeeded", async () => {
  const previousWork = view({ sessionId: "previous-session", busy: false, inputs: [] });
  state.work = previousWork;
  await render();
  expect(share().props.disabled).toBe(false);

  state.work = { ...previousWork, isPending: true };
  await render();
  expect(share().props.disabled).toBe(true);
  expect(JSON.stringify(renderer!.toJSON())).toContain("Checking this task's agent session");
  await act(async () => share().props.onClick());
  expect(state.grant).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();

  state.work = view({ sessionId: "refreshed-session", busy: false, inputs: [] });
  await render();
  expect(share().props.disabled).toBe(false);
  await act(async () => share().props.onClick());
  expect(state.grant).toHaveBeenCalledOnce();
  expect(state.navigate).toHaveBeenCalledOnce();
});

it("blocks a stale successful observation when native readiness fails and supports retry", async () => {
  await render();
  state.work = view(
    { sessionId: "old-session", busy: false, inputs: [] },
    "The original session requires recovery.",
  );
  await render();
  expect(share().props.disabled).toBe(true);
  await act(async () => share().props.onClick());
  expect(state.grant).not.toHaveBeenCalled();
  expect(JSON.stringify(renderer!.toJSON())).toContain("The original session requires recovery.");
  const retry = renderer!.root
    .findAllByType("button")
    .find((button) => button.children.includes("Retry"))!;
  await act(async () => retry.props.onClick());
  expect(state.refreshWork).toHaveBeenCalledOnce();
});

it("keeps setup and return controls available when no live desktop host exists", async () => {
  state.grant.mockResolvedValue({
    _tag: "Success",
    value: { enabled: false, message: "Start this thread's session in the desktop app." },
  });
  await render();
  await act(async () => share().props.onClick());
  expect(state.navigate).not.toHaveBeenCalled();
  expect(JSON.stringify(renderer!.toJSON())).toContain(
    "Start this thread's session in the desktop app.",
  );
  expect(share().props.disabled).toBe(false);
  expect(JSON.stringify(renderer!.toJSON())).toContain("Return to ");
});

it("does not steal navigation when a grant completes after the user leaves the workspace", async () => {
  let finish: (result: unknown) => void = () => {};
  state.grant.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await act(async () => {
    share().props.onClick();
  });
  await act(async () => renderer!.unmount());
  renderer = undefined;
  await act(async () => finish({ _tag: "Success", value: { enabled: true } }));
  expect(state.navigate).not.toHaveBeenCalled();
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, createElement, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MeerkatProjectTeam,
  type MeerkatTeamAgent,
  type MeerkatCoordinatorWork,
  type OrchestrationSession,
} from "@t3tools/contracts";
import {
  canObserveMeerkatCoordinator,
  coordinatorWorkTarget,
  shouldPauseMeerkatCoordinatorObservation,
  useMeerkatCoordinatorWork,
} from "./meerkatCoordinatorWork";
import type { EnvironmentQueryView } from "./query";

const state = vi.hoisted(() => ({
  team: null as EnvironmentQueryView<MeerkatProjectTeam> | null,
  work: null as EnvironmentQueryView<MeerkatCoordinatorWork> | null,
  observe: vi.fn(() => "work"),
  refreshWork: vi.fn(),
  refreshTeam: vi.fn(),
}));
vi.mock("./meerkatTeam", () => ({
  meerkatTeamEnvironment: { projectTeam: () => "team" },
  useVisibleTeamRefresh: () => {},
}));
vi.mock("./meerkatControls", () => ({
  meerkatControlsEnvironment: { coordinatorWork: state.observe },
}));
vi.mock("./query", () => ({
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
const target = {
  projectId: ProjectId.make("p"),
  instanceId: ProviderInstanceId.make("native"),
  threadId: ThreadId.make("thread"),
};
const input = { inputId: "input", runId: "run", startedAt: null };
const coordinator: MeerkatTeamAgent = {
  agentRef: "coordinator",
  mobId: "native-thread",
  mobLabel: "Thread",
  mobKind: "thread",
  scopeLabel: "project",
  threadId: target.threadId,
  availability: "unloaded",
  record: {
    identity: "coordinator",
    display_name: "Coordinator",
    runtime_key: "native-thread/ingress",
    runtime_member_id: "ingress",
    visibility: "addressable",
    addressable: false,
    health: "ready",
    labels: {},
  },
};
const team: MeerkatProjectTeam = {
  projectId: target.projectId,
  observation: "loaded_runtimes",
  observedAt: "2026-10-01T00:00:00.000Z",
  projectAgents: [],
  providers: [
    {
      instanceId: target.instanceId,
      label: "Native",
      status: "ready",
      errors: [],
      totalScopeCount: 1,
      unloadedScopeCount: 1,
      loadedMobCount: 0,
      agents: [coordinator],
    },
  ],
};
const withAgents = (...agents: MeerkatTeamAgent[]): MeerkatProjectTeam => ({
  ...team,
  providers: [{ ...team.providers[0]!, agents }],
});
describe("native coordinator control identity", () => {
  it("pauses live controls when successful discovery has no live coordinator", () => {
    expect(shouldPauseMeerkatCoordinatorObservation(target, team)).toBe(true);
    expect(
      shouldPauseMeerkatCoordinatorObservation(target, {
        ...team,
        providers: [{ ...team.providers[0]!, status: "partial", errors: ["Other scope failed"] }],
      }),
    ).toBe(true);
    for (const availability of ["retired", "unknown"] as const)
      expect(
        shouldPauseMeerkatCoordinatorObservation(
          target,
          withAgents({ ...coordinator, availability }),
        ),
      ).toBe(true);
    expect(shouldPauseMeerkatCoordinatorObservation(target, withAgents())).toBe(true);
    expect(
      shouldPauseMeerkatCoordinatorObservation(
        target,
        withAgents(coordinator, { ...coordinator, agentRef: "other-incarnation" }),
      ),
    ).toBe(true);
  });
  it("keeps live, legacy, foreign, and failed discovery observable", () => {
    for (const snapshot of [
      withAgents({ ...coordinator, availability: "live" }),
      withAgents({ ...coordinator, availability: undefined }),
      withAgents(coordinator, {
        ...coordinator,
        availability: "live",
        agentRef: "live-incarnation",
      }),
      { ...team, projectId: ProjectId.make("other-project") },
      {
        ...team,
        providers: [{ ...team.providers[0]!, instanceId: ProviderInstanceId.make("other-native") }],
      },
      { ...team, providers: [{ ...team.providers[0]!, status: "unavailable" as const }] },
      { ...team, providers: [{ ...team.providers[0]!, status: "disabled" as const }] },
    ])
      expect(shouldPauseMeerkatCoordinatorObservation(target, snapshot)).toBe(false);
  });
  it("does not let partial discovery turn an unknown target into confirmed absence", () => {
    const partial = {
      ...team,
      providers: [{ ...team.providers[0]!, status: "partial" as const, agents: [] }],
    };
    expect(shouldPauseMeerkatCoordinatorObservation(target, partial)).toBe(false);
    expect(
      shouldPauseMeerkatCoordinatorObservation(target, {
        ...partial,
        providers: [
          {
            ...partial.providers[0]!,
            agents: [{ ...coordinator, availability: "unknown" }],
          },
        ],
      }),
    ).toBe(false);
  });
  it("waits for native admission but keeps failed and interrupted sessions observable", () => {
    const session: OrchestrationSession = {
      threadId: target.threadId,
      providerInstanceId: target.instanceId,
      providerName: "meerkat",
      status: "starting",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    expect(canObserveMeerkatCoordinator(null)).toBe(false);
    expect(canObserveMeerkatCoordinator(session)).toBe(false);
    expect(
      canObserveMeerkatCoordinator({ ...session, providerName: "codex", status: "ready" }),
    ).toBe(false);
    for (const status of ["running", "ready", "error", "interrupted", "stopped"] as const)
      expect(canObserveMeerkatCoordinator({ ...session, status })).toBe(true);
  });
  it("selects exact session and native run, including multiple contributing inputs", () => {
    expect(
      coordinatorWorkTarget(target, {
        sessionId: "session",
        busy: true,
        inputs: [input, { ...input, inputId: "steer" }],
      }),
    ).toEqual({ ...target, sessionId: "session", inputId: "input", nativeRunId: "run" });
  });
  it("withholds controls for idle, missing or mixed run observations", () => {
    expect(
      coordinatorWorkTarget(target, { sessionId: "s", busy: false, inputs: [input] }),
    ).toBeNull();
    expect(coordinatorWorkTarget(target, { sessionId: "s", busy: true, inputs: [] })).toBeNull();
    expect(
      coordinatorWorkTarget(target, {
        sessionId: "s",
        busy: true,
        inputs: [input, { ...input, runId: "successor" }],
      }),
    ).toBeNull();
    expect(coordinatorWorkTarget(null, { sessionId: "s", busy: true, inputs: [input] })).toBeNull();
  });
});

describe("coordinator observation lifecycle", () => {
  let renderer: ReactTestRenderer | undefined;
  let observed: ReturnType<typeof useMeerkatCoordinatorWork> | undefined;
  const environmentId = EnvironmentId.make("environment");
  const view = <A>(data: A | null, error: string | null = null): EnvironmentQueryView<A> => ({
    data,
    error,
    dataUpdatedAt: data ? 1 : null,
    isPending: !data && !error,
    isSuccess: data !== null && error === null,
    refresh: state.refreshWork,
  });
  function Observer() {
    const next = useMeerkatCoordinatorWork(environmentId, target);
    useEffect(() => {
      observed = next;
    }, [next]);
    return null;
  }
  const render = async () => {
    await act(async () => {
      if (renderer) renderer.update(createElement(Observer));
      else renderer = create(createElement(Observer));
    });
  };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    vi.stubGlobal("window", globalThis);
    vi.useFakeTimers();
    state.observe.mockClear();
    state.refreshWork.mockClear();
    state.refreshTeam.mockClear();
    state.team = view<MeerkatProjectTeam>(null);
    state.work = view({ sessionId: "native-session", busy: false, inputs: [] });
    observed = undefined;
  });
  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits for discovery, pauses unloaded history, and observes live idle peers again on resume", async () => {
    await render();
    state.team = view(team);
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(state.observe).not.toHaveBeenCalled();
    expect(state.refreshWork).not.toHaveBeenCalled();
    expect(observed?.error).toBeNull();
    expect(observed?.data).toBeNull();

    state.team = view(withAgents({ ...coordinator, availability: "live" }));
    await render();
    expect(state.observe).toHaveBeenCalledWith({ environmentId, input: target });
    expect(observed?.data?.sessionId).toBe("native-session");
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(state.refreshWork).toHaveBeenCalledOnce();

    state.team = view(team);
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(state.refreshWork).toHaveBeenCalledOnce();
    expect(observed?.data).toBeNull();
    expect(observed?.control).toBeNull();
  });

  it("does not let stale unloaded discovery hide canonical recovery failures", async () => {
    state.team = view(team, "The native snapshot could not be read.");
    state.work = view<MeerkatCoordinatorWork>(null, "The original session requires recovery.");
    await render();
    expect(state.observe).toHaveBeenCalledWith({ environmentId, input: target });
    expect(observed?.error).toBe("The original session requires recovery.");
    expect(observed?.control).toBeNull();
  });

  it("leaves cold-restored history quiet until a live coordinator appears, preserving live failures", async () => {
    state.work = view<MeerkatCoordinatorWork>(
      null,
      "This conversation is not an unambiguous live native target.",
    );
    for (const snapshot of [
      withAgents(),
      withAgents({ ...coordinator, availability: "unknown" }),
      withAgents(coordinator, { ...coordinator, agentRef: "duplicate" }),
    ]) {
      state.team = { ...view(snapshot), refresh: state.refreshTeam };
      await render();
      expect(observed?.error).toBeNull();
      expect(observed?.data).toBeNull();
      expect(observed?.isDormant).toBe(true);
    }
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(state.observe).not.toHaveBeenCalled();
    expect(state.refreshWork).not.toHaveBeenCalled();
    await act(async () => observed?.refresh());
    expect(state.refreshTeam).toHaveBeenCalledOnce();

    state.team = view(withAgents({ ...coordinator, availability: "live" }));
    await render();
    expect(state.observe).toHaveBeenCalledWith({ environmentId, input: target });
    expect(observed?.isDormant).toBe(false);
    expect(observed?.error).toBe("This conversation is not an unambiguous live native target.");
    expect(observed?.control).toBeNull();
    state.work = view({ sessionId: "resumed-session", busy: true, inputs: [input] });
    await render();
    expect(observed?.error).toBeNull();
    expect(observed?.control?.sessionId).toBe("resumed-session");
  });

  it("keeps ambiguous live target failures visible", async () => {
    state.work = view<MeerkatCoordinatorWork>(null, "More than one live coordinator matched.");
    state.team = view(
      withAgents(
        { ...coordinator, availability: "live" },
        { ...coordinator, availability: "live", agentRef: "duplicate" },
      ),
    );
    await render();
    expect(observed?.error).toBe("More than one live coordinator matched.");
  });
});

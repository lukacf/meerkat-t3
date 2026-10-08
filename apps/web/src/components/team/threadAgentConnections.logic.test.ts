import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MeerkatThreadConnections,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { projectAgentRouteScope } from "../sidebar/meerkatAgentNavigation";
import {
  latestThreadConnections,
  selectableThreadProjectAgents,
  visibleThreadProjectAgents,
} from "./threadAgentConnections.logic";

const base: MeerkatThreadConnections = {
  projectId: ProjectId.make("project"),
  instanceId: ProviderInstanceId.make("meerkat"),
  threadId: ThreadId.make("thread"),
  explicit: true,
  desiredAgentIds: [],
  connections: [],
};

describe("thread project agent navigation", () => {
  it("keeps a native connection visible after solo is requested until it disconnects", () => {
    const state = {
      ...base,
      connections: [
        { agentId: "architect", status: "connected" as const, error: null, snapshot: null },
      ],
    };
    expect(
      visibleThreadProjectAgents(state, [{ agentId: "architect", label: "Architect" }]),
    ).toEqual([{ agentId: "architect", label: "Architect" }]);
    expect(
      visibleThreadProjectAgents(
        { ...state, connections: [{ ...state.connections[0]!, status: "disconnected" }] },
        [],
      ),
    ).toEqual([]);
  });

  it("does not call a thread solo because an archived or missing desired definition is absent", () => {
    expect(visibleThreadProjectAgents({ ...base, desiredAgentIds: ["old-agent"] }, [])).toEqual([
      { agentId: "old-agent", label: "Saved agent" },
    ]);
  });

  it("keeps acknowledged draft selection over a stale observation and accepts newer native state", () => {
    const defaults = { ...base, explicit: false, desiredAgentIds: ["architect"] };
    expect(latestThreadConnections(defaults, 1, { value: base, at: 2 })).toEqual(base);
    expect(latestThreadConnections(defaults, 3, { value: base, at: 2 })).toEqual(defaults);
  });

  it("hides archived agents unless selected, so they can still be disconnected", () => {
    const archived = { agentId: "archived", archived: true };
    const available = { agentId: "available", archived: false };
    expect(selectableThreadProjectAgents([archived], [])).toEqual([]);
    expect(selectableThreadProjectAgents([archived, available], [archived.agentId])).toEqual([
      archived,
      available,
    ]);
  });

  it("finds the selected agent's owning project without a backing thread route", () => {
    const environment = EnvironmentId.make("local");
    expect(projectAgentRouteScope(`/${environment}/agents/architect`, "?project=project")).toEqual({
      environmentId: "local",
      projectId: "project",
    });
    expect(projectAgentRouteScope(`/${environment}/projects/project/agents/new`, "")).toEqual({
      environmentId: "local",
      projectId: "project",
    });
    expect(projectAgentRouteScope(`/${environment}/projects/project/agents/propose`, "")).toEqual({
      environmentId: "local",
      projectId: "project",
    });
    expect(projectAgentRouteScope(`/${environment}/projects/project/start`, "")).toEqual({
      environmentId: "local",
      projectId: "project",
    });
    expect(projectAgentRouteScope(`/${environment}/thread`, "?project=project")).toBeNull();
    expect(projectAgentRouteScope(`/${environment}/agents/architect`, "")).toBeNull();
  });
});

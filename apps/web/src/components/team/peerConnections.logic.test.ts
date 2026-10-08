import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  canConnectPeers,
  latestPeerConnections,
  matchesPeerSearch,
  peerChoicesEmptyMessage,
  visiblePeerConnection,
  type PeerItem,
} from "./peerConnections.logic";

const agent: PeerItem = {
  environmentId: EnvironmentId.make("local"),
  endpoint: {
    kind: "project-agent",
    projectId: ProjectId.make("catalog"),
    instanceId: ProviderInstanceId.make("meerkat"),
    agentId: "architect",
  },
  instanceId: ProviderInstanceId.make("meerkat"),
  label: "Architect",
  projectTitle: "Catalog",
};
const thread: PeerItem = {
  ...agent,
  endpoint: {
    kind: "thread",
    projectId: ProjectId.make("orders"),
    threadId: ThreadId.make("build"),
    instanceId: ProviderInstanceId.make("meerkat"),
  },
  label: "Build orders",
  projectTitle: "Orders",
};

describe("peer connection choices", () => {
  it("allows agents and threads across projects in the same environment", () => {
    expect(canConnectPeers(agent, thread)).toBe(true);
    expect(canConnectPeers(thread, agent)).toBe(true);
  });
  it("rejects self links and disjoint runtime hosts/providers", () => {
    expect(canConnectPeers(agent, { ...agent, label: "Renamed" })).toBe(false);
    expect(canConnectPeers(agent, { ...thread, environmentId: EnvironmentId.make("remote") })).toBe(
      false,
    );
    expect(
      canConnectPeers(thread, {
        ...agent,
        endpoint: { ...agent.endpoint, instanceId: ProviderInstanceId.make("other") },
        instanceId: ProviderInstanceId.make("other"),
      }),
    ).toBe(false);
  });
  it("keeps failed disconnections visible for an explicit retry", () => {
    const edge = {
      edgeId: "edge",
      source: agent.endpoint,
      target: thread.endpoint,
      desired: false,
      status: "error" as const,
      error: "Native unwire failed",
    };
    expect(visiblePeerConnection(edge)).toBe(true);
    expect(visiblePeerConnection({ ...edge, status: "disconnected", error: null })).toBe(false);
    expect(visiblePeerConnection({ ...edge, status: "connected", error: null })).toBe(true);
    expect(visiblePeerConnection({ ...edge, status: "unloaded", error: null })).toBe(true);
  });

  it("searches the project and agent together", () => {
    expect(matchesPeerSearch(agent, "CAT architect")).toBe(true);
    expect(matchesPeerSearch(agent, "orders")).toBe(false);
  });

  it("distinguishes an empty search, no eligible peers and a fully connected roster", () => {
    expect(peerChoicesEmptyMessage("unknown", 6, 2)).toBe(
      "No agents or threads match your search.",
    );
    expect(peerChoicesEmptyMessage("", 0, 0)).toBe(
      "No other agents or threads are available for this connection.",
    );
    expect(peerChoicesEmptyMessage("", 6, 0)).toBe(
      "All available agents and threads are already connected.",
    );
  });

  it("keeps a successful addition visible before polling catches up", () => {
    const before = { endpoint: agent.endpoint, connections: [] };
    const after = {
      endpoint: agent.endpoint,
      connections: [
        {
          edgeId: "edge",
          source: agent.endpoint,
          target: thread.endpoint,
          desired: true,
          status: "connected" as const,
          error: null,
        },
      ],
    };
    const receipt = { value: after, at: 20 };
    expect(latestPeerConnections(before, 10, receipt)).toEqual(after);
    expect(latestPeerConnections(before, 30, receipt)).toEqual(before);
  });
});

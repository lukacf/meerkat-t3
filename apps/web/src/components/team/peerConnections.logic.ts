import type {
  EnvironmentId,
  MeerkatPeerConnection,
  MeerkatPeerConnections,
  ProviderInstanceId,
} from "@t3tools/contracts";

export type PeerEndpoint = import("@t3tools/contracts").MeerkatPeerEndpoint;

export interface PeerItem {
  environmentId: EnvironmentId;
  endpoint: PeerEndpoint;
  label: string;
  projectTitle: string;
  instanceId?: ProviderInstanceId;
}

export function peerEndpointKey(endpoint: PeerEndpoint): string {
  return JSON.stringify([
    endpoint.kind,
    endpoint.projectId,
    endpoint.instanceId,
    endpoint.kind === "thread" ? endpoint.threadId : endpoint.agentId,
  ]);
}

export function canConnectPeers(source: PeerItem, target: PeerItem): boolean {
  if (source.environmentId !== target.environmentId) return false;
  if (peerEndpointKey(source.endpoint) === peerEndpointKey(target.endpoint)) return false;
  const sourceInstance = source.endpoint.instanceId;
  const targetInstance = target.endpoint.instanceId;
  return !sourceInstance || !targetInstance || sourceInstance === targetInstance;
}

export function matchesPeerSearch(item: PeerItem, search: string): boolean {
  const text = `${item.label} ${item.projectTitle} ${item.endpoint.kind}`.toLocaleLowerCase();
  return search
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((term) => text.includes(term));
}

export function visiblePeerConnection(edge: MeerkatPeerConnection): boolean {
  return edge.desired || edge.status !== "disconnected" || Boolean(edge.error);
}

export function latestPeerConnections(
  observation: MeerkatPeerConnections | null,
  observedAt: number | null,
  receipt: { value: MeerkatPeerConnections; at: number } | null,
) {
  return receipt && (observedAt ?? 0) <= receipt.at ? receipt.value : observation;
}

export function peerChoicesEmptyMessage(search: string, eligible: number, available: number) {
  if (search.trim()) return "No agents or threads match your search.";
  if (eligible === 0) return "No other agents or threads are available for this connection.";
  if (available === 0) return "All available agents and threads are already connected.";
  return "No agents or threads match your search.";
}

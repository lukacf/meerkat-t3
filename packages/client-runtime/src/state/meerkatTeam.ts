import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Project observations use the environment transport, independently of chat sessions. */
export function createMeerkatTeamEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const projectTeam = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:meerkat:project-team",
    tag: WS_METHODS.meerkatProjectTeam,
    staleTimeMs: 0,
    idleTtlMs: 0,
  });
  const projectAgents = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:meerkat:project-agents",
    tag: WS_METHODS.meerkatProjectAgents,
    staleTimeMs: 0,
    idleTtlMs: 0,
  });
  const threadConnections = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:meerkat:thread-connections",
    tag: WS_METHODS.meerkatThreadConnections,
    staleTimeMs: 0,
    idleTtlMs: 0,
  });
  const peerConnections = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:meerkat:peer-connections",
    tag: WS_METHODS.meerkatPeerConnections,
    staleTimeMs: 0,
    idleTtlMs: 0,
  });
  const agentQueue = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:meerkat:agent-queue",
    tag: WS_METHODS.meerkatAgentQueue,
    staleTimeMs: 0,
    idleTtlMs: 0,
  });
  return {
    searchConversations: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:meerkat:search-conversations",
      tag: WS_METHODS.meerkatSearchConversations,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    agentQueue,
    agentQueueEnqueue: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:meerkat:agent-queue-enqueue",
      tag: WS_METHODS.meerkatAgentQueueEnqueue,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(
            agentQueue({
              environmentId: target.environmentId,
              input: {
                projectId: target.input.projectId,
                instanceId: target.input.instanceId,
                agentRef: target.input.agentRef,
              },
            }),
          ),
        ),
    }),
    agentQueueEdit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:meerkat:agent-queue-edit",
      tag: WS_METHODS.meerkatAgentQueueEdit,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(
            agentQueue({
              environmentId: target.environmentId,
              input: {
                projectId: target.input.projectId,
                instanceId: target.input.instanceId,
                agentRef: target.input.agentRef,
              },
            }),
          ),
        ),
    }),
    agentQueueMove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:meerkat:agent-queue-move",
      tag: WS_METHODS.meerkatAgentQueueMove,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(
            agentQueue({
              environmentId: target.environmentId,
              input: {
                projectId: target.input.projectId,
                instanceId: target.input.instanceId,
                agentRef: target.input.agentRef,
              },
            }),
          ),
        ),
    }),
    agentQueueCancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:meerkat:agent-queue-cancel",
      tag: WS_METHODS.meerkatAgentQueueCancel,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(
            agentQueue({
              environmentId: target.environmentId,
              input: {
                projectId: target.input.projectId,
                instanceId: target.input.instanceId,
                agentRef: target.input.agentRef,
              },
            }),
          ),
        ),
    }),
    agentQueueRetry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:meerkat:agent-queue-retry",
      tag: WS_METHODS.meerkatAgentQueueRetry,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(
            agentQueue({
              environmentId: target.environmentId,
              input: {
                projectId: target.input.projectId,
                instanceId: target.input.instanceId,
                agentRef: target.input.agentRef,
              },
            }),
          ),
        ),
    }),
    projectAgents,
    threadConnections,
    peerConnections,
    peerConnectionSet: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:meerkat:peer-connection-set",
      tag: WS_METHODS.meerkatPeerConnectionSet,
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          for (const endpoint of [target.input.source, target.input.target]) {
            registry.refresh(
              peerConnections({ environmentId: target.environmentId, input: { endpoint } }),
            );
            if (endpoint.kind === "thread")
              registry.refresh(
                threadConnections({ environmentId: target.environmentId, input: endpoint }),
              );
          }
        }),
    }),
    projectProposal: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:meerkat:project-proposal",
      tag: WS_METHODS.meerkatProjectProposal,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    projectProposalSetup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:meerkat:project-proposal-setup",
      tag: WS_METHODS.meerkatProjectProposalSetup,
    }),
    projectProposalCreate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:meerkat:project-proposal-create",
      tag: WS_METHODS.meerkatProjectProposalCreate,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(
            projectAgents({
              environmentId: target.environmentId,
              input: { projectId: target.input.projectId },
            }),
          ),
        ),
    }),
    projectAgentPrepare: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:meerkat:project-agent-prepare",
      tag: WS_METHODS.meerkatProjectAgentPrepare,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(
            projectAgents({
              environmentId: target.environmentId,
              input: { projectId: target.input.projectId },
            }),
          ),
        ),
    }),
    threadConnectionsSet: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:meerkat:thread-connections-set",
      tag: WS_METHODS.meerkatThreadConnectionsSet,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(
            threadConnections({
              environmentId: target.environmentId,
              input: {
                projectId: target.input.projectId,
                threadId: target.input.threadId,
                instanceId: target.input.instanceId,
              },
            }),
          ),
        ),
    }),
    projectAgentCreate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:meerkat:project-agent-create",
      tag: WS_METHODS.meerkatProjectAgentCreate,
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          registry.refresh(
            projectTeam({
              environmentId: target.environmentId,
              input: { projectId: target.input.projectId },
            }),
          );
          registry.refresh(
            projectAgents({
              environmentId: target.environmentId,
              input: { projectId: target.input.projectId },
            }),
          );
        }),
    }),
    projectAgentUpdate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:meerkat:project-agent-update",
      tag: WS_METHODS.meerkatProjectAgentUpdate,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(
            projectAgents({
              environmentId: target.environmentId,
              input: { projectId: target.input.projectId },
            }),
          ),
        ),
    }),
    projectAgentLifecycle: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:meerkat:project-agent-lifecycle",
      tag: WS_METHODS.meerkatProjectAgentLifecycle,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(
            projectAgents({
              environmentId: target.environmentId,
              input: { projectId: target.input.projectId },
            }),
          ),
        ),
    }),
    agentActivityPage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:meerkat:agent-activity-page",
      tag: WS_METHODS.meerkatAgentActivity,
    }),
    agentSend: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:meerkat:agent-send",
      tag: WS_METHODS.meerkatAgentSend,
    }),
    agentDeliveryReconcile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:meerkat:agent-delivery-reconcile",
      tag: WS_METHODS.meerkatAgentDeliveryReconcile,
    }),
    agentResume: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:meerkat:agent-resume",
      tag: WS_METHODS.meerkatAgentResume,
    }),
    agentStopCrew: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:meerkat:agent-stop-crew",
      tag: WS_METHODS.meerkatAgentStopCrew,
    }),
    agentStop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:meerkat:agent-stop",
      tag: WS_METHODS.meerkatAgentStop,
    }),
    projectTeam,
    agentActivity: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:meerkat:agent-activity",
      tag: WS_METHODS.meerkatAgentActivity,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
  };
}

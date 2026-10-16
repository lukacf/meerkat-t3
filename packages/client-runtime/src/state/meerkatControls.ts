import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createMeerkatControlAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    usageSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "meerkat:usage-snapshot",
      tag: WS_METHODS.meerkatUsageSnapshot,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    approvals: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "meerkat:approvals",
      tag: WS_METHODS.meerkatApprovals,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    decideApproval: createEnvironmentRpcCommand(runtime, {
      label: "meerkat:approval-decide",
      tag: WS_METHODS.meerkatApprovalDecide,
    }),
    checkpointCapture: createEnvironmentRpcCommand(runtime, {
      label: "meerkat:checkpoint-capture",
      tag: WS_METHODS.meerkatCheckpointCapture,
    }),
    checkpoints: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "meerkat:checkpoints",
      tag: WS_METHODS.meerkatCheckpoints,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    checkpointPreview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "meerkat:checkpoint-preview",
      tag: WS_METHODS.meerkatCheckpointPreview,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    checkpointRestore: createEnvironmentRpcCommand(runtime, {
      label: "meerkat:checkpoint-restore",
      tag: WS_METHODS.meerkatCheckpointRestore,
    }),
    coordinatorWork: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "meerkat:coordinator-work",
      tag: WS_METHODS.meerkatCoordinatorWork,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    coordinatorStop: createEnvironmentRpcCommand(runtime, {
      label: "meerkat:coordinator-stop",
      tag: WS_METHODS.meerkatCoordinatorStop,
    }),
    coordinatorSteer: createEnvironmentRpcCommand(runtime, {
      label: "meerkat:coordinator-steer",
      tag: WS_METHODS.meerkatCoordinatorSteer,
    }),
    threadRecovery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "meerkat:thread-recovery",
      tag: WS_METHODS.meerkatThreadRecovery,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    reconnectThread: createEnvironmentRpcCommand(runtime, {
      label: "meerkat:reconnect-thread",
      tag: WS_METHODS.meerkatReconnectThread,
    }),
    recoverThread: createEnvironmentRpcCommand(runtime, {
      label: "meerkat:recover-thread",
      tag: WS_METHODS.meerkatRecoverThread,
    }),
    attention: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "meerkat:attention",
      tag: WS_METHODS.meerkatAttention,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    attentionRead: createEnvironmentRpcCommand(runtime, {
      label: "meerkat:attention-read",
      tag: WS_METHODS.meerkatAttentionRead,
    }),
    questions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "meerkat:questions",
      tag: WS_METHODS.meerkatQuestions,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    answer: createEnvironmentRpcCommand(runtime, {
      label: "meerkat:answer",
      tag: WS_METHODS.meerkatQuestionAnswer,
    }),
    authStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "meerkat:auth-status",
      tag: WS_METHODS.meerkatAuthStatus,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    authAction: createEnvironmentRpcCommand(runtime, {
      label: "meerkat:auth-action",
      tag: WS_METHODS.meerkatAuthAction,
    }),
  };
}

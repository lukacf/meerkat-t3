import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Shared connections use their own scoped RPCs and never request a host workbench. */
export function createSharedWorkspaceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const session = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:shared:session",
    tag: WS_METHODS.sharedWorkspaceSession,
    staleTimeMs: 0,
  });
  const conversation = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:shared:conversation",
    tag: WS_METHODS.sharedSpecialistConversation,
    staleTimeMs: 0,
  });
  const inbox = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:shared:inbox",
    tag: WS_METHODS.sharedInboxRead,
    staleTimeMs: 0,
  });
  const localConnections = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:shared:local-connections",
    tag: WS_METHODS.sharedLocalConnectionList,
    staleTimeMs: 0,
  });
  const localDelegations = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:shared:local-delegations",
    tag: WS_METHODS.sharedLocalDelegationList,
    staleTimeMs: 0,
  });
  return {
    session,
    conversation,
    inbox,
    compositionHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:shared:composition-history",
      tag: WS_METHODS.sharedCompositionHistory,
      staleTimeMs: 0,
    }),
    knowledge: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:shared:knowledge",
      tag: WS_METHODS.sharedKnowledgeSearch,
      staleTimeMs: 0,
    }),
    localConnections,
    localDelegations,
    delegationSession: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:shared:delegation-session",
      tag: WS_METHODS.sharedDelegationSession,
      staleTimeMs: 0,
    }),
    observeDelegationSession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared:observe-delegation-session",
      tag: WS_METHODS.sharedDelegationSession,
    }),
    createLocalConnection: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared:create-local-connection",
      tag: WS_METHODS.sharedLocalConnectionCreate,
      onSettled: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(localConnections({ environmentId: target.environmentId, input: {} })),
        ),
    }),
    cancelLocalConnectionSetup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared:cancel-local-connection-setup",
      tag: WS_METHODS.sharedLocalConnectionCancelSetup,
      onSettled: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(localConnections({ environmentId: target.environmentId, input: {} })),
        ),
    }),
    disconnectLocalConnection: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared:disconnect-local-connection",
      tag: WS_METHODS.sharedLocalConnectionDisconnect,
      onSettled: (target, registry) =>
        Effect.sync(() => {
          registry.refresh(localConnections({ environmentId: target.environmentId, input: {} }));
          registry.refresh(
            localDelegations({ environmentId: target.environmentId, input: target.input }),
          );
        }),
    }),
    enableLocalDelegation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared:enable-local-delegation",
      tag: WS_METHODS.sharedLocalDelegationEnable,
      onSettled: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(
            localDelegations({
              environmentId: target.environmentId,
              input: { connectionId: target.input.connectionId },
            }),
          ),
        ),
    }),
    revokeLocalDelegation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared:revoke-local-delegation",
      tag: WS_METHODS.sharedLocalDelegationRevoke,
    }),
    discover: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:shared:discovery",
      tag: WS_METHODS.sharedSpecialistDiscover,
      staleTimeMs: 0,
    }),
    checkoutRevision: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:shared:local-revision",
      tag: WS_METHODS.sharedCheckoutRevision,
      staleTimeMs: 0,
    }),
    observeCheckoutRevision: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared:observe-local-revision",
      tag: WS_METHODS.sharedCheckoutRevision,
    }),
    previewCheckoutPatch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared:preview-local-patch",
      tag: WS_METHODS.sharedCheckoutPatch,
    }),
    putSnapshot: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared:put-snapshot",
      tag: WS_METHODS.sharedSnapshotPut,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared:configure",
      tag: WS_METHODS.sharedWorkspaceConfigure,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(session({ environmentId: target.environmentId, input: {} })),
        ),
    }),
    registerProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared:register-project",
      tag: WS_METHODS.sharedProjectRegister,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(session({ environmentId: target.environmentId, input: {} })),
        ),
    }),
    registerSpecialist: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared:register-specialist",
      tag: WS_METHODS.sharedSpecialistRegister,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(session({ environmentId: target.environmentId, input: {} })),
        ),
    }),
    join: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared:join",
      tag: WS_METHODS.sharedWorkspaceJoin,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(session({ environmentId: target.environmentId, input: {} })),
        ),
    }),
    attachCheckout: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared:attach-checkout",
      tag: WS_METHODS.sharedCheckoutAttach,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(session({ environmentId: target.environmentId, input: {} })),
        ),
    }),
    putWorkContext: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared:work-context",
      tag: WS_METHODS.sharedWorkContextPut,
    }),
    send: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared:send",
      tag: WS_METHODS.sharedSpecialistSend,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(
            conversation({
              environmentId: target.environmentId,
              input: { specialistId: target.input.specialistId },
            }),
          ),
        ),
    }),
    request: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared:request-outcome",
      tag: WS_METHODS.sharedSpecialistRequest,
    }),
    acknowledgeInbox: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared:read-inbox",
      tag: WS_METHODS.sharedInboxAcknowledge,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(inbox({ environmentId: target.environmentId, input: {} })),
        ),
    }),
  };
}

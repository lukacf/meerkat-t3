import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthSharedReadScope,
  AuthSharedContributeScope,
  AuthSharedAdminScope,
  AuthSharedParticipantScopes,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
} from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("keeps shared participant scopes separate from host settings, files and execution", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.sharedWorkspaceSession)).toBe(AuthSharedReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.sharedSpecialistSend)).toBe(
      AuthSharedContributeScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.sharedSpecialistRegister)).toBe(
      AuthSharedAdminScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.sharedCheckoutRevision)).toBe(
      AuthOrchestrationReadScope,
    );
    for (const method of [
      WS_METHODS.serverGetConfig,
      WS_METHODS.serverGetSettings,
      WS_METHODS.meerkatAuthAction,
      WS_METHODS.meerkatAgentSend,
      WS_METHODS.meerkatAgentStop,
      WS_METHODS.sharedCheckoutRevision,
      WS_METHODS.sharedCheckoutPatch,
    ]) {
      expect([...AuthSharedParticipantScopes]).not.toContain(requiredScopeForRpcMethod(method));
    }
  });
  it("requires shared administration for permanent composition and its retained operation records", () => {
    for (const method of [
      WS_METHODS.sharedCompositionExecute,
      WS_METHODS.sharedCompositionOperation,
    ]) {
      expect(WsRpcGroup.requests.has(method)).toBe(true);
      expect(requiredScopeForRpcMethod(method)).toBe(AuthSharedAdminScope);
      expect([...AuthSharedParticipantScopes]).not.toContain(requiredScopeForRpcMethod(method));
    }
  });
  it("allows participants to read responsibility history without granting composition authority", () => {
    expect(WsRpcGroup.requests.has(WS_METHODS.sharedCompositionHistory)).toBe(true);
    expect(requiredScopeForRpcMethod(WS_METHODS.sharedCompositionHistory)).toBe(
      AuthSharedReadScope,
    );
    expect([...AuthSharedParticipantScopes]).toContain(
      requiredScopeForRpcMethod(WS_METHODS.sharedCompositionHistory),
    );
    expect([...AuthSharedParticipantScopes]).not.toContain(
      requiredScopeForRpcMethod(WS_METHODS.sharedCompositionExecute),
    );
  });
  it("requires operate access for server-composed provider settings", () => {
    expect(WsRpcGroup.requests.has(WS_METHODS.serverUpdateProviderSettings)).toBe(true);
    expect(requiredScopeForRpcMethod(WS_METHODS.serverUpdateProviderSettings)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetSettings)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("allows receipt-only reconciliation with read access without granting native send access", () => {
    expect(WsRpcGroup.requests.has(WS_METHODS.meerkatAgentDeliveryReconcile)).toBe(true);
    expect(requiredScopeForRpcMethod(WS_METHODS.meerkatAgentDeliveryReconcile)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.meerkatAgentSend)).toBe(
      AuthOrchestrationOperateScope,
    );
  });
  it("allows durable queue and attention subscriptions with read access", () => {
    for (const method of [
      WS_METHODS.meerkatAgentQueueSubscribe,
      WS_METHODS.meerkatAttentionSubscribe,
    ]) {
      expect(WsRpcGroup.requests.has(method)).toBe(true);
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
  });
  it("allows snapshot observation with read access and requires operate access to restore files", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.meerkatCheckpoints)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.meerkatCheckpointPreview)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.meerkatCheckpointCapture)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.meerkatCheckpointRestore)).toBe(
      AuthOrchestrationOperateScope,
    );
  });
  it("requires operate access for interrupted work cleanup while status remains read-only", () => {
    expect(WsRpcGroup.requests.has(WS_METHODS.meerkatThreadRecovery)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.meerkatRecoverThread)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.meerkatReconnectThread)).toBe(true);
    expect(requiredScopeForRpcMethod(WS_METHODS.meerkatThreadRecovery)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.meerkatRecoverThread)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.meerkatReconnectThread)).toBe(
      AuthOrchestrationOperateScope,
    );
  });
  it("allows question observation with read scope and requires operate scope to answer", () => {
    expect(WsRpcGroup.requests.has(WS_METHODS.meerkatQuestions)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.meerkatQuestionAnswer)).toBe(true);
    expect(requiredScopeForRpcMethod(WS_METHODS.meerkatQuestions)).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.meerkatQuestionAnswer)).toBe(
      AuthOrchestrationOperateScope,
    );
  });
  it("allows approval observation with read scope and requires operate scope for decisions", () => {
    expect(WsRpcGroup.requests.has(WS_METHODS.meerkatApprovals)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.meerkatApprovalDecide)).toBe(true);
    expect(requiredScopeForRpcMethod(WS_METHODS.meerkatApprovals)).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.meerkatApprovalDecide)).toBe(
      AuthOrchestrationOperateScope,
    );
  });
  it("uses read scope for native Team and activity observations", () => {
    expect(WsRpcGroup.requests.has(WS_METHODS.meerkatUsageSnapshot)).toBe(true);
    expect(requiredScopeForRpcMethod(WS_METHODS.meerkatUsageSnapshot)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.meerkatAttention)).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.meerkatAttentionRead)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.meerkatProjectTeam)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.meerkatAgentActivity)).toBe(
      AuthOrchestrationReadScope,
    );
  });
  it("requires operate scope for native agent lifecycle, delivery and topology mutations", () => {
    for (const method of [
      WS_METHODS.meerkatProjectProposalSetup,
      WS_METHODS.meerkatProjectProposalCreate,
      WS_METHODS.meerkatProjectAgentPrepare,
      WS_METHODS.meerkatProjectAgentCreate,
      WS_METHODS.meerkatProjectAgentUpdate,
      WS_METHODS.meerkatProjectAgentLifecycle,
      WS_METHODS.meerkatAgentSend,
      WS_METHODS.meerkatAgentStop,
      WS_METHODS.meerkatAgentResume,
      WS_METHODS.meerkatAgentStopCrew,
      WS_METHODS.meerkatThreadConnectionsSet,
      WS_METHODS.meerkatPeerConnectionSet,
    ])
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    for (const method of [
      WS_METHODS.meerkatProjectAgents,
      WS_METHODS.meerkatThreadConnections,
      WS_METHODS.meerkatPeerConnections,
      WS_METHODS.meerkatProjectProposal,
    ])
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
  });
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toBe(
      AuthRelayReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toBe(AuthRelayWriteScope);
  });

  it("requires permission to operate on a thread before uploading feedback", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.providerUploadFeedback)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("requires write access to import agent session history", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsScan)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsImport)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("reads the reviewer menu under the same scope as the pull request it belongs to", () => {
    // The candidate list is a read like the detail beside it, and asking somebody for a review is
    // a write like every other pull request operation.
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsReviewerCandidates)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsDetail),
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsRequestReviewers)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsComment),
    );
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});

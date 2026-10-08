import type { EnvironmentId, MeerkatQuestionTarget } from "@t3tools/contracts";
import { useMemo } from "react";
import { meerkatControlsEnvironment } from "../../state/meerkatControls";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { NativeToolApprovals, type NativeToolApprovalApi } from "./NativeToolApprovals";
import { readRestoreReviewWorkBlock, useRestoreReviewWorkBlock } from "./useRestoreReview";

export function MeerkatToolApprovals({
  environmentId,
  target,
  expectedSessionId,
  expectedApprovalId,
}: {
  environmentId: EnvironmentId;
  target: MeerkatQuestionTarget;
  expectedSessionId?: string;
  expectedApprovalId?: string;
}) {
  const list = useAtomQueryRunner(meerkatControlsEnvironment.approvals, {
    reportFailure: false,
    refresh: true,
  });
  const decide = useAtomCommand(meerkatControlsEnvironment.decideApproval, {
    reportFailure: false,
  });
  const { projectId, instanceId, agentRef, threadId } = target;
  const restoreBlock = useRestoreReviewWorkBlock(environmentId);
  const api = useMemo<NativeToolApprovalApi>(() => {
    const input = {
      projectId,
      instanceId,
      ...(agentRef ? { agentRef } : {}),
      ...(threadId ? { threadId } : {}),
    };
    return {
      list: async () => {
        const result = await list({ environmentId, input });
        if (result._tag === "Failure") throw Error(formatEnvironmentQueryError(result.cause));
        if (
          expectedSessionId &&
          result.value.approvals.some((row) => row.record.owner.session_id !== expectedSessionId)
        ) {
          throw Error(
            "This approval belongs to a previous native session. Open its saved conversation.",
          );
        }
        return {
          approvals: result.value.approvals.filter(
            (row) => !expectedApprovalId || row.record.approval_id === expectedApprovalId,
          ),
        };
      },
      decide: async (decision) => {
        const restoreBlock = readRestoreReviewWorkBlock(environmentId);
        if (restoreBlock) throw Error(restoreBlock);
        if (
          (expectedSessionId && decision.sessionId !== expectedSessionId) ||
          (expectedApprovalId && decision.approvalId !== expectedApprovalId)
        ) {
          throw Error("This decision does not belong to the selected native approval.");
        }
        const result = await decide({ environmentId, input: { ...input, ...decision } });
        if (result._tag === "Failure") throw Error(formatEnvironmentQueryError(result.cause));
        return result.value;
      },
    };
  }, [
    environmentId,
    projectId,
    instanceId,
    agentRef,
    threadId,
    list,
    decide,
    expectedSessionId,
    expectedApprovalId,
  ]);
  return (
    <NativeToolApprovals
      api={api}
      disabledReason={restoreBlock}
      targetKey={`${environmentId}:${projectId}:${instanceId}:${agentRef ?? threadId}:${expectedSessionId ?? ""}:${expectedApprovalId ?? ""}`}
    />
  );
}

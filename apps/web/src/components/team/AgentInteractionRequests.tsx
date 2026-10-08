import type {
  EnvironmentId,
  MeerkatQuestionTarget,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { meerkatControlsEnvironment } from "../../state/meerkatControls";
import { useVisibleTeamRefresh } from "../../state/meerkatTeam";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentQuestionCard } from "./AgentQuestionCard";
import { readRestoreReviewWorkBlock, useRestoreReviewWorkBlock } from "./useRestoreReview";

type Scope = { environmentId: EnvironmentId; projectId: ProjectId; instanceId: ProviderInstanceId };
function InteractionRequests({
  environmentId,
  ...target
}: Scope & Pick<MeerkatQuestionTarget, "agentRef" | "threadId">) {
  const query = useEnvironmentQuery(
    meerkatControlsEnvironment.questions({ environmentId, input: target }),
  );
  useVisibleTeamRefresh(query, true);
  const answer = useAtomCommand(meerkatControlsEnvironment.answer, { reportFailure: false });
  const restoreBlock = useRestoreReviewWorkBlock(environmentId);
  return (
    <div aria-live="polite" className="max-h-32 space-y-2 overflow-y-auto px-3 empty:hidden">
      {query.error ? (
        <p role="alert" className="py-2 text-xs text-destructive">
          Could not check for questions: {query.error}{" "}
          <button type="button" className="underline" onClick={query.refresh}>
            Retry
          </button>
        </p>
      ) : null}
      {query.data?.requests.map((request) => (
        <AgentQuestionCard
          key={request.requestId}
          request={request}
          draftScope={{ environmentId, projectId: target.projectId, instanceId: target.instanceId }}
          disabledReason={restoreBlock}
          onAnswer={async (answers, dismissed) => {
            const currentBlock = readRestoreReviewWorkBlock(environmentId);
            if (currentBlock) return currentBlock;
            const result = await answer({
              environmentId,
              input: {
                ...target,
                requestId: request.requestId,
                sessionId: request.sessionId,
                answers,
                dismissed,
              },
            });
            query.refresh();
            return result._tag === "Failure"
              ? formatEnvironmentQueryError(result.cause)
              : result.value.accepted && result.value.requestId === request.requestId
                ? null
                : "The agent did not confirm this answer. Your draft has been kept. Refresh the question before retrying.";
          }}
        />
      ))}
    </div>
  );
}
export function AgentInteractionRequests(props: Scope & { agentRef: string }) {
  return <InteractionRequests {...props} />;
}
export function ThreadInteractionRequests(props: Scope & { threadId: ThreadId }) {
  return <InteractionRequests {...props} />;
}

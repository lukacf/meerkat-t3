import type {
  EnvironmentId,
  MeerkatTeamAgent,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useState } from "react";
import { formatEnvironmentQueryError } from "../../state/query";
import { meerkatTeamEnvironment } from "../../state/meerkatTeam";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { readRestoreReviewWorkBlock, useRestoreReviewWorkBlock } from "./useRestoreReview";

export function MeerkatResumeAgentButton({
  environmentId,
  projectId,
  instanceId,
  agent,
  onResumed,
  disabled = false,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  instanceId: ProviderInstanceId;
  agent: MeerkatTeamAgent;
  onResumed: () => void;
  disabled?: boolean;
}) {
  const resume = useAtomCommand(meerkatTeamEnvironment.agentResume, { reportFailure: false });
  const stopCrew = useAtomCommand(meerkatTeamEnvironment.agentStopCrew, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restoreBlock = useRestoreReviewWorkBlock(environmentId);
  if (!agent.record.labels.source_mob_id) return null;
  const running =
    (agent.availability === undefined || agent.availability === "live") &&
    agent.record.addressable &&
    agent.record.visibility === "addressable" &&
    !agent.canResume;
  if (!running && !agent.canResume) return null;
  const failureMessage = running
    ? "This crew could not stop. Refresh its owning conversation and retry."
    : "This crew could not resume. Its existing conversation remains available.";
  const label = running ? "Stop crew" : "Resume crew";
  const pendingLabel = running ? "Stopping crew..." : "Resuming crew...";
  return (
    <span className="flex flex-col items-start gap-1">
      <Button
        size="xs"
        variant="outline"
        disabled={disabled || pending || (!running && restoreBlock !== null)}
        title={
          !running && restoreBlock
            ? restoreBlock
            : running
              ? "Stop every worker in this crew. Conversation history is kept."
              : "Resume the whole stopped crew with its existing conversations."
        }
        onClick={() => {
          const currentBlock = running ? null : readRestoreReviewWorkBlock(environmentId);
          if (currentBlock) {
            setError(currentBlock);
            return;
          }
          setPending(true);
          setError(null);
          const command = running ? stopCrew : resume;
          void command({
            environmentId,
            input: { projectId, instanceId, agentRef: agent.agentRef },
          })
            .then((result) => {
              if (result._tag === "Success") onResumed();
              else setError(`${failureMessage} ${formatEnvironmentQueryError(result.cause)}`);
            })
            .catch(() => setError(failureMessage))
            .finally(() => setPending(false));
        }}
      >
        {pending ? pendingLabel : label}
      </Button>
      {error ? (
        <span className="max-w-xs text-2xs text-destructive" role="status">
          {error}
        </span>
      ) : null}
    </span>
  );
}

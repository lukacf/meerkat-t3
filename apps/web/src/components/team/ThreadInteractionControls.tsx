import type {
  EnvironmentId,
  MeerkatCoordinatorTarget,
  MeerkatCoordinatorWork,
} from "@t3tools/contracts";
import type { EnvironmentQueryView } from "../../state/query";
import { ThreadInteractionRequests } from "./AgentInteractionRequests";
import { MeerkatToolApprovals } from "./MeerkatToolApprovals";

/** Coordinator work resolves the canonical native target before either control can poll it. */
export function ThreadInteractionControls({
  environmentId,
  observation,
  resumeBySending = true,
  ...target
}: MeerkatCoordinatorTarget & {
  environmentId: EnvironmentId;
  observation: EnvironmentQueryView<MeerkatCoordinatorWork> & { isDormant?: boolean };
  resumeBySending?: boolean;
}) {
  if (observation.error) {
    return (
      <p role="alert" className="px-4 py-2 text-xs text-destructive">
        Could not check agent requests: {observation.error}{" "}
        <button type="button" className="underline" onClick={observation.refresh}>
          Retry
        </button>
      </p>
    );
  }
  if (observation.isDormant) {
    return resumeBySending ? (
      <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
        Send a message to resume this conversation.
      </p>
    ) : null;
  }
  if (!observation.data) return null;
  return (
    <>
      <ThreadInteractionRequests
        key={observation.data.sessionId}
        environmentId={environmentId}
        {...target}
      />
      <MeerkatToolApprovals
        environmentId={environmentId}
        target={target}
        expectedSessionId={observation.data.sessionId}
      />
    </>
  );
}

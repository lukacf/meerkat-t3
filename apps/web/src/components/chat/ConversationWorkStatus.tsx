import type { OrchestrationLatestTurn, TurnId } from "@t3tools/contracts";
import { useState } from "react";

interface ConversationWorkStatusProps {
  scopeKey: string;
  enabled: boolean;
  latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "state"> | null;
  isWorking: boolean;
}

interface Observation {
  scopeKey: string;
  enabled: boolean;
  turnId: TurnId | null;
  turnState: OrchestrationLatestTurn["state"] | null;
  working: boolean;
}

interface AnnouncementState {
  observation: Observation;
  pendingTurnId: TurnId | null;
  message: string;
}

function baseline(observation: Observation): AnnouncementState {
  return {
    observation,
    pendingTurnId: observation.turnState === "running" ? observation.turnId : null,
    message: "",
  };
}

function sameObservation(previous: Observation, next: Observation) {
  return (
    previous.scopeKey === next.scopeKey &&
    previous.enabled === next.enabled &&
    previous.turnId === next.turnId &&
    previous.turnState === next.turnState &&
    previous.working === next.working
  );
}

function observe(previous: AnnouncementState, next: Observation): AnnouncementState {
  if (
    next.scopeKey !== previous.observation.scopeKey ||
    !next.enabled ||
    !previous.observation.enabled
  ) {
    return baseline(next);
  }

  const pendingTurnId =
    next.turnId !== previous.observation.turnId || next.turnState === "running"
      ? next.turnId
      : previous.pendingTurnId;

  if (next.working) {
    return { observation: next, pendingTurnId, message: "Working" };
  }
  if (next.turnId !== null && pendingTurnId === next.turnId) {
    const message =
      next.turnState === "completed"
        ? "Response complete"
        : next.turnState === "error"
          ? "Response failed"
          : next.turnState === "interrupted"
            ? "Response interrupted"
            : "";
    return { observation: next, pendingTurnId: null, message };
  }
  return {
    observation: next,
    pendingTurnId,
    message: previous.observation.working || next.turnId === null ? "" : previous.message,
  };
}

/** Announce observed work, not old outcomes loaded with a conversation. */
export function ConversationWorkStatus({
  scopeKey,
  enabled,
  latestTurn,
  isWorking,
}: ConversationWorkStatusProps) {
  const observation: Observation = {
    scopeKey,
    enabled,
    turnId: latestTurn?.turnId ?? null,
    turnState: latestTurn?.state ?? null,
    working: isWorking || latestTurn?.state === "running",
  };
  const [state, setState] = useState(() => baseline(observation));
  // Compare only lifecycle fields. Streamed text and duration ticks must not
  // replace this node or repeat its announcement. A scope reset is synchronous
  // so another conversation cannot briefly render the previous outcome.
  let current = state;
  if (!sameObservation(state.observation, observation)) {
    current = observe(state, observation);
    setState(current);
  }
  return (
    <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {/* A fast new turn can have the same outcome text without an observed
          running snapshot. Replace only its content, never the live region. */}
      <span key={current.observation.turnId}>{current.message}</span>
    </span>
  );
}

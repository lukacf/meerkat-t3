import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { meerkatTeamEnvironment } from "../../state/meerkatTeam";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { readRestoreReviewWorkBlock } from "./useRestoreReview";
import {
  createProjectAgentCreationDraftStore,
  projectAgentCreationScopeKey,
  type CreatedProjectAgent,
  type ProjectAgentCreationAttempt,
  type ProjectAgentCreationScope,
} from "./projectAgentCreationDraftStore";

export function useProjectAgentCreation(
  scope: ProjectAgentCreationScope,
  onCreated: (agent: CreatedProjectAgent) => void,
) {
  const key = projectAgentCreationScopeKey(scope);
  const store = useMemo(
    () =>
      createProjectAgentCreationDraftStore({
        environmentId: scope.environmentId,
        projectId: scope.projectId,
        cwd: scope.cwd,
      }),
    [scope.environmentId, scope.projectId, scope.cwd],
  );
  const state = useStore(store);
  const create = useAtomCommand(meerkatTeamEnvironment.projectAgentCreate, {
    reportFailure: false,
  });
  const [localError, setLocalError] = useState<{ key: string; message: string } | null>(null);
  const active = useRef<typeof store | null>(store);
  active.current = store;
  useEffect(() => {
    active.current = store;
    const refresh = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(key)) store.getState().refresh();
    };
    globalThis.addEventListener?.("storage", refresh);
    return () => {
      if (active.current === store) active.current = null;
      globalThis.removeEventListener?.("storage", refresh);
    };
  }, [key, store]);
  const showError = (message: string) => setLocalError({ key, message });
  const dispatch = async (attempt: ProjectAgentCreationAttempt | null) => {
    if (!attempt) return;
    const requestId = attempt.input.requestId;
    let error: string | undefined;
    try {
      if (active.current !== store) {
        error = "This project setup is no longer active. Reopen it to retry the saved request.";
        return;
      }
      if (attempt.accepted) {
        if (active.current === store) onCreated(attempt.accepted);
        return;
      }
      const block = readRestoreReviewWorkBlock(scope.environmentId);
      if (block) {
        error = block;
        return;
      }
      setLocalError(null);
      const result = await create({ environmentId: scope.environmentId, input: attempt.input });
      if (result._tag === "Failure") error = formatEnvironmentQueryError(result.cause);
      else if (store.getState().accept(requestId, result.value) && active.current === store)
        onCreated(result.value);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The creation response was interrupted.";
    } finally {
      // The old target's receipt is still saved after navigation, but cannot redirect its new owner.
      store.getState().finish(requestId, error);
    }
  };
  return {
    state,
    store,
    dispatch,
    showError,
    error: state.error ?? (localError?.key === key ? localError.message : null),
    retry: (requestId: string) => dispatch(store.getState().retry(requestId)),
  };
}

export function ProjectAgentCreationRecovery({
  attempts,
  pendingIds,
  restoreBlock,
  onRetry,
}: {
  attempts: ReadonlyArray<ProjectAgentCreationAttempt>;
  pendingIds: ReadonlyArray<string>;
  restoreBlock: string | null;
  onRetry: (requestId: string) => void;
}) {
  if (!attempts.length) return null;
  return (
    <details
      className="rounded-lg border border-border p-3"
      open={attempts.some((attempt) => !attempt.accepted)}
    >
      <summary className="cursor-pointer text-sm font-medium">
        Saved creation requests ({attempts.length})
      </summary>
      <div className="mt-3 space-y-4">
        {attempts.map((attempt) => (
          <div key={attempt.input.requestId} className="space-y-2 text-sm">
            <p className="font-medium">
              {attempt.input.label} -{" "}
              {attempt.accepted
                ? "Created"
                : pendingIds.includes(attempt.input.requestId)
                  ? "Request in progress"
                  : "Confirmation pending"}
            </p>
            <p className="text-xs text-muted-foreground">
              {attempt.accepted
                ? "The saved receipt opens the same agent without reconnecting it."
                : pendingIds.includes(attempt.input.requestId)
                  ? "Waiting for the server to confirm this request. Your settings are saved."
                  : "The response may have been lost. Retry the original request to recover its result, or create it if it was not accepted."}
            </p>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Original settings and request ID</summary>
              <dl className="mt-2 space-y-1 break-all">
                <div>
                  <dt className="inline font-medium">Request: </dt>
                  <dd className="inline">{attempt.input.requestId}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">Provider: </dt>
                  <dd className="inline">{attempt.input.instanceId}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">Model: </dt>
                  <dd className="inline">{attempt.input.model}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">Reasoning level: </dt>
                  <dd className="inline">
                    {attempt.input.options
                      ?.filter(
                        (option) =>
                          option.id !== "prompt_cache_enabled" && option.value !== "default",
                      )
                      .map((option) => String(option.value))
                      .join(", ") || "Model default"}
                  </dd>
                </div>
                <div>
                  <dt className="inline font-medium">Access: </dt>
                  <dd className="inline">{attempt.input.accessMode}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">Role: </dt>
                  <dd className="inline">{attempt.input.role}</dd>
                </div>
                <div>
                  <dt className="font-medium">Instructions</dt>
                  <dd className="whitespace-pre-wrap">{attempt.input.instructions}</dd>
                </div>
                {attempt.accepted && (
                  <div>
                    <dt className="inline font-medium">Agent: </dt>
                    <dd className="inline">{attempt.accepted.agentId}</dd>
                  </div>
                )}
              </dl>
            </details>
            {attempt.error &&
              !attempt.accepted &&
              !pendingIds.includes(attempt.input.requestId) && (
                <p className="text-xs text-warning-foreground">{attempt.error}</p>
              )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                pendingIds.includes(attempt.input.requestId) ||
                (!attempt.accepted && restoreBlock !== null)
              }
              title={!attempt.accepted ? (restoreBlock ?? undefined) : undefined}
              onClick={() => onRetry(attempt.input.requestId)}
            >
              {pendingIds.includes(attempt.input.requestId)
                ? "Waiting for response..."
                : attempt.accepted
                  ? "Open created agent"
                  : "Retry same request"}
            </Button>
          </div>
        ))}
      </div>
    </details>
  );
}

import type { ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { persistClientSettingsUpdate, useClientSettings } from "../../hooks/useSettings";
import { useCompleteOnboarding } from "../../onboarding/firstRun";
import {
  hasSuccessfulFirstReply,
  isFirstTaskLocation,
  isOnboardingTask,
  type FirstTaskEvidence,
} from "../../onboarding/firstTask.logic";
import { Button } from "../ui/button";
import { useThreadShells } from "../../state/entities";
import { useBackgroundDraftSubmissionPending } from "../../composerDraftStore";

export function FirstTaskGuide(
  props: FirstTaskEvidence & { readonly threadId: ThreadId | null; readonly isDraft: boolean },
) {
  const progress = useClientSettings((settings) => settings.onboardingProgress);
  const complete = useCompleteOnboarding();
  const threads = useThreadShells();
  const trackedSubmissionPending = useBackgroundDraftSubmissionPending(
    progress?.projectRef && progress.threadId
      ? scopeThreadRef(progress.projectRef.environmentId, progress.threadId)
      : null,
  );
  const trackedThreadExists =
    progress?.threadId !== null &&
    threads.some(
      (thread) =>
        thread.environmentId === progress?.projectRef?.environmentId &&
        thread.id === progress?.threadId,
    );
  const navigate = useNavigate();
  const saving = useRef(false);
  const [error, setError] = useState<"progress" | "skip" | "replace" | null>(null);
  const [retry, setRetry] = useState(0);
  const evidenceRef = useRef(props);
  evidenceRef.current = props;
  const succeeded = progress !== null && hasSuccessfulFirstReply(progress, props);
  const needsThread =
    props.isDraft &&
    progress?.step === "first-task" &&
    progress.projectRef?.environmentId === props.environmentId &&
    progress.projectRef?.projectId === props.projectId &&
    progress.threadId === null;
  useEffect(() => {
    if (!progress || !props.threadId || (!succeeded && !needsThread) || saving.current || error)
      return;
    saving.current = true;
    void persistClientSettingsUpdate((current) => {
      const active = current.onboardingProgress;
      if (!active || active.step !== "first-task" || active.startedAt !== progress.startedAt)
        return current;
      if (needsThread) {
        // A background submission opens another draft before its server shell arrives.
        // Claim once, including when a competing pane's save was already queued.
        return active.threadId === null &&
          active.projectRef?.environmentId === props.environmentId &&
          active.projectRef?.projectId === props.projectId
          ? { ...current, onboardingProgress: { ...active, threadId: props.threadId } }
          : current;
      }
      if (!isOnboardingTask(active, evidenceRef.current)) return current;
      return hasSuccessfulFirstReply(active, evidenceRef.current)
        ? { ...current, onboardingProgress: null, onboardingCompletedAt: new Date().toISOString() }
        : { ...current, onboardingProgress: { ...active, threadId: props.threadId } };
    })
      .then(() => setError(null))
      .catch(() => setError("progress"))
      .finally(() => {
        saving.current = false;
        setRetry((value) => value + 1);
      });
  }, [
    error,
    needsThread,
    progress,
    props.environmentId,
    props.projectId,
    props.threadId,
    retry,
    succeeded,
  ]);
  if (
    progress?.step !== "first-task" ||
    !progress.projectRef ||
    progress.projectRef?.environmentId !== props.environmentId ||
    progress.projectRef?.projectId !== props.projectId
  )
    return null;
  const projectRef = progress.projectRef;
  const otherTask = !needsThread && !isFirstTaskLocation(progress, props);
  const chooseNewFirstTask = async () => {
    if (trackedSubmissionPending) return;
    try {
      const saved = await persistClientSettingsUpdate((current) => {
        const active = current.onboardingProgress;
        return active?.step === "first-task" &&
          active.startedAt === progress.startedAt &&
          active.threadId === progress.threadId &&
          active.projectRef?.environmentId === projectRef.environmentId &&
          active.projectRef?.projectId === projectRef.projectId
          ? { ...current, onboardingProgress: { ...active, threadId: null } }
          : current;
      });
      setError(null);
      if (saved.onboardingProgress?.threadId === null)
        void navigate({
          to: "/$environmentId/projects/$projectId/start",
          params: projectRef,
        });
    } catch {
      setError("replace");
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium">{otherTask ? "Finish your setup" : "Your first task"}</p>
        <p className="text-xs text-muted-foreground" role="status">
          {otherTask
            ? "Setup follows your first task. Return to it to finish with a successful reply."
            : succeeded
              ? error
                ? "Your first reply arrived."
                : "Your first reply arrived. Saving setup..."
              : props.latestTurn?.state === "running"
                ? "Your first task is running. Setup finishes when its reply arrives."
                : props.latestTurn?.state === "error" || props.latestTurn?.state === "interrupted"
                  ? "This task has not finished successfully. Resolve the issue shown below, then continue this conversation to finish setup."
                  : "Choose a model below and ask: Explain this project and suggest a small first task. Setup finishes when a reply arrives."}
        </p>
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error === "skip"
              ? "Could not skip setup. Try again."
              : "Could not save setup progress. Try again."}
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap gap-1">
        {otherTask ? (
          <Button
            size="xs"
            variant="outline"
            disabled={trackedSubmissionPending}
            onClick={() => {
              if (trackedThreadExists && progress.threadId) {
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId: projectRef.environmentId, threadId: progress.threadId },
                });
              } else {
                // Absence from the local shells is not proof of deletion.
                // Replacing the selected task is an explicit user choice.
                void chooseNewFirstTask();
              }
            }}
          >
            {trackedSubmissionPending
              ? "Starting first task..."
              : trackedThreadExists
                ? "Open first task"
                : "Choose a new first task"}
          </Button>
        ) : null}
        {error ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              if (error === "skip") {
                void complete().catch(() => setError("skip"));
              } else if (error === "replace") {
                void chooseNewFirstTask();
              } else {
                setError(null);
                setRetry((value) => value + 1);
              }
            }}
          >
            {error === "skip" ? "Retry skipping setup" : "Retry saving setup"}
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" onClick={() => void navigate({ to: "/welcome" })}>
          Back to setup
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void complete().catch(() => setError("skip"))}
        >
          Skip setup
        </Button>
      </div>
    </div>
  );
}

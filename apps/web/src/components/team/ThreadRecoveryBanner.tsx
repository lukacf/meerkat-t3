import { useEffect, useRef, useState } from "react";
import { AlertTriangleIcon, LoaderCircleIcon } from "lucide-react";
import type { EnvironmentId, MeerkatThreadRecoveryTarget } from "@t3tools/contracts";
import { meerkatControlsEnvironment } from "../../state/meerkatControls";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { readRestoreReviewWorkBlock, useRestoreReviewWorkBlock } from "./useRestoreReview";

type Props = MeerkatThreadRecoveryTarget & {
  environmentId: EnvironmentId;
  onRecovered?: () => void;
  onReconnect?: () => void;
  onStartNewTask?: () => Promise<unknown>;
};

export function ThreadRecoveryBanner(props: Props) {
  return (
    <ScopedThreadRecoveryBanner
      key={JSON.stringify([props.environmentId, props.projectId, props.threadId, props.instanceId])}
      {...props}
    />
  );
}
function ScopedThreadRecoveryBanner({
  environmentId,
  onRecovered,
  onReconnect,
  onStartNewTask,
  ...target
}: Props) {
  const query = useEnvironmentQuery(
    meerkatControlsEnvironment.threadRecovery({ environmentId, input: target }),
  );
  const recover = useAtomCommand(meerkatControlsEnvironment.recoverThread, {
    reportFailure: false,
  });
  const reconnect = useAtomCommand(meerkatControlsEnvironment.reconnectThread, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovered, setRecovered] = useState(false);
  const mounted = useRef(true);
  const startingNewTask = useRef(false);
  const restoreBlock = useRestoreReviewWorkBlock(environmentId);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const state = query.data;
  if (!query.error && !state)
    return (
      <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
        Checking the interrupted operation...
      </p>
    );
  if (!query.error && state?.status === "none") return null;
  const stop = async () => {
    if (!state?.runId || pending) return;
    const currentBlock = readRestoreReviewWorkBlock(environmentId);
    if (currentBlock) {
      setError(currentBlock);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await recover({ environmentId, input: { ...target, runId: state.runId } });
      if (!mounted.current) return;
      if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
      else {
        setRecovered(true);
        onRecovered?.();
      }
      query.refresh();
    } catch (cause) {
      if (!mounted.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Cleanup could not be confirmed. Refresh to check the original operation.",
      );
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  const reconnectOriginal = async () => {
    if (!state?.runId || pending) return;
    const currentBlock = readRestoreReviewWorkBlock(environmentId);
    if (currentBlock) {
      setError(currentBlock);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await reconnect({ environmentId, input: { ...target, runId: state.runId } });
      if (!mounted.current) return;
      if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
      else onReconnect?.();
      query.refresh();
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "Could not reconnect the original operation.",
        );
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  const startNewTask = async () => {
    if (!onStartNewTask || pending || startingNewTask.current) return;
    startingNewTask.current = true;
    setPending(true);
    setError(null);
    try {
      await onStartNewTask();
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "Could not open a new task.");
    } finally {
      startingNewTask.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const canStartNewTask = !query.error && state?.status === "unavailable" && onStartNewTask;
  const title = query.error
    ? "Could not check interrupted work"
    : recovered || state?.status === "recovered"
      ? "Interrupted work stopped"
      : state?.status === "running"
        ? "The original operation is still running"
        : state?.status === "settled"
          ? "The original operation has finished"
          : "Interrupted work needs attention";
  return (
    <section
      aria-label="Interrupted work"
      aria-live="polite"
      className="mx-3 my-2 flex min-w-0 gap-3 rounded-xl border border-warning/25 bg-warning-surface px-3 py-3"
    >
      <AlertTriangleIcon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-warning-foreground"
      />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {query.error ??
            (recovered
              ? "Your saved conversation is preserved. The previous outcome remains unknown; review external effects before continuing."
              : state?.status === "settled"
                ? "The previous request has finished. Reconnect to continue this conversation."
                : state?.message)}
        </p>
        {canStartNewTask ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            This conversation will be preserved. Starting a new task does not stop or retry the
            interrupted operation; its outcome remains unknown.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {canStartNewTask ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void startNewTask()}
            >
              {pending ? "Opening new task..." : "Start a new task"}
            </Button>
          ) : null}
          {!query.error &&
          !recovered &&
          state?.runId &&
          (state.canRecover || state.status === "recovered") ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending || restoreBlock !== null}
              title={restoreBlock ?? undefined}
              onClick={() => void stop()}
            >
              {pending ? (
                <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              {pending
                ? "Stopping interrupted work..."
                : state.status === "recovered"
                  ? "Continue conversation"
                  : "Stop interrupted work"}
            </Button>
          ) : null}
          {!query.error && (state?.status === "running" || state?.status === "settled") ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending || restoreBlock !== null}
              title={restoreBlock ?? undefined}
              onClick={() => void reconnectOriginal()}
            >
              Reconnect
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" disabled={pending} onClick={query.refresh}>
            Refresh status
          </Button>
        </div>
      </div>
    </section>
  );
}

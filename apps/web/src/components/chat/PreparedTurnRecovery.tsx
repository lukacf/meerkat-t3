import type { ThreadPreparedTurn } from "@t3tools/contracts";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../ui/button";

export function preparedTurnBlocksSend(prepared: ThreadPreparedTurn | null | undefined): boolean {
  return prepared != null && prepared.phase !== "released";
}

export function preparedTurnNeedsSetupAcknowledgement(prepared: ThreadPreparedTurn): boolean {
  return prepared.setup === "not_started" || prepared.setup === "sync_running";
}

export function preparedTurnCanEdit(prepared: ThreadPreparedTurn): boolean {
  return (
    prepared.phase === "released" ||
    prepared.phase === "blocked" ||
    (prepared.phase === "preparing" && Boolean(prepared.reason))
  );
}

interface Props {
  prepared: ThreadPreparedTurn;
  disabledReason: string | null;
  setupActive: boolean;
  hasDraft: boolean;
  onAccounts: (() => void) | null;
  onRetry: (continueAfterInterruptedSetup: boolean) => Promise<void>;
  onEdit: () => Promise<void>;
}

/** The parent keys this card by environment, thread and immutable recovery ID. */
export function PreparedTurnRecovery(props: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const active = useRef(false);
  const running = useRef(false);
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const run = async (action: "retry" | "edit") => {
    const current = latest.current;
    if (!active.current || running.current || current.disabledReason) return;
    if (current.setupActive && (action === "edit" || current.prepared.setup !== "async_running"))
      return;
    if (
      action === "retry" &&
      (current.prepared.phase !== "blocked" ||
        !current.prepared.expectedCwd ||
        (preparedTurnNeedsSetupAcknowledgement(current.prepared) && !acknowledged))
    )
      return;
    if (action === "edit" && (current.hasDraft || !preparedTurnCanEdit(current.prepared))) return;
    running.current = true;
    setPending(true);
    setError(null);
    try {
      if (action === "retry") await current.onRetry(acknowledged);
      else await current.onEdit();
    } catch (cause) {
      if (active.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not recover the saved message. It remains available here.",
        );
    } finally {
      running.current = false;
      if (active.current) setPending(false);
    }
  };
  const released = props.prepared.phase === "released";
  const disabled = pending || props.disabledReason !== null;
  const retryDisabled = disabled || (props.setupActive && props.prepared.setup !== "async_running");
  return (
    <section
      aria-label="Saved message recovery"
      className="mx-auto my-3 w-full max-w-3xl rounded-lg border border-border bg-card p-4 text-sm"
    >
      <p className="font-medium">
        {released
          ? "Original message available"
          : props.setupActive ||
              props.prepared.phase === "ready" ||
              (props.prepared.phase === "preparing" && !props.prepared.reason)
            ? "Preparing your checkout"
            : "Message saved, waiting to start"}
      </p>
      <p className="mt-1 text-muted-foreground">
        {released
          ? "The original request was released for editing. Its saved message remains available until you send a replacement."
          : "This thread keeps your original message and checkout. Retrying uses the saved request without creating another checkout or rerunning setup."}
      </p>
      {props.prepared.expectedCwd ? (
        <p className="mt-2 break-all font-mono text-xs">{props.prepared.expectedCwd}</p>
      ) : null}
      {props.prepared.reason && !released ? (
        <p className="mt-2 text-muted-foreground">{props.prepared.reason}</p>
      ) : null}
      {!released &&
      !props.setupActive &&
      props.prepared.phase !== "preparing" &&
      preparedTurnNeedsSetupAcknowledgement(props.prepared) ? (
        <label className="mt-3 flex items-start gap-2">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={retryDisabled}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>
            Continue without rerunning setup. I have checked the checkout after setup stopped or did
            not finish.
          </span>
        </label>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {props.onAccounts ? (
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => {
              if (!active.current || running.current) return;
              try {
                latest.current.onAccounts?.();
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "This saved checkout is no longer available.",
                );
              }
            }}
          >
            Accounts for this checkout
          </Button>
        ) : null}
        {!released ? (
          <Button
            size="sm"
            disabled={
              retryDisabled ||
              props.prepared.phase !== "blocked" ||
              !props.prepared.expectedCwd ||
              (preparedTurnNeedsSetupAcknowledgement(props.prepared) && !acknowledged)
            }
            onClick={() => void run("retry")}
          >
            {pending ? "Working..." : "Retry saved message"}
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          disabled={
            disabled || props.setupActive || props.hasDraft || !preparedTurnCanEdit(props.prepared)
          }
          onClick={() => void run("edit")}
        >
          {released ? "Restore saved message" : "Edit message"}
        </Button>
      </div>
      {props.hasDraft ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Your composer already has a draft. Keep or move it before restoring the original message.
        </p>
      ) : null}
      {props.disabledReason ? (
        <p className="mt-2 text-xs text-muted-foreground">{props.disabledReason}</p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

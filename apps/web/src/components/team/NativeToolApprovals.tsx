import type { MeerkatApproval } from "@t3tools/contracts";
import { CheckIcon, LoaderCircleIcon, ShieldQuestionIcon, XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { usePresentationVisibility } from "../../hooks/usePresentationVisibility";
import { Button } from "../ui/button";

export interface NativeToolApprovalApi {
  list(): Promise<{ readonly approvals: readonly MeerkatApproval[] }>;
  decide(input: {
    approvalId: string;
    sessionId: string;
    decision: "approve" | "deny";
  }): Promise<MeerkatApproval>;
}

/** Scope changes remount the controller, so an old response cannot answer a new agent. */
export function NativeToolApprovals({
  targetKey,
  api,
  disabledReason,
}: {
  targetKey: string;
  api: NativeToolApprovalApi;
  disabledReason?: string | null;
}) {
  return <ApprovalController key={targetKey} api={api} disabledReason={disabledReason} />;
}

function ApprovalController({
  api,
  disabledReason,
}: {
  api: NativeToolApprovalApi;
  disabledReason?: string | null | undefined;
}) {
  const [rows, setRows] = useState<readonly MeerkatApproval[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const presented = usePresentationVisibility();
  const isPresented = useEffectEvent(() => presented);
  const updateObservation = useRef<() => void>(() => {});
  const revision = useRef(0);
  const deciding = useRef(false);
  const list = useEffectEvent(() => api.list());
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    let refreshAfterRead = false;
    const clearTimer = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      if (!disposed && isPresented() && document.visibilityState === "visible")
        timer = setTimeout(() => void refresh(), 2000);
    };
    const refresh = async () => {
      clearTimer();
      if (disposed || !isPresented() || document.visibilityState !== "visible") return;
      if (reading) {
        refreshAfterRead = true;
        return;
      }
      if (deciding.current) {
        schedule();
        return;
      }
      reading = true;
      const startedAt = revision.current;
      try {
        const result = await list();
        if (!disposed && startedAt === revision.current) {
          setRows(result.approvals);
          setLoadError(null);
        }
      } catch (cause) {
        if (!disposed && startedAt === revision.current)
          setLoadError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        reading = false;
        if (refreshAfterRead) {
          refreshAfterRead = false;
          void refresh();
        } else {
          schedule();
        }
      }
    };
    const onVisibility = () => {
      clearTimer();
      if (isPresented() && document.visibilityState === "visible") void refresh();
      else refreshAfterRead = false;
    };
    updateObservation.current = onVisibility;
    document.addEventListener("visibilitychange", onVisibility);
    void refresh();
    return () => {
      disposed = true;
      updateObservation.current = () => {};
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  const previousPresentation = useRef(presented);
  useEffect(() => {
    if (previousPresentation.current !== presented) updateObservation.current();
    previousPresentation.current = presented;
  }, [presented]);
  const decide = async (row: MeerkatApproval, decision: "approve" | "deny") => {
    if (disabledReason) {
      setDecisionError(disabledReason);
      return;
    }
    if (deciding.current) return;
    deciding.current = true;
    revision.current += 1;
    setBusy(row.record.approval_id);
    setDecisionError(null);
    try {
      const updated = await api.decide({
        approvalId: row.record.approval_id,
        sessionId: row.record.owner.session_id,
        decision,
      });
      setRows((current) =>
        current.map((entry) =>
          entry.record.approval_id === updated.record.approval_id ? updated : entry,
        ),
      );
    } catch (cause) {
      setDecisionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      revision.current += 1;
      deciding.current = false;
      setBusy(null);
    }
  };
  const error = decisionError ?? loadError;
  const history = rows.filter((row) => !row.actionable).slice(0, 5);
  const pending = rows.filter((row) => row.actionable && row.record.status === "pending");
  if (!pending.length && !history.length && !error) return null;
  return (
    <section aria-label="Tool approvals" className="mx-auto w-full max-w-3xl space-y-2 px-4 py-2">
      {disabledReason ? (
        <p role="status" className="text-xs text-muted-foreground">
          {disabledReason}
        </p>
      ) : null}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          Approvals: {error}
        </p>
      )}
      {pending.map((row) => (
        <div
          key={row.record.approval_id}
          className="rounded-xl border border-primary/25 bg-card p-3 shadow-sm"
        >
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldQuestionIcon className="size-4 shrink-0 text-primary" />
            Permission to run {row.record.proposed_action.body.toolName}
          </div>
          <details open className="mt-2 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              Review tool arguments
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2">
              {JSON.stringify(row.record.proposed_action.body.arguments, null, 2)}
            </pre>
          </details>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              This call only. A native tool timeout may end this request.
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null || Boolean(disabledReason)}
                onClick={() => void decide(row, "deny")}
              >
                <XIcon className="size-3.5" />
                Deny
              </Button>
              <Button
                size="sm"
                disabled={busy !== null || Boolean(disabledReason)}
                onClick={() => void decide(row, "approve")}
              >
                {busy === row.record.approval_id ? (
                  <LoaderCircleIcon className="size-3.5 animate-spin" />
                ) : (
                  <CheckIcon className="size-3.5" />
                )}
                Allow once
              </Button>
            </div>
          </div>
        </div>
      ))}
      {history.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer py-1">Recent tool decisions</summary>
          <ul className="mt-1 space-y-2">
            {history.map((row) => (
              <li key={row.record.approval_id} className="rounded-md border px-3 py-2">
                <div className="flex justify-between gap-3">
                  <span className="truncate">{row.record.proposed_action.body.toolName}</span>
                  <span>
                    {row.record.status === "pending" ? "No longer waiting" : row.record.status}
                  </span>
                </div>
                {row.record.decision?.reason && (
                  <p className="mt-1">{row.record.decision.reason}</p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

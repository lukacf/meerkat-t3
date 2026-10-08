import { useState } from "react";
import { PauseCircleIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import type {
  EnvironmentId,
  RestoreReviewItem,
  RestoreReviewSnapshot,
  RestoreReviewStatus,
} from "@t3tools/contracts";
import { useEnvironment, useEnvironments } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { serverEnvironment, environmentServerConfigsAtom } from "../../state/server";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
  DialogClose,
} from "../ui/dialog";
import { canConsentRestoreReview } from "./restoreReviewReadiness";
import { useRestoreReview } from "./useRestoreReview";

export function RestoreReviewSidebar() {
  const { environments } = useEnvironments();
  return environments.map((environment) => (
    <RestoreReviewBanner
      key={environment.environmentId}
      environmentId={environment.environmentId}
      compact
    />
  ));
}

export function RestoreReviewBanner({
  environmentId,
  compact = false,
}: {
  environmentId: EnvironmentId;
  compact?: boolean;
}) {
  const status = useRestoreReview(environmentId);
  const environment = useEnvironment(environmentId);
  if (!status || status.status === "clear") return null;
  return (
    <RestoreReviewContent
      key={`${environmentId}:${status.restoreId}`}
      environmentId={environmentId}
      label={environment?.label ?? environmentId}
      status={status}
      compact={compact}
    />
  );
}

function RestoreReviewContent({
  environmentId,
  label,
  status,
  compact,
}: {
  environmentId: EnvironmentId;
  label: string;
  status: RestoreReviewStatus;
  compact: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [consented, setConsented] = useState<RestoreReviewStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  function openConversation(item: RestoreReviewItem) {
    const destination = item.destination;
    if (!destination) return;
    setOpen(false);
    if (destination.kind === "thread") {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: destination.threadId },
        search: destination.member ? { member: destination.member } : {},
      });
    } else {
      void navigate({
        to: "/$environmentId/agents/$agentId",
        params: { environmentId, agentId: destination.agentId },
        search: {
          project: item.projectId,
          ...(destination.nativeAgent
            ? { nativeAgent: destination.nativeAgent, nativeInstance: destination.instanceId }
            : {}),
        },
      });
    }
  }
  const review =
    status.status === "required" && consented?.restoreId === status.restoreId ? consented : status;
  const query = useEnvironmentQuery(
    open ? serverEnvironment.restoreReviewSnapshot({ environmentId, input: {} }) : null,
  );
  const consent = useAtomCommand(serverEnvironment.consentRestoreReview, { reportFailure: false });
  const canResume =
    canConsentRestoreReview(review, query.data) && !pending && !query.error && !query.isPending;
  async function resume() {
    const current = appAtomRegistry
      .get(environmentServerConfigsAtom)
      .get(environmentId)?.restoreReview;
    if (pending || !current || !canConsentRestoreReview(current, query.data) || !canResume) {
      setError("The restore review changed. Refresh the details before resuming.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await consent({ environmentId, input: { restoreId: current.restoreId! } });
      if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
      else setConsented(result.value);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The restore review could not be saved. Work remains paused.",
      );
    } finally {
      setPending(false);
    }
  }
  const restart = review.status === "restart-required";
  return (
    <div
      className={
        compact
          ? "flex shrink-0 items-center gap-2 border-t border-border p-2"
          : `flex min-h-11 shrink-0 flex-wrap items-center gap-3 border-b border-border bg-muted/40 px-4 py-2 ${COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS}`
      }
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        <PauseCircleIcon className="size-4 shrink-0 text-warning-foreground" />
        <div className="min-w-0">
          <p className="truncate font-medium">
            {restart ? "Restart required" : "Restored work paused"}
          </p>
          <p className="truncate text-xs text-muted-foreground">{label}</p>
        </div>
      </div>
      <Button variant="outline" size="xs" onClick={() => setOpen(true)}>
        {restart ? "Details" : "Review"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{restart ? "Restart required" : "Review restored work"}</DialogTitle>
            <DialogDescription>
              {label} - saved history and drafts remain available. New work is paused in this
              environment.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-4">
              <p role="status" className="text-sm">
                {review.message}
              </p>
              {restart ? (
                <p className="text-sm">
                  Your review is saved. Restart this environment to resume. This running process
                  will stay paused until it exits.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Review the saved work below before resuming. After you choose Resume restored work
                  and restart this environment, queued messages and saved sessions may continue
                  using their original identities. Stop and delivery checks remain available now.
                </p>
              )}
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Environment</dt>
                <dd className="break-all">{environmentId}</dd>
                <dt className="text-muted-foreground">Restore ID</dt>
                <dd className="break-all">{review.restoreId ?? "Unavailable"}</dd>
                <dt className="text-muted-foreground">Restored</dt>
                <dd>{review.restoredAt ?? "Unknown"}</dd>
                <dt className="text-muted-foreground">Backup created</dt>
                <dd>{review.backupCreatedAt ?? "Unknown"}</dd>
              </dl>
              {query.isPending ? (
                <p className="text-sm text-muted-foreground">Reading saved work...</p>
              ) : null}
              {query.error ? (
                <p role="alert" className="text-sm text-destructive">
                  {query.error}
                </p>
              ) : null}
              {query.data && query.data.restoreId !== review.restoreId ? (
                <p role="alert" className="text-sm text-destructive">
                  The restore record changed. Refresh these details before resuming.
                </p>
              ) : query.data ? (
                <RestoreWorkSummary snapshot={query.data} onOpenConversation={openConversation} />
              ) : null}
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            {!restart ? (
              <Button variant="ghost" disabled={pending || query.isPending} onClick={query.refresh}>
                Refresh details
              </Button>
            ) : null}
            <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
            {!restart && review.status !== "invalid" ? (
              <Button disabled={!canResume} onClick={() => void resume()}>
                {pending ? "Saving review..." : "Resume restored work"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function RestoreWorkSummary({
  snapshot,
  onOpenConversation,
}: {
  snapshot: RestoreReviewSnapshot;
  onOpenConversation: (item: RestoreReviewItem) => void;
}) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">Server-saved work</h3>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        {[
          ["Queued messages", snapshot.counts.queuedMessages],
          ["Uncertain deliveries", snapshot.counts.uncertainDeliveries],
          ["Interrupted sessions", snapshot.counts.interruptedSessions],
          ["Saved agent records", snapshot.counts.savedAgents],
        ].map(([label, count]) => (
          <div key={label} className="rounded-md border border-border p-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 font-medium">{count}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        Local drafts, staged messages, and earlier send requests remain in their conversations and
        are not included in these counts. Staged messages may send after you resume and restart.
      </p>
      <p className="text-xs text-muted-foreground">
        Native agent mailboxes are unknown while agents are unloaded. These counts do not include
        work waiting inside unloaded native mailboxes.
      </p>
      <p className="text-xs text-muted-foreground">
        Opening a conversation does not resume work. This environment stays paused until you
        explicitly resume and restart it.
      </p>
      {snapshot.items.length ? (
        <div className="space-y-2">
          {snapshot.items.map((item, index) => (
            <details
              key={`${item.kind}:${item.id}:${index}`}
              className="rounded-md border border-border p-3 text-sm"
            >
              <summary className="cursor-pointer break-words font-medium">
                {item.label}{" "}
                <span className="font-normal text-muted-foreground">- {item.status}</span>
              </summary>
              <p className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                {item.detail}
              </p>
              <div className="mt-2 space-y-2">
                {item.destination ? (
                  <>
                    <p className="break-words text-xs">{item.destination.label}</p>
                    <Button variant="outline" size="xs" onClick={() => onOpenConversation(item)}>
                      Open conversation
                    </Button>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Conversation unavailable from these saved records.
                  </p>
                )}
              </div>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt>Original ID</dt>
                <dd className="break-all">{item.id}</dd>
                <dt>Project</dt>
                <dd className="break-all">{item.projectId}</dd>
                {item.instanceId ? (
                  <>
                    <dt>Provider</dt>
                    <dd className="break-all">{item.instanceId}</dd>
                  </>
                ) : null}
                {item.threadId ? (
                  <>
                    <dt>Thread</dt>
                    <dd className="break-all">{item.threadId}</dd>
                  </>
                ) : null}
              </dl>
            </details>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No saved work appears in this server snapshot. Unloaded native mailbox contents remain
          unknown.
        </p>
      )}
      {snapshot.truncated ? (
        <p className="text-xs text-muted-foreground">
          This list is limited. Counts include additional saved work.
        </p>
      ) : null}
    </div>
  );
}

import type {
  EnvironmentId,
  SharedActivity,
  SharedInbox,
  SharedKnowledgeSearchHit,
  SharedRevision,
  SharedWorkspaceSnapshot,
} from "@t3tools/contracts";
import { GitBranchIcon, InboxIcon, RefreshCwIcon } from "lucide-react";
import { useId, useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { sharedWorkspaceEnvironment as shared } from "../../state/sharedWorkspace";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SharedRevisionLabel({ revision }: { revision: SharedRevision }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-foreground/75" />
        }
      >
        <GitBranchIcon className="size-3 shrink-0" />
        <span className="truncate">{revision.branch}</span>
        <code className="shrink-0 text-2xs">{revision.commit.slice(0, 8)}</code>
        {revision.snapshotId ? <span className="shrink-0">with snapshot</span> : null}
      </TooltipTrigger>
      <TooltipPopup>
        {revision.branch} at {revision.commit}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Product observations stay distinct from native delivery and request outcomes. */
export function SharedActivityInbox({
  environmentId,
  inbox,
  snapshot,
  busy,
  acknowledging = false,
  offline,
  error,
  onRefresh,
  onAcknowledge,
}: {
  environmentId: EnvironmentId;
  inbox: SharedInbox | null;
  snapshot: SharedWorkspaceSnapshot | null;
  busy: boolean;
  acknowledging?: boolean;
  offline: boolean;
  error: string | null;
  onRefresh: () => void;
  onAcknowledge: (batchId: string) => void;
}) {
  return (
    <details
      className="rounded-xl border border-border bg-card"
      aria-label="Shared project updates"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs">
        <InboxIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Project updates</span>
        <span className="ml-auto text-muted-foreground" role="status">
          {offline
            ? "Host offline"
            : acknowledging
              ? "Marking batch read..."
              : busy
                ? "Fetching updates..."
                : error
                  ? "Updates unavailable"
                  : inbox
                    ? inbox.events.length
                      ? `${inbox.events.length} unread${inbox.hasMore ? "+" : ""}`
                      : "No unread updates"
                    : "Not checked"}
        </span>
      </summary>
      <div className="border-t border-border px-3 py-3">
        {error ? (
          <p role="alert" className="mb-3 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {offline ? (
          <p className="mb-3 text-xs text-muted-foreground">
            {inbox
              ? "Showing the last fetched batch. Reconnect before fetching new updates or marking it read."
              : "No briefing has been fetched. Reconnect to check project updates."}
          </p>
        ) : null}
        <ol className="max-h-72 space-y-4 overflow-y-auto">
          {inbox?.events.map((event) => (
            <li key={event.eventId} className="space-y-1.5 text-xs">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
                <span className="font-medium text-foreground">{event.author.displayName}</span>
                <span>
                  {snapshot?.projects.find(
                    (project) => project.sharedProjectId === event.context.sharedProjectId,
                  )?.name ?? "Shared project"}
                </span>
                <SharedRevisionLabel revision={event.revision} />
                <span className="ml-auto capitalize">{event.kind.replaceAll("_", " ")}</span>
              </div>
              <p className="whitespace-pre-wrap leading-relaxed">{event.summary}</p>
              {event.knowledge ? (
                <SharedCorrectionDetail
                  key={`${environmentId}:${inbox.recipientId}:${event.knowledge.evidenceId}`}
                  environmentId={environmentId}
                  sharedProjectId={event.context.sharedProjectId}
                  knowledge={event.knowledge}
                  offline={offline}
                />
              ) : null}
              {event.sources.length ? (
                <details className="text-muted-foreground">
                  <summary className="cursor-pointer">Evidence ({event.sources.length})</summary>
                  <ul className="mt-1 space-y-1">
                    {[
                      ...new Map(
                        event.sources.map((source) => [JSON.stringify(source), source]),
                      ).entries(),
                    ].map(([key, source]) => (
                      <li key={key}>
                        {/^https?:\/\//i.test(source.uri) ? (
                          <a
                            className="underline underline-offset-2"
                            href={source.uri}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {source.title}
                          </a>
                        ) : (
                          <span>
                            {source.title}: <code className="break-all">{source.uri}</code>
                          </span>
                        )}
                        {source.native ? (
                          <span>
                            {" "}
                            ({source.native.owner}, cursor {source.native.cursor})
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </li>
          ))}
        </ol>
        {inbox && !inbox.events.length && !busy && !error ? (
          <p className="text-xs text-muted-foreground">No unread product updates.</p>
        ) : null}
        <div className="mt-3 flex items-center gap-2">
          {inbox?.batchId ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || offline || Boolean(error)}
              onClick={() => onAcknowledge(inbox.batchId!)}
            >
              Mark these updates read
            </Button>
          ) : null}
          <Button
            size={inbox ? "icon-xs" : "xs"}
            variant={inbox ? "ghost" : "outline"}
            disabled={busy || offline}
            aria-label="Refresh project updates"
            onClick={onRefresh}
          >
            <RefreshCwIcon />
            {!inbox ? "Fetch briefing" : null}
          </Button>
        </div>
        {inbox?.batchId ? (
          <p className="mt-2 text-3xs text-muted-foreground">
            Marks this batch read. Task delivery and completion are shown with each request.
          </p>
        ) : null}
      </div>
    </details>
  );
}

function SharedCorrectionDetail({
  environmentId,
  sharedProjectId,
  knowledge,
  offline,
}: {
  environmentId: EnvironmentId;
  sharedProjectId: string;
  knowledge: NonNullable<SharedActivity["knowledge"]>;
  offline: boolean;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  return (
    <div>
      <Button
        size="xs"
        variant="outline"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Hide correction" : "View correction"}
      </Button>
      {open ? (
        <div id={detailId} className="mt-2 space-y-3 rounded-lg border border-border p-3">
          <SharedKnowledgeDetail
            environmentId={environmentId}
            sharedProjectId={sharedProjectId}
            evidenceId={knowledge.evidenceId}
            offline={offline}
          />
          {knowledge.supersedes.length ? (
            <div className="space-y-2 border-t border-border pt-3">
              <p className="font-medium">Supersedes</p>
              <p className="text-muted-foreground">
                Previous findings are kept with their original content and revision.
              </p>
              <ul className="space-y-2">
                {knowledge.supersedes.map((evidenceId) => (
                  <li key={evidenceId}>
                    <RetainedFinding
                      environmentId={environmentId}
                      sharedProjectId={sharedProjectId}
                      evidenceId={evidenceId}
                      offline={offline}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RetainedFinding({
  environmentId,
  sharedProjectId,
  evidenceId,
  offline,
}: {
  environmentId: EnvironmentId;
  sharedProjectId: string;
  evidenceId: string;
  offline: boolean;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  return (
    <div>
      <Button
        size="xs"
        variant="ghost"
        className="h-auto max-w-full flex-wrap justify-start text-left whitespace-normal"
        aria-label={`${open ? "Hide" : "View"} retained finding ${evidenceId}`}
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{open ? "Hide retained finding" : "View retained finding"}</span>
        <code className="min-w-0 break-all text-3xs">{evidenceId}</code>
      </Button>
      {open ? (
        <div id={detailId} className="mt-2 rounded-lg bg-muted/40 p-3">
          <SharedKnowledgeDetail
            environmentId={environmentId}
            sharedProjectId={sharedProjectId}
            evidenceId={evidenceId}
            offline={offline}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Reading evidence is independent of acknowledging the sealed inbox batch. */
function SharedKnowledgeDetail({
  environmentId,
  sharedProjectId,
  evidenceId,
  offline,
}: {
  environmentId: EnvironmentId;
  sharedProjectId: string;
  evidenceId: string;
  offline: boolean;
}) {
  const query = useEnvironmentQuery(
    !offline ? shared.knowledge({ environmentId, input: { evidenceId } }) : null,
  );
  const [retained, setRetained] = useState<SharedKnowledgeSearchHit | null>(null);
  const fetched = query.data?.records.find(
    (record) => record.evidenceId === evidenceId && record.sharedProjectId === sharedProjectId,
  );
  if (fetched && !query.error && fetched !== retained) setRetained(fetched);
  const record = offline ? retained : fetched;
  return (
    <div className="space-y-2">
      {offline ? (
        <p className="text-muted-foreground">
          {record
            ? "Showing the last fetched finding. Reconnect to check for later corrections."
            : "Reconnect to load this finding."}
        </p>
      ) : query.error ? (
        <div role="alert" className="space-y-2">
          <p className="text-destructive">Could not load this finding: {query.error}</p>
          <Button size="xs" variant="outline" onClick={query.refresh}>
            Retry finding
          </Button>
        </div>
      ) : query.isPending && !record ? (
        <p role="status" className="text-muted-foreground">
          Loading finding...
        </p>
      ) : query.isSuccess && !record ? (
        <p role="alert" className="text-muted-foreground">
          This finding is not available in this shared project. Its inbox reference is kept.
        </p>
      ) : null}
      {record ? (
        <>
          <p className="font-medium break-words">{record.title}</p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
            <span>{record.author.displayName}</span>
            <SharedRevisionLabel revision={record.revision} />
            <span>
              {record.revision.applicability === "proposal"
                ? "Proposed change"
                : record.revision.applicability === "merged"
                  ? "Merged revision"
                  : "Branch revision"}
            </span>
          </div>
          <p className="whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere]">
            {record.body}
          </p>
          <p className="text-3xs text-muted-foreground">
            Finding <code className="break-all">{record.evidenceId}</code>
          </p>
          {record.corrections.length ? (
            <div className="space-y-1 border-t border-border pt-2">
              <p className="font-medium">Later corrections</p>
              <ul className="space-y-2 text-muted-foreground">
                {record.corrections.map((correction) => (
                  <li key={correction.evidenceId} className="space-y-1">
                    <p className="break-words">{correction.title}</p>
                    <SharedRevisionLabel revision={correction.revision} />
                  </li>
                ))}
              </ul>
              {record.hasMoreCorrections ? (
                <p className="text-muted-foreground">
                  Additional corrections exist for this finding.
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

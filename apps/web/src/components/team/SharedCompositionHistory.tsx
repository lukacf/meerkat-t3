import type {
  EnvironmentId,
  SharedCompositionHistoryItem,
  SharedCompositionReference,
  SharedWorkspaceSnapshot,
} from "@t3tools/contracts";
import { ChevronDownIcon, HistoryIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { sharedWorkspaceEnvironment as shared } from "../../state/sharedWorkspace";
import { Button } from "../ui/button";

type Props = {
  environmentId: EnvironmentId;
  specialistId: string;
  snapshot: SharedWorkspaceSnapshot | null;
  connected: boolean;
};
const kindLabel = {
  create: "Specialist created",
  revise: "Responsibilities revised",
  connect: "Peers connected",
  split: "Responsibilities split",
  consolidate: "Responsibilities consolidated",
  supersede: "Future routing changed",
};
const pendingKindLabel = {
  create: "Create specialist",
  revise: "Revise responsibilities",
  connect: "Connect peers",
  split: "Split responsibilities",
  consolidate: "Consolidate responsibilities",
  supersede: "Change future routing",
};

/** Reads retained product changes only. Opening this view never retries native work. */
export function SharedCompositionHistory(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="group rounded-xl border border-border bg-card"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs">
        <HistoryIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Responsibility history</span>
        <ChevronDownIcon className="ml-auto size-3.5 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      {open ? (
        <HistoryPage key={`${props.environmentId}:${props.specialistId}`} {...props} />
      ) : null}
    </details>
  );
}

function HistoryPage({ environmentId, specialistId, snapshot, connected }: Props) {
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const query = useEnvironmentQuery(
    connected
      ? shared.compositionHistory({
          environmentId,
          input: { specialistId, limit: 5, ...(cursor ? { cursor } : {}) },
        })
      : null,
  );
  const page = connected && !query.error && !query.isPending ? query.data : null;
  const unavailable = !connected || query.isPending || Boolean(query.error);
  return (
    <div className="space-y-3 border-t border-border px-3 py-3 text-xs">
      <p className="leading-relaxed text-foreground/75">
        Changes apply to future assignments. Existing requests keep their original specialist;
        predecessors are retained.
      </p>
      {!connected ? (
        <p role="status" className="text-muted-foreground">
          Connect to the shared host to read responsibility history.
        </p>
      ) : query.error ? (
        <p role="alert" className="text-destructive">
          Responsibility history is unavailable. {query.error}
        </p>
      ) : query.isPending ? (
        <p role="status" className="text-muted-foreground">
          Loading responsibility history...
        </p>
      ) : page && !page.items.length ? (
        <p className="text-muted-foreground">
          No responsibility changes have been recorded for this specialist.
        </p>
      ) : null}
      {page?.items.length ? (
        <ol className="max-h-80 space-y-3 overflow-y-auto">
          {page.items.map((item) => (
            <HistoryEntry key={item.operation.operationKey} item={item} snapshot={snapshot} />
          ))}
        </ol>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh responsibility history"
          disabled={!connected || query.isPending}
          onClick={query.refresh}
        >
          <RefreshCwIcon />
        </Button>
        {cursors.length ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={unavailable}
            onClick={() => setCursors((previous) => previous.slice(0, -1))}
          >
            Newer changes
          </Button>
        ) : null}
        {page?.nextCursor ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={unavailable}
            onClick={() => setCursors((previous) => [...previous, page.nextCursor!])}
          >
            Older changes
          </Button>
        ) : null}
        {page ? (
          <span className="ml-auto text-2xs text-muted-foreground">
            Observed{" "}
            {new Date(page.observedAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function HistoryEntry({
  item,
  snapshot,
}: {
  item: SharedCompositionHistoryItem;
  snapshot: SharedWorkspaceSnapshot | null;
}) {
  const { operation } = item;
  const completed = operation.status === "completed";
  const label = (id: string) =>
    snapshot?.specialists.find((specialist) => specialist.specialistId === id)?.label ?? id;
  const referenceLabel = (reference: SharedCompositionReference) => {
    if ("specialistId" in reference) return label(reference.specialistId);
    const created = operation.creations.find((creation) => creation.key === reference.creationKey);
    return created?.specialistId
      ? label(created.specialistId)
      : (item.assignments.find((assignment) => assignment.creationKey === reference.creationKey)
          ?.label ?? reference.creationKey);
  };
  const author =
    item.authorDisplayName ??
    (operation.actor.kind === "specialist" ? "Workspace specialist" : "Workspace participant");
  return (
    <li className="space-y-1.5 rounded-lg border border-border/70 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-medium">
          {completed ? kindLabel[operation.kind] : pendingKindLabel[operation.kind]}
        </span>
        <span className={completed ? "text-muted-foreground" : "text-warning-foreground"}>
          {operation.status === "completed"
            ? "Completed"
            : operation.status === "conflict"
              ? "Conflict"
              : "Pending"}
        </span>
        <time dateTime={operation.updatedAt} className="ml-auto text-2xs text-muted-foreground">
          {new Date(operation.updatedAt).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      </div>
      <p className="break-words text-foreground/75">Requested by {author}</p>
      {operation.detail ? (
        <p className="whitespace-pre-wrap break-words leading-relaxed text-foreground/85">
          {operation.detail}
        </p>
      ) : null}
      {!completed && operation.status === "pending" ? (
        <p className="text-2xs text-muted-foreground">Completion has not been observed.</p>
      ) : null}
      {(completed ? operation.lineage : item.transitions).length ? (
        <div className="space-y-1 text-foreground/85">
          <p className="font-medium">{completed ? "Future routing" : "Proposed future routing"}</p>
          {completed
            ? operation.lineage.map((lineage) => (
                <p key={lineage.predecessorId} className="break-words">
                  {label(lineage.predecessorId)} to {lineage.successorIds.map(label).join(", ")}.{" "}
                  {lineage.superseded
                    ? "Predecessor retained for existing requests."
                    : "Predecessor keeps its remaining assignments."}
                </p>
              ))
            : item.transitions.map((transition) => (
                <p key={transition.predecessorId} className="break-words">
                  {label(transition.predecessorId)} to{" "}
                  {transition.successors.map(referenceLabel).join(", ")}. Not applied.
                </p>
              ))}
        </div>
      ) : null}
      <details className="text-foreground/75">
        <summary className="cursor-pointer text-2xs">Assignments and evidence</summary>
        <div className="mt-2 space-y-3">
          {item.assignments.map((assignment) => (
            <div
              key={
                assignment.creationKey
                  ? `create:${assignment.creationKey}`
                  : `revise:${assignment.specialistId}`
              }
              className="space-y-1"
            >
              <p className="font-medium text-foreground">
                {assignment.label ??
                  (assignment.specialistId
                    ? label(assignment.specialistId)
                    : assignment.creationKey)}
                {completed ? "" : " (proposed)"}
              </p>
              {assignment.expectedVersion !== null ? (
                <p className="text-2xs">
                  Requested from assignment version {assignment.expectedVersion}
                </p>
              ) : null}
              {assignment.assignments.map((scope) => (
                <div key={scope.sharedProjectId} className="space-y-1 break-words">
                  <p>
                    {snapshot?.projects.find(
                      (project) => project.sharedProjectId === scope.sharedProjectId,
                    )?.name ?? scope.sharedProjectId}
                    : {scope.charter}
                  </p>
                  {scope.paths.length ? (
                    <p className="text-2xs">Paths: {scope.paths.join(", ")}</p>
                  ) : null}
                  {scope.tags.length ? (
                    <p className="text-2xs">Topics: {scope.tags.join(", ")}</p>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
          {item.peers.map((peer) => (
            <p key={JSON.stringify(peer)} className="break-words">
              {completed ? "Peers" : "Proposed peers"}: {referenceLabel(peer.source)} and{" "}
              {referenceLabel(peer.target)}
            </p>
          ))}
          {operation.evidence.length ? (
            <ul className="space-y-2">
              {operation.evidence.map((evidence) => (
                <li key={evidence.step} className="space-y-0.5 break-all text-2xs">
                  <p className="font-medium">
                    {evidence.kind === "native_identity"
                      ? "Native identity"
                      : evidence.kind === "native_revision"
                        ? "Native revision"
                        : "Native peer connection"}
                  </p>
                  <p>
                    Agent: <code>{evidence.nativeTarget.agentId}</code>
                  </p>
                  {evidence.sessionId ? (
                    <p>
                      Session: <code>{evidence.sessionId}</code>
                    </p>
                  ) : null}
                  {evidence.revisionId ? (
                    <p>
                      Revision: <code>{evidence.revisionId}</code>
                    </p>
                  ) : null}
                  {evidence.peerEdgeId ? (
                    <p>
                      Connection: <code>{evidence.peerEdgeId}</code>
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-2xs">No native evidence was recorded for this operation.</p>
          )}
          <p className="break-all text-2xs">
            Request: <code>{operation.operationId}</code> by {operation.actor.kind}{" "}
            <code>{operation.actor.id}</code>
          </p>
        </div>
      </details>
    </li>
  );
}

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, SharedInbox, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BoxIcon, ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { useProjects } from "../../state/entities";
import type { EnvironmentPresentation } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import {
  sharedWorkspaceEnvironment as shared,
  useSharedDirectory,
  useSharedHosts,
} from "../../state/sharedWorkspace";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { SharedActivityInbox } from "./SharedActivityInbox";
import { SharedSpecialistDiscovery, sharedDiscoveryReasonLabel } from "./SharedSpecialistDiscovery";
import { SharedTaskAccess } from "./SharedTaskAccess";
import { sharedHostStatus, sharedSpecialistDestination } from "./sharedWorkspace.logic";

/** Opening work discovers project coverage without publishing its prompt or granting authority. */
export function SharedTaskCollaboration({
  environmentId,
  projectId,
  threadId,
  isDraft,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
  isDraft: boolean;
}) {
  const hosts = useSharedHosts();
  const project = useProjects().find(
    (item) => item.environmentId === environmentId && item.id === projectId,
  );
  if (!project) return null;
  return hosts.map((host) => (
    <HostTaskCollaboration
      key={`${host.environmentId}:${host.entry.target._tag === "BearerConnectionTarget" ? host.entry.target.connectionId : "local"}:${threadId}`}
      project={project}
      host={host}
      threadId={threadId}
      isDraft={isDraft}
    />
  ));
}

function HostTaskCollaboration({
  project,
  host,
  threadId,
  isDraft,
}: {
  project: EnvironmentProject;
  host: EnvironmentPresentation;
  threadId: ThreadId;
  isDraft: boolean;
}) {
  const directory = useSharedDirectory(host);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [fetchBriefing, setFetchBriefing] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);
  const [ackError, setAckError] = useState<string | null>(null);
  const [ackNotice, setAckNotice] = useState<string | null>(null);
  const [retainedInbox, setRetainedInbox] = useState<SharedInbox | null>(null);
  const snapshot = directory.snapshot;
  const checkout = snapshot?.checkouts.find(
    (item) =>
      item.participantId === snapshot.participant?.participantId &&
      item.localEnvironmentId === project.environmentId &&
      item.localProjectId === project.id,
  );
  const connected = directory.connected && !directory.error;
  const discovery = useEnvironmentQuery(
    connected && checkout
      ? shared.discover({
          environmentId: host.environmentId,
          input: { sharedProjectId: checkout.sharedProjectId, limit: 6 },
        })
      : null,
  );
  const inbox = useEnvironmentQuery(
    connected && checkout && fetchBriefing
      ? shared.inbox({ environmentId: host.environmentId, input: {} })
      : null,
  );
  if (
    inbox.data &&
    !inbox.error &&
    inbox.data.recipientId === snapshot?.participant?.participantId &&
    inbox.data !== retainedInbox
  )
    setRetainedInbox(inbox.data);
  const currentInbox =
    inbox.data?.recipientId === snapshot?.participant?.participantId
      ? inbox.data
      : retainedInbox?.recipientId === snapshot?.participant?.participantId
        ? retainedInbox
        : null;
  const acknowledge = useAtomCommand(shared.acknowledgeInbox, { reportFailure: false });
  const matches = discovery.data?.items ?? [];
  const hostName = snapshot?.workspace?.name ?? host.label;
  const status = sharedHostStatus(
    host.connection.phase,
    snapshot !== null,
    directory.error,
    directory.isPending,
  );
  async function markRead(batchId: string) {
    if (!connected || acknowledging || batchId !== inbox.data?.batchId) return;
    setAcknowledging(true);
    setAckError(null);
    setAckNotice(null);
    try {
      const result = await acknowledge({ environmentId: host.environmentId, input: { batchId } });
      if (result._tag === "Failure") setAckError(formatEnvironmentQueryError(result.cause));
      else {
        setAckNotice(
          "This briefing batch was marked read for you. It does not acknowledge an agent's inbox or complete its work.",
        );
        inbox.refresh();
      }
    } finally {
      setAcknowledging(false);
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="ghost-muted" size="xs" className="min-w-0 shrink" />}
        aria-label={`Shared specialists in ${hostName}`}
      >
        <BoxIcon />
        <span className="truncate">Shared specialists</span>
        <span
          className="shrink-0 text-muted-foreground"
          aria-label={!connected ? status : undefined}
        >
          {!connected
            ? status === "Host offline"
              ? "Offline"
              : status
            : discovery.error
              ? "!"
              : discovery.isPending
                ? "..."
                : checkout && discovery.data
                  ? `${matches.length}${discovery.data.nextCursor ? "+" : ""}`
                  : ""}
        </span>
        <ChevronDownIcon />
      </PopoverTrigger>
      <PopoverPopup width="lg" align="start" keepMounted>
        <PopoverTitle className="break-words">{hostName}</PopoverTitle>
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {project.title} - {status}
        </p>
        <div className="mt-4 space-y-4">
          {!checkout ? (
            <div className="space-y-2 text-xs text-muted-foreground">
              <p>
                {!connected
                  ? "Reconnect the shared host to check this project's association."
                  : directory.isPending
                    ? "Checking this project's shared checkout..."
                    : "Connect this checkout to use its existing shared specialists."}
              </p>
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/projects/$projectId/start",
                    params: { environmentId: project.environmentId, projectId: project.id },
                  })
                }
              >
                Open project setup
              </Button>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium">Specialists for this project</p>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Refresh suggested specialists"
                    disabled={!directory.connected || discovery.isPending}
                    onClick={() => {
                      discovery.refresh();
                      directory.refresh();
                    }}
                  >
                    <RefreshCwIcon />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Found automatically from project responsibilities. Your task text stays local
                  until you explicitly share it.
                </p>
                {directory.error ? (
                  <p role="alert" className="break-words text-xs text-destructive">
                    {directory.error}
                  </p>
                ) : !directory.connected ? (
                  <p role="status" className="text-xs text-muted-foreground">
                    The host is offline. Reconnect to refresh these suggestions.
                  </p>
                ) : discovery.error ? (
                  <p role="alert" className="break-words text-xs text-destructive">
                    {discovery.error}
                  </p>
                ) : discovery.isPending ? (
                  <p role="status" className="text-xs text-muted-foreground">
                    Finding project specialists...
                  </p>
                ) : discovery.data && !matches.length ? (
                  <p className="text-xs text-muted-foreground">
                    No current specialists match this project.
                  </p>
                ) : null}
                {matches.map((match) => {
                  const specialist = snapshot?.specialists.find(
                    (item) =>
                      item.specialistId === match.specialistId &&
                      item.assignmentVersion === match.assignmentVersion &&
                      !item.supersededAt,
                  );
                  const assignedHere = match.sharedProjectIds.includes(checkout.sharedProjectId);
                  return (
                    <div
                      key={match.specialistId}
                      className="min-w-0 rounded-lg border border-border p-2.5"
                    >
                      <div className="flex min-w-0 items-start justify-between gap-2">
                        <p className="min-w-0 break-words text-xs font-medium">{match.label}</p>
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={!specialist || !assignedHere}
                          onClick={() => {
                            if (specialist && assignedHere)
                              void navigate(
                                sharedSpecialistDestination(
                                  host.environmentId,
                                  specialist,
                                  checkout,
                                  isDraft ? undefined : threadId,
                                ),
                              );
                          }}
                        >
                          Open
                        </Button>
                      </div>
                      <p className="mt-1 break-words text-3xs text-muted-foreground">
                        {match.matches
                          .flatMap((item) => item.reasons.map(sharedDiscoveryReasonLabel))
                          .join(" · ")}
                      </p>
                      {match.matches
                        .filter((item) => item.sharedProjectId === checkout.sharedProjectId)
                        .map((item) => (
                          <p
                            key={item.sharedProjectId}
                            className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground"
                          >
                            {item.charterExcerpt}
                            <span className="block pt-1 text-3xs">
                              Charter excerpt{item.charterExcerptTruncated ? " (shortened)" : ""}
                            </span>
                          </p>
                        ))}
                      {!specialist ? (
                        <p className="mt-1 text-3xs text-muted-foreground">
                          The directory changed. Refresh before opening.
                        </p>
                      ) : null}
                    </div>
                  );
                })}
                {discovery.data?.nextCursor ? (
                  <p className="text-3xs text-muted-foreground">
                    More specialists are available in Find specialists below.
                  </p>
                ) : null}
              </div>
              {snapshot ? (
                <SharedSpecialistDiscovery
                  host={host}
                  checkout={checkout}
                  snapshot={snapshot}
                  connected={connected}
                  refreshDirectory={directory.refresh}
                  threadId={isDraft ? undefined : threadId}
                />
              ) : null}
              <div className="space-y-2 border-t border-border pt-3">
                <p className="text-xs text-muted-foreground">
                  Your briefing includes updates from the shared projects you follow. Fetching shows
                  the retained batch; marking it read is a separate action for your account.
                </p>
                <SharedActivityInbox
                  environmentId={host.environmentId}
                  inbox={currentInbox}
                  snapshot={snapshot}
                  busy={inbox.isPending || acknowledging}
                  acknowledging={acknowledging}
                  offline={!directory.connected}
                  error={ackError ?? directory.error ?? inbox.error}
                  onRefresh={() => {
                    if (!connected) return;
                    setFetchBriefing(true);
                    setAckError(null);
                    setAckNotice(null);
                    inbox.refresh();
                  }}
                  onAcknowledge={(batchId) => void markRead(batchId)}
                />
                {ackNotice ? (
                  <p role="status" className="text-3xs text-muted-foreground">
                    {ackNotice}
                  </p>
                ) : null}
              </div>
              {snapshot && !isDraft ? (
                <SharedTaskAccess
                  host={host}
                  checkout={checkout}
                  snapshot={snapshot}
                  connected={connected}
                  canContribute={directory.permissions?.contribute === true}
                  initialThreadId={threadId}
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Start this task before granting its agent access. Browsing specialists does not
                  grant access.
                </p>
              )}
            </>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

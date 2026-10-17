import type { EnvironmentId, SharedWorkContextInput } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowUpIcon, BoxIcon, RefreshCwIcon, ServerIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isElectron } from "../../env";
import { randomUUID } from "../../lib/utils";
import { useProjects, useThreadShellsForProjectRefs } from "../../state/entities";
import { useEnvironment, type EnvironmentPresentation } from "../../state/environments";
import { useVisibleTeamRefresh } from "../../state/meerkatTeam";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import {
  sharedWorkspaceEnvironment as shared,
  useSharedDirectory,
} from "../../state/sharedWorkspace";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SharedActivityInbox, SharedRevisionLabel } from "./SharedActivityInbox";
import { SharedCompositionHistory } from "./SharedCompositionHistory";
import { SharedRequestCard, SharedMarkdown } from "./SharedRequestCard";
import { sharedHostStatus } from "./sharedWorkspace.logic";
import {
  deliverSharedRequest,
  readSharedDraft,
  saveSharedDraft,
  type SharedDraft,
  type SharedPendingRequest,
} from "./sharedConversationDraft";
import { savedMessageView } from "./nativeTranscript.logic";
import { SharedSnapshotPanel } from "./SharedSnapshotPanel";
import { useSharedSnapshot } from "./useSharedSnapshot";

export function SharedSpecialistConversation({
  environmentId,
  specialistId,
  checkoutId,
  checkoutEnvironment,
  checkoutProject,
  checkoutThread,
}: {
  environmentId: EnvironmentId;
  specialistId: string;
  checkoutId?: string | undefined;
  checkoutEnvironment?: string | undefined;
  checkoutProject?: string | undefined;
  checkoutThread?: string | undefined;
}) {
  const host = useEnvironment(environmentId);
  if (!host)
    return (
      <SidebarInset>
        <p className="p-6 text-sm text-muted-foreground">
          This shared host is not connected to this app.
        </p>
      </SidebarInset>
    );
  return (
    <SharedConversation
      key={`${environmentId}:${specialistId}:${checkoutId ?? ""}:${checkoutThread ?? ""}`}
      host={host}
      specialistId={specialistId}
      checkoutId={checkoutId}
      checkoutEnvironment={checkoutEnvironment}
      checkoutProject={checkoutProject}
      checkoutThread={checkoutThread}
    />
  );
}

function SharedConversation({
  host,
  specialistId,
  checkoutId,
  checkoutEnvironment,
  checkoutProject,
  checkoutThread,
}: {
  host: EnvironmentPresentation;
  specialistId: string;
  checkoutId: string | undefined;
  checkoutEnvironment: string | undefined;
  checkoutProject: string | undefined;
  checkoutThread: string | undefined;
}) {
  const navigate = useNavigate();
  const directory = useSharedDirectory(host);
  const conversation = useEnvironmentQuery(
    shared.conversation({ environmentId: host.environmentId, input: { specialistId } }),
  );
  useVisibleTeamRefresh(conversation, true);
  const inbox = useEnvironmentQuery(shared.inbox({ environmentId: host.environmentId, input: {} }));
  useVisibleTeamRefresh(inbox, true);
  const projects = useProjects();
  const checkout = directory.snapshot?.checkouts.find(
    (candidate) =>
      candidate.checkoutId === checkoutId &&
      candidate.participantId === directory.snapshot?.participant?.participantId &&
      candidate.localEnvironmentId === checkoutEnvironment &&
      candidate.localProjectId === checkoutProject,
  );
  const project = checkout
    ? projects.find(
        (candidate) =>
          candidate.environmentId === checkout.localEnvironmentId &&
          candidate.id === checkout.localProjectId,
      )
    : undefined;
  const tasks = useThreadShellsForProjectRefs(
    checkout
      ? [{ environmentId: checkout.localEnvironmentId, projectId: checkout.localProjectId }]
      : [],
  );
  const task = checkoutThread
    ? tasks.find((candidate) => candidate.id === checkoutThread && !candidate.archivedAt)
    : undefined;
  const taskContextAvailable = !checkoutThread || Boolean(task);
  const revision = useEnvironmentQuery(
    checkout && taskContextAvailable
      ? shared.checkoutRevision({
          environmentId: checkout.localEnvironmentId,
          input: { projectId: checkout.localProjectId, ...(task ? { threadId: task.id } : {}) },
        })
      : null,
  );
  const specialist =
    conversation.data?.specialist ??
    directory.snapshot?.specialists.find((candidate) => candidate.specialistId === specialistId);
  const observeRevision = useAtomCommand(shared.observeCheckoutRevision, { reportFailure: false });
  const putContext = useAtomCommand(shared.putWorkContext, { reportFailure: false });
  const send = useAtomCommand(shared.send, { reportFailure: false });
  const acknowledge = useAtomCommand(shared.acknowledgeInbox, { reportFailure: false });
  const connectionId =
    host.entry.target._tag === "BearerConnectionTarget" ? host.entry.target.connectionId : "local";
  const patchSnapshot = useSharedSnapshot({
    hostEnvironmentId: host.environmentId,
    accountKey: JSON.stringify([
      connectionId,
      directory.snapshot?.workspace?.workspaceId,
      directory.snapshot?.participant?.participantId,
    ]),
    checkout,
    threadId: task?.id,
    maxBytes: directory.snapshot?.workspace?.limits.maxSnapshotBytes ?? 0,
  });
  const draftKey = `meerkat-t3:shared-request:v1:${JSON.stringify([host.environmentId, connectionId, specialistId, checkoutId, ...(checkoutThread ? [checkoutThread] : [])])}`;
  const [initialDraft] = useState(() => {
    try {
      return { value: readSharedDraft(draftKey), error: null };
    } catch {
      return {
        value: { text: "", pending: null } satisfies SharedDraft,
        error:
          "The saved request could not be read. Sending is blocked to preserve its delivery identity.",
      };
    }
  });
  const [draft, setDraft] = useState<SharedDraft>(initialDraft.value);
  const [notice, setNotice] = useState<string | null>(initialDraft.error);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [inboxBusy, setInboxBusy] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const connected = directory.connected && !directory.error;
  const requests = conversation.data?.requests ?? [];
  const unsentPending =
    draft.pending &&
    requests.some(
      (request) =>
        request.outcome.status === "not_admitted" &&
        request.clientRequestId === draft.pending?.requestId &&
        request.author.participantId === draft.pending.participantId &&
        request.context.contextVersion === draft.pending.contextVersion &&
        draft.pending.workspaceId === directory.snapshot?.workspace?.workspaceId,
    );
  const currentDraft = useRef(draft);
  const writeDraft = (value: SharedDraft) => {
    if (!saveSharedDraft(draftKey, value)) {
      setNotice(
        "Could not save the request on this device. Keep this window open and copy your message before leaving.",
      );
      return false;
    }
    setDraft(value);
    currentDraft.current = value;
    return true;
  };
  useEffect(() => {
    const pending = currentDraft.current.pending;
    if (!pending) return;
    const admitted = requests.find(
      (request) =>
        request.clientRequestId === pending.requestId &&
        request.author.participantId === pending.participantId &&
        request.context.contextId === pending.context.contextId &&
        (!pending.contextVersion || request.context.contextVersion === pending.contextVersion) &&
        pending.workspaceId === directory.snapshot?.workspace?.workspaceId,
    );
    if (!admitted || admitted.outcome.status === "not_admitted") return;
    const value = {
      text: currentDraft.current.text === pending.text ? "" : currentDraft.current.text,
      pending: null,
    };
    if (saveSharedDraft(draftKey, value)) {
      currentDraft.current = value;
      setDraft(value);
    }
  }, [requests, draftKey, directory.snapshot?.workspace?.workspaceId]);

  async function submit() {
    if (
      busyRef.current ||
      patchSnapshot.busy ||
      !connected ||
      !directory.permissions?.contribute ||
      !checkout ||
      !taskContextAvailable ||
      !specialist ||
      initialDraft.error
    )
      return;
    if (
      !currentDraft.current.pending &&
      (!currentDraft.current.text.trim() || specialist.supersededAt)
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      let pending: SharedPendingRequest | null = currentDraft.current.pending;
      const participant = directory.snapshot?.participant;
      const workspace = directory.snapshot?.workspace;
      if (!participant || !workspace) throw new Error("Join this shared workspace before sending.");
      if (
        pending &&
        (pending.participantId !== participant.participantId ||
          pending.workspaceId !== workspace.workspaceId)
      )
        throw new Error(
          "This saved request belongs to a different workspace or participant. Reconnect the original account to retry it.",
        );
      if (
        pending &&
        (pending.context.checkoutId !== checkout.checkoutId ||
          (task
            ? pending.context.source.kind !== "thread" ||
              pending.context.source.threadId !== task.id
            : pending.context.source.kind !== "project_conversation"))
      )
        throw new Error(
          "This saved request belongs to a different local task or checkout. Open its original conversation to retry it.",
        );
      if (!pending) {
        const observed = await observeRevision({
          environmentId: checkout.localEnvironmentId,
          input: { projectId: checkout.localProjectId, ...(task ? { threadId: task.id } : {}) },
        });
        if (observed._tag === "Failure")
          throw new Error(formatEnvironmentQueryError(observed.cause));
        const sharedRevision = await patchSnapshot.resolveRevision(observed.value);
        const text = currentDraft.current.text.trim();
        const context: SharedWorkContextInput = {
          contextId: randomUUID(),
          checkoutId: checkout.checkoutId,
          source: task ? { kind: "thread", threadId: task.id } : { kind: "project_conversation" },
          objective: text,
          revision: sharedRevision,
          paths: [],
          tags: [],
        };
        pending = {
          requestId: randomUUID(),
          participantId: participant.participantId,
          workspaceId: workspace.workspaceId,
          context,
          contextVersion: null,
          text,
        };
        if (!writeDraft({ ...currentDraft.current, pending })) return;
      }
      const delivered = await deliverSharedRequest(pending, specialistId, {
        putContext: async (input) => {
          const result = await putContext({ environmentId: host.environmentId, input });
          if (result._tag === "Failure") throw new Error(formatEnvironmentQueryError(result.cause));
          return result.value;
        },
        persist: (bound) => writeDraft({ ...currentDraft.current, pending: bound }),
        send: async (input) => {
          const result = await send({ environmentId: host.environmentId, input });
          if (result._tag === "Failure") throw new Error(formatEnvironmentQueryError(result.cause));
          return result.value;
        },
      });
      if (delivered.outcome.status === "not_admitted") {
        setNotice(
          delivered.outcome.detail ?? "This request has not been sent. Retry the saved request.",
        );
        conversation.refresh();
        return;
      }
      writeDraft({
        text: currentDraft.current.text.trim() === pending.text ? "" : currentDraft.current.text,
        pending: null,
      });
      conversation.refresh();
      revision.refresh();
    } catch (error) {
      conversation.refresh();
      setNotice(
        error instanceof Error
          ? error.message
          : "The request could not be confirmed. Its saved delivery identity is retained.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function markRead(batchId: string) {
    if (inboxBusy || !connected) return;
    setInboxBusy(true);
    setInboxError(null);
    try {
      const result = await acknowledge({ environmentId: host.environmentId, input: { batchId } });
      if (result._tag === "Failure") setInboxError(formatEnvironmentQueryError(result.cause));
      else inbox.refresh();
    } finally {
      setInboxBusy(false);
    }
  }
  const label = specialist?.label ?? "Shared specialist";
  const status = sharedHostStatus(
    host.connection.phase,
    directory.snapshot !== null,
    directory.error,
    directory.isPending,
  );
  const activity = conversation.data?.activity;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron} className="border-b border-border">
        {checkout ? (
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0"
            aria-label={task ? "Back to task" : "Back to project"}
            onClick={() =>
              void navigate(
                task
                  ? {
                      to: "/$environmentId/$threadId",
                      params: { environmentId: checkout.localEnvironmentId, threadId: task.id },
                    }
                  : {
                      to: "/$environmentId/projects/$projectId/start",
                      params: {
                        environmentId: checkout.localEnvironmentId,
                        projectId: checkout.localProjectId,
                      },
                    },
              )
            }
          >
            <ArrowLeftIcon />
            {task ? "Back to task" : "Back to project"}
          </Button>
        ) : null}
        <BoxIcon className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{label}</h1>
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-foreground/75" />
            }
          >
            <ServerIcon className="size-3.5 shrink-0" />
            <span className="hidden max-w-32 truncate sm:inline">
              {directory.snapshot?.workspace?.name ?? host.label}
            </span>
          </TooltipTrigger>
          <TooltipPopup>{host.label}</TooltipPopup>
        </Tooltip>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh shared conversation"
          disabled={!directory.connected}
          onClick={() => {
            directory.refresh();
            conversation.refresh();
            inbox.refresh();
            revision.refresh();
          }}
        >
          <RefreshCwIcon />
        </Button>
      </WorkspacePageHeader>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-5 py-2 text-xs text-foreground/75">
        <span className="font-medium">{project?.title ?? "No local checkout selected"}</span>
        {checkoutThread ? (
          <>
            <span aria-hidden="true" className="text-muted-foreground">
              /
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="min-w-0 flex-1 basis-48 truncate font-medium text-foreground/90" />
                }
              >
                {task?.title ?? "Local task unavailable"}
              </TooltipTrigger>
              <TooltipPopup>{task?.title ?? "This local task is unavailable."}</TooltipPopup>
            </Tooltip>
          </>
        ) : null}
        {revision.data?.branch ? (
          <SharedRevisionLabel
            revision={{
              branch: revision.data.branch,
              commit: revision.data.commit,
              applicability: "branch",
            }}
          />
        ) : null}
        {revision.data?.dirty ? (
          <span className="text-warning-foreground">
            {patchSnapshot.snapshot ? "Shared snapshot selected" : "Uncommitted changes stay local"}
          </span>
        ) : null}
        <span className="ml-auto" role="status">
          {status}
        </span>
      </div>
      {checkoutThread && !taskContextAvailable ? (
        <p role="alert" className="border-b border-border px-5 py-2 text-xs text-destructive">
          This local task is unavailable. Reconnect its environment or open an existing task.
          Sending stays blocked until its checkout can be verified.
        </p>
      ) : null}
      {!connected ? (
        <p
          role="status"
          className="border-b border-border bg-muted/30 px-5 py-2 text-xs text-muted-foreground"
        >
          The shared host is unavailable. Your draft stays on this device. Reconnect to refresh
          requests and project updates.
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-5 py-4">
          <SharedActivityInbox
            environmentId={host.environmentId}
            inbox={inbox.data}
            snapshot={directory.snapshot}
            busy={inboxBusy || inbox.isPending}
            acknowledging={inboxBusy}
            offline={!connected}
            error={inboxError ?? inbox.error}
            onRefresh={inbox.refresh}
            onAcknowledge={(id) => void markRead(id)}
          />
          <SharedCompositionHistory
            environmentId={host.environmentId}
            specialistId={specialistId}
            snapshot={directory.snapshot}
            connected={connected}
          />
          {conversation.error ? (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {conversation.error}
            </p>
          ) : null}
          {!requests.length ? (
            <div className="py-16 text-center">
              <BoxIcon className="mx-auto mb-3 size-7 text-muted-foreground" />
              <h2 className="text-lg font-medium">
                {!connected
                  ? "Shared host unavailable"
                  : conversation.isPending
                    ? "Loading requests..."
                    : `Work with ${label}`}
              </h2>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                {!connected
                  ? "Reconnect to read this specialist's requests and activity. Your local draft is preserved."
                  : "Requests from every participant keep their own project and revision. Each result appears with the request it answers."}
              </p>
            </div>
          ) : (
            requests.map((request) => (
              <SharedRequestCard
                key={request.requestId}
                request={request}
                specialistLabel={label}
                onRetry={
                  request.outcome.status === "not_admitted" &&
                  connected &&
                  directory.permissions?.contribute &&
                  !busy &&
                  (!draft.pending || draft.pending.requestId === request.clientRequestId) &&
                  request.author.participantId === directory.snapshot?.participant?.participantId &&
                  request.context.checkoutId === checkout?.checkoutId &&
                  (task
                    ? request.context.source.kind === "thread" &&
                      request.context.source.threadId === task.id
                    : request.context.source.kind === "project_conversation")
                    ? () => {
                        if (busyRef.current || !directory.snapshot?.workspace) return;
                        if (
                          writeDraft({
                            text: currentDraft.current.text || request.text,
                            pending: {
                              requestId: request.clientRequestId,
                              participantId: request.author.participantId,
                              workspaceId: directory.snapshot.workspace.workspaceId,
                              context: {
                                ...request.context,
                                source: task
                                  ? { kind: "thread", threadId: task.id }
                                  : { kind: "project_conversation" },
                              },
                              contextVersion: request.context.contextVersion,
                              text: request.text,
                            },
                          })
                        )
                          void submit();
                      }
                    : undefined
                }
                projectLabel={
                  directory.snapshot?.projects.find(
                    (entry) => entry.sharedProjectId === request.context.sharedProjectId,
                  )?.name ?? "Shared project"
                }
              />
            ))
          )}
          {activity?.transcript ? (
            <details className="my-4 border-t border-border pt-3 text-xs text-muted-foreground">
              <summary className="cursor-pointer text-foreground/75">Specialist activity</summary>
              <p className="my-3">
                Includes peer and scheduled activity. Only the evidence attached to a request above
                establishes its result.
              </p>
              {!activity.transcript.exhausted ? (
                <p className="mb-3">Showing the most recent messages.</p>
              ) : null}
              <div className="space-y-4">
                {activity.transcript.messages.flatMap(({ offset, message }) => {
                  const view = savedMessageView(message, label);
                  if (!view) return [];
                  const occurrences = new Map<string, number>();
                  const parts = view.parts.map((part) => {
                    const content = JSON.stringify(part);
                    const occurrence = occurrences.get(content) ?? 0;
                    occurrences.set(content, occurrence + 1);
                    return { key: `${offset}:${content}:${occurrence}`, part };
                  });
                  return [
                    <article key={offset} className="space-y-1">
                      <p className="font-medium">{view.label}</p>
                      {parts.map(({ part, key }) =>
                        part.kind === "text" ? (
                          <SharedMarkdown key={key} text={part.text} />
                        ) : (
                          <details key={key}>
                            <summary className="cursor-pointer">
                              {part.kind === "reasoning"
                                ? "Reasoning"
                                : part.kind === "image"
                                  ? "Image reference"
                                  : part.label}
                            </summary>
                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all">
                              {JSON.stringify(part, null, 2)}
                            </pre>
                          </details>
                        ),
                      )}
                    </article>,
                  ];
                })}
              </div>
            </details>
          ) : null}
          {conversation.data?.activityError ? (
            <p className="my-3 text-xs text-muted-foreground">
              Specialist activity is unavailable. Request outcomes above retain their own evidence.
            </p>
          ) : null}
        </div>
      </div>
      <div className="shrink-0 px-5 pb-5 pt-2">
        <div className="mx-auto max-w-3xl">
          {specialist?.supersededAt ? (
            <p className="mb-2 text-xs text-muted-foreground">
              This specialist is superseded for new assignments. Existing requests and their
              original owner remain available.
            </p>
          ) : null}
          {!checkout ? (
            <p className="mb-2 text-xs text-muted-foreground">
              Open this specialist from an attached local project to send a request.
            </p>
          ) : null}
          {notice ? (
            <p role="alert" className="mb-2 text-xs text-destructive">
              {notice}
            </p>
          ) : null}
          {draft.pending ? (
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <p role="status" className="min-w-0 flex-1">
                {unsentPending
                  ? "This saved request has not been sent. Retrying keeps its original message and revision."
                  : "A saved request is awaiting confirmation. Retrying keeps the same request and revision."}
              </p>
              {unsentPending ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (busyRef.current) return;
                    if (writeDraft({ text: currentDraft.current.text, pending: null })) {
                      setNotice(
                        "The unsent request stays in this conversation. Your next send will use a new request and the current revision.",
                      );
                    }
                  }}
                >
                  Edit as new request
                </Button>
              ) : null}
            </div>
          ) : null}
          {checkout && taskContextAvailable && !draft.pending ? (
            <div className="mb-3">
              <SharedSnapshotPanel
                state={patchSnapshot}
                destination={directory.snapshot?.workspace?.name ?? host.label}
                maxBytes={directory.snapshot?.workspace?.limits.maxSnapshotBytes ?? 0}
                disabled={busy || !connected || !directory.permissions?.contribute}
              />
            </div>
          ) : null}
          <form
            className="rounded-2xl border border-border bg-card p-3 shadow-sm"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <textarea
              aria-label={`Message ${label}`}
              placeholder="Ask about your project..."
              className="min-h-20 max-h-48 w-full resize-none bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted-foreground"
              value={draft.text}
              disabled={Boolean(initialDraft.error)}
              onChange={(event) => {
                const next = { ...currentDraft.current, text: event.target.value };
                setDraft(next);
                currentDraft.current = next;
                if (!saveSharedDraft(draftKey, next))
                  setNotice(
                    "Your draft could not be saved on this device. Copy it before leaving.",
                  );
              }}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="flex items-center gap-3">
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                {directory.snapshot?.participant?.displayName
                  ? `Sending as ${directory.snapshot.participant.displayName}`
                  : "Join this workspace to send"}
              </p>
              <Button
                type="submit"
                size={draft.pending ? "sm" : "icon-sm"}
                disabled={
                  busy ||
                  patchSnapshot.busy ||
                  !connected ||
                  !directory.permissions?.contribute ||
                  !checkout ||
                  !taskContextAvailable ||
                  Boolean(initialDraft.error) ||
                  (!draft.pending && (!draft.text.trim() || Boolean(specialist?.supersededAt)))
                }
                aria-label={draft.pending ? "Retry saved request" : `Send to ${label}`}
              >
                {draft.pending ? "Retry saved request" : <ArrowUpIcon />}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </SidebarInset>
  );
}

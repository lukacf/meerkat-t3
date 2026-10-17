import { MeerkatWorkspaceCheckpoints } from "./MeerkatWorkspaceCheckpoints";
import { SharedTaskCollaboration } from "./SharedTaskCollaboration";
import type {
  EnvironmentId,
  MeerkatThreadConnections,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { BotIcon, ChevronDownIcon, LinkIcon, UsersIcon } from "lucide-react";
import { useImperativeHandle, useRef, useState, type Ref } from "react";

import { randomUUID } from "../../lib/utils";
import { meerkatTeamEnvironment, useVisibleTeamRefresh } from "../../state/meerkatTeam";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import {
  latestThreadConnections,
  selectableThreadProjectAgents,
  visibleThreadProjectAgents,
} from "./threadAgentConnections.logic";
import { MeerkatResumeAgentButton } from "./MeerkatResumeAgentButton";
import { MeerkatAgentWorkLabel } from "./MeerkatActivityOverview";
import { MeerkatPeerConnectionsBar } from "./MeerkatPeerConnections";
import { useProjects, useThreadShells } from "../../state/entities";
import { readRestoreReviewWorkBlock, useRestoreReviewWorkBlock } from "./useRestoreReview";

export interface ThreadAgentsBarHandle {
  prepareToSend: () => Promise<void>;
}

export interface ThreadAgentsBarProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  instanceId: ProviderInstanceId;
  threadId: ThreadId;
  isDraft: boolean;
  disabled?: boolean;
  activeMemberOverride?: string | null;
  onMemberChange?: (member: string | null) => void;
  ref?: Ref<ThreadAgentsBarHandle>;
}

export function ThreadAgentsBar({
  environmentId,
  projectId,
  instanceId,
  threadId,
  isDraft,
  disabled = false,
  ref,
  activeMemberOverride,
  onMemberChange,
}: ThreadAgentsBarProps) {
  const navigate = useNavigate();
  const restoreBlock = useRestoreReviewWorkBlock(environmentId);
  const projectTitle =
    useProjects().find(
      (project) => project.environmentId === environmentId && project.id === projectId,
    )?.title ?? "Project";
  const threadTitle =
    useThreadShells().find(
      (thread) => thread.environmentId === environmentId && thread.id === threadId,
    )?.title ?? "Thread";
  const routeMember = useLocation({
    select: (location) => new URLSearchParams(location.searchStr).get("member"),
  });
  const activeMember = activeMemberOverride !== undefined ? activeMemberOverride : routeMember;
  const [membersOpen, setMembersOpen] = useState(false);
  const query = useEnvironmentQuery(
    meerkatTeamEnvironment.projectTeam({ environmentId, input: { projectId } }),
  );
  useVisibleTeamRefresh(query, !isDraft);
  const connections = useEnvironmentQuery(
    meerkatTeamEnvironment.threadConnections({
      environmentId,
      input: { projectId, threadId, instanceId },
    }),
  );
  useVisibleTeamRefresh(connections, true);
  const setConnections = useAtomCommand(meerkatTeamEnvironment.threadConnectionsSet, {
    reportFailure: false,
  });
  const [manageOpen, setManageOpen] = useState(false);
  const [selection, setSelection] = useState<ReadonlyArray<string>>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [applied, setApplied] = useState<{ value: MeerkatThreadConnections; at: number } | null>(
    null,
  );
  const pendingSave = useRef<Promise<void> | null>(null);
  const errorRef = useRef<string | null>(null);
  useImperativeHandle(
    ref,
    () => ({
      prepareToSend: async () => {
        await pendingSave.current;
        if (errorRef.current) throw new Error(errorRef.current);
      },
    }),
    [],
  );
  const connectionState = latestThreadConnections(
    connections.data,
    connections.dataUpdatedAt,
    applied,
  );
  const desiredIds = connectionState?.desiredAgentIds ?? [];
  const projectAgents =
    query.data?.projectAgents.filter((agent) => agent.instanceId === instanceId) ?? [];
  const selectedAgents = visibleThreadProjectAgents(connectionState, projectAgents);
  const visibleChoices = selectableThreadProjectAgents(projectAgents, selection);
  const applySelection = (agentIds: ReadonlyArray<string>) => {
    if (pendingSave.current) return;
    const workBlock = agentIds.length > 0 ? readRestoreReviewWorkBlock(environmentId) : null;
    if (workBlock) {
      setSaveError(workBlock);
      errorRef.current = workBlock;
      return;
    }
    setSaving(true);
    setSaveError(null);
    errorRef.current = null;
    const operation = (async () => {
      const result = await setConnections({
        environmentId,
        input: { projectId, threadId, instanceId, agentIds, requestId: randomUUID() },
      });
      if (result._tag === "Failure") {
        const message =
          "Could not save the thread's project agents. Retry the selection before sending.";
        setSaveError(message);
        errorRef.current = message;
        return;
      }
      setApplied({ value: result.value, at: Date.now() });
      setManageOpen(false);
      connections.refresh();
      query.refresh();
    })()
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Could not save project agents.";
        setSaveError(message);
        errorRef.current = message;
      })
      .finally(() => {
        pendingSave.current = null;
        setSaving(false);
      });
    pendingSave.current = operation;
  };
  const provider = query.data?.providers.find((candidate) => candidate.instanceId === instanceId);
  const members = provider?.agents.filter((agent) => agent.threadId === threadId) ?? [];
  const workers = members.filter(
    (agent) =>
      agent.record.labels.source_mob_id !== undefined ||
      agent.record.labels.spawned_by !== undefined,
  );
  const selectMember = (member?: string) => {
    setMembersOpen(false);
    if (onMemberChange) {
      onMemberChange(member ?? null);
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
      search: member ? { member } : {},
    });
  };
  return (
    <div
      className="@container/thread-agents min-w-0 shrink-0 border-b border-border/60"
      aria-label="Thread agents"
    >
      <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-2 px-3 py-0.5">
        {!isDraft ? (
          <Popover open={membersOpen} onOpenChange={setMembersOpen}>
            <PopoverTrigger render={<Button variant="ghost-muted" size="xs" />}>
              <UsersIcon />
              <span className="max-w-[min(8rem,22cqw)] truncate">
                {activeMember
                  ? (workers.find((agent) => agent.agentRef === activeMember)?.record
                      .display_name ?? "Worker")
                  : "Coordinator"}
              </span>
              {workers.length > 0 ? (
                <span className="text-muted-foreground">+ {workers.length}</span>
              ) : null}
              <ChevronDownIcon />
            </PopoverTrigger>
            <PopoverPopup width="md" align="start">
              <PopoverTitle>Thread agents</PopoverTitle>
              <div className="mt-3 max-h-80 space-y-1 overflow-y-auto">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent"
                  aria-current={!activeMember ? "page" : undefined}
                  onClick={() => selectMember()}
                >
                  <UsersIcon className="size-4 text-muted-foreground" />
                  Coordinator
                </button>
                {workers.map((agent) => (
                  <div key={agent.agentRef} className="rounded-md border border-border/60 p-2">
                    <button
                      type="button"
                      className="flex w-full min-w-0 items-center gap-2 text-left text-sm hover:text-primary"
                      aria-current={activeMember === agent.agentRef ? "page" : undefined}
                      onClick={() => selectMember(agent.agentRef)}
                    >
                      <BotIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 break-words">
                        {agent.record.display_name}
                      </span>
                      <MeerkatAgentWorkLabel agent={agent} />
                    </button>
                    <MeerkatResumeAgentButton
                      environmentId={environmentId}
                      projectId={projectId}
                      instanceId={instanceId}
                      agent={agent}
                      onResumed={query.refresh}
                      disabled={disabled || Boolean(query.error) || provider?.status === "disabled"}
                    />
                  </div>
                ))}
                {workers.length === 0 ? (
                  <p className="px-2 py-2 text-xs text-muted-foreground">
                    Workers appear here when the coordinator starts them.
                  </p>
                ) : null}
                {provider?.status === "partial" ? (
                  <p role="status" className="px-2 text-xs text-muted-foreground">
                    Some agents are unavailable.
                  </p>
                ) : null}
              </div>
            </PopoverPopup>
          </Popover>
        ) : (
          <Popover
            open={manageOpen}
            onOpenChange={(open) => {
              if (saving || disabled) return;
              if (open) {
                setSelection([...desiredIds]);
                query.refresh();
              }
              setManageOpen(open);
            }}
          >
            <PopoverTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="xs"
                  disabled={saving || disabled || connectionState === null}
                />
              }
            >
              <LinkIcon />
              {saving
                ? "Saving..."
                : selectedAgents.length > 0
                  ? `${selectedAgents.length} project ${selectedAgents.length === 1 ? "agent" : "agents"}`
                  : connectionState === null
                    ? "Loading agents..."
                    : "Solo"}
              <ChevronDownIcon />
            </PopoverTrigger>
            <PopoverPopup width="md" align="start">
              <PopoverTitle>Project agents</PopoverTitle>
              <p className="mt-2 text-xs text-muted-foreground">
                Selected agents join this thread when you send its first message.
              </p>
              {restoreBlock && selection.length > 0 ? (
                <p role="status" className="mt-2 text-xs text-muted-foreground">
                  {restoreBlock}
                </p>
              ) : null}
              <div className="my-3 flex max-h-64 flex-col gap-3 overflow-y-auto">
                {query.error ? (
                  <div className="flex items-center gap-2">
                    <p role="status" className="flex-1 text-xs text-destructive">
                      Project agents unavailable.
                    </p>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={query.isPending}
                      onClick={query.refresh}
                    >
                      Retry
                    </Button>
                  </div>
                ) : null}
                {query.data === null ? (
                  query.error ? null : (
                    <p role="status" className="text-sm text-muted-foreground">
                      Loading project agents...
                    </p>
                  )
                ) : visibleChoices.length === 0 && !query.error ? (
                  <p className="text-sm text-muted-foreground">
                    Add an agent to this project to connect it here.
                  </p>
                ) : (
                  visibleChoices.map((agent) => (
                    <label key={agent.agentId} className="flex cursor-pointer items-start gap-2.5">
                      <Checkbox
                        checked={selection.includes(agent.agentId)}
                        disabled={
                          saving ||
                          disabled ||
                          Boolean(query.error) ||
                          ((!agent.enabled || agent.archived) &&
                            !selection.includes(agent.agentId)) ||
                          (!selection.includes(agent.agentId) && selection.length >= 8)
                        }
                        onCheckedChange={(checked) =>
                          setSelection((value) =>
                            checked
                              ? [...value, agent.agentId]
                              : value.filter((id) => id !== agent.agentId),
                          )
                        }
                      />
                      <span className="min-w-0">
                        <span className="block break-words text-sm font-medium">{agent.label}</span>
                        <span className="block text-xs text-muted-foreground">
                          {agent.role}
                          {agent.archived ? " · Archived" : !agent.enabled ? " · Disabled" : ""}
                        </span>
                      </span>
                    </label>
                  ))
                )}
              </div>
              {visibleChoices.length > 8 ? (
                <p className="mb-2 text-xs text-muted-foreground">Choose up to 8 agents.</p>
              ) : null}
              <div className="flex items-center justify-between gap-2">
                <Button
                  variant="ghost-muted"
                  size="sm"
                  disabled={saving || disabled || selection.length === 0}
                  onClick={() => setSelection([])}
                >
                  Clear
                </Button>
                <div className="flex gap-2">
                  <Button
                    variant="ghost-muted"
                    size="sm"
                    disabled={saving || disabled}
                    onClick={() => setManageOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={saving || disabled || (selection.length > 0 && Boolean(restoreBlock))}
                    title={selection.length > 0 ? (restoreBlock ?? undefined) : undefined}
                    onClick={() => applySelection(selection)}
                  >
                    Apply
                  </Button>
                </div>
              </div>
            </PopoverPopup>
          </Popover>
        )}
        {!isDraft ? (
          <MeerkatPeerConnectionsBar
            inline
            disabled={disabled}
            item={{
              environmentId,
              endpoint: { kind: "thread", projectId, threadId, instanceId },
              instanceId,
              label: threadTitle,
              projectTitle,
            }}
          />
        ) : selectedAgents.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" />}
            >
              {selectedAgents.map((agent) => agent.label).join(", ")}
            </TooltipTrigger>
            <TooltipPopup>{selectedAgents.map((agent) => agent.label).join(", ")}</TooltipPopup>
          </Tooltip>
        ) : null}
        {isDraft && desiredIds.length > 0 ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={saving || disabled}
            onClick={() => applySelection([])}
          >
            Start solo
          </Button>
        ) : null}
        {!isDraft && !activeMember ? (
          <MeerkatWorkspaceCheckpoints
            environmentId={environmentId}
            target={{ projectId, instanceId, threadId }}
          />
        ) : null}
        {!activeMember ? (
          <SharedTaskCollaboration
            environmentId={environmentId}
            projectId={projectId}
            threadId={threadId}
            isDraft={isDraft}
          />
        ) : null}
        {query.error || connections.error ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className="ml-auto size-1.5 shrink-0 rounded-full bg-warning"
                  role="status"
                  aria-label={query.error ? "Team unavailable" : "Connections unavailable"}
                />
              }
            />
            <TooltipPopup>{query.error ?? connections.error}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {saveError ? (
        <p className="px-4 pb-2 text-xs text-destructive" role="alert">
          {saveError}
        </p>
      ) : null}
    </div>
  );
}

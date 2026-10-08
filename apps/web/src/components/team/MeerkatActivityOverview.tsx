import { useMeerkatAttention } from "../../state/meerkatAttention";
import { attentionLabel, nativeAttentionDestination } from "./meerkatAttention.logic";
import type { EnvironmentId, MeerkatTeamAgent, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ActivityIcon, CircleIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { meerkatTeamEnvironment, useVisibleTeamRefresh } from "../../state/meerkatTeam";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { meerkatWorkStatus } from "./meerkatWork.logic";

export function MeerkatAgentWorkLabel({ agent }: { agent: MeerkatTeamAgent }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const status = meerkatWorkStatus(agent, now);
  return (
    <span
      className="inline-flex items-center gap-1 text-2xs text-muted-foreground"
      aria-label={`${agent.record.display_name}: ${status}`}
    >
      {status === "Working" ? (
        <LoaderCircleIcon className="size-3 animate-spin" />
      ) : (
        <CircleIcon className="size-2" />
      )}
      {status}
    </span>
  );
}

const NO_OBSERVED_AGENTS: ReadonlyArray<MeerkatTeamAgent> = [];

/** Compact project work view. Native jobs expose their own objective/outcome when available. */
export function MeerkatActivityOverview({
  environmentId,
  projectId,
  observedAgents = NO_OBSERVED_AGENTS,
}: {
  observedAgents?: ReadonlyArray<MeerkatTeamAgent>;
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const attention = useMeerkatAttention(environmentId, projectId);
  const needsAttention = attention.data?.items ?? [];
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [open]);
  const query = useEnvironmentQuery(
    open ? meerkatTeamEnvironment.projectTeam({ environmentId, input: { projectId } }) : null,
  );
  useVisibleTeamRefresh(query, open);
  const agents = query.data?.providers.flatMap((provider) => provider.agents) ?? observedAgents;
  const working = agents.filter((agent) => meerkatWorkStatus(agent, now) === "Working");
  const openAgent = (agent: MeerkatTeamAgent) => {
    if (agent.threadId)
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: agent.threadId },
        search:
          agent.record.labels.source_mob_id || agent.record.labels.spawned_by
            ? { member: agent.agentRef }
            : {},
      });
    else if (agent.projectAgentId)
      void navigate({
        to: "/$environmentId/agents/$agentId",
        params: { environmentId, agentId: agent.projectAgentId },
        search: {
          project: projectId,
          ...(agent.record.labels.source_mob_id ? { member: agent.agentRef } : {}),
        },
      });
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size="xs" variant="ghost-muted" aria-label="Project work" />}>
        <ActivityIcon />{" "}
        {needsAttention.length > 0
          ? `${attentionLabel(needsAttention)} (${needsAttention.length})`
          : `Work${working.length > 0 ? ` (${working.length})` : ""}`}
      </PopoverTrigger>
      <PopoverPopup width="md" align="start">
        <PopoverTitle>Project work</PopoverTitle>
        {attention.error ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            Could not refresh agent attention.{" "}
            <button type="button" className="underline" onClick={attention.refresh}>
              Retry
            </button>
          </p>
        ) : null}
        {needsAttention.length > 0 ? (
          <div
            className="mt-2 max-h-60 space-y-1 overflow-y-auto border-b pb-2"
            aria-label="Needs attention"
          >
            {needsAttention.map((item) => {
              const target = nativeAttentionDestination(environmentId, item);
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={!target}
                  onClick={() => target && void navigate(target)}
                  className="flex w-full flex-col rounded px-2 py-2 text-left hover:bg-accent"
                >
                  <span className="text-xs font-medium">
                    {item.label} · {item.title}
                  </span>
                  {item.detail ? (
                    <span className="line-clamp-2 text-2xs text-muted-foreground">
                      {item.detail}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
        {query.error ? (
          <p className="mt-2 text-xs text-destructive">Could not refresh native work status.</p>
        ) : null}
        <div className="mt-2 max-h-80 space-y-1 overflow-y-auto">
          {[...agents]
            .sort(
              (a, b) => Number(b.work?.status === "running") - Number(a.work?.status === "running"),
            )
            .map((agent) => (
              <button
                key={agent.agentRef}
                type="button"
                className="flex w-full flex-col gap-1 rounded px-2 py-2 text-left hover:bg-accent disabled:cursor-default"
                disabled={!agent.threadId && !agent.projectAgentId}
                onClick={() => openAgent(agent)}
              >
                <span className="flex w-full items-center justify-between gap-3">
                  <span className="truncate text-xs font-medium">{agent.record.display_name}</span>
                  <MeerkatAgentWorkLabel agent={agent} />
                </span>
                <span className="text-2xs text-muted-foreground">{agent.mobLabel}</span>
                {agent.work?.objective ? (
                  <span className="line-clamp-2 text-xs">{agent.work.objective}</span>
                ) : null}
                {agent.work?.outcome ? (
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {agent.work.outcome}
                  </span>
                ) : null}
              </button>
            ))}
          {agents.length === 0 ? (
            <p className="py-3 text-xs text-muted-foreground">
              {query.isPending ? "Reading native agents..." : "No native agents observed yet."}
            </p>
          ) : null}
        </div>
        <p className="mt-2 text-2xs text-muted-foreground">
          Unloaded agents retain their conversation history. Open their owning conversation to
          reconnect.
        </p>
      </PopoverPopup>
    </Popover>
  );
}

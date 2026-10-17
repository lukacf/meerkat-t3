import { useMeerkatAttention } from "../../state/meerkatAttention";
import { attentionLabel, nativeAttentionDestination } from "../team/meerkatAttention.logic";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { MeerkatProjectAgent, MeerkatTeamAgent, ScopedProjectRef } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ArchiveIcon, BoxIcon, ChevronDownIcon, LinkIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { MeerkatActivityOverview } from "../team/MeerkatActivityOverview";
import { meerkatWorkStatus } from "../team/meerkatWork.logic";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { meerkatTeamEnvironment, useVisibleTeamRefresh } from "../../state/meerkatTeam";
import { useEnvironmentQuery } from "../../state/query";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useMeerkatPeerConnections, useMeerkatPeerDrag } from "../team/MeerkatPeerConnections";
import { sidebarCheckoutLabel } from "./sidebarProjectCheckouts";
import { SharedProjectAgentRows } from "./SharedProjectAgentRows";

function AgentRow({
  agent,
  project,
  active,
  open,
  nativeAgent,
  now,
  attention,
}: {
  agent: MeerkatProjectAgent;
  project: EnvironmentProject;
  active: boolean;
  open: () => void;
  nativeAgent?: MeerkatTeamAgent | undefined;
  now: number;
  attention: string | null;
}) {
  const item = {
    environmentId: project.environmentId,
    endpoint: {
      kind: "project-agent" as const,
      projectId: project.id,
      agentId: agent.agentId,
      instanceId: agent.instanceId,
    },
    instanceId: agent.instanceId,
    label: agent.label,
    projectTitle: project.title,
  };
  const { dragProps, isDropTarget } = useMeerkatPeerDrag(agent.enabled ? item : null);
  const peers = useMeerkatPeerConnections();
  const status =
    attention ??
    (agent.error
      ? "Needs attention"
      : !agent.enabled
        ? "Disabled"
        : nativeAgent
          ? meerkatWorkStatus(nativeAgent, now)
          : agentStatus(agent));
  return (
    <SidebarMenuItem {...dragProps} className="group/agent relative">
      <SidebarMenuButton
        size="default"
        isActive={active || isDropTarget}
        onClick={open}
        aria-label={`${agent.label}, ${status}`}
        tooltip={{
          children: `${agent.label} · ${status}. Drag onto an agent or thread to connect.`,
          hidden: false,
        }}
      >
        <BoxIcon />
        <span className={`min-w-0 flex-1 truncate ${attention ? "font-semibold" : ""}`}>
          {agent.label}
        </span>
        <span
          className={`mr-5 size-1.5 shrink-0 rounded-full ${status === "Working" || status === "Unread" ? "bg-primary" : status === "Needs attention" || status === "Needs input" ? "bg-warning" : status === "Idle" ? "bg-success/70" : "bg-muted-foreground/35"}`}
          aria-hidden="true"
        />
      </SidebarMenuButton>
      <button
        type="button"
        aria-label={`Connections for ${agent.label}`}
        onClick={() => peers?.choosePeer(item)}
        className="absolute right-1 top-1.5 rounded p-1 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/agent:opacity-100 max-sm:opacity-100"
      >
        <LinkIcon className="size-3" />
      </button>
    </SidebarMenuItem>
  );
}

function agentStatus(agent: MeerkatProjectAgent) {
  if (agent.connectionStatus === "error") return "Needs attention";
  if (!agent.enabled) return "Disabled";
  return "Saved project agent";
}

function ProjectAgentRows({
  project,
  showProject,
  environmentLabel,
  visible,
}: {
  project: EnvironmentProject;
  showProject: boolean;
  environmentLabel: string | null;
  visible: boolean;
}) {
  const attention = useMeerkatAttention(project.environmentId, project.id);
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const location = useLocation();
  const checkoutLabel = sidebarCheckoutLabel({ ...project, environmentLabel });
  const [expanded, setExpanded] = useState(true);
  const observing = visible && expanded;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!observing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [observing]);
  const query = useEnvironmentQuery(
    visible
      ? meerkatTeamEnvironment.projectTeam({
          environmentId: project.environmentId,
          input: { projectId: project.id },
        })
      : null,
  );
  useVisibleTeamRefresh(query, observing);
  const agents = query.data?.projectAgents.filter((agent) => !agent.archived) ?? [];
  const archivedAgents = query.data?.projectAgents.filter((agent) => agent.archived) ?? [];
  const currentSearch = new URLSearchParams(location.searchStr);
  const openAgent = (agent?: string) => {
    if (isMobile) setOpenMobile(false);
    if (agent) {
      void navigate({
        to: "/$environmentId/agents/$agentId",
        params: { environmentId: project.environmentId, agentId: agent },
        search: { project: project.id },
      });
    } else {
      void navigate({
        to: "/$environmentId/projects/$projectId/agents/new",
        params: { environmentId: project.environmentId, projectId: project.id },
      });
    }
  };
  if (!visible) return null;
  return (
    <div className="min-w-0" data-project-agents={project.id}>
      <div className="flex min-w-0 items-center justify-between gap-2 px-2 pb-1 pt-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="flex min-w-0 items-center gap-1 text-2xs font-medium text-sidebar-muted-foreground hover:text-sidebar-foreground"
                aria-expanded={expanded}
                aria-label={`${expanded ? "Collapse" : "Expand"} project agents${showProject ? ` in ${checkoutLabel}` : ""}`}
                onClick={() => setExpanded((value) => !value)}
              />
            }
          >
            <ChevronDownIcon
              className={`size-3 shrink-0 transition-transform ${expanded ? "" : "-rotate-90"}`}
            />
            {showProject ? (
              <span className="min-w-0 text-left">
                <span className="block truncate text-left" dir="rtl">
                  <bdi>{project.workspaceRoot}</bdi>
                </span>
                <span className="block truncate text-3xs font-normal">
                  {environmentLabel?.trim() || project.environmentId}
                </span>
              </span>
            ) : (
              <span className="truncate">Agents</span>
            )}
            {agents.length > 0 ? (
              <span className="font-normal opacity-70">{agents.length}</span>
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="right">{checkoutLabel}</TooltipPopup>
        </Tooltip>
        <MeerkatActivityOverview
          environmentId={project.environmentId}
          projectId={project.id}
          observedAgents={query.data?.providers.flatMap((provider) => provider.agents) ?? []}
        />
      </div>
      {expanded ? (
        <SidebarMenu>
          {agents.map((agent) => (
            <AgentRow
              key={agent.agentId}
              agent={agent}
              project={project}
              now={now}
              attention={attentionLabel(
                attention.data?.items.filter(
                  (item) =>
                    item.projectAgentId === agent.agentId && item.instanceId === agent.instanceId,
                ) ?? [],
              )}
              nativeAgent={query.data?.providers
                .flatMap((provider) => provider.agents)
                .find(
                  (native) =>
                    native.projectAgentId === agent.agentId && !native.record.labels.source_mob_id,
                )}
              active={
                location.pathname === `/${project.environmentId}/agents/${agent.agentId}` &&
                currentSearch.get("project") === project.id
              }
              open={() => {
                const items =
                  attention.data?.items.filter(
                    (item) =>
                      item.projectAgentId === agent.agentId && item.instanceId === agent.instanceId,
                  ) ?? [];
                const item =
                  items.find((entry) => entry.kind === "question" || entry.kind === "approval") ??
                  items.find((entry) => entry.kind.endsWith("error")) ??
                  items[0];
                const destination = item
                  ? nativeAttentionDestination(project.environmentId, item)
                  : null;
                if (destination) {
                  if (isMobile) setOpenMobile(false);
                  void navigate(destination);
                } else openAgent(agent.agentId);
              }}
            />
          ))}
          {query.error ? (
            <li className="px-2 py-1 text-xs text-destructive" role="status">
              Agents unavailable
            </li>
          ) : null}
          {query.isPending && query.data === null ? (
            <li className="px-2 py-1 text-xs text-muted-foreground">Loading agents...</li>
          ) : null}
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              onClick={() => openAgent()}
              aria-label={showProject ? `Add agent in ${checkoutLabel}` : undefined}
            >
              <PlusIcon />
              <span>Add agent</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {archivedAgents.length > 0 ? (
            <SidebarMenuItem>
              <details>
                <summary className="cursor-pointer px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
                  Show archived agents ({archivedAgents.length})
                </summary>
                <SidebarMenu>
                  {archivedAgents.map((agent) => (
                    <SidebarMenuItem key={agent.agentId}>
                      <SidebarMenuButton
                        size="sm"
                        isActive={
                          location.pathname ===
                            `/${project.environmentId}/agents/${agent.agentId}` &&
                          currentSearch.get("project") === project.id
                        }
                        onClick={() => openAgent(agent.agentId)}
                        tooltip={`Open ${agent.label} to restore this agent`}
                      >
                        <ArchiveIcon />
                        <span className="min-w-0 flex-1 truncate">{agent.label}</span>
                        <span className="text-3xs font-normal opacity-70">Archived</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </details>
            </SidebarMenuItem>
          ) : null}
        </SidebarMenu>
      ) : null}
    </div>
  );
}

/** Saved agents have their own conversations and never become duplicate thread rows. */
export function MeerkatProjectAgents({
  projectRefs,
  visible = true,
}: {
  projectRefs: ReadonlyArray<ScopedProjectRef>;
  visible?: boolean;
}) {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const supportedEnvironments = new Set(
    environments
      .filter((environment) =>
        environment.serverConfig?.providers.some((provider) => provider.driver === "meerkat"),
      )
      .map((environment) => environment.environmentId),
  );
  const visibleProjects = projects.filter(
    (project) =>
      supportedEnvironments.has(project.environmentId) &&
      projectRefs.some(
        (ref) => ref.environmentId === project.environmentId && ref.projectId === project.id,
      ),
  );
  return (
    <div className="pl-4" role="group" aria-label="Agents">
      <SharedProjectAgentRows projectRefs={projectRefs} visible={visible} />
      {visibleProjects.map((project) => (
        <ProjectAgentRows
          key={`${project.environmentId}:${project.id}`}
          project={project}
          showProject={visibleProjects.length > 1}
          environmentLabel={
            environments.find((environment) => environment.environmentId === project.environmentId)
              ?.label ?? null
          }
          visible={visible}
        />
      ))}
    </div>
  );
}

function ProjectAttention({ projectRef }: { projectRef: ScopedProjectRef }) {
  const attention = useMeerkatAttention(projectRef.environmentId, projectRef.projectId);
  const label = attentionLabel(attention.data?.items ?? []);
  if (!label && !attention.error) return null;
  const status = label ?? "Attention unavailable";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="shrink-0" role="status">
            <span
              className={`block size-1.5 rounded-full ${status === "Unread" ? "bg-primary" : "bg-warning"}`}
              aria-hidden="true"
            />
            <span className="sr-only">{status}</span>
          </span>
        }
      />
      <TooltipPopup side="right">{status}</TooltipPopup>
    </Tooltip>
  );
}

/** Lightweight attention remains visible while the full project body is collapsed. */
export function MeerkatProjectAttention({
  projectRefs,
}: {
  projectRefs: readonly ScopedProjectRef[];
}) {
  const { environments } = useEnvironments();
  const supported = new Set(
    environments
      .filter((environment) =>
        environment.serverConfig?.providers.some((provider) => provider.driver === "meerkat"),
      )
      .map((environment) => environment.environmentId),
  );
  return projectRefs
    .filter((ref) => supported.has(ref.environmentId))
    .map((projectRef) => (
      <ProjectAttention
        key={`${projectRef.environmentId}:${projectRef.projectId}`}
        projectRef={projectRef}
      />
    ));
}

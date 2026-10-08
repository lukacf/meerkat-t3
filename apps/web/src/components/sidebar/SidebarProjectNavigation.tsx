import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { EllipsisIcon, PlusIcon } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { sidebarCheckoutLabel } from "./sidebarProjectCheckouts";

type CheckoutProject = Pick<
  SidebarProjectGroupMember,
  "environmentId" | "id" | "environmentLabel" | "workspaceRoot"
>;

function CheckoutMenuItem({
  project,
  action,
  onSelect,
}: {
  project: CheckoutProject;
  action: string;
  onSelect: (project: ScopedProjectRef) => void;
}) {
  return (
    <MenuItem
      aria-label={`${action} ${sidebarCheckoutLabel(project)}`}
      onClick={() => onSelect(scopeProjectRef(project.environmentId, project.id))}
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span>{project.environmentLabel?.trim() || project.environmentId}</span>
        <span className="text-xs text-muted-foreground whitespace-normal break-all">
          {project.workspaceRoot}
        </span>
      </span>
    </MenuItem>
  );
}

function CheckoutAction({
  displayName,
  projects,
  action,
  onSelect,
}: {
  displayName: string;
  projects: readonly CheckoutProject[];
  action: "open" | "new-thread";
  onSelect: (project: ScopedProjectRef) => void;
}) {
  const grouped = projects.length > 1;
  const label = action === "open" ? `Open ${displayName} project` : `New thread in ${displayName}`;
  const children = action === "open" ? displayName : <PlusIcon />;
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (grouped) return;
    event.preventDefault();
    const project = projects[0];
    if (project) onSelect(scopeProjectRef(project.environmentId, project.id));
  };
  const trigger =
    action === "open" ? (
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={label}
        disabled={projects.length === 0}
        onClick={onClick}
      >
        {children}
      </button>
    ) : (
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label={label}
        disabled={projects.length === 0}
        onClick={onClick}
      >
        {children}
      </Button>
    );
  if (!grouped) return trigger;
  return (
    <Menu>
      <MenuTrigger render={trigger}>{children}</MenuTrigger>
      <MenuPopup align={action === "open" ? "start" : "end"}>
        <MenuGroup>
          <MenuGroupLabel>
            {action === "open" ? "Open checkout" : "New thread in checkout"}
          </MenuGroupLabel>
          {projects.map((project) => (
            <CheckoutMenuItem
              key={`${project.environmentId}:${project.id}`}
              project={project}
              action={action === "open" ? "Open" : "New thread in"}
              onSelect={onSelect}
            />
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

export function SidebarProjectNavigation({
  project,
  attention,
  supportsAgents,
  onOpenProject,
  onNewThread,
  onProposeAgents,
  onAddAgent,
  onSettings,
}: {
  project: Pick<SidebarProjectSnapshot, "displayName" | "memberProjects">;
  attention: ReactNode;
  supportsAgents: (environmentId: EnvironmentId) => boolean;
  onOpenProject: (project: ScopedProjectRef) => void;
  onNewThread: (project: ScopedProjectRef) => void;
  onProposeAgents: (project: ScopedProjectRef) => void;
  onAddAgent: (project: ScopedProjectRef) => void;
  onSettings: () => void;
}) {
  const grouped = project.memberProjects.length > 1;
  const agentProjects = project.memberProjects.filter((member) =>
    supportsAgents(member.environmentId),
  );
  return (
    <>
      <CheckoutAction
        displayName={project.displayName}
        projects={project.memberProjects}
        action="open"
        onSelect={onOpenProject}
      />
      {attention}
      <CheckoutAction
        displayName={project.displayName}
        projects={project.memberProjects}
        action="new-thread"
        onSelect={onNewThread}
      />
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`Project actions for ${project.displayName}`}
              onClick={(event) => event.stopPropagation()}
            />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuGroup>
            {grouped && agentProjects.length > 0 ? (
              <MenuGroupLabel>Propose agents in checkout</MenuGroupLabel>
            ) : null}
            {agentProjects.map((member) =>
              grouped ? (
                <CheckoutMenuItem
                  key={`propose:${member.environmentId}:${member.id}`}
                  project={member}
                  action="Propose agents in"
                  onSelect={onProposeAgents}
                />
              ) : (
                <MenuItem
                  key={`propose:${member.environmentId}:${member.id}`}
                  onClick={() => onProposeAgents(scopeProjectRef(member.environmentId, member.id))}
                >
                  Propose agents from repository
                </MenuItem>
              ),
            )}
          </MenuGroup>
          <MenuGroup>
            {grouped && agentProjects.length > 0 ? (
              <MenuGroupLabel>Add agent in checkout</MenuGroupLabel>
            ) : null}
            {agentProjects.map((member) =>
              grouped ? (
                <CheckoutMenuItem
                  key={`add:${member.environmentId}:${member.id}`}
                  project={member}
                  action="Add agent in"
                  onSelect={onAddAgent}
                />
              ) : (
                <MenuItem
                  key={`add:${member.environmentId}:${member.id}`}
                  onClick={() => onAddAgent(scopeProjectRef(member.environmentId, member.id))}
                >
                  Add agent
                </MenuItem>
              ),
            )}
          </MenuGroup>
          <MenuItem onClick={onSettings}>Project settings</MenuItem>
        </MenuPopup>
      </Menu>
    </>
  );
}

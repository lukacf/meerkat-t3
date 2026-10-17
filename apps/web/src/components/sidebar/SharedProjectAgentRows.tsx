import type { ScopedProjectRef } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { BoxIcon, ServerIcon } from "lucide-react";
import type { EnvironmentPresentation } from "../../state/environments";
import { useSharedDirectory, useSharedHosts } from "../../state/sharedWorkspace";
import {
  sharedHostStatus,
  sharedProjectRoster,
  sharedSpecialistDestination,
} from "../team/sharedWorkspace.logic";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

function HostAgentRows({
  host,
  projectRefs,
  visible,
}: {
  host: EnvironmentPresentation;
  projectRefs: ReadonlyArray<ScopedProjectRef>;
  visible: boolean;
}) {
  const query = useSharedDirectory(host, visible);
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile, setOpenMobile } = useSidebar();
  const rows = query.snapshot ? sharedProjectRoster(query.snapshot, projectRefs) : [];
  if (!visible || !rows.length) return null;
  const status = sharedHostStatus(
    host.connection.phase,
    query.snapshot !== null,
    query.error,
    query.isPending,
  );
  const search = new URLSearchParams(location.searchStr);
  return (
    <div className="min-w-0 pt-2" aria-label={`Agents on ${host.label}`}>
      <div className="flex min-w-0 items-center gap-1.5 px-2 pb-1 text-2xs text-sidebar-muted-foreground">
        <ServerIcon className="size-3 shrink-0" />
        <span className="truncate">{query.snapshot?.workspace?.name ?? host.label}</span>
        {status !== "Shared" ? <span className="ml-auto shrink-0">{status}</span> : null}
      </div>
      <SidebarMenu>
        {rows.map(({ specialist, checkouts }) => (
          <SidebarMenuItem key={specialist.specialistId}>
            <SidebarMenuButton
              isActive={
                location.pathname === `/${host.environmentId}/agents/${specialist.specialistId}` &&
                search.get("shared") === "true" &&
                checkouts.some(
                  (checkout) =>
                    checkout.localProjectId === search.get("checkoutProject") &&
                    checkout.localEnvironmentId === search.get("checkoutEnvironment"),
                )
              }
              tooltip={`${specialist.label} · ${host.label} · ${specialist.supersededAt ? "Superseded for new work; existing requests remain available" : status}`}
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                void navigate(
                  sharedSpecialistDestination(host.environmentId, specialist, checkouts[0]),
                );
              }}
            >
              <BoxIcon />
              <span className="min-w-0 flex-1 truncate">{specialist.label}</span>
              <span className="text-3xs text-sidebar-muted-foreground">
                {specialist.supersededAt ? "Previous" : "Shared"}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </div>
  );
}

export function SharedProjectAgentRows({
  projectRefs,
  visible,
}: {
  projectRefs: ReadonlyArray<ScopedProjectRef>;
  visible: boolean;
}) {
  const hosts = useSharedHosts();
  return hosts.map((host) => (
    <HostAgentRows
      key={host.environmentId}
      host={host}
      projectRefs={projectRefs}
      visible={visible}
    />
  ));
}

import { NativeAttentionConversation } from "./NativeAttentionConversation";
import { NativeSearchConversation } from "./NativeSearchConversation";
import { ConversationWorkspaceControls } from "./ConversationWorkspaceChrome";
import { ConversationWorkspace } from "./ConversationWorkspace";
import {
  ProviderInstanceId,
  type EnvironmentId,
  type ProjectId,
  type ModelSelection,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { BoxIcon } from "lucide-react";
import { isElectron } from "../../env";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { meerkatTeamEnvironment, useVisibleTeamRefresh } from "../../state/meerkatTeam";
import { useEnvironmentQuery } from "../../state/query";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ProjectAgentPanel } from "./ProjectAgentPanel";
import { ProjectAgentSetup } from "./ProjectAgentSetup";

export function ProjectAgentConversation({
  environmentId,
  projectId,
  agentId,
  embedded = false,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  agentId: string;
  embedded?: boolean;
}) {
  const search = useSearch({ strict: false });
  const routeParams = useParams({ strict: false });
  const project = useProjects().find(
    (entry) => entry.id === projectId && entry.environmentId === environmentId,
  );
  const query = useEnvironmentQuery(
    meerkatTeamEnvironment.projectTeam({ environmentId, input: { projectId } }),
  );

  const definition = query.data?.projectAgents.find((entry) => entry.agentId === agentId);
  const provider = query.data?.providers.find(
    (entry) => entry.instanceId === definition?.instanceId,
  );
  const agent =
    provider?.agents.find((entry) => entry.agentRef === definition?.agentRef) ??
    provider?.agents.find(
      (entry) =>
        entry.projectAgentId === definition?.agentId &&
        !entry.record.labels.source_mob_id &&
        !entry.record.labels.spawned_by,
    );
  const content = (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ProjectAgentObservation query={query} />
      {search.attention &&
      routeParams.environmentId === environmentId &&
      routeParams.agentId === agentId &&
      search.project === projectId ? (
        <NativeAttentionConversation
          environmentId={environmentId}
          projectId={projectId}
          projectAgentId={agentId}
          cwd={project?.workspaceRoot}
          projectTitle={project?.title ?? "Project"}
        />
      ) : search.nativeAgent &&
        routeParams.environmentId === environmentId &&
        routeParams.agentId === agentId &&
        search.project === projectId &&
        (search.nativeInstance || definition) ? (
        <NativeSearchConversation
          environmentId={environmentId}
          projectId={projectId}
          instanceId={
            search.nativeInstance
              ? ProviderInstanceId.make(search.nativeInstance)
              : definition!.instanceId
          }
          label={definition?.label ?? "Agent"}
          cwd={project?.workspaceRoot}
        />
      ) : definition ? (
        <ProjectAgentPanel
          key={definition.agentId}
          definition={definition}
          environmentId={environmentId}
          projectId={projectId}
          projectTitle={project?.title ?? "Project"}
          provider={provider}
          agent={agent}
          rosterStale={query.error !== null}
          refreshTeam={query.refresh}
        />
      ) : (
        <>
          <WorkspacePageHeader electron={isElectron}>
            <BoxIcon className="size-4 text-muted-foreground" />
            <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">
              {project?.title ?? "Project"}
            </h1>
            <ConversationWorkspaceControls />
          </WorkspacePageHeader>
          <p role="status" className="p-6 text-sm text-muted-foreground">
            {query.error ??
              (query.isPending
                ? "Opening agent conversation..."
                : "This project agent is unavailable.")}
          </p>
        </>
      )}
    </div>
  );
  return embedded ? (
    content
  ) : (
    <ConversationWorkspace
      environmentId={environmentId}
      projectId={projectId}
      primaryLabel={definition?.label ?? "Agent"}
      primaryTarget={{
        kind: "project-agent",
        environmentId,
        projectId,
        agentId,
        label: definition?.label ?? "Agent",
      }}
    >
      {content}
    </ConversationWorkspace>
  );
}

function ProjectAgentObservation({
  query,
}: {
  query: import("../../state/query").EnvironmentQueryView<unknown>;
}) {
  // This observer must render beneath the pane presentation boundary, including the primary route.
  useVisibleTeamRefresh(query, true);
  return null;
}

export function NewProjectAgent({
  environmentId,
  projectId,
  selectedModel,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  selectedModel?: ModelSelection | null;
}) {
  const navigate = useNavigate();
  const project = useProjects().find(
    (entry) => entry.id === projectId && entry.environmentId === environmentId,
  );
  const { environments } = useEnvironments();
  const config = environments.find((entry) => entry.environmentId === environmentId)?.serverConfig;
  const providers =
    config?.providers.filter(
      (entry) =>
        entry.driver === "meerkat" && entry.enabled && entry.availability !== "unavailable",
    ) ?? [];
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <BoxIcon className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-semibold">{project?.title ?? "Project"} / New agent</h1>
      </WorkspacePageHeader>
      <ProjectAgentSetup
        environmentId={environmentId}
        projectId={projectId}
        providers={providers}
        cwd={project?.workspaceRoot}
        preferredModel={
          selectedModel ??
          (config
            ? resolveProjectSettings(config.settings, projectId, project).settings
                .defaultModelSelection
            : null)
        }
        onCancel={() =>
          void navigate({
            to: "/$environmentId/projects/$projectId/start",
            params: { environmentId, projectId },
          })
        }
        onCreated={(agent) =>
          void navigate({
            to: "/$environmentId/agents/$agentId",
            params: { environmentId, agentId: agent.agentId },
            search: { project: projectId },
            replace: true,
          })
        }
      />
    </SidebarInset>
  );
}

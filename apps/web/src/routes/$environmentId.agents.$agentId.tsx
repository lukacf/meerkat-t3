import { validateNativeAttentionLocation } from "../components/team/meerkatAttention.logic";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { ProjectAgentConversation } from "../components/team/ProjectAgentConversation";
import { validateNativeSearchLocation } from "../components/team/nativeSearchNavigation";

export const Route = createFileRoute("/$environmentId/agents/$agentId")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.project === "string" ? { project: search.project } : {}),
    ...validateNativeSearchLocation(search),
    ...validateNativeAttentionLocation(search),
  }),
  beforeLoad: ({ context, search }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    )
      throw redirect({ to: "/pair", replace: true });
    if (!search.project) throw redirect({ to: "/", replace: true });
  },
  component: () => {
    const { environmentId, agentId } = Route.useParams();
    const { project } = Route.useSearch();
    return (
      <ProjectAgentConversation
        environmentId={EnvironmentId.make(environmentId)}
        projectId={ProjectId.make(project!)}
        agentId={agentId}
      />
    );
  },
});

import { validateNativeAttentionLocation } from "../components/team/meerkatAttention.logic";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { ProjectAgentConversation } from "../components/team/ProjectAgentConversation";
import { SharedSpecialistConversation } from "../components/team/SharedSpecialistConversation";
import { validateNativeSearchLocation } from "../components/team/nativeSearchNavigation";

export const Route = createFileRoute("/$environmentId/agents/$agentId")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.project === "string" ? { project: search.project } : {}),
    ...(search.shared === true || search.shared === "true" ? { shared: true as const } : {}),
    ...(typeof search.checkoutEnvironment === "string"
      ? { checkoutEnvironment: search.checkoutEnvironment }
      : {}),
    ...(typeof search.checkoutProject === "string"
      ? { checkoutProject: search.checkoutProject }
      : {}),
    ...(typeof search.checkoutId === "string" ? { checkoutId: search.checkoutId } : {}),
    ...(typeof search.checkoutThread === "string" && search.checkoutThread
      ? { checkoutThread: search.checkoutThread }
      : {}),
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
    const { project, shared, checkoutEnvironment, checkoutProject, checkoutId, checkoutThread } =
      Route.useSearch();
    if (shared)
      return (
        <SharedSpecialistConversation
          environmentId={EnvironmentId.make(environmentId)}
          specialistId={agentId}
          checkoutEnvironment={checkoutEnvironment}
          checkoutProject={checkoutProject}
          checkoutId={checkoutId}
          checkoutThread={checkoutThread}
        />
      );
    return (
      <ProjectAgentConversation
        environmentId={EnvironmentId.make(environmentId)}
        projectId={ProjectId.make(project!)}
        agentId={agentId}
      />
    );
  },
});

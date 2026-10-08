import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { ProjectAgentProposalLaunch } from "../components/team/ProjectAgentProposalLaunch";

import { validateAgentSetupSearch } from "../components/team/projectAgentSetup.logic";

export const Route = createFileRoute("/$environmentId/projects/$projectId/agents/propose")({
  validateSearch: validateAgentSetupSearch,
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    )
      throw redirect({ to: "/pair", replace: true });
  },
  component: () => {
    const { environmentId, projectId } = Route.useParams();
    const { instance, model, options } = Route.useSearch();
    return (
      <ProjectAgentProposalLaunch
        key={`${environmentId}:${projectId}`}
        environmentId={EnvironmentId.make(environmentId)}
        projectId={ProjectId.make(projectId)}
        selectedModel={
          instance && model
            ? {
                instanceId: ProviderInstanceId.make(instance),
                model,
                ...(options !== undefined ? { options } : {}),
              }
            : null
        }
      />
    );
  },
});

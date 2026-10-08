import { createFileRoute, redirect } from "@tanstack/react-router";

/** Older prototype links resolve into the native project/thread conversation navigation. */
export const Route = createFileRoute("/team")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { environment?: string; project?: string; agent?: string; thread?: string } => ({
    ...(typeof search.environment === "string" ? { environment: search.environment } : {}),
    ...(typeof search.project === "string" ? { project: search.project } : {}),
    ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
    ...(typeof search.thread === "string" ? { thread: search.thread } : {}),
  }),
  beforeLoad: ({ search }) => {
    if (search.environment && search.thread)
      throw redirect({
        to: "/$environmentId/$threadId",
        params: { environmentId: search.environment, threadId: search.thread },
        replace: true,
      });
    if (search.environment && search.project && search.agent)
      throw redirect({
        to: "/$environmentId/agents/$agentId",
        params: { environmentId: search.environment, agentId: search.agent },
        search: { project: search.project },
        replace: true,
      });
    if (search.environment && search.project)
      throw redirect({
        to: "/$environmentId/projects/$projectId/agents/new",
        params: { environmentId: search.environment, projectId: search.project },
        replace: true,
      });
    throw redirect({ to: "/", replace: true });
  },
});

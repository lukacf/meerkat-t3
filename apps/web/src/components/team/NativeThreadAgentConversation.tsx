import { NativeAttentionConversation } from "./NativeAttentionConversation";
import { useParams, useSearch } from "@tanstack/react-router";
import { NativeSearchConversation } from "./NativeSearchConversation";
import {
  ProviderInstanceId,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ArrowLeftIcon, BotIcon } from "lucide-react";
import { meerkatTeamEnvironment, useVisibleTeamRefresh } from "../../state/meerkatTeam";
import { useEnvironmentQuery } from "../../state/query";
import { useProject, useThreadShell } from "../../state/entities";
import { Button } from "../ui/button";
import { AgentConversation } from "./AgentConversation";
import { AgentHeaderIdentity, AgentWorkspaceTools } from "./AgentWorkspaceTools";
import { ConversationWorkspaceControls } from "./ConversationWorkspaceChrome";

export function NativeThreadAgentConversation({
  environmentId,
  projectId,
  instanceId,
  threadId,
  agentRef,
  onBack,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  instanceId: ProviderInstanceId;
  threadId: ThreadId;
  agentRef: string;
  onBack: () => void;
}) {
  const search = useSearch({ strict: false });
  const routeParams = useParams({ strict: false });
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  // A missing owner does not imply that a worker belongs to the project checkout.
  const workspaceCwd = thread ? (thread.worktreePath ?? project?.workspaceRoot) : undefined;
  const query = useEnvironmentQuery(
    meerkatTeamEnvironment.projectTeam({ environmentId, input: { projectId } }),
  );
  useVisibleTeamRefresh(query, true);
  const provider = query.data?.providers.find((entry) => entry.instanceId === instanceId);
  const currentAgent = provider?.agents.find(
    (entry) => entry.threadId === threadId && entry.agentRef === agentRef,
  );
  const historical = useEnvironmentQuery(
    !currentAgent
      ? meerkatTeamEnvironment.agentActivity({
          environmentId,
          input: { projectId, instanceId, agentRef, limit: 100 },
        })
      : null,
  );
  const agent = currentAgent ?? historical.data?.agent;

  const identity = (
    <>
      <Button
        size="icon-sm"
        variant="ghost-muted"
        onClick={onBack}
        aria-label="Back to coordinator"
        title="Back to coordinator"
      >
        <ArrowLeftIcon />
      </Button>
      <AgentHeaderIdentity
        icon={<BotIcon className="size-4 shrink-0 text-muted-foreground" />}
        label={agent?.record.display_name ?? "Worker"}
        context={thread?.title ?? "Thread agent"}
      />
    </>
  );
  return (
    <section
      className="@container/agent-panel flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label="Thread agent conversation"
    >
      {project ? (
        <AgentWorkspaceTools
          environmentId={environmentId}
          projectId={projectId}
          threadId={threadId}
          cwd={project.workspaceRoot}
          projectTitle={project.title}
          agent={agent}
          provider={provider}
          identity={identity}
          actions={<ConversationWorkspaceControls />}
        />
      ) : (
        <header className="flex h-12 min-w-0 shrink-0 items-center gap-2 border-b border-border px-3">
          {identity}
          <ConversationWorkspaceControls />
        </header>
      )}
      {search.attention &&
      search.member === agentRef &&
      routeParams.environmentId === environmentId &&
      routeParams.threadId === threadId ? (
        <NativeAttentionConversation
          environmentId={environmentId}
          projectId={projectId}
          threadId={threadId}
          agentRef={agentRef}
          cwd={workspaceCwd}
          accessMode={thread?.runtimeMode}
        />
      ) : search.nativeAgent === agentRef &&
        routeParams.environmentId === environmentId &&
        routeParams.threadId === threadId ? (
        <NativeSearchConversation
          environmentId={environmentId}
          projectId={projectId}
          instanceId={
            search.nativeInstance ? ProviderInstanceId.make(search.nativeInstance) : instanceId
          }
          label={agent?.record.display_name ?? "Agent"}
          cwd={workspaceCwd}
        />
      ) : agent && provider ? (
        <AgentConversation
          key={agent.agentRef}
          environmentId={environmentId}
          projectId={projectId}
          provider={provider}
          agent={agent}
          cwd={workspaceCwd}
          accessMode={thread?.runtimeMode}
          rosterStale={query.error !== null || !currentAgent}
          refreshTeam={query.refresh}
        />
      ) : (
        <p role="status" className="p-6 text-sm text-muted-foreground">
          {query.error ??
            historical.error ??
            (query.isPending || historical.isPending
              ? "Opening worker conversation..."
              : "This worker is no longer available in the thread.")}
        </p>
      )}
    </section>
  );
}

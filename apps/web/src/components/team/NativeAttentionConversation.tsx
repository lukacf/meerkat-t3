import { NativeAttentionReadMarker } from "./NativeAttentionReadMarker";
import type { EnvironmentId, ProjectId, RuntimeMode, ThreadId } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMeerkatAttention } from "../../state/meerkatAttention";
import { meerkatControlsEnvironment } from "../../state/meerkatControls";
import { meerkatTeamEnvironment } from "../../state/meerkatTeam";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { MeerkatToolApprovals } from "./MeerkatToolApprovals";
import { AgentQuestionCard } from "./AgentQuestionCard";
import { NativeAgentTranscript } from "./NativeAgentTranscript";
import { AgentConversation } from "./AgentConversation";
import { ProjectAgentPanel } from "./ProjectAgentPanel";
import { attentionConversationTarget } from "./meerkatAttention.logic";
import { readRestoreReviewWorkBlock, useRestoreReviewWorkBlock } from "./useRestoreReview";

/** A notification opens its recorded native session, even after the current agent changes. */
export function NativeAttentionConversation({
  environmentId,
  projectId,
  projectAgentId,
  threadId,
  agentRef,
  cwd,
  accessMode,
  projectTitle = "Project",
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  projectAgentId?: string;
  threadId?: ThreadId;
  agentRef?: string;
  cwd?: string | undefined;
  accessMode?: RuntimeMode | undefined;
  projectTitle?: string;
}) {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const attention = useMeerkatAttention(environmentId, projectId, search.attention, true);
  const candidate = attention.data?.items.find((item) => item.id === search.attention);
  const item =
    candidate &&
    candidate.instanceId === search.attentionInstance &&
    (threadId
      ? candidate.threadId === threadId && candidate.agentRef === agentRef
      : candidate.projectAgentId === projectAgentId)
      ? candidate
      : undefined;
  const activity = useEnvironmentQuery(
    item?.agentRef
      ? meerkatTeamEnvironment.agentActivity({
          environmentId,
          input: { projectId, instanceId: item.instanceId, agentRef: item.agentRef, limit: 100 },
        })
      : null,
  );
  const answer = useAtomCommand(meerkatControlsEnvironment.answer, { reportFailure: false });
  const restoreBlock = useRestoreReviewWorkBlock(environmentId);
  const team = useEnvironmentQuery(
    item?.kind === "completion"
      ? meerkatTeamEnvironment.projectTeam({ environmentId, input: { projectId } })
      : null,
  );
  const ownTranscript =
    activity.data?.transcript?.sessionId === item?.sessionId
      ? activity.data?.transcript
      : undefined;
  const target =
    item?.kind === "completion"
      ? attentionConversationTarget(item, team.data?.providers ?? [], activity.data?.agent)
      : null;
  const definition = target
    ? team.data?.projectAgents.find(
        (agent) => agent.agentId === item?.projectAgentId && agent.instanceId === item?.instanceId,
      )
    : undefined;
  // Historical sessions use the saved transcript below. Mounting AgentConversation
  // would also mount its durable-agent queue, which can belong to a newer session.
  if (target && !target.historical && !attention.error) {
    if (
      definition &&
      definition.agentRef === target.agent.agentRef &&
      !target.agent.threadId &&
      !target.agent.record.labels.source_mob_id &&
      !target.agent.record.labels.spawned_by
    ) {
      return (
        <ProjectAgentPanel
          definition={definition}
          environmentId={environmentId}
          projectId={projectId}
          provider={target.provider}
          agent={target.agent}
          rosterStale={team.error !== null}
          refreshTeam={team.refresh}
          projectTitle={projectTitle}
        />
      );
    }
    return (
      <section className="flex min-h-0 flex-1 flex-col" aria-label="Agent attention">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
            {target.agent.record.display_name}
          </h2>
        </header>
        <AgentConversation
          environmentId={environmentId}
          projectId={projectId}
          provider={target.provider}
          agent={target.agent}
          browserReturnAttention={
            item?.projectAgentId && !item.threadId && item.agentRef && item.sessionId
              ? {
                  kind: "project-agent-attention",
                  environmentId,
                  projectId,
                  agentId: item.projectAgentId,
                  attentionId: item.id,
                  instanceId: item.instanceId,
                  agentRef: item.agentRef,
                  sessionId: item.sessionId,
                  label: item.label,
                }
              : undefined
          }
          rosterStale={team.error !== null}
          refreshTeam={team.refresh}
          cwd={cwd}
          accessMode={definition?.accessMode ?? accessMode}
        />
      </section>
    );
  }
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Agent attention">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium">{item?.label ?? "Agent attention"}</h2>
          <p className="text-xs text-muted-foreground">{item?.title}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void navigate({
              to: ".",
              search: (previous: Record<string, unknown>) => {
                const { attention: _a, attentionInstance: _i, ...rest } = previous;
                return rest;
              },
            })
          }
        >
          Back to conversation
        </Button>
      </div>
      {attention.error || (!item && !attention.isPending) ? (
        <p role="alert" className="p-4 text-sm text-destructive">
          {attention.error ?? "This attention item is no longer available for this conversation."}
        </p>
      ) : null}
      {item ? (
        <div className="shrink-0 space-y-2 p-3">
          {item.kind === "approval" &&
          item.active &&
          item.agentRef &&
          item.sessionId &&
          item.approvalId ? (
            <MeerkatToolApprovals
              environmentId={environmentId}
              target={{ projectId, instanceId: item.instanceId, agentRef: item.agentRef }}
              expectedSessionId={item.sessionId}
              expectedApprovalId={item.approvalId}
            />
          ) : item.kind === "approval" ? (
            <p className="text-sm text-muted-foreground">
              This tool approval is no longer pending.
            </p>
          ) : item.kind === "question" && item.active && item.question && item.agentRef ? (
            <AgentQuestionCard
              request={item.question}
              draftScope={{ environmentId, projectId, instanceId: item.instanceId }}
              disabledReason={restoreBlock}
              onAnswer={async (answers, dismissed) => {
                const currentBlock = readRestoreReviewWorkBlock(environmentId);
                if (currentBlock) return currentBlock;
                const result = await answer({
                  environmentId,
                  input: {
                    projectId,
                    instanceId: item.instanceId,
                    agentRef: item.agentRef!,
                    requestId: item.question!.requestId,
                    sessionId: item.question!.sessionId,
                    answers,
                    dismissed,
                  },
                });
                attention.refresh();
                return result._tag === "Failure"
                  ? formatEnvironmentQueryError(result.cause)
                  : result.value.accepted && result.value.requestId === item.question!.requestId
                    ? null
                    : "The agent did not confirm this answer. Your draft has been kept. Refresh the question before retrying.";
              }}
            />
          ) : item.kind === "question" ? (
            <p className="text-sm text-muted-foreground">This question is no longer pending.</p>
          ) : item.detail && item.kind !== "completion" ? (
            <p
              role={item.kind.endsWith("error") ? "alert" : undefined}
              className="whitespace-pre-wrap text-sm"
            >
              {item.detail}
            </p>
          ) : null}
          {ownTranscript && item.agentRef && item.sessionId ? (
            <NativeAttentionReadMarker
              environmentId={environmentId}
              projectId={projectId}
              instanceId={item.instanceId}
              agentRef={item.agentRef}
              sessionId={item.sessionId}
            />
          ) : null}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {ownTranscript && item ? (
          <NativeAgentTranscript
            key={`${item.id}:${ownTranscript.storeRevision}`}
            scope={{
              environmentId,
              projectId,
              instanceId: item.instanceId,
              agentRef: item.agentRef!,
            }}
            initial={ownTranscript}
            agentLabel={item.label}
            cwd={cwd}
            raw={false}
            onRefresh={activity.refresh}
          />
        ) : activity.error || team.error ? (
          <p role="alert" className="text-sm text-destructive">
            {activity.error ?? team.error}
          </p>
        ) : activity.isPending || team.isPending ? (
          <p className="text-sm text-muted-foreground">Opening conversation...</p>
        ) : item?.sessionId ? (
          <p className="text-sm text-muted-foreground">
            The saved native session is unavailable. This item will not open a replacement session.
          </p>
        ) : null}
      </div>
    </section>
  );
}

import type {
  EnvironmentId,
  MeerkatProjectAgent,
  MeerkatProjectAgentAccessMode,
  MeerkatProjectAgentProposal,
  MeerkatProjectProposalCreateResult,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertCircleIcon,
  ArrowRightIcon,
  BookOpenIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { newMessageId } from "../../lib/utils";
import { meerkatTeamEnvironment, useVisibleTeamRefresh } from "../../state/meerkatTeam";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  latestProposalAgent,
  proposalCandidateState,
  proposalPreparationSummary,
  proposalVisibleInThread,
} from "./projectAgentProposal.logic";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { PROJECT_AGENT_PROPOSAL_PROMPT } from "./projectAgentProposalPrompt";
import { ProjectAgentPermissions, projectAgentPermissionLabel } from "./ProjectAgentPermissions";
import { readRestoreReviewWorkBlock, useRestoreReviewWorkBlock } from "./useRestoreReview";

type ProposalContext = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  sourceThreadId: ThreadId;
  projectTitle: string;
};

export function ProjectAgentProposalPanel({
  environmentId,
  projectId,
  sourceThreadId,
  projectTitle,
  busy,
  modelSelection,
  runtimeMode,
}: ProposalContext & { busy: boolean; modelSelection: ModelSelection; runtimeMode: RuntimeMode }) {
  const query = useEnvironmentQuery(
    meerkatTeamEnvironment.projectProposal({ environmentId, input: { projectId, sourceThreadId } }),
  );
  const snapshot = query.data;
  const visible = proposalVisibleInThread(snapshot, sourceThreadId);
  useVisibleTeamRefresh(query, true);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const restoreBlock = useRestoreReviewWorkBlock(environmentId);
  async function refreshProposal() {
    const currentBlock = readRestoreReviewWorkBlock(environmentId);
    if (currentBlock) {
      setError(currentBlock);
      return;
    }
    if (busy || inFlight.current || !snapshot?.available) return;
    inFlight.current = true;
    setRefreshing(true);
    setError(null);
    try {
      const result = await startTurn({
        environmentId,
        input: {
          threadId: sourceThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: PROJECT_AGENT_PROPOSAL_PROMPT,
            attachments: [],
          },
          modelSelection,
          runtimeMode,
          interactionMode: "default",
          createdAt: new Date().toISOString(),
        },
      });
      if (result._tag === "Failure") {
        setError(formatEnvironmentQueryError(result.cause));
        setRefreshing(false);
      }
      query.refresh();
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }
  if (!visible) return null;
  const blocked =
    busy || refreshing || restoreBlock !== null || query.error !== null || !snapshot?.available;
  return (
    <section
      className="min-w-0 shrink-0 border-b border-border/60 bg-background"
      aria-label="Project-agent proposal"
    >
      {snapshot?.status === "ready" && snapshot.proposal && snapshot.instanceId ? (
        <ProposalReview
          key={snapshot.proposal.proposalId}
          environmentId={environmentId}
          projectId={projectId}
          sourceThreadId={sourceThreadId}
          projectTitle={projectTitle}
          proposal={snapshot.proposal}
          instanceId={snapshot.instanceId}
          busy={blocked}
          refreshing={refreshing}
          refreshProposal={() => void refreshProposal()}
          refreshAuthority={query.refresh}
        />
      ) : (
        <div className="flex min-w-0 items-center gap-3 px-4 py-2.5">
          <BookOpenIcon className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium">
              {snapshot?.status === "pending" || busy
                ? "Project setup in progress"
                : snapshot?.status === "none"
                  ? "Set up project agents"
                  : snapshot?.status === "unavailable"
                    ? "Project agent proposals unavailable"
                    : "Proposal needs another pass"}
            </p>
            {snapshot?.error ? (
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{snapshot.error}</p>
            ) : null}
          </div>
          {snapshot?.status !== "pending" && !busy ? (
            <Button
              size="xs"
              variant="outline"
              disabled={blocked}
              onClick={() => void refreshProposal()}
            >
              <RefreshCwIcon />
              {refreshing
                ? "Starting..."
                : snapshot?.status === "none"
                  ? "Start study"
                  : "Try again"}
            </Button>
          ) : null}
        </div>
      )}
      {query.error || error ? (
        <p role="alert" className="px-5 pb-3 text-sm text-warning-foreground">
          {error ?? query.error}
        </p>
      ) : null}
    </section>
  );
}

function ProposalReview({
  environmentId,
  projectId,
  sourceThreadId,
  projectTitle,
  proposal,
  instanceId,
  busy,
  refreshing,
  refreshProposal,
  refreshAuthority,
}: ProposalContext & {
  proposal: MeerkatProjectAgentProposal;
  instanceId: ProviderInstanceId;
  busy: boolean;
  refreshing: boolean;
  refreshProposal: () => void;
  refreshAuthority: () => void;
}) {
  const navigate = useNavigate();
  const team = useEnvironmentQuery(
    meerkatTeamEnvironment.projectTeam({ environmentId, input: { projectId } }),
  );
  useVisibleTeamRefresh(team, true);
  const create = useAtomCommand(meerkatTeamEnvironment.projectProposalCreate, {
    reportFailure: false,
  });
  const prepare = useAtomCommand(meerkatTeamEnvironment.projectAgentPrepare, {
    reportFailure: false,
  });
  const [selected, setSelected] = useState(() =>
    proposal.agents.filter((entry) => entry.recommended).map((entry) => entry.id),
  );
  const [reviewOpen, setReviewOpen] = useState(false);
  const [accessMode, setAccessMode] = useState<MeerkatProjectAgentAccessMode>("read-only");
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [receipts, setReceipts] = useState<ReadonlyMap<string, MeerkatProjectAgent>>(new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [requestError, setRequestError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const rows = proposal.agents.map((candidate) => {
    const observed =
      team.data?.projectAgents.find(
        (entry) =>
          entry.instanceId === instanceId && entry.role === candidate.role && !entry.archived,
      ) ??
      team.data?.projectAgents.find(
        (entry) => entry.instanceId === instanceId && entry.role === candidate.role,
      );
    const agent = latestProposalAgent(observed, receipts.get(candidate.id));
    const currentState = proposalCandidateState(candidate, agent);
    const state = agent?.pendingRevision
      ? { label: "Revision saved", actionable: false, retry: false }
      : currentState.label === "Different assignment"
        ? { label: "Revision proposed", actionable: true, retry: false }
        : currentState;
    return {
      candidate,
      agent,
      state,
    };
  });
  const actionable = rows.filter((row) => row.state.actionable);
  const selectedIds = actionable
    .filter((row) => selected.includes(row.candidate.id))
    .map((row) => row.candidate.id);
  const progress = proposalPreparationSummary(
    rows.map((row) => ({ ...row, error: errors.get(row.candidate.id) })),
  );
  const { preparing, ready } = progress;
  const requestIssue = requestError ?? team.error;
  const needsAttention = progress.failed > 0 || requestIssue !== null;
  const submitting = pendingIds.size > 0;
  const blocked = busy || submitting || team.error !== null || team.data === null;
  const startTask = () => {
    setReviewOpen(false);
    void navigate({
      to: "/$environmentId/projects/$projectId/start",
      params: { environmentId, projectId },
      search: {},
    });
  };
  function applyResults(results: MeerkatProjectProposalCreateResult["results"]) {
    setReceipts((current) => {
      const next = new Map(current);
      for (const result of results) if (result.agent) next.set(result.candidateId, result.agent);
      return next;
    });
    setErrors((current) => {
      const next = new Map(current);
      for (const result of results) {
        if (result.error) next.set(result.candidateId, result.error);
        else next.delete(result.candidateId);
      }
      return next;
    });
  }
  async function createSelected(candidateIds: ReadonlyArray<string>) {
    const currentBlock = readRestoreReviewWorkBlock(environmentId);
    if (currentBlock) {
      setRequestError(currentBlock);
      return;
    }
    if (blocked || inFlight.current || candidateIds.length === 0) return;
    inFlight.current = true;
    setPendingIds(new Set(candidateIds));
    setRequestError(null);
    try {
      const result = await create({
        environmentId,
        input: {
          projectId,
          sourceThreadId,
          proposalId: proposal.proposalId,
          candidateIds: [...candidateIds],
          accessMode,
        },
      });
      if (result._tag === "Failure") setRequestError(formatEnvironmentQueryError(result.cause));
      else applyResults(result.value.results);
      team.refresh();
      refreshAuthority();
    } finally {
      inFlight.current = false;
      setPendingIds(new Set());
    }
  }
  async function retry(candidateId: string, agent: MeerkatProjectAgent) {
    const currentBlock = readRestoreReviewWorkBlock(environmentId);
    if (currentBlock) {
      setRequestError(currentBlock);
      return;
    }
    if (blocked || inFlight.current) return;
    inFlight.current = true;
    setPendingIds(new Set([candidateId]));
    setRequestError(null);
    try {
      const result = await prepare({
        environmentId,
        input: { projectId, agentId: agent.agentId, retry: true },
      });
      if (result._tag === "Failure")
        setErrors((current) =>
          new Map(current).set(candidateId, formatEnvironmentQueryError(result.cause)),
        );
      else applyResults([{ candidateId, agent: result.value, error: null }]);
      team.refresh();
    } finally {
      inFlight.current = false;
      setPendingIds(new Set());
    }
  }
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-4 py-2.5">
        {needsAttention ? (
          <AlertCircleIcon className="size-4 shrink-0 text-warning" />
        ) : progress.allAcceptedReady ? (
          <CheckIcon className="size-4 shrink-0 text-success" />
        ) : (
          <BookOpenIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <p className="min-w-32 flex-1 text-xs">
          <span className="font-medium">Project agents</span>
          <span className="ml-2 text-muted-foreground" role="status">
            {requestIssue ? "Needs attention" : progress.label}
          </span>
        </p>
        <Button size="xs" variant="outline" onClick={() => setReviewOpen(true)}>
          {needsAttention
            ? "Review issues"
            : progress.accepted > 0
              ? "View agents"
              : "Review proposal"}
        </Button>
        {progress.available > 0 && !reviewOpen ? (
          <Button size="xs" disabled={submitting} onClick={startTask}>
            Start a task <ArrowRightIcon />
          </Button>
        ) : null}
      </div>
      {!reviewOpen && requestIssue ? (
        <p role="alert" className="px-4 pb-2.5 text-xs text-warning-foreground">
          {requestIssue}
        </p>
      ) : null}
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {!needsAttention && progress.allAcceptedReady
                ? `${ready} ${ready === 1 ? "agent" : "agents"} ready`
                : "Project agents"}
            </DialogTitle>
            <DialogDescription>{projectTitle}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-2">
              <h2 className="text-sm font-semibold leading-relaxed">{proposal.title}</h2>
              {proposal.summary ? (
                <p className="text-sm leading-relaxed text-muted-foreground">{proposal.summary}</p>
              ) : null}
            </div>
            {rows.some((row) => !row.agent) ? (
              <ProjectAgentPermissions
                value={accessMode}
                onChange={setAccessMode}
                disabled={blocked}
              />
            ) : null}
            {rows.some((row) => row.agent) ? (
              <p className="text-xs text-muted-foreground">
                Existing agents keep their permissions when you update assignments or repeat a
                study.
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>
                {actionable.length > 0 ? `${selectedIds.length} selected · ` : ""}
                {progress.label}
              </span>
              {actionable.length > 0 ? (
                <div className="flex gap-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={blocked}
                    onClick={() => setSelected(actionable.map((row) => row.candidate.id))}
                  >
                    Select all
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={blocked}
                    onClick={() => setSelected([])}
                  >
                    Clear
                  </Button>
                </div>
              ) : null}
            </div>
            <div className="space-y-2" role="group" aria-label="Proposed project agents">
              {rows.map(({ candidate, agent, state }) => {
                const pending = pendingIds.has(candidate.id);
                const error = errors.get(candidate.id) ?? agent?.preparation?.error;
                return (
                  <article key={candidate.id} className="rounded-lg border border-border p-3">
                    <div className="flex items-start gap-3">
                      <div className="pt-0.5">
                        {state.actionable ? (
                          <Checkbox
                            aria-label={`Select ${candidate.label}`}
                            checked={selected.includes(candidate.id)}
                            disabled={blocked || !state.actionable}
                            onCheckedChange={(checked) =>
                              setSelected((current) =>
                                checked
                                  ? [...current, candidate.id]
                                  : current.filter((id) => id !== candidate.id),
                              )
                            }
                          />
                        ) : state.label === "Ready" ? (
                          <CheckIcon className="size-4 text-success" aria-label="Ready" />
                        ) : (
                          <BotIcon
                            className="size-4 text-muted-foreground"
                            aria-label={state.label}
                          />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-medium">{candidate.label}</h3>
                          <Badge size="sm" variant="secondary">
                            {projectAgentPermissionLabel(agent ? agent.accessMode : accessMode)}
                          </Badge>
                          {candidate.recommended ? (
                            <Badge size="sm" variant="secondary">
                              Recommended
                            </Badge>
                          ) : null}
                          {state.label === "Ready" ? (
                            <Badge size="sm" variant="success">
                              Ready
                            </Badge>
                          ) : null}
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          {candidate.focus}
                        </p>
                        <details className="group mt-2">
                          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                            <ChevronDownIcon className="size-3 -rotate-90 transition-transform group-open:rotate-0" />
                            Assignment details
                          </summary>
                          <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                            {candidate.charter}
                          </p>
                          {candidate.ownershipPaths.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {candidate.ownershipPaths.map((path) => (
                                <code
                                  key={path}
                                  className="max-w-full break-all rounded bg-muted px-1.5 py-0.5 text-2xs"
                                >
                                  {path}
                                </code>
                              ))}
                            </div>
                          ) : null}
                        </details>
                        {state.label === "Revision proposed" && agent ? (
                          <div className="mt-2 space-y-2 rounded-md bg-muted/40 p-2 text-xs">
                            <p className="font-medium">
                              Update {agent.label}, preserving its conversation and connections
                            </p>
                            <p className="text-muted-foreground">
                              Current focus: {agent.focus ?? "Not specified"}
                            </p>
                            <p className="text-muted-foreground">
                              Current responsibilities: {agent.charter ?? agent.instructions}
                            </p>
                            <p className="text-muted-foreground">
                              Current paths: {agent.ownershipPaths?.join(", ") ?? "Not assigned"}
                            </p>
                            <p>
                              The proposed assignment above will apply when idle, then start a fresh
                              study.
                            </p>
                          </div>
                        ) : null}
                        {error ? (
                          <p role="status" className="mt-2 text-xs text-warning-foreground">
                            {error}
                          </p>
                        ) : null}
                        {agent || pending || errors.has(candidate.id) ? (
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            {state.label !== "Ready" ? (
                              <span className="mr-auto text-xs text-muted-foreground">
                                {pending
                                  ? agent
                                    ? "Starting study..."
                                    : "Creating..."
                                  : state.label}
                              </span>
                            ) : null}
                            {state.retry && agent ? (
                              <Button
                                size="xs"
                                variant="outline"
                                disabled={blocked}
                                onClick={() => void retry(candidate.id, agent)}
                              >
                                Retry study
                              </Button>
                            ) : null}
                            {errors.has(candidate.id) && !agent ? (
                              <Button
                                size="xs"
                                variant="outline"
                                disabled={blocked}
                                onClick={() => void createSelected([candidate.id])}
                              >
                                Retry creation
                              </Button>
                            ) : null}
                            {agent ? (
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() =>
                                  void navigate({
                                    to: "/$environmentId/agents/$agentId",
                                    params: { environmentId, agentId: agent.agentId },
                                    search: { project: projectId },
                                  })
                                }
                              >
                                {agent.archived ? "Open to restore" : "Open conversation"}
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
            {requestIssue ? (
              <div className="flex items-center gap-2">
                <p role="alert" className="flex-1 text-sm text-warning-foreground">
                  {requestIssue}
                </p>
                {team.error ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={team.isPending}
                    onClick={team.refresh}
                  >
                    Retry loading agents
                  </Button>
                ) : null}
              </div>
            ) : null}
            {busy || submitting || preparing ? (
              <p role="status" className="text-xs text-muted-foreground">
                {busy
                  ? "Repository study is running."
                  : submitting
                    ? "Preparing selected agents..."
                    : `${preparing} studying. Open an agent to follow its progress.`}
              </p>
            ) : actionable.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Applying {selectedIds.length}{" "}
                {selectedIds.length === 1
                  ? "assignment starts an agent"
                  : "assignments starts separate agents"}{" "}
                to study their areas using the configured model accounts. Each run can incur API
                charges. Usage shows recorded Meerkat lifetime tokens separately from period charts
                and cost estimates.{" "}
                {accessMode === "read-only"
                  ? "Read-only agents cannot change files or send peer replies."
                  : "Full-access agents can run commands, change files, and send peer replies."}
              </p>
            ) : null}
            {progress.available > 0 ? (
              <p className="text-xs text-muted-foreground">
                Start a task to choose which project agents to work with. This setup conversation
                stays solo.
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button size="sm" variant="ghost" disabled={blocked} onClick={refreshProposal}>
              <RefreshCwIcon />
              {refreshing ? "Starting..." : "Refresh proposal"}
            </Button>
            {selectedIds.length > 0 ? (
              <Button size="sm" disabled={blocked} onClick={() => void createSelected(selectedIds)}>
                Apply {selectedIds.length} {selectedIds.length === 1 ? "assignment" : "assignments"}
              </Button>
            ) : progress.available > 0 ? (
              <Button size="sm" disabled={submitting} onClick={startTask}>
                Start a task <ArrowRightIcon />
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setReviewOpen(false)}>
                Done
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

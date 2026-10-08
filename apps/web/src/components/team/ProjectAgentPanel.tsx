import { AgentHeaderIdentity, AgentWorkspaceTools } from "./AgentWorkspaceTools";
import type {
  EnvironmentId,
  MeerkatProjectAgent,
  MeerkatTeamAgent,
  MeerkatTeamProvider,
  ProjectId,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ArchiveIcon, BoxIcon, CableIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";
import { useProject } from "../../state/entities";
import { randomUUID } from "../../lib/utils";
import { meerkatTeamEnvironment } from "../../state/meerkatTeam";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
  DialogClose,
} from "../ui/dialog";
import { AgentConversation } from "./AgentConversation";
import { EarlierAgentDrafts } from "./EarlierAgentDrafts";
import { nativeLabel } from "./agentActivity.logic";
import { ConversationWorkspaceControls } from "./ConversationWorkspaceChrome";
import { MeerkatPeerConnectionsBar } from "./MeerkatPeerConnections";
import { projectAgentPermissionLabel } from "./ProjectAgentPermissions";

import { readRestoreReviewWorkBlock, useRestoreReviewWorkBlock } from "./useRestoreReview";

export function ProjectAgentPanel({
  definition,
  environmentId,
  projectId,
  provider,
  agent,
  rosterStale,
  refreshTeam,
  projectTitle,
}: {
  definition: MeerkatProjectAgent;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  provider: MeerkatTeamProvider | undefined;
  agent: MeerkatTeamAgent | undefined;
  rosterStale: boolean;
  refreshTeam: () => void;
  projectTitle: string;
}) {
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const lifecycle = useAtomCommand(meerkatTeamEnvironment.projectAgentLifecycle, {
    reportFailure: false,
  });
  const prepare = useAtomCommand(meerkatTeamEnvironment.projectAgentPrepare, {
    reportFailure: false,
  });
  const update = useAtomCommand(meerkatTeamEnvironment.projectAgentUpdate, {
    reportFailure: false,
  });
  const [settings, setSettings] = useState(false);
  const [label, setLabel] = useState(definition.label);
  const [focus, setFocus] = useState(definition.focus ?? definition.label);
  const [charter, setCharter] = useState(definition.charter ?? definition.instructions);
  const [instructions, setInstructions] = useState(definition.instructions);
  const [paths, setPaths] = useState((definition.ownershipPaths ?? ["."]).join("\n"));
  const [reviewRevision, setReviewRevision] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const restoreBlock = useRestoreReviewWorkBlock(environmentId);
  async function act(action: "connect" | "disconnect" | "archive" | "unarchive") {
    if (busy) return;
    const currentBlock = action === "connect" ? readRestoreReviewWorkBlock(environmentId) : null;
    if (currentBlock) {
      setNotice(currentBlock);
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await lifecycle({
        environmentId,
        input: { projectId, agentId: definition.agentId, action },
      });
      if (result._tag === "Failure") setNotice(formatEnvironmentQueryError(result.cause));
      refreshTeam();
    } finally {
      setBusy(false);
    }
  }
  async function retryPreparation(refresh = false) {
    if (busy) return;
    const currentBlock = readRestoreReviewWorkBlock(environmentId);
    if (currentBlock) {
      setNotice(currentBlock);
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await prepare({
        environmentId,
        input: {
          projectId,
          agentId: definition.agentId,
          ...(refresh ? { refresh: true } : { retry: true }),
        },
      });
      if (result._tag === "Failure") setNotice(formatEnvironmentQueryError(result.cause));
      refreshTeam();
    } finally {
      setBusy(false);
    }
  }
  async function revise(applyPending = false) {
    if (busy) return;
    const currentBlock = readRestoreReviewWorkBlock(environmentId);
    if (currentBlock) {
      setNotice(currentBlock);
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await update({
        environmentId,
        input: {
          projectId,
          agentId: definition.agentId,
          ...(applyPending
            ? { applyPending: true }
            : {
                revision: {
                  requestId: randomUUID(),
                  instructions: instructions.trim(),
                  focus: focus.trim(),
                  charter: charter.trim(),
                  ownershipPaths: paths
                    .split("\n")
                    .map((path) => path.trim())
                    .filter(Boolean),
                },
              }),
        },
      });
      setNotice(
        result._tag === "Failure"
          ? formatEnvironmentQueryError(result.cause)
          : result.value.pendingRevision
            ? "Responsibilities saved for the next idle boundary."
            : (result.value.error ?? "Responsibilities applied. A fresh domain study has started."),
      );
      setReviewRevision(false);
      refreshTeam();
    } finally {
      setBusy(false);
    }
  }
  async function rename() {
    if (busy || !label.trim()) return;
    setBusy(true);
    try {
      const result = await update({
        environmentId,
        input: { projectId, agentId: definition.agentId, label: label.trim() },
      });
      setNotice(
        result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : "Name saved.",
      );
      refreshTeam();
    } finally {
      setBusy(false);
    }
  }
  const connected = definition.connectionStatus === "connected";
  const reconnectAction = definition.archived ? (
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("unarchive")}>
      {busy ? "Restoring..." : "Restore agent"}
    </Button>
  ) : (
    <Button
      size="sm"
      variant="outline"
      disabled={busy || restoreBlock !== null || definition.connectionStatus === "connecting"}
      title={restoreBlock ?? undefined}
      onClick={() => void act("connect")}
    >
      <CableIcon />
      {busy || definition.connectionStatus === "connecting" ? "Connecting..." : "Connect agent"}
    </Button>
  );
  const identity = (
    <AgentHeaderIdentity
      icon={<BoxIcon className="size-4 shrink-0 text-muted-foreground" />}
      label={definition.label}
      context={projectTitle}
    />
  );
  const actions = (
    <>
      <Tooltip>
        <TooltipTrigger render={<Badge size="sm" variant="secondary" />}>
          {projectAgentPermissionLabel(definition.accessMode)}
        </TooltipTrigger>
        <TooltipPopup>
          {definition.accessMode === "full-access"
            ? "Can edit files and run commands without approval."
            : definition.accessMode === "read-only"
              ? "File changes and shell commands are blocked."
              : "This server does not report this agent's permissions."}
        </TooltipPopup>
      </Tooltip>
      {definition.archived ? (
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void act("unarchive")}>
          Restore
        </Button>
      ) : !connected ? (
        <Button
          size="xs"
          variant="outline"
          disabled={busy || restoreBlock !== null || definition.connectionStatus === "connecting"}
          title={restoreBlock ?? undefined}
          onClick={() => void act("connect")}
        >
          <CableIcon />
          {busy ? "Connecting..." : "Connect"}
        </Button>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost-muted"
              aria-label="Agent settings"
              aria-haspopup="dialog"
              aria-expanded={settings}
              onClick={() => {
                setLabel(definition.label);
                setFocus(definition.focus ?? definition.label);
                setCharter(definition.charter ?? definition.instructions);
                setInstructions(definition.instructions);
                setPaths((definition.ownershipPaths ?? ["."]).join("\n"));
                setReviewRevision(false);
                setSettings(true);
              }}
            >
              <Settings2Icon />
            </Button>
          }
        />
        <TooltipPopup>Agent settings</TooltipPopup>
      </Tooltip>
      <ConversationWorkspaceControls />
    </>
  );
  return (
    <section
      className="@container/agent-panel flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label={definition.label}
    >
      {project?.workspaceRoot ? (
        <AgentWorkspaceTools
          environmentId={environmentId}
          projectId={projectId}
          cwd={project.workspaceRoot}
          projectTitle={projectTitle}
          workspaceAgent={definition}
          agent={agent}
          provider={provider}
          identity={identity}
          actions={actions}
        />
      ) : (
        <header className="flex h-12 min-w-0 shrink-0 items-center gap-2 border-b border-border px-3">
          {identity}
          {actions}
        </header>
      )}
      <MeerkatPeerConnectionsBar
        disabled={definition.archived}
        item={{
          environmentId,
          endpoint: {
            kind: "project-agent",
            projectId,
            agentId: definition.agentId,
            instanceId: definition.instanceId,
          },
          instanceId: definition.instanceId,
          label: definition.label,
          projectTitle,
        }}
      />
      {notice || definition.error ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2 text-xs text-warning-foreground">
          <p role="status" className="min-w-0 flex-1">
            {notice ?? definition.error}
          </p>
          {definition.error && !definition.enabled ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void act(definition.archived ? "archive" : "disconnect")}
            >
              Retry cleanup
            </Button>
          ) : null}
        </div>
      ) : null}
      {definition.preparation && definition.preparation.status !== "ready" ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
          <Badge size="sm" variant="secondary">
            {nativeLabel(definition.preparation.status)}
          </Badge>
          <span className="min-w-0 flex-1 truncate">
            {definition.preparation.error ?? definition.focus ?? "Learning its area of the project"}
          </span>
          {["failed", "interrupted", "uncertain"].includes(definition.preparation.status) ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !connected}
              onClick={() => void retryPreparation()}
            >
              Retry preparation
            </Button>
          ) : null}
        </div>
      ) : null}
      {definition.pendingRevision ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2 text-xs">
          <span className="min-w-0 flex-1 text-muted-foreground">
            {definition.pendingRevision.error ??
              `Responsibilities v${definition.pendingRevision.version} saved, awaiting an idle boundary.`}
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !connected || agent?.work?.status === "running"}
            onClick={() => void revise(true)}
          >
            Apply revision
          </Button>
        </div>
      ) : null}
      <Dialog open={settings} onOpenChange={setSettings}>
        <DialogPopup className="max-h-[min(85dvh,640px)] max-w-lg">
          <DialogHeader>
            <div className="space-y-2 pr-4">
              <DialogTitle>Agent settings</DialogTitle>
              <DialogDescription>{definition.label}</DialogDescription>
            </div>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-1">
              <p className="text-sm font-medium">
                Permissions: {projectAgentPermissionLabel(definition.accessMode)}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {definition.accessMode === "full-access"
                  ? "This agent can edit files and run commands without asking for approval."
                  : definition.accessMode === "read-only"
                    ? "This agent can inspect files. File changes, commands, and sending messages to peers are blocked."
                    : "Connect to an updated server to view this agent's permissions."}{" "}
                Permissions stay with this conversation across reconnects and responsibility
                changes. Create a new agent to choose a different mode.
              </p>
            </div>
            <form
              className="flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void rename();
              }}
            >
              <label className="min-w-0 flex-1 space-y-2 text-sm">
                <span>Display name</span>
                <Input
                  value={label}
                  maxLength={120}
                  disabled={busy}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              <Button
                type="submit"
                size="sm"
                variant="outline"
                disabled={busy || !label.trim() || label.trim() === definition.label}
              >
                Save name
              </Button>
            </form>
            <details open={reviewRevision || Boolean(definition.pendingRevision)}>
              <summary className="cursor-pointer text-sm font-medium">
                Responsibilities and instructions
              </summary>
              <div className="mt-3 space-y-3">
                <p className="text-xs text-muted-foreground">
                  Version {definition.revisionVersion ?? 1}. Revisions keep this agent's
                  conversation and connections. Changes apply when idle, followed by a fresh study.
                </p>
                {definition.pendingRevision ? (
                  <div className="space-y-2 rounded-lg border border-border p-3 text-xs">
                    <p className="font-medium">
                      Saved revision v{definition.pendingRevision.version}
                    </p>
                    <p>{definition.pendingRevision.focus}</p>
                    <p className="whitespace-pre-wrap text-muted-foreground">
                      {definition.pendingRevision.charter}
                    </p>
                    <p className="break-words font-mono text-muted-foreground">
                      {definition.pendingRevision.ownershipPaths.join(", ")}
                    </p>
                    <p role="status" className="text-muted-foreground">
                      {definition.pendingRevision.error ?? "Ready to apply when idle."}
                    </p>
                    <Button
                      size="xs"
                      disabled={busy || !connected || agent?.work?.status === "running"}
                      onClick={() => void revise(true)}
                    >
                      Apply saved revision
                    </Button>
                  </div>
                ) : (
                  <>
                    <label className="block space-y-1 text-xs">
                      Focus
                      <Input
                        value={focus}
                        maxLength={2000}
                        disabled={busy || reviewRevision}
                        onChange={(event) => setFocus(event.target.value)}
                      />
                    </label>
                    <label className="block space-y-1 text-xs">
                      Responsibilities
                      <Textarea
                        value={charter}
                        maxLength={16000}
                        disabled={busy || reviewRevision}
                        onChange={(event) => setCharter(event.target.value)}
                      />
                    </label>
                    <label className="block space-y-1 text-xs">
                      Owned paths, one per line
                      <Textarea
                        value={paths}
                        disabled={busy || reviewRevision}
                        onChange={(event) => setPaths(event.target.value)}
                      />
                    </label>
                    <label className="block space-y-1 text-xs">
                      Agent instructions
                      <Textarea
                        value={instructions}
                        maxLength={32000}
                        disabled={busy || reviewRevision}
                        onChange={(event) => setInstructions(event.target.value)}
                      />
                    </label>
                    {reviewRevision ? (
                      <div className="space-y-2 rounded-lg bg-muted/40 p-3">
                        <p className="text-xs font-medium">Review responsibility changes</p>
                        <dl className="space-y-2 text-xs">
                          <div>
                            <dt className="text-muted-foreground">Previous focus</dt>
                            <dd>{definition.focus ?? "No explicit focus"}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">Previous responsibilities</dt>
                            <dd className="whitespace-pre-wrap">
                              {definition.charter ?? definition.instructions}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">Previous paths</dt>
                            <dd>{definition.ownershipPaths?.join(", ") ?? "Not assigned"}</dd>
                          </div>
                          {instructions !== definition.instructions ? (
                            <div>
                              <dt className="text-muted-foreground">Previous instructions</dt>
                              <dd className="whitespace-pre-wrap">{definition.instructions}</dd>
                            </div>
                          ) : null}
                        </dl>
                        <div className="flex gap-2">
                          <Button size="xs" disabled={busy} onClick={() => void revise()}>
                            Save revision
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => setReviewRevision(false)}
                          >
                            Edit
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={
                          busy ||
                          definition.archived ||
                          !focus.trim() ||
                          !charter.trim() ||
                          !instructions.trim() ||
                          !paths.trim() ||
                          (instructions === definition.instructions &&
                            focus === definition.focus &&
                            charter === definition.charter &&
                            paths === definition.ownershipPaths?.join("\n"))
                        }
                        onClick={() => setReviewRevision(true)}
                      >
                        Review revision
                      </Button>
                    )}
                  </>
                )}
              </div>
            </details>
            {definition.ownershipPaths?.length ? (
              <section className="space-y-2 border-t border-border pt-3">
                <h3 className="text-sm font-medium">Project knowledge</h3>
                <p className="text-xs text-muted-foreground">
                  {definition.preparation?.status === "ready"
                    ? `Studied snapshot from ${new Date(definition.preparation.evidence?.capturedAt ?? definition.preparation.updatedAt).toLocaleString()}.`
                    : definition.preparation
                      ? `Study: ${nativeLabel(definition.preparation.status)}.`
                      : "No completed study for these responsibilities."}{" "}
                  Working files can change after a study.
                </p>
                {definition.preparation?.evidence ? (
                  <p className="text-xs text-muted-foreground">
                    {definition.preparation.evidence.fileCount} files, content{" "}
                    {definition.preparation.evidence.contentFingerprint.slice(0, 12)}. Includes
                    uncommitted edits. Excludes{" "}
                    {definition.preparation.evidence.excludedDirectories.join(", ")}.
                  </p>
                ) : null}
                <Button
                  size="xs"
                  variant="outline"
                  disabled={
                    busy ||
                    !connected ||
                    Boolean(definition.pendingRevision) ||
                    ["running"].includes(agent?.work?.status ?? "") ||
                    ["studying", "dispatching"].includes(definition.preparation?.status ?? "")
                  }
                  onClick={() => void retryPreparation(true)}
                >
                  Refresh domain knowledge
                </Button>
              </section>
            ) : null}
            {notice ? (
              <p role="status" className="text-xs text-muted-foreground">
                {notice}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <div className="mr-auto flex flex-wrap gap-2">
              {connected ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void act("disconnect")}
                >
                  Disconnect
                </Button>
              ) : null}
              {!definition.archived ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void act("archive")}
                >
                  <ArchiveIcon />
                  Archive
                </Button>
              ) : null}
            </div>
            <DialogClose render={<Button size="sm" variant="outline" />}>Done</DialogClose>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      {agent && provider ? (
        <AgentConversation
          key={agent.agentRef}
          environmentId={environmentId}
          projectId={projectId}
          provider={provider}
          agent={agent}
          displayName={definition.label}
          primaryProjectAgentId={definition.agentId}
          accessMode={definition.accessMode}
          cwd={project?.workspaceRoot}
          rosterStale={rosterStale}
          readOnlyReason={
            definition.archived
              ? "This conversation is saved. Restore the archived agent to continue."
              : !connected
                ? "This conversation is saved. Connect the agent to continue."
                : undefined
          }
          readOnlyAction={reconnectAction}
          refreshTeam={refreshTeam}
        />
      ) : (
        <div className="flex min-h-40 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <BoxIcon className="size-9 text-muted-foreground" />
          <h3 className="text-sm font-medium">
            {definition.archived ? "This agent is archived" : "Your agent is saved"}
          </h3>
          <p className="max-w-sm text-sm text-muted-foreground">
            {definition.archived
              ? "Restore it to make it available in this project again."
              : "Connect to resume its conversation and make it available to threads."}
          </p>
          {reconnectAction}
          <EarlierAgentDrafts
            environmentId={environmentId}
            projectId={projectId}
            instanceId={definition.instanceId}
          />
        </div>
      )}
    </section>
  );
}

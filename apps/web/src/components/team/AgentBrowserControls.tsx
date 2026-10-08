import { createMeerkatMediaAtoms } from "@t3tools/client-runtime/state/meerkatMedia";
import type { RuntimeMode, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Link } from "@tanstack/react-router";
import { GlobeIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useProject, useThreadShell, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { vcsEnvironment } from "../../state/vcs";
import { useEnvironmentQuery } from "../../state/query";
import { useVisibleTeamRefresh } from "../../state/meerkatTeam";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import type { NativeMediaScope } from "./NativeAgentImages";
import { useAgentWorkspaceHandoff } from "./useAgentWorkspaceHandoff";
import { resolveAgentWorkspaceModel } from "./agentWorkspaceModel";
import { useProviderWorkspaceReadiness } from "../../hooks/useProviderWorkspaceReadiness";
import { readRestoreReviewWorkBlock } from "./useRestoreReview";
import {
  useAgentWorkspaceHandoffStore,
  type AgentWorkspaceAttentionOrigin,
  type AgentWorkspaceOrigin,
} from "./agentWorkspaceHandoffStore";

type AgentBrowserControlsProps = {
  scope: NativeMediaScope;
  workspaceCwd: string | undefined;
  ownerThreadId?: ThreadId | undefined;
  primaryProjectAgentId?: string | undefined;
  returnAttention?: AgentWorkspaceAttentionOrigin | undefined;
  label: string;
  currentModel?: string | undefined;
  accessMode?: RuntimeMode | undefined;
  disabled?: boolean;
};

const media = createMeerkatMediaAtoms(connectionAtomRuntime);

/** Browser access is an explicit grant to a real same-project thread workspace. */
export function AgentBrowserControls(props: AgentBrowserControlsProps) {
  const { environmentId, projectId, instanceId, agentRef, threadId } = props.scope;
  return (
    <ScopedAgentBrowserControls
      key={JSON.stringify([
        environmentId,
        projectId,
        instanceId,
        agentRef,
        threadId,
        props.ownerThreadId,
        props.workspaceCwd,
        props.returnAttention?.attentionId,
      ])}
      {...props}
    />
  );
}

function ScopedAgentBrowserControls({
  scope,
  workspaceCwd: requestedWorkspaceCwd,
  ownerThreadId,
  primaryProjectAgentId,
  returnAttention,
  label,
  currentModel,
  accessMode,
  disabled = false,
}: AgentBrowserControlsProps) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<ThreadId | undefined>(ownerThreadId ?? scope.threadId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { environmentId, ...target } = scope;
  const readOnly = accessMode === "read-only";
  const project = useProject(scopeProjectRef(environmentId, scope.projectId));
  const owningThreadId = ownerThreadId ?? scope.threadId;
  const owningThread = useThreadShell(
    owningThreadId ? scopeThreadRef(environmentId, owningThreadId) : null,
  );
  // Revalidate the owner here as well as at the conversation boundary. An old
  // or still-loading caller must not create a host in a worker's project root.
  const workspaceCwd = owningThreadId
    ? owningThread &&
      requestedWorkspaceCwd === (owningThread.worktreePath ?? project?.workspaceRoot)
      ? requestedWorkspaceCwd
      : undefined
    : requestedWorkspaceCwd;
  const { environments } = useEnvironments();
  const providers =
    environments.find((entry) => entry.environmentId === environmentId)?.serverConfig?.providers ??
    [];
  const workspace = useProviderWorkspaceReadiness({
    environmentId,
    cwd: workspaceCwd,
    providers,
    instanceId: scope.instanceId,
  });
  const provider = workspace.providers.find((entry) => entry.instanceId === scope.instanceId);
  const { model, blockedReason } = resolveAgentWorkspaceModel(provider?.models ?? [], currentModel);
  const modelBlockedReason = workspace.pendingInstanceIds.has(scope.instanceId)
    ? "Checking models for this workspace..."
    : blockedReason;
  // Helpers inherit projectAgentId from their domain. Only an explicit primary
  // definition or the verified attention item can identify their return route.
  const origin: AgentWorkspaceOrigin | null = owningThreadId
    ? {
        kind: "thread",
        environmentId,
        projectId: scope.projectId,
        threadId: owningThreadId,
        ...(scope.agentRef ? { member: scope.agentRef } : {}),
        label,
      }
    : primaryProjectAgentId
      ? {
          kind: "project-agent",
          environmentId,
          projectId: scope.projectId,
          agentId: primaryProjectAgentId,
          label,
        }
      : returnAttention?.environmentId === environmentId &&
          returnAttention.projectId === scope.projectId &&
          returnAttention.instanceId === scope.instanceId &&
          returnAttention.agentRef === scope.agentRef
        ? returnAttention
        : null;
  const handoff = useAgentWorkspaceHandoff(origin ? { purpose: "browser", origin } : null);
  const grant = useAtomCommand(media.browserGrant, { reportFailure: false });
  const status = useEnvironmentQuery(
    open && !disabled ? media.browserStatus({ environmentId, input: target }) : null,
  );
  const checkout = useEnvironmentQuery(
    open && workspaceCwd
      ? vcsEnvironment.status({ environmentId, input: { cwd: workspaceCwd } })
      : null,
  );
  useVisibleTeamRefresh(status, open && !disabled);
  const threads = useThreadShells().filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.projectId === scope.projectId &&
      thread.modelSelection.instanceId === scope.instanceId &&
      Boolean(workspaceCwd) &&
      (thread.worktreePath ?? project?.workspaceRoot) === workspaceCwd &&
      !thread.archivedAt,
  );
  const selected =
    threads.find((thread) => thread.id === chosen) ??
    threads.find((thread) => thread.id === status.data?.hostThreadId) ??
    (threads.length === 1 ? threads[0] : undefined);
  const shared = threads.find((thread) => thread.id === status.data?.hostThreadId);
  const workspaceLoading = !project || !workspaceCwd || (status.isPending && threads.length === 0);
  function rememberHost(hostThreadId: ThreadId) {
    if (readOnly || !origin || !workspaceCwd) return;
    useAgentWorkspaceHandoffStore.getState().save({
      purpose: "browser",
      origin,
      target,
      hostThreadId,
      cwd: workspaceCwd,
      branch: checkout.data?.refName ?? owningThread?.branch ?? null,
    });
  }
  function createHost() {
    if (handoff.savedAttempt) {
      void handoff.resume();
      return;
    }
    if (readOnly || !origin || !workspaceCwd || !model) return;
    void handoff.start({
      purpose: "browser",
      origin,
      target,
      cwd: workspaceCwd,
      branch: checkout.data?.refName ?? owningThread?.branch ?? null,
      worktreePath: owningThread?.worktreePath ?? null,
      modelSelection: { instanceId: scope.instanceId, model: model.slug },
    });
  }
  async function change(enabled: boolean) {
    const restoreBlock = readRestoreReviewWorkBlock(environmentId);
    if (restoreBlock) {
      setError(restoreBlock);
      return;
    }
    if (enabled && (readOnly || !selected)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await grant({
        environmentId,
        input: {
          ...target,
          enabled,
          ...(enabled && selected ? { hostThreadId: selected.id } : {}),
        },
      });
      if (!mounted.current) return;
      if (result._tag !== "Success")
        setError(
          "Browser access could not be changed. Open the chosen thread in the desktop app and enable agent browser access, then retry.",
        );
      else if (enabled && !result.value.enabled)
        setError(
          result.value.message ??
            "No desktop browser host is connected. Open this environment in the desktop app and try again.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost-muted"
            size="icon-sm"
            disabled={disabled}
            aria-label="Browser access"
            title="Browser access"
          />
        }
      >
        <GlobeIcon />
      </PopoverTrigger>
      <PopoverPopup className="w-80" side="top" align="start">
        <div className="space-y-3 p-3">
          <PopoverTitle>Shared browser</PopoverTitle>
          <p className="text-xs text-muted-foreground">
            Share a desktop browser in the same checkout. A web client can manage sharing when a
            desktop app is connected to this environment.
          </p>
          {readOnly ? (
            <p className="text-xs text-muted-foreground">
              Read-only agents cannot use browser tools. Use a Full access specialist or task.
              Existing sharing can still be revoked below.
            </p>
          ) : null}
          <p className="break-all text-xs text-muted-foreground">
            {workspaceCwd ?? "Waiting for this agent's checkout."}
          </p>
          <p className="text-xs" role="status">
            {status.error ??
              (!status.isPending && status.data
                ? (status.data.message ??
                  (status.data.enabled
                    ? readOnly
                      ? "Sharing is saved, but this agent's Read-only permissions still apply."
                      : "Browser access is enabled."
                    : "Browser access is off."))
                : "Checking browser access...")}
          </p>
          {status.data?.reason === "disabled" ? (
            <Button size="xs" variant="outline" render={<Link to="/settings/projects" />}>
              Open project settings
            </Button>
          ) : null}
          {status.data?.enabled && shared ? (
            <p className="text-xs">Shared workspace: {shared.title}</p>
          ) : null}
          <label className="block text-xs">
            Browser workspace
            <select
              aria-label="Browser workspace"
              className="mt-1 w-full rounded border bg-background p-2"
              value={selected?.id ?? ""}
              disabled={busy || workspaceLoading}
              onChange={(event) =>
                setChosen(threads.find((thread) => thread.id === event.target.value)?.id)
              }
            >
              <option value="">
                {workspaceLoading ? "Loading workspaces..." : "Choose a thread"}
              </option>
              {threads.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title}
                  {thread.branch ? ` (${thread.branch})` : ""}
                </option>
              ))}
            </select>
          </label>
          {!threads.length ? (
            <p className="text-xs text-muted-foreground">
              {workspaceLoading
                ? "Loading compatible workspaces..."
                : "No compatible thread exists in this checkout. Create a browser workspace below."}
            </p>
          ) : null}
          {error || handoff.error ? (
            <p role="alert" className="text-xs text-destructive">
              {error ?? handoff.error}
            </p>
          ) : null}
          {modelBlockedReason ? (
            <p className="text-xs text-muted-foreground">
              {modelBlockedReason}{" "}
              <Link
                to="/settings/providers"
                search={{ environmentId, instanceId: scope.instanceId }}
              >
                Open Providers
              </Link>
            </p>
          ) : null}
          {handoff.recovery ? (
            <div className="space-y-2 text-xs">
              <p>{handoff.recovery.message}</p>
              <Button
                size="sm"
                variant="outline"
                disabled={handoff.recovery.pending}
                onClick={() => void handoff.recovery?.retry()}
              >
                {handoff.recovery.pending ? "Opening saved task..." : handoff.recovery.label}
              </Button>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={
                readOnly ||
                busy ||
                !selected ||
                Boolean(status.error) ||
                status.data?.reason === "disabled"
              }
              onClick={() => void change(true)}
            >
              Share browser
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !status.data?.enabled}
              onClick={() => void change(false)}
            >
              Stop sharing
            </Button>
            {(shared ?? selected) ? (
              <Button
                size="sm"
                variant="ghost"
                render={
                  <Link
                    to="/$environmentId/$threadId"
                    params={{ environmentId, threadId: (shared ?? selected)!.id }}
                    onClick={() => rememberHost((shared ?? selected)!.id)}
                  />
                }
              >
                Open workspace
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy ||
                handoff.pending ||
                !origin ||
                (!handoff.savedAttempt &&
                  (readOnly || !workspaceCwd || !model || status.data?.reason === "disabled"))
              }
              onClick={createHost}
            >
              {handoff.pending
                ? "Opening workspace..."
                : handoff.savedAttempt
                  ? handoff.savedAttempt.accepted
                    ? "Open saved browser task"
                    : "Retry opening task"
                  : "Create browser workspace"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Open the shared workspace to take control. Stop sharing revokes this agent's access;
            reconnecting an agent or closing its browser host requires sharing again.
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

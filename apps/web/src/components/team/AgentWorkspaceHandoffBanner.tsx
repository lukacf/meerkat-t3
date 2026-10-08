import { createMeerkatMediaAtoms } from "@t3tools/client-runtime/state/meerkatMedia";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import {
  canObserveMeerkatCoordinator,
  useMeerkatCoordinatorWork,
} from "../../state/meerkatCoordinatorWork";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  agentWorkspaceOriginDestination,
  handoffKey,
  useAgentWorkspaceHandoffStore,
} from "./agentWorkspaceHandoffStore";

const media = createMeerkatMediaAtoms(connectionAtomRuntime);

export function AgentWorkspaceHandoffBanner({
  environmentId,
  threadId,
  persisted,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  persisted: boolean;
}) {
  const record = useAgentWorkspaceHandoffStore(
    (state) => state.records[handoffKey(environmentId, threadId)],
  );
  const navigate = useNavigate();
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const environment = useEnvironment(environmentId);
  const session = thread?.session;
  const matchingSession = Boolean(
    persisted &&
    environment?.connection.phase === "connected" &&
    session?.providerInstanceId === record?.target.instanceId &&
    canObserveMeerkatCoordinator(session) &&
    (session?.status === "ready" || session?.status === "running" || session?.status === "idle"),
  );
  const observation = useMeerkatCoordinatorWork(
    environmentId,
    record?.purpose === "browser" && matchingSession
      ? {
          projectId: record.target.projectId,
          instanceId: record.target.instanceId,
          threadId,
        }
      : null,
  );
  const grant = useAtomCommand(media.browserGrant, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (!record) return null;
  // A saved ready session can outlive its native coordinator after a restart.
  // Only the canonical live observation can make this browser host shareable.
  const sessionReady = Boolean(
    matchingSession &&
    observation.isSuccess &&
    observation.data &&
    !observation.isPending &&
    !observation.error &&
    !observation.isDormant,
  );
  const readinessError = matchingSession ? observation.error : null;
  const sessionGuidance =
    environment?.connection.phase !== "connected"
      ? "Reconnect this environment before sharing its browser."
      : session?.status === "starting"
        ? "Starting this task's agent session. Share its browser when the session is ready."
        : session && session.providerInstanceId !== record.target.instanceId
          ? "This task uses a different provider connection. Return to your agent to create a compatible browser workspace."
          : session?.status === "error"
            ? "Use the recovery controls below to reconnect this task's agent session before sharing its browser."
            : observation.isDormant
              ? "Send a message below to resume this task's agent session, then share its browser and return."
              : readinessError
                ? "The agent session could not be checked. Retry before sharing its browser."
                : matchingSession
                  ? "Checking this task's agent session before sharing its browser."
                  : session
                    ? "Send a message below to resume this task's agent session, then share its browser and return."
                    : "Send a first message below to start this task's agent session, then share its browser and return.";
  const source = record.origin;
  const destination = agentWorkspaceOriginDestination(source);
  async function share() {
    if (!record || busy || !sessionReady) return;
    setBusy(true);
    setError(null);
    try {
      const result = await grant({
        environmentId,
        input: { ...record.target, hostThreadId: threadId, enabled: true },
      });
      if (
        !mounted.current ||
        useAgentWorkspaceHandoffStore.getState().records[handoffKey(environmentId, threadId)] !==
          record
      )
        return;
      if (result._tag !== "Success") {
        setError(formatEnvironmentQueryError(result.cause));
      } else if (!result.value.enabled) {
        setError(
          result.value.message ??
            "Connect this environment in the desktop app, start this thread's agent session, then try again.",
        );
      } else {
        await navigate(destination);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div
      className="shrink-0 space-y-2 border-b border-border bg-muted/20 px-4 py-2 text-xs"
      aria-label="Agent workspace handoff"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">
          {record.purpose === "browser" ? "Browser workspace" : "Delivery task"} from {source.label}
        </span>
        {record.purpose === "browser" ? (
          <Button size="xs" disabled={busy || !sessionReady} onClick={() => void share()}>
            {busy ? "Sharing..." : "Share browser and return"}
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" render={<Link {...destination} />}>
          Return to {source.label}
        </Button>
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() => useAgentWorkspaceHandoffStore.getState().remove(environmentId, threadId)}
        >
          Dismiss
        </Button>
      </div>
      <p className="break-all text-muted-foreground">
        Source checkout: {record.cwd}
        {record.branch ? ` - ${record.branch}` : ""}
      </p>
      <p className="text-muted-foreground">
        {record.purpose === "browser"
          ? sessionReady
            ? "The agent session is ready. Share its browser and return to your agent. A desktop app must be connected to this environment."
            : sessionGuidance
          : "Add the findings you want to carry forward before sending. Pull requests created from this task are linked here."}
      </p>
      {record.context ? (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer">Saved handoff context</summary>
          <p className="mt-2 whitespace-pre-wrap break-words">{record.context}</p>
        </details>
      ) : null}
      {error || readinessError ? (
        <p role="alert" className="text-destructive">
          {error ?? readinessError}
          {readinessError ? (
            <>
              {" "}
              <button type="button" className="underline" onClick={observation.refresh}>
                Retry
              </button>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

import type {
  EnvironmentId,
  MeerkatAuthActionInput,
  MeerkatAuthFlow,
  MeerkatAuthScope,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { meerkatControlsEnvironment } from "../../state/meerkatControls";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  meerkatAuthScopeKey,
  meerkatAuthWorkspaceMatches,
  meerkatConnectionSetup,
} from "./MeerkatProviderControls.logic";

type Provider = MeerkatAuthActionInput["provider"];
interface MeerkatProviderControlsProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  instanceId: ProviderInstanceId;
  threadTarget?: MeerkatAuthScope["threadTarget"];
}

export function MeerkatProviderControls(props: MeerkatProviderControlsProps) {
  return (
    <ScopedMeerkatProviderControls
      key={meerkatAuthScopeKey(props.environmentId, props)}
      {...props}
    />
  );
}

function ScopedMeerkatProviderControls({
  environmentId,
  projectId,
  instanceId,
  threadTarget,
}: MeerkatProviderControlsProps) {
  const navigate = useNavigate();
  const scope: MeerkatAuthScope = {
    projectId,
    instanceId,
    ...(threadTarget ? { threadTarget } : {}),
  };
  const query = useEnvironmentQuery(
    meerkatControlsEnvironment.authStatus({ environmentId, input: scope }),
  );
  const command = useAtomCommand(meerkatControlsEnvironment.authAction, { reportFailure: false });
  const [flow, setFlow] = useState<(MeerkatAuthFlow & { provider: Provider }) | null>(null);
  const [callback, setCallback] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [pollingPaused, setPollingPaused] = useState(false);
  const workspaceMatches = meerkatAuthWorkspaceMatches(scope, query.data);
  const scopeError =
    query.error ??
    (threadTarget && query.data && !workspaceMatches
      ? "This account view does not match the requested checkout. Refresh connections."
      : null);
  const actionsAllowed = workspaceMatches && scopeError === null;
  const activeRef = useRef(false);
  const pendingRef = useRef(false);
  const currentRef = useRef({ actionsAllowed, flow, callback });
  useLayoutEffect(() => {
    currentRef.current = { actionsAllowed, flow, callback };
  }, [actionsAllowed, flow, callback]);
  useLayoutEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);
  const action = async (provider: Provider, action: MeerkatAuthActionInput["action"]) => {
    if (!activeRef.current || pendingRef.current || !currentRef.current.actionsAllowed) return;
    const currentFlow = currentRef.current.flow;
    const flowAction = action === "complete" || action === "cancel" || action === "status";
    if (flowAction && (!currentFlow?.flowId || currentFlow.provider !== provider)) return;
    const callbackUrl = currentRef.current.callback;
    if (action === "complete" && !callbackUrl.trim()) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await command({
        environmentId,
        input: {
          ...scope,
          provider,
          action,
          ...(flowAction && currentFlow?.flowId ? { flowId: currentFlow.flowId } : {}),
          ...(action === "complete" ? { callbackUrl } : {}),
        },
      });
      if (!activeRef.current) return;
      if (result._tag === "Failure") {
        setError(
          action === "complete"
            ? "Sign-in could not be completed. Refresh its status before retrying."
            : formatEnvironmentQueryError(result.cause),
        );
        if (action === "status") setPollingPaused(true);
      } else {
        setPollingPaused(false);
        setFlow({ ...result.value, provider });
        if (result.value.status !== "waiting") {
          query.refresh();
          setCallback("");
        }
      }
    } catch {
      if (activeRef.current) {
        setError("The sign-in request failed. Refresh connections before retrying.");
        if (action === "status") setPollingPaused(true);
      }
    } finally {
      pendingRef.current = false;
      if (activeRef.current) setPending(false);
    }
  };
  const pollStatus = useEffectEvent(() => {
    const currentFlow = currentRef.current.flow;
    if (currentFlow?.status === "waiting") void action(currentFlow.provider, "status");
  });
  useEffect(() => {
    if (!flow?.flowId || flow.status !== "waiting" || !actionsAllowed || pending || pollingPaused)
      return;
    const timer = window.setTimeout(() => pollStatus(), 2000);
    return () => window.clearTimeout(timer);
  }, [flow, actionsAllowed, pending, pollingPaused]);
  const refreshConnections = () => {
    if (!activeRef.current) return;
    setPollingPaused(false);
    setError(null);
    query.refresh();
  };
  return (
    <div className="space-y-3 p-3">
      <p className="text-sm font-medium">Provider connections</p>
      <p className="text-xs text-muted-foreground">
        Browser sign-in uses a configured OAuth profile. API keys are set in this provider's
        Credentials settings on the selected environment.
      </p>
      {threadTarget && workspaceMatches && query.data?.workspace && !scopeError ? (
        <p className="break-all text-xs text-muted-foreground">
          Checkout: {query.data.workspace.cwd}
        </p>
      ) : null}
      {(error ?? scopeError) && (
        <p role="alert" className="text-xs text-destructive">
          {error ?? scopeError}
        </p>
      )}
      {query.isPending && !query.data && (
        <p className="text-xs text-muted-foreground">Checking connections...</p>
      )}
      {threadTarget && !query.data && !query.isPending && !scopeError ? (
        <p className="text-xs text-muted-foreground">
          This checkout's account status is unavailable. Refresh connections.
        </p>
      ) : null}
      {(workspaceMatches && !scopeError ? query.data?.connections : [])?.map((connection) => {
        const setup = meerkatConnectionSetup(connection);
        return (
          <div
            key={`${connection.provider}:${connection.bindingId}`}
            className="flex flex-wrap items-center gap-2 text-xs"
          >
            <div className="min-w-24 flex-1">
              <p className="font-medium">{connection.displayName}</p>
              <p className="text-muted-foreground">{setup.label}</p>
            </div>
            {setup.interactive ? (
              <>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pending || !actionsAllowed}
                  onClick={() => void action(connection.provider as Provider, "start")}
                >
                  {connection.state === "connected" ? "Sign in again" : "Sign in"}
                </Button>
                {connection.state === "connected" && (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={pending || !actionsAllowed}
                    onClick={() => void action(connection.provider as Provider, "logout")}
                  >
                    Sign out
                  </Button>
                )}
              </>
            ) : setup.environmentSetup ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  void navigate({
                    to: "/settings/providers",
                    search: {
                      environmentId,
                      instanceId,
                      machine: environmentId,
                      project: undefined,
                      checkout: undefined,
                      ...(threadTarget
                        ? {
                            accountProject: projectId,
                            accountThread: threadTarget.threadId,
                            accountCwd: threadTarget.expectedCwd,
                          }
                        : {}),
                    },
                    hash: "provider-environment",
                  })
                }
              >
                Set up credentials
              </Button>
            ) : (
              <span className="text-muted-foreground">Host configuration</span>
            )}
            {setup.instructions && (
              <p className="w-full text-muted-foreground">{setup.instructions}</p>
            )}
          </div>
        );
      })}
      {flow?.status === "waiting" && (
        <div className="space-y-2 rounded-md border p-2 text-xs">
          {flow.authorizeUrl && actionsAllowed && (
            <a
              href={flow.authorizeUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline"
            >
              Continue sign-in in browser
            </a>
          )}
          <p className="text-muted-foreground">
            On another device, copy the final callback URL from your browser and paste it here.
          </p>
          <Input
            aria-label="Sign-in callback URL"
            type="password"
            autoComplete="off"
            value={callback}
            disabled={pending || !actionsAllowed}
            onChange={(event) => setCallback(event.target.value)}
            placeholder="Callback URL"
          />
          <div className="flex gap-2">
            <Button
              size="xs"
              disabled={pending || !actionsAllowed || !callback.trim()}
              onClick={() => void action(flow.provider, "complete")}
            >
              Complete sign-in
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={pending || !actionsAllowed}
              onClick={() => void action(flow.provider, "cancel")}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {flow?.message && (
        <p role="status" className="text-xs">
          {flow.message}
        </p>
      )}
      <Button size="xs" variant="ghost" onClick={refreshConnections}>
        Refresh connections
      </Button>
    </div>
  );
}

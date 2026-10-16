import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  type ProviderInstanceId,
  type EnvironmentId,
  type MeerkatAuthActionInput,
  type MeerkatAuthConnection,
  type MeerkatAuthFlow,
  type MeerkatAuthMethod,
  type MeerkatAuthScope,
  type ProjectId,
} from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  KeyRoundIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import {
  deriveProviderInstanceEntries,
  resolveMeerkatAccountInstance,
} from "../../providerInstances";
import { meerkatControlsEnvironment } from "../../state/meerkatControls";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import {
  meerkatAuthScopeKey,
  meerkatAuthWorkspaceMatches,
} from "../team/MeerkatProviderControls.logic";
import { useProviderAccountTarget } from "./ProviderAccountContext";
import {
  accountFormReady,
  accountIdentity,
  accountKey,
  accountMethod,
  accountRouteLabel,
  accountStatus,
  groupProviderAccounts,
  signInUrl,
  type ProviderAccountGroup,
} from "./providerAccounts";

interface ProviderAccountsPanelProps {
  environmentId: EnvironmentId;
  instanceId?: ProviderInstanceId | undefined;
  environmentLabel?: string;
  projectId?: ProjectId;
  threadTarget?: MeerkatAuthScope["threadTarget"];
  readOnly?: boolean;
  compact?: boolean;
  onPendingChange?: (pending: boolean) => void;
  onErrorChange?: (hasError: boolean) => void;
}

export function ProviderAccountsPanel(props: ProviderAccountsPanelProps) {
  const target = useProviderAccountTarget();
  const applies = target?.environmentId === props.environmentId;
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.environmentId));
  const projectId = props.projectId ?? (applies ? target.projectId : undefined);
  const threadTarget = props.threadTarget ?? (applies ? target.threadTarget : undefined);
  const instanceId = resolveMeerkatAccountInstance({
    entries: deriveProviderInstanceEntries(providers ?? []),
    requestedInstanceId: props.instanceId ?? (applies ? target.instanceId : undefined),
    requireExactInstance: projectId !== undefined || threadTarget !== undefined,
  });
  const providersKnown = providers !== null;
  useEffect(() => {
    if (instanceId) return;
    props.onPendingChange?.(false);
    props.onErrorChange?.(providersKnown);
  }, [instanceId, providersKnown, props.onPendingChange, props.onErrorChange]);
  if (!instanceId) {
    return (
      <p role={providers === null ? "status" : "alert"} className="text-sm text-muted-foreground">
        {providers === null
          ? "Loading model accounts for this device."
          : "Model accounts are unavailable for this connection. Reconnect this device or open Providers from the Meerkat conversation you want to use."}
      </p>
    );
  }
  const scope: MeerkatAuthScope = {
    instanceId,
    ...(projectId ? { projectId } : {}),
    ...(threadTarget ? { threadTarget } : {}),
  };
  return (
    <ScopedProviderAccountsPanel
      key={meerkatAuthScopeKey(props.environmentId, scope)}
      {...props}
      scope={scope}
    />
  );
}

type AccountFlow = {
  value: MeerkatAuthFlow;
  connection: MeerkatAuthConnection;
  device: boolean;
  scope: MeerkatAuthScope;
};

function ScopedProviderAccountsPanel({
  environmentId,
  environmentLabel,
  scope,
  readOnly = false,
  compact = false,
  onPendingChange,
  onErrorChange,
}: ProviderAccountsPanelProps & { scope: MeerkatAuthScope }) {
  const query = useEnvironmentQuery(
    meerkatControlsEnvironment.authStatus({ environmentId, input: scope }),
  );
  const command = useAtomCommand(meerkatControlsEnvironment.authAction, { reportFailure: false });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<MeerkatAuthMethod | null>(null);
  const [editing, setEditing] = useState<MeerkatAuthConnection | null>(null);
  const [editingScope, setEditingScope] = useState<MeerkatAuthScope>(scope);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState("");
  const [callback, setCallback] = useState("");
  const [flow, setFlow] = useState<AccountFlow | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pollingPaused, setPollingPaused] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ProviderAccountGroup | null>(null);
  const active = useRef(false);
  const busy = useRef(false);
  const current = useRef({ flow, allowed: false });
  const matches = meerkatAuthWorkspaceMatches(scope, query.data);
  const scopeError = query.error
    ? "Could not read provider accounts. Check this device's connection and try again."
    : query.data && !matches
      ? "This account view no longer matches the requested checkout. Reopen Providers from the conversation."
      : null;
  const allowed = matches && !scopeError && !readOnly;
  const methods = query.data?.methods ?? [];
  const connections = matches && !scopeError ? (query.data?.connections ?? []) : [];
  const accounts = groupProviderAccounts(connections);
  const authenticated = accounts.filter((account) =>
    account.connections.some((connection) => connection.state === "connected"),
  );

  useLayoutEffect(() => {
    current.current = { flow, allowed };
  }, [flow, allowed]);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    onPendingChange?.(pending || flow?.value.status === "waiting");
  }, [pending, flow, onPendingChange]);
  useEffect(() => {
    onErrorChange?.(
      !!(error ?? scopeError ?? (flow?.value.status === "waiting" ? linkError : null)),
    );
  }, [error, scopeError, linkError, flow?.value.status, onErrorChange]);

  const refresh = () => {
    query.refresh();
    void refreshProviders({
      environmentId,
      input: { instanceId: scope.instanceId, refreshModels: true },
    });
  };
  const retryAccounts = async () => {
    if (!active.current || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      // A startup failure leaves no instance for authStatus to query. Targeted
      // refresh reconciles saved settings before account discovery can succeed.
      const result = await refreshProviders({
        environmentId,
        input: { instanceId: scope.instanceId, refreshModels: true },
      });
      if (!active.current || isAtomCommandInterrupted(result)) return;
      if (result._tag === "Failure") throw new Error("account recovery failed");
      query.refresh();
    } catch {
      if (active.current)
        setError(
          "Could not reconnect provider accounts. Check this device's connection and try again.",
        );
    } finally {
      busy.current = false;
      if (active.current) setPending(false);
    }
  };
  const resetForm = () => {
    setMethod(null);
    setEditing(null);
    setEditingScope(scope);
    setFields({});
    setSecret("");
    setCallback("");
    setFlow(null);
    setError(null);
    setCopied(false);
    setCopiedLink(false);
    setLinkError(null);
    setPollingPaused(false);
  };
  const execute = async (
    input: Omit<MeerkatAuthActionInput, keyof MeerkatAuthScope>,
    requestScope: MeerkatAuthScope = scope,
  ): Promise<MeerkatAuthFlow> => {
    const result = await command({ environmentId, input: { ...requestScope, ...input } });
    // Native diagnostics can include callback or credential input. Never echo them in this surface.
    if (result._tag === "Failure") throw new Error("account request failed");
    return result.value;
  };
  const receive = (
    value: MeerkatAuthFlow,
    connection: MeerkatAuthConnection,
    device: boolean,
    requestScope: MeerkatAuthScope = scope,
  ) => {
    setFlow({ value, connection: value.connection ?? connection, device, scope: requestScope });
    setPollingPaused(false);
    if (value.status === "failed") {
      setCallback("");
      setLinkError(null);
      setError("This sign-in has ended. Start again to continue.");
    } else if (value.status !== "waiting") {
      setCallback("");
      refresh();
      if (value.status === "connected") {
        setNotice(
          value.defaultActivation?.status === "needs_selection"
            ? "Account connected. Choose which account to use in Models below."
            : "Account connected. Updating its models...",
        );
        setOpen(false);
      }
    }
  };
  const act = async (
    connection: MeerkatAuthConnection,
    action: MeerkatAuthActionInput["action"],
  ) => {
    if (!active.current || busy.current || !current.current.allowed) return;
    if (
      action === "delete" &&
      (connection.editable !== true || connection.supportsRemoval !== true)
    )
      return;
    const currentFlow = current.current.flow;
    const usesFlow = ["status", "complete", "cancel", "devicePoll"].includes(action);
    if (
      usesFlow &&
      (!currentFlow?.value.flowId || accountKey(currentFlow.connection) !== accountKey(connection))
    )
      return;
    if (action === "complete" && !callback.trim()) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const value = await execute(
        {
          ...accountIdentity(connection),
          action,
          ...(usesFlow ? { flowId: currentFlow!.value.flowId! } : {}),
          ...(action === "complete" ? { callbackUrl: callback.trim() } : {}),
        },
        usesFlow ? currentFlow!.scope : scope,
      );
      if (!active.current) return;
      if (action === "check") {
        if (value.status === "failed") throw new Error("account check failed");
        setNotice(
          value.connection?.state === "connected"
            ? "Account connected. Updating its models..."
            : value.connection?.state === "unknown"
              ? "Saved credentials could not be verified. Complete any system prompt, then check the account again."
              : "No usable credentials were found. Sign in or update this account's credentials.",
        );
        refresh();
      } else if (["logout", "delete", "default"].includes(action)) {
        if (value.status === "failed") throw new Error("account operation failed");
        setNotice(
          action === "default"
            ? "Default account updated."
            : action === "delete"
              ? "Account removed. Saved conversations are kept."
              : "Signed out. Your account and saved conversations are kept.",
        );
        setRemoving(null);
        refresh();
      } else {
        receive(
          value,
          connection,
          usesFlow ? currentFlow!.device : action === "deviceStart",
          usesFlow ? currentFlow!.scope : scope,
        );
        if (action === "cancel" && value.status === "cancelled") {
          setOpen(false);
          resetForm();
        }
      }
    } catch {
      if (active.current) {
        // Credential revocation may succeed even if removing configuration fails.
        // Reconcile the visible account without claiming the deletion completed.
        if (action === "delete") refresh();
        setError(
          action === "delete"
            ? "Could not remove this account. Try again."
            : action === "check"
              ? "Could not verify this account. Complete any system prompt, then check the account again."
              : "The account request did not complete. Check the connection and try again.",
        );
        if (action === "status" || action === "devicePoll") setPollingPaused(true);
      }
    } finally {
      busy.current = false;
      if (active.current) setPending(false);
    }
  };
  const configure = async () => {
    if (
      !active.current ||
      !method ||
      !accountFormReady(method, fields, secret) ||
      !current.current.allowed ||
      busy.current
    )
      return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const accountScope: MeerkatAuthScope = editing
        ? editingScope
        : { instanceId: scope.instanceId };
      const configured =
        editing && (method.flow === "browser" || method.flow === "device")
          ? { connection: editing, status: "disconnected" }
          : await execute(
              {
                action: "configure",
                provider: method.provider,
                methodId: method.id,
                ...(editing ? accountIdentity(editing) : {}),
                fields,
                ...(method.flow === "secret" ? { secret } : {}),
              },
              accountScope,
            );
      if (!active.current) return;
      setSecret("");
      if (!configured.connection || configured.status === "failed")
        throw new Error("account configuration failed");
      setEditing(configured.connection);
      setEditingScope(accountScope);
      query.refresh();
      if (method.flow === "browser" || method.flow === "device") {
        if (!current.current.allowed) return;
        const value = await execute(
          {
            ...accountIdentity(configured.connection),
            action: method.flow === "device" ? "deviceStart" : "start",
          },
          accountScope,
        );
        if (active.current)
          receive(value, configured.connection, method.flow === "device", accountScope);
      } else {
        const needsSelection =
          "defaultActivation" in configured &&
          configured.defaultActivation?.status === "needs_selection";
        const savedButUnverified =
          "credentialsSaved" in configured &&
          configured.credentialsSaved === true &&
          configured.connection.state === "unknown";
        setNotice(
          method.flow === "secret"
            ? savedButUnverified
              ? `${method.secretLabel ?? "API key"} saved. Refresh account status to check the connection.`
              : needsSelection
                ? `${method.secretLabel ?? "API key"} saved. Choose which account to use in Models below.`
                : `${method.secretLabel ?? "API key"} saved. Its provider will verify access when you use a model.`
            : "Account configuration saved.",
        );
        setOpen(false);
        resetForm();
        refresh();
      }
    } catch {
      if (active.current)
        setError("Could not connect this account. Check the details and try again.");
    } finally {
      busy.current = false;
      if (active.current) {
        setPending(false);
        setSecret("");
      }
    }
  };
  const poll = useEffectEvent(() => {
    const next = current.current.flow;
    if (next?.value.status !== "waiting") return;
    // The server decides expiry, including whether a credential commit is still in progress.
    void act(next.connection, next.device ? "devicePoll" : "status");
  });
  useEffect(() => {
    if (
      !flow?.value.flowId ||
      flow.value.status !== "waiting" ||
      !allowed ||
      pending ||
      pollingPaused
    )
      return;
    const timer = window.setTimeout(poll, Math.max(2, flow.value.intervalSeconds ?? 2) * 1000);
    return () => window.clearTimeout(timer);
  }, [flow, allowed, pending, pollingPaused]);
  const closeDialog = () => {
    if (busy.current) return;
    if (flow?.value.status === "waiting" && allowed) {
      void act(flow.connection, "cancel");
      return;
    }
    setOpen(false);
    resetForm();
  };
  const reconnect = (connection: MeerkatAuthConnection) => {
    resetForm();
    setNotice(null);
    setOpen(true);
    setEditing(connection);
    setEditingScope(scope);
    const selected = accountMethod(connection, methods);
    setMethod(selected ?? null);
    setFields({ ...connection.fields });
    if (connection.supportsInteractiveLogin)
      void act(connection, connection.loginFlow === "device" ? "deviceStart" : "start");
  };
  const authorizationUrl = signInUrl(
    flow?.value.verificationUriComplete ?? flow?.value.verificationUri ?? flow?.value.authorizeUrl,
  );
  const isCurrentSignIn = () =>
    active.current &&
    current.current.allowed &&
    !!flow?.value.flowId &&
    current.current.flow?.value.flowId === flow.value.flowId &&
    current.current.flow.value.status === "waiting";
  const openSignInPage = async () => {
    if (!authorizationUrl || !isCurrentSignIn()) return;
    try {
      await ensureLocalApi().shell.openExternal(authorizationUrl);
      if (isCurrentSignIn()) setLinkError(null);
    } catch {
      if (isCurrentSignIn())
        setLinkError("Could not open the sign-in page. Copy the link and open it in your browser.");
    }
  };
  const copySignInLink = async () => {
    if (!authorizationUrl || !isCurrentSignIn()) return;
    try {
      await writeTextToClipboard(authorizationUrl, "sign-in link");
      if (isCurrentSignIn()) {
        setCopiedLink(true);
        setLinkError(null);
      }
    } catch {
      if (isCurrentSignIn())
        setLinkError("Could not copy the sign-in link. Try opening the sign-in page again.");
    }
  };

  return (
    <div className={compact ? "space-y-5" : "mx-auto w-full max-w-3xl space-y-7"}>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Accounts</h2>
          <p className="max-w-xl text-sm text-muted-foreground">
            Accounts are saved on {environmentLabel ?? "this device"}. Connect one to use its
            models.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!allowed || pending || flow?.value.status === "waiting" || methods.length === 0}
          onClick={() => {
            resetForm();
            setNotice(null);
            setOpen(true);
          }}
        >
          <PlusIcon />
          Add account
        </Button>
      </div>
      {readOnly && (
        <p className="text-sm text-muted-foreground">
          You can view these accounts. This device requires edit access to change them.
        </p>
      )}
      {scope.threadTarget && query.data?.workspace && matches && (
        <p className="break-all text-xs text-muted-foreground">
          Accounts for this conversation's checkout: {query.data.workspace.cwd}
        </p>
      )}
      {(scopeError || (!open && !removing && error)) && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/25 px-4 py-3 text-sm"
        >
          <span>{(!open && !removing && error) || scopeError}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void retryAccounts()}
          >
            {pending ? "Trying again..." : "Try again"}
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckIcon className="size-4 shrink-0" />
          {notice}
        </p>
      )}
      {query.isPending && !query.data ? (
        <div
          className="rounded-xl border p-8 text-center text-sm text-muted-foreground"
          role="status"
        >
          Checking accounts...
        </div>
      ) : null}
      {!scopeError && matches && connections.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-9 text-center">
          <KeyRoundIcon className="size-6 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Your models start here</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Sign in with an existing account or add an API key. Recommended and supported models
              will appear below.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={!allowed || pending || methods.length === 0}
            onClick={() => {
              resetForm();
              setOpen(true);
            }}
          >
            Connect your first account
          </Button>
        </div>
      )}
      {connections.length > 0 && (
        <div className="divide-y overflow-hidden rounded-xl border">
          {accounts.map((account) => {
            const { connection } = account;
            const nativeMethod = accountMethod(connection, methods);
            const connected = connection.state === "connected";
            const editable = connection.editable === true;
            const defaults = account.connections.filter((route) => route.isDefault);
            return (
              <div key={account.key} className="space-y-3 px-4 py-4">
                <div className="flex items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/30">
                    <KeyRoundIcon className="size-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="text-sm font-medium">
                        {nativeMethod?.displayName ?? connection.displayName}
                      </p>
                      {defaults.length > 0 && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-3xs text-muted-foreground">
                          {defaults.length === account.connections.length
                            ? "Default"
                            : `Default for ${defaults.map(accountRouteLabel).join(", ")}`}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 break-all text-xs text-muted-foreground">
                      {connection.accountLabel ||
                        connection.accountId ||
                        (nativeMethod?.flow === "secret"
                          ? (nativeMethod.secretLabel ?? "API key")
                          : nativeMethod?.flow === "device"
                            ? "Device sign-in"
                            : connection.supportsInteractiveLogin
                              ? "Browser sign-in"
                              : "Configured on this device")}
                    </p>
                  </div>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span
                      className={`size-1.5 rounded-full ${connected ? "bg-success" : "bg-warning"}`}
                    />
                    {accountStatus(connection)}
                  </span>
                  {editable && (
                    <AccountActions
                      connection={connection}
                      connections={account.connections}
                      method={nativeMethod}
                      disabled={!allowed || pending || flow?.value.status === "waiting"}
                      onConnect={() => reconnect(connection)}
                      onCheck={() => void act(connection, "check")}
                      onDefault={(route) => void act(route, "default")}
                      onRemove={() => {
                        setError(null);
                        setNotice(null);
                        setRemoving(account);
                      }}
                    />
                  )}
                </div>
                {!editable && (
                  <p className="pl-12 text-xs text-muted-foreground">Managed on this device</p>
                )}
              </div>
            );
          })}
        </div>
      )}
      {matches && !scopeError && (
        <div className="space-y-3 border-t pt-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Models</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Model menus use your default account for each provider.
              </p>
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh accounts and models"
              disabled={pending}
              onClick={refresh}
            >
              <RefreshCwIcon />
            </Button>
          </div>
          {authenticated.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              Connect an account to see its models.
            </p>
          ) : (
            authenticated.map((account) => (
              <AccountModels
                key={account.key}
                account={account}
                label={
                  accountMethod(account.connection, methods)?.displayName ??
                  account.connection.displayName
                }
                disabled={!allowed || pending || flow?.value.status === "waiting"}
                onDefault={(route) => void act(route, "default")}
              />
            ))
          )}
        </div>
      )}

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) closeDialog();
        }}
      >
        <DialogPopup showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>
              {flow
                ? `Connect ${method?.displayName ?? flow.connection.displayName}`
                : method
                  ? method.displayName
                  : "Add account"}
            </DialogTitle>
            <DialogDescription>
              {flow
                ? flow.device
                  ? "Enter this code in your browser to finish signing in."
                  : "Finish signing in with your provider. This window will update automatically."
                : method
                  ? method.flow === "secret"
                    ? `Enter your ${method.secretLabel === "Bearer token" ? "bearer token" : (method.secretLabel ?? "API key")} to connect this provider.`
                    : method.description
                  : "Choose how you want to connect. You can add more accounts later."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {error && (
              <p
                role="alert"
                className="mb-4 rounded-lg border border-destructive/25 p-3 text-sm text-destructive"
              >
                {error}
              </p>
            )}
            {!method && !flow && (
              <div className="divide-y rounded-xl border">
                {methods.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      setMethod(option);
                      setError(null);
                    }}
                  >
                    <KeyRoundIcon className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{option.displayName}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {option.flow === "secret"
                          ? option.displayName.endsWith("API key")
                            ? "Connect with a key"
                            : (option.secretLabel ?? "API key")
                          : option.flow === "device"
                            ? "Sign in with a device code"
                            : option.flow === "browser"
                              ? "Sign in with your account"
                              : "Use credentials on this device"}
                      </p>
                    </div>
                    <ChevronRightIcon className="size-4 text-muted-foreground" />
                  </button>
                ))}
              </div>
            )}
            {method && !flow && (
              <form
                id="provider-account-connect"
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void configure();
                }}
              >
                {method.flow === "secret" && (
                  <label className="block space-y-2 text-sm font-medium">
                    <span>{method.secretLabel ?? "API key"}</span>
                    <Input
                      autoFocus
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={secret}
                      onChange={(event) => setSecret(event.target.value)}
                      disabled={pending}
                      placeholder={`Paste your ${method.secretLabel === "Bearer token" ? "bearer token" : (method.secretLabel ?? "API key")}`}
                      required
                    />
                  </label>
                )}
                {method.fields
                  .filter((field) => !editing || field.key !== "name")
                  .map((field) => (
                    <label key={field.key} className="block space-y-2 text-sm font-medium">
                      <span>
                        {field.label}
                        {!field.required && (
                          <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
                        )}
                      </span>
                      <Input
                        type={field.secret ? "password" : "text"}
                        autoComplete="off"
                        spellCheck={false}
                        value={fields[field.key] ?? ""}
                        onChange={(event) =>
                          setFields((previous) => ({
                            ...previous,
                            [field.key]: event.target.value,
                          }))
                        }
                        disabled={
                          pending || (!!editing && !!editingScope.projectId && !field.secret)
                        }
                        required={field.required}
                      />
                    </label>
                  ))}
                {editing &&
                  editingScope.projectId &&
                  method.fields.some((field) => field.key !== "name") && (
                    <p className="text-xs text-muted-foreground">
                      To change this account's endpoint or deployment, select All projects in
                      Providers.
                    </p>
                  )}
                <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                  <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" />
                  {method.flow === "secret"
                    ? "Saved on this device. Provider access is checked when you use a model."
                    : "Saved on this device for your projects. Your provider handles sign-in in the browser."}
                </p>
              </form>
            )}
            {flow && (
              <div className="space-y-4">
                {flow.value.userCode && (
                  <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/30 p-4">
                    <code className="text-xl font-semibold tracking-widest">
                      {flow.value.userCode}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={copied ? "Code copied" : "Copy sign-in code"}
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(flow.value.userCode!)
                          .then(() => setCopied(true))
                          .catch(() =>
                            setError("Could not copy the code. Select and copy it above."),
                          );
                      }}
                    >
                      {copied ? <CheckIcon /> : <CopyIcon />}
                    </Button>
                  </div>
                )}
                {authorizationUrl && flow.value.status === "waiting" && (
                  <div className="space-y-3">
                    {linkError && (
                      <p role="alert" className="text-sm text-destructive">
                        {linkError}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="default" disabled={!allowed} onClick={openSignInPage}>
                        Open sign-in page
                        <ArrowUpRightIcon />
                      </Button>
                      <Button variant="outline" disabled={!allowed} onClick={copySignInLink}>
                        {copiedLink ? <CheckIcon /> : <CopyIcon />}
                        {copiedLink ? "Link copied" : "Copy sign-in link"}
                      </Button>
                    </div>
                  </div>
                )}
                <p className="text-sm text-muted-foreground" role="status">
                  {pending
                    ? "Checking sign-in..."
                    : flow.value.status === "waiting"
                      ? "Waiting for sign-in"
                      : flow.value.status === "connected"
                        ? "Account connected"
                        : "Sign-in has ended"}
                </p>
                {flow.value.expiresAt && flow.value.status === "waiting" && (
                  <p className="text-xs text-muted-foreground">
                    {flow.device ? "Code expires at" : "Sign-in expires at"}{" "}
                    {new Date(flow.value.expiresAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    .
                  </p>
                )}
                {!flow.device && flow.value.status === "waiting" && (
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer py-2">Browser did not return here?</summary>
                    <div className="space-y-3 pt-2">
                      <p>Paste the callback URL shown after signing in.</p>
                      <label className="block">
                        <span className="sr-only">Sign-in callback URL</span>
                        <Input
                          type="password"
                          autoComplete="off"
                          value={callback}
                          onChange={(event) => setCallback(event.target.value)}
                          placeholder="Callback URL"
                        />
                      </label>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending || !callback.trim() || !allowed}
                        onClick={() => void act(flow.connection, "complete")}
                      >
                        Complete sign-in
                      </Button>
                    </div>
                  </details>
                )}
                {pollingPaused && flow.value.status === "waiting" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending || !allowed}
                    onClick={() => {
                      setPollingPaused(false);
                      void act(flow.connection, flow.device ? "devicePoll" : "status");
                    }}
                  >
                    Check again
                  </Button>
                )}
              </div>
            )}
          </DialogPanel>
          <DialogFooter>
            {method && !flow && !editing && (
              <div className="sm:mr-auto">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    setMethod(null);
                    setSecret("");
                    setFields({});
                    setError(null);
                  }}
                >
                  <ArrowLeftIcon />
                  Back
                </Button>
              </div>
            )}
            <Button variant="ghost" disabled={pending} onClick={closeDialog}>
              {flow?.value.status === "waiting" && allowed
                ? "Cancel sign-in"
                : flow
                  ? "Close"
                  : "Cancel"}
            </Button>
            {flow?.value.status === "failed" && (
              <Button disabled={pending || !allowed} onClick={() => reconnect(flow.connection)}>
                Start again
              </Button>
            )}
            {method && !flow && (
              <Button
                type="submit"
                form="provider-account-connect"
                disabled={pending || !allowed || !accountFormReady(method, fields, secret)}
              >
                {pending
                  ? "Connecting..."
                  : method.flow === "secret"
                    ? `Save ${method.secretLabel ?? "API key"}`
                    : "Continue"}
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={!!removing}
        onOpenChange={(next) => {
          if (!next && !pending) {
            setRemoving(null);
            setError(null);
          }
        }}
      >
        <DialogPopup showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>Remove account?</DialogTitle>
            <DialogDescription>
              This removes {removing?.connection.accountLabel || removing?.connection.displayName}'s
              saved account configuration and credentials from this device.
              {removing && removing.connections.length > 1
                ? " This includes all models connected through this account."
                : ""}{" "}
              Saved agents and conversations stay available. You can add the account again later.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <DialogPanel>
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            </DialogPanel>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setRemoving(null);
                setError(null);
              }}
            >
              Keep account
            </Button>
            <Button
              variant="destructive"
              disabled={pending || !allowed}
              onClick={() => {
                if (removing) void act(removing.connection, "delete");
              }}
            >
              {pending ? "Removing..." : "Remove account"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function AccountModels({
  account,
  label,
  disabled,
  onDefault,
}: {
  account: ProviderAccountGroup;
  label: string;
  disabled: boolean;
  onDefault: (connection: MeerkatAuthConnection) => void;
}) {
  const { connection } = account;
  const connected = account.connections.filter((route) => route.state === "connected");
  const availableDefaults = connected.filter(
    (route) => route.editable === true && route.supportsDefault === true && !route.isDefault,
  );
  const models = [
    ...new Map(
      connected.flatMap((route) => (route.models ?? []).map((model) => [model.id, model] as const)),
    ).values(),
  ];
  const modelsVerified = connected.every((route) => route.modelsVerified);
  const labelCounts = new Map<string, number>();
  for (const model of models) {
    const label = model.displayName || model.id;
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  const modelLabel = (model: (typeof models)[number]) => {
    const label = model.displayName || model.id;
    return (labelCounts.get(label) ?? 0) > 1 ? `${label} (${model.id})` : label;
  };
  const recommended = models.filter((model) => model.recommended);
  const supported = models.filter((model) => !model.recommended);
  return (
    <div className="rounded-xl border px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{label}</h3>
        {(connection.accountLabel || connection.accountId) && (
          <span className="max-w-52 truncate text-xs text-muted-foreground">
            {connection.accountLabel || connection.accountId}
          </span>
        )}
      </div>
      {availableDefaults.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {availableDefaults.map((route) => (
            <Button
              key={accountKey(route)}
              variant="outline"
              size="xs"
              disabled={disabled}
              onClick={() => onDefault(route)}
            >
              {account.connections.length > 1
                ? `Use for ${accountRouteLabel(route)}`
                : "Use this account"}
            </Button>
          ))}
        </div>
      )}
      {models.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          This account's model list is not available yet.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {recommended.length > 0 && (
            <div>
              <p className="mb-2 text-xs text-muted-foreground">Recommended</p>
              <div className="flex flex-wrap gap-2">
                {recommended.map((model) => (
                  <span key={model.id} className="rounded-md bg-muted px-2 py-1 text-xs">
                    {modelLabel(model)}
                  </span>
                ))}
              </div>
            </div>
          )}
          {supported.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer py-1 text-muted-foreground">
                {supported.length}{" "}
                {recommended.length > 0 ? "more supported models" : "supported models"}
              </summary>
              <div className="mt-2 flex flex-wrap gap-2">
                {supported.map((model) => (
                  <span key={model.id} className="rounded-md border px-2 py-1">
                    {modelLabel(model)}
                  </span>
                ))}
              </div>
            </details>
          )}
          {!modelsVerified && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Supported by this connection. Availability depends on your account and is checked when
              used.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function AccountActions({
  connection,
  connections,
  method,
  disabled,
  onConnect,
  onCheck,
  onDefault,
  onRemove,
}: {
  connection: MeerkatAuthConnection;
  connections: MeerkatAuthConnection[];
  method: MeerkatAuthMethod | undefined;
  disabled: boolean;
  onConnect: () => void;
  onCheck: () => void;
  onDefault: (connection: MeerkatAuthConnection) => void;
  onRemove: () => void;
}) {
  const connected = connection.state === "connected";
  const unchecked = connection.state === "unknown";
  const canCheck =
    unchecked ||
    (connection.authMethod === "github_copilot_oauth" &&
      connections.some((route) => route.state === "connected" && route.modelsVerified !== true));
  const canConnect =
    connection.editable === true &&
    (connection.supportsInteractiveLogin || connection.supportsSecretUpdate === true);
  const canRemove = connections.every(
    (route) => route.editable === true && route.supportsRemoval === true,
  );
  return (
    <div className="flex shrink-0 items-center gap-1">
      {canCheck && (
        <Button size="xs" variant="outline" disabled={disabled} onClick={onCheck}>
          Check account
        </Button>
      )}
      {!connected && !unchecked && canConnect && (
        <Button size="xs" variant="outline" disabled={disabled} onClick={onConnect}>
          {method?.flow === "secret" ? "Connect" : "Sign in"}
        </Button>
      )}
      {(canConnect || connected || connection.state === "reauth_required" || canRemove) && (
        <Menu>
          <MenuTrigger
            disabled={disabled}
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Actions for ${connection.accountLabel || connection.accountId || method?.displayName || connection.displayName}`}
              />
            }
          >
            <MoreHorizontalIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            {canConnect && (
              <MenuItem onClick={onConnect}>
                {method?.flow === "secret"
                  ? `Update ${method.secretLabel ?? "API key"}`
                  : "Sign in again"}
              </MenuItem>
            )}
            {connections
              .filter(
                (route) =>
                  route.state === "connected" &&
                  route.editable === true &&
                  route.supportsDefault === true &&
                  !route.isDefault,
              )
              .map((route) => (
                <MenuItem key={accountKey(route)} onClick={() => onDefault(route)}>
                  {connections.length > 1
                    ? `Use by default for ${accountRouteLabel(route)}`
                    : "Use by default"}
                </MenuItem>
              ))}
            {canRemove && (
              <MenuItem variant="destructive" onClick={onRemove}>
                Remove account
              </MenuItem>
            )}
          </MenuPopup>
        </Menu>
      )}
    </div>
  );
}

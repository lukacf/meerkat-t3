import type {
  SharedCheckout,
  SharedDelegationAction,
  SharedLocalConnection,
  SharedLocalDelegation,
  SharedWorkspaceSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { ChevronDownIcon, KeyRoundIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { useNowMinute } from "../../hooks/useNowMinute";
import { readRestoreReviewWorkBlock, useRestoreReviewWorkBlock } from "./useRestoreReview";
import { useThreadShellsForProjectRefs } from "../../state/entities";
import { useEnvironment, type EnvironmentPresentation } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { environmentSession } from "../../state/session";
import { sharedWorkspaceEnvironment as shared } from "../../state/sharedWorkspace";
import { isSharedSpecialistHostTarget } from "../../connection/desktopLocal";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SharedSnapshotPanel } from "./SharedSnapshotPanel";
import { useSharedSnapshot } from "./useSharedSnapshot";
import {
  clearCanceledTaskSetup,
  clearRemovedTaskAccount,
  assertTaskAccessSession,
  enableTaskAccess,
  readTaskAccess,
  saveTaskAccess,
  startNewTaskAccessRequest,
  taskAccessAttemptExpired,
  taskAccessExpiry,
  taskAccessKey,
  taskAccessStatus,
  type TaskAccessScope,
  type TaskAccessSetup,
} from "./sharedTaskAccessState";

const ACTION_GROUPS: ReadonlyArray<{
  label: string;
  actions: ReadonlyArray<SharedDelegationAction>;
  default: boolean;
}> = [
  {
    label: "Find specialists and read shared knowledge",
    actions: [
      "projects.list",
      "projects.get",
      "specialists.list",
      "specialists.get",
      "knowledge.search",
    ],
    default: true,
  },
  {
    label: "Ask specialists and read their replies",
    actions: ["specialists.send", "specialists.request"],
    default: true,
  },
  {
    label: "Read and acknowledge task updates",
    actions: ["inbox.list", "inbox.ack"],
    default: true,
  },
  {
    label: "Publish this task's objective and observations",
    actions: ["activity.publish"],
    default: false,
  },
  {
    label: "Record and supersede shared knowledge",
    actions: ["knowledge.record", "knowledge.supersede"],
    default: false,
  },
];
const DEFAULT_ACTIONS = ACTION_GROUPS.filter((group) => group.default).flatMap(
  (group) => group.actions,
);
const commandOptions = { reportFailure: false, reportDefect: false };

type Props = {
  host: EnvironmentPresentation;
  checkout: SharedCheckout;
  snapshot: SharedWorkspaceSnapshot;
  connected: boolean;
  canContribute: boolean;
  initialThreadId?: ThreadId | undefined;
};

/** Personal task access belongs beside the attached project, never in host administration. */
export function SharedTaskAccess(props: Props) {
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  const local = useEnvironment(props.checkout.localEnvironmentId);
  const target = props.host.entry.target;
  if (
    !local ||
    target._tag !== "BearerConnectionTarget" ||
    !isSharedSpecialistHostTarget(target) ||
    !props.snapshot.workspace ||
    !props.snapshot.participant
  )
    return null;
  const localTarget = local.entry.target;
  if (isSharedSpecialistHostTarget(localTarget)) return null;
  const scope: TaskAccessScope = {
    localEnvironmentId: props.checkout.localEnvironmentId,
    localProjectId: props.checkout.localProjectId,
    localConnectionKey: "connectionId" in localTarget ? localTarget.connectionId : localTarget._tag,
    hostEnvironmentId: props.host.environmentId,
    hostConnectionKey: target.connectionId,
    workspaceId: props.snapshot.workspace.workspaceId,
    participantId: props.snapshot.participant.participantId,
    checkoutId: props.checkout.checkoutId,
    sharedProjectId: props.checkout.sharedProjectId,
  };
  return (
    <div className="border-t border-border pt-3">
      <Collapsible
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setVisited(true);
        }}
      >
        <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-sm text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <KeyRoundIcon className="size-3.5 shrink-0" /> Allow a task to collaborate
          <ChevronDownIcon
            className={`ml-auto size-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </CollapsibleTrigger>
        <CollapsiblePanel keepMounted>
          {visited ? (
            <TaskAccessPanel key={taskAccessKey(scope)} {...props} scope={scope} local={local} />
          ) : null}
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

function TaskAccessPanel({
  host,
  checkout,
  snapshot,
  connected,
  canContribute,
  scope,
  local,
  initialThreadId,
}: Props & { scope: TaskAccessScope; local: EnvironmentPresentation }) {
  const id = useId();
  const tasks = useThreadShellsForProjectRefs([
    { environmentId: checkout.localEnvironmentId, projectId: checkout.localProjectId },
  ]).filter((task) => !task.archivedAt && task.session !== null);
  const initialTaskTitle = tasks.find((task) => task.id === initialThreadId)?.title ?? "";
  const [loaded] = useState(() => {
    try {
      return { setup: readTaskAccess(scope), error: null };
    } catch {
      return {
        setup: null,
        error:
          "The saved access request could not be read. Its data has been kept; restore local storage before continuing.",
      };
    }
  });
  const [setup, setSetup] = useState<TaskAccessSetup | null>(loaded.setup);
  const [taskId, setTaskId] = useState(loaded.setup?.attempt?.threadId ?? initialThreadId ?? "");
  const [objective, setObjective] = useState(
    loaded.setup?.attempt?.context.objective ?? initialTaskTitle,
  );
  const [actions, setActions] = useState<ReadonlyArray<SharedDelegationAction>>(
    loaded.setup?.attempt?.actions ?? DEFAULT_ACTIONS,
  );
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(loaded.error);
  const [notice, setNotice] = useState<string | null>(null);
  const clock = Date.parse(`${useNowMinute()}Z`);
  const restoreBlock = useRestoreReviewWorkBlock(scope.localEnvironmentId);
  const localOnline = local.connection.phase === "connected";
  const localConnections = useEnvironmentQuery(
    localOnline
      ? shared.localConnections({ environmentId: scope.localEnvironmentId, input: {} })
      : null,
  );
  const remoteSession = useEnvironmentQuery(
    connected ? shared.delegationSession({ environmentId: host.environmentId, input: {} }) : null,
  );
  const connections =
    localConnections.data?.filter(
      (connection) =>
        connection.environmentId === scope.hostEnvironmentId &&
        connection.workspaceId === scope.workspaceId &&
        connection.participantId === scope.participantId,
    ) ?? [];
  // Removal proof is retained by the backend only after its secret deletion succeeds.
  // Match the create request too, so a lost creation response remains recoverable.
  const removedConnection = connections.find(
    (candidate) =>
      candidate.remoteRevocation &&
      (setup?.connection?.connectionId === candidate.connectionId ||
        setup?.connectionRequestId === candidate.requestId),
  );
  useEffect(() => {
    if (!setup || !removedConnection) return;
    if (clearRemovedTaskAccount(scope, removedConnection)) {
      // oxlint-disable-next-line react/set-state-in-effect -- A retained backend removal receipt reconciles durable browser recovery state after a lost response.
      setSetup(null);
      setTaskId(initialThreadId ?? "");
      setObjective(initialTaskTitle);
      setConsent(false);
      setNotice(
        removedConnection.remoteRevocation === "confirmed"
          ? "The stored account was removed and remote grants were revoked."
          : "The stored account was removed locally. Remote revocation could not be confirmed.",
      );
    } else
      setError(
        "The account was removed, but its saved request could not be cleared. Restore local storage before reconnecting.",
      );
  }, [removedConnection, scope, setup, initialThreadId, initialTaskTitle]);
  const connection = setup?.connection
    ? (connections.find((candidate) => candidate.connectionId === setup.connection!.connectionId) ??
      setup.connection)
    : (connections.find((candidate) => !candidate.revokedAt) ?? null);
  const existing = useEnvironmentQuery(
    localOnline && connection
      ? shared.localDelegations({
          environmentId: scope.localEnvironmentId,
          input: { connectionId: connection.connectionId },
        })
      : null,
  );
  const observeRevision = useAtomCommand(shared.observeCheckoutRevision, commandOptions);
  const observeSession = useAtomCommand(shared.observeDelegationSession, commandOptions);
  const observePrepared = useAtomCommand(
    environmentSession.observePreparedConnection,
    commandOptions,
  );
  const putContext = useAtomCommand(shared.putWorkContext, commandOptions);
  const createConnection = useAtomCommand(shared.createLocalConnection, commandOptions);
  const cancelConnectionSetup = useAtomCommand(shared.cancelLocalConnectionSetup, commandOptions);
  const enable = useAtomCommand(shared.enableLocalDelegation, commandOptions);
  const pending = setup?.attempt ?? null;
  const expiredAttempt = pending && !pending.result && taskAccessAttemptExpired(pending, clock);
  const selectedTask = tasks.find((task) => task.id === taskId);
  const patchSnapshot = useSharedSnapshot({
    hostEnvironmentId: host.environmentId,
    accountKey: JSON.stringify([scope.hostConnectionKey, scope.workspaceId, scope.participantId]),
    checkout,
    threadId: selectedTask?.id,
    maxBytes: snapshot.workspace?.limits.maxSnapshotBytes ?? 0,
  });
  const duplicate = existing.data?.some(
    (row) =>
      row.threadId === taskId &&
      !row.revokedAt &&
      !row.grant?.revokedAt &&
      row.grant !== null &&
      Date.parse(row.grant.expiresAt) > clock,
  );
  const ready =
    connected &&
    localOnline &&
    canContribute &&
    !setup?.cancelRequested &&
    !restoreBlock &&
    !loaded.error &&
    !localConnections.error &&
    localConnections.data !== null &&
    !remoteSession.error &&
    remoteSession.data?.canContribute === true &&
    (!connection || (existing.data !== null && !existing.error));
  const persist = (next: TaskAccessSetup) => {
    if (!saveTaskAccess(next)) return false;
    setSetup(next);
    return true;
  };
  async function submit() {
    if (
      !ready ||
      !consent ||
      busy ||
      patchSnapshot.busy ||
      (!pending && (!selectedTask || !objective.trim() || !actions.length || duplicate))
    )
      return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const currentRestoreBlock = readRestoreReviewWorkBlock(scope.localEnvironmentId);
      if (currentRestoreBlock) throw new Error(currentRestoreBlock);
      const session = await observeSession({ environmentId: host.environmentId, input: {} });
      if (session._tag === "Failure") throw new Error(formatEnvironmentQueryError(session.cause));
      assertTaskAccessSession(scope, session.value);
      let next = setup;
      if (!pending) {
        const task = selectedTask!;
        const observation = await observeRevision({
          environmentId: scope.localEnvironmentId,
          input: { projectId: scope.localProjectId, threadId: task.id },
        });
        if (observation._tag === "Failure")
          throw new Error(formatEnvironmentQueryError(observation.cause));
        const revision = observation.value;
        if (revision.projectId !== scope.localProjectId)
          throw new Error(
            "The local backend returned another project's revision. Nothing has been shared.",
          );
        const sharedRevision = await patchSnapshot.resolveRevision(revision);
        const observed = await observePrepared({ environmentId: host.environmentId, input: {} });
        const prepared = observed._tag === "Success" ? observed.value : null;
        if (
          !prepared ||
          prepared.environmentId !== scope.hostEnvironmentId ||
          prepared.target._tag !== "BearerConnectionTarget" ||
          prepared.target.connectionId !== scope.hostConnectionKey ||
          !isSharedSpecialistHostTarget(prepared.target) ||
          prepared.httpAuthorization?._tag !== "Bearer"
        )
          throw new Error("Reconnect this shared account before enabling task access.");
        const origin = new URL(prepared.httpBaseUrl).origin;
        next = {
          scope,
          connectionRequestId: setup?.connectionRequestId ?? randomUUID(),
          connectionLabel: setup?.connectionLabel ?? snapshot.workspace!.name,
          requestGeneration: setup?.requestGeneration ?? 0,
          origin,
          connection: connection?.revokedAt ? null : connection,
          attempt: {
            requestId: randomUUID(),
            threadId: task.id,
            label: task.title.slice(0, 200) || "Local task",
            context: {
              contextId: randomUUID(),
              checkoutId: checkout.checkoutId,
              source: { kind: "thread", threadId: task.id },
              objective: objective.trim(),
              revision: sharedRevision,
              paths: [],
              tags: [],
            },
            contextVersion: null,
            actions,
            expiresAt: taskAccessExpiry(session.value.expiresAt),
            result: null,
          },
        };
      }
      if (!next?.attempt) return;
      if (Date.parse(next.attempt.expiresAt) > Date.parse(session.value.expiresAt))
        throw new Error(
          "This saved grant outlives the current shared account. Revoke the saved request before choosing a new scope.",
        );
      const result = await enableTaskAccess(next, {
        persist,
        putContext: async (input) => {
          const response = await putContext({ environmentId: host.environmentId, input });
          if (response._tag === "Failure")
            throw new Error(formatEnvironmentQueryError(response.cause));
          return response.value;
        },
        createConnection: async (input) => {
          const observed = await observePrepared({ environmentId: host.environmentId, input: {} });
          const prepared = observed._tag === "Success" ? observed.value : null;
          if (
            !prepared ||
            prepared.environmentId !== host.environmentId ||
            prepared.target._tag !== "BearerConnectionTarget" ||
            prepared.target.connectionId !== scope.hostConnectionKey ||
            !isSharedSpecialistHostTarget(prepared.target) ||
            prepared.httpAuthorization?._tag !== "Bearer" ||
            new URL(prepared.httpBaseUrl).origin !== input.origin
          )
            throw new Error("The paired shared account changed. Its credential was not forwarded.");
          const response = await createConnection({
            environmentId: scope.localEnvironmentId,
            input: { ...input, credential: prepared.httpAuthorization.token },
          });
          // Never format a credential-bearing failure or put the token in durable UI state.
          if (response._tag === "Failure")
            throw new Error(
              "The local backend could not confirm the shared account. Retry this saved request; do not create another connection.",
            );
          return response.value;
        },
        enable: async (input) => {
          const response = await enable({ environmentId: scope.localEnvironmentId, input });
          if (response._tag === "Failure")
            throw new Error(formatEnvironmentQueryError(response.cause));
          return response.value;
        },
      });
      setSetup(result);
      setNotice(
        result.attempt?.result
          ? `${taskAccessStatus(result.attempt.result)}. This describes access, not whether the task has run or read its updates.`
          : "The grant is awaiting confirmation. Retry uses the same request and scope.",
      );
      localConnections.refresh();
      existing.refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Task access could not be confirmed. The saved request is retained.",
      );
    } finally {
      setBusy(false);
    }
  }
  function another() {
    if (!setup || !setup.attempt?.result) return;
    if (!persist({ ...setup, attempt: null })) {
      setError("The completed request could not be saved. Retry when local storage is available.");
      return;
    }
    setTaskId(initialThreadId ?? "");
    setObjective(initialTaskTitle);
    setConsent(false);
    setNotice(null);
  }
  function renewExpiredRequest() {
    if (!setup || busy || loaded.error || setup.cancelRequested) return;
    const next = startNewTaskAccessRequest(setup);
    if (!next) {
      setError(
        "The saved request changed or could not be reset. Reload this page to load its current state; the request has been kept.",
      );
      return;
    }
    setSetup(next);
    if (initialThreadId && taskId !== initialThreadId) {
      setTaskId(initialThreadId);
      setObjective(initialTaskTitle);
    }
    setConsent(false);
    setError(null);
    setNotice(
      "Your stored account and previous access history are kept. A new request will check access again; this does not confirm remote revocation.",
    );
    existing.refresh();
  }
  async function cancelSavedSetup() {
    if (!setup || setup.connection || !localOnline || busy || loaded.error) return;
    const requestId = setup.connectionRequestId;
    if (!persist({ ...setup, cancelRequested: true })) {
      setError("Cancellation could not be saved. Restore local storage, then try again.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await cancelConnectionSetup({
        environmentId: scope.localEnvironmentId,
        input: { requestId },
      });
      if (result._tag === "Failure") {
        setError(
          "Setup cancellation could not be confirmed. Retry cancellation to finish removing any stored credential.",
        );
        return;
      }
      if (!clearCanceledTaskSetup(scope, requestId, result.value)) {
        setError(
          "The saved setup could not be cleared safely. Its request is retained; retry cancellation when local storage is available.",
        );
        return;
      }
      setSetup(null);
      setTaskId(initialThreadId ?? "");
      setObjective(initialTaskTitle);
      setConsent(false);
      setNotice(
        result.value.cleanup?.remoteRevocation === "unconfirmed"
          ? "Setup canceled and its stored credential removed locally. Remote revocation could not be confirmed."
          : "Setup canceled and its stored credential removed.",
      );
    } finally {
      localConnections.refresh();
      existing.refresh();
      setBusy(false);
    }
  }
  const accountName = snapshot.workspace?.name ?? host.label;
  return (
    <div className="min-w-0 space-y-4 pt-3 text-xs">
      <p className="text-muted-foreground">
        Let one of your started tasks consult this workspace's specialists. Choose what it may share
        and do, with access lasting at most one hour.
      </p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="space-y-1.5">
          {initialThreadId ? (
            <div className="min-w-0 space-y-1">
              <p className="text-muted-foreground">Task on {local.label}</p>
              <p className="wrap-anywhere font-medium">
                {selectedTask?.title ?? pending?.label ?? "Task unavailable"}
              </p>
            </div>
          ) : (
            <>
              <Label htmlFor={`${id}-task`}>Task on {local.label}</Label>
              <Select
                value={taskId}
                disabled={busy || Boolean(pending)}
                onValueChange={(value) => {
                  const task = tasks.find((candidate) => candidate.id === value);
                  setTaskId(task?.id ?? "");
                  setObjective(task?.title ?? "");
                  setConsent(false);
                }}
              >
                <SelectTrigger id={`${id}-task`}>
                  <SelectValue placeholder="Choose a started task">
                    {selectedTask?.title ??
                      pending?.label ??
                      (taskId ? "Task unavailable" : undefined)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {tasks.map((task) => (
                    <SelectItem key={task.id} value={task.id}>
                      {task.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </>
          )}
          {!tasks.length ? (
            <p className="text-muted-foreground">
              Start a task in this project first. Task access requires an existing native session.
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-objective`}>Objective shared with the workspace</Label>
          <Textarea
            id={`${id}-objective`}
            value={objective}
            maxLength={4000}
            disabled={busy || Boolean(pending)}
            onChange={(event) => {
              setObjective(event.target.value);
              setConsent(false);
            }}
          />
        </div>
        {selectedTask && !pending ? (
          <SharedSnapshotPanel
            state={patchSnapshot}
            destination={accountName}
            maxBytes={snapshot.workspace?.limits.maxSnapshotBytes ?? 0}
            disabled={busy || !ready}
          />
        ) : null}
        <fieldset className="space-y-2" disabled={busy || Boolean(pending)}>
          <legend className="mb-2 font-medium">Allowed actions</legend>
          {ACTION_GROUPS.map((group, index) => (
            <Label key={group.label} htmlFor={`${id}-action-${index}`}>
              <Checkbox
                id={`${id}-action-${index}`}
                checked={group.actions.every((action) => actions.includes(action))}
                onCheckedChange={(checked) => {
                  setActions((current) =>
                    checked
                      ? [...new Set([...current, ...group.actions])]
                      : current.filter((action) => !group.actions.includes(action)),
                  );
                  setConsent(false);
                }}
              />
              {group.label}
            </Label>
          ))}
        </fieldset>
        {pending ? (
          <div className="space-y-1 rounded-lg bg-muted/40 p-3 text-muted-foreground">
            <p className="break-all">
              Saved revision: {pending.context.revision.branch} at{" "}
              {pending.context.revision.commit.slice(0, 12)}
            </p>
            <p>Expires {new Date(pending.expiresAt).toLocaleString()}</p>
            {expiredAttempt ? (
              <>
                <p>
                  This request's saved expiry has passed. Start a new request to choose its task and
                  scope again using the stored account.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  disabled={busy || Boolean(loaded.error) || Boolean(setup?.cancelRequested)}
                  onClick={renewExpiredRequest}
                >
                  Start a new request
                </Button>
              </>
            ) : (
              <p>
                Changing its task, objective, revision, or actions requires revoking this access and
                enabling a new grant.
              </p>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground">
            The selected task's clean Git branch and commit will be read before enabling access. Its
            conversation and uncommitted files are not uploaded. Access expires within one hour, or
            sooner if your paired account expires.
          </p>
        )}
        {setup?.cancelRequested ? (
          <p role="status" className="text-muted-foreground">
            Setup cancellation is pending. Retry cancellation below to confirm credential removal.
          </p>
        ) : !pending?.result ? (
          <>
            <Label htmlFor={`${id}-consent`}>
              <Checkbox
                id={`${id}-consent`}
                checked={consent}
                disabled={busy}
                onCheckedChange={setConsent}
              />
              <span className="min-w-0 break-words">
                Allow this task to use my {accountName} account. Store the paired account credential
                on {local.label} ({local.displayUrl}) and share the objective, revision, and
                selected actions above.
              </span>
            </Label>
            <Button
              size="sm"
              disabled={
                !ready ||
                !consent ||
                busy ||
                patchSnapshot.busy ||
                Boolean(connection?.revokedAt) ||
                (!pending && (!selectedTask || !objective.trim() || !actions.length || duplicate))
              }
              type="submit"
            >
              {busy
                ? "Confirming access..."
                : pending
                  ? "Retry saved request"
                  : "Enable for this task"}
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" type="button" onClick={another}>
            {initialThreadId ? "Set up new access" : "Choose another task"}
          </Button>
        )}
        {!connected ? (
          <p className="text-muted-foreground">
            Reconnect the shared host to enable or confirm task access.
          </p>
        ) : !canContribute ? (
          <p className="text-muted-foreground">
            A participant connection is required to enable task access.
          </p>
        ) : null}
        {!localOnline ? (
          <p className="text-muted-foreground">
            Reconnect {local.label} to manage its stored access.
          </p>
        ) : null}
        {localConnections.error || remoteSession.error || existing.error ? (
          <p role="alert" className="text-destructive">
            {localConnections.error ?? remoteSession.error ?? existing.error} Update or reconnect
            the environment, then refresh.
          </p>
        ) : null}
        {!pending && duplicate ? (
          <p className="text-muted-foreground">
            This task already has access. Revoke it below before changing its scope.
          </p>
        ) : null}
      </form>
      {setup && !setup.connection ? (
        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-muted-foreground">
            Cancel this saved setup to remove any credential stored by its connection attempt. Your
            existing app connection is kept.
          </p>
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={busy || !localOnline || Boolean(loaded.error)}
            onClick={() => void cancelSavedSetup()}
          >
            {setup.cancelRequested ? "Retry setup cancellation" : "Cancel saved setup"}
          </Button>
        </div>
      ) : null}
      {restoreBlock ? (
        <p role="alert" className="text-destructive">
          {restoreBlock}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {connections.map((item) => (
        <TaskConnectionAccess
          key={item.connectionId}
          connection={item}
          scope={scope}
          online={localOnline}
          now={clock}
          tasks={tasks.map((task) => ({ id: task.id, title: task.title }))}
          threadId={initialThreadId}
          onRemoved={(removedAccount) => {
            if (
              setup &&
              (setup.connection?.connectionId === removedAccount.connectionId ||
                setup.connectionRequestId === removedAccount.requestId)
            ) {
              if (clearRemovedTaskAccount(scope, removedAccount)) {
                setSetup(null);
                setTaskId(initialThreadId ?? "");
                setObjective(initialTaskTitle);
                setConsent(false);
              } else
                setError(
                  "The backend removed this account, but the saved form could not be cleared. Restore local storage before reconnecting.",
                );
            }
            localConnections.refresh();
            existing.refresh();
          }}
          onChange={(result) => {
            if (
              setup?.attempt &&
              result.threadId === setup.attempt.threadId &&
              result.connectionId === setup.connection?.connectionId &&
              result.grant?.context.contextId === setup.attempt.context.contextId &&
              result.grant?.context.contextVersion === setup.attempt.contextVersion &&
              result.revokedAt &&
              result.grant?.revokedAt
            )
              persist({ ...setup, attempt: { ...setup.attempt, result } });
            existing.refresh();
          }}
        />
      ))}
      <Button
        size="xs"
        variant="ghost"
        type="button"
        disabled={busy || !localOnline}
        onClick={() => {
          localConnections.refresh();
          remoteSession.refresh();
          existing.refresh();
        }}
      >
        Refresh access
      </Button>
    </div>
  );
}

function TaskConnectionAccess({
  connection,
  scope,
  online,
  tasks,
  threadId,
  onChange,
  onRemoved,
  now,
}: {
  connection: SharedLocalConnection;
  scope: TaskAccessScope;
  online: boolean;
  tasks: ReadonlyArray<{ id: string; title: string }>;
  threadId?: ThreadId | undefined;
  onChange: (result: SharedLocalDelegation) => void;
  onRemoved: (connection: SharedLocalConnection) => void;
  now: number;
}) {
  const query = useEnvironmentQuery(
    online
      ? shared.localDelegations({
          environmentId: scope.localEnvironmentId,
          input: { connectionId: connection.connectionId },
        })
      : null,
  );
  const revoke = useAtomCommand(shared.revokeLocalDelegation, commandOptions);
  const disconnect = useAtomCommand(shared.disconnectLocalConnection, commandOptions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<"confirmed" | "unconfirmed" | null>(null);
  const removal = removed ?? connection.remoteRevocation ?? null;
  const projectRows = query.data?.filter((row) => {
    if (threadId && row.threadId !== threadId) return false;
    return row.grant
      ? row.grant.binding.environmentId === scope.localEnvironmentId &&
          row.grant.binding.projectId === scope.localProjectId
      : tasks.some((task) => task.id === row.threadId);
  });
  async function change(localId?: string) {
    if (!online || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (localId) {
        const result = await revoke({
          environmentId: scope.localEnvironmentId,
          input: { localId },
        });
        if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
        else onChange(result.value);
      } else {
        const result = await disconnect({
          environmentId: scope.localEnvironmentId,
          input: { connectionId: connection.connectionId },
        });
        if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
        else {
          setRemoved(result.value.remoteRevocation);
          onRemoved(result.value.connection);
        }
      }
    } finally {
      query.refresh();
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 break-words font-medium">{connection.label}</p>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy || !online || removal !== null}
          onClick={() => void change()}
        >
          {removal
            ? "Stored credential removed"
            : connection.revokedAt
              ? "Finish removing account"
              : "Remove stored account"}
        </Button>
      </div>
      <p className="text-muted-foreground">
        Removing this account blocks all of its task grants, including those in other projects, and
        deletes its stored credential locally. Remote revocation is attempted separately. This does
        not stop tasks or sign you out of the app.
      </p>
      {removal ? (
        <p role="status" className="text-muted-foreground">
          {removal === "confirmed"
            ? "Stored account removed. Remote grants are revoked."
            : "Stored account removed locally. Remote revocation could not be confirmed; any outstanding remote grant remains bounded by its original expiry."}
        </p>
      ) : null}
      {projectRows?.map((row) => (
        <div
          key={row.localId}
          className="flex min-w-0 flex-wrap items-start justify-between gap-2 rounded-lg bg-muted/30 p-2"
        >
          <div className="min-w-0 space-y-1">
            <p className="break-words">
              {tasks.find((task) => task.id === row.threadId)?.title ??
                row.grant?.participant.displayName ??
                "Task"}
            </p>
            <p className="text-muted-foreground">{taskAccessStatus(row, now)}</p>
            {row.grant ? (
              <p className="text-muted-foreground">
                {row.grant.context.revision.branch} at{" "}
                {row.grant.context.revision.commit.slice(0, 12)} - expires{" "}
                {new Date(row.grant.expiresAt).toLocaleString()}
              </p>
            ) : null}
          </div>
          <Button
            size="xs"
            variant="outline"
            disabled={
              busy || !online || removal !== null || Boolean(row.revokedAt && row.grant?.revokedAt)
            }
            onClick={() => void change(row.localId)}
          >
            {row.revokedAt ? "Confirm revocation" : "Revoke access"}
          </Button>
        </div>
      ))}
      {query.isPending ? <p className="text-muted-foreground">Loading task access...</p> : null}
      {error || query.error ? (
        <p role="alert" className="text-destructive">
          {error ?? query.error}
        </p>
      ) : null}
    </div>
  );
}

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { MeerkatPeerConnections, MeerkatProjectAgent } from "@t3tools/contracts";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftRightIcon, ChevronDownIcon, LinkIcon, UnlinkIcon } from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { randomUUID } from "../../lib/utils";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { meerkatTeamEnvironment, useVisibleTeamRefresh } from "../../state/meerkatTeam";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { readRestoreReviewWorkBlock } from "./useRestoreReview";
import {
  canConnectPeers,
  latestPeerConnections,
  matchesPeerSearch,
  peerChoicesEmptyMessage,
  peerEndpointKey,
  visiblePeerConnection,
  type PeerEndpoint,
  type PeerItem,
} from "./peerConnections.logic";

export type { PeerItem } from "./peerConnections.logic";

const PEER_MIME = "application/x-meerkat-peer";
interface PeerContextValue {
  dragged: PeerItem | null;
  setDragged: (item: PeerItem | null) => void;
  confirm: (source: PeerItem, target: PeerItem) => void;
  choosePeer: (source: PeerItem) => void;
  revision: number;
}
const PeerContext = createContext<PeerContextValue | null>(null);

export function useMeerkatPeerConnections() {
  return useContext(PeerContext);
}

export function useMeerkatPeerDrag(item: PeerItem | null): {
  dragProps: HTMLAttributes<HTMLElement>;
  isDropTarget: boolean;
} {
  const context = useContext(PeerContext);
  const [over, setOver] = useState(false);
  const source = context?.dragged;
  const canDrop = Boolean(item && source && canConnectPeers(source, item));
  const ours = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes(PEER_MIME);
  if (!item || !context) return { dragProps: {}, isDropTarget: false };
  return {
    isDropTarget: over && canDrop,
    dragProps: {
      draggable: true,
      "data-peer-label": item.label,
      onPointerDownCapture: (event) => {
        // Peer drags must not also activate T3's thread reordering sensor.
        event.stopPropagation();
      },
      onDragStartCapture: (event) => {
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "link";
        event.dataTransfer.setData(PEER_MIME, peerEndpointKey(item.endpoint));
        context.setDragged(item);
      },
      onDragEndCapture: () => {
        setOver(false);
        context.setDragged(null);
      },
      onDragOverCapture: (event) => {
        if (!ours(event)) return;
        event.stopPropagation();
        event.preventDefault();
        event.dataTransfer.dropEffect = canDrop ? "link" : "none";
        setOver(canDrop);
      },
      onDragLeaveCapture: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      },
      onDropCapture: (event) => {
        if (!ours(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        if (source && canDrop) context.confirm(source, item);
        context.setDragged(null);
      },
    } as HTMLAttributes<HTMLElement>,
  };
}

function useOpenPeer() {
  const navigate = useNavigate();
  return (item: PeerItem) => {
    if (item.endpoint.kind === "thread") {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: item.environmentId, threadId: item.endpoint.threadId },
        search: {},
      });
    } else {
      void navigate({
        to: "/$environmentId/agents/$agentId",
        params: { environmentId: item.environmentId, agentId: item.endpoint.agentId },
        search: { project: item.endpoint.projectId },
      });
    }
  };
}

function PeerLabel({
  endpoint,
  source,
  children,
}: {
  endpoint: PeerEndpoint;
  source: PeerItem;
  children: (item: PeerItem, agent: MeerkatProjectAgent | null) => ReactNode;
}) {
  const projects = useProjects();
  const threads = useThreadShells();
  const agents = useEnvironmentQuery(
    endpoint.kind === "project-agent"
      ? meerkatTeamEnvironment.projectAgents({
          environmentId: source.environmentId,
          input: { projectId: endpoint.projectId },
        })
      : null,
  );
  const agent =
    endpoint.kind === "project-agent"
      ? agents.data?.agents.find(
          (item) =>
            item.agentId === endpoint.agentId &&
            item.projectId === endpoint.projectId &&
            item.instanceId === endpoint.instanceId,
        )
      : undefined;
  const label =
    endpoint.kind === "thread"
      ? (threads.find(
          (thread) =>
            thread.environmentId === source.environmentId && thread.id === endpoint.threadId,
        )?.title ?? "Thread")
      : (agent?.label ?? "Project agent");
  return children(
    {
      environmentId: source.environmentId,
      endpoint,
      instanceId: endpoint.instanceId,
      label,
      projectTitle:
        projects.find(
          (project) =>
            project.environmentId === source.environmentId && project.id === endpoint.projectId,
        )?.title ?? "Project",
    },
    agents.isSuccess && !agents.isPending ? (agent ?? null) : null,
  );
}

function AvailablePeers({
  projects,
  threads,
  source,
  search,
  connectedKeys,
  disabled,
  select,
}: {
  projects: ReadonlyArray<EnvironmentProject>;
  threads: ReadonlyArray<PeerItem>;
  source: PeerItem;
  search: string;
  connectedKeys: ReadonlySet<string>;
  disabled: boolean;
  select: (item: PeerItem) => void;
}) {
  const registry = useContext(RegistryContext);
  // Aggregate query state without coupling project failures, so an empty list
  // cannot masquerade as a completed search while rosters are still loading.
  const rosters = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          projects
            .filter((project) => project.environmentId === source.environmentId)
            .map((project) => {
              const result = get(
                meerkatTeamEnvironment.projectAgents({
                  environmentId: project.environmentId,
                  input: { projectId: project.id },
                }),
              );
              return {
                project,
                data: Option.getOrNull(AsyncResult.value(result)),
                pending: result.waiting || result._tag === "Initial",
                failed: result._tag === "Failure",
              };
            }),
        ),
      [projects, source.environmentId],
    ),
  );
  const agents: PeerItem[] = rosters.flatMap(({ project, data, failed }) =>
    failed
      ? []
      : (data?.agents ?? [])
          .filter((agent) => !agent.archived && agent.enabled)
          .map((agent) => ({
            environmentId: project.environmentId,
            endpoint: {
              kind: "project-agent" as const,
              projectId: project.id,
              agentId: agent.agentId,
              instanceId: agent.instanceId,
            },
            instanceId: agent.instanceId,
            label: agent.label,
            projectTitle: project.title,
          })),
  );
  const eligible = [...agents, ...threads].filter((item) => canConnectPeers(source, item));
  const available = eligible.filter((item) => !connectedKeys.has(peerEndpointKey(item.endpoint)));
  const choices = available.filter((item) => matchesPeerSearch(item, search));
  const pending = rosters.some((roster) => roster.pending);
  const failed = rosters.filter((roster) => roster.failed);
  return (
    <>
      {choices.map((item) => (
        <PeerChoice
          key={peerEndpointKey(item.endpoint)}
          item={item}
          disabled={disabled}
          select={select}
        />
      ))}
      {failed.length > 0 ? (
        <div className="flex items-center gap-2">
          <p role="status" className="flex-1 text-xs text-destructive">
            Agents unavailable in {failed.map(({ project }) => project.title).join(", ")}.
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || pending}
            onClick={() => {
              for (const { project } of failed) {
                registry.refresh(
                  meerkatTeamEnvironment.projectAgents({
                    environmentId: project.environmentId,
                    input: { projectId: project.id },
                  }),
                );
              }
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {pending ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading agents...
        </p>
      ) : choices.length === 0 && failed.length === 0 ? (
        <p role="status" className="py-2 text-xs text-muted-foreground">
          {peerChoicesEmptyMessage(search, eligible.length, available.length)}
        </p>
      ) : null}
    </>
  );
}

function PeerChoice({
  item,
  disabled,
  select,
}: {
  item: PeerItem;
  disabled: boolean;
  select: (item: PeerItem) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm-multiline"
      className="w-full justify-start text-left"
      disabled={disabled}
      onClick={() => select(item)}
    >
      <LinkIcon className="shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{item.label}</span>
        <span className="block truncate text-xs font-normal text-muted-foreground">
          {item.projectTitle} / {item.endpoint.kind === "thread" ? "Thread" : "Agent"}
        </span>
      </span>
    </Button>
  );
}

export function MeerkatPeerConnectionsProvider({ children }: { children: ReactNode }) {
  const openPeer = useOpenPeer();
  const [dragged, setDragged] = useState<PeerItem | null>(null);
  const [dialog, setDialog] = useState<{ source: PeerItem; target: PeerItem | null } | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ value: MeerkatPeerConnections; at: number } | null>(
    null,
  );
  const [revision, setRevision] = useState(0);
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const setConnection = useAtomCommand(meerkatTeamEnvironment.peerConnectionSet, {
    reportFailure: false,
  });
  const agentLifecycle = useAtomCommand(meerkatTeamEnvironment.projectAgentLifecycle, {
    reportFailure: false,
  });
  const connections = useEnvironmentQuery(
    dialog
      ? meerkatTeamEnvironment.peerConnections({
          environmentId: dialog.source.environmentId,
          input: { endpoint: dialog.source.endpoint },
        })
      : null,
  );
  useVisibleTeamRefresh(connections, dialog !== null && !busy);
  const open = useCallback((source: PeerItem, target: PeerItem | null) => {
    if (busyRef.current) return;
    setError(null);
    setNotice(null);
    setReceipt(null);
    setSearch("");
    setDialog({ source, target });
  }, []);
  const contextValue = useMemo<PeerContextValue>(
    () => ({
      dragged,
      setDragged,
      confirm: (from, to) => open(from, to),
      choosePeer: (from) => open(from, null),
      revision,
    }),
    [dragged, open, revision],
  );
  const change = async (target: PeerEndpoint, connected: boolean, connectAgent = false) => {
    if (!dialog || busyRef.current) return;
    const restoreBlock =
      connected || connectAgent ? readRestoreReviewWorkBlock(dialog.source.environmentId) : null;
    if (restoreBlock) {
      setError(restoreBlock);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (connectAgent && target.kind === "project-agent") {
        const restored = await agentLifecycle({
          environmentId: dialog.source.environmentId,
          input: { projectId: target.projectId, agentId: target.agentId, action: "connect" },
        });
        connections.refresh();
        if (restored._tag === "Failure") {
          setError(formatEnvironmentQueryError(restored.cause));
          return;
        }
        const agent = restored.value;
        if (
          agent.agentId !== target.agentId ||
          agent.projectId !== target.projectId ||
          agent.instanceId !== target.instanceId ||
          agent.archived ||
          !agent.enabled ||
          agent.connectionStatus !== "connected" ||
          agent.error
        ) {
          setError(agent.error ?? "The agent has not connected. Open it to inspect its status.");
          return;
        }
      }
      const result = await setConnection({
        environmentId: dialog.source.environmentId,
        input: {
          source: dialog.source.endpoint,
          target,
          connected,
          requestId: randomUUID(),
        },
      });
      if (result._tag === "Failure") {
        setError(formatEnvironmentQueryError(result.cause));
      } else {
        setReceipt({ value: result.value, at: Date.now() });
        setRevision((value) => value + 1);
        connections.refresh();
        const changed = result.value.connections.find((edge) =>
          [edge.source, edge.target].some(
            (endpoint) => peerEndpointKey(endpoint) === peerEndpointKey(target),
          ),
        );
        if (connected && !changed) {
          setError("The connection was not confirmed. Refresh the connections and try again.");
        } else if (changed?.status === "error" || changed?.error) {
          setError(
            changed.error ?? "The native connection could not be updated. Retry the action.",
          );
        } else {
          setDialog({ source: dialog.source, target: null });
          setNotice(
            connected
              ? changed?.status === "connected"
                ? "Connected."
                : "Connection saved. It will connect when both agents are available."
              : changed?.status === "connected" || changed?.status === "unloaded"
                ? "Disconnect requested. Cleanup is pending."
                : "Disconnected.",
          );
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the connection.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const source = dialog?.source;
  const currentConnections = latestPeerConnections(
    connections.data,
    connections.dataUpdatedAt,
    receipt,
  );
  const connectedKeys = new Set(
    (currentConnections?.connections ?? [])
      .filter(visiblePeerConnection)
      .flatMap((edge) => [peerEndpointKey(edge.source), peerEndpointKey(edge.target)]),
  );
  const selectTarget = (target: PeerItem) => {
    if (!source || busyRef.current) return;
    setError(null);
    setNotice(null);
    if (target.endpoint.projectId === source.endpoint.projectId) {
      void change(target.endpoint, true);
    } else {
      setDialog({ source, target });
    }
  };
  const providerIds = new Set(
    environments
      .find((environment) => environment.environmentId === source?.environmentId)
      ?.serverConfig?.providers.filter((provider) => provider.driver === "meerkat")
      .map((provider) => provider.instanceId),
  );
  const threadChoices: PeerItem[] = threads
    .filter((thread) => thread.environmentId === source?.environmentId && !thread.archivedAt)
    .flatMap((thread) => {
      const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
      if (!instanceId || !providerIds.has(instanceId)) return [];
      return [
        {
          environmentId: thread.environmentId,
          endpoint: {
            kind: "thread" as const,
            projectId: thread.projectId,
            threadId: thread.id,
            instanceId,
          },
          instanceId,
          label: thread.title,
          projectTitle:
            projects.find(
              (project) =>
                project.environmentId === thread.environmentId && project.id === thread.projectId,
            )?.title ?? "Project",
        },
      ];
    });
  return (
    <PeerContext.Provider value={contextValue}>
      {children}
      <Dialog
        open={dialog !== null}
        onOpenChange={(value) => {
          if (!value && !busyRef.current) setDialog(null);
        }}
      >
        <DialogPopup className="max-w-lg" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>{dialog?.target ? "Connect these agents?" : "Connections"}</DialogTitle>
            <DialogDescription>
              {dialog?.target
                ? "Each keeps its own conversation. The connection allows peer messages when each agent's permissions permit."
                : `Connect ${source?.label ?? "this agent"} to project agents or threads.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
              Read-only agents cannot reply to peers. Create a specialist with Full access for
              two-way collaboration; this also permits file changes and commands.
            </p>
            {dialog?.target ? (
              <div className="flex items-center gap-4 rounded-lg border p-4">
                <div className="min-w-0 flex-1">
                  <p className="break-words font-medium">{dialog.source.label}</p>
                  <p className="text-xs text-muted-foreground">{dialog.source.projectTitle}</p>
                </div>
                <ArrowLeftRightIcon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="break-words font-medium">{dialog.target.label}</p>
                  <p className="text-xs text-muted-foreground">{dialog.target.projectTitle}</p>
                </div>
              </div>
            ) : source ? (
              <>
                <div className="space-y-1" aria-label="Current connections">
                  {(currentConnections?.connections ?? [])
                    .filter(visiblePeerConnection)
                    .map((edge) => {
                      const other =
                        peerEndpointKey(edge.source) === peerEndpointKey(source.endpoint)
                          ? edge.target
                          : edge.source;
                      return (
                        <PeerLabel key={edge.edgeId} source={source} endpoint={other}>
                          {(item, agent) => (
                            <div className="flex items-center gap-2 rounded-md border p-2">
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm">{item.label}</p>
                                <p className="text-xs text-muted-foreground">
                                  {item.projectTitle} /{" "}
                                  {edge.status === "unloaded"
                                    ? edge.desired
                                      ? "Saved - connects when available"
                                      : "Cleanup pending"
                                    : edge.status}
                                </p>
                                {edge.error ? (
                                  <p role="status" className="text-xs text-destructive">
                                    {edge.error}
                                  </p>
                                ) : null}
                              </div>
                              <Button
                                size="xs"
                                variant="ghost-muted"
                                disabled={busy}
                                onClick={() => {
                                  setDialog(null);
                                  openPeer(item);
                                }}
                              >
                                {agent?.archived ? "Open to restore" : "Open"}
                              </Button>
                              {edge.desired &&
                              !agent?.archived &&
                              (edge.status !== "connected" || (agent && !agent.enabled)) ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  aria-label={`${agent && !agent.enabled ? "Connect agent" : "Retry connect"} ${item.label}`}
                                  disabled={busy || (other.kind === "project-agent" && !agent)}
                                  onClick={() =>
                                    void change(other, true, Boolean(agent && !agent.enabled))
                                  }
                                >
                                  {agent && !agent.enabled ? "Connect agent" : "Retry connect"}
                                </Button>
                              ) : null}
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={`${!edge.desired ? "Retry disconnect" : "Disconnect"} ${item.label}`}
                                disabled={busy}
                                onClick={() => void change(other, false)}
                              >
                                <UnlinkIcon />
                              </Button>
                            </div>
                          )}
                        </PeerLabel>
                      );
                    })}
                  {connections.error ? (
                    <div className="flex items-center gap-2">
                      <p role="status" className="flex-1 text-xs text-destructive">
                        {connections.error}
                      </p>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy || connections.isPending}
                        onClick={connections.refresh}
                      >
                        Retry
                      </Button>
                    </div>
                  ) : currentConnections === null ? (
                    <p role="status" className="text-xs text-muted-foreground">
                      Loading connections...
                    </p>
                  ) : null}
                </div>
                <Input
                  aria-label="Find agents or threads"
                  placeholder="Find an agent, thread, or project"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  disabled={busy}
                />
                <div className="space-y-1" aria-label="Available connections">
                  <AvailablePeers
                    projects={projects}
                    threads={threadChoices}
                    source={source}
                    search={search}
                    connectedKeys={connectedKeys}
                    disabled={busy || connections.error !== null || currentConnections === null}
                    select={selectTarget}
                  />
                </div>
              </>
            ) : null}
            {notice ? (
              <p role="status" className="text-xs text-muted-foreground">
                {notice}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setError(null);
                setDialog(dialog?.target ? { source: dialog.source, target: null } : null);
              }}
            >
              {dialog?.target ? "Back" : "Done"}
            </Button>
            {dialog?.target ? (
              <Button disabled={busy} onClick={() => void change(dialog.target!.endpoint, true)}>
                {busy ? "Connecting..." : "Connect agents"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </PeerContext.Provider>
  );
}

export function MeerkatPeerConnectionsBar({
  item,
  disabled = false,
  inline = false,
}: {
  item: PeerItem;
  disabled?: boolean;
  inline?: boolean;
}) {
  const context = useContext(PeerContext);
  const [open, setOpen] = useState(false);
  const query = useEnvironmentQuery(
    meerkatTeamEnvironment.peerConnections({
      environmentId: item.environmentId,
      input: { endpoint: item.endpoint },
    }),
  );
  useVisibleTeamRefresh(query, !disabled);
  const refresh = useEffectEvent(() => query.refresh());
  useEffect(() => {
    if (context?.revision !== undefined) refresh();
  }, [context?.revision]);
  const openPeer = useOpenPeer();
  const desired = query.data?.connections.filter(visiblePeerConnection) ?? [];
  const needsAttention = desired.some((edge) => edge.status === "error");
  return (
    <div
      className={
        inline
          ? "min-w-0 shrink-0"
          : "flex h-9 shrink-0 items-center border-b border-border/60 px-3"
      }
      aria-label="Peer connections"
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button variant="ghost-muted" size="xs" />}>
          <LinkIcon />
          Connections{desired.length > 0 ? ` · ${desired.length}` : ""}
          {needsAttention || query.error ? (
            <span
              className="size-1.5 rounded-full bg-warning"
              aria-label="Connections need attention"
            />
          ) : null}
          <ChevronDownIcon />
        </PopoverTrigger>
        <PopoverPopup width="md" align="start">
          <PopoverTitle>Connections</PopoverTitle>
          <div className="my-3 max-h-72 space-y-1 overflow-y-auto">
            {desired.map((edge) => {
              const other =
                peerEndpointKey(edge.source) === peerEndpointKey(item.endpoint)
                  ? edge.target
                  : edge.source;
              return (
                <PeerLabel key={edge.edgeId} source={item} endpoint={other}>
                  {(peer) => (
                    <button
                      type="button"
                      className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:outline focus-visible:outline-ring"
                      onClick={() => {
                        setOpen(false);
                        openPeer(peer);
                      }}
                    >
                      <span
                        className={`mt-1.5 size-1.5 shrink-0 rounded-full ${edge.status === "connected" ? "bg-success" : edge.status === "error" ? "bg-warning" : "bg-muted-foreground/40"}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block break-words text-sm">{peer.label}</span>
                        <span className="block break-words text-xs text-muted-foreground">
                          {edge.error ??
                            (edge.status === "unloaded"
                              ? edge.desired
                                ? "Saved connection · offline"
                                : "Disconnect pending"
                              : `${peer.projectTitle} · ${edge.status}`)}
                        </span>
                      </span>
                    </button>
                  )}
                </PeerLabel>
              );
            })}
            {desired.length === 0 ? (
              <p className="py-1 text-xs leading-relaxed text-muted-foreground">
                Connect project agents or threads to allow peer messages when their permissions
                permit. Read-only agents cannot reply to peers. You can also drag agents together in
                the sidebar.
              </p>
            ) : null}
            {query.error ? (
              <p role="status" className="text-xs text-destructive">
                Connections unavailable. Try again shortly.
              </p>
            ) : null}
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => {
              setOpen(false);
              context?.choosePeer(item);
            }}
          >
            <LinkIcon />
            {desired.length > 0 ? "Manage connections" : "Connect an agent"}
          </Button>
        </PopoverPopup>
      </Popover>
    </div>
  );
}

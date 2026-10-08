import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Columns2Icon, Rows2Icon, XIcon, PanelRightOpenIcon, Undo2Icon } from "lucide-react";
import { useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { meerkatTeamEnvironment } from "../../state/meerkatTeam";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { ThreadRouteView } from "../ThreadRouteView";
import { ProjectAgentConversation } from "./ProjectAgentConversation";
import { PresentationVisibility } from "../../hooks/usePresentationVisibility";
import { ConversationPaneContext } from "./ConversationPaneContext";
import { ConversationWorkspaceChrome } from "./ConversationWorkspaceChrome";
import { RestoreReviewBanner } from "./RestoreReviewBanner";
import {
  conversationTargetKey,
  EMPTY_CONVERSATION_LAYOUT,
  useConversationWorkspaceStore,
  type ConversationTarget,
} from "./conversationWorkspaceStore";

export function ConversationWorkspace({
  environmentId,
  projectId,
  primaryLabel,
  primaryTarget,
  children,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  primaryLabel: string;
  primaryTarget?: ConversationTarget | undefined;
  children: ReactNode;
}) {
  const routePath = useLocation({ select: (location) => location.pathname });
  const primaryKey = primaryTarget ? conversationTargetKey(primaryTarget) : routePath;
  const workspaceKey = JSON.stringify([environmentId, projectId]);
  const primaryId = `${workspaceKey}:primary`;
  const secondaryId = `${workspaceKey}:secondary`;
  const layout = useConversationWorkspaceStore(
    (state) => state.layouts[workspaceKey] ?? EMPTY_CONVERSATION_LAYOUT,
  );
  const focused = useConversationWorkspaceStore((state) => state.focusedPane);
  const state = useConversationWorkspaceStore.getState;
  const [picker, setPicker] = useState<string | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [short, setShort] = useState(false);
  const openingSecondary = useRef(false);
  const closingSecondary = useRef(false);
  const lastPrimaryFocus = useRef<HTMLElement | null>(null);
  const focusPrimary = useCallback(() => {
    requestAnimationFrame(() => {
      const pane = workspaceRef.current?.querySelector<HTMLElement>(
        '[data-pane-position="primary"]',
      );
      const remembered = lastPrimaryFocus.current;
      const target = remembered?.isConnected && pane?.contains(remembered) ? remembered : pane;
      target?.focus({ preventScroll: true });
    });
  }, []);
  const closeSecondary = () => {
    state().close(workspaceKey);
    state().focus(primaryId);
    setPicker(null);
    focusPrimary();
  };
  useEffect(() => {
    const element = workspaceRef.current;
    if (!element) return;
    const update = () => {
      setCompact(element.clientWidth < 860);
      setShort(element.clientHeight < 960);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [search, setSearch] = useState("");
  const team = useEnvironmentQuery(
    meerkatTeamEnvironment.projectTeam({ environmentId, input: { projectId } }),
  );
  const threads = useThreadShells().filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.projectId === projectId &&
      !thread.archivedAt,
  );
  const choices: ConversationTarget[] = [
    ...(team.data?.projectAgents
      .filter((agent) => !agent.archived)
      .map((agent): ConversationTarget => ({
        kind: "project-agent",
        environmentId,
        projectId,
        agentId: agent.agentId,
        label: agent.label,
      })) ?? []),
    ...threads.map((thread): ConversationTarget => ({
      kind: "thread",
      environmentId,
      projectId,
      threadId: thread.id,
      label: thread.title,
    })),
    ...(team.data?.providers.flatMap((provider) =>
      provider.agents
        .filter(
          (agent) =>
            agent.threadId && (agent.record.labels.source_mob_id || agent.record.labels.spawned_by),
        )
        .map((agent): ConversationTarget => ({
          kind: "thread",
          environmentId,
          projectId,
          threadId: agent.threadId!,
          member: agent.agentRef,
          label: agent.record.display_name,
        })),
    ) ?? []),
  ].filter(
    (target) =>
      !primaryTarget || conversationTargetKey(target) !== conversationTargetKey(primaryTarget),
  );
  const secondary =
    layout.secondary &&
    (!primaryTarget ||
      conversationTargetKey(layout.secondary) !== conversationTargetKey(primaryTarget))
      ? layout.secondary
      : null;
  useEffect(() => {
    state().focus(primaryId);
  }, [primaryId, primaryKey, state]);
  const primaryActive = useCallback(() => state().focusedPane === primaryId, [primaryId, state]);
  const secondaryActive = useCallback(
    () => state().focusedPane === secondaryId,
    [secondaryId, state],
  );
  const filteredChoices = choices.filter((target) =>
    target.label.toLowerCase().includes(search.toLowerCase()),
  );
  const controls = (id: string) => (
    <div className="flex shrink-0 items-center gap-0.5" data-conversation-layout-controls>
      <Popover
        open={picker === id}
        onOpenChange={(open) => {
          setPicker(open ? id : null);
          if (open) {
            setSearch("");
            team.refresh();
          }
        }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={<Button size="icon-sm" variant="ghost" aria-label="Open beside" />}
              >
                <PanelRightOpenIcon />
              </PopoverTrigger>
            }
          />
          <TooltipPopup>Open another conversation</TooltipPopup>
        </Tooltip>
        <PopoverPopup
          width="sm"
          align="end"
          finalFocus={() => {
            if (closingSecondary.current) {
              closingSecondary.current = false;
              focusPrimary();
              return false;
            }
            if (!openingSecondary.current) return true;
            openingSecondary.current = false;
            requestAnimationFrame(() => {
              const element = workspaceRef.current?.querySelector<HTMLElement>(
                '[data-pane-position="secondary"]',
              );
              element?.focus({ preventScroll: true });
              state().focus(secondaryId);
            });
            return false;
          }}
        >
          <PopoverTitle>Open beside</PopoverTitle>
          <div className="mt-3 space-y-3">
            {secondary ? (
              <div className="flex items-center gap-1 border-b border-border pb-3">
                <Button
                  size="xs"
                  variant={layout.direction === "columns" ? "secondary" : "ghost"}
                  aria-pressed={layout.direction === "columns"}
                  onClick={() => state().direction(workspaceKey, "columns")}
                >
                  <Columns2Icon /> Side by side
                </Button>
                <Button
                  size="xs"
                  variant={layout.direction === "rows" ? "secondary" : "ghost"}
                  aria-pressed={layout.direction === "rows"}
                  onClick={() => state().direction(workspaceKey, "rows")}
                >
                  <Rows2Icon /> Stacked
                </Button>
              </div>
            ) : layout.closed ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  openingSecondary.current = true;
                  state().reopen(workspaceKey);
                  state().focus(secondaryId);
                  setPicker(null);
                }}
              >
                <Undo2Icon /> Reopen last conversation
              </Button>
            ) : null}
            {secondary ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  closingSecondary.current = true;
                  closeSecondary();
                }}
              >
                <XIcon /> Close second conversation
              </Button>
            ) : null}
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find an agent or thread"
              aria-label="Find conversation"
            />
            <div className="max-h-72 space-y-0.5 overflow-y-auto">
              {filteredChoices.map((target) => (
                <button
                  key={conversationTargetKey(target)}
                  type="button"
                  className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`${target.label}, ${target.kind === "project-agent" ? "project agent" : target.member ? "worker" : "thread"}`}
                  onClick={() => {
                    openingSecondary.current = true;
                    state().open(workspaceKey, target);
                    state().focus(secondaryId);
                    setPicker(null);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{target.label}</span>
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {target.kind === "project-agent"
                      ? "Agent"
                      : target.member
                        ? "Worker"
                        : "Thread"}
                  </span>
                </button>
              ))}
              {filteredChoices.length === 0 ? (
                <p className="px-2 py-3 text-xs text-muted-foreground">
                  {search
                    ? "No matching conversations."
                    : "Another agent or thread will appear here once created."}
                </p>
              ) : null}
            </div>
          </div>
        </PopoverPopup>
      </Popover>
      {secondary && id === secondaryId ? (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Close second conversation"

          onClick={closeSecondary}
        >
          <XIcon />
        </Button>
      ) : null}
    </div>
  );
  const singleVisiblePane = layout.direction === "columns" ? compact : short;
  const pane = (id: string, content: ReactNode) => (
    <PresentationVisibility value={!secondary || !singleVisiblePane || focused === id}>
      <ConversationPaneContext value={id === primaryId ? primaryActive : secondaryActive}>
        <ConversationWorkspaceChrome
          value={{
            paneId: id,
            split: secondary !== null,
            secondary: id === secondaryId,
            controls: controls(id),
          }}
        >
          <section
            className={cn(
              "@container/conversation relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
              secondary && singleVisiblePane && focused !== id && "hidden",
            )}
            aria-label={id === primaryId ? primaryLabel : secondary?.label}
            onFocusCapture={(event) => {
              if (id === primaryId && event.target instanceof HTMLElement)
                lastPrimaryFocus.current = event.target;
              state().focus(id);
            }}
            onPointerDownCapture={() => state().focus(id)}
            tabIndex={-1}
            data-pane-position={id === primaryId ? "primary" : "secondary"}
            data-conversation-pane={id}
            data-active={focused === id}
          >
            {content}
          </section>
        </ConversationWorkspaceChrome>
      </ConversationPaneContext>
    </PresentationVisibility>
  );
  return (
    <div
      ref={workspaceRef}
      className="relative flex h-svh min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:h-dvh"
    >
      <RestoreReviewBanner environmentId={environmentId} />
      {secondary && singleVisiblePane ? (
        <div
          className={cn(
            "flex h-10 shrink-0 items-center gap-1 border-b border-border px-3",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
          aria-label="Conversation tabs"
        >
          {[
            { id: primaryId, label: primaryLabel },
            { id: secondaryId, label: secondary.label },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              className={cn(
                "min-w-0 flex-1 truncate rounded-md px-2 py-1 text-xs focus-visible:ring-2 focus-visible:ring-ring",
                focused === item.id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
              aria-label={item.label}
              aria-pressed={focused === item.id}
              onClick={() => state().focus(item.id)}
            >
              {item.label}
            </button>
          ))}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Close second conversation"
            onClick={closeSecondary}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 overflow-hidden",
          layout.direction === "rows"
            ? "flex-col divide-y divide-border"
            : "divide-x divide-border",
        )}
      >
        {pane(primaryId, children)}
        {secondary
          ? pane(
              secondaryId,
              secondary.kind === "project-agent" ? (
                <ProjectAgentConversation
                  key={conversationTargetKey(secondary)}
                  environmentId={secondary.environmentId}
                  projectId={secondary.projectId}
                  agentId={secondary.agentId}
                  embedded
                />
              ) : (
                <ThreadRouteView
                  key={conversationTargetKey(secondary)}
                  target={{
                    kind: "server",
                    threadRef: scopeThreadRef(secondary.environmentId, secondary.threadId),
                  }}
                  embedded
                  memberOverride={secondary.member ?? null}
                  onMemberChange={(member) => {
                    if (secondary.kind !== "thread") return;
                    const { member: _previousMember, ...coordinator } = secondary;
                    const worker = team.data?.providers
                      .flatMap((provider) => provider.agents)
                      .find((agent) => agent.agentRef === member);
                    state().open(workspaceKey, {
                      ...coordinator,
                      ...(member ? { member } : {}),
                      label:
                        worker?.record.display_name ??
                        threads.find((thread) => thread.id === secondary.threadId)?.title ??
                        secondary.label,
                    });
                  }}
                />
              ),
            )
          : null}
      </div>
    </div>
  );
}

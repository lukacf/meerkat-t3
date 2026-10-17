import { MeerkatWorkspaceCheckpoints } from "./MeerkatWorkspaceCheckpoints";
import { MeerkatToolApprovals } from "./MeerkatToolApprovals";
import { NativeAttentionReadMarker } from "./NativeAttentionReadMarker";
import { AgentBrowserControls } from "./AgentBrowserControls";
import type { AgentWorkspaceAttentionOrigin } from "./agentWorkspaceHandoffStore";
import { NativeAgentTranscript, NativeTranscriptPart } from "./NativeAgentTranscript";
import { NativeToolActivityGroup } from "./NativeToolActivityGroup";
import type { NativeActivityRow } from "./nativeToolActivity.logic";
import { useNativeToolActivity } from "./useNativeToolActivity";
import { canonicalAssistantMessage } from "./nativeAssistantOccurrence.logic";
import { savedMessageView } from "./nativeTranscript.logic";
import { nativePeerNotices, nativePeerTool } from "./nativePeerMessage.logic";
import { NativePeerContent } from "./NativePeerContent";
import {
  nativeHistoryIdentity,
  nativeActivityPages,
  nativeTranscriptPages,
  nativeConversationPreferences,
  readNativeHistoryPosition,
  selectNativeTranscriptRevision,
  followNativeHistoryEnd,
} from "./nativeHistoryState";
import {
  useNativeHistoryViewport,
  type NativeHistoryEndFocusRequest,
} from "./useNativeHistoryViewport";
import {
  useNativeHistoryDisclosures,
  type NativeHistoryDisclosures,
} from "./nativeHistoryDisclosures";
import { MeerkatResumeAgentButton } from "./MeerkatResumeAgentButton";
import type {
  ConsoleFrame,
  EnvironmentId,
  MeerkatTeamAgent,
  MeerkatAgentQueueItem,
  MeerkatTeamProvider,
  MeerkatSavedTranscript,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ServerProviderSkill,
} from "@t3tools/contracts";
import {
  ArrowUpIcon,
  RefreshCwIcon,
  SquareIcon,
  CopyIcon,
  ChevronDownIcon,
  CheckIcon,
  ListPlusIcon,
  EllipsisIcon,
} from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { isMacPlatform, randomUUID } from "../../lib/utils";
import { composerSubmissionIntentForEnter } from "../../composer-logic";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { meerkatTeamEnvironment, useVisibleTeamRefresh } from "../../state/meerkatTeam";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { AgentComposerEditor } from "./AgentComposerEditor";
import { agentWorkspaceDraftId } from "./agentWorkspaceContext";
import type { AgentDraftTarget } from "./agentDraftIdentity";
import { EarlierAgentDrafts } from "./EarlierAgentDrafts";
import { restoreReviewWorkBlock } from "./restoreReviewReadiness";
import { useComposerDraftStore } from "../../composerDraftStore";
import { composerContextRecordsFromDraft } from "../composerContextPresentation";
import {
  clearAcknowledgedAgentComposerDurably,
  migrateAgentComposerDraft,
  snapshotAgentComposer,
  updateAgentComposerPrompt,
  createRetainedAgentContext,
} from "./agentComposerContext";
import { useEnvironments } from "../../state/environments";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import { getAgentDeliveryRetryBlock, getAgentModelSendBlock } from "./agentModelReadiness";
import type { ComposerModelSendBlock } from "../chat/composerModelReadiness";
import { contextualSettingsScope } from "../settings/contextualSettingsScope";
import { providerAccountSettingsSearch } from "../settings/providerAccountTarget";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { useMeerkatAttention } from "../../state/meerkatAttention";
import { pendingNativeQuestionCalls } from "./nativeQuestionStatus";
import { resolveProviderSkillsForCwd } from "@t3tools/client-runtime/providerSkills";
import { extractMeerkatConsoleSkillSelections } from "@t3tools/shared/meerkatSkills";
import { ComposerSurface } from "../chat/ComposerSurface";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentUnsentQueue } from "./AgentUnsentQueue";
import { LegacyAgentUnsentQueue } from "./LegacyAgentUnsentQueue";
import {
  agentQueueImportPayload,
  confirmedAgentQueueImport,
  nextAgentQueueImport,
} from "./agentQueueMigration";
import {
  canSendAgentQueue,
  EMPTY_AGENT_QUEUE,
  type UnsentAgentMessage,
  useAgentUnsentQueueStore,
} from "./agentUnsentQueueStore";
import {
  agentConversationDraftKey,
  EMPTY_AGENT_DRAFT,
  type AgentSendPayload,
  type SendAttempt,
  useAgentConversationDraftStore,
} from "./agentConversationDraftStore";
import {
  conversationActivities,
  type ConversationActivity,
  frameText,
  isThreadCoordinator,
  mergeActivityFrames,
  nativeLabel,
} from "./agentActivity.logic";
import { advanceAgentHistory, INITIAL_AGENT_HISTORY } from "./agentHistory.logic";
import { AgentInteractionRequests } from "./AgentInteractionRequests";
import { AgentModelControls } from "./AgentModelControls";
import {
  NativeAgentImages,
  NativeImageAttachmentButton,
  NativeImageDraftRecovery,
  imageRefsFromNative,
  useMeerkatImageAttachments,
  type NativeMediaScope,
} from "./NativeAgentImages";

function ToolActivity({
  activity,
  scope,
  disclosures,
  rowId = activity.id,
  compact = false,
  questionPending = false,
  cwd,
  skills,
}: {
  activity: Extract<ConversationActivity, { kind: "tool" }>;
  disclosures: NativeHistoryDisclosures;
  scope: NativeMediaScope;
  rowId?: string;
  compact?: boolean;
  questionPending?: boolean | undefined;
  cwd: string | undefined;
  skills: ReadonlyArray<ServerProviderSkill>;
}) {
  const peer = activity.frames.reduce<ReturnType<typeof nativePeerTool>>((found, frame) => {
    const payload = frame.payload;
    return (
      found ??
      (payload && typeof payload === "object" && Reflect.get(payload, "args") !== undefined
        ? nativePeerTool(Reflect.get(payload, "name"), Reflect.get(payload, "args"))
        : null)
    );
  }, null);
  return (
    <article className={compact ? "py-0.5" : "px-5 py-2"} data-agent-frame-id={activity.id}>
      <details
        open={disclosures.expanded.has(activity.id)}
        onToggle={(event) => disclosures.toggle(activity.id, event.currentTarget.open, rowId)}
        className={compact ? "text-xs" : "rounded-lg border border-border text-xs"}
      >
        <summary
          className={`cursor-pointer py-2 ${compact ? "" : "px-3 "}${activity.status === "Failed" ? "text-destructive" : "text-muted-foreground"}`}
          onClick={() => disclosures.prepare(rowId)}
        >
          <span className="ml-1 font-medium text-foreground">
            {questionPending ? "Question" : (peer?.label ?? activity.label)}
          </span>
          <span className="ml-3">{questionPending ? "Needs input" : activity.status}</span>
        </summary>
        <div className="space-y-3 border-t border-border p-3">
          {peer ? (
            <NativePeerContent peer={peer} scope={scope} cwd={cwd} skills={skills} />
          ) : (
            <NativeAgentImages scope={scope} images={imageRefsFromNative(activity.frames)} />
          )}
          {!peer && activity.input ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">
              {activity.input}
            </pre>
          ) : null}
          {activity.output &&
          (!peer || activity.status === "Failed" || activity.status === "Stopped") ? (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-muted-foreground">
              {activity.output}
            </pre>
          ) : null}
          <details
            open={disclosures.expanded.has(`${activity.id}:details`)}
            onToggle={(event) =>
              disclosures.toggle(`${activity.id}:details`, event.currentTarget.open, rowId)
            }
            className="text-muted-foreground"
          >
            <summary className="cursor-pointer" onClick={() => disclosures.prepare(rowId)}>
              Activity details
            </summary>
            <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all">
              {JSON.stringify(activity.frames, null, 2)}
            </pre>
          </details>
        </div>
      </details>
    </article>
  );
}

function ActivityFrame({
  frame,
  rowId,
  scope,
  label,
  environmentId,
  cwd,
  disclosures,
  compact = false,
  disclosureId = rowId,
  skills,
}: {
  frame: ConsoleFrame;
  rowId: string;
  disclosures: NativeHistoryDisclosures;
  scope: NativeMediaScope;
  label: string;
  environmentId: EnvironmentId;
  cwd: string | undefined;
  compact?: boolean;
  disclosureId?: string;
  skills: ReadonlyArray<ServerProviderSkill>;
}) {
  const text = frameText(frame.payload);
  const canonicalMessage = canonicalAssistantMessage(frame);
  const saved = canonicalMessage ? savedMessageView(canonicalMessage, label) : null;
  const parts = saved?.parts.map((part, index) => ({ id: `${disclosureId}:${index}`, part }));
  const stopped =
    frame.kind === "interaction_failed" &&
    typeof frame.payload === "object" &&
    frame.payload !== null &&
    Reflect.get(frame.payload, "error_report")?.class === "cancelled";
  const user = frame.kind === "user_input";
  const assistant =
    saved !== null ||
    frame.kind === "text_complete" ||
    frame.kind === "text_delta" ||
    (frame.kind === "interaction_complete" && text);
  const message = user || assistant;
  const images = saved ? [] : imageRefsFromNative(frame.payload);
  const peers =
    frame.kind === "system_notice"
      ? nativePeerNotices(
          frame.payload && typeof frame.payload === "object"
            ? (Reflect.get(frame.payload, "message") ?? frame.payload)
            : frame.payload,
        )
      : [];
  if (peers.length) {
    return (
      <article className={compact ? "py-0.5" : "px-5 py-2"} data-agent-frame-id={frame.id}>
        {!compact ? (
          <div className="mb-2 text-xs text-muted-foreground">{nativeLabel(frame.status)}</div>
        ) : null}
        {peers.map((peer, index) => (
          <NativeTranscriptPart
            key={index}
            id={`${disclosureId}:peer:${index}`}
            rowId={rowId}
            part={{ kind: "peer", label: peer.label, value: frame.payload, peer }}
            scope={scope}
            cwd={cwd}
            disclosures={disclosures}
            compact={compact}
            skills={skills}
          />
        ))}
      </article>
    );
  }
  if (
    !message &&
    images.length === 0 &&
    !stopped &&
    frame.status !== "delivery_failed" &&
    frame.kind !== "interaction_failed"
  ) {
    const toolConfiguration =
      frame.kind === "tool_config_changed" ||
      (frame.kind === "system_notice" &&
        typeof frame.payload === "object" &&
        frame.payload !== null &&
        Reflect.get(frame.payload, "kind") === "tool_scope");
    const summary = toolConfiguration
      ? "Tool access updated"
      : frame.kind === "reasoning_complete"
        ? "Reasoning"
        : text
          ? text.slice(0, 140)
          : nativeLabel(frame.kind);
    return (
      <article className={compact ? "py-0.5" : "px-5 py-1"} data-agent-frame-id={frame.id}>
        <details
          open={disclosures.expanded.has(disclosureId)}
          onToggle={(event) => disclosures.toggle(disclosureId, event.currentTarget.open, rowId)}
          className="text-xs text-muted-foreground"
        >
          <summary className="cursor-pointer py-1" onClick={() => disclosures.prepare(rowId)}>
            {summary}
          </summary>
          <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/30 p-3">
            {JSON.stringify(frame.payload, null, 2)}
          </pre>
        </details>
      </article>
    );
  }
  return (
    <article
      className={compact ? "py-0.5" : message ? "px-5 py-4" : "px-5 py-2"}
      data-agent-frame-id={frame.id}
    >
      {!compact ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {message ? (
            <h3 className="font-semibold text-foreground">{user ? "You" : label}</h3>
          ) : (
            <span>{stopped ? "Stopped" : nativeLabel(frame.kind)}</span>
          )}
          {!stopped && (user || !message) ? (
            <Badge size="sm" variant="secondary">
              {nativeLabel(frame.status)}
            </Badge>
          ) : null}
          <time className="ml-auto" dateTime={new Date(frame.timestamp_ms).toISOString()}>
            {new Date(frame.timestamp_ms).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        </div>
      ) : null}
      {saved ? (
        <div className="space-y-3 text-sm">
          {parts?.map(({ id, part }) => (
            <NativeTranscriptPart
              key={id}
              id={id}
              rowId={rowId}
              part={part}
              scope={scope}
              cwd={cwd}
              disclosures={disclosures}
              compact={compact}
              skills={skills}
            />
          ))}
        </div>
      ) : (
        <NativeAgentImages scope={scope} images={images} />
      )}
      {!saved && text && message ? (
        <div className={user ? "rounded-xl bg-muted/60 p-4" : "text-sm"}>
          <ChatMarkdown
            text={text}
            cwd={cwd}
            environmentId={environmentId}
            isStreaming={frame.kind === "text_delta"}
            skills={skills}
            headingLevelOffset={3}
          />
        </div>
      ) : null}
      {!message ? (
        <details
          open={disclosures.expanded.has(frame.id)}
          onToggle={(event) => disclosures.toggle(frame.id, event.currentTarget.open)}
          className="text-xs text-muted-foreground"
        >
          <summary className="cursor-pointer" onClick={() => disclosures.prepare(frame.id)}>
            {text ? text.slice(0, 140) : "View activity details"}
          </summary>
          <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/30 p-3">
            {JSON.stringify(frame.payload, null, 2)}
          </pre>
        </details>
      ) : null}
    </article>
  );
}

function NativeActivityHistory({
  identity,
  activityRows,
  listRef,
  scope,
  agentLabel,
  environmentId,
  cwd,
  hasHistory,
  loadingHistory,
  loadHistory,
  history,
  historyError,
  isPending,
  mobKind,
  nativeRunId,
  skills,
  pendingQuestionToolCallIds,
}: {
  identity: string;
  activityRows: readonly NativeActivityRow[];
  listRef: RefObject<LegendListRef | null>;
  scope: NativeMediaScope;
  agentLabel: string;
  environmentId: EnvironmentId;
  cwd: string | undefined;
  hasHistory: boolean;
  loadingHistory: boolean;
  loadHistory: () => Promise<void>;
  history: typeof INITIAL_AGENT_HISTORY;
  historyError: string | null;
  isPending: boolean;
  mobKind: MeerkatTeamAgent["mobKind"];
  nativeRunId?: string | undefined;
  skills: ReadonlyArray<ServerProviderSkill>;
  pendingQuestionToolCallIds: ReadonlySet<string>;
}) {
  const displayRows = useNativeToolActivity(identity, activityRows);
  const rowIds = useMemo(() => displayRows.map((row) => row.id), [displayRows]);
  const viewport = useNativeHistoryViewport({ identity, listRef, rowIds });
  const disclosures = useNativeHistoryDisclosures(identity);
  const extraData = useMemo(
    () => ({
      expanded: disclosures.expanded,
      agentLabel,
      cwd,
      environmentId,
      projectId: scope.projectId,
      instanceId: scope.instanceId,
      agentRef: scope.agentRef,
      threadId: scope.threadId,
      nativeRunId,
      skills,
      pendingQuestionToolCallIds,
    }),
    [
      disclosures.expanded,
      agentLabel,
      cwd,
      environmentId,
      scope.projectId,
      scope.instanceId,
      scope.agentRef,
      scope.threadId,
      nativeRunId,
      skills,
      pendingQuestionToolCallIds,
    ],
  );
  return (
    <LegendList
      ref={listRef}
      data={displayRows}
      extraData={extraData}
      keyExtractor={(item) => item.id}
      estimatedItemSize={110}
      initialScrollAtEnd={viewport.initialScrollAtEnd}
      {...(viewport.initialScrollIndex
        ? { initialScrollIndex: viewport.initialScrollIndex, alwaysRender: viewport.alwaysRender }
        : {})}
      onLoad={viewport.onLoad}
      onScroll={viewport.onScroll}
      onItemSizeChanged={viewport.onItemSizeChanged}
      maintainVisibleContentPosition={
        viewport.positioning
          ? false
          : {
              data: true,
              size: true,
              shouldRestorePosition: (row) => disclosures.shouldRestorePosition(row.id),
            }
      }
      maintainScrollAtEnd={
        viewport.positioning || disclosures.settling
          ? false
          : { animated: false, on: { dataChange: true, itemLayout: true, layout: true } }
      }
      maintainScrollAtEndThreshold={0.01}
      recycleItems={false}
      className="h-full min-h-0 overflow-x-hidden overscroll-y-contain [overflow-anchor:none]"
      role="list"
      aria-label="Conversation activity"
      ListHeaderComponent={
        <div className="mx-auto max-w-3xl">
          {hasHistory ? (
            <div className="flex justify-center py-4">
              <Button
                size="sm"
                variant="ghost-muted"
                disabled={loadingHistory}
                onClick={() => void loadHistory()}
              >
                {loadingHistory
                  ? "Loading conversation history..."
                  : history.started
                    ? "Load more history"
                    : "Load conversation history"}
              </Button>
            </div>
          ) : null}
          {historyError ? (
            <p role="status" className="px-6 py-3 text-xs text-warning-foreground">
              {historyError}
            </p>
          ) : null}
        </div>
      }
      renderItem={({ item, index }) => (
        <div
          role="listitem"
          aria-posinset={index + 1}
          aria-setsize={displayRows.length}
          className="mx-auto max-w-3xl"
        >
          {item.kind === "raw" ? (
            <article data-agent-frame-id={item.id} className="border-b border-border/50 p-4">
              <pre className="overflow-auto whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(item.frame, null, 2)}
              </pre>
            </article>
          ) : item.kind === "tool-group" ? (
            <NativeToolActivityGroup
              group={item}
              disclosures={disclosures}
              nativeRunId={nativeRunId}
              pendingQuestionToolCallIds={pendingQuestionToolCallIds}
              renderActivity={(activity, rowId, questionPending) =>
                activity.kind === "tool" ? (
                  <ToolActivity
                    activity={activity}
                    scope={scope}
                    disclosures={disclosures}
                    rowId={rowId}
                    questionPending={questionPending}
                    cwd={cwd}
                    skills={skills}
                    compact
                  />
                ) : (
                  <ActivityFrame
                    scope={scope}
                    frame={activity.frame}
                    rowId={rowId}
                    disclosureId={activity.id}
                    disclosures={disclosures}
                    label={agentLabel}
                    environmentId={environmentId}
                    cwd={cwd}
                    skills={skills}
                    compact
                  />
                )
              }
            />
          ) : item.kind === "tool" ? (
            <ToolActivity
              activity={item}
              scope={scope}
              disclosures={disclosures}
              cwd={cwd}
              skills={skills}
            />
          ) : (
            <ActivityFrame
              scope={scope}
              frame={item.frame}
              rowId={item.id}
              disclosures={disclosures}
              label={agentLabel}
              environmentId={environmentId}
              cwd={cwd}
              skills={skills}
            />
          )}
        </div>
      )}
      ListFooterComponent={<div className="h-6" />}
      ListEmptyComponent={
        <div className="mx-auto max-w-md px-6 py-16 text-center text-sm text-muted-foreground">
          {isPending
            ? "Loading conversation..."
            : mobKind === "thread"
              ? "Talk directly to this worker while keeping its conversation inside the thread."
              : "Start a conversation with this agent. Its context stays with it across threads."}
        </div>
      }
    />
  );
}

type AgentConversationProps = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  provider: MeerkatTeamProvider;
  agent: MeerkatTeamAgent;
  primaryProjectAgentId?: string | undefined;
  browserReturnAttention?: AgentWorkspaceAttentionOrigin | undefined;
  rosterStale: boolean;
  readOnlyReason?: string | undefined;
  readOnlyAction?: ReactNode;
  refreshTeam: () => void;
  displayName?: string;
  cwd: string | undefined;
  accessMode?: RuntimeMode | "repository-read-only" | "read-and-collaborate" | undefined;
};

export function AgentConversation(props: AgentConversationProps) {
  const identity = nativeHistoryIdentity(
    {
      environmentId: props.environmentId,
      projectId: props.projectId,
      instanceId: props.provider.instanceId,
      agentRef: props.agent.agentRef,
    },
    props.agent.record.session_id,
  );
  return <AgentConversationContent key={identity} {...props} historyIdentity={identity} />;
}

function AgentConversationContent({
  environmentId,
  projectId,
  provider,
  agent,
  primaryProjectAgentId,
  browserReturnAttention,
  rosterStale,
  readOnlyReason,
  readOnlyAction,
  refreshTeam,
  displayName,
  cwd,
  accessMode,
  historyIdentity,
}: AgentConversationProps & { historyIdentity: string }) {
  const navigate = useNavigate();
  const settings = useEnvironmentSettings(environmentId);
  const settingsProjectGroups = useSettingsProjectGroups();
  const providerSettingsScope = useMemo(
    () =>
      providerAccountSettingsSearch({
        environmentId,
        instanceId: provider.instanceId,
        projectId,
        threadId: agent.threadId,
        cwd,
        fallback: contextualSettingsScope({
          environmentId,
          projectId,
          groups: settingsProjectGroups,
          threads: [],
        }),
      }),
    [environmentId, projectId, settingsProjectGroups, provider.instanceId, agent.threadId, cwd],
  );
  const isMobileViewport = useMediaQuery("max-sm");
  const agentLabel = displayName ?? agent.record.display_name;
  const query = useEnvironmentQuery(
    meerkatTeamEnvironment.agentActivity({
      environmentId,
      input: { projectId, instanceId: provider.instanceId, agentRef: agent.agentRef, limit: 100 },
    }),
  );
  useVisibleTeamRefresh(query, !rosterStale);
  const loadPage = useAtomCommand(meerkatTeamEnvironment.agentActivityPage, {
    reportFailure: false,
  });
  const [cachedActivity] = useState(() => nativeActivityPages.get(historyIdentity));
  const [olderFrames, setOlderFrames] = useState<ReadonlyArray<ConsoleFrame>>(
    cachedActivity?.frames ?? [],
  );
  const [history, setHistory] = useState(cachedActivity?.history ?? INITIAL_AGENT_HISTORY);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyInFlight = useRef(false);
  const send = useAtomCommand(meerkatTeamEnvironment.agentSend, { reportFailure: false });
  const reconcileDelivery = useAtomCommand(meerkatTeamEnvironment.agentDeliveryReconcile, {
    reportFailure: false,
  });
  const stop = useAtomCommand(meerkatTeamEnvironment.agentStop, { reportFailure: false });
  const queueTarget = { projectId, instanceId: provider.instanceId, agentRef: agent.agentRef };
  const queueQuery = useEnvironmentQuery(
    meerkatTeamEnvironment.agentQueue({ environmentId, input: queueTarget }),
  );
  useVisibleTeamRefresh(queueQuery, !isThreadCoordinator(agent));
  const queueEnqueue = useAtomCommand(meerkatTeamEnvironment.agentQueueEnqueue, {
    reportFailure: false,
  });
  const queueEdit = useAtomCommand(meerkatTeamEnvironment.agentQueueEdit, { reportFailure: false });
  const queueMove = useAtomCommand(meerkatTeamEnvironment.agentQueueMove, { reportFailure: false });
  const queueCancel = useAtomCommand(meerkatTeamEnvironment.agentQueueCancel, {
    reportFailure: false,
  });
  const queueRetry = useAtomCommand(meerkatTeamEnvironment.agentQueueRetry, {
    reportFailure: false,
  });
  const [queuePending, setQueuePending] = useState(false);
  const queueInFlight = useRef(false);
  const importsAttempted = useRef(new Set<string>());

  const draftTarget: AgentDraftTarget = {
    environmentId,
    projectId,
    instanceId: provider.instanceId,
    identity: primaryProjectAgentId
      ? { kind: "project-agent", projectAgentId: primaryProjectAgentId }
      : { kind: "native-agent", durableId: agent.durableId, agentRef: agent.agentRef },
  };
  const draftKey = agentConversationDraftKey(draftTarget);
  const composerDraftId = agentWorkspaceDraftId(draftTarget);
  const composerDraft = useComposerDraftStore((state) => state.getComposerDraft(composerDraftId));
  useEffect(() => {
    migrateAgentComposerDraft(draftKey, composerDraftId);
  }, [draftKey, composerDraftId]);
  const contextRecords = useMemo(
    () =>
      composerContextRecordsFromDraft({
        terminalContexts: composerDraft?.terminalContexts ?? [],
        reviewComments: composerDraft?.reviewComments ?? [],
        previewAnnotations: composerDraft?.previewAnnotations ?? [],
      }),
    [composerDraft],
  );
  const { environments } = useEnvironments();
  const serverConfig = environments.find(
    (entry) => entry.environmentId === environmentId,
  )?.serverConfig;
  const configuredProvider = serverConfig?.providers.find(
    (entry) => entry.instanceId === provider.instanceId,
  );
  const skills = configuredProvider
    ? resolveProviderSkillsForCwd(configuredProvider, cwd ?? null)
    : [];
  const draft = useAgentConversationDraftStore(
    (state) => state.byTarget[draftKey] ?? EMPTY_AGENT_DRAFT,
  );
  const sendPending = useAgentConversationDraftStore((state) =>
    Boolean(state.pendingByTarget[draftKey]),
  );
  const mediaScope = {
    environmentId,
    projectId,
    instanceId: provider.instanceId,
    agentRef: agent.agentRef,
  };
  const attachments = useMeerkatImageAttachments(mediaScope, draftKey);
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const unsent = useAgentUnsentQueueStore((state) => state.byTarget[draftKey] ?? EMPTY_AGENT_QUEUE);
  const text = composerDraft?.prompt ?? draft.text;
  const retainedContext = useMemo(createRetainedAgentContext, [composerDraftId]);
  const handlingMode = draft.mode;
  const setText = (value: string) =>
    updateAgentComposerPrompt(composerDraftId, value, retainedContext);
  const setHandlingMode = (value: "queue" | "steer") =>
    useAgentConversationDraftStore.getState().setMode(draftKey, value);
  const [stopping, setStopping] = useState(false);
  const stopInFlight = useRef(false);
  const [checkingDelivery, setCheckingDelivery] = useState(false);
  const pending =
    sendPending || checkingDelivery || stopping || queuePending || attachments.uploading;
  const inFlight = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeModelAction, setNoticeModelAction] =
    useState<ComposerModelSendBlock["action"]>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [absentDelivery, setAbsentDelivery] = useState<SendAttempt | null>(null);
  const readModelBlock = (selection: ModelSelection | undefined, steering = false) =>
    getAgentModelSendBlock({
      instanceId: provider.instanceId,
      selection,
      currentModel: agent.work?.model,
      modelAuth: agent.work?.modelAuth,
      steering,
      cwd,
      serverConfig: appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId),
    });
  const rejectModelSend = (block: ComposerModelSendBlock, savedMessage = false) => {
    setNotice(
      savedMessage
        ? `${block.reason} The saved message and its delivery details are unchanged.`
        : block.reason,
    );
    setNoticeModelAction(
      savedMessage && block.action?.kind === "models"
        ? { kind: "settings", instanceId: provider.instanceId, label: "Open provider settings" }
        : block.action,
    );
  };
  const [preferences] = useState(() => nativeConversationPreferences.get(historyIdentity));
  const [raw, setRaw] = useState(preferences?.raw ?? false);
  const [conversationView, setConversationView] = useState<"saved" | "events" | null>(
    preferences?.view ?? null,
  );
  const latestTranscript = query.data?.transcript;
  const [pinnedTranscript, setPinnedTranscript] = useState<MeerkatSavedTranscript | undefined>(
    () =>
      preferences?.savedRevision
        ? nativeTranscriptPages.get(`${historyIdentity}:saved:${preferences.savedRevision}`)
        : undefined,
  );
  const [latestTranscriptRequest, setLatestTranscriptRequest] = useState(0);
  const [latestTranscriptFocus, setLatestTranscriptFocus] = useState<{
    sessionId: string;
    storeRevision: string;
    request: NativeHistoryEndFocusRequest;
  }>();
  const transcript = selectNativeTranscriptRevision(
    pinnedTranscript,
    latestTranscript,
    pinnedTranscript
      ? readNativeHistoryPosition(`${historyIdentity}:saved:${pinnedTranscript.storeRevision}`)
      : undefined,
  );
  if (
    latestTranscriptFocus &&
    (latestTranscriptFocus.sessionId !== transcript?.sessionId ||
      latestTranscriptFocus.storeRevision !== transcript?.storeRevision)
  )
    setLatestTranscriptFocus(undefined);
  if (
    transcript !== pinnedTranscript &&
    transcript &&
    (conversationView === "saved" ||
      (conversationView === null && agent.work?.status !== "running"))
  )
    setPinnedTranscript(transcript);
  if (conversationView === null && query.data)
    setConversationView(latestTranscript && agent.work?.status !== "running" ? "saved" : "events");
  const showingSaved = Boolean(
    transcript &&
    (conversationView === "saved" ||
      (conversationView === null && agent.work?.status !== "running")),
  );
  const hasNewSavedMessages = Boolean(
    showingSaved &&
    latestTranscript &&
    latestTranscript.storeRevision !== transcript?.storeRevision,
  );
  const activityList = useRef<LegendListRef>(null);
  const openLatestTranscript = (focusLatest = false) => {
    const latest = latestTranscript ?? pinnedTranscript;
    if (latest) {
      followNativeHistoryEnd(`${historyIdentity}:saved:${latest.storeRevision}`);
      const requestId = randomUUID();
      setLatestTranscriptFocus(
        focusLatest
          ? {
              sessionId: latest.sessionId,
              storeRevision: latest.storeRevision,
              request: {
                id: requestId,
                onHandled: () =>
                  setLatestTranscriptFocus((current) =>
                    current?.request.id === requestId ? undefined : current,
                  ),
              },
            }
          : undefined,
      );
      setPinnedTranscript(latest);
      setLatestTranscriptRequest((request) => request + 1);
    }
  };
  const refreshConversation = () => {
    openLatestTranscript();
    query.refresh();
  };
  useEffect(() => {
    if (conversationView)
      nativeConversationPreferences.set(historyIdentity, {
        view: conversationView,
        raw,
        ...(transcript ? { savedRevision: transcript.storeRevision } : {}),
      });
  }, [historyIdentity, conversationView, raw, transcript]);
  const coordinator = isThreadCoordinator(agent);
  const addressable =
    (agent.availability === undefined || agent.availability === "live") &&
    agent.record.addressable &&
    !agent.canResume &&
    agent.record.visibility === "addressable" &&
    !readOnlyReason &&
    !rosterStale &&
    provider.status !== "disabled";
  const liveSteering = addressable && handlingMode === "steer";
  const restoreHeld = restoreReviewWorkBlock(serverConfig?.restoreReview) !== null;
  const draftModelBlock = getAgentModelSendBlock({
    instanceId: provider.instanceId,
    selection: draft.modelSelection,
    currentModel: agent.work?.model,
    modelAuth: agent.work?.modelAuth,
    steering: liveSteering,
    cwd,
    serverConfig,
  });
  const frames = useMemo(
    () => mergeActivityFrames([...olderFrames, ...(query.data?.timeline.frames ?? [])]),
    [olderFrames, query.data?.timeline.frames],
  );
  const historySnapshot = useRef({ frames, history });
  useLayoutEffect(() => {
    historySnapshot.current = { frames, history };
  }, [frames, history]);
  useLayoutEffect(
    () => () => nativeActivityPages.set(historyIdentity, historySnapshot.current),
    [historyIdentity],
  );
  const [retainedPage, setRetainedPage] = useState(query.data);
  if (query.data && retainedPage !== query.data) {
    setRetainedPage(query.data);
    setOlderFrames(frames);
  }
  const hasHistory = !history.exhausted && frames.length > 0;
  async function loadHistory() {
    if (!hasHistory || historyInFlight.current) return;
    historyInFlight.current = true;
    setLoadingHistory(true);
    setHistoryError(null);
    try {
      const result = await loadPage({
        environmentId,
        input: {
          projectId,
          instanceId: provider.instanceId,
          agentRef: agent.agentRef,
          limit: 100,
          mode: "since",
          ...(history.after ? { after: history.after } : {}),
        },
      });
      if (result._tag === "Failure") {
        setHistoryError(formatEnvironmentQueryError(result.cause));
        return;
      }
      setOlderFrames((previous) =>
        mergeActivityFrames([...result.value.timeline.frames, ...previous]),
      );
      const next = advanceAgentHistory(history, result.value.timeline);
      setHistory(next);
      if (next.exhausted && result.value.timeline.exhausted !== true)
        setHistoryError("The history cursor stopped advancing. Loaded messages remain available.");
    } finally {
      historyInFlight.current = false;
      setLoadingHistory(false);
    }
  }
  const activityRows = useMemo<
    ReadonlyArray<ConversationActivity | { kind: "raw"; id: string; frame: ConsoleFrame }>
  >(
    () =>
      raw
        ? frames.map((frame) => ({ kind: "raw", id: frame.id, frame }))
        : conversationActivities(frames),
    [frames, raw],
  );
  async function submit(queuedId?: string, recovery?: { requestId: string; retry?: true }) {
    migrateAgentComposerDraft(draftKey, composerDraftId);
    const snapshot = snapshotAgentComposer(
      useComposerDraftStore.getState().getComposerDraft(composerDraftId),
    );
    const savedQueueRows = useAgentUnsentQueueStore.getState().readTarget(draftKey);
    if (!savedQueueRows && !recovery) {
      setNotice("Could not read the saved queue. Your message is retained; no new work was sent.");
      return;
    }
    const queued = queuedId ? savedQueueRows?.find((row) => row.id === queuedId) : undefined;
    const latestDraft =
      useAgentConversationDraftStore.getState().byTarget[draftKey] ?? EMPTY_AGENT_DRAFT;
    const requestedAttempt = recovery
      ? useAgentConversationDraftStore.getState().findSendAttemptById(draftKey, recovery.requestId)
      : undefined;
    if (recovery && !requestedAttempt) {
      const error = useAgentConversationDraftStore.getState().sendErrorByTarget[draftKey];
      if (!error) setAbsentDelivery(null);
      setNotice(
        error ?? "The saved request is no longer available in this browser. No new work was sent.",
      );
      return;
    }
    const requestedRetry = recovery?.retry ? requestedAttempt : undefined;
    const draftImages = queued || requestedAttempt ? [] : attachments.readForSend();
    if (draftImages === null) return;
    if (
      (queuedId && !queued && !requestedAttempt) ||
      (!requestedAttempt &&
        !(queued?.text ?? snapshot.text).trim() &&
        !(queued ? (queued.images ?? []) : draftImages).length) ||
      coordinator ||
      inFlight.current
    )
      return;
    const confirming =
      !queued && !requestedAttempt
        ? savedQueueRows?.find(
            (row) =>
              row.text === snapshot.text &&
              JSON.stringify(row.context) === JSON.stringify(snapshot.context) &&
              JSON.stringify(row.images ?? []) === JSON.stringify(draftImages),
          )
        : undefined;
    if (confirming) {
      if (latestDraft.attempts.some((attempt) => attempt.queueId === confirming.id))
        await submit(confirming.id);
      else await importQueued(confirming.id);
      return;
    }
    const mode = queued ? "queue" : latestDraft.mode;
    const selection = queued
      ? queued.modelSelection
      : mode === "queue"
        ? latestDraft.modelSelection
        : undefined;
    const payload: AgentSendPayload = requestedAttempt ?? {
      text: (queued?.text ?? snapshot.text).trim(),
      ...((queued ? queued.context : snapshot.context)
        ? { context: queued ? queued.context! : snapshot.context! }
        : {}),
      mode,
      images: queued ? (queued.images ?? []) : draftImages,
      ...(selection ? { modelSelection: selection } : {}),
      ...(queued ? { queueId: queued.id } : {}),
      agentRef: agent.agentRef,
    };
    const earlierAttempt =
      requestedAttempt ??
      useAgentConversationDraftStore.getState().findSendAttempt(draftKey, payload);
    if (earlierAttempt && !earlierAttempt.agentRef) {
      setNotice(
        "This earlier request has no saved agent session. Its delivery details are retained; no new work was sent.",
      );
      return;
    }
    if (requestedRetry) {
      const retryBlock = getAgentDeliveryRetryBlock({
        attempt: requestedRetry,
        absentRequestId: absentDelivery?.requestId,
        currentAgentRef: agent.agentRef,
        addressable,
        work: agent.work,
        now: Date.now(),
        instanceId: provider.instanceId,
        currentModel: agent.work?.model,
        modelAuth: agent.work?.modelAuth,
        cwd,
        serverConfig: appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId),
      });
      if (retryBlock) {
        rejectModelSend(retryBlock, true);
        return;
      }
    }
    if (!earlierAttempt) {
      if (!addressable) {
        setNotice("Connect this agent before sending. Your draft is unchanged.");
        setNoticeModelAction(null);
        return;
      }
      if (attachments.uploading) return;
      try {
        extractMeerkatConsoleSkillSelections(payload.text, mode);
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : String(cause));
        return;
      }
      const modelBlock = readModelBlock(selection, mode === "steer");
      if (modelBlock) {
        rejectModelSend(modelBlock, Boolean(queued));
        return;
      }
      if (selection && !canSendAgentQueue(agent.work, Date.now())) {
        if (!queued) await queueDraft();
        return;
      }
    }
    // Checking an earlier request never sends. Retrying requires a separate
    // explicit action after absence, with the original payload and target.
    let createdNewAttempt = false;
    const attempt =
      earlierAttempt ??
      useAgentConversationDraftStore.getState().beginSend(
        draftKey,
        () => {
          createdNewAttempt = true;
          return randomUUID();
        },
        payload,
      );
    if (!attempt) {
      const error = useAgentConversationDraftStore.getState().sendErrorByTarget[draftKey];
      if (error) setNotice(error);
      return;
    }
    if (!attempt.agentRef) {
      setNotice(
        "This earlier request has no saved agent session. Its delivery details are retained; no new work was sent.",
      );
      useAgentConversationDraftStore.getState().finishSend(draftKey, attempt.requestId);
      return;
    }
    const receiptOnly = !createdNewAttempt && !requestedRetry;
    inFlight.current = true;
    setCheckingDelivery(receiptOnly);
    setNotice(null);
    setNoticeModelAction(null);
    setAbsentDelivery(null);
    try {
      const result = await (receiptOnly ? reconcileDelivery : send)({
        environmentId,
        input: {
          projectId,
          instanceId: provider.instanceId,
          agentRef: attempt.agentRef,
          requestId: attempt.requestId,
          text: attempt.text,
          ...(attempt.context ? { context: attempt.context } : {}),
          handlingMode: attempt.mode,
          ...(attempt.images?.length ? { images: attempt.images } : {}),
          ...(attempt.modelSelection ? { modelSelection: attempt.modelSelection } : {}),
        },
      });
      if (result._tag === "Failure") {
        setNotice(formatEnvironmentQueryError(result.cause));
        return;
      }
      if (!result.value) {
        setAbsentDelivery(attempt);
        setNotice(
          "No earlier delivery record was found. Your message and original request are retained; no new work was sent.",
        );
        return;
      }
      if (result.value.status === "uncertain") {
        setNotice(
          result.value.message ??
            "Delivery is uncertain. Check the conversation before trying again.",
        );
        return;
      }
      // The immutable attempt outlives every cleanup write, including queue
      // retries invoked without the original local row still being present.
      if (
        (attempt.queueId &&
          !useAgentUnsentQueueStore.getState().remove(draftKey, attempt.queueId)) ||
        !clearAcknowledgedAgentComposerDurably(composerDraftId, attempt) ||
        !attachments.clearAcknowledged(attempt.images ?? [])
      ) {
        setNotice(
          "Delivery was confirmed, but local draft cleanup could not be saved. The original request is retained. Check delivery again after freeing local storage.",
        );
        return;
      }
      if (!useAgentConversationDraftStore.getState().acknowledge(draftKey, attempt.requestId)) {
        setNotice(
          useAgentConversationDraftStore.getState().sendErrorByTarget[draftKey] ??
            "Delivery was confirmed, but its local confirmation could not be saved. The original request is retained.",
        );
        return;
      }
      void activityList.current?.scrollToEnd({ animated: false });
      setConversationView("events");
      setNotice(
        result.value.message ?? (attempt.mode === "steer" ? "Steering sent." : "Message sent."),
      );
      query.refresh();
      refreshTeam();
    } finally {
      inFlight.current = false;
      setCheckingDelivery(false);
      useAgentConversationDraftStore.getState().finishSend(draftKey, attempt.requestId);
    }
  }
  function observedQueueImport(row: UnsentAgentMessage) {
    return confirmedAgentQueueImport(
      row,
      {
        environmentId,
        target: queueTarget,
        durableId: agent.durableId,
      },
      {
        environmentId,
        target: queueTarget,
        queue: queueQuery.data ?? undefined,
        isPending: queueQuery.isPending,
        hasError: Boolean(queueQuery.error),
      },
    );
  }
  function clearImportedQueueDraft(row: UnsentAgentMessage) {
    // Unlike direct sends, the local queue row is the only immutable request
    // record. Keep it until both composer stores have durably removed its data.
    if (
      !clearAcknowledgedAgentComposerDurably(composerDraftId, row) ||
      !attachments.clearAcknowledged(row.images ?? []) ||
      !useAgentUnsentQueueStore.getState().remove(draftKey, row.id)
    ) {
      setNotice(
        "This message is already saved to the server queue, but local cleanup could not be saved. The original queued message is retained for confirmation.",
      );
      return false;
    }
    return true;
  }
  async function importQueued(id: string) {
    if (queueInFlight.current || coordinator) return false;
    const savedRows = useAgentUnsentQueueStore.getState().readTarget(draftKey);
    if (!savedRows) {
      setNotice("Could not read the saved queue. No new work was sent.");
      return false;
    }
    const row = savedRows.find((item) => item.id === id);
    if (!row) return false;
    const earlierAttempt = useAgentConversationDraftStore.getState().findSendAttempt(draftKey, {
      ...agentQueueImportPayload(row),
      mode: "queue",
      queueId: row.id,
    });
    const recoveryError = useAgentConversationDraftStore.getState().sendErrorByTarget[draftKey];
    if (recoveryError) {
      setNotice(recoveryError);
      return false;
    }
    if (earlierAttempt) {
      await submit(id, { requestId: earlierAttempt.requestId });
      return false;
    }
    if (observedQueueImport(row)) {
      if (!clearImportedQueueDraft(row)) return false;
      setNotice("The earlier queue request was confirmed. No new work was sent.");
      setNoticeModelAction(null);
      return true;
    }
    if (!addressable) {
      setNotice(
        "Connect this agent before adding new work to its queue. Your saved message is unchanged.",
      );
      setNoticeModelAction(null);
      return false;
    }
    const modelBlock = readModelBlock(row.modelSelection);
    if (modelBlock) {
      rejectModelSend(modelBlock, true);
      return false;
    }
    queueInFlight.current = true;
    setQueuePending(true);
    setNoticeModelAction(null);
    try {
      const result = await queueEnqueue({
        environmentId,
        input: {
          ...queueTarget,
          requestId: `import-${row.id}`,
          payload: agentQueueImportPayload(row),
        },
      });
      if (result._tag === "Failure") {
        setNotice(formatEnvironmentQueryError(result.cause));
        return false;
      }
      queueQuery.refresh();
      if (!clearImportedQueueDraft(row)) return false;
      setNotice(
        "Saved to the queue. It will send when the agent is idle, even after you leave this conversation.",
      );
      return true;
    } finally {
      queueInFlight.current = false;
      setQueuePending(false);
    }
  }
  async function queueDraft() {
    const images = attachments.readForSend();
    if (images === null) return;
    migrateAgentComposerDraft(draftKey, composerDraftId);
    const snapshot = snapshotAgentComposer(
      useComposerDraftStore.getState().getComposerDraft(composerDraftId),
    );
    if ((!snapshot.text.trim() && !images.length) || pending || coordinator) return;
    if (!addressable) {
      setNotice("Connect this agent before adding new work to its queue. Your draft is unchanged.");
      setNoticeModelAction(null);
      return;
    }
    try {
      extractMeerkatConsoleSkillSelections(snapshot.text, "queue");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    const selection = useAgentConversationDraftStore.getState().byTarget[draftKey]?.modelSelection;
    const payload = {
      ...snapshot,
      images,
      ...(selection ? { modelSelection: selection } : {}),
    };
    useAgentConversationDraftStore
      .getState()
      .findSendAttempt(draftKey, { ...payload, mode: "queue" });
    const recoveryError = useAgentConversationDraftStore.getState().sendErrorByTarget[draftKey];
    if (recoveryError) {
      setNotice(recoveryError);
      return;
    }
    if (
      useAgentConversationDraftStore
        .getState()
        .byTarget[draftKey]?.attempts.some(
          (attempt) =>
            attempt.text === snapshot.text &&
            JSON.stringify(attempt.context) === JSON.stringify(snapshot.context),
        )
    ) {
      setNotice(
        "An earlier delivery of this message needs confirmation. Check delivery before adding it to the queue.",
      );
      return;
    }
    const modelBlock = readModelBlock(selection);
    if (modelBlock) {
      rejectModelSend(modelBlock);
      return;
    }
    const savedRows = useAgentUnsentQueueStore.getState().readTarget(draftKey);
    if (!savedRows) {
      setNotice("Could not read the saved queue. Your draft is unchanged.");
      return;
    }
    const prior = savedRows.find(
      (row) =>
        row.text === payload.text &&
        JSON.stringify(row.context) === JSON.stringify(payload.context) &&
        JSON.stringify(row.images ?? []) === JSON.stringify(payload.images) &&
        JSON.stringify(row.modelSelection) === JSON.stringify(payload.modelSelection),
    );
    const id = prior?.id ?? randomUUID();
    if (
      !prior &&
      !useAgentUnsentQueueStore.getState().add(draftKey, { id, ...payload, sendWhenIdle: true })
    ) {
      setNotice("Could not save the queued message. Your draft is unchanged.");
      return;
    }
    importsAttempted.current.add(id);
    await importQueued(id);
  }
  const nextImport = nextAgentQueueImport(unsent, draft.attempts);
  const nextImportRecorded = Boolean(nextImport && observedQueueImport(nextImport));
  const pendingImportModelBlock =
    nextImport && !nextImportRecorded
      ? getAgentModelSendBlock({
          instanceId: provider.instanceId,
          selection: nextImport.modelSelection,
          currentModel: agent.work?.model,
          modelAuth: agent.work?.modelAuth,
          steering: false,
          cwd,
          serverConfig,
        })
      : null;
  const importModelBlocked = pendingImportModelBlock !== null;
  useEffect(() => {
    if (
      !nextImport ||
      coordinator ||
      (!addressable && !nextImportRecorded) ||
      queuePending ||
      queueQuery.error ||
      importModelBlocked ||
      importsAttempted.current.has(nextImport.id)
    )
      return;
    importsAttempted.current.add(nextImport.id);
    void importQueued(nextImport.id);
  }, [
    nextImport,
    coordinator,
    addressable,
    nextImportRecorded,
    queuePending,
    queueQuery.error,
    importModelBlocked,
  ]);
  async function mutateQueue(
    item: MeerkatAgentQueueItem,
    action: "edit" | "move" | "cancel" | "retry",
    value?: string,
  ) {
    if (queueInFlight.current || !queueQuery.data || queueQuery.error || queueQuery.isPending)
      return false;
    // Uncertain items only reconcile their receipt. Failed items are new work.
    if (action === "retry" && item.status !== "uncertain") {
      if (!addressable) {
        setNotice("Connect this agent before retrying queued work.");
        setNoticeModelAction(null);
        return false;
      }
      const modelBlock = readModelBlock(item.payload.modelSelection);
      if (modelBlock) {
        rejectModelSend(modelBlock, true);
        return false;
      }
    }
    queueInFlight.current = true;
    setQueuePending(true);
    setNoticeModelAction(null);
    const input = { ...queueTarget, itemId: item.id, expectedRevision: queueQuery.data.revision };
    try {
      const result =
        action === "edit"
          ? await queueEdit({
              environmentId,
              input: { ...input, payload: { ...item.payload, text: value ?? item.payload.text } },
            })
          : action === "move"
            ? await queueMove({
                environmentId,
                input: { ...input, direction: value === "up" ? "up" : "down" },
              })
            : action === "cancel"
              ? await queueCancel({ environmentId, input })
              : await queueRetry({ environmentId, input });
      queueQuery.refresh();
      if (result._tag === "Failure") {
        setNotice(formatEnvironmentQueryError(result.cause));
        return false;
      }
      setNotice(null);
      return true;
    } finally {
      queueInFlight.current = false;
      setQueuePending(false);
    }
  }
  async function cancel() {
    if (!addressable || stopInFlight.current) return;
    const nativeRunId = agent.work?.status === "running" ? agent.work.nativeRunId : undefined;
    if (!nativeRunId) {
      setNotice("The current run is not available to stop. Refresh the agent's status.");
      query.refresh();
      refreshTeam();
      return;
    }
    stopInFlight.current = true;
    setStopping(true);
    setNoticeModelAction(null);
    try {
      const result = await stop({
        environmentId,
        input: {
          projectId,
          instanceId: provider.instanceId,
          agentRef: agent.agentRef,
          nativeRunId,
        },
      });
      setNotice(
        result._tag === "Failure"
          ? formatEnvironmentQueryError(result.cause)
          : "Stop request sent.",
      );
      query.refresh();
      refreshTeam();
    } finally {
      stopInFlight.current = false;
      setStopping(false);
    }
  }
  const unavailableReason =
    readOnlyReason ??
    (rosterStale
      ? "Agent status is unavailable. Refresh to reconnect."
      : agent.availability && agent.availability !== "live"
        ? "This agent is offline. You can still read its conversation."
        : "This agent is currently unavailable.");
  const working = agent.work?.status === "running";
  const attention = useMeerkatAttention(environmentId, projectId);
  const pendingQuestionToolCallIds = useMemo(
    () =>
      pendingNativeQuestionCalls(
        addressable && !attention.error ? (attention.data?.items ?? []) : [],
        {
          projectId,
          instanceId: provider.instanceId,
          agentRef: agent.agentRef,
          sessionId: agent.record.session_id,
          mobId: agent.mobId,
        },
      ),
    [
      addressable,
      attention.error,
      attention.data,
      projectId,
      provider.instanceId,
      agent.agentRef,
      agent.record.session_id,
      agent.mobId,
    ],
  );
  const needsInput = pendingQuestionToolCallIds.size > 0;
  const requiresModifier =
    settings.sendShortcut === "mod-enter" ||
    (settings.sendShortcut === "mod-enter-multiline" && /[\r\n]/.test(text));
  const sendShortcutLabel = isMobileViewport
    ? null
    : requiresModifier
      ? `${isMacPlatform(navigator.platform) ? "Cmd" : "Ctrl"}+Enter`
      : "Enter";
  const renderModelAction = (action: ComposerModelSendBlock["action"]) =>
    action?.kind === "settings" ? (
      <Link
        to="/settings/providers"
        search={{ ...providerSettingsScope, environmentId, instanceId: action.instanceId }}
      >
        {action.label}
      </Link>
    ) : action?.kind === "models" ? (
      <Button
        type="button"
        variant="ghost-muted"
        size="xs"
        onClick={() => setModelPickerOpen(true)}
      >
        {action.label}
      </Button>
    ) : null;
  return (
    <section
      className="@container/agent-conversation flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label="Agent conversation"
    >
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {hasNewSavedMessages ? "New messages available" : ""}
      </span>
      {query.data && !query.error && !rosterStale ? (
        <NativeAttentionReadMarker
          environmentId={environmentId}
          projectId={projectId}
          instanceId={provider.instanceId}
          agentRef={agent.agentRef}
          sessionId={agent.record.session_id}
        />
      ) : null}
      <div className="flex h-9 min-w-0 shrink-0 items-center gap-2 px-4 text-xs text-muted-foreground">
        <span
          className={`size-1.5 shrink-0 rounded-full ${needsInput ? "bg-warning" : addressable && working ? "bg-primary" : addressable ? "bg-success" : "bg-muted-foreground/40"}`}
        />
        <span className="min-w-0 flex-1 truncate" role="status">
          {addressable
            ? needsInput
              ? "Needs input"
              : working
                ? "Working"
                : agent.work?.status === "idle"
                  ? "Ready"
                  : "Connected"
            : "Conversation history"}
        </span>
        {transcript ? (
          <Menu>
            <MenuTrigger
              render={<Button variant="ghost-muted" size="xs" aria-label="Conversation source" />}
            >
              {showingSaved ? "Messages" : "Live activity"}
              <ChevronDownIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem
                onClick={() => {
                  setConversationView("saved");
                  setRaw(false);
                }}
              >
                {showingSaved ? <CheckIcon /> : null}Saved messages
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setLatestTranscriptFocus(undefined);
                  setConversationView("events");
                  setRaw(false);
                }}
              >
                {!showingSaved ? <CheckIcon /> : null}Live activity
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : null}
        {hasNewSavedMessages ? (
          <Button size="xs" variant="ghost-muted" onClick={() => openLatestTranscript(true)}>
            New messages
          </Button>
        ) : null}
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label="Conversation options"
                title="Conversation options"
              />
            }
          >
            <EllipsisIcon />
          </PopoverTrigger>
          <PopoverPopup align="end">
            <div className="w-64 space-y-2 p-2">
              <div className="flex flex-col items-start gap-1">
                <Button variant="ghost" size="sm" aria-pressed={raw} onClick={() => setRaw(!raw)}>
                  {raw ? "Hide message details" : "Show message details"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={query.isPending}
                  onClick={refreshConversation}
                >
                  <RefreshCwIcon />
                  Refresh conversation
                </Button>
                {!showingSaved ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!frames.length}
                    onClick={() =>
                      void writeTextToClipboard(
                        frames
                          .map(
                            (frame) =>
                              `${frame.kind === "user_input" ? "You" : agentLabel}: ${frameText(frame.payload) || nativeLabel(frame.kind)}`,
                          )
                          .join("\n\n"),
                        "conversation",
                      ).then(
                        () => setNotice("Loaded conversation copied."),
                        () => setNotice("Could not copy the conversation."),
                      )
                    }
                  >
                    <CopyIcon />
                    Copy loaded conversation
                  </Button>
                ) : null}
              </div>
              {agent.record.labels.source_mob_id ? (
                <div className="border-t border-border pt-2">
                  <MeerkatResumeAgentButton
                    environmentId={environmentId}
                    projectId={projectId}
                    instanceId={provider.instanceId}
                    agent={agent}
                    onResumed={refreshTeam}
                    disabled={
                      rosterStale ||
                      Boolean(readOnlyReason) ||
                      pending ||
                      provider.status === "disabled"
                    }
                  />
                </div>
              ) : null}
              <p className="px-2 text-xs leading-relaxed text-muted-foreground">
                {showingSaved
                  ? "Saved messages from this session. Switch to live activity to inspect events."
                  : query.data?.historyStatus === "partial"
                    ? "Live event history is partial. Saved messages are available separately."
                    : "Live activity from this agent's session."}
              </p>
            </div>
          </PopoverPopup>
        </Popover>
      </div>
      {query.error ? (
        <p role="status" className="shrink-0 px-5 py-2 text-xs text-warning-foreground">
          {query.error}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        {showingSaved && transcript ? (
          <NativeAgentTranscript
            key={`${agent.agentRef}:${transcript.sessionId}:${transcript.storeRevision}`}
            initial={transcript}
            scope={mediaScope}
            agentLabel={agentLabel}
            cwd={cwd}
            raw={raw}
            onRefresh={refreshConversation}
            latestRequest={latestTranscriptRequest}
            {...(latestTranscriptFocus?.sessionId === transcript.sessionId &&
            latestTranscriptFocus.storeRevision === transcript.storeRevision
              ? { latestFocusRequest: latestTranscriptFocus.request }
              : {})}
            skills={skills}
          />
        ) : (
          <NativeActivityHistory
            identity={`${historyIdentity}:events`}
            activityRows={activityRows}
            listRef={activityList}
            scope={mediaScope}
            agentLabel={agentLabel}
            environmentId={environmentId}
            cwd={cwd}
            hasHistory={hasHistory}
            loadingHistory={loadingHistory}
            loadHistory={loadHistory}
            history={history}
            historyError={historyError}
            isPending={query.isPending}
            mobKind={agent.mobKind}
            nativeRunId={addressable && working ? agent.work?.nativeRunId : undefined}
            skills={skills}
            pendingQuestionToolCallIds={pendingQuestionToolCallIds}
          />
        )}
      </div>
      <div className="max-h-[60%] shrink-0 overflow-y-auto px-3 pb-3 pt-2 @lg/agent-conversation:px-5 @lg/agent-conversation:pb-4">
        <EarlierAgentDrafts
          environmentId={environmentId}
          projectId={projectId}
          instanceId={provider.instanceId}
        />
        {addressable ? (
          <AgentInteractionRequests
            environmentId={environmentId}
            projectId={projectId}
            instanceId={provider.instanceId}
            agentRef={agent.agentRef}
          />
        ) : null}
        {agent.mobKind === "thread" &&
        (agent.availability === undefined || agent.availability === "live") ? (
          <MeerkatToolApprovals
            environmentId={environmentId}
            target={{ projectId, instanceId: provider.instanceId, agentRef: agent.agentRef }}
          />
        ) : null}
        <AgentUnsentQueue
          queue={queueQuery.data ?? undefined}
          environmentId={environmentId}
          cwd={cwd}
          skills={skills}
          disabled={queuePending}
          loading={queueQuery.isPending}
          error={queueQuery.error}
          onRefresh={queueQuery.refresh}
          onEdit={(item, text) => mutateQueue(item, "edit", text)}
          onMove={(item, direction) => void mutateQueue(item, "move", direction)}
          onCancel={(item) => void mutateQueue(item, "cancel")}
          onRetry={(item) => void mutateQueue(item, "retry")}
        />
        <LegacyAgentUnsentQueue
          targetKey={draftKey}
          uncertainIds={
            new Set(draft.attempts.flatMap((attempt) => (attempt.queueId ? [attempt.queueId] : [])))
          }
          disabled={pending}
          onSend={(id) => {
            if (draft.attempts.some((attempt) => attempt.queueId === id)) void submit(id);
            else void importQueued(id);
          }}
        />
        {coordinator ? (
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 rounded-xl bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
            <p>Continue in the coordinator's thread.</p>
            {agent.threadId ? (
              <Button
                variant="outline"
                size="xs"
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId, threadId: agent.threadId! },
                  })
                }
              >
                Open thread
              </Button>
            ) : null}
          </div>
        ) : null}
        {!coordinator && !addressable ? (
          <div
            role="status"
            className="mx-auto mb-2 flex max-w-3xl items-center gap-3 rounded-xl border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground"
          >
            <p className="min-w-0 flex-1 leading-relaxed">
              {unavailableReason} Your draft stays editable.
              {!readOnlyReason && !rosterStale
                ? " Connect this agent to send or queue work."
                : null}
            </p>
            {readOnlyReason && readOnlyAction ? (
              <div className="shrink-0">{readOnlyAction}</div>
            ) : null}
            {rosterStale ? (
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Refresh agent status"
                onClick={refreshTeam}
              >
                <RefreshCwIcon />
              </Button>
            ) : null}
          </div>
        ) : null}
        {!coordinator ? (
          <form
            className="mx-auto max-w-3xl"
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("Files")) {
                event.preventDefault();
                event.dataTransfer.dropEffect =
                  addressable && !pending && !attachments.readFailed ? "copy" : "none";
              }
            }}
            onDrop={(event) => {
              const files = Array.from(event.dataTransfer.files).filter((file) =>
                file.type.startsWith("image/"),
              );
              if (files.length) {
                event.preventDefault();
                if (!addressable) {
                  setNotice(
                    "Connect this agent before attaching new images. Existing images are saved with your draft.",
                  );
                  setNoticeModelAction(null);
                  return;
                }
                if (pending) return;
                void attachments.addFiles(files);
              }
            }}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {addressable ? (
              <div className="mb-2">
                <MeerkatWorkspaceCheckpoints
                  environmentId={environmentId}
                  target={mediaScope}
                  offerCapture
                />
              </div>
            ) : null}
            <ComposerSurface.Shell>
              <ComposerSurface.Host>
                <ComposerSurface.Main>
                  {attachments.images.length ? (
                    <div className="max-h-36 overflow-auto px-4 pt-2">
                      <NativeAgentImages scope={mediaScope} images={attachments.images} />
                      <div className="flex flex-wrap gap-1">
                        {attachments.images.map((image, index) => (
                          <Button
                            type="button"
                            key={image.blob_id}
                            variant="ghost-muted"
                            size="xs"
                            disabled={attachments.readFailed}
                            onClick={() => attachments.remove(image.blob_id)}
                          >
                            Remove image {index + 1}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <div className="px-4 pt-4 pb-2">
                    <AgentComposerEditor
                      ariaLabel={`Message ${agentLabel}`}
                      editorRef={editorRef}
                      value={text}
                      environmentId={environmentId}
                      cwd={cwd}
                      contextRecords={contextRecords}
                      skills={skills}
                      disabled={pending}
                      className="min-h-16 max-h-40 text-sm"
                      placeholder={
                        liveSteering
                          ? `Redirect ${agentLabel}'s current work...`
                          : `Message ${agentLabel}...`
                      }
                      onChange={setText}
                      onPaste={(event) => {
                        const files = Array.from(event.clipboardData.files).filter((file) =>
                          file.type.startsWith("image/"),
                        );
                        if (files.length) {
                          event.preventDefault();
                          if (!addressable) {
                            setNotice(
                              "Connect this agent before attaching new images. Existing images are saved with your draft.",
                            );
                            setNoticeModelAction(null);
                            return;
                          }
                          if (pending) return;
                          void attachments.addFiles(files);
                        }
                      }}
                      onCommandKeyDown={(key, event) => {
                        if (key !== "Enter" || event.isComposing || event.keyCode === 229)
                          return false;
                        const intent = composerSubmissionIntentForEnter({
                          isMobileViewport,
                          shiftKey: event.shiftKey,
                          modifierKey: event.metaKey || event.ctrlKey,
                          isDraftThread: false,
                          sendShortcut: settings.sendShortcut,
                          prompt: text,
                        });
                        if (!intent) return false;
                        // Delivery mode is explicit in this composer; the shortcut only decides send vs newline.
                        event.preventDefault();
                        void submit();
                        return true;
                      }}
                    />
                  </div>
                  <div className="flex min-w-0 items-center gap-1 px-3 pb-3">
                    <div className="min-w-0 flex-1">
                      <AgentModelControls
                        environmentId={environmentId}
                        instanceId={provider.instanceId}
                        settingsScope={providerSettingsScope}
                        value={liveSteering ? undefined : draft.modelSelection}
                        currentModel={agent.work?.model}
                        currentModelProvider={agent.work?.modelProvider}
                        currentReasoning={agent.work?.reasoning}
                        cwd={cwd}
                        open={modelPickerOpen}
                        onOpenChange={setModelPickerOpen}
                        onChange={(value) => {
                          useAgentConversationDraftStore.getState().setModel(draftKey, value);
                          setNotice(null);
                          setNoticeModelAction(null);
                        }}
                        disabled={pending || liveSteering}
                      />
                    </div>
                    {addressable ? (
                      <>
                        {accessMode !== "repository-read-only" &&
                        accessMode !== "read-and-collaborate" ? (
                          <AgentBrowserControls
                            scope={mediaScope}
                            workspaceCwd={cwd}
                            ownerThreadId={agent.threadId}
                            primaryProjectAgentId={primaryProjectAgentId}
                            returnAttention={
                              browserReturnAttention?.sessionId === agent.record.session_id
                                ? browserReturnAttention
                                : undefined
                            }
                            label={agentLabel}
                            currentModel={agent.work?.model}
                            accessMode={accessMode}
                            disabled={pending}
                          />
                        ) : null}
                        <NativeImageAttachmentButton attachments={attachments} disabled={pending} />
                      </>
                    ) : null}
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            type="button"
                            size="xs"
                            variant={handlingMode === "steer" ? "secondary" : "ghost-muted"}
                            aria-label="Message options"
                            title={
                              handlingMode === "steer" ? "Steering current work" : "Message options"
                            }
                            disabled={pending}
                          />
                        }
                      >
                        {handlingMode === "steer" ? "Steer" : "Message"}
                        <ChevronDownIcon />
                      </MenuTrigger>
                      <MenuPopup side="top" align="end">
                        <p className="max-w-72 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                          Message enters the native queue. Steer corrects active work. Queue for
                          idle keeps a follow-up editable until the agent is ready. Stop ends the
                          current turn; queued work remains and may run next.
                        </p>
                        <MenuItem onClick={() => setHandlingMode("queue")}>
                          <span className="w-4">
                            {handlingMode === "queue" ? <CheckIcon className="size-4" /> : null}
                          </span>
                          Message
                        </MenuItem>
                        <MenuItem disabled={!addressable} onClick={() => setHandlingMode("steer")}>
                          <span className="w-4">
                            {handlingMode === "steer" ? <CheckIcon className="size-4" /> : null}
                          </span>
                          Steer current work
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem
                          disabled={
                            !addressable ||
                            stopping ||
                            agent.work?.status !== "running" ||
                            !agent.work.nativeRunId
                          }
                          onClick={() => void cancel()}
                        >
                          <SquareIcon />
                          Stop turn
                        </MenuItem>
                        <MenuItem
                          disabled={
                            pending ||
                            attachments.readFailed ||
                            restoreHeld ||
                            !addressable ||
                            (!text.trim() && !attachments.images.length) ||
                            draft.attempts.some((attempt) => {
                              const snapshot = snapshotAgentComposer(composerDraft);
                              return (
                                attempt.text === snapshot.text &&
                                JSON.stringify(attempt.context) === JSON.stringify(snapshot.context)
                              );
                            })
                          }
                          onClick={() => void queueDraft()}
                        >
                          <ListPlusIcon />
                          Queue for idle
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                    {addressable && working ? (
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost-muted"
                        disabled={stopping || !agent.work?.nativeRunId}
                        aria-label="Stop turn"
                        title="Stop turn"
                        onClick={() => void cancel()}
                      >
                        <SquareIcon />
                      </Button>
                    ) : null}
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="submit"
                            className="ml-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-message-action text-message-action-foreground hover:bg-message-action-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-40"
                            disabled={
                              !addressable ||
                              restoreHeld ||
                              pending ||
                              attachments.readFailed ||
                              (!text.trim() && !attachments.images.length)
                            }
                            aria-label={
                              pending
                                ? "Sending message"
                                : handlingMode === "steer"
                                  ? "Steer current work"
                                  : "Send message"
                            }
                          >
                            <ArrowUpIcon className="size-4" />
                          </button>
                        }
                      />
                      <TooltipPopup>
                        {!addressable ? (
                          "Connect this agent to send"
                        ) : (
                          <>
                            {handlingMode === "steer" ? "Steer current work" : "Send message"}{" "}
                            {sendShortcutLabel ? `(${sendShortcutLabel})` : null}
                          </>
                        )}
                      </TooltipPopup>
                    </Tooltip>
                  </div>
                  {liveSteering ? (
                    <p role="status" className="px-4 pb-3 text-xs text-muted-foreground">
                      Corrects the active turn. If it has ended, switch to Message.
                    </p>
                  ) : null}
                </ComposerSurface.Main>
              </ComposerSurface.Host>
            </ComposerSurface.Shell>
            {draftModelBlock ? (
              <div
                role="status"
                className="mt-2 flex flex-wrap items-center gap-x-2 px-3 text-xs text-muted-foreground"
              >
                <span>{draftModelBlock.reason}</span>
                {renderModelAction(draftModelBlock.action)}
              </div>
            ) : null}
            <NativeImageDraftRecovery attachments={attachments} />
          </form>
        ) : null}
        {pendingImportModelBlock ? (
          <p role="status" className="mx-auto mt-2 max-w-3xl text-xs text-muted-foreground">
            A saved message is waiting for model access. {pendingImportModelBlock.reason}{" "}
            {renderModelAction({
              kind: "settings",
              instanceId: provider.instanceId,
              label: "Open provider settings",
            })}
          </p>
        ) : null}
        {draft.attempts
          .filter(
            (attempt) => !attempt.queueId || !unsent.some((row) => row.id === attempt.queueId),
          )
          .map((attempt) => (
            <div
              key={attempt.requestId}
              className="mx-auto mt-3 flex max-w-3xl items-center gap-3 rounded-lg border border-border/70 px-3 py-2"
            >
              <div className="min-w-0 flex-1 text-xs">
                <p className="font-medium">Earlier delivery needs confirmation</p>
                <p className="mt-1 truncate text-muted-foreground">
                  {attempt.text || "Image message"}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={pending}
                onClick={() => void submit(undefined, { requestId: attempt.requestId })}
              >
                Check delivery
              </Button>
            </div>
          ))}
        {notice ? (
          <p role="status" className="mx-auto mt-3 max-w-3xl text-xs text-muted-foreground">
            {notice} {renderModelAction(noticeModelAction)}
          </p>
        ) : null}
        {absentDelivery ? (
          <div className="mx-auto mt-2 max-w-3xl">
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={pending}
              onClick={() =>
                void submit(absentDelivery.queueId, {
                  requestId: absentDelivery.requestId,
                  retry: true,
                })
              }
            >
              Retry same message
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

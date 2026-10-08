import { LegendList, type LegendListRef } from "@legendapp/list/react";
import type { MeerkatSavedTranscript, ServerProviderSkill } from "@t3tools/contracts";
import { useParams, useSearch } from "@tanstack/react-router";
import { CopyIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { resolveProviderSkillsForCwd } from "@t3tools/client-runtime/providerSkills";
import { useEnvironments } from "../../state/environments";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { meerkatTeamEnvironment } from "../../state/meerkatTeam";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import {
  useNativeHistoryDisclosures,
  type NativeHistoryDisclosures,
} from "./nativeHistoryDisclosures";
import { Button } from "../ui/button";
import { NativeAgentImages, type NativeMediaScope } from "./NativeAgentImages";
import { NativePeerContent } from "./NativePeerContent";
import { nativePeerTool } from "./nativePeerMessage.logic";
import {
  nativeHistoryIdentity,
  nativeTranscriptPages,
  mergeNativeTranscriptWindows,
} from "./nativeHistoryState";
import {
  useNativeHistoryViewport,
  type NativeHistoryEndFocusRequest,
} from "./useNativeHistoryViewport";
import {
  mergeSavedTranscriptPages,
  savedMessageView,
  savedTranscriptText,
  type SavedMessagePart,
} from "./nativeTranscript.logic";

export function NativeTranscriptPart({
  part,
  scope,
  cwd,
  id,
  rowId,
  disclosures,
  compact = false,
  skills,
}: {
  part: SavedMessagePart;
  id: string;
  rowId: string;
  disclosures: NativeHistoryDisclosures;
  scope: NativeMediaScope;
  cwd: string | undefined;
  compact?: boolean;
  skills: ReadonlyArray<ServerProviderSkill>;
}) {
  if (part.kind === "image") return <NativeAgentImages scope={scope} images={[part.image]} />;
  if (part.kind === "text")
    return (
      <ChatMarkdown
        text={part.text}
        cwd={cwd}
        environmentId={scope.environmentId}
        isStreaming={false}
        skills={skills}
        headingLevelOffset={3}
      />
    );
  if (part.kind === "reasoning")
    return part.text ? (
      <details
        open={disclosures.expanded.has(id)}
        onToggle={(event) => disclosures.toggle(id, event.currentTarget.open, rowId)}
        className="text-xs text-muted-foreground"
      >
        <summary className="cursor-pointer" onClick={() => disclosures.prepare(rowId)}>
          Reasoning
        </summary>
        <div className="pt-3">
          <ChatMarkdown
            text={part.text}
            cwd={cwd}
            environmentId={scope.environmentId}
            isStreaming={false}
            skills={skills}
            headingLevelOffset={3}
          />
        </div>
      </details>
    ) : null;
  const peer =
    part.kind === "peer"
      ? part.peer
      : part.kind === "tool"
        ? nativePeerTool(part.label, part.value)
        : null;
  return (
    <details
      open={disclosures.expanded.has(id)}
      onToggle={(event) => disclosures.toggle(id, event.currentTarget.open, rowId)}
      className={compact ? "text-xs" : "rounded-lg border border-border text-xs"}
    >
      <summary
        onClick={() => disclosures.prepare(rowId)}
        className={`cursor-pointer py-2 ${compact ? "" : "px-3 "}${part.kind === "tool" && part.error ? "text-destructive" : "text-muted-foreground"}`}
      >
        {peer?.label ?? part.label}
      </summary>
      {peer ? (
        <div className="space-y-3 border-t border-border p-3">
          <NativePeerContent peer={peer} scope={scope} cwd={cwd} skills={skills} />
          <details
            open={disclosures.expanded.has(`${id}:details`)}
            onToggle={(event) =>
              disclosures.toggle(`${id}:details`, event.currentTarget.open, rowId)
            }
          >
            <summary
              className="cursor-pointer text-muted-foreground"
              onClick={() => disclosures.prepare(rowId)}
            >
              Message details
            </summary>
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all">
              {JSON.stringify(part.value, null, 2)}
            </pre>
          </details>
        </div>
      ) : (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all border-t border-border p-3">
          {typeof part.value === "string" ? part.value : JSON.stringify(part.value, null, 2)}
        </pre>
      )}
    </details>
  );
}

type NativeAgentTranscriptProps = {
  initial: MeerkatSavedTranscript;
  scope: NativeMediaScope;
  agentLabel: string;
  cwd: string | undefined;
  raw: boolean;
  onRefresh: () => void;
  latestRequest?: number;
  latestFocusRequest?: NativeHistoryEndFocusRequest;
  skills?: ReadonlyArray<ServerProviderSkill>;
};

/** Revision-keyed read-only transcript; pages never enter the live ConsoleFrame collection. */
export function NativeAgentTranscript(props: NativeAgentTranscriptProps) {
  return (
    <NativeAgentTranscriptContent
      key={`${nativeHistoryIdentity(props.scope, props.initial.sessionId)}:${props.initial.storeRevision}`}
      {...props}
    />
  );
}

function NativeAgentTranscriptContent({
  initial,
  scope,
  agentLabel,
  cwd,
  raw,
  onRefresh,
  latestRequest,
  latestFocusRequest,
  skills: suppliedSkills,
}: NativeAgentTranscriptProps) {
  const { environments } = useEnvironments();
  const provider = environments
    .find((environment) => environment.environmentId === scope.environmentId)
    ?.serverConfig?.providers.find((candidate) => candidate.instanceId === scope.instanceId);
  const skills = suppliedSkills ?? (provider ? resolveProviderSkillsForCwd(provider, cwd) : []);
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const selectedOffset =
    params.environmentId === scope.environmentId &&
    search.nativeAgent === scope.agentRef &&
    search.nativeSession === initial.sessionId &&
    search.nativeRevision === initial.storeRevision
      ? search.nativeOffset
      : undefined;
  const identity = `${nativeHistoryIdentity(scope, initial.sessionId)}:saved:${initial.storeRevision}`;
  const [loaded, setLoaded] = useState(() => {
    const cached = nativeTranscriptPages.get(identity);
    return {
      initial,
      transcript: cached ? mergeNativeTranscriptWindows(cached, initial) : initial,
    };
  });
  const transcript =
    loaded.initial === initial
      ? loaded.transcript
      : mergeNativeTranscriptWindows(loaded.transcript, initial);
  if (loaded.initial !== initial) setLoaded({ initial, transcript });
  useEffect(() => {
    nativeTranscriptPages.set(identity, transcript);
  }, [identity, transcript]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const list = useRef<LegendListRef>(null);
  const disclosures = useNativeHistoryDisclosures(identity);
  const rows = useMemo(
    () =>
      transcript.messages.flatMap(({ offset, message }) => {
        const view = savedMessageView(message, agentLabel);
        if (!view) return [];
        // Native block order is stable within this immutable session revision.
        const parts = view.parts.map((part, index) => ({ id: `${offset}:${index}`, part }));
        return [{ offset, message, view, parts }];
      }),
    [transcript.messages, agentLabel],
  );
  const rowIds = useMemo(() => rows.map((row) => String(row.offset)), [rows]);
  const viewport = useNativeHistoryViewport({
    identity,
    listRef: list,
    rowIds,
    ...(latestRequest !== undefined ? { endRequest: latestRequest } : {}),
    ...(latestFocusRequest ? { endFocusRequest: latestFocusRequest } : {}),
    ...(selectedOffset !== undefined ? { selectedRowId: String(selectedOffset) } : {}),
  });
  const extraData = useMemo(
    () => ({
      expanded: disclosures.expanded,
      raw,
      selectedOffset,
      environmentId: scope.environmentId,
      projectId: scope.projectId,
      instanceId: scope.instanceId,
      agentRef: scope.agentRef,
      threadId: scope.threadId,
      cwd,
      skills,
    }),
    [
      disclosures.expanded,
      raw,
      selectedOffset,
      scope.environmentId,
      scope.projectId,
      scope.instanceId,
      scope.agentRef,
      scope.threadId,
      cwd,
      skills,
    ],
  );
  const loadPage = useAtomCommand(meerkatTeamEnvironment.agentActivityPage, {
    reportFailure: false,
  });
  async function loadOlder() {
    if (
      inFlight.current ||
      transcript.exhausted ||
      transcript.nextBefore === undefined ||
      !scope.agentRef
    )
      return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await loadPage({
        environmentId: scope.environmentId,
        input: {
          projectId: scope.projectId,
          instanceId: scope.instanceId,
          agentRef: scope.agentRef,
          limit: 100,
          transcriptBefore: transcript.nextBefore,
          transcriptRevision: transcript.storeRevision,
        },
      });
      if (result._tag === "Failure") {
        setError(formatEnvironmentQueryError(result.cause));
        return;
      }
      if (!result.value.transcript)
        throw new Error("Saved messages are unavailable. Refresh the conversation to try again.");
      const next = mergeSavedTranscriptPages(transcript, result.value.transcript);
      setLoaded((current) =>
        current.initial === initial ? { initial, transcript: next } : current,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load older saved messages.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  return (
    <div className="h-full min-h-0" aria-label="Saved conversation messages">
      <LegendList
        ref={list}
        data={rows}
        extraData={extraData}
        keyExtractor={(item) => String(item.offset)}
        estimatedItemSize={130}
        initialScrollAtEnd={viewport.initialScrollAtEnd}
        {...(viewport.initialScrollIndex
          ? { initialScrollIndex: viewport.initialScrollIndex, alwaysRender: viewport.alwaysRender }
          : {})}
        dataVersion={selectedOffset ?? "latest"}
        onLoad={viewport.onLoad}
        onScroll={viewport.onScroll}
        onItemSizeChanged={viewport.onItemSizeChanged}
        maintainVisibleContentPosition={
          viewport.positioning
            ? false
            : {
                data: true,
                size: true,
                shouldRestorePosition: (row) =>
                  disclosures.shouldRestorePosition(String(row.offset)),
              }
        }
        recycleItems={false}
        className="h-full min-h-0 overflow-x-hidden overscroll-y-contain [overflow-anchor:none]"
        role="list"
        aria-label="Saved conversation messages"
        ListHeaderComponent={
          <div className="mx-auto max-w-3xl">
            <div className="flex justify-end px-4 pt-1 text-xs text-muted-foreground">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Copy loaded saved messages"
                disabled={!transcript.messages.length}
                onClick={() =>
                  void writeTextToClipboard(
                    savedTranscriptText(transcript, agentLabel),
                    "saved messages",
                  ).then(
                    () => setCopyNotice("Loaded saved messages copied."),
                    () => setCopyNotice("Could not copy saved messages."),
                  )
                }
              >
                <CopyIcon />
              </Button>
            </div>
            {copyNotice ? (
              <p role="status" className="px-6 text-xs text-muted-foreground">
                {copyNotice}
              </p>
            ) : null}
            {!transcript.exhausted ? (
              <div className="flex justify-center py-3">
                <Button
                  variant="ghost-muted"
                  size="sm"
                  disabled={pending || transcript.nextBefore === undefined}
                  onClick={() => void loadOlder()}
                >
                  {pending ? "Loading saved messages..." : "Load older saved messages"}
                </Button>
              </div>
            ) : null}
            {error ? (
              <div className="flex items-center gap-2 px-6 py-3 text-xs text-warning-foreground">
                <p role="status">{error}</p>
                <Button variant="ghost-muted" size="xs" onClick={onRefresh}>
                  Refresh saved messages
                </Button>
              </div>
            ) : null}
          </div>
        }
        renderItem={({ item: { offset, message, view, parts }, index }) => (
          <article
            role="listitem"
            aria-posinset={index + 1}
            aria-setsize={rows.length}
            data-agent-transcript-offset={offset}
            tabIndex={-1}
            className={`mx-auto max-w-3xl px-5 py-4 ${offset === selectedOffset ? "rounded-lg bg-primary/5 ring-1 ring-inset ring-primary/30" : ""}`}
          >
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <h3 className="min-w-0 truncate font-medium text-foreground">{view.label}</h3>
              {view.timestamp ? (
                <time className="ml-auto shrink-0 text-2xs" dateTime={view.timestamp}>
                  {new Date(view.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              ) : null}
            </div>
            {raw ? (
              <pre className="overflow-auto whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(message, null, 2)}
              </pre>
            ) : (
              <div
                className={view.user ? "space-y-3 rounded-xl bg-muted/60 p-4" : "space-y-3 text-sm"}
              >
                {parts.map(({ id, part }) => (
                  <NativeTranscriptPart
                    key={id}
                    part={part}
                    scope={scope}
                    cwd={cwd}
                    id={id}
                    rowId={String(offset)}
                    disclosures={disclosures}
                    skills={skills}
                  />
                ))}
              </div>
            )}
          </article>
        )}
        ListFooterComponent={<div className="h-6" />}
        ListEmptyComponent={
          <p className="px-6 py-12 text-center text-sm text-muted-foreground">
            No saved conversation messages are available for this session.
          </p>
        }
      />
    </div>
  );
}

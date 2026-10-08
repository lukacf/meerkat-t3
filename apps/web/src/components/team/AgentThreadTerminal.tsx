import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import ThreadTerminalDrawer from "../ThreadTerminalDrawer";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { useKnownTerminalSessions } from "../../state/terminalSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { terminalEnvironment } from "../../state/terminal";
import { useConversationPaneActive } from "./ConversationPaneContext";
import { type TerminalContextSelection } from "../../lib/terminalContext";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Reuse the coordinator's shell and controls for every worker in the same worktree. */
export function AgentThreadTerminal({
  threadRef,
  cwd,
  projectRoot,
  worktreePath,
  keybindings,
  onAddTerminalContext,
}: {
  threadRef: ScopedThreadRef;
  cwd: string;
  projectRoot: string;
  worktreePath: string | null;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}) {
  const state = useTerminalUiStateStore((store) =>
    selectThreadTerminalUiState(store.terminalUiStateByThreadKey, threadRef),
  );
  const sessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  });
  const open = useAtomCommand(terminalEnvironment.open, "terminal open");
  const close = useAtomCommand(terminalEnvironment.close, "terminal close");
  const [focus, setFocus] = useState(0);
  const initializedTarget = useRef<string | null>(null);
  const paneActive = useConversationPaneActive();
  const runtimeEnv = useMemo(
    () => projectScriptRuntimeEnv({ project: { cwd: projectRoot }, worktreePath }),
    [projectRoot, worktreePath],
  );
  useEffect(() => {
    const store = useTerminalUiStateStore.getState();
    const current = selectThreadTerminalUiState(store.terminalUiStateByThreadKey, threadRef);
    const ids = [
      ...new Set([...current.terminalIds, ...sessions.map((session) => session.target.terminalId)]),
    ];
    const key = `${threadRef.environmentId}:${threadRef.threadId}`;
    if (ids.length === 0 && initializedTarget.current !== key)
      store.ensureTerminal(threadRef, "term-1");
    else if (ids.length !== current.terminalIds.length) store.reconcileTerminalIds(threadRef, ids);
    initializedTarget.current = key;
  }, [threadRef, sessions]);
  const create = useCallback(
    (kind: "new" | "split" | "vertical") => {
      const store = useTerminalUiStateStore.getState();
      const current = selectThreadTerminalUiState(store.terminalUiStateByThreadKey, threadRef);
      const terminalId = nextTerminalId([
        ...current.terminalIds,
        ...sessions.map((session) => session.target.terminalId),
      ]);
      const add =
        kind === "new"
          ? store.newTerminal
          : kind === "split"
            ? store.splitTerminal
            : store.splitTerminalVertical;
      add(threadRef, terminalId);
      setFocus((value) => value + 1);
      void open({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, terminalId, cwd, worktreePath, env: runtimeEnv },
      });
    },
    [cwd, open, runtimeEnv, sessions, threadRef, worktreePath],
  );
  const labels = useMemo(
    () =>
      new Map(
        sessions.map((session) => [
          session.target.terminalId,
          session.state.summary?.label ?? session.target.terminalId,
        ]),
      ),
    [sessions],
  );
  const activeSummary = sessions.find(
    (session) => session.target.terminalId === state.activeTerminalId,
  )?.state.summary;
  const terminalLaunchLocationsById = useMemo(() => {
    const locations = new Map<
      string,
      { cwd: string; worktreePath: string | null; runtimeEnv: Record<string, string> }
    >();
    for (const session of sessions) {
      const summary = session.state.summary;
      if (!summary) continue;
      locations.set(session.target.terminalId, {
        cwd: summary.cwd,
        worktreePath: summary.worktreePath,
        runtimeEnv: projectScriptRuntimeEnv({
          project: { cwd: projectRoot },
          worktreePath: summary.worktreePath,
        }),
      });
    }
    return locations;
  }, [projectRoot, sessions]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Tooltip>
        <TooltipTrigger
          render={
            <div className="truncate border-b border-border px-3 py-1 text-xs text-muted-foreground" />
          }
        >
          Shell opened in {activeSummary?.cwd ?? cwd}
        </TooltipTrigger>
        <TooltipPopup>{activeSummary?.cwd ?? cwd}</TooltipPopup>
      </Tooltip>
      <ThreadTerminalDrawer
        mode="panel"
        mayAutoFocus={paneActive}
        threadRef={threadRef}
        threadId={threadRef.threadId}
        cwd={cwd}
        worktreePath={worktreePath}
        runtimeEnv={runtimeEnv}
        height={state.terminalHeight}
        terminalIds={state.terminalIds}
        activeTerminalId={state.activeTerminalId}
        terminalGroups={state.terminalGroups}
        activeTerminalGroupId={state.activeTerminalGroupId}
        focusRequestId={focus}
        onNewTerminal={() => create("new")}
        onSplitTerminal={() => create("split")}
        onSplitTerminalVertical={() => create("vertical")}
        onActiveTerminalChange={(id) => {
          useTerminalUiStateStore.getState().setActiveTerminal(threadRef, id);
          setFocus((value) => value + 1);
        }}
        onCloseTerminal={(terminalId) => {
          void close({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, terminalId, deleteHistory: true },
          }).then((result) => {
            if (result._tag === "Success")
              useTerminalUiStateStore.getState().closeTerminal(threadRef, terminalId);
          });
        }}
        onTerminalClosed={(terminalId) =>
          useTerminalUiStateStore.getState().closeTerminal(threadRef, terminalId)
        }
        onHeightChange={(height) =>
          useTerminalUiStateStore.getState().setTerminalHeight(threadRef, height)
        }
        keybindings={keybindings}
        onAddTerminalContext={onAddTerminalContext}
        terminalLabelsById={labels}
        terminalLaunchLocationsById={terminalLaunchLocationsById}
        nativeWorkspace={{ cwd, worktreePath }}
      />
    </div>
  );
}

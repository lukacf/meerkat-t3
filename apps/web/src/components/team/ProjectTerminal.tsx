import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  createProjectTerminalAtoms,
  readTerminalOutputUpdate,
  INITIAL_TERMINAL_OUTPUT_CURSOR,
} from "@t3tools/client-runtime/state/projectTerminal";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery, formatEnvironmentQueryError } from "../../state/query";
import { GhosttyTerminalSurface } from "../../terminal/ghostty/surface";
import {
  terminalThemeFromApp,
  writeTerminalOutputUpdate,
  terminalSelectionLineRange,
} from "../ThreadTerminalDrawer";
import { Button } from "../ui/button";
import { useConversationPaneActive } from "./ConversationPaneContext";
import { randomUUID } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import type { TerminalContextSelection } from "../../lib/terminalContext";
import { useClientSettings } from "../../hooks/useSettings";

const terminals = createProjectTerminalAtoms(connectionAtomRuntime);
export function ProjectTerminal({
  environmentId,
  projectId,
  initialTerminalId,
  onRestarted,
  onAddTerminalContext,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  initialTerminalId?: string | undefined;
  onRestarted?: (previousTerminalId: string, terminalId: string) => void;
  onAddTerminalContext?: (selection: TerminalContextSelection) => void;
}) {
  const storageKey = `project-terminal:${environmentId}:${projectId}`;
  const [terminalId, setTerminalId] = useState(() => {
    try {
      if (initialTerminalId) sessionStorage.setItem(storageKey, initialTerminalId);
      return initialTerminalId ?? sessionStorage.getItem(storageKey) ?? "project-shell-1";
    } catch {
      return initialTerminalId ?? "project-shell-1";
    }
  });
  const query = useEnvironmentQuery(
    terminals.attach({ environmentId, input: { projectId, terminalId } }),
  );
  const write = useAtomCommand(terminals.write, { reportFailure: false });
  const resize = useAtomCommand(terminals.resize, { reportFailure: false });
  const clear = useAtomCommand(terminals.clear, { reportFailure: false });
  const close = useAtomCommand(terminals.close, { reportFailure: false });
  const mount = useRef<HTMLDivElement>(null);
  const surface = useRef<GhosttyTerminalSurface | null>(null);
  const cursor = useRef(INITIAL_TERMINAL_OUTPUT_CURSOR);
  const [ready, setReady] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const restartInFlight = useRef(false);
  const [restarting, setRestarting] = useState(false);
  const paneActive = useConversationPaneActive();
  const font = useClientSettings((settings) => settings.fontFamilyCode);
  const send = useEffectEvent(async (attachedTerminalId: string, data: string) => {
    const result = await write({
      environmentId,
      input: { projectId, terminalId: attachedTerminalId, data },
    });
    if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
  });
  const fit = useEffectEvent(async (attachedTerminalId: string, cols: number, rows: number) => {
    const result = await resize({
      environmentId,
      input: { projectId, terminalId: attachedTerminalId, cols, rows },
    });
    if (result._tag === "Failure" && query.data?.status === "running")
      setError(formatEnvironmentQueryError(result.cause));
  });
  const mayFocus = useEffectEvent(() => paneActive());
  useEffect(() => {
    if (!mount.current) return;
    let cancelled = false;
    const container = mount.current;
    const observer = new MutationObserver(() =>
      surface.current?.setTheme(terminalThemeFromApp(container)),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    void GhosttyTerminalSurface.create(container, {
      theme: terminalThemeFromApp(container),
      font: { family: font, size: 12 },
      visible: true,
      onData: (data) => void send(terminalId, data),
      onResize: (cols, rows) => void fit(terminalId, cols, rows),
      onSelectionChange: () => {},
      beforeKey: () => true,
      onLinkActivate: (url) => {
        if (/^https?:\/\//.test(url)) void readLocalApi()?.shell.openExternal(url);
      },
    }).then(
      (terminal) => {
        if (cancelled) {
          terminal.dispose();
          return;
        }
        surface.current = terminal;
        cursor.current = INITIAL_TERMINAL_OUTPUT_CURSOR;
        setReady((value) => value + 1);
        if (mayFocus()) terminal.focus();
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
      observer.disconnect();
      surface.current?.dispose();
      surface.current = null;
    };
  }, [terminalId, font]);
  useEffect(() => {
    if (!ready || !query.data || !surface.current) return;
    const update = readTerminalOutputUpdate(query.data.output, cursor.current);
    cursor.current = update.cursor;
    if (update.type !== "none") writeTerminalOutputUpdate(surface.current, update);
  }, [query.data, ready]);
  async function restart() {
    if (restartInFlight.current) return;
    restartInFlight.current = true;
    setRestarting(true);
    try {
      const result = await close({ environmentId, input: { projectId, terminalId } });
      if (result._tag === "Failure") {
        setError(formatEnvironmentQueryError(result.cause));
        return;
      }
      const next = `project-shell-${randomUUID()}`;
      try {
        const selected = sessionStorage.getItem(storageKey);
        if (selected === null || selected === terminalId) sessionStorage.setItem(storageKey, next);
      } catch {
        /* This session remains usable. */
      }
      setTerminalId(next);
      // The panel may have closed while the request was pending. Retain its new selection above it.
      onRestarted?.(terminalId, next);
      setError(null);
    } finally {
      restartInFlight.current = false;
      setRestarting(false);
    }
  }
  async function clearHistory() {
    const result = await clear({ environmentId, input: { projectId, terminalId } });
    if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
    else setError(null);
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-terminal-owner="right-panel">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {query.data?.cwd ?? "Project root"} - {query.data?.label ?? "Project terminal"} -{" "}
          {query.data?.status ?? "connecting"}
        </span>
        <Button size="xs" variant="ghost" onClick={() => void clearHistory()}>
          Clear
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void navigator.clipboard.writeText(surface.current?.getSelection() ?? "")}
        >
          Copy selection
        </Button>
        {onAddTerminalContext ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              const text = surface.current?.getSelection();
              const position = surface.current?.getSelectionPosition();
              if (!text || !position) {
                setError("Select terminal output to add it to the conversation.");
                return;
              }
              onAddTerminalContext({
                terminalId,
                terminalLabel: query.data?.label ?? "Project terminal",
                ...terminalSelectionLineRange(position),
                text,
              });
              setError(null);
            }}
          >
            Add selection to draft
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" disabled={restarting} onClick={() => void restart()}>
          Restart
        </Button>
      </div>
      {query.error || query.data?.error || error ? (
        <p role="status" className="p-2 text-xs text-destructive">
          {query.error ?? query.data?.error ?? error}
        </p>
      ) : null}
      <div ref={mount} className="min-h-0 flex-1 overflow-hidden" aria-label="Project terminal" />
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  HistoryIcon,
  RefreshCwIcon,
  Undo2Icon,
  ChevronLeftIcon,
  ChevronDownIcon,
} from "lucide-react";
import { FileDiff, type FileDiffProps } from "@pierre/diffs/react";
import { parseDiffFromFile } from "@pierre/diffs";
import type {
  MeerkatWorkspaceCheckpoint,
  MeerkatCheckpointPreview,
  MeerkatCheckpointRestoreResult,
} from "@t3tools/contracts";
import { useTheme } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";

/** The caller binds these methods to the server-resolved native conversation target. */
export interface NativeWorkspaceCheckpointApi {
  capture(): Promise<MeerkatWorkspaceCheckpoint>;
  list(): Promise<{ readonly checkpoints: ReadonlyArray<MeerkatWorkspaceCheckpoint> }>;
  preview(checkpointId: string): Promise<MeerkatCheckpointPreview>;
  restore(
    checkpoint: MeerkatWorkspaceCheckpoint,
    files: ReadonlyArray<{ path: string; expectedCurrent: string }>,
  ): Promise<MeerkatCheckpointRestoreResult>;
}
const timestamp = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** File-only recovery. Keeps native conversation and current Git staging intact. */
interface CheckpointProps {
  api: NativeWorkspaceCheckpointApi;
  targetKey: string;
  onRestored?: () => void;
  offerCapture?: boolean;
}

export function NativeWorkspaceCheckpoints(props: CheckpointProps) {
  return <CheckpointDialog key={props.targetKey} {...props} />;
}

function CheckpointDialog({ api, onRestored, offerCapture }: CheckpointProps) {
  const { resolvedTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [checkpoints, setCheckpoints] = useState<ReadonlyArray<MeerkatWorkspaceCheckpoint>>([]);
  const [preview, setPreview] = useState<MeerkatCheckpointPreview | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<"list" | "preview" | "restore" | "capture" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MeerkatCheckpointRestoreResult | null>(null);
  const generation = useRef(0);
  const load = useCallback(
    async (checkpointId?: string) => {
      const request = ++generation.current;
      setBusy(checkpointId ? "preview" : "list");
      setError(null);
      setResult(null);
      setSelected(new Set());
      setExpanded(null);
      try {
        if (checkpointId) {
          const response = await api.preview(checkpointId);
          if (request === generation.current) setPreview(response);
        } else {
          const response = await api.list();
          if (request === generation.current) {
            setCheckpoints(response.checkpoints);
            setPreview(null);
          }
        }
      } catch (cause) {
        if (request === generation.current) setError(message(cause));
      } finally {
        if (request === generation.current) setBusy(null);
      }
    },
    [api],
  );
  useEffect(
    () => () => {
      ++generation.current;
    },
    [],
  );
  const capture = async () => {
    if (busy) return;
    const request = ++generation.current;
    setBusy("capture");
    setError(null);
    try {
      await api.capture();
      const response = await api.list();
      if (request === generation.current) setCheckpoints(response.checkpoints);
    } catch (cause) {
      if (request === generation.current) setError(message(cause));
    } finally {
      if (request === generation.current) setBusy(null);
    }
  };
  const restore = async () => {
    if (!preview || busy || selected.size === 0) return;
    const request = ++generation.current;
    setBusy("restore");
    setError(null);
    setResult(null);
    try {
      const response = await api.restore(
        preview.checkpoint,
        preview.files
          .filter((file) => selected.has(file.path))
          .map(({ path, expectedCurrent }) => ({ path, expectedCurrent })),
      );
      if (request === generation.current) {
        setResult(response);
        setSelected(new Set());
        if (response.restored.length) onRestored?.();
        const refreshed = await api.preview(preview.checkpoint.id);
        if (request === generation.current) setPreview(refreshed);
      }
    } catch (cause) {
      if (request === generation.current) setError(message(cause));
    } finally {
      if (request === generation.current) setBusy(null);
    }
  };
  const file = preview?.files.find((item) => item.path === expanded);
  const diff = useMemo(
    () =>
      file && file.before !== null
        ? parseDiffFromFile(
            { name: file.path, contents: file.current ?? "" },
            { name: file.path, contents: file.before },
          )
        : null,
    [file],
  );
  const diffOptions = useMemo<NonNullable<FileDiffProps<undefined>["options"]>>(
    () => ({ diffStyle: "unified", theme: resolveDiffThemeName(resolvedTheme), overflow: "wrap" }),
    [resolvedTheme],
  );
  return (
    <>
      {offerCapture ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Before asking for edits, save a recovery snapshot. Capture is manual.</span>
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!!busy}
            onClick={() => {
              setOpen(true);
              setPreview(null);
              void capture();
            }}
          >
            Save recovery snapshot
          </Button>
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => {
              setOpen(true);
              void load();
            }}
          >
            History
          </Button>
        </div>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Workspace checkpoints"
                onClick={() => {
                  setOpen(true);
                  void load();
                }}
              />
            }
          >
            <HistoryIcon className="size-4" />
          </TooltipTrigger>
          <TooltipPopup>Manual recovery snapshots. Save before asking for edits.</TooltipPopup>
        </Tooltip>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (busy !== "restore") setOpen(value);
        }}
      >
        <DialogPopup className="flex w-[min(92vw,900px)] max-w-[900px] flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {preview ? "Restore selected files" : "Workspace checkpoints"}
            </DialogTitle>
            <DialogDescription>
              {preview
                ? "Review the exact file changes below. Restore changes files only; your conversation and Git staging stay intact."
                : "Save a workspace snapshot before making changes, then review and restore selected files."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pb-5">
            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              {preview ? (
                <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void load()}>
                  <ChevronLeftIcon className="size-3.5" /> All checkpoints
                </Button>
              ) : (
                <span>Shared workspace snapshots</span>
              )}
              {!preview ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!!busy}
                  onClick={() => void capture()}
                >
                  Save snapshot
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                disabled={!!busy}
                onClick={() => void load(preview?.checkpoint.id)}
              >
                <RefreshCwIcon className="size-3.5" /> Refresh
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Other agents or your own edits may be included when they share this workspace.
            </p>
            {error && (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </p>
            )}
            {busy && (
              <p role="status" className="text-sm text-muted-foreground">
                {busy === "restore"
                  ? "Restoring selected files..."
                  : busy === "capture"
                    ? "Saving workspace snapshot..."
                    : "Loading workspace snapshots..."}
              </p>
            )}
            {result && (
              <div role="status" className="rounded-md border bg-muted/30 p-3 text-sm">
                <p>
                  {result.restored.length
                    ? `Restored ${result.restored.length} ${result.restored.length === 1 ? "file" : "files"}.`
                    : "No files were restored."}
                </p>
                {result.conflicts.map((conflict) => (
                  <p key={conflict.path} className="mt-1 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{conflict.path}:</span>{" "}
                    {conflict.reason}
                  </p>
                ))}
              </div>
            )}
            {!preview && !busy && checkpoints.length === 0 && (
              <div className="rounded-lg border border-dashed p-8 text-center">
                <HistoryIcon className="mx-auto mb-3 size-6 text-muted-foreground" />
                <p className="text-sm font-medium">No workspace checkpoints yet</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Save a snapshot to keep a recovery point for this checkout. Automatic capture is
                  not available yet.
                </p>
              </div>
            )}
            {!preview &&
              checkpoints.map((checkpoint) => (
                <div
                  key={checkpoint.id}
                  className="flex items-center gap-3 rounded-lg border px-3 py-3"
                >
                  <HistoryIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {timestamp(checkpoint.startedAt)}
                      {checkpoint.source === "manual" ? " - Saved snapshot" : ""}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{checkpoint.workspace}</p>
                    {checkpoint.detail && (
                      <p className="mt-1 text-xs text-muted-foreground">{checkpoint.detail}</p>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {checkpoint.status === "active"
                      ? "In progress"
                      : checkpoint.status === "partial"
                        ? "Partial"
                        : checkpoint.status === "unavailable"
                          ? "Unavailable"
                          : "Complete"}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      !!busy ||
                      checkpoint.status === "active" ||
                      checkpoint.status === "unavailable"
                    }
                    onClick={() => void load(checkpoint.id)}
                  >
                    Review
                  </Button>
                </div>
              ))}
            {preview && (
              <>
                <div className="rounded-lg bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
                  <p>
                    {timestamp(preview.checkpoint.startedAt)}
                    {preview.checkpoint.completedAt
                      ? ` to ${timestamp(preview.checkpoint.completedAt)}`
                      : ""}
                  </p>
                  <p className="mt-1 truncate">{preview.checkpoint.workspace}</p>
                </div>
                {preview.files.length === 0 && (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    No file changes to review against this snapshot.
                  </p>
                )}
                {preview.files.map((item) => (
                  <div key={item.path} className="overflow-hidden rounded-lg border">
                    <div className="flex items-start gap-3 px-3 py-3">
                      <Checkbox
                        aria-label={`Restore ${item.path}`}
                        checked={selected.has(item.path)}
                        disabled={!!busy || !item.restorable}
                        onCheckedChange={(checked) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (checked) next.add(item.path);
                            else next.delete(item.path);
                            return next;
                          })
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <p className="break-all font-mono text-xs">{item.path}</p>
                        {item.reason && (
                          <p className="mt-1 text-xs text-muted-foreground">{item.reason}</p>
                        )}
                      </div>
                      {item.before !== null && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-expanded={expanded === item.path}
                          disabled={!!busy}
                          onClick={() =>
                            setExpanded((value) => (value === item.path ? null : item.path))
                          }
                        >
                          <ChevronDownIcon className="size-3.5" /> Preview
                        </Button>
                      )}
                    </div>
                    {expanded === item.path && diff && (
                      <div
                        className="max-h-72 overflow-auto border-t text-xs"
                        aria-label={`Restore preview for ${item.path}`}
                      >
                        <FileDiff fileDiff={diff} options={diffOptions} />
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="ghost" disabled={busy === "restore"} onClick={() => setOpen(false)}>
              Close
            </Button>
            {preview && (
              <Button disabled={!!busy || selected.size === 0} onClick={() => void restore()}>
                <Undo2Icon className="size-3.5" /> Restore {selected.size || "selected"}{" "}
                {selected.size === 1 ? "file" : "files"}
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

import type { SharedCheckoutPatch } from "@t3tools/contracts";
import { useId, useState } from "react";
import type { useSharedSnapshot } from "./useSharedSnapshot";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type Props = {
  state: ReturnType<typeof useSharedSnapshot>;
  destination: string;
  maxBytes: number;
  disabled?: boolean;
};

export function SharedSnapshotPanel({ state, destination, maxBytes, disabled = false }: Props) {
  const preview = state.preview;
  const blocking = preview?.excluded.filter((item) => item.reason !== "ignored") ?? [];
  const canShare =
    preview?.status === "ready" &&
    !preview.filesTruncated &&
    !preview.excludedTruncated &&
    blocking.length === 0 &&
    preview.bytes <= maxBytes;
  if (preview && state.snapshot)
    return (
      <SharedSnapshotSummary
        key={state.snapshot.snapshotId}
        state={state}
        preview={preview}
        destination={destination}
        disabled={disabled}
      />
    );
  return (
    <div className="min-w-0 space-y-2 rounded-lg border border-border p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">Workspace snapshot</p>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={disabled || state.busy}
          onClick={() => void state.previewChanges()}
        >
          {state.busy ? "Checking..." : preview ? "Refresh preview" : "Preview snapshot"}
        </Button>
      </div>
      <p className="text-muted-foreground">
        Preview locally first. Nothing is uploaded until you choose Share snapshot.
      </p>
      {preview ? (
        <>
          <p className="wrap-anywhere text-muted-foreground">
            {preview.branch ?? "Detached checkout"} at {preview.commit.slice(0, 12)} -{" "}
            {preview.bytes.toLocaleString()} bytes
          </p>
          <SnapshotContents preview={preview} />
          <p className="text-muted-foreground">
            Tracked changes only. Ignored files are never included. Stage new files first to include
            them.
          </p>
          {blocking.length ? (
            <div role="alert" className="space-y-1 text-destructive">
              <p>Resolve these excluded changes before sharing:</p>
              <ul className="max-h-24 overflow-y-auto">
                {blocking.map((file) => (
                  <li key={file.path} className="wrap-anywhere">
                    {file.path}: {file.reason.replaceAll("_", " ")}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {preview.bytes > maxBytes ? (
            <p role="alert" className="text-destructive">
              This workspace accepts snapshots up to {maxBytes.toLocaleString()} bytes.
            </p>
          ) : null}
          {preview.filesTruncated || preview.excludedTruncated ? (
            <p role="alert" className="text-destructive">
              The change list exceeds the preview limit. Reduce the change set before sharing.
            </p>
          ) : null}
          {preview.status === "clean" ? (
            <p className="text-muted-foreground">No uncommitted tracked changes to share.</p>
          ) : null}
          {canShare ? (
            <div className="space-y-2">
              <p className="text-muted-foreground">
                Share these file contents with {destination}. The workspace retains this snapshot as
                request evidence.
              </p>
              <Button
                type="button"
                size="xs"
                disabled={disabled || state.busy}
                onClick={() => void state.shareSnapshot()}
              >
                Share snapshot
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-destructive">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

function SharedSnapshotSummary({
  state,
  preview,
  destination,
  disabled,
}: Omit<Props, "maxBytes"> & { preview: SharedCheckoutPatch }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  return (
    <div className="min-w-0 rounded-lg border border-border p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p role="status" className="font-medium">
            Snapshot shared
          </p>
          <Tooltip>
            <TooltipTrigger render={<p className="truncate text-muted-foreground" />}>
              {preview.files.length} {preview.files.length === 1 ? "file" : "files"} -{" "}
              {preview.bytes.toLocaleString()} bytes - {destination}
            </TooltipTrigger>
            <TooltipPopup>Shared with {destination}</TooltipPopup>
          </Tooltip>
        </div>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Hide snapshot" : "View shared snapshot"}
        </Button>
      </div>
      {expanded ? (
        <div id={detailsId} className="mt-3 space-y-2 border-t border-border pt-3">
          <p className="wrap-anywhere text-muted-foreground">
            {preview.branch} at {preview.commit.slice(0, 12)}
          </p>
          <SnapshotContents preview={preview} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground">Later edits need a new preview.</p>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={disabled || state.busy}
              onClick={() => void state.previewChanges()}
            >
              {state.busy ? "Checking..." : "Refresh preview"}
            </Button>
          </div>
        </div>
      ) : null}
      {state.error ? (
        <p role="alert" className="mt-2 text-destructive">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

function SnapshotContents({ preview }: { preview: SharedCheckoutPatch }) {
  return (
    <>
      {preview.files.length ? (
        <ul
          className="max-h-32 space-y-1 overflow-y-auto rounded-md bg-muted/40 p-2"
          aria-label="Snapshot files"
        >
          {preview.files.map((file) => (
            <li key={file.path} className="flex gap-2">
              <span className="min-w-0 flex-1 wrap-anywhere font-mono">{file.path}</span>
              <span className="shrink-0 text-muted-foreground">
                {file.change.replaceAll("_", " ")}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {preview.patch ? (
        <details>
          <summary className="cursor-pointer text-muted-foreground">Review patch</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre rounded-md bg-muted/40 p-2 text-2xs">
            {preview.patch}
          </pre>
        </details>
      ) : null}
    </>
  );
}

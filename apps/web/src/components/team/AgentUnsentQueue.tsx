import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  KnownComposerContextRecord,
  type EnvironmentId,
  type MeerkatAgentQueue,
  type MeerkatAgentQueueItem,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  previewAnnotationFromRecord,
  reviewCommentFromRecord,
} from "../../lib/composerContextRecords";
import type {
  ComposerDraftContextRecords,
  ComposerDraftContextRecord,
} from "../composerContextPresentation";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import type { ReactNode } from "react";
import { Button } from "../ui/button";
import { ContextChip } from "../ContextChip";
import { SkillInlineText } from "../chat/SkillInlineText";
import { AgentComposerEditor } from "./AgentComposerEditor";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditor";

const isKnownRecord = Schema.is(KnownComposerContextRecord);
export function queuedComposerContext(item: MeerkatAgentQueueItem): ComposerDraftContextRecords {
  const records = new Map<string, ComposerDraftContextRecord>();
  for (const record of item.payload.context?.records ?? []) {
    if (!isKnownRecord(record)) continue;
    if (record.kind === "terminal")
      records.set(record.contextId, {
        kind: "terminal",
        record: {
          id: record.contextId,
          createdAt: item.createdAt,
          terminalId: record.terminalId,
          terminalLabel: record.terminalLabel,
          lineStart: record.lineStart,
          lineEnd: record.lineEnd,
          text: record.text,
        },
      });
    else if (record.kind === "review-comment")
      records.set(record.contextId, {
        kind: "review-comment",
        record: reviewCommentFromRecord(record),
      });
    else if (record.kind === "preview-annotation")
      records.set(record.contextId, {
        kind: "preview-annotation",
        record: previewAnnotationFromRecord(record),
      });
  }
  return records;
}
function QueuedText({
  item,
  skills,
}: {
  item: MeerkatAgentQueueItem;
  skills: ReadonlyArray<ServerProviderSkill>;
}) {
  const fragments: ReactNode[] = [];
  let cursor = 0;
  for (const occurrence of collectComposerContextReferences(item.payload.text)) {
    fragments.push(
      <SkillInlineText
        key={`text:${cursor}`}
        text={item.payload.text.slice(cursor, occurrence.start)}
        skills={skills}
      />,
    );
    fragments.push(
      <ContextChip key={`${occurrence.start}:${occurrence.contextId}`} kind="neutral">
        {occurrence.label}
      </ContextChip>,
    );
    cursor = occurrence.end;
  }
  fragments.push(
    <SkillInlineText key="tail" text={item.payload.text.slice(cursor)} skills={skills} />,
  );
  return (
    <p className="line-clamp-3 whitespace-pre-wrap text-xs">
      {fragments.length ? fragments : "Image message"}
    </p>
  );
}
function QueueEditor({
  item,
  environmentId,
  cwd,
  skills,
  disabled,
  saveDisabled,
  recoveryMessage,
  onSave,
  onCancel,
}: {
  item: MeerkatAgentQueueItem;
  environmentId: EnvironmentId;
  cwd: string | undefined;
  skills: ReadonlyArray<ServerProviderSkill>;
  disabled: boolean;
  saveDisabled: boolean;
  recoveryMessage: string | null;
  onSave: (text: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(item.payload.text);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const saveInFlight = useRef(false);
  const latest = useRef({ text, saveDisabled });
  useLayoutEffect(() => {
    latest.current = { text, saveDisabled };
  }, [text, saveDisabled]);
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  useEffect(() => {
    editorRef.current?.focusAtEnd();
  }, []);
  async function save() {
    if (
      saveInFlight.current ||
      latest.current.saveDisabled ||
      (!text.trim() && !item.payload.images?.length)
    )
      return;
    const submitted = text;
    saveInFlight.current = true;
    setSaving(true);
    setNotice(null);
    try {
      const saved = await onSave(submitted);
      if (saved && !latest.current.saveDisabled && latest.current.text === submitted) onCancel();
      else
        setNotice(
          saved
            ? "Changes were saved. Your current edit is still available."
            : "Changes could not be saved. Your edit is still available.",
        );
    } catch {
      setNotice("Changes could not be saved. Your edit is still available.");
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }
  async function copy() {
    try {
      const copied = await writeTextToClipboard(text, "edited message");
      setNotice(copied ? "Edited text copied." : "There is no text to copy.");
    } catch {
      setNotice("Could not copy the text. Your edit is still here; select and copy it manually.");
    }
  }
  return (
    <div className="space-y-2">
      {recoveryMessage ? (
        <p role="status" className="text-xs text-muted-foreground">
          {recoveryMessage} Your edit is still here. Copy the text to keep working with it.
        </p>
      ) : null}
      <AgentComposerEditor
        editorRef={editorRef}
        value={text}
        environmentId={environmentId}
        cwd={cwd}
        contextRecords={queuedComposerContext(item)}
        skills={skills}
        disabled={disabled || saving}
        ariaLabel="Edit queued message"
        placeholder="Edit queued message"
        className="min-h-16 max-h-40 text-sm"
        onChange={(value) => {
          setText(value);
          setNotice(null);
        }}
        onPaste={() => {}}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="xs"
          disabled={saveDisabled || saving || (!text.trim() && !item.payload.images?.length)}
          onClick={() => void save()}
        >
          Save
        </Button>
        <Button type="button" size="xs" variant="outline" onClick={() => void copy()}>
          Copy edited text
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          {recoveryMessage ? "Discard edit" : "Cancel"}
        </Button>
      </div>
      {notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
export function AgentUnsentQueue({
  queue,
  environmentId,
  cwd,
  skills,
  disabled,
  loading,
  error,
  onRefresh,
  onEdit,
  onMove,
  onCancel,
  onRetry,
}: {
  queue: MeerkatAgentQueue | undefined;
  environmentId: EnvironmentId;
  cwd: string | undefined;
  skills: ReadonlyArray<ServerProviderSkill>;
  disabled: boolean;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onEdit: (item: MeerkatAgentQueueItem, text: string) => Promise<boolean>;
  onMove: (item: MeerkatAgentQueueItem, direction: "up" | "down") => void;
  onCancel: (item: MeerkatAgentQueueItem) => void;
  onRetry: (item: MeerkatAgentQueueItem) => void;
}) {
  const [editing, setEditing] = useState<{ item: MeerkatAgentQueueItem } | null>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const restoreFocusTo = useRef<string | null>(null);
  const [retainedQueue, setRetainedQueue] = useState(queue);
  useEffect(() => {
    if (queue) setRetainedQueue(queue);
  }, [queue]);
  const observedQueue = queue ?? retainedQueue;
  const queuedRows =
    observedQueue?.items.filter((row) => !["completed", "cancelled"].includes(row.status)) ?? [];
  const rows =
    editing && !queuedRows.some((row) => row.id === editing.item.id)
      ? [
          ...queuedRows,
          observedQueue?.items.find((row) => row.id === editing.item.id) ?? editing.item,
        ]
      : queuedRows;
  const readOnly = disabled || loading || Boolean(error) || !queue;
  useEffect(() => {
    if (editing !== null || readOnly || restoreFocusTo.current === null) return;
    editButtons.current.get(restoreFocusTo.current)?.focus();
    restoreFocusTo.current = null;
  }, [editing, readOnly]);
  if (!rows.length && !loading && !error) return null;
  const editable = queuedRows.filter((row) => ["queued", "failed"].includes(row.status));
  return (
    <div
      className="mx-auto mb-2 max-w-3xl rounded-xl border border-border bg-muted/20"
      aria-label="Queued messages"
    >
      {error ? (
        <div role="alert" className="space-y-2 px-3 py-2 text-xs">
          <p className="text-destructive">Could not refresh queued messages. {error}</p>
          <p className="text-muted-foreground">
            {rows.length
              ? "Showing the last known queue. Refresh before making changes."
              : "Saved messages may still be waiting to send."}
          </p>
          <Button size="xs" variant="outline" disabled={loading} onClick={onRefresh}>
            Retry queue
          </Button>
        </div>
      ) : loading ? (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          {rows.length ? "Refreshing queued messages..." : "Checking queued messages..."}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <details open>
          <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
            {queuedRows.length
              ? `${queuedRows.length} queued ${queuedRows.length === 1 ? "message" : "messages"}`
              : "Retained message edit"}
            {queuedRows.length ? (
              <span className="ml-2 text-muted-foreground/70">Saved to this environment</span>
            ) : null}
          </summary>
          {observedQueue?.waitingReason ? (
            <p className="px-3 pb-2 text-xs text-muted-foreground" role="status">
              {observedQueue.waitingReason}
            </p>
          ) : null}
          <ol className="max-h-56 space-y-2 overflow-auto px-2 pb-2">
            {rows.map((row) => {
              const canEdit = ["queued", "failed"].includes(row.status);
              const index = editable.findIndex((item) => item.id === row.id);
              const originalRequestId =
                editing?.item.id === row.id ? editing.item.requestId : row.requestId;
              const current = queue?.items.find(
                (item) => item.id === row.id && item.requestId === originalRequestId,
              );
              const currentEditable = current && ["queued", "failed"].includes(current.status);
              const recoveryMessage = !queue
                ? null
                : !current
                  ? "The original message is no longer in the queue."
                  : current.status === "dispatching"
                    ? "The original message is sending and can no longer be edited."
                    : current.status === "accepted"
                      ? "The original message was sent and can no longer be edited."
                      : current.status === "completed"
                        ? "The original message has completed."
                        : current.status === "cancelled"
                          ? "The original message was cancelled."
                          : current.status === "uncertain"
                            ? "Delivery of the original message is uncertain."
                            : null;
              return (
                <li key={row.id} className="rounded-md bg-muted/30 p-2">
                  {editing?.item.id === row.id ? (
                    <QueueEditor
                      item={editing.item}
                      environmentId={environmentId}
                      cwd={cwd}
                      skills={skills}
                      disabled={disabled || Boolean(error)}
                      saveDisabled={readOnly || !currentEditable}
                      recoveryMessage={recoveryMessage}
                      onSave={(text) =>
                        !readOnly && currentEditable
                          ? onEdit(current, text)
                          : Promise.resolve(false)
                      }
                      onCancel={() => {
                        restoreFocusTo.current = row.id;
                        setEditing((active) => (active === editing ? null : active));
                      }}
                    />
                  ) : (
                    <>
                      <QueuedText item={row} skills={skills} />
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>
                          {row.status === "accepted"
                            ? "Sent, waiting for completion"
                            : row.status === "dispatching"
                              ? "Sending"
                              : row.status === "uncertain"
                                ? "Delivery uncertain"
                                : row.status === "failed"
                                  ? "Needs attention"
                                  : "Waiting to send"}
                        </span>
                        {row.payload.images?.length ? (
                          <span>{row.payload.images.length} attached image(s)</span>
                        ) : null}
                        {row.payload.modelSelection ? (
                          <span>{row.payload.modelSelection.model}</span>
                        ) : null}
                      </div>
                      {row.error ? (
                        <p role="status" className="mt-1 text-xs text-warning-foreground">
                          {row.error}
                        </p>
                      ) : null}
                      <div className="mt-2 flex gap-1">
                        {row.status === "failed" || row.status === "uncertain" ? (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={readOnly}
                            onClick={() => onRetry(row)}
                          >
                            {row.status === "uncertain" ? "Check delivery" : "Retry"}
                          </Button>
                        ) : null}
                        {canEdit ? (
                          <>
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              disabled={readOnly || editing !== null}
                              aria-label="Edit queued message"
                              ref={(element) => {
                                if (element) editButtons.current.set(row.id, element);
                                else editButtons.current.delete(row.id);
                              }}
                              onClick={() => setEditing({ item: row })}
                            >
                              <PencilIcon />
                            </Button>
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              disabled={readOnly || index === 0}
                              aria-label="Move queued message up"
                              onClick={() => onMove(row, "up")}
                            >
                              <ArrowUpIcon />
                            </Button>
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              disabled={readOnly || index === editable.length - 1}
                              aria-label="Move queued message down"
                              onClick={() => onMove(row, "down")}
                            >
                              <ArrowDownIcon />
                            </Button>
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              disabled={readOnly}
                              aria-label="Delete unsent message"
                              onClick={() => onCancel(row)}
                            >
                              <Trash2Icon />
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

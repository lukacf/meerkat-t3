import { Button } from "../ui/button";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { EMPTY_AGENT_QUEUE, useAgentUnsentQueueStore } from "./agentUnsentQueueStore";

/** Keep the original enqueue request immutable until the environment acknowledges it. */
export function LegacyAgentUnsentQueue({
  targetKey,
  disabled,
  uncertainIds,
  onSend,
}: {
  targetKey: string;
  disabled: boolean;
  uncertainIds: ReadonlySet<string>;
  onSend: (id: string) => void;
}) {
  const rows = useAgentUnsentQueueStore((state) => state.byTarget[targetKey] ?? EMPTY_AGENT_QUEUE);
  if (!rows.length) return null;
  return (
    <div
      className="mx-auto mb-2 max-w-3xl rounded-xl border border-border bg-muted/20 p-3"
      aria-label="Messages awaiting confirmation"
    >
      <p className="mb-2 text-xs text-muted-foreground">Waiting for confirmation</p>
      <ol className="max-h-40 space-y-2 overflow-auto">
        {rows.map((row) => (
          <li key={row.id}>
            <p className="line-clamp-2 whitespace-pre-wrap text-xs">
              {replaceComposerContextReferences(row.text, (entry) => entry.label) ||
                "Image message"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {uncertainIds.has(row.id)
                ? "Earlier delivery is uncertain. This message has not been added to the new queue."
                : "This message is saved in this browser until the environment confirms it. Editing becomes available after confirmation."}
            </p>
            <div className="mt-2">
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => onSend(row.id)}
              >
                {uncertainIds.has(row.id) ? "Check earlier delivery" : "Retry confirmation"}
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

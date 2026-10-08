import { useState } from "react";
import { ArchiveIcon } from "lucide-react";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { meerkatTeamEnvironment } from "../../state/meerkatTeam";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
  DialogClose,
} from "../ui/dialog";
import type { AgentDraftScope } from "./agentDraftIdentity";
import { NativeAgentImages } from "./NativeAgentImages";
import {
  earlierAgentDeliveryInput,
  readEarlierAgentDrafts,
  readEarlierAgentSendAttempt,
  type EarlierAgentDraft,
  type EarlierDraftStorage,
} from "./earlierAgentDraftRecovery";

function browserStorage(): EarlierDraftStorage {
  const storages: EarlierDraftStorage = {};
  // A blocked storage getter is reported by the caller, without replacing any saved bytes.
  storages.local = globalThis.localStorage;
  storages.session = globalThis.sessionStorage;
  return storages;
}

function readSnapshot(scope: AgentDraftScope) {
  try {
    return readEarlierAgentDrafts(scope, browserStorage());
  } catch {
    return {
      entries: [],
      errors: [
        "Earlier saved drafts could not be read. Local storage is unavailable; no saved data was changed.",
      ],
    };
  }
}

export function EarlierAgentDrafts(scope: AgentDraftScope) {
  return <EarlierAgentDraftsContent key={JSON.stringify(scope)} scope={scope} />;
}

function EarlierAgentDraftsContent({ scope }: { scope: AgentDraftScope }) {
  const [snapshot, setSnapshot] = useState(() => readSnapshot(scope));
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});
  const reconcile = useAtomCommand(meerkatTeamEnvironment.agentDeliveryReconcile, {
    reportFailure: false,
  });
  const notice = (id: string, text: string) =>
    setNotices((current) => ({ ...current, [id]: text }));

  async function checkDelivery(entry: EarlierAgentDraft, requestId: string) {
    if (pending) return;
    const id = `${entry.id}:${requestId}`;
    setPending(id);
    try {
      const attempt = readEarlierAgentSendAttempt(scope, browserStorage(), entry, requestId);
      const input = attempt ? earlierAgentDeliveryInput(scope, attempt) : null;
      if (!input) {
        notice(
          id,
          "The original request or its saved agent session is unavailable. No work was sent; the earlier data is retained.",
        );
        return;
      }
      const result = await reconcile(input);
      notice(
        id,
        result._tag === "Failure"
          ? formatEnvironmentQueryError(result.cause)
          : !result.value
            ? "No delivery record was found. This does not send the message again. The original request is retained."
            : result.value.status === "accepted"
              ? "Delivery confirmed. The original request remains here for reference."
              : (result.value.message ??
                "Delivery remains uncertain. The original request is retained."),
      );
    } catch {
      notice(
        id,
        "The earlier request could not be checked. No new work was sent; the saved data is unchanged.",
      );
    } finally {
      setPending(null);
    }
  }

  if (!snapshot.entries.length && !snapshot.errors.length) return null;
  return (
    <div className="mx-auto mb-2 max-w-3xl">
      <Button
        type="button"
        variant="ghost-muted"
        size="xs"
        onClick={() => {
          setSnapshot(readSnapshot(scope));
          setOpen(true);
        }}
      >
        <ArchiveIcon /> Earlier saved drafts
        {snapshot.entries.length ? ` (${snapshot.entries.length})` : ""}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Earlier saved drafts</DialogTitle>
            <DialogDescription>
              Saved with older agent identities in this project. Their owner may be ambiguous, so
              they stay separate from current drafts. Nothing here is sent or queued automatically.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-3">
              {snapshot.errors.map((error) => (
                <p key={error} role="status" className="text-xs text-destructive">
                  {error}
                </p>
              ))}
              {!snapshot.entries.length && !snapshot.errors.length ? (
                <p className="text-sm text-muted-foreground">
                  No earlier drafts remain in this project.
                </p>
              ) : null}
              {snapshot.entries.map((entry) => (
                <section key={entry.id} className="space-y-3 rounded-lg border border-border p-3">
                  <div>
                    <h3 className="break-words text-sm font-medium">{entry.label}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {entry.kind === "queue"
                        ? "Earlier queue - delivery may be unconfirmed"
                        : entry.kind === "images"
                          ? "Saved attachments"
                          : entry.attempts.length
                            ? "Saved draft and delivery records"
                            : "Saved draft text"}
                      {entry.source === "session" ? " - this window" : ""}
                    </p>
                  </div>
                  {entry.text ? (
                    <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-sm">
                      {entry.text}
                    </p>
                  ) : null}
                  {open && entry.imagePreview ? (
                    <NativeAgentImages
                      scope={{ ...scope, agentRef: entry.imagePreview.agentRef }}
                      images={entry.imagePreview.images}
                    />
                  ) : null}
                  {entry.kind === "images" && !entry.imagePreview ? (
                    <p className="text-xs text-muted-foreground">
                      The original agent session was not saved with these images. Their references
                      are kept below, but a preview cannot be safely matched to an agent.
                    </p>
                  ) : null}
                  {entry.kind === "queue" ? (
                    <p className="text-xs text-muted-foreground">
                      These messages may already exist in an agent's queue. Check that conversation
                      before using their text again.
                    </p>
                  ) : null}
                  {entry.attempts.map((attempt) => {
                    const id = `${entry.id}:${attempt.requestId}`;
                    return (
                      <div key={attempt.requestId} className="space-y-2 rounded-md bg-muted/40 p-3">
                        <p className="text-xs font-medium">Delivery needs confirmation</p>
                        <p className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-sm">
                          {attempt.text || "Image message"}
                        </p>
                        {open && attempt.agentRef && attempt.images?.length ? (
                          <NativeAgentImages
                            scope={{ ...scope, agentRef: attempt.agentRef }}
                            images={attempt.images}
                          />
                        ) : null}
                        <dl className="space-y-1 break-all text-xs text-muted-foreground">
                          <div>
                            <dt className="inline font-medium">Request: </dt>
                            <dd className="inline">{attempt.requestId}</dd>
                          </div>
                          <div>
                            <dt className="inline font-medium">Original agent session: </dt>
                            <dd className="inline">{attempt.agentRef ?? "Not recorded"}</dd>
                          </div>
                        </dl>
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          disabled={pending !== null || !attempt.agentRef}
                          onClick={() => void checkDelivery(entry, attempt.requestId)}
                        >
                          {pending === id ? "Checking delivery..." : "Check delivery"}
                        </Button>
                        {notices[id] ? (
                          <p role="status" className="text-xs text-muted-foreground">
                            {notices[id]}
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                      Saved details and attachment references
                    </summary>
                    <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all">
                      {JSON.stringify(entry.saved, null, 2)}
                    </pre>
                  </details>
                  <div className="flex flex-wrap gap-2">
                    {entry.text && entry.kind !== "images" ? (
                      <Button
                        type="button"
                        variant="ghost-muted"
                        size="xs"
                        onClick={() => {
                          void writeTextToClipboard(entry.text)
                            .then((copied) =>
                              notice(
                                entry.id,
                                copied
                                  ? "Text copied. No draft was moved or sent."
                                  : "Could not copy the text.",
                              ),
                            )
                            .catch(() => notice(entry.id, "Could not copy the text."));
                        }}
                      >
                        Copy text
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost-muted"
                      size="xs"
                      onClick={() => {
                        void writeTextToClipboard(
                          JSON.stringify(
                            { source: entry.source, key: entry.key, saved: entry.saved },
                            null,
                            2,
                          ),
                        )
                          .then((copied) =>
                            notice(
                              entry.id,
                              copied
                                ? "Saved details copied. No draft was moved or sent."
                                : "Could not copy the saved details.",
                            ),
                          )
                          .catch(() => notice(entry.id, "Could not copy the saved details."));
                      }}
                    >
                      Copy saved details
                    </Button>
                  </div>
                  {notices[entry.id] ? (
                    <p role="status" className="text-xs text-muted-foreground">
                      {notices[entry.id]}
                    </p>
                  ) : null}
                </section>
              ))}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending !== null}
              onClick={() => setSnapshot(readSnapshot(scope))}
            >
              Refresh
            </Button>
            <DialogClose render={<Button type="button" variant="outline" size="sm" />}>
              Done
            </DialogClose>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

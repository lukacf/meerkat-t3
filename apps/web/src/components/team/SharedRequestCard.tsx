import type { SharedSpecialistRequest } from "@t3tools/contracts";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { frameText } from "./agentActivity.logic";
import { Button } from "../ui/button";
import { SharedRevisionLabel } from "./SharedActivityInbox";

const sharedMarkdownComponents: Components = {
  a: ({ href, children }) =>
    href && /^https?:\/\//i.test(href) ? (
      <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => <span className="text-muted-foreground">{alt || "Attached image"}</span>,
};

/** Shared text cannot implicitly open files or terminals on the runtime host. */
export function SharedMarkdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown min-w-0 text-sm leading-relaxed [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={sharedMarkdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function SharedRequestCard({
  request,
  specialistLabel,
  projectLabel,
  onRetry,
}: {
  request: SharedSpecialistRequest;
  specialistLabel: string;
  projectLabel: string;
  onRetry?: (() => void) | undefined;
}) {
  const outcome = request.outcome;
  const result = outcome.completion ? frameText(outcome.completion.payload) : null;
  return (
    <article className="space-y-5 py-6" data-shared-request-id={request.requestId}>
      <div className="ml-8 rounded-2xl bg-muted/50 px-4 py-3 sm:ml-16">
        <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{request.author.displayName}</span>
          <span>{projectLabel}</span>
          <SharedRevisionLabel revision={request.context.revision} />
          <time className="ml-auto" dateTime={request.createdAt}>
            {new Date(request.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        </div>
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{request.text}</p>
      </div>
      <div className="space-y-3 px-1">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium">{specialistLabel}</span>
          <span
            className={outcome.status === "failed" ? "text-destructive" : "text-muted-foreground"}
            role="status"
          >
            {outcome.status === "not_admitted"
              ? "Not sent"
              : outcome.status === "unresolved"
                ? "Outcome unresolved"
                : outcome.status === "accepted"
                  ? "Accepted, awaiting result"
                  : outcome.status === "failed"
                    ? "Request failed"
                    : "Completed"}
          </span>
        </div>
        {result ? (
          <SharedMarkdown text={result} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {outcome.status === "completed"
              ? "A native completion is recorded for this request. Its evidence is available below."
              : (outcome.detail ?? "This request has no confirmed result yet.")}
          </p>
        )}
        {outcome.status === "not_admitted" && onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry saved request
          </Button>
        ) : null}
        {outcome.detail && result ? (
          <p className="text-xs text-muted-foreground">{outcome.detail}</p>
        ) : null}
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Request evidence</summary>
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            <dt>Request</dt>
            <dd className="break-all font-mono">{request.requestId}</dd>
            <dt>Native input</dt>
            <dd className="break-all font-mono">{request.nativeRequestId}</dd>
            <dt>Checkout</dt>
            <dd className="break-all font-mono">{request.context.checkoutId}</dd>
            <dt>Context version</dt>
            <dd className="break-all font-mono">{request.context.contextVersion}</dd>
            <dt>Revision</dt>
            <dd className="break-all font-mono">{request.context.revision.commit}</dd>
          </dl>
          {outcome.receipt || outcome.completion ? (
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-2">
              {JSON.stringify(
                { receipt: outcome.receipt, completion: outcome.completion },
                null,
                2,
              )}
            </pre>
          ) : null}
        </details>
      </div>
    </article>
  );
}

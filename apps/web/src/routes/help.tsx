import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeftIcon, BookOpenIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { APP_DISPLAY_NAME } from "../branding";
import { GUIDE_TOPICS, guideHeadingId, resolveGuideLink, resolveGuideTopic } from "../components/help/guide";
import { useNavigateToMainApp } from "../components/sidebar/mainAppLocation";
import { Button } from "../components/ui/button";

export const Route = createFileRoute("/help")({
  validateSearch: (search: Record<string, unknown>) => ({ topic: resolveGuideTopic(search.topic) }),
  component: HelpPage,
});

function HelpPage() {
  const { topic } = Route.useSearch();
  const selected = GUIDE_TOPICS.find((entry) => entry.id === topic) ?? GUIDE_TOPICS[0];
  const back = useNavigateToMainApp();
  return (
    <div className="flex h-dvh w-full flex-col bg-background text-foreground">
      <header className="drag-region flex shrink-0 items-center gap-3 border-b px-5 py-3 pt-10 sm:px-8">
        <Button variant="ghost" size="sm" className="shrink-0 [-webkit-app-region:no-drag]" onClick={() => void back()}>
          <ArrowLeftIcon /> Back to workspace
        </Button>
        <div className="ml-auto flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
          <BookOpenIcon className="size-4 shrink-0" /> <span className="truncate">{APP_DISPLAY_NAME} Guide</span>
        </div>
      </header>
      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col md:flex-row">
        <nav aria-label="Guide topics" className="flex shrink-0 gap-1 overflow-x-auto border-b p-3 md:w-56 md:flex-col md:overflow-y-auto md:border-r md:border-b-0 md:p-5">
          {GUIDE_TOPICS.map((entry) => (
            <Link
              key={entry.id}
              to="/help"
              search={{ topic: entry.id }}
              aria-current={topic === entry.id ? "page" : undefined}
              className={`rounded-md px-3 py-2 text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring ${topic === entry.id ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"}`}
            >
              {entry.label}
            </Link>
          ))}
        </nav>
        <main key={topic} className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-8 sm:px-10">
          <article className="mx-auto max-w-2xl pb-12 text-sm leading-7">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: ({ children }) => <h1 className="mb-6 text-2xl font-semibold tracking-tight">{children}</h1>,
                h2: ({ children }) => <h2 id={guideHeadingId(String(children))} className="mt-8 mb-3 scroll-mt-4 text-lg font-semibold">{children}</h2>,
                h3: ({ children }) => <h3 id={guideHeadingId(String(children))} className="mt-6 mb-2 scroll-mt-4 text-base font-semibold">{children}</h3>,
                p: ({ children }) => <p className="my-3">{children}</p>,
                ul: ({ children }) => <ul className="my-3 list-disc space-y-2 pl-5">{children}</ul>,
                ol: ({ children }) => <ol className="my-3 list-decimal space-y-2 pl-5">{children}</ol>,
                blockquote: ({ children }) => <blockquote className="my-4 rounded-r-md border-l-2 border-primary bg-muted/50 px-4 py-1">{children}</blockquote>,
                table: ({ children }) => <div className="my-4 overflow-x-auto"><table className="w-full border-collapse text-left">{children}</table></div>,
                th: ({ children }) => <th className="border-b px-3 py-2 font-medium">{children}</th>,
                td: ({ children }) => <td className="border-b px-3 py-2 align-top">{children}</td>,
                pre: ({ children }) => <pre className="my-4 overflow-x-auto rounded-md border bg-muted/50 p-4 text-xs leading-6">{children}</pre>,
                code: ({ children, className }) => <code className={className ? "font-mono text-xs" : "rounded bg-muted px-1 py-0.5 font-mono text-xs"}>{children}</code>,
                a: ({ href, children }) => {
                  const target = resolveGuideLink(href);
                  return target ? (
                    <Link to="/help" search={{ topic: target.topic }} hash={target.hash} className="text-primary underline underline-offset-2">{children}</Link>
                  ) : (
                    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">{children}</a>
                  );
                },
              }}
            >
              {selected.text}
            </ReactMarkdown>
          </article>
        </main>
      </div>
    </div>
  );
}

import type { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowLeftIcon, MessageSquareIcon } from "lucide-react";
import { meerkatTeamEnvironment } from "../../state/meerkatTeam";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { NativeAgentTranscript } from "./NativeAgentTranscript";

/** A search result is a read-only exact session, separate from the current live incarnation. */
export function NativeSearchConversation({
  environmentId,
  projectId,
  instanceId,
  label,
  cwd,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  instanceId: ProviderInstanceId;
  label: string;
  cwd: string | undefined;
}) {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const scope = { environmentId, projectId, instanceId, agentRef: search.nativeAgent! };
  const query = useEnvironmentQuery(
    meerkatTeamEnvironment.agentActivity({
      environmentId,
      input: {
        projectId,
        instanceId,
        agentRef: search.nativeAgent!,
        limit: 100,
        ...(search.nativeRevision && search.nativeOffset !== undefined
          ? {
              transcriptRevision: search.nativeRevision,
              transcriptBefore: search.nativeOffset + 1,
            }
          : {}),
      },
    }),
  );
  const transcript = query.data?.transcript;
  const matchesSession = !search.nativeSession || transcript?.sessionId === search.nativeSession;
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Search result conversation">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <MessageSquareIcon className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() =>
            void navigate({
              to: ".",
              search: (previous) => {
                const next = { ...previous };
                delete next.nativeAgent;
                delete next.nativeInstance;
                delete next.nativeSession;
                delete next.nativeRevision;
                delete next.nativeOffset;
                return next;
              },
            })
          }
        >
          <ArrowLeftIcon />
          Open conversation
        </Button>
      </header>
      <div className="shrink-0 border-b border-border px-4 py-2 text-xs text-muted-foreground">
        Saved search result
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.error || (transcript && !matchesSession) ? (
          <p role="status" className="p-6 text-sm text-muted-foreground">
            {query.error ??
              "This saved result no longer matches the requested session. Search again to find its current messages."}
          </p>
        ) : transcript ? (
          <NativeAgentTranscript
            key={`${scope.agentRef}:${transcript.sessionId}:${transcript.storeRevision}`}
            initial={transcript}
            scope={scope}
            agentLabel={label}
            cwd={cwd}
            raw={false}
            onRefresh={query.refresh}
          />
        ) : (
          <p role="status" className="p-6 text-sm text-muted-foreground">
            {query.isPending
              ? "Opening saved message..."
              : "This agent has no saved messages available."}
          </p>
        )}
      </div>
    </section>
  );
}

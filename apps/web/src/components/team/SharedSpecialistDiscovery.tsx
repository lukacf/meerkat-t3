import type {
  SharedCheckout,
  SharedDiscoveryInput,
  SharedDiscoveryReason,
  SharedWorkspaceSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, SearchIcon } from "lucide-react";
import { useId, useState } from "react";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { sharedWorkspaceEnvironment as shared } from "../../state/sharedWorkspace";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { sharedSpecialistDestination } from "./sharedWorkspace.logic";

export function sharedDiscoveryReasonLabel(reason: SharedDiscoveryReason) {
  switch (reason.kind) {
    case "project":
      return "Project assignment";
    case "path":
      return `Path: ${reason.path}`;
    case "tag":
      return `Tag: ${reason.tag}`;
    case "description":
      return reason.source === "label" ? "Name matches" : "Charter matches";
    case "general":
      return "General coverage";
  }
}

/** A small directory search within the local project's existing shared-host section. */
export function SharedSpecialistDiscovery({
  host,
  checkout,
  snapshot,
  connected,
  refreshDirectory,
  threadId,
}: {
  host: EnvironmentPresentation;
  checkout: SharedCheckout;
  snapshot: SharedWorkspaceSnapshot;
  connected: boolean;
  refreshDirectory: () => void;
  threadId?: ThreadId | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-border pt-3">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-sm text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <SearchIcon className="size-3.5 shrink-0" />
          Find specialists
          <ChevronDownIcon
            className={`ml-auto size-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          {open ? (
            <DiscoverySearch
              key={checkout.checkoutId}
              host={host}
              checkout={checkout}
              snapshot={snapshot}
              connected={connected}
              refreshDirectory={refreshDirectory}
              threadId={threadId}
            />
          ) : null}
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

function DiscoverySearch({
  host,
  checkout,
  snapshot,
  connected,
  refreshDirectory,
  threadId,
}: {
  host: EnvironmentPresentation;
  checkout: SharedCheckout;
  snapshot: SharedWorkspaceSnapshot;
  connected: boolean;
  refreshDirectory: () => void;
  threadId?: ThreadId | undefined;
}) {
  const id = useId();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  const [tag, setTag] = useState("");
  const [allProjects, setAllProjects] = useState(false);
  const [filters, setFilters] = useState<SharedDiscoveryInput>({
    sharedProjectId: checkout.sharedProjectId,
  });
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const after = cursors[cursors.length - 1];
  const result = useEnvironmentQuery(
    connected
      ? shared.discover({
          environmentId: host.environmentId,
          input: { ...filters, limit: 10, ...(after ? { after } : {}) },
        })
      : null,
  );
  const submit = () => {
    setFilters({
      ...(!allProjects ? { sharedProjectId: checkout.sharedProjectId } : {}),
      ...(query.trim() ? { query: query.trim() } : {}),
      ...(path.trim() ? { paths: [path.trim()] } : {}),
      ...(tag.trim() ? { tags: [tag.trim()] } : {}),
    });
    setCursors([undefined]);
    result.refresh();
  };
  return (
    <div className="min-w-0 space-y-4 pt-3">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (connected) submit();
        }}
      >
        <div className="flex min-w-0 flex-wrap gap-2">
          <Input
            className="min-w-0 flex-1 basis-40"
            aria-label="Search specialist names and charters"
            placeholder="Search names and responsibilities"
            maxLength={512}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={!connected || result.isPending}
          >
            Search
          </Button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor={`${id}-path`}>
              Path <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id={`${id}-path`}
              placeholder="src/catalog"
              maxLength={1024}
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
          </div>
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor={`${id}-tag`}>
              Tag <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id={`${id}-tag`}
              placeholder="catalog"
              maxLength={200}
              value={tag}
              onChange={(event) => setTag(event.target.value)}
            />
          </div>
        </div>
        <Label htmlFor={`${id}-all-projects`}>
          <Checkbox
            id={`${id}-all-projects`}
            checked={allProjects}
            onCheckedChange={(checked) => setAllProjects(checked)}
          />
          Search across this workspace's projects
        </Label>
      </form>
      {!connected ? (
        <p role="status" className="text-xs text-muted-foreground">
          The host is offline. Reconnect to search its directory.
        </p>
      ) : result.error ? (
        <div role="alert" className="space-y-2 text-xs text-destructive">
          <p className="wrap-anywhere">{result.error}</p>
          <Button variant="outline" size="xs" onClick={result.refresh}>
            Retry search
          </Button>
        </div>
      ) : result.isPending ? (
        <p role="status" className="text-xs text-muted-foreground">
          Searching specialists...
        </p>
      ) : result.data ? (
        <div className="space-y-3" aria-live="polite">
          <p className="text-xs text-muted-foreground">
            {filters.sharedProjectId ? "In this project" : "Across this workspace"}. Matches
            describe responsibilities, not whether an agent is running.
          </p>
          {!result.data.items.length ? (
            <p className="text-sm text-muted-foreground">No specialists match these filters.</p>
          ) : null}
          {result.data.items.map((match) => {
            const specialist = snapshot.specialists.find(
              (candidate) =>
                candidate.specialistId === match.specialistId &&
                candidate.assignmentVersion === match.assignmentVersion,
            );
            const assignedHere = match.sharedProjectIds.includes(checkout.sharedProjectId);
            return (
              <div
                key={match.specialistId}
                className="min-w-0 space-y-2 rounded-lg border border-border p-3"
              >
                <div className="flex min-w-0 flex-wrap items-start gap-2">
                  <span className="min-w-0 flex-1 basis-32 wrap-anywhere text-sm font-medium">
                    {match.label}
                  </span>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={!specialist}
                    onClick={() => {
                      if (specialist)
                        void navigate(
                          sharedSpecialistDestination(
                            host.environmentId,
                            specialist,
                            assignedHere ? checkout : undefined,
                            assignedHere ? threadId : undefined,
                          ),
                        );
                    }}
                  >
                    {assignedHere ? "Open conversation" : "View conversation"}
                  </Button>
                </div>
                {!assignedHere ? (
                  <p className="text-xs text-muted-foreground">
                    This specialist is not assigned to this checkout's project. Its conversation
                    opens without a local task context.
                  </p>
                ) : null}
                {!specialist ? (
                  <Button variant="ghost" size="xs" onClick={refreshDirectory}>
                    Refresh changed directory
                  </Button>
                ) : null}
                {match.matches.map((assignment) => {
                  const full = specialist?.assignments.find(
                    (candidate) => candidate.sharedProjectId === assignment.sharedProjectId,
                  );
                  return (
                    <div key={assignment.sharedProjectId} className="space-y-1.5 text-xs">
                      <p className="wrap-anywhere font-medium">
                        {snapshot.projects.find(
                          (project) => project.sharedProjectId === assignment.sharedProjectId,
                        )?.name ?? "Shared project"}
                      </p>
                      <div className="flex flex-wrap gap-1.5 text-muted-foreground">
                        {assignment.reasons.map((reason) => (
                          <span
                            key={reason.kind}
                            className="max-w-full rounded bg-muted px-1.5 py-0.5 wrap-anywhere"
                          >
                            {sharedDiscoveryReasonLabel(reason)}
                          </span>
                        ))}
                      </div>
                      <p className="text-muted-foreground">
                        Charter excerpt{assignment.charterExcerptTruncated ? " (shortened)" : ""}
                      </p>
                      <p className="whitespace-pre-wrap wrap-anywhere text-muted-foreground">
                        {assignment.charterExcerpt}
                      </p>
                      {assignment.charterExcerptTruncated && full ? (
                        <Collapsible>
                          <CollapsibleTrigger className="rounded-sm text-left underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            Read full charter
                          </CollapsibleTrigger>
                          <CollapsiblePanel>
                            <p className="pt-2 whitespace-pre-wrap wrap-anywhere text-muted-foreground">
                              {full.charter}
                            </p>
                          </CollapsiblePanel>
                        </Collapsible>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {cursors.length > 1 || result.data.nextCursor ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                variant="ghost"
                size="xs"
                disabled={cursors.length < 2}
                onClick={() => setCursors((current) => current.slice(0, -1))}
              >
                Previous results
              </Button>
              <span className="text-xs text-muted-foreground">Page {cursors.length}</span>
              <Button
                variant="ghost"
                size="xs"
                disabled={!result.data.nextCursor}
                onClick={() => {
                  if (result.data?.nextCursor)
                    setCursors((current) => [...current, result.data!.nextCursor!]);
                }}
              >
                Next results
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

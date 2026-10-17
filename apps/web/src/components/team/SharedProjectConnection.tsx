import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { canonicalSharedRepository } from "@t3tools/shared/sharedRepository";
import { useNavigate } from "@tanstack/react-router";
import { LinkIcon, ServerIcon } from "lucide-react";
import { useState } from "react";
import type { EnvironmentPresentation } from "../../state/environments";
import { formatEnvironmentQueryError } from "../../state/query";
import {
  sharedWorkspaceEnvironment as shared,
  useSharedDirectory,
  useSharedHosts,
} from "../../state/sharedWorkspace";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SharedSpecialistDiscovery } from "./SharedSpecialistDiscovery";
import { SharedTaskAccess } from "./SharedTaskAccess";
import {
  sharedHostStatus,
  sharedProjectRoster,
  sharedSpecialistDestination,
} from "./sharedWorkspace.logic";

function HostProjectConnection({
  project,
  host,
}: {
  project: EnvironmentProject;
  host: EnvironmentPresentation;
}) {
  const directory = useSharedDirectory(host);
  const join = useAtomCommand(shared.join, { reportFailure: false });
  const attach = useAtomCommand(shared.attachCheckout, { reportFailure: false });
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshot = directory.snapshot;
  let repository: string | null = null;
  try {
    repository = project.repositoryIdentity?.locator.remoteUrl
      ? canonicalSharedRepository(project.repositoryIdentity.locator.remoteUrl)
      : null;
  } catch {
    /* Ambiguous remotes require a repository fix before association. */
  }
  const sharedProject = snapshot?.projects.find(
    (candidate) =>
      candidate.repository === repository || candidate.aliases.includes(repository ?? ""),
  );
  const checkout = snapshot?.checkouts.find(
    (candidate) =>
      candidate.participantId === snapshot.participant?.participantId &&
      candidate.localEnvironmentId === project.environmentId &&
      candidate.localProjectId === project.id,
  );
  const roster = snapshot
    ? sharedProjectRoster(snapshot, [
        { environmentId: project.environmentId, projectId: project.id },
      ])
    : [];
  const status = sharedHostStatus(
    host.connection.phase,
    snapshot !== null,
    directory.error,
    directory.isPending,
  );
  async function connect() {
    if (
      busy ||
      !directory.connected ||
      directory.error ||
      !directory.permissions?.contribute ||
      !repository ||
      !sharedProject
    )
      return;
    setBusy(true);
    setError(null);
    try {
      if (!snapshot?.participant) {
        if (!name.trim()) {
          setError("Enter your name so requests are attributed to you.");
          return;
        }
        const joined = await join({
          environmentId: host.environmentId,
          input: { displayName: name.trim() },
        });
        if (joined._tag === "Failure") {
          setError(formatEnvironmentQueryError(joined.cause));
          return;
        }
      }
      const result = await attach({
        environmentId: host.environmentId,
        input: {
          localEnvironmentId: project.environmentId,
          localProjectId: project.id,
          repository,
          sharedProjectId: sharedProject.sharedProjectId,
        },
      });
      if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
      else directory.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 rounded-xl border border-border p-4">
      <div className="flex items-center gap-2 text-sm">
        <ServerIcon className="size-4 text-muted-foreground" />
        <span className="font-medium">{snapshot?.workspace?.name ?? host.label}</span>
        <span className="ml-auto text-xs text-muted-foreground">{status}</span>
      </div>
      {checkout ? (
        <>
          <p className="text-xs text-muted-foreground">
            This checkout uses the project's shared specialists. Your tasks and files stay on this
            machine.
          </p>
          <div className="flex flex-wrap gap-2">
            {roster.map(({ specialist }) => (
              <Button
                key={specialist.specialistId}
                size="xs"
                variant="secondary"
                onClick={() =>
                  void navigate(
                    sharedSpecialistDestination(host.environmentId, specialist, checkout),
                  )
                }
              >
                {specialist.label}
                {specialist.supersededAt ? " (previous)" : ""}
              </Button>
            ))}
          </div>
          {!roster.length ? (
            <p className="text-xs text-muted-foreground">
              No specialists are assigned to this shared project yet.
            </p>
          ) : null}
          {snapshot ? (
            <SharedSpecialistDiscovery
              host={host}
              checkout={checkout}
              snapshot={snapshot}
              connected={directory.connected && !directory.error}
              refreshDirectory={directory.refresh}
            />
          ) : null}
          {snapshot ? (
            <SharedTaskAccess
              host={host}
              checkout={checkout}
              snapshot={snapshot}
              connected={directory.connected && !directory.error}
              canContribute={directory.permissions?.contribute === true}
            />
          ) : null}
        </>
      ) : sharedProject ? (
        <>
          <p className="text-xs text-muted-foreground">
            Use the existing specialists for {sharedProject.name} with this checkout.
          </p>
          {!snapshot?.participant ? (
            <Input
              aria-label="Your name in the shared workspace"
              placeholder="Your name"
              value={name}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
            />
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={
              busy ||
              !directory.connected ||
              Boolean(directory.error) ||
              !directory.permissions?.contribute
            }
            onClick={() => void connect()}
          >
            <LinkIcon />
            {busy ? "Connecting..." : "Use shared specialists"}
          </Button>
          {directory.permissions && !directory.permissions.contribute ? (
            <p className="text-xs text-muted-foreground">
              This connection can view shared work. Ask the workspace owner for a participant
              invitation to send requests.
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {directory.error ??
            (!directory.connected
              ? "The shared host is offline. Reconnect to check this repository's specialists."
              : !snapshot
                ? "Loading the shared workspace..."
                : !repository
                  ? "Add an unambiguous Git remote to associate this checkout with a shared project."
                  : "This repository has not been registered in this shared workspace.")}
        </p>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function SharedProjectConnection({ project }: { project: EnvironmentProject }) {
  const hosts = useSharedHosts();
  if (!hosts.length) return null;
  return (
    <div className="space-y-3" aria-label="Shared project specialists">
      {hosts.map((host) => (
        <HostProjectConnection key={host.environmentId} host={host} project={project} />
      ))}
    </div>
  );
}

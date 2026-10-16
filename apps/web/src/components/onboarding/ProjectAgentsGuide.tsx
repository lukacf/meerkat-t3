import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { persistClientSettingsUpdate, useClientSettings } from "../../hooks/useSettings";
import { environmentShell } from "../../state/shell";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { Button } from "../ui/button";

type Props = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  sourceThreadId?: ThreadId;
  acceptedAgentId?: string | undefined;
  preparationLabel?: string | undefined;
  blocked?: boolean | undefined;
};

function isThreadMissing(shell: EnvironmentShellState, threadId: ThreadId) {
  return (
    shell.status === "live" &&
    Option.isSome(shell.snapshot) &&
    !shell.snapshot.value.threads.some((thread) => thread.id === threadId)
  );
}

/** Only a server-bound proposal can claim this journey's conversation. */
export function ProjectAgentsGuide({
  environmentId,
  projectId,
  sourceThreadId,
  acceptedAgentId,
  preparationLabel,
  blocked = false,
}: Props) {
  const progress = useClientSettings((settings) => settings.onboardingProgress);
  const navigate = useNavigate();
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const savedThreadMissing = progress?.threadId ? isThreadMissing(shell, progress.threadId) : false;
  const matches =
    progress?.step === "project-agents" &&
    progress.projectRef?.environmentId === environmentId &&
    progress.projectRef.projectId === projectId &&
    (!sourceThreadId ||
      progress.threadId === null ||
      progress.threadId === sourceThreadId ||
      savedThreadMissing);
  useEffect(() => {
    if (
      !matches ||
      !sourceThreadId ||
      progress.threadId === sourceThreadId ||
      inFlight.current ||
      error
    )
      return;
    inFlight.current = true;
    setSaving(true);
    void persistClientSettingsUpdate((current) => {
      const active = current.onboardingProgress;
      if (
        active?.threadId &&
        active.threadId !== sourceThreadId &&
        !isThreadMissing(
          appAtomRegistry.get(environmentShell.stateValueAtom(environmentId)),
          active.threadId,
        )
      )
        return current;
      return active?.step === "project-agents" &&
        active.startedAt === progress.startedAt &&
        active.projectRef?.environmentId === environmentId &&
        active.projectRef.projectId === projectId &&
        active.threadId === progress.threadId
        ? { ...current, onboardingProgress: { ...active, threadId: sourceThreadId } }
        : current;
    })
      .catch(() => setError("Could not save setup progress. Try again before continuing."))
      .finally(() => {
        inFlight.current = false;
        setSaving(false);
      });
  }, [environmentId, error, matches, progress, projectId, sourceThreadId]);

  if (!matches) return null;
  async function finish(skip: boolean) {
    if (
      !progress ||
      inFlight.current ||
      (!skip && (blocked || !acceptedAgentId || !sourceThreadId))
    )
      return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      let completed = false;
      await persistClientSettingsUpdate((current) => {
        completed = false;
        const active = current.onboardingProgress;
        if (
          active?.step !== "project-agents" ||
          active.startedAt !== progress.startedAt ||
          active.projectRef?.environmentId !== environmentId ||
          active.projectRef.projectId !== projectId ||
          (!skip && active.threadId !== sourceThreadId)
        )
          return current;
        completed = true;
        return {
          ...current,
          onboardingProgress: null,
          onboardingCompletedAt: new Date().toISOString(),
        };
      });
      if (!completed) return;
      if (!skip && acceptedAgentId) {
        await navigate({
          to: "/$environmentId/agents/$agentId",
          params: { environmentId, agentId: acceptedAgentId },
          search: { project: projectId },
        });
      } else {
        await navigate({
          to: "/$environmentId/projects/$projectId/start",
          params: { environmentId, projectId },
          search: {},
        });
      }
    } catch {
      setError("Could not finish setup. Your proposal and assignments are saved. Try again.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  return (
    <aside aria-label="Project agents setup" className="space-y-2 px-4 py-3">
      <p className="text-sm font-medium">Set up your project specialists</p>
      <p className="text-xs text-muted-foreground">
        {acceptedAgentId
          ? `Assignments applied. ${preparationLabel ?? "Open a specialist to follow its preparation."}`
          : "Study the repository, review the proposed domains, and apply the assignments you want."}
      </p>
      <div className="flex flex-wrap gap-2">
        {acceptedAgentId ? (
          <Button
            size="sm"
            disabled={saving || blocked || error !== null}
            onClick={() => void finish(false)}
          >
            Continue to specialists
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={saving}
          onClick={() => void navigate({ to: "/help", search: { topic: "agents" } })}
        >
          Help
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={saving}
          onClick={() => void navigate({ to: "/welcome" })}
        >
          Back to setup
        </Button>
        <Button size="sm" variant="ghost" disabled={saving} onClick={() => void finish(true)}>
          Skip setup
        </Button>
      </div>
      {error ? (
        <div role="alert" className="text-xs text-warning-foreground">
          {error}{" "}
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setError(null);
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}
    </aside>
  );
}

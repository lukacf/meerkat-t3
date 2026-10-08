import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { projectCloneProgressSummary } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { gitEnvironment } from "../../state/git";
import { vcsEnvironment } from "../../state/vcs";
import { serverEnvironment } from "../../state/server";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface OnboardingProjectReadinessProps {
  readonly project: ScopedProjectRef;
  readonly cwd: string;
  readonly onContinue: () => Promise<boolean>;
  readonly onBack: () => void;
  readonly onPendingChange: (pending: boolean) => void;
}

export function OnboardingProjectReadiness(props: OnboardingProjectReadinessProps) {
  return (
    <ProjectReadiness
      key={JSON.stringify([props.project.environmentId, props.project.projectId, props.cwd])}
      {...props}
    />
  );
}

function ProjectReadiness({
  project,
  cwd,
  onContinue,
  onBack,
  onPendingChange,
}: OnboardingProjectReadinessProps) {
  const config = useAtomValue(serverEnvironment.configValueAtom(project.environmentId));
  const tracksClones = config?.environment.capabilities.projectCloneTracking === true;
  const clones = useEnvironmentQuery(
    tracksClones
      ? sourceControlEnvironment.projectClones({ environmentId: project.environmentId, input: {} })
      : null,
  );
  const clone = clones.data?.find((entry) => entry.projectId === project.projectId) ?? null;
  const cloneUnavailable =
    config === null || (tracksClones && (clones.data === null || clones.error !== null));
  const cloneBlocked = clone !== null && clone.phase !== "done";
  const phase = clone?.phase ?? null;
  const [observedClone, setObservedClone] = useState({
    phase,
    refreshIdentity: phase === "done",
  });
  if (observedClone.phase !== phase) {
    setObservedClone({
      phase,
      refreshIdentity:
        observedClone.refreshIdentity ||
        phase === "done" ||
        (observedClone.phase !== null && observedClone.phase !== "done"),
    });
  }
  const identity = useEnvironmentQuery(
    cloneUnavailable || cloneBlocked
      ? null
      : gitEnvironment.identity({ environmentId: project.environmentId, input: { cwd } }),
  );
  const queryIdentity = useAtomQueryRunner(gitEnvironment.identity, { reportFailure: false });
  const refreshIdentity = identity.refresh;
  useEffect(() => {
    if (!observedClone.refreshIdentity || cloneUnavailable || cloneBlocked) return;
    let current = true;
    // Invalidate even an in-flight read of the pre-clone directory, then await
    // the replacement. Cached data must not expose Initialize Git meanwhile.
    refreshIdentity();
    void queryIdentity({ environmentId: project.environmentId, input: { cwd } }).then(() => {
      if (current) setObservedClone((previous) => ({ ...previous, refreshIdentity: false }));
    });
    return () => {
      current = false;
    };
  }, [
    cloneBlocked,
    cloneUnavailable,
    cwd,
    observedClone.refreshIdentity,
    project.environmentId,
    queryIdentity,
    refreshIdentity,
  ]);
  const identityPending = observedClone.refreshIdentity || identity.isPending;
  const identityReady =
    !cloneUnavailable && !cloneBlocked && !identityPending && identity.isSuccess;
  const updateIdentity = useAtomCommand(gitEnvironment.updateIdentity, { reportFailure: false });
  const init = useAtomCommand(vcsEnvironment.init, { reportFailure: false });
  const retryClone = useAtomCommand(sourceControlEnvironment.retryProjectClone, {
    reportFailure: false,
  });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  const focusAfterUpdate = useRef<"author" | "continue" | null>(null);
  useEffect(() => {
    onPendingChange(pending);
  }, [onPendingChange, pending]);
  useEffect(() => () => onPendingChange(false), [onPendingChange]);
  useEffect(() => {
    if (pending) return;
    const target =
      focusAfterUpdate.current === "author"
        ? nameInputRef.current
        : focusAfterUpdate.current === "continue" && identityReady && identity.data?.ready
          ? continueRef.current
          : null;
    if (target && !target.disabled) {
      focusAfterUpdate.current = null;
      target.focus();
    }
  }, [editing, identity.data?.ready, identityReady, pending]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (editing) return;
    setName(identity.data?.effective.name ?? "");
    setEmail(identity.data?.effective.email ?? "");
  }, [editing, identity.data]);
  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update project setup. Try again.",
      );
    } finally {
      setPending(false);
    }
  };
  const effective = identity.data?.effective;
  const repository = identity.data?.repositoryRoot;
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Check your project</h2>
        <p className="mt-1 break-all text-sm text-muted-foreground">{cwd}</p>
      </div>
      {cloneUnavailable ? (
        <div className="space-y-2">
          <p role={clones.error ? "alert" : "status"} className="text-sm text-muted-foreground">
            {clones.error
              ? `Clone status could not be checked: ${clones.error}`
              : "Checking clone status..."}
          </p>
          {clones.error ? (
            <Button size="sm" variant="outline" onClick={clones.refresh}>
              Check again
            </Button>
          ) : null}
        </div>
      ) : cloneBlocked ? (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <p className="text-sm" role={clone.phase === "running" ? "status" : "alert"}>
            {clone.phase === "running"
              ? projectCloneProgressSummary(clone)
              : (clone.error ?? "The clone did not finish.")}
          </p>
          {clone.phase !== "running" ? (
            <Button
              disabled={pending}
              size="sm"
              onClick={() =>
                void run(async () => {
                  const result = await retryClone({
                    environmentId: project.environmentId,
                    input: { projectId: project.projectId },
                  });
                  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                })
              }
            >
              Retry clone
            </Button>
          ) : null}
        </div>
      ) : null}
      {!cloneUnavailable && !cloneBlocked && identityPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Checking Git and commit author...
        </p>
      ) : null}
      {!cloneUnavailable && !cloneBlocked && !identityPending && identity.error ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            Git setup could not be checked: {identity.error}
          </p>
          <Button size="sm" variant="outline" onClick={identity.refresh}>
            Check again
          </Button>
        </div>
      ) : null}
      {identity.data && identityReady ? (
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div>
            <p className="text-sm font-medium">
              {repository ? "Git repository found" : "This folder is not a Git repository"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Git keeps file history and enables branches, change review and commits.
            </p>
          </div>
          {!repository ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  const result = await init({
                    environmentId: project.environmentId,
                    input: { cwd },
                  });
                  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                  identity.refresh();
                })
              }
            >
              Initialize Git in this folder
            </Button>
          ) : (
            <>
              <div role="status">
                <p className="text-sm font-medium">
                  {identity.data.ready ? "Commit author ready" : "Choose a commit author"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {identity.data.ready
                    ? `${effective?.name} <${effective?.email}>`
                    : "Git needs a name and email to create commits. These details appear in commit history."}
                </p>
              </div>
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Where this identity comes from</summary>
                <dl className="mt-2 space-y-1">
                  <div>
                    <dt className="inline font-medium">Computer default: </dt>
                    <dd className="inline">
                      {identity.data.global.name ?? "Not set"} &lt;
                      {identity.data.global.email ?? "Not set"}&gt;
                    </dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">Repository override: </dt>
                    <dd className="inline">
                      {identity.data.local.name ?? "Not set"} &lt;
                      {identity.data.local.email ?? "Not set"}&gt;
                    </dd>
                  </div>
                </dl>
                <p className="mt-1">
                  The effective author above is what Git currently resolves, including any
                  environment overrides.
                </p>
              </details>
              {!identity.data.ready || editing ? (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      const result = await updateIdentity({
                        environmentId: project.environmentId,
                        input: { cwd, name: name.trim(), email: email.trim() },
                      });
                      identity.refresh();
                      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                      focusAfterUpdate.current = result.value.ready ? "continue" : "author";
                      setEditing(false);
                    });
                  }}
                >
                  <label className="block space-y-1 text-sm">
                    Name
                    <Input
                      ref={nameInputRef}
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value);
                        setEditing(true);
                      }}
                      required
                      disabled={pending}
                    />
                  </label>
                  <label className="block space-y-1 text-sm">
                    Email
                    <Input
                      value={email}
                      onChange={(event) => {
                        setEmail(event.target.value);
                        setEditing(true);
                      }}
                      required
                      disabled={pending}
                    />
                  </label>
                  <p className="break-all text-xs text-muted-foreground">
                    Saved only for {repository}. Your computer default stays unchanged. A
                    GitHub-provided private commit email is also supported.
                  </p>
                  <Button
                    size="sm"
                    disabled={pending || !name.trim() || !email.trim()}
                    type="submit"
                  >
                    Save for this repository
                  </Button>
                </form>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    focusAfterUpdate.current = "author";
                    setEditing(true);
                  }}
                >
                  Use a different author for this repository
                </Button>
              )}
            </>
          )}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Link
        className="text-xs text-primary underline underline-offset-2"
        to="/help"
        search={{ topic: "accounts" }}
        hash="github-repositories"
      >
        Git installation and setup help
      </Link>
      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="ghost" disabled={pending} onClick={onBack}>
          Back to projects
        </Button>
        <Button
          ref={continueRef}
          disabled={pending || cloneUnavailable || cloneBlocked || identityPending}
          onClick={() =>
            void run(async () => {
              await onContinue();
            })
          }
        >
          {identityReady && identity.data?.ready && repository
            ? "Continue to first task"
            : "Continue without Git setup"}
        </Button>
      </div>
    </div>
  );
}

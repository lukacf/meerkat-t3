import { useEffect, useRef, useState } from "react";
import type { EnvironmentId, FilesystemBrowseResult, ScopedProjectRef } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { FolderOpenIcon, FolderPlusIcon, GitForkIcon } from "lucide-react";
import { useEnvironments } from "../../state/environments";
import { readProject, useProjects } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { filesystemEnvironment } from "../../state/filesystem";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import {
  findProjectByPath,
  inferProjectTitleFromPath,
  ensureBrowseDirectoryPath,
  getBrowseParentPath,
} from "../../lib/projectPaths";
import { newProjectId } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { OnboardingProjectReadiness } from "./OnboardingProjectReadiness";
import { useEnvironmentQuery } from "../../state/query";
import {
  createOnboardingProjectDraftStore,
  emptyOnboardingProjectDraft,
  safeOnboardingRemoteUrl,
  type OnboardingProjectDraft,
  type OnboardingProjectCloneAttempt,
} from "../../onboarding/projectDraftStore";

export function OnboardingProjectStep({
  environmentIds,
  onProject,
  onImport,
  onPendingChange,
  onReviewProject,
  initialProjectRef,
}: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly onProject: (project: ScopedProjectRef) => Promise<boolean>;
  readonly onImport: () => void;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onReviewProject: (project: ScopedProjectRef) => Promise<boolean>;
  readonly initialProjectRef: ScopedProjectRef | null;
}) {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const [draftStore] = useState(createOnboardingProjectDraftStore);
  const selectedInitialProject =
    initialProjectRef && environmentIds.includes(initialProjectRef.environmentId)
      ? initialProjectRef
      : null;
  const [environmentId, setEnvironmentId] = useState(
    () => selectedInitialProject?.environmentId ?? draftStore.selectedEnvironment(environmentIds),
  );
  const [draftState, setDraftState] = useState(() => draftStore.read(environmentId));
  const { mode, path, remoteUrl } = draftState.draft;
  const cloneAttempt = draftState.draft.cloneAttempt;
  const readFailed = draftState.readFailed === true;
  const submitting = useRef(false);
  const admittedProject =
    environmentId && draftState.draft.admittedProjectId
      ? scopeProjectRef(environmentId, draftState.draft.admittedProjectId)
      : null;
  const updateDraft = (
    patch: Partial<Pick<OnboardingProjectDraft, "mode" | "path" | "remoteUrl">>,
  ) => {
    if (readFailed || cloneAttempt || submitting.current) return;
    // Editing the form explicitly starts a different intent; retries retain the accepted project.
    const draft = { ...draftState.draft, ...patch };
    if (draft.mode !== mode || draft.path !== path || draft.remoteUrl !== remoteUrl) {
      delete draft.admittedProjectId;
    }
    const error = environmentId ? draftStore.write(environmentId, draft) : null;
    setDraftState({ draft, error });
  };
  const discardDraft = () => {
    if (!environmentId) return;
    const error = draftStore.discard(environmentId);
    setDraftState((current) =>
      error ? { ...current, error } : { draft: emptyOnboardingProjectDraft(), error: null },
    );
    if (!error) {
      setBrowse(null);
      setError(null);
    }
  };
  const retryReadingDraft = () => {
    if (!environmentId || submitting.current) return;
    setDraftState(draftStore.read(environmentId));
    setError(null);
  };
  const [browse, setBrowse] = useState<FilesystemBrowseResult | null>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const browseHeadingRef = useRef<HTMLParagraphElement>(null);
  const focusAfterBrowse = useRef<"folder" | "path" | null>(null);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [createdPath, setCreatedPath] = useState("");
  const [createdProject, setCreatedProject] = useState<ScopedProjectRef | null>(
    selectedInitialProject,
  );
  useEffect(() => {
    onPendingChange(pending);
  }, [onPendingChange, pending]);
  useEffect(() => () => onPendingChange(false), [onPendingChange]);
  useEffect(() => {
    if (pending) return;
    const target =
      focusAfterBrowse.current === "path"
        ? pathInputRef.current
        : focusAfterBrowse.current === "folder"
          ? browseHeadingRef.current
          : null;
    if (target) {
      focusAfterBrowse.current = null;
      target.focus();
    }
  }, [browse, pending]);
  const [error, setError] = useState<string | null>(null);
  const create = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const clone = useAtomCommand(sourceControlEnvironment.startProjectClone, {
    reportFailure: false,
  });
  const legacyClone = useAtomCommand(sourceControlEnvironment.cloneRepository, {
    reportFailure: false,
  });
  const loadBrowse = useAtomQueryRunner(filesystemEnvironment.browse, { reportFailure: false });
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const available = environment?.connection.phase === "connected";
  const discovery = useEnvironmentQuery(
    environmentId && available
      ? sourceControlEnvironment.discovery({ environmentId, input: {} })
      : null,
  );
  const git = discovery.data?.versionControlSystems.find((item) => item.kind === "git");
  const gitMissing = git?.status === "missing";
  const github = discovery.data?.sourceControlProviders.find((item) => item.kind === "github");
  const showError = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : "Could not open this project. Try again.");
  const reviewProject = async (project: ScopedProjectRef, workspaceRoot: string) => {
    const draft = {
      ...draftState.draft,
      path: workspaceRoot,
      admittedProjectId: project.projectId,
    };
    delete draft.cloneAttempt;
    setCreatedPath(workspaceRoot);
    setDraftState({ draft, error: draftStore.write(project.environmentId, draft) });
    if ((await onReviewProject(project)) && mounted.current) {
      const error = draftStore.discard(project.environmentId);
      setDraftState(
        error ? { draft, error } : { draft: emptyOnboardingProjectDraft(), error: null },
      );
      setCreatedProject(project);
    }
  };
  const browsePath = async (partialPath: string) => {
    if (!environmentId || pending || readFailed || cloneAttempt) return;
    setPending(true);
    setError(null);
    try {
      const result = await loadBrowse({
        environmentId,
        input: { partialPath, cwd: environment?.serverConfig?.cwd },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      focusAfterBrowse.current = "folder";
      setBrowse(result.value);
    } catch (cause) {
      showError(cause);
    } finally {
      setPending(false);
    }
  };
  const chooseProject = async (project: ScopedProjectRef) => {
    if (readFailed) return;
    if (cloneAttempt && project.projectId !== cloneAttempt.projectId) return;
    setPending(true);
    setError(null);
    try {
      const workspaceRoot =
        projects.find(
          (item) => item.environmentId === project.environmentId && item.id === project.projectId,
        )?.workspaceRoot ?? path;
      await reviewProject(project, workspaceRoot);
    } catch (cause) {
      showError(cause);
    } finally {
      setPending(false);
    }
  };
  const submit = async () => {
    if (
      !environmentId ||
      !available ||
      pending ||
      readFailed ||
      submitting.current ||
      (!admittedProject &&
        !cloneAttempt &&
        (!path.trim() || (mode === "clone" && (gitMissing || discovery.isPending))))
    )
      return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      if (admittedProject) {
        await reviewProject(admittedProject, path);
        return;
      }
      const recoverCloneProject = async (attempt: OnboardingProjectCloneAttempt) => {
        if (!mounted.current) return false;
        const projectRef = scopeProjectRef(environmentId, attempt.projectId);
        const project = readProject(projectRef);
        if (!project) return false;
        await reviewProject(projectRef, project.workspaceRoot);
        return true;
      };
      if (cloneAttempt && (await recoverCloneProject(cloneAttempt))) return;
      const cwd = path.trim();
      const existing = findProjectByPath(
        projects.filter((entry) => entry.environmentId === environmentId),
        cwd,
      );
      if (existing && mode !== "clone") {
        setCreatedPath(existing.workspaceRoot);
        const projectRef = scopeProjectRef(environmentId, existing.id);
        await reviewProject(projectRef, existing.workspaceRoot);
        return;
      }
      const projectId = cloneAttempt?.projectId ?? newProjectId();
      if (
        cloneAttempt ||
        (mode === "clone" &&
          environment?.serverConfig?.environment.capabilities.projectCloneTracking === true)
      ) {
        const attempt = cloneAttempt ?? {
          projectId,
          title: inferProjectTitleFromPath(cwd),
          createdAt: new Date().toISOString(),
          remoteUrl: remoteUrl.trim(),
          destinationPath: cwd,
        };
        const draft = { ...draftState.draft, cloneAttempt: attempt };
        const saveError = draftStore.write(environmentId, draft);
        setDraftState({ draft, error: saveError });
        if (saveError) return;
        if (!attempt.remoteUrl) {
          throw new Error(
            "The original clone has not appeared yet. Its private URL was not saved. Reconnect to recover it, or discard this draft before starting another request.",
          );
        }
        if (environment?.serverConfig?.environment.capabilities.projectCloneTracking !== true) {
          throw new Error("Reconnect to a server with clone tracking to recover this request.");
        }
        let workspaceRoot: string;
        try {
          const result = await clone({ environmentId, input: attempt });
          if (!mounted.current) return;
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          workspaceRoot = result.value.cwd;
        } catch (cause) {
          if (!mounted.current || (await recoverCloneProject(attempt))) return;
          throw cause;
        }
        await reviewProject(scopeProjectRef(environmentId, attempt.projectId), workspaceRoot);
        return;
      } else {
        let workspaceRoot = cwd;
        if (mode === "clone") {
          const result = await legacyClone({
            environmentId,
            input: { remoteUrl: remoteUrl.trim(), destinationPath: cwd },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          workspaceRoot = result.value.cwd;
        }
        const result = await create({
          environmentId,
          input: {
            projectId,
            title: inferProjectTitleFromPath(workspaceRoot),
            workspaceRoot,
            createWorkspaceRootIfMissing: mode === "create",
            defaultModelSelection: null,
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      }
      const projectRef = scopeProjectRef(environmentId, projectId);
      setCreatedPath(cwd);
      await reviewProject(projectRef, cwd);
    } catch (cause) {
      if (mounted.current) showError(cause);
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const selectedProjectCwd =
    projects.find(
      (project) =>
        project.environmentId === createdProject?.environmentId &&
        project.id === createdProject?.projectId,
    )?.workspaceRoot ?? createdPath;
  if (createdProject && !readFailed) {
    if (!selectedProjectCwd)
      return (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Waiting for your selected project. Reconnect its computer or choose another project.
          </p>
          <Button variant="outline" onClick={() => setCreatedProject(null)}>
            Choose another project
          </Button>
        </div>
      );
    return (
      <div className="space-y-3">
        {draftState.error && admittedProject ? (
          <div className="space-y-2">
            <p role="status" className="text-xs text-muted-foreground">
              {draftState.error}
            </p>
            <Button type="button" variant="ghost" disabled={pending} onClick={discardDraft}>
              Retry discarding draft
            </Button>
          </div>
        ) : null}
        <OnboardingProjectReadiness
          project={createdProject}
          cwd={selectedProjectCwd}
          onContinue={() => onProject(createdProject)}
          onBack={() => setCreatedProject(null)}
          onPendingChange={onPendingChange}
        />
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Choose your first project</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Choose a repository for your long-lived specialists. Meerkat can study its domains and
          propose agents that work together across tasks and projects.
        </p>
      </div>
      {environmentIds.length > 1 ? (
        <label className="block space-y-1 text-sm">
          Computer
          <select
            className="w-full rounded-md border border-input bg-background p-2"
            value={environmentId}
            disabled={pending}
            onChange={(event) => {
              if (submitting.current) return;
              const next = environmentIds.find((id) => id === event.target.value);
              setEnvironmentId(next);
              if (next) draftStore.selectEnvironment(next);
              setDraftState(draftStore.read(next));
              setBrowse(null);
              setError(null);
              setCreatedProject(null);
            }}
          >
            {environments
              .filter((entry) => environmentIds.includes(entry.environmentId))
              .map((entry) => (
                <option key={entry.environmentId} value={entry.environmentId}>
                  {entry.label}
                </option>
              ))}
          </select>
        </label>
      ) : (
        <p className="text-xs text-muted-foreground">
          Files and commands stay on {environment?.label ?? "the selected computer"}.
        </p>
      )}
      <div className="grid grid-cols-3 gap-2">
        {(
          [
            { id: "open", label: "Open folder", Icon: FolderOpenIcon },
            { id: "create", label: "Create project", Icon: FolderPlusIcon },
            { id: "clone", label: "Clone repository", Icon: GitForkIcon },
          ] as const
        ).map(({ id, label, Icon }) => (
          <Button
            key={id}
            variant={mode === id ? "secondary" : "outline"}
            size="sm-multiline"
            disabled={pending || readFailed || Boolean(cloneAttempt)}
            aria-pressed={mode === id}
            onClick={() => {
              if (readFailed) return;
              updateDraft({ mode: id });
              setError(null);
              setCreatedProject(null);
            }}
          >
            <Icon className="size-4 shrink-0" />
            {label}
          </Button>
        ))}
      </div>
      {mode === "clone" ? (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            {discovery.isPending
              ? "Checking Git on this computer..."
              : gitMissing
                ? "Install Git on this computer before cloning."
                : git?.status === "available"
                  ? "Git is available for cloning."
                  : "Git availability has not been confirmed."}
          </p>
          {github ? (
            <p>
              {github.status === "missing"
                ? "The GitHub CLI is not installed. Git can still clone accessible URLs; GitHub pull request actions need the CLI."
                : github.auth.status === "authenticated"
                  ? "A GitHub CLI account is connected on this computer."
                  : github.auth.status === "unauthenticated"
                    ? "The GitHub CLI is not signed in. Private repositories may need Git credentials before cloning."
                    : "GitHub sign-in has not been confirmed. Private repositories may need Git credentials before cloning."}
            </p>
          ) : null}
          {gitMissing ? (
            <p>
              {
                discovery.data?.versionControlSystems.find((item) => item.kind === "git")
                  ?.installHint
              }
            </p>
          ) : null}
          {discovery.error || gitMissing ? (
            <Button variant="ghost" size="xs" onClick={discovery.refresh}>
              Check again
            </Button>
          ) : null}
        </div>
      ) : null}
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {mode === "clone" ? (
          <label className="block space-y-1 text-sm">
            Repository URL
            <Input
              value={remoteUrl}
              onChange={(event) => {
                if (readFailed) return;
                updateDraft({ remoteUrl: event.target.value });
                setCreatedProject(null);
              }}
              placeholder="https://github.com/owner/repository.git"
              disabled={pending || readFailed || Boolean(cloneAttempt)}
              required={!admittedProject && !cloneAttempt}
            />
          </label>
        ) : null}
        <label className="block space-y-1 text-sm">
          {mode === "open" ? "Project folder" : "New folder path"}
          <div className="flex gap-2">
            <Input
              ref={pathInputRef}
              value={path}
              onChange={(event) => {
                if (readFailed) return;
                updateDraft({ path: event.target.value });
                setCreatedProject(null);
              }}
              placeholder={environment?.serverConfig?.cwd ?? "/path/to/project"}
              disabled={pending || readFailed || Boolean(cloneAttempt)}
              required
            />
            <Button
              type="button"
              variant="outline"
              disabled={!available || pending || readFailed || Boolean(cloneAttempt)}
              onClick={() => void browsePath(path || environment?.serverConfig?.cwd || "~")}
            >
              Browse
            </Button>
          </div>
        </label>
        {browse ? (
          <div className="max-h-44 overflow-auto rounded-md border border-border p-2">
            <div className="flex items-center justify-between gap-2">
              <p
                ref={browseHeadingRef}
                tabIndex={-1}
                className="min-w-0 break-all text-xs text-muted-foreground"
              >
                <span className="sr-only">Current folder: </span>
                {browse.parentPath}
              </p>
              <Button
                size="xs"
                variant="secondary"
                type="button"
                disabled={pending}
                onClick={() => {
                  focusAfterBrowse.current = "path";
                  updateDraft({ path: browse.parentPath });
                  setBrowse(null);
                  setCreatedProject(null);
                }}
              >
                Use folder
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                const parent = getBrowseParentPath(browse.parentPath);
                if (parent) void browsePath(parent);
              }}
            >
              Parent folder
            </Button>
            {browse.entries.map((entry) => (
              <Button
                key={entry.fullPath}
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                disabled={pending}
                onClick={() => {
                  updateDraft({ path: entry.fullPath });
                  setCreatedProject(null);
                  void browsePath(ensureBrowseDirectoryPath(entry.fullPath));
                }}
              >
                <FolderOpenIcon className="size-3.5" />
                {entry.name}
              </Button>
            ))}
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {mode === "open"
            ? "Choose an existing folder. Its files stay in place."
            : mode === "create"
              ? "Enter a new folder name after its parent path. The folder will be created for you."
              : "Choose a new empty destination. Private repositories use Git credentials configured on this computer."}
        </p>
        {!available ? (
          <p role="status" className="text-sm text-muted-foreground">
            Reconnect this computer to continue, or go back to choose another.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {draftState.error ? (
          <p role="status" className="text-xs text-muted-foreground">
            {draftState.error}
          </p>
        ) : null}
        {readFailed ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Retry reading your saved draft before continuing, or discard it to start again.
              Discarding does not cancel a clone that may already be running.
            </p>
            <Button type="button" variant="outline" disabled={pending} onClick={retryReadingDraft}>
              Retry reading draft
            </Button>
          </div>
        ) : null}
        {admittedProject ? (
          <p role="status" className="text-xs text-muted-foreground">
            Project setup has already started. Continue setup to review it without creating or
            cloning it again. Editing these fields starts a new setup request.
          </p>
        ) : null}
        {cloneAttempt ? (
          <p role="status" className="text-xs text-muted-foreground">
            This clone has not been confirmed yet. Recover it using the original request. Discarding
            this draft lets you choose another project; it does not cancel cloning.
          </p>
        ) : null}
        {remoteUrl.trim() && !safeOnboardingRemoteUrl(remoteUrl) ? (
          <p className="text-xs text-muted-foreground">
            Only complete repository URLs without credentials or query parameters are saved. This
            URL stays in the open form.
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          {mode !== "open" || path || remoteUrl || draftState.error ? (
            <Button type="button" variant="ghost" disabled={pending} onClick={discardDraft}>
              Discard draft
            </Button>
          ) : null}
          <Button
            type="submit"
            disabled={
              pending ||
              readFailed ||
              !available ||
              (!admittedProject &&
                !cloneAttempt &&
                (!path.trim() ||
                  (mode === "clone" && (!remoteUrl.trim() || gitMissing || discovery.isPending))))
            }
          >
            {pending
              ? "Opening project..."
              : admittedProject
                ? "Continue setup"
                : cloneAttempt
                  ? "Recover clone"
                  : mode === "clone"
                    ? "Clone and open"
                    : "Open project"}
          </Button>
        </div>
      </form>
      {projects.some((project) => project.environmentId === environmentId) ? (
        <div className="space-y-1 border-t border-border pt-3">
          <p className="text-xs text-muted-foreground">Or continue with an existing project</p>
          {projects
            .filter((project) => project.environmentId === environmentId)
            .map((project) => (
              <Button
                key={project.id}
                variant="ghost"
                size="sm"
                disabled={
                  pending ||
                  readFailed ||
                  !available ||
                  Boolean(cloneAttempt && cloneAttempt.projectId !== project.id)
                }
                onClick={() =>
                  void chooseProject(scopeProjectRef(project.environmentId, project.id))
                }
              >
                {project.title}
              </Button>
            ))}
        </div>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        disabled={pending || readFailed}
        onClick={() => {
          if (!readFailed) onImport();
        }}
      >
        Import Claude Code or Codex history...
      </Button>
    </div>
  );
}

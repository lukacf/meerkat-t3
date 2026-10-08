import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ProjectListEntriesResult,
  ProjectReadFileError,
  type ProjectReadFileResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { useProjectPathSearch } from "~/state/queries";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { fileEditRecoveryStore, type FileEditRecoveryWrite } from "./fileEditRecoveryStore";

const EMPTY_PROJECT_FILE_PATH = "";
const EMPTY_PROJECT_FILE_QUERY_ATOM = Atom.make(
  AsyncResult.initial<ProjectReadFileResult, never>(false),
).pipe(Atom.withLabel("project-file-query:empty"));
/** A pending in-app write to the file, overlaying the query until confirmed. */
export function optimisticFileAtom(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
) {
  return projectEnvironment.optimisticFile({ environmentId, cwd, relativePath });
}

// Only unconfirmed edits outlive their last view. Confirmed and clean files
// retain the registry's normal disposal policy.
const pendingFileLeases = new WeakMap<ReturnType<typeof optimisticFileAtom>, () => void>();
const recoveryWrites = new WeakMap<ProjectReadFileResult, FileEditRecoveryWrite>();

function releasePendingFile(atom: ReturnType<typeof optimisticFileAtom>): void {
  const release = pendingFileLeases.get(atom);
  pendingFileLeases.delete(atom);
  release?.();
}

interface ProjectQueryState<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

interface ProjectFileQueryState extends ProjectQueryState<ProjectReadFileResult> {
  /** The path exists but is not a regular file, typically a directory. */
  readonly isNotFile: boolean;
  readonly saveFailed: boolean;
}

function getProjectEntriesQueryAtom(
  environmentId: EnvironmentId,
  cwd: string,
  directoryPath?: string,
) {
  return projectEnvironment.listEntries({
    environmentId,
    input: { cwd, ...(directoryPath !== undefined ? { directoryPath } : {}) },
  });
}

export function getProjectFileQueryAtom(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
) {
  return projectEnvironment.readFile({
    environmentId,
    input: { cwd, relativePath: relativePath ?? EMPTY_PROJECT_FILE_PATH },
  });
}

export function setProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): void {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  if (!pendingFileLeases.has(atom)) {
    pendingFileLeases.set(atom, appAtomRegistry.mount(atom));
  }
  const data = {
    relativePath,
    contents,
    byteLength: new TextEncoder().encode(contents).byteLength,
    truncated: false,
  };
  recoveryWrites.set(
    data,
    fileEditRecoveryStore.capture({ environmentId, cwd, relativePath }, contents),
  );
  appAtomRegistry.set(atom, {
    confirmedAgainst: undefined,
    data,
  });
}

export function markProjectFileSaveFailed(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): void {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  const optimistic = appAtomRegistry.get(atom);
  if (optimistic?.data.contents !== contents || optimistic.confirmedAgainst !== undefined) return;
  appAtomRegistry.set(atom, { ...optimistic, saveFailed: true });
}

export function getOptimisticProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): ProjectReadFileResult | null {
  return appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath))?.data ?? null;
}

export function hasPendingProjectFileEdit(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): boolean {
  const optimistic = appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath));
  return optimistic !== null && optimistic.confirmedAgainst === undefined;
}

/** Await a new disk read before a restored file becomes editable again. */
export async function refreshRestoredProjectFile(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): Promise<void> {
  const optimisticAtom = optimisticFileAtom(environmentId, cwd, relativePath);
  const previousOptimistic = appAtomRegistry.get(optimisticAtom);
  const queryAtom = getProjectFileQueryAtom(environmentId, cwd, relativePath);
  // Also replace an in-flight read that began before the restore RPC completed.
  appAtomRegistry.refresh(queryAtom);
  await executeAtomQuery(appAtomRegistry, queryAtom, {
    reportDefect: false,
    reportFailure: false,
  });
  // A restore may supersede the confirming read from an earlier successful
  // save. Its old overlay must not mask the new disk contents or a deletion.
  if (
    previousOptimistic !== null &&
    previousOptimistic.confirmedAgainst !== undefined &&
    appAtomRegistry.get(optimisticAtom) === previousOptimistic
  ) {
    appAtomRegistry.set(optimisticAtom, null);
  }
}

export function confirmProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): boolean {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  const optimisticFile = appAtomRegistry.get(atom);
  if (optimisticFile?.data.contents !== contents) return false;

  const recoveryWrite = recoveryWrites.get(optimisticFile.data);
  if (recoveryWrite) fileEditRecoveryStore.confirm(recoveryWrite);

  const queryAtom = getProjectFileQueryAtom(environmentId, cwd, relativePath);
  const confirmed = {
    ...optimisticFile,
    confirmedAgainst: appAtomRegistry.get(queryAtom),
    saveFailed: false,
  };
  appAtomRegistry.set(atom, confirmed);
  releasePendingFile(atom);
  appAtomRegistry.refresh(queryAtom);
  void executeAtomQuery(appAtomRegistry, queryAtom, {
    reportDefect: false,
    reportFailure: false,
  }).then((result) => {
    if (result._tag === "Success" && appAtomRegistry.get(atom) === confirmed) {
      appAtomRegistry.set(atom, null);
    }
  });
  return true;
}

export function resolveProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
  data: ProjectReadFileResult | null,
): ProjectReadFileResult | null {
  if (relativePath === null) return data;
  return appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath))?.data ?? data;
}

export function clearProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): void {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  appAtomRegistry.set(atom, null);
  releasePendingFile(atom);
}

function failureCause<A>(result: AsyncResult.AsyncResult<A, unknown>): unknown {
  return result._tag === "Failure" ? Cause.squash(result.cause) : null;
}

function errorMessage(cause: unknown): string | null {
  if (cause === null) return null;
  return cause instanceof Error ? cause.message : "Workspace query failed.";
}

const isProjectReadFileError = Schema.is(ProjectReadFileError);

export function useProjectEntriesQuery(
  environmentId: EnvironmentId,
  cwd: string,
  directoryPath?: string,
): ProjectQueryState<ProjectListEntriesResult> {
  const atom = getProjectEntriesQueryAtom(environmentId, cwd, directoryPath);
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = useCallback(() => refreshAtom(), [refreshAtom]);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: errorMessage(failureCause(result)),
    isPending: result.waiting,
    refresh,
  };
}

/**
 * Backing query for the project file picker: a debounced, bounded, file-only
 * server search. An empty query is a valid request — the index answers it
 * with frecency-ordered files, so the picker's initial view is recent files
 * without transferring the full workspace listing. `matchedQuery` is the
 * query the returned entries were computed for, so the caller can highlight
 * against results instead of half-typed input.
 */
export function useProjectFilePickerQuery(
  environmentId: EnvironmentId,
  cwd: string,
  query: string,
  limit: number,
  options?: { readonly imageOnly?: boolean },
) {
  const search = useProjectPathSearch(
    {
      environmentId,
      cwd,
      query,
      kind: "file",
      ...(options?.imageOnly ? { imageOnly: true } : {}),
    },
    limit,
    { allowEmptyQuery: true },
  );

  return {
    entries: search.isPending ? [] : search.entries,
    error: search.error,
    isPending: search.isPending,
    matchedQuery: search.searchedQuery,
  };
}

export function useProjectFileQuery(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
  enabled = true,
): ProjectFileQueryState {
  // The caller decides what to read. A media path is not skipped here: a folder
  // named `assets.png` is only knowable as a folder from the read failure.
  const atom = enabled
    ? getProjectFileQueryAtom(environmentId, cwd, relativePath)
    : EMPTY_PROJECT_FILE_QUERY_ATOM;
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = useCallback(() => refreshAtom(), [refreshAtom]);
  const data = Option.getOrNull(AsyncResult.value(result));
  const optimisticResult = useAtomValue(
    optimisticFileAtom(environmentId, cwd, relativePath ?? EMPTY_PROJECT_FILE_PATH),
  );
  const optimisticFile = relativePath === null ? null : optimisticResult;
  const cause = failureCause(result);

  return {
    data: optimisticFile?.data ?? data,
    error: errorMessage(cause),
    isNotFile: isProjectReadFileError(cause) && cause.failure === "path_not_file",
    saveFailed: optimisticFile?.saveFailed === true,
    isPending: result.waiting,
    refresh,
  };
}

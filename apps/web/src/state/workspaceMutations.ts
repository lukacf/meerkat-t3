import type { EnvironmentId } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { create } from "zustand";

export interface WorkspaceMutationTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  /** Aliases verified by the server for this exact workspace, never inferred by the browser. */
  readonly aliases?: ReadonlyArray<string>;
}

interface WorkspaceMutationState {
  readonly revisions: Readonly<Record<string, number>>;
  readonly restoringFiles: ReadonlySet<string>;
}

const useWorkspaceMutationStore = create<WorkspaceMutationState>(() => ({
  revisions: {},
  restoringFiles: new Set(),
}));
const pendingEditorsByFile = new Map<string, Set<symbol>>();

function workspaceKey(target: WorkspaceMutationTarget): string {
  return JSON.stringify([target.environmentId, normalizeProjectPathForComparison(target.cwd)]);
}

function fileKey(target: WorkspaceMutationTarget, relativePath: string): string {
  return JSON.stringify([workspaceKey(target), relativePath]);
}

export function workspaceMutationPaths(target: WorkspaceMutationTarget): ReadonlyArray<string> {
  return [...new Set([target.cwd, ...(target.aliases ?? [])])];
}

/** Consumer file mutations supplement the provider activity already driving refresh. */
export function publishWorkspaceMutation(target: WorkspaceMutationTarget): void {
  const keys = new Set(
    workspaceMutationPaths(target).map((cwd) => workspaceKey({ ...target, cwd })),
  );
  useWorkspaceMutationStore.setState((state) => {
    const revisions = { ...state.revisions };
    for (const key of keys) revisions[key] = (revisions[key] ?? 0) + 1;
    return { revisions };
  });
}

export function useWorkspaceMutationId(
  environmentId: EnvironmentId | null,
  cwd: string | null | undefined,
  providerMutationId: string | null,
): string | null {
  const key = environmentId !== null && cwd ? workspaceKey({ environmentId, cwd }) : null;
  const revision = useWorkspaceMutationStore((state) => (key ? (state.revisions[key] ?? 0) : 0));
  return revision === 0 ? providerMutationId : JSON.stringify([providerMutationId, revision]);
}

export function isWorkspaceFileRestoring(
  target: WorkspaceMutationTarget,
  relativePath: string,
): boolean {
  return useWorkspaceMutationStore.getState().restoringFiles.has(fileKey(target, relativePath));
}

/** Keep every editor's pending write visible, including a final unmount flush. */
export function setWorkspaceFileEditPending(
  target: WorkspaceMutationTarget,
  relativePath: string,
  editor: symbol,
  pending: boolean,
): void {
  const key = fileKey(target, relativePath);
  const editors = pendingEditorsByFile.get(key) ?? new Set<symbol>();
  if (pending) editors.add(editor);
  else editors.delete(editor);
  if (editors.size > 0) pendingEditorsByFile.set(key, editors);
  else pendingEditorsByFile.delete(key);
}

export function useWorkspaceFileRestoring(
  target: WorkspaceMutationTarget,
  relativePath: string | null,
): boolean {
  const key = relativePath === null ? null : fileKey(target, relativePath);
  return useWorkspaceMutationStore((state) => key !== null && state.restoringFiles.has(key));
}

/**
 * The pending check and lock happen synchronously before starting the RPC.
 * Hold the lock through the read-back so editors cannot save pre-restore text.
 */
export async function withWorkspaceRestore<A>(
  target: WorkspaceMutationTarget,
  paths: ReadonlyArray<string>,
  hasPendingEdit: (path: string, cwd: string) => boolean,
  restoreAndRefresh: () => Promise<A>,
): Promise<A> {
  const state = useWorkspaceMutationStore.getState();
  const workspaces = workspaceMutationPaths(target);
  const pendingPath = paths.find((path) =>
    workspaces.some(
      (cwd) =>
        pendingEditorsByFile.has(fileKey({ ...target, cwd }, path)) || hasPendingEdit(path, cwd),
    ),
  );
  if (pendingPath !== undefined) {
    throw new Error(`Wait for pending edits in ${pendingPath} to save before restoring it.`);
  }
  const keys = paths.flatMap((path) => workspaces.map((cwd) => fileKey({ ...target, cwd }, path)));
  if (keys.some((key) => state.restoringFiles.has(key))) {
    throw new Error("A restore is already in progress for one of the selected files.");
  }
  useWorkspaceMutationStore.setState({
    restoringFiles: new Set([...state.restoringFiles, ...keys]),
  });
  try {
    return await restoreAndRefresh();
  } finally {
    useWorkspaceMutationStore.setState((current) => {
      const restoringFiles = new Set(current.restoringFiles);
      for (const key of keys) restoringFiles.delete(key);
      return { restoringFiles };
    });
  }
}

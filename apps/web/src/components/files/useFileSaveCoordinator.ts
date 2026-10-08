import type { EnvironmentId, ProjectReadFileResult } from "@t3tools/contracts";
import { createRef, useEffect, useMemo } from "react";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { isWorkspaceFileRestoring, setWorkspaceFileEditPending } from "~/state/workspaceMutations";

import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  markProjectFileSaveFailed,
} from "./projectFilesQueryState";

const FILE_SAVE_DEBOUNCE_MS = 500;

interface FileSaveOptions {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  onPendingChange: (relativePath: string, pending: boolean) => void;
}

export function useFileSaveCoordinator({
  environmentId,
  cwd,
  relativePath,
  onPendingChange,
}: FileSaveOptions): { readonly change: (contents: string) => boolean } {
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const session = useMemo(() => {
    const coordinatorRef = createRef<FileSaveCoordinator>();
    return {
      change: (contents: string) => {
        if (
          !coordinatorRef.current ||
          isWorkspaceFileRestoring({ environmentId, cwd }, relativePath)
        ) {
          return false;
        }
        coordinatorRef.current.change(contents);
        return true;
      },
      setup: () => {
        const editor = Symbol("file-editor");
        let savingFile: ProjectReadFileResult | null = null;
        const isCurrentSave = () =>
          savingFile !== null &&
          getOptimisticProjectFileQueryData(environmentId, cwd, relativePath) === savingFile;
        const coordinator = new FileSaveCoordinator({
          debounceMs: FILE_SAVE_DEBOUNCE_MS,
          onPendingChange: (pending) => {
            setWorkspaceFileEditPending({ environmentId, cwd }, relativePath, editor, pending);
            onPendingChange(relativePath, pending);
          },
          onSaveSettled: () => {
            setWorkspaceFileEditPending({ environmentId, cwd }, relativePath, editor, false);
          },
          persist: (nextContents) => {
            // This coordinator has one write in flight. A new edit, even one
            // with identical text in another pane, must keep its own recovery state.
            savingFile = getOptimisticProjectFileQueryData(environmentId, cwd, relativePath);
            if (isWorkspaceFileRestoring({ environmentId, cwd }, relativePath)) {
              return Promise.resolve(
                AsyncResult.failure(
                  Cause.fail(new Error("The file is being restored. The unsaved edit was kept.")),
                ),
              );
            }
            // A failed save can retry while the editor unmounts.
            setWorkspaceFileEditPending({ environmentId, cwd }, relativePath, editor, true);
            return writeFile({
              environmentId,
              input: { cwd, relativePath, contents: nextContents },
            });
          },
          onConfirmed: (confirmedContents) => {
            if (!isCurrentSave()) return;
            confirmProjectFileQueryData(environmentId, cwd, relativePath, confirmedContents);
          },
          onSaveFailed: (failedContents) => {
            if (!isCurrentSave()) return;
            markProjectFileSaveFailed(environmentId, cwd, relativePath, failedContents);
          },
        });
        coordinatorRef.current = coordinator;
        return () => {
          coordinatorRef.current = null;
          coordinator.dispose();
        };
      },
    };
  }, [cwd, environmentId, onPendingChange, relativePath, writeFile]);

  // StrictMode replays effect setup. Retired file sessions stay inert, while the
  // replay gets a fresh coordinator instead of reusing a disposed one.
  useEffect(session.setup, [session]);
  return session;
}

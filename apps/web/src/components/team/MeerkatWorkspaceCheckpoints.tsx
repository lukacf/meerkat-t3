import type { EnvironmentId, MeerkatCheckpointTarget } from "@t3tools/contracts";
import { Cause } from "effect";
import { useMemo } from "react";
import { meerkatControlsEnvironment } from "../../state/meerkatControls";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import {
  publishWorkspaceMutation,
  withWorkspaceRestore,
  workspaceMutationPaths,
} from "../../state/workspaceMutations";
import { vcsEnvironment } from "../../state/vcs";
import {
  hasPendingProjectFileEdit,
  refreshRestoredProjectFile,
} from "../files/projectFilesQueryState";
import {
  NativeWorkspaceCheckpoints,
  type NativeWorkspaceCheckpointApi,
} from "./NativeWorkspaceCheckpoints";
import { readRestoreReviewWorkBlock } from "./useRestoreReview";

export function MeerkatWorkspaceCheckpoints({
  environmentId,
  target,
  onRestored,
  offerCapture,
}: {
  environmentId: EnvironmentId;
  target: MeerkatCheckpointTarget;
  onRestored?: () => void;
  offerCapture?: boolean;
}) {
  const list = useAtomQueryRunner(meerkatControlsEnvironment.checkpoints, {
    reportFailure: false,
    refresh: true,
  });
  const preview = useAtomQueryRunner(meerkatControlsEnvironment.checkpointPreview, {
    reportFailure: false,
    refresh: true,
  });
  const capture = useAtomCommand(meerkatControlsEnvironment.checkpointCapture, {
    reportFailure: false,
  });
  const restore = useAtomCommand(meerkatControlsEnvironment.checkpointRestore, {
    reportFailure: false,
  });
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const { projectId, instanceId, agentRef, threadId } = target;
  const api = useMemo<NativeWorkspaceCheckpointApi>(() => {
    const input = {
      projectId,
      instanceId,
      ...(agentRef ? { agentRef } : {}),
      ...(threadId ? { threadId } : {}),
    };
    return {
      capture: async () => {
        const restoreBlock = readRestoreReviewWorkBlock(environmentId);
        if (restoreBlock) throw Error(restoreBlock);
        const result = await capture({ environmentId, input });
        if (result._tag === "Failure") throw Error(Cause.pretty(result.cause));
        return result.value;
      },
      list: async () => {
        const result = await list({ environmentId, input });
        if (result._tag === "Failure") throw Error(Cause.pretty(result.cause));
        return result.value;
      },
      preview: async (checkpointId) => {
        const result = await preview({ environmentId, input: { ...input, checkpointId } });
        if (result._tag === "Failure") throw Error(Cause.pretty(result.cause));
        return result.value;
      },
      restore: (checkpoint, files) => {
        const restoreBlock = readRestoreReviewWorkBlock(environmentId);
        if (restoreBlock) return Promise.reject(Error(restoreBlock));
        const workspace = {
          environmentId,
          cwd: checkpoint.workspace,
          aliases: checkpoint.workspacePath ? [checkpoint.workspacePath] : [],
        };
        const workspacePaths = workspaceMutationPaths(workspace);
        return withWorkspaceRestore(
          workspace,
          files.map((file) => file.path),
          (path, cwd) => hasPendingProjectFileEdit(environmentId, cwd, path),
          async () => {
            const result = await restore({
              environmentId,
              input: { ...input, checkpointId: checkpoint.id, files },
            });
            if (result._tag === "Failure") throw Error(Cause.pretty(result.cause));
            if (result.value.restored.length > 0) {
              publishWorkspaceMutation(workspace);
              await Promise.all(
                workspacePaths.flatMap((cwd) =>
                  result.value.restored.map((path) =>
                    refreshRestoredProjectFile(environmentId, cwd, path),
                  ),
                ),
              );
              for (const cwd of workspacePaths)
                void refreshVcsStatus({ environmentId, input: { cwd } });
            }
            return result.value;
          },
        );
      },
    };
  }, [
    environmentId,
    projectId,
    instanceId,
    agentRef,
    threadId,
    list,
    preview,
    restore,
    capture,
    refreshVcsStatus,
  ]);
  return (
    <NativeWorkspaceCheckpoints
      api={api}
      targetKey={`${environmentId}:${projectId}:${instanceId}:${agentRef ?? threadId}`}
      {...(onRestored ? { onRestored } : {})}
      {...(offerCapture ? { offerCapture: true } : {})}
    />
  );
}

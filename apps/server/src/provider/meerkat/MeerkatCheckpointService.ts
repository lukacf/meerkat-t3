import {
  MeerkatCheckpointError,
  type MeerkatCheckpointTarget,
  type MeerkatCheckpointPreviewInput,
  type MeerkatCheckpointRestoreInput,
  type MeerkatWorkspaceCheckpoint,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { requireRestoreReviewReleased } from "../../restoreReview.ts";
import {
  makeMeerkatCheckpointStore,
  type MeerkatCheckpointScope,
} from "./MeerkatCheckpointStore.ts";

/** Bind authenticated application targets to canonical native execution workspaces at the edge. */
export const makeMeerkatCheckpointService = (
  resolve: (target: MeerkatCheckpointTarget) => Effect.Effect<
    {
      scope: MeerkatCheckpointScope;
      workspacePath?: string;
      assertWriteSafe: Effect.Effect<void, MeerkatCheckpointError>;
    },
    MeerkatCheckpointError
  >,
  existingStore: Effect.Success<typeof makeMeerkatCheckpointStore>,
) => {
  const store = existingStore;
  const withWorkspacePath = (checkpoint: MeerkatWorkspaceCheckpoint, workspacePath?: string) =>
    workspacePath === undefined ? checkpoint : { ...checkpoint, workspacePath };
  return {
    capture: (input: MeerkatCheckpointTarget) =>
      requireRestoreReviewReleased.pipe(
        Effect.mapError((cause) => new MeerkatCheckpointError({ message: cause.message })),
        Effect.andThen(resolve(input)),
        Effect.flatMap(({ scope, assertWriteSafe, workspacePath }) =>
          store
            .capture(scope, assertWriteSafe)
            .pipe(Effect.map((checkpoint) => withWorkspacePath(checkpoint, workspacePath))),
        ),
      ),
    list: (input: MeerkatCheckpointTarget) =>
      resolve(input).pipe(
        Effect.flatMap(({ scope, workspacePath }) =>
          store.list(scope).pipe(
            Effect.map((result) => ({
              ...result,
              checkpoints: result.checkpoints.map((checkpoint) =>
                withWorkspacePath(checkpoint, workspacePath),
              ),
            })),
          ),
        ),
      ),
    preview: (input: MeerkatCheckpointPreviewInput) =>
      resolve(input).pipe(
        Effect.flatMap(({ scope, workspacePath }) =>
          store.preview(scope, input.checkpointId).pipe(
            Effect.map((result) => ({
              ...result,
              checkpoint: withWorkspacePath(result.checkpoint, workspacePath),
            })),
          ),
        ),
      ),
    restore: (input: MeerkatCheckpointRestoreInput) =>
      requireRestoreReviewReleased.pipe(
        Effect.mapError((cause) => new MeerkatCheckpointError({ message: cause.message })),
        Effect.andThen(resolve(input)),
        Effect.flatMap(({ scope, assertWriteSafe }) =>
          store.restore(scope, input.checkpointId, input.files, assertWriteSafe),
        ),
      ),
  };
};

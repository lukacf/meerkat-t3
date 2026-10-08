import { MeerkatCheckpointError, type MeerkatCheckpointTarget } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { meerkatProjectStateRoot } from "../Layers/MeerkatAdapter.ts";
import { makeMeerkatCheckpointService } from "./MeerkatCheckpointService.ts";
import { MeerkatCheckpointStoreService } from "./MeerkatCheckpointStore.ts";
import type { makeMeerkatTeamService } from "./MeerkatTeamService.ts";

const decodeScope = Schema.decodeUnknownSync(
  Schema.Struct({
    projectPath: Schema.String,
    workspace: Schema.String,
    stateRoot: Schema.String,
    mobId: Schema.String,
    sessionId: Schema.String,
    runtimeGeneration: Schema.String,
    workspaceStatus: Schema.Literals(["idle", "busy", "unknown"]),
    workspaceBusy: Schema.Boolean,
    workspaceGeneration: Schema.String,
  }),
);
const fail = (cause: unknown) =>
  new MeerkatCheckpointError({
    message: cause instanceof Error ? cause.message : String(cause),
  });

/** The client selects a conversation; native ownership supplies all filesystem scope. */
export const makeMeerkatWorkspaceCheckpoints = Effect.fn("makeMeerkatWorkspaceCheckpoints")(
  function* (team: Pick<Effect.Success<typeof makeMeerkatTeamService>, "interactionTarget">) {
    const registry = yield* ProviderInstanceRegistry;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const store = yield* MeerkatCheckpointStoreService;
    const resolve = Effect.fn("MeerkatWorkspaceCheckpoints.resolve")(function* (
      input: MeerkatCheckpointTarget,
    ) {
      const instance = yield* registry.getInstance(input.instanceId);
      if (!instance?.enabled || !instance.meerkatControls || !instance.meerkatTeam)
        return yield* fail("Connect the original Meerkat provider to inspect workspace snapshots.");
      const target = yield* team
        .interactionTarget({
          projectId: input.projectId,
          instanceId: input.instanceId,
          ...(input.agentRef ? { agentRef: input.agentRef } : {}),
          ...(input.threadId ? { threadId: input.threadId } : {}),
        })
        .pipe(Effect.mapError(fail));
      if (!target.record.session_id) return yield* fail("This conversation has no native session.");
      const params = {
        projectPath: target.projectPath,
        workspace: target.projectPath,
        stateRoot:
          target.stateRoot ??
          meerkatProjectStateRoot(path, target.reader.stateRoot, target.projectPath),
        mobId: target.mobId,
        sessionId: target.record.session_id,
        includeWorkspaceStatus: true,
      };
      const readScope = Effect.tryPromise({
        try: async () =>
          decodeScope(await instance.meerkatControls!.request("mobs.v1.checkpointScope", params)),
        catch: fail,
      });
      const scope = yield* readScope;
      const canonicalPaths = yield* Effect.all({
        projectPath: fs.realPath(params.projectPath),
        workspace: fs.realPath(params.workspace),
        stateRoot: fs.realPath(params.stateRoot),
      }).pipe(Effect.mapError(fail));
      if (
        scope.sessionId !== params.sessionId ||
        scope.mobId !== params.mobId ||
        scope.projectPath !== canonicalPaths.projectPath ||
        scope.workspace !== canonicalPaths.workspace ||
        scope.stateRoot !== canonicalPaths.stateRoot
      )
        return yield* fail("The native snapshot owner changed. Refresh the conversation.");
      if ((yield* registry.getInstance(input.instanceId)) !== instance)
        return yield* fail("The Meerkat connection changed while resolving this snapshot.");
      const assertWriteSafe = Effect.gen(function* () {
        if ((yield* registry.getInstance(input.instanceId)) !== instance)
          return yield* fail("The Meerkat connection changed. Refresh the snapshot preview.");
        const current = yield* readScope;
        const currentPaths = yield* Effect.all({
          projectPath: fs.realPath(params.projectPath),
          workspace: fs.realPath(params.workspace),
          stateRoot: fs.realPath(params.stateRoot),
        }).pipe(Effect.mapError(fail));
        if (
          (yield* registry.getInstance(input.instanceId)) !== instance ||
          currentPaths.projectPath !== canonicalPaths.projectPath ||
          currentPaths.workspace !== canonicalPaths.workspace ||
          currentPaths.stateRoot !== canonicalPaths.stateRoot ||
          current.runtimeGeneration !== scope.runtimeGeneration ||
          current.workspaceGeneration !== scope.workspaceGeneration ||
          current.sessionId !== scope.sessionId ||
          current.mobId !== scope.mobId ||
          current.workspace !== scope.workspace ||
          current.projectPath !== scope.projectPath ||
          current.stateRoot !== scope.stateRoot
        )
          return yield* fail("The native workspace owner changed. Refresh the snapshot preview.");
        if (
          current.workspaceBusy ||
          current.workspaceStatus !== "idle" ||
          !current.workspaceGeneration
        )
          return yield* fail(
            "Native work is active or its state is unknown. Wait for the workspace to be idle.",
          );
      });
      return {
        workspacePath: params.workspace,
        scope: {
          projectPath: scope.projectPath,
          workspace: scope.workspace,
          stateRoot: scope.stateRoot,
          mobId: scope.mobId,
          sessionId: scope.sessionId,
          instanceId: input.instanceId,
        },
        assertWriteSafe,
      };
    });
    return makeMeerkatCheckpointService(resolve, store);
  },
);

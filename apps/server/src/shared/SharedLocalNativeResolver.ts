import { SharedWorkspaceError, type SharedLocalAgentBinding } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { makeMeerkatTeamService } from "../provider/meerkat/MeerkatTeamService.ts";
import type { SharedLocalNativeResolver } from "./SharedLocalDelegationService.ts";

/** Saved thread metadata locates a candidate; current native ownership authorizes it. */
export const makeSharedLocalNativeResolver = Effect.fn("SharedLocalNativeResolver.make")(function* (
  team: Pick<Effect.Success<typeof makeMeerkatTeamService>, "projectTeam">,
) {
  const projection = yield* ProjectionSnapshotQuery;
  const environment = yield* ServerEnvironment;
  const resolve: SharedLocalNativeResolver = Effect.fn("SharedLocalNativeResolver.resolve")(
    function* (threadId) {
      const thread = yield* projection.getThreadShellById(threadId);
      if (Option.isNone(thread) || thread.value.archivedAt)
        return yield* new SharedWorkspaceError({
          code: "not_found",
          message: "Choose an active local task.",
        });
      const roster = yield* team.projectTeam({ projectId: thread.value.projectId });
      const matches = roster.providers.flatMap((provider) =>
        provider.agents
          .filter(
            (agent) =>
              agent.threadId === threadId &&
              agent.mobKind === "thread" &&
              agent.record.runtime_member_id === "ingress" &&
              !agent.record.labels.source_mob_id &&
              agent.availability === "live" &&
              agent.record.addressable &&
              agent.record.visibility === "addressable" &&
              agent.record.session_id,
          )
          .map((agent) => ({ agent, instanceId: provider.instanceId })),
      );
      if (matches.length !== 1)
        return yield* new SharedWorkspaceError({
          code: "unavailable",
          message: "The task has no unambiguous live native agent. Start or reconnect it first.",
        });
      const { agent, instanceId } = matches[0]!;
      return {
        environmentId: yield* environment.getEnvironmentId,
        projectId: thread.value.projectId,
        threadId,
        instanceId,
        mobId: agent.mobId,
        sessionId: agent.record.session_id!,
      } satisfies SharedLocalAgentBinding;
    },
    Effect.mapError(
      () =>
        new SharedWorkspaceError({
          code: "unavailable",
          message: "Could not verify the task's current native ownership.",
        }),
    ),
  );
  return resolve;
});

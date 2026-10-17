import { SharedWorkspaceError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SharedToolInvocation, SharedToolResponse } from "./SharedToolHost.ts";

type NativeTools = {
  readonly invoke: (
    input: SharedToolInvocation,
  ) => Effect.Effect<SharedToolResponse, SharedWorkspaceError>;
};
type LocalTools = {
  readonly invoke: (input: SharedToolInvocation) => Effect.Effect<unknown, SharedWorkspaceError>;
};
const isSharedError = Schema.is(SharedWorkspaceError);

/** A failed specialist check never falls back to a more permissive personal route. */
export const makeSharedNativeToolRouter = Effect.fn("SharedNativeToolRouter.make")(function* (
  native: NativeTools,
  local: LocalTools,
) {
  const sql = yield* SqlClient.SqlClient;
  const invoke = Effect.fn("SharedNativeToolRouter.invoke")(
    function* (input: SharedToolInvocation) {
      const registered = yield* sql`SELECT s.specialist_id FROM shared_specialists s
      JOIN meerkat_project_agents a ON a.agent_id=s.native_agent_id
        AND a.project_id=s.native_project_id AND a.instance_id=s.native_instance_id
      WHERE a.mob_id=${input.mobId} LIMIT 1`;
      return registered.length
        ? yield* native.invoke(input)
        : { content: yield* local.invoke(input) };
    },
    Effect.mapError((cause) =>
      isSharedError(cause)
        ? cause
        : new SharedWorkspaceError({
            code: "unavailable",
            message: "The shared caller route could not be verified.",
          }),
    ),
  );
  return { invoke };
});

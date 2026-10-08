import {
  ProjectTerminalError,
  TerminalSessionLookupError,
  type ProjectTerminalTarget,
  type ProjectTerminalAttachInput,
  type ProjectTerminalWriteInput,
  type ProjectTerminalResizeInput,
  type ProjectTerminalEvent,
  type TerminalAttachStreamEvent,
  type TerminalMetadataStreamEvent,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TerminalManager } from "./Manager.ts";
import { projectTerminalOwnerKey, isProjectTerminalOwner } from "./terminalOwner.ts";
export { projectTerminalOwnerKey, isProjectTerminalOwner } from "./terminalOwner.ts";

export function threadTerminalMetadata(
  event: TerminalMetadataStreamEvent,
): TerminalMetadataStreamEvent | null {
  if (event.type === "snapshot")
    return {
      ...event,
      terminals: event.terminals.filter((terminal) => !isProjectTerminalOwner(terminal.threadId)),
    };
  return isProjectTerminalOwner(event.type === "upsert" ? event.terminal.threadId : event.threadId)
    ? null
    : event;
}
export function projectTerminalEvent(
  target: ProjectTerminalTarget,
  event: TerminalAttachStreamEvent,
): ProjectTerminalEvent | null {
  const owner = event.type === "snapshot" ? event.snapshot.threadId : event.threadId;
  const terminalId = event.type === "snapshot" ? event.snapshot.terminalId : event.terminalId;
  if (owner !== projectTerminalOwnerKey(target.projectId) || terminalId !== target.terminalId)
    return null;
  if (event.type === "snapshot" || event.type === "restarted")
    return {
      ...target,
      type: "snapshot",
      data: event.snapshot.history,
      cwd: event.snapshot.cwd,
      status: event.snapshot.status,
      label: event.snapshot.label,
      ...(event.snapshot.sequence !== undefined ? { sequence: event.snapshot.sequence } : {}),
    };
  const base = {
    ...target,
    type: event.type,
    ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
  };
  switch (event.type) {
    case "output":
      return { ...base, data: event.data };
    case "exited":
      return { ...base, status: "exited", exitCode: event.exitCode };
    case "error":
      return { ...base, status: "error", message: event.message };
    case "activity":
      return { ...base, label: event.label };
    default:
      return base;
  }
}
const decodeProjectRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ workspace_root: Schema.String })),
);
export const makeProjectTerminalService = Effect.fn("makeProjectTerminalService")(function* () {
  const manager = yield* TerminalManager;
  const sql = yield* SqlClient.SqlClient;
  const failure = (target: ProjectTerminalTarget, cause: unknown) =>
    new ProjectTerminalError({
      projectId: target.projectId,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  const owner = Effect.fn("ProjectTerminal.owner")(function* (input: ProjectTerminalTarget) {
    const rows =
      yield* sql`SELECT workspace_root FROM projection_projects WHERE project_id = ${input.projectId} AND deleted_at IS NULL`.pipe(
        Effect.flatMap(decodeProjectRows),
        Effect.mapError((cause) => failure(input, cause)),
      );
    if (!rows[0]) return yield* failure(input, "Project not found.");
    return {
      threadId: projectTerminalOwnerKey(input.projectId),
      terminalId: input.terminalId,
      cwd: rows[0].workspace_root,
    };
  });
  return {
    attach: Effect.fn("ProjectTerminal.attach")(function* (
      input: ProjectTerminalAttachInput,
      listener: (event: ProjectTerminalEvent) => Effect.Effect<void>,
    ) {
      const target = yield* owner(input);
      return yield* manager
        .attachStream(
          {
            ...target,
            env: projectScriptRuntimeEnv({ project: { cwd: target.cwd } }),
            ...(input.cols ? { cols: input.cols } : {}),
            ...(input.rows ? { rows: input.rows } : {}),
          },
          (event) => {
            const visible = projectTerminalEvent(input, event);
            return visible ? listener(visible) : Effect.void;
          },
        )
        .pipe(Effect.mapError((cause) => failure(input, cause)));
    }),
    write: Effect.fn("ProjectTerminal.write")(function* (input: ProjectTerminalWriteInput) {
      const target = yield* owner(input);
      yield* manager
        .write({ ...target, data: input.data })
        .pipe(Effect.mapError((cause) => failure(input, cause)));
    }),
    resize: Effect.fn("ProjectTerminal.resize")(function* (input: ProjectTerminalResizeInput) {
      const target = yield* owner(input);
      yield* manager
        .resize({ ...target, cols: input.cols, rows: input.rows })
        .pipe(Effect.mapError((cause) => failure(input, cause)));
    }),
    clear: Effect.fn("ProjectTerminal.clear")(function* (input: ProjectTerminalTarget) {
      const target = yield* owner(input);
      yield* manager.clear(target).pipe(Effect.mapError((cause) => failure(input, cause)));
    }),
    close: Effect.fn("ProjectTerminal.close")(function* (input: ProjectTerminalTarget) {
      const target = yield* owner(input);
      yield* manager.close(target).pipe(Effect.mapError((cause) => failure(input, cause)));
    }),
  };
});

const decodeThreadLaunchRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      workspace_root: Schema.String,
      worktree_path: Schema.NullOr(Schema.String),
      thread_deleted_at: Schema.NullOr(Schema.String),
      project_deleted_at: Schema.NullOr(Schema.String),
      provider_name: Schema.NullOr(Schema.String),
    }),
  ),
);

/** Native workers share their owning thread's shell; a stale client cannot redirect it. */
export const makeThreadTerminalLaunchResolver = Effect.fn("makeThreadTerminalLaunchResolver")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return Effect.fn("ThreadTerminal.resolveLaunch")(function* <
      T extends {
        threadId: string;
        terminalId: string;
        cwd?: string | undefined;
        worktreePath?: string | null | undefined;
      },
    >(input: T) {
      const rows = yield* sql`
      SELECT p.workspace_root, t.worktree_path,
        t.deleted_at AS thread_deleted_at, p.deleted_at AS project_deleted_at,
        r.provider_name
      FROM projection_threads t
      JOIN projection_projects p ON p.project_id = t.project_id
      LEFT JOIN provider_session_runtime r ON r.thread_id = t.thread_id
      WHERE t.thread_id = ${input.threadId}
    `.pipe(
        Effect.flatMap(decodeThreadLaunchRows),
        Effect.mapError(
          () =>
            new TerminalSessionLookupError({
              threadId: input.threadId,
              terminalId: input.terminalId,
            }),
        ),
      );
      const scope = rows[0];
      // Unsaved donor drafts have no server thread yet and keep their existing launch contract.
      if (!scope) return input;
      if (scope.thread_deleted_at || scope.project_deleted_at)
        return yield* new TerminalSessionLookupError({
          threadId: input.threadId,
          terminalId: input.terminalId,
        });
      if (scope.provider_name !== "meerkat") return input;
      return {
        ...input,
        cwd: scope.worktree_path ?? scope.workspace_root,
        worktreePath: scope.worktree_path,
        executionScope: {
          cwd: scope.worktree_path ?? scope.workspace_root,
          worktreePath: scope.worktree_path,
        },
      };
    });
  },
);

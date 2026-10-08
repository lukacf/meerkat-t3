import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { TerminalSessionStatus } from "./terminal.ts";

export const ProjectTerminalTarget = Schema.Struct({
  projectId: ProjectId,
  terminalId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type ProjectTerminalTarget = typeof ProjectTerminalTarget.Type;
const cols = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }));
const rows = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }));
export const ProjectTerminalAttachInput = Schema.Struct({
  ...ProjectTerminalTarget.fields,
  cols: Schema.optional(cols),
  rows: Schema.optional(rows),
});
export type ProjectTerminalAttachInput = typeof ProjectTerminalAttachInput.Type;
export const ProjectTerminalWriteInput = Schema.Struct({
  ...ProjectTerminalTarget.fields,
  data: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
});
export type ProjectTerminalWriteInput = typeof ProjectTerminalWriteInput.Type;
export const ProjectTerminalResizeInput = Schema.Struct({
  ...ProjectTerminalTarget.fields,
  cols,
  rows,
});
export type ProjectTerminalResizeInput = typeof ProjectTerminalResizeInput.Type;
export const ProjectTerminalEvent = Schema.Struct({
  ...ProjectTerminalTarget.fields,
  type: Schema.Literals(["snapshot", "output", "exited", "closed", "error", "cleared", "activity"]),
  sequence: Schema.optional(Schema.Number),
  data: Schema.optional(Schema.String),
  status: Schema.optional(TerminalSessionStatus),
  label: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type ProjectTerminalEvent = typeof ProjectTerminalEvent.Type;
export class ProjectTerminalError extends Schema.TaggedError<ProjectTerminalError>()(
  "ProjectTerminalError",
  { projectId: ProjectId, message: Schema.String },
) {}

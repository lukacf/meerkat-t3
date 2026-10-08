import * as Schema from "effect/Schema";
import { IsoDateTime, MessageId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { MeerkatControlScope } from "./meerkatControls.ts";
import { OrchestrationMessageContext } from "./composerContext.ts";
import { ChatAttachment, UploadChatImageAttachment } from "./orchestration.ts";

export const MeerkatCoordinatorTarget = Schema.Struct({
  ...MeerkatControlScope.fields,
  threadId: ThreadId,
});
export type MeerkatCoordinatorTarget = typeof MeerkatCoordinatorTarget.Type;
export const MeerkatCoordinatorInput = Schema.Struct({
  inputId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  startedAt: Schema.NullOr(IsoDateTime),
});
export const MeerkatCoordinatorWork = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  busy: Schema.Boolean,
  inputs: Schema.Array(MeerkatCoordinatorInput),
});
export type MeerkatCoordinatorWork = typeof MeerkatCoordinatorWork.Type;
export const MeerkatCoordinatorControl = Schema.Struct({
  ...MeerkatCoordinatorTarget.fields,
  sessionId: TrimmedNonEmptyString,
  inputId: TrimmedNonEmptyString,
  nativeRunId: TrimmedNonEmptyString,
});
export type MeerkatCoordinatorControl = typeof MeerkatCoordinatorControl.Type;
export const MeerkatCoordinatorSteer = Schema.Struct({
  ...MeerkatCoordinatorControl.fields,
  message: Schema.Struct({
    messageId: MessageId,
    text: Schema.String,
    attachments: Schema.Array(Schema.Union([ChatAttachment, UploadChatImageAttachment])),
    context: Schema.optional(OrchestrationMessageContext),
  }),
  createdAt: IsoDateTime,
  /** Inspect an earlier submission only. Missing acceptance never permits another send. */
  receiptOnly: Schema.optional(Schema.Boolean),
});
export type MeerkatCoordinatorSteer = typeof MeerkatCoordinatorSteer.Type;
export const MeerkatCoordinatorStopReceipt = Schema.Struct({
  accepted: Schema.Boolean,
  sessionId: TrimmedNonEmptyString,
  inputId: TrimmedNonEmptyString,
  nativeRunId: TrimmedNonEmptyString,
});

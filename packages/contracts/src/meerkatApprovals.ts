import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { MeerkatQuestionTarget } from "./meerkatControls.ts";

export const MeerkatApproval = Schema.Struct({
  record: Schema.Struct({
    approval_id: TrimmedNonEmptyString,
    status: Schema.Literals(["pending", "approved", "denied", "expired", "cancelled"]),
    owner: Schema.Struct({
      owner_type: Schema.Literal("session"),
      session_id: TrimmedNonEmptyString,
    }),
    proposed_action: Schema.Struct({
      summary: Schema.String,
      body: Schema.Struct({ toolName: Schema.String, arguments: Schema.Unknown }),
    }),
    created_at: IsoDateTime,
    expires_at: Schema.optional(IsoDateTime),
    decision: Schema.optional(
      Schema.Struct({
        decision: Schema.Literals(["approve", "deny"]),
        reason: Schema.optional(Schema.String),
        decided_at: IsoDateTime,
      }),
    ),
  }),
  actionable: Schema.Boolean,
});
export type MeerkatApproval = typeof MeerkatApproval.Type;
export const MeerkatApprovals = Schema.Struct({ approvals: Schema.Array(MeerkatApproval) });
export const MeerkatApprovalDecisionInput = Schema.Struct({
  ...MeerkatQuestionTarget.fields,
  sessionId: TrimmedNonEmptyString,
  approvalId: TrimmedNonEmptyString,
  decision: Schema.Literals(["approve", "deny"]),
});
export type MeerkatApprovalDecisionInput = typeof MeerkatApprovalDecisionInput.Type;

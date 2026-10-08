import type { MeerkatAttentionItem } from "@t3tools/contracts";
import type { ConversationActivity } from "./agentActivity.logic";

/** The current native attention observation, not saved tool history, owns this state. */
export function pendingNativeQuestionCalls(
  items: readonly MeerkatAttentionItem[],
  target: {
    projectId: string;
    instanceId: string;
    agentRef: string;
    sessionId: string | undefined;
    mobId: string;
  },
) {
  return new Set(
    items.flatMap((item) =>
      target.sessionId &&
      item.active &&
      item.kind === "question" &&
      item.projectId === target.projectId &&
      item.instanceId === target.instanceId &&
      item.agentRef === target.agentRef &&
      item.sessionId === target.sessionId &&
      item.question?.sessionId === target.sessionId &&
      item.question.mobId === target.mobId
        ? [item.question.toolCallId]
        : [],
    ),
  );
}

export function isCurrentNativeQuestion(
  activity: ConversationActivity,
  nativeRunId: string | undefined,
  pendingToolCallIds: ReadonlySet<string> | undefined,
) {
  return (
    nativeRunId !== undefined &&
    activity.kind === "tool" &&
    (activity.status === "Requested" || activity.status === "Running") &&
    activity.frames.some((frame) => {
      if (frame.source.kind !== "console_event" || frame.run_id !== nativeRunId) return false;
      const payload = frame.payload;
      if (!payload || typeof payload !== "object") return false;
      const callId = Reflect.get(payload, "tool_call_id") ?? Reflect.get(payload, "id");
      return typeof callId === "string" && pendingToolCallIds?.has(callId) === true;
    })
  );
}

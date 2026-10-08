import type { ConsoleFrame, ConsoleIdentityRecord, MeerkatAgentWork } from "@t3tools/contracts";

/** Terminal native interactions only. Tool completions and message health are not run status. */
export function nativeWorkCompletion(
  frames: ReadonlyArray<ConsoleFrame>,
  record: Pick<ConsoleIdentityRecord, "identity" | "session_id">,
) {
  let latest:
    | Extract<NonNullable<MeerkatAgentWork["latestCompletion"]>, { interactionId: string }>
    | undefined;
  for (const frame of frames) {
    if (!frame.interaction_id || frame.identity !== record.identity) continue;
    if (frame.session_id && frame.session_id !== record.session_id) continue;
    // MobKit completes steering delivery while the original work is still running.
    const payload = frame.payload as Record<string, unknown> | null;
    if (
      payload?.handling_mode === "steer" ||
      payload?.reason === "steer_delivered" ||
      payload?.source_event_type === "session_history" ||
      payload?.type === "session_history"
    )
      continue;
    const status =
      frame.kind === "interaction_complete"
        ? "completed"
        : frame.kind === "interaction_failed"
          ? "failed"
          : undefined;
    if (!status || (latest && frame.timestamp_ms <= latest.timestampMs)) continue;
    latest = { interactionId: frame.interaction_id, status, timestampMs: frame.timestamp_ms };
  }
  return latest;
}

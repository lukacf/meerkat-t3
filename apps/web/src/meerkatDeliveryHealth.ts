export function meerkatDeliveryHealth(
  activities: readonly { kind: string; payload: unknown }[],
): string | null {
  for (let index = activities.length - 1; index >= 0; index--) {
    const activity = activities[index]!;
    if (
      activity.kind !== "runtime.warning" ||
      !activity.payload ||
      typeof activity.payload !== "object"
    )
      continue;
    const payload = activity.payload as Record<string, unknown>;
    const detail = payload.detail;
    if (
      !detail ||
      typeof detail !== "object" ||
      !("kind" in detail) ||
      detail.kind !== "meerkat.delivery.health"
    )
      continue;
    return "status" in detail && detail.status === "error"
      ? "Saved output is waiting to sync. Retrying automatically."
      : null;
  }
  return null;
}

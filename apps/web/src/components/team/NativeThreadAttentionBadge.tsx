import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useMeerkatAttention } from "../../state/meerkatAttention";
import { attentionLabel, nativeAttentionDestination } from "./meerkatAttention.logic";

export function NativeThreadAttentionBadge({
  environmentId,
  projectId,
  threadId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
}) {
  const query = useMeerkatAttention(environmentId, projectId);
  const navigate = useNavigate();
  const items = (query.data?.items ?? []).filter((item) => item.threadId === threadId);
  const label = attentionLabel(items);
  if (!label) return null;
  const target =
    items.find((item) => item.kind === "question" || item.kind === "approval") ??
    items.find((item) => item.kind.endsWith("error")) ??
    items[0];
  const destination = target ? nativeAttentionDestination(environmentId, target) : null;
  return (
    <button
      type="button"
      className="shrink-0 rounded px-1 py-0.5 text-3xs font-medium text-primary hover:bg-accent"
      aria-label={`Thread agents: ${label}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (destination) void navigate(destination);
      }}
    >
      {label}
    </button>
  );
}

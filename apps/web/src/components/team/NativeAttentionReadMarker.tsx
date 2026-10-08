import type { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";
import { useMeerkatAttention } from "../../state/meerkatAttention";
import { meerkatControlsEnvironment } from "../../state/meerkatControls";
import { useAtomCommand } from "../../state/use-atom-command";
import { matchingAttention } from "./meerkatAttention.logic";

/** Mount only after the exact native transcript/activity is visible in its conversation. */
export function NativeAttentionReadMarker({
  environmentId,
  projectId,
  instanceId,
  agentRef,
  sessionId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  instanceId: ProviderInstanceId;
  agentRef: string;
  sessionId: string | undefined;
}) {
  const query = useMeerkatAttention(environmentId, projectId);
  const markRead = useAtomCommand(meerkatControlsEnvironment.attentionRead, {
    reportFailure: true,
  });
  const inFlight = useRef(false);
  const marker = useRef<HTMLSpanElement>(null);
  const data = query.data;
  const refresh = query.refresh;
  useEffect(() => {
    const read = () => {
      if (
        inFlight.current ||
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        !marker.current?.getClientRects().length
      )
        return;
      const itemIds = matchingAttention(data?.items ?? [], instanceId, agentRef, sessionId)
        .filter((item) => item.unread)
        .map((item) => item.id)
        .slice(0, 100);
      if (!itemIds.length) return;
      inFlight.current = true;
      void markRead({ environmentId, input: { projectId, itemIds } })
        .then((result) => {
          if (result._tag === "Success") refresh();
        })
        .finally(() => {
          inFlight.current = false;
        });
    };
    read();
    const observer =
      typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(read);
    if (marker.current) observer?.observe(marker.current);
    window.addEventListener("focus", read);
    document.addEventListener("visibilitychange", read);
    return () => {
      observer?.disconnect();
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", read);
    };
  }, [data, refresh, environmentId, projectId, instanceId, agentRef, sessionId, markRead]);
  return (
    <span
      ref={marker}
      aria-hidden="true"
      className="pointer-events-none absolute size-px opacity-0"
    />
  );
}

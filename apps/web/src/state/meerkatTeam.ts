import { createMeerkatTeamEnvironmentAtoms } from "@t3tools/client-runtime/state/meerkatTeam";
import { useEffect, useEffectEvent, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { usePresentationVisibility } from "../hooks/usePresentationVisibility";
import type { EnvironmentQueryView } from "./query";

export const meerkatTeamEnvironment = createMeerkatTeamEnvironmentAtoms(connectionAtomRuntime);

/** Wait after each completed observation and suspend refreshing in background tabs. */
export function useVisibleTeamRefresh<A>(query: EnvironmentQueryView<A>, enabled: boolean) {
  const presented = usePresentationVisibility();
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const refresh = useEffectEvent(() => query.refresh());
  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  useEffect(() => {
    if (!enabled || !visible || !presented || query.isPending) return;
    const timer = window.setTimeout(() => refresh(), 5_000);
    return () => window.clearTimeout(timer);
  }, [enabled, visible, presented, query.isPending]);
  return visible;
}

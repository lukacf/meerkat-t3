import { createSharedWorkspaceEnvironmentAtoms } from "@t3tools/client-runtime/state/sharedWorkspace";
import { SharedWorkspaceSnapshot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";
import { isSharedSpecialistHostTarget } from "../connection/desktopLocal";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironments, type EnvironmentPresentation } from "./environments";
import { useVisibleTeamRefresh } from "./meerkatTeam";
import { useEnvironmentQuery } from "./query";

export const sharedWorkspaceEnvironment =
  createSharedWorkspaceEnvironmentAtoms(connectionAtomRuntime);
const SNAPSHOT_PREFIX = "meerkat-t3:shared-directory:v1:";
const isSnapshot = Schema.is(SharedWorkspaceSnapshot);

export function useSharedHosts() {
  return useEnvironments().environments.filter((environment) =>
    isSharedSpecialistHostTarget(environment.entry.target),
  );
}

function readCachedDirectory(key: string): SharedWorkspaceSnapshot | null {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(key) ?? "null");
    return isSnapshot(value) ? value : null;
  } catch {
    return null;
  }
}

/** Retained directory rows are display-only while offline, never an execution observation. */
export function useSharedDirectory(host: EnvironmentPresentation, visible = true) {
  const key = `${SNAPSHOT_PREFIX}${host.environmentId}:${host.entry.target._tag === "BearerConnectionTarget" ? host.entry.target.connectionId : "local"}`;
  const [retained, setRetained] = useState(() => ({ key, snapshot: readCachedDirectory(key) }));
  if (retained.key !== key) setRetained({ key, snapshot: readCachedDirectory(key) });
  const query = useEnvironmentQuery(
    visible
      ? sharedWorkspaceEnvironment.session({ environmentId: host.environmentId, input: {} })
      : null,
  );
  useVisibleTeamRefresh(query, visible);
  if (query.data && !query.error && retained.snapshot !== query.data.snapshot) {
    setRetained({ key, snapshot: query.data.snapshot });
  }
  useEffect(() => {
    if (!query.data || query.error) return;
    const snapshot = query.data.snapshot;
    try {
      globalThis.localStorage?.setItem(key, JSON.stringify(snapshot));
    } catch {
      // A full or unavailable browser store must not erase the live directory.
    }
  }, [key, query.data, query.error]);
  return {
    ...query,
    snapshot: query.data?.snapshot ?? (retained.key === key ? retained.snapshot : null),
    permissions: query.data?.permissions ?? null,
    connected: host.connection.phase === "connected",
  };
}

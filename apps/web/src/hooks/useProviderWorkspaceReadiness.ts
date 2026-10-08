import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import {
  canCheckProviderWorkspaceReadiness,
  hasProviderWorkspaceReadiness,
  resolveProviderWorkspaceReadiness,
} from "@t3tools/client-runtime/providerWorkspaceReadiness";
import { useEffect, useMemo, useRef, useState } from "react";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

const RETRY_DELAY_MS = 5_000;

/** Opening a composer checks its workspace; it never connects or starts an agent. */
export function useProviderWorkspaceReadiness({
  environmentId,
  cwd,
  providers,
  instanceId,
}: {
  environmentId: EnvironmentId;
  cwd: string | null | undefined;
  providers: ReadonlyArray<ServerProvider>;
  /** Omit for the ordinary picker, which can choose any native instance. */
  instanceId?: ProviderInstanceId;
}) {
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  const pending = useRef(new Map<string, ReturnType<typeof refresh>>());
  const [retryTick, setRetryTick] = useState(0);
  const missing = providers
    .filter(
      (provider) =>
        canCheckProviderWorkspaceReadiness(provider) &&
        (!instanceId || provider.instanceId === instanceId) &&
        !hasProviderWorkspaceReadiness(provider, cwd),
    )
    .map((provider) => provider.instanceId);
  // Scope and missing membership, rather than every server status publication,
  // own the request lifetime. Unrelated config updates must not restart a probe.
  const missingKey = JSON.stringify(missing);
  useEffect(() => {
    if (!cwd) return;
    let active = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const instanceIds: ProviderInstanceId[] = JSON.parse(missingKey);
    for (const targetInstanceId of instanceIds) {
      const key = JSON.stringify([environmentId, targetInstanceId, cwd]);
      let request = pending.current.get(key);
      if (!request) {
        request = refresh({ environmentId, input: { instanceId: targetInstanceId, cwd } });
        pending.current.set(key, request);
        const release = () => {
          pending.current.delete(key);
        };
        void request.then(release, release);
      }
      void request.then(
        (result) => {
          const refreshed =
            result._tag === "Success"
              ? result.value.providers.find((row) => row.instanceId === targetInstanceId)
              : undefined;
          if (refreshed && hasProviderWorkspaceReadiness(refreshed, cwd)) return;
          if (active)
            timers.push(setTimeout(() => setRetryTick((tick) => tick + 1), RETRY_DELAY_MS));
        },
        () => {
          if (active)
            timers.push(setTimeout(() => setRetryTick((tick) => tick + 1), RETRY_DELAY_MS));
        },
      );
    }
    return () => {
      active = false;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [cwd, environmentId, missingKey, refresh, retryTick]);
  return useMemo(() => resolveProviderWorkspaceReadiness(providers, cwd), [providers, cwd]);
}

import type { DesktopSharedHostState } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { environmentCatalog } from "../../connection/catalog";
import { isDesktopSharedHostTarget } from "../../connection/desktopLocal";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SharedHostSettings } from "./SharedHostSettings";
import { SettingsSection } from "./settingsLayout";

function SharedHostConnection({ host }: { host: EnvironmentPresentation | undefined }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retryConnection = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const canRetry =
    host && ["error", "offline", "available", "reconnecting"].includes(host.connection.phase);
  async function reconnect() {
    if (!host || busy || !canRetry) return;
    setBusy(true);
    setError(null);
    try {
      const result = await retryConnection(host.environmentId);
      if (result._tag === "Failure" && active.current) {
        setError(
          "Could not connect this app. Check that macOS secure storage is available, then retry.",
        );
      }
    } catch {
      if (active.current) setError("Could not retry this connection. Try again.");
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      <p role="status" className="text-sm text-muted-foreground">
        {host?.connection.error ??
          "This app is connecting to the shared host. If macOS shows a Keychain prompt, respond to it to continue."}
      </p>
      {canRetry && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void reconnect()}>
          {busy ? "Retrying connection..." : "Retry connection"}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function LocalSharedHostSettings() {
  const bridge = window.desktopBridge;
  const { environments } = useEnvironments();
  const host = environments.find((entry) => isDesktopSharedHostTarget(entry.entry.target));
  const [state, setState] = useState<DesktopSharedHostState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connected = host?.connection.phase === "connected";
  const connectionFailed =
    host && ["error", "offline", "available", "reconnecting"].includes(host.connection.phase);
  const supported = Boolean(bridge?.getSharedHostState && bridge.setSharedHostEnabled);
  useEffect(() => {
    if (!supported) return;
    let active = true;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const next = await bridge!.getSharedHostState!();
        if (active) {
          setState(next);
          setError(null);
        }
      } catch {
        if (active) setError("Could not check the local shared host. Try again.");
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [bridge, supported]);
  if (!supported) return null;

  async function setEnabled(enabled: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setState(await bridge!.setSharedHostEnabled!(enabled));
    } catch {
      setError(
        "The shared host setting could not be applied. Your workspace has been kept. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <SettingsSection title="Shared specialists on this Mac">
        <div className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground">
            Run a shared workspace alongside your personal tasks. It starts with the app and is
            available only on this Mac. Its specialists and saved model accounts are kept
            separately. Accounts supplied through your shell environment can also be available.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              disabled={busy || !state || state.status === "stopping"}
              onClick={() => void setEnabled(!state?.enabled)}
            >
              {busy ? "Applying..." : state?.enabled ? "Stop shared host" : "Host on this Mac"}
            </Button>
            {state?.status === "unavailable" && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void setEnabled(true)}
              >
                Retry
              </Button>
            )}
            <span role="status" className="text-xs text-muted-foreground">
              {!state
                ? "Checking host..."
                : state.status === "running"
                  ? connected
                    ? "Running"
                    : connectionFailed || host?.connection.phase === "unsupported"
                      ? "Host running; connection needs attention"
                      : "Host running; connecting this app..."
                  : state.status === "starting"
                    ? "Starting..."
                    : state.status === "stopping"
                      ? "Stopping..."
                      : state.status === "unavailable"
                        ? "Needs attention"
                        : "Stopped"}
            </span>
          </div>
          {state?.status === "running" && !connected && (
            <SharedHostConnection key={host?.environmentId ?? "pending"} host={host} />
          )}
          {state?.enabled && (
            <p className="text-xs text-muted-foreground">
              Stopping keeps the workspace and its history. Specialists will be unavailable until
              you start the host again. Quitting MeerkaT3 also stops this host.
            </p>
          )}
          {(error || state?.error) && (
            <p role="alert" className="text-sm text-destructive">
              {error ?? state?.error}
            </p>
          )}
        </div>
      </SettingsSection>
      {state?.status === "running" && connected && host && (
        <SharedHostSettings host={host} title="Set up this Mac's shared workspace" />
      )}
    </>
  );
}

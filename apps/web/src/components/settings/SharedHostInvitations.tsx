import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthSharedParticipantScopes,
  type AuthClientSession,
  type AuthPairingLink,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useCallback, useEffect, useRef, useState } from "react";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { setPairingTokenOnUrl } from "../../pairingUrl";
import { environmentSession, useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

type Props = { environmentId: EnvironmentId; hostLabel: string; connected: boolean };
type Invitation = { id: string; url: string; expiresAt: DateTime.Utc };
const participantAccess = (item: AuthPairingLink | AuthClientSession) =>
  item.scopes.length > 0 &&
  item.scopes.every((scope) => AuthSharedParticipantScopes.some((allowed) => allowed === scope));
const timestamp = (value: DateTime.Utc) => new Date(DateTime.toEpochMillis(value)).toLocaleString();

export function SharedHostInvitations(props: Props) {
  const session = useEnvironmentSessionState(props.environmentId);
  const granted = session.data?.authenticated ? (session.data.scopes ?? []) : [];
  const canManage =
    props.connected &&
    [AuthAccessReadScope, AuthAccessWriteScope, ...AuthSharedParticipantScopes].every((scope) =>
      granted.includes(scope),
    );
  // Host or permission changes discard secrets and pending UI state.
  return (
    <HostInvitations
      key={`${props.environmentId}:${canManage}`}
      {...props}
      canManage={canManage}
      permissionsPending={session.isPending}
    />
  );
}

function HostInvitations({
  environmentId,
  hostLabel,
  connected,
  canManage,
  permissionsPending,
}: Props & { canManage: boolean; permissionsPending: boolean }) {
  const create = useAtomCommand(environmentSession.createPairingCredential, {
    reportFailure: false,
    reportDefect: false,
  });
  const list = useAtomCommand(environmentSession.listPairingLinks, {
    reportFailure: false,
    reportDefect: false,
  });
  const revoke = useAtomCommand(environmentSession.revokePairingLink, {
    reportFailure: false,
    reportDefect: false,
  });
  const listClients = useAtomCommand(environmentSession.listClientSessions, {
    reportFailure: false,
    reportDefect: false,
  });
  const revokeClient = useAtomCommand(environmentSession.revokeClientSession, {
    reportFailure: false,
    reportDefect: false,
  });
  const [links, setLinks] = useState<ReadonlyArray<AuthPairingLink> | null>(null);
  const [clients, setClients] = useState<ReadonlyArray<AuthClientSession> | null>(null);
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<Invitation | null>(null);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const active = useRef(true);
  const refreshSequence = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    const [result, clientResult] = await Promise.all([
      list({ environmentId, input: {} }),
      listClients({ environmentId, input: {} }),
    ]);
    if (!active.current || sequence !== refreshSequence.current) return;
    if (result._tag === "Success") {
      const invitations = result.value.filter(participantAccess);
      setLinks(invitations);
      setFresh((current) =>
        current && invitations.some((link) => link.id === current.id) ? current : null,
      );
    }
    if (clientResult._tag === "Success")
      setClients(
        clientResult.value.filter((client) => participantAccess(client) && !client.current),
      );
    if (result._tag === "Failure" || clientResult._tag === "Failure")
      setNotice(
        "Could not refresh all shared access. Reconnect this host or refresh to try again.",
      );
    setNow(Date.now());
  }, [environmentId, list, listClients]);

  useEffect(() => {
    active.current = true;
    // oxlint-disable-next-line react/set-state-in-effect -- Refresh synchronizes host-owned access after both network reads complete.
    if (canManage) void refresh();
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      active.current = false;
      refreshSequence.current += 1;
      clearInterval(timer);
    };
  }, [canManage, refresh]);

  async function createInvitation() {
    if (!canManage || busy) return;
    const operation = ++refreshSequence.current;
    setBusy(true);
    setNotice(null);
    setReveal(false);
    const result = await create({
      environmentId,
      input: {
        ...(label.trim() ? { label: label.trim() } : {}),
        scopes: AuthSharedParticipantScopes,
      },
    });
    if (!active.current || operation !== refreshSequence.current) return;
    if (result._tag === "Failure") {
      setNotice(
        "Could not confirm invitation creation. Refresh invitations before creating another; the request may have succeeded.",
      );
    } else {
      const url = new URL("/pair", result.value.httpBaseUrl);
      url.username = "";
      url.password = "";
      setFresh({
        id: result.value.id,
        url: setPairingTokenOnUrl(url, result.value.credential).toString(),
        expiresAt: result.value.expiresAt,
      });
      setLabel("");
      setNotice("Invitation created. Copy the link now; it is only available during this visit.");
      await refresh();
    }
    if (active.current) setBusy(false);
  }

  async function revokeInvitation(id: string) {
    if (!canManage || busy) return;
    const operation = ++refreshSequence.current;
    setBusy(true);
    setNotice(null);
    const result = await revoke({ environmentId, input: { id } });
    if (!active.current || operation !== refreshSequence.current) return;
    if (result._tag === "Failure") {
      setNotice("Could not revoke this invitation. Refresh its status before trying again.");
    } else {
      setLinks((current) => current?.filter((link) => link.id !== id) ?? null);
      setFresh((current) => (current?.id === id ? null : current));
      setNotice(
        result.value.revoked
          ? "Invitation revoked. Already connected clients keep their access."
          : "This invitation is no longer active. Already connected clients keep their access.",
      );
    }
    setBusy(false);
  }

  async function revokeClientAccess(client: AuthClientSession) {
    if (!canManage || busy || client.current || !participantAccess(client)) return;
    const operation = ++refreshSequence.current;
    setBusy(true);
    setNotice(null);
    const result = await revokeClient({ environmentId, input: { sessionId: client.sessionId } });
    if (!active.current || operation !== refreshSequence.current) return;
    if (result._tag === "Failure") {
      setNotice("Could not revoke client access. Refresh its status before trying again.");
    } else {
      setClients(
        (current) => current?.filter((item) => item.sessionId !== client.sessionId) ?? null,
      );
      setNotice(
        result.value.revoked
          ? "Client access revoked. This client needs a new invitation to reconnect."
          : "This client no longer has access.",
      );
    }
    setBusy(false);
  }

  async function copyInvitation() {
    if (!canManage || !fresh || DateTime.toEpochMillis(fresh.expiresAt) <= Date.now()) return;
    try {
      await writeTextToClipboard(fresh.url, "shared host invitation");
      if (active.current) setNotice("Invitation link copied.");
    } catch {
      if (active.current) {
        setReveal(true);
        setNotice("Could not copy automatically. Select and copy the invitation link below.");
      }
    }
  }

  const freshValid = fresh && DateTime.toEpochMillis(fresh.expiresAt) > now;
  return (
    <section
      className="min-w-0 space-y-3 border-t border-border/50 pt-4"
      aria-label={`Invitations for ${hostLabel}`}
    >
      <div>
        <h3 className="text-sm font-medium">Invite collaborators</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Connect to specialists on {hostLabel}. Invitations do not grant access to its terminal,
          files or account settings.
        </p>
      </div>
      {!canManage ? (
        <p role="status" className="text-xs text-muted-foreground">
          {!connected
            ? "Reconnect this host to manage invitations."
            : permissionsPending
              ? "Checking invitation permissions..."
              : "Invitation management requires an administrator connection to this host."}
        </p>
      ) : (
        <>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void createInvitation();
            }}
          >
            <label className="min-w-40 flex-1 space-y-1 text-xs">
              <span>Invitation label (optional)</span>
              <Input
                aria-label="Invitation label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="For example, Alice's Mac"
                disabled={busy}
              />
            </label>
            <Button type="submit" size="sm" disabled={busy}>
              Create invitation
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setNotice(null);
                void refresh();
              }}
            >
              Refresh access
            </Button>
          </form>
          {notice && (
            <p role="status" className="text-xs text-muted-foreground">
              {notice}
            </p>
          )}
          {freshValid && (
            <div className="space-y-2 rounded-md border border-border/60 p-3">
              <p className="text-xs text-muted-foreground">
                New invitation expires {timestamp(fresh.expiresAt)}.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="xs" onClick={() => void copyInvitation()}>
                  Copy invitation link
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => setReveal((value) => !value)}
                >
                  {reveal ? "Hide link" : "Show link"}
                </Button>
              </div>
              {reveal && (
                <Input
                  aria-label="Invitation link"
                  value={fresh.url}
                  readOnly
                  onFocus={(event) => event.target.select()}
                />
              )}
              {new URL(fresh.url).hostname === "127.0.0.1" && (
                <p className="text-xs text-muted-foreground">
                  This link works on this Mac. Use a reachable shared host address for other
                  computers.
                </p>
              )}
            </div>
          )}
          <ul className="divide-y divide-border/50">
            {(links ?? []).map((link) => (
              <li key={link.id} className="flex flex-wrap items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{link.label ?? "Shared specialist invitation"}</p>
                  <p className="text-xs text-muted-foreground">
                    Created {timestamp(link.createdAt)}.{" "}
                    {DateTime.toEpochMillis(link.expiresAt) > now ? "Expires" : "Expired"}{" "}
                    {timestamp(link.expiresAt)}.
                  </p>
                </div>
                <Button
                  type="button"
                  size="xs"
                  variant="destructive-outline"
                  disabled={busy}
                  onClick={() => void revokeInvitation(link.id)}
                >
                  Revoke invitation
                </Button>
              </li>
            ))}
          </ul>
          {links?.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No active shared specialist invitations.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Each invitation can be used once. Revoking it prevents a new connection; it does not
            revoke access already issued to a client.
          </p>
          <div className="border-t border-border/50 pt-3">
            <h3 className="text-sm font-medium">Client access</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Clients that used an invitation can reconnect until their access expires or you revoke
              it. Your administrative connection is not listed here.
            </p>
            <ul className="mt-2 divide-y divide-border/50" aria-label="Shared participant clients">
              {(clients ?? []).map((client) => (
                <li key={client.sessionId} className="flex flex-wrap items-center gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      {client.client.label ?? client.client.browser ?? "Shared specialist client"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {client.connected ? "Connected" : "Offline"}.
                      {client.client.os ? ` ${client.client.os}.` : ""} Access issued{" "}
                      {timestamp(client.issuedAt)}.{" "}
                      {DateTime.toEpochMillis(client.expiresAt) > now ? "Expires" : "Expired"}{" "}
                      {timestamp(client.expiresAt)}.
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    variant="destructive-outline"
                    disabled={busy}
                    onClick={() => void revokeClientAccess(client)}
                  >
                    Revoke access
                  </Button>
                </li>
              ))}
            </ul>
            {clients?.length === 0 && (
              <p className="mt-2 text-xs text-muted-foreground">No shared participant clients.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

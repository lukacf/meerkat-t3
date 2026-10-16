import type { MeerkatAuthConnection, MeerkatAuthMethod } from "@t3tools/contracts";

export function accountIdentity(connection: MeerkatAuthConnection) {
  return {
    provider: connection.provider,
    realmId: connection.realmId,
    bindingId: connection.bindingId,
    profileId: connection.profileId,
  };
}

export function accountKey(connection: MeerkatAuthConnection): string {
  return JSON.stringify(Object.values(accountIdentity(connection)));
}

export interface ProviderAccountGroup {
  key: string;
  connection: MeerkatAuthConnection;
  connections: MeerkatAuthConnection[];
}

export function groupProviderAccounts(connections: readonly MeerkatAuthConnection[]) {
  const groups = new Map<string, ProviderAccountGroup>();
  for (const connection of connections) {
    // Only native credential-account identity proves that route bindings share
    // sign-in and removal. Matching names or login account IDs do not.
    const key = connection.credentialAccount
      ? JSON.stringify([
          "account",
          connection.credentialAccount.realm,
          connection.credentialAccount.account,
          connection.authMethod,
          connection.backendKind,
        ])
      : accountKey(connection);
    const existing = groups.get(key);
    if (existing) existing.connections.push(connection);
    else groups.set(key, { key, connection, connections: [connection] });
  }
  return [...groups.values()];
}

export function accountRouteLabel(connection: MeerkatAuthConnection): string {
  switch (connection.provider) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "gemini":
      return "Google";
    default:
      return connection.provider;
  }
}

export function accountMethod(
  connection: MeerkatAuthConnection,
  methods: readonly MeerkatAuthMethod[],
) {
  const compatible = methods.filter(
    (method) =>
      method.authMethod === connection.authMethod && method.backendKind === connection.backendKind,
  );
  const exact = compatible.filter((method) => method.provider === connection.provider);
  // An account method can supply several native protocol families, as Copilot does.
  return exact.length === 1 ? exact[0] : compatible.length === 1 ? compatible[0] : undefined;
}

export function accountStatus(connection: MeerkatAuthConnection): string {
  if (connection.state === "connected") {
    if (connection.authMethod?.includes("api_key")) return "Key saved";
    if (connection.authMethod?.includes("bearer")) return "Token saved";
    return "Connected";
  }
  if (connection.state === "reauth_required") return "Sign in again";
  if (connection.state === "host_managed" || connection.state === "unknown") return "Not verified";
  return "Not connected";
}

export function signInUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function accountFormReady(
  method: MeerkatAuthMethod,
  fields: Readonly<Record<string, string>>,
  secret: string,
): boolean {
  return (
    (method.flow !== "secret" || secret.trim().length > 0) &&
    method.fields.every((field) => !field.required || (fields[field.key]?.trim().length ?? 0) > 0)
  );
}

import type {
  EnvironmentId,
  MeerkatAuthConnection,
  MeerkatAuthOverview,
  MeerkatAuthScope,
} from "@t3tools/contracts";

export function meerkatAuthScopeKey(environmentId: EnvironmentId, scope: MeerkatAuthScope): string {
  return JSON.stringify([
    environmentId,
    scope.projectId,
    scope.instanceId,
    scope.threadTarget?.threadId ?? null,
    scope.threadTarget?.expectedCwd ?? null,
  ]);
}

export function meerkatAuthWorkspaceMatches(
  scope: MeerkatAuthScope,
  overview: typeof MeerkatAuthOverview.Type | null,
): boolean {
  if (!scope.threadTarget) return overview !== null;
  return (
    overview?.workspace?.projectId === scope.projectId &&
    overview.workspace.threadId === scope.threadTarget.threadId &&
    overview.workspace.cwd === scope.threadTarget.expectedCwd
  );
}

const standardApiKeyVariables: Readonly<Record<string, string>> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
};

export function meerkatConnectionSetup(connection: MeerkatAuthConnection) {
  const interactive =
    ["openai", "anthropic", "gemini"].includes(connection.provider) &&
    connection.supportsInteractiveLogin;
  const missing = connection.state === "needs_auth" || connection.state === "reauth_required";
  const environmentSetup = missing && !interactive;
  const variable =
    connection.source === "env" && connection.realmId === "env_default"
      ? standardApiKeyVariables[connection.provider]
      : undefined;
  const label =
    connection.state === "connected"
      ? "Connected"
      : connection.state === "host_managed"
        ? "Managed by host"
        : interactive
          ? connection.state === "reauth_required"
            ? "Sign in again"
            : "Sign-in needed"
          : "Credentials needed";
  return {
    interactive,
    environmentSetup,
    label,
    instructions: environmentSetup
      ? variable
        ? `In Credentials, choose ${connection.displayName} and enter your API key (${variable}).`
        : "Add the variables required by this connection under Advanced variable in Credentials, or update its configured credentials on the host."
      : null,
  };
}

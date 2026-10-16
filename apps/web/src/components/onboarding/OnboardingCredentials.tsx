import type { EnvironmentId } from "@t3tools/contracts";
import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentSessionState } from "../../state/session";
import { ProviderAccountsPanel } from "../settings/ProviderAccountsPanel";
import {
  classifyProviderEnvironmentAccess,
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
  type ProviderOperateAccess,
} from "../settings/ProviderSettingsPanel.logic";

interface CredentialProps {
  readonly environmentId: EnvironmentId;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onErrorChange: (hasError: boolean) => void;
}

export function OnboardingCredentials(props: CredentialProps) {
  const { environments } = useEnvironments();
  const environment = environments.find((entry) => entry.environmentId === props.environmentId);
  if (!environment) return <p role="status">Reconnect this computer to configure providers.</p>;
  if (environment.entry.target._tag === "PrimaryConnectionTarget") {
    return isElectron ? (
      <CredentialEditor {...props} environment={environment} operateAccess="granted" />
    ) : (
      <PrimaryCredentialEditor {...props} environment={environment} />
    );
  }
  return <RemoteCredentialEditor {...props} environment={environment} />;
}

function PrimaryCredentialEditor(
  props: CredentialProps & { readonly environment: EnvironmentPresentation },
) {
  const session = usePrimarySessionState();
  return (
    <CredentialEditor
      {...props}
      operateAccess={resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: session.data,
        isPending: session.isPending,
        hasError: session.error !== null,
      })}
    />
  );
}
function RemoteCredentialEditor(
  props: CredentialProps & { readonly environment: EnvironmentPresentation },
) {
  const session = useEnvironmentSessionState(props.environmentId);
  return (
    <CredentialEditor
      {...props}
      operateAccess={resolveRemoteOperateAccess({
        session: session.data,
        isPending: session.isPending,
        hasError: session.hasError,
      })}
    />
  );
}

function CredentialEditor({
  environmentId,
  environment,
  operateAccess,
  onPendingChange,
  onErrorChange,
}: CredentialProps & {
  readonly environment: EnvironmentPresentation;
  readonly operateAccess: ProviderOperateAccess;
}) {
  const access = classifyProviderEnvironmentAccess({
    connectionPhase: environment.connection.phase,
    hasServerConfig: environment.serverConfig !== null,
    operateAccess,
  });
  if (access.kind !== "editable") {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {access.kind === "read-only"
          ? "This connection is read-only. Reconnect with permission to manage this computer, or ask its owner to configure providers."
          : "Waiting for this computer and its provider settings..."}
      </p>
    );
  }
  return (
    <div className="rounded-lg border border-border p-3">
      <ProviderAccountsPanel
        environmentId={environmentId}
        compact
        onPendingChange={onPendingChange}
        onErrorChange={onErrorChange}
      />
    </div>
  );
}

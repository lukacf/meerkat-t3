import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import { useProviderWorkspaceReadiness } from "../../hooks/useProviderWorkspaceReadiness";
import { useEnvironmentSessionState } from "../../state/session";
import {
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
  type ProviderOperateAccess,
} from "./ProviderSettingsPanel.logic";
import type { ResolvedSettingsScope } from "./settingsScope";

const WorkspaceAccessContext = createContext<ReadonlyMap<EnvironmentId, ProviderOperateAccess>>(
  new Map(),
);
export function useSettingsWorkspaceAccess() {
  return useContext(WorkspaceAccessContext);
}

type ReadinessEnvironment = {
  environmentId: EnvironmentId;
  isPrimary: boolean;
  serverConfig: { providers: ReadonlyArray<ServerProvider> } | null;
};
type EnvironmentChecksProps = {
  environment: ReadinessEnvironment;
  scope: Pick<ResolvedSettingsScope, "kind" | "members">;
  report: (
    environmentId: EnvironmentId,
    owner: string,
    access: ProviderOperateAccess | null,
  ) => void;
};

function AuthorizedChecks({
  environment,
  scope,
  report,
  access,
}: EnvironmentChecksProps & { access: ProviderOperateAccess }) {
  const owner = useId();
  useLayoutEffect(() => {
    report(environment.environmentId, owner, access);
    return () => report(environment.environmentId, owner, null);
  }, [environment.environmentId, owner, report, access]);
  const providers = environment.serverConfig?.providers;
  return (
    <>
      {access === "granted" && providers
        ? scope.members
            .filter((member) => member.environmentId === environment.environmentId)
            .map((member) => (
              <WorkspaceCheck
                key={member.physicalProjectKey}
                environmentId={environment.environmentId}
                cwd={member.workspaceRoot}
                providers={providers}
              />
            ))
        : null}
    </>
  );
}

function PrimaryChecks(props: EnvironmentChecksProps) {
  const state = usePrimarySessionState();
  const access = resolvePrimaryOperateAccess({
    isPrimary: true,
    hasDesktopBridge: false,
    session: state.data,
    isPending: state.isPending,
    hasError: state.error !== null,
  });
  return <AuthorizedChecks {...props} access={access} />;
}

function RemoteChecks(props: EnvironmentChecksProps) {
  const state = useEnvironmentSessionState(props.environment.environmentId);
  const access = resolveRemoteOperateAccess({
    session: state.data,
    isPending: state.isPending,
    hasError: state.hasError,
  });
  return <AuthorizedChecks {...props} access={access} />;
}

function EnvironmentChecks(props: EnvironmentChecksProps) {
  if (props.environment.isPrimary) {
    return isElectron ? (
      <AuthorizedChecks {...props} access="granted" />
    ) : (
      <PrimaryChecks {...props} />
    );
  }
  return <RemoteChecks {...props} />;
}

function WorkspaceCheck({
  environmentId,
  cwd,
  providers,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  providers: ReadonlyArray<ServerProvider>;
}) {
  useProviderWorkspaceReadiness({ environmentId, cwd, providers });
  return null;
}

/** Each selected checkout owns an independent probe, including same-machine project groups. */
export function SettingsWorkspaceReadiness({
  scope,
  environments,
  children,
}: {
  scope: Pick<ResolvedSettingsScope, "kind" | "members">;
  environments: ReadonlyArray<ReadinessEnvironment>;
  children?: ReactNode;
}) {
  const projectScoped = scope.kind === "project" || scope.kind === "checkout";
  const [reports, setReports] = useState<
    ReadonlyMap<EnvironmentId, { owner: string; access: ProviderOperateAccess }>
  >(() => new Map());
  const report = useCallback<EnvironmentChecksProps["report"]>((environmentId, owner, access) => {
    setReports((current) => {
      const previous = current.get(environmentId);
      if (access === null) {
        if (previous?.owner !== owner) return current;
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      }
      if (previous?.owner === owner && previous.access === access) return current;
      return new Map(current).set(environmentId, { owner, access });
    });
  }, []);
  const value = useMemo(
    () =>
      new Map<EnvironmentId, ProviderOperateAccess>(
        projectScoped
          ? environments.map(
              (environment) =>
                [
                  environment.environmentId,
                  reports.get(environment.environmentId)?.access ?? "pending",
                ] as const,
            )
          : [],
      ),
    [environments, projectScoped, reports],
  );
  return (
    <WorkspaceAccessContext value={value}>
      {/* Probe membership must not reparent the Settings page or discard unsaved edits. */}
      <Fragment key="workspace-checks">
        {projectScoped
          ? environments.map((environment) => (
              <EnvironmentChecks
                key={environment.environmentId}
                environment={environment}
                scope={scope}
                report={report}
              />
            ))
          : null}
      </Fragment>
      {children}
    </WorkspaceAccessContext>
  );
}

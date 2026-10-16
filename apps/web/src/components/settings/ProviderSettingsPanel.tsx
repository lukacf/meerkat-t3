import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import {
  type EnvironmentId,
  type ProviderInstanceId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import { useMemo, useState, type ReactNode } from "react";
import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import { useEnvironmentSessionState } from "../../state/session";
import { cn } from "../../lib/utils";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ExpandableText } from "./ExpandableText";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { ProviderAccountsPanel } from "./ProviderAccountsPanel";
import {
  buildProviderEnvironmentOptions,
  classifyProviderEnvironmentAccess,
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
  resolveSelectedProviderEnvironmentId,
  type ProviderEnvironmentAccess,
  type ProviderOperateAccess,
} from "./ProviderSettingsPanel.logic";

function providerEnvironmentDetail(environment: EnvironmentPresentation): string {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return "Primary device";
  if (environment.relayManaged) return "T3 Connect";
  if (environment.entry.target._tag === "SshConnectionTarget") return "SSH";
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return "Local device";
  return environment.displayUrl ?? "Remote device";
}

// Shared by the editor grid and the placeholder states so switching devices
// never changes the card's footprint.
const providerCardHeightClassName = "min-h-56";

/**
 * Same chrome as the provider editor (section heading, floating device tabs,
 * tall card) for states that cannot render provider settings yet.
 */
function ProviderSettingsPlaceholder({
  deviceTabs,
  icon,
  title,
  description,
  children,
}: {
  readonly deviceTabs?: ReactNode;
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly children?: ReactNode;
}) {
  return (
    <SettingsSection {...searchableSetting("providers")} variant="plain">
      {deviceTabs ? (
        <div className="flex min-h-11 min-w-0 items-center px-3 sm:px-4">{deviceTabs}</div>
      ) : null}
      <SettingsGroup
        divided={false}
        className={cn(providerCardHeightClassName, "flex overflow-x-hidden overflow-y-auto")}
      >
        <Empty>
          <EmptyMedia variant="icon">{icon}</EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>{title}</EmptyTitle>
            <EmptyDescription>{description}</EmptyDescription>
          </EmptyHeader>
          {children ? <EmptyContent className="max-w-xl">{children}</EmptyContent> : null}
        </Empty>
      </SettingsGroup>
    </SettingsSection>
  );
}

function EnvironmentUnavailablePlaceholder({
  environment,
  access,
  deviceTabs,
}: {
  readonly environment: EnvironmentPresentation;
  readonly access: Exclude<ProviderEnvironmentAccess, { kind: "editable" | "read-only" }>;
  readonly deviceTabs?: ReactNode;
}) {
  const isLoading = access.kind === "loading";
  const title = isLoading
    ? "Loading provider settings"
    : access.kind === "error"
      ? "Could not connect to this device"
      : "Provider settings are unavailable";
  // Keep the description to a short status; the raw failure can be a
  // multi-paragraph CLI dump, so it goes below, clamped and expandable.
  const description = isLoading
    ? access.reason === "permissions"
      ? "Checking what this session is allowed to change."
      : `Waiting for ${environment.label}'s configuration.`
    : connectionStatusTitle(environment.connection);
  const error = isLoading ? null : environment.connection.error;
  // No spinner: this state can persist indefinitely for a wedged device, and a
  // continuously repainting animation would run the whole time.
  return (
    <ProviderSettingsPlaceholder
      deviceTabs={deviceTabs}
      icon={
        <EnvironmentMachineIcon kind={resolveEnvironmentMachineKind(environment.serverConfig)} />
      }
      title={title}
      description={description}
    >
      {error ? (
        <ExpandableText
          key={environment.environmentId}
          text={error}
          className="w-full text-left font-mono text-xs leading-relaxed text-muted-foreground"
        />
      ) : null}
    </ProviderSettingsPlaceholder>
  );
}

interface ProviderSettingsTarget {
  readonly environmentId?: EnvironmentId;
  readonly instanceId?: ProviderInstanceId;
  readonly scoped?: boolean;
}

export function ProviderSettingsPanel(target: ProviderSettingsTarget) {
  return (
    <SettingsPageContainer width="wide" className="@container/providers gap-8">
      <ProviderSettingsPanelContent
        key={`${target.environmentId ?? ""}:${target.instanceId ?? ""}`}
        {...target}
      />
    </SettingsPageContainer>
  );
}

function ProviderSettingsPanelContent(target: ProviderSettingsTarget) {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const options = useMemo(
    () => buildProviderEnvironmentOptions(environments, primaryEnvironmentId),
    [environments, primaryEnvironmentId],
  );
  // Raw user intent; the effective selection is re-derived every render so a
  // device that drops out of the catalog falls back without erasing the pick —
  // if it reappears (e.g. after a reconnect) the selection is restored.
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    target.environmentId ?? primaryEnvironmentId,
  );
  const targetEnvironmentMissing =
    target.environmentId !== undefined &&
    selectedEnvironmentId === target.environmentId &&
    !options.some((environment) => environment.environmentId === target.environmentId);
  const effectiveEnvironmentId =
    target.scoped || targetEnvironmentMissing
      ? target.environmentId
      : resolveSelectedProviderEnvironmentId(options, selectedEnvironmentId, primaryEnvironmentId);
  const selectedEnvironment =
    options.find((environment) => environment.environmentId === effectiveEnvironmentId) ?? null;
  const onlyPrimaryDevice =
    options.length === 1 && options[0]?.entry.target._tag === "PrimaryConnectionTarget";
  const deviceTabs =
    !target.scoped && !onlyPrimaryDevice && options.length > 0 ? (
      <ScrollArea radius="none" hideScrollbars scrollFade className="h-11 min-w-0 flex-1">
        <ToggleGroup
          aria-label="Devices"
          variant="segmented"
          className="my-2"
          value={effectiveEnvironmentId ? [effectiveEnvironmentId] : []}
          onValueChange={(next) => {
            const environment = options.find((option) => option.environmentId === next[0]);
            if (environment) setSelectedEnvironmentId(environment.environmentId);
          }}
        >
          {options.map((environment) => {
            const machine = resolveEnvironmentMachineKind(environment.serverConfig);
            const detail = providerEnvironmentDetail(environment);
            const statusText = connectionStatusTitle(environment.connection);
            return (
              <Tooltip key={environment.environmentId}>
                <TooltipTrigger
                  render={
                    <Toggle value={environment.environmentId}>
                      <EnvironmentMachineIcon
                        kind={machine}
                        className="size-3.5 shrink-0"
                        aria-hidden
                      />
                      <span className="max-w-40 truncate">{environment.label}</span>
                      {environment.connection.phase !== "connected" ? (
                        <ConnectionStatusDot
                          dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
                          pingClassName={connectionPhasePingClassName(environment.connection.phase)}
                        />
                      ) : null}
                      <span className="sr-only">
                        {detail}, {statusText}
                      </span>
                    </Toggle>
                  }
                />
                <TooltipPopup side="top">
                  {detail} · {statusText}
                </TooltipPopup>
              </Tooltip>
            );
          })}
        </ToggleGroup>
      </ScrollArea>
    ) : null;

  return (
    <>
      {targetEnvironmentMissing ? (
        <ProviderSettingsPlaceholder
          deviceTabs={deviceTabs}
          icon={<EnvironmentMachineIcon kind={resolveEnvironmentMachineKind(null)} />}
          title="Device unavailable"
          description="Reconnect this device to set up its provider, or select another device."
        />
      ) : null}
      {options.length === 0 && !targetEnvironmentMissing ? (
        <ProviderSettingsPlaceholder
          icon={<EnvironmentMachineIcon kind={resolveEnvironmentMachineKind(null)} />}
          title={isReady ? "No connected devices" : "Loading devices"}
          description={
            isReady
              ? "Connect a device to manage its provider accounts."
              : "Reading connected devices."
          }
        />
      ) : null}

      {selectedEnvironment ? (
        <SelectedEnvironmentProviderSettings
          key={selectedEnvironment.environmentId}
          environment={selectedEnvironment}
          deviceTabs={deviceTabs}
          targetInstanceId={
            target.environmentId === undefined ||
            selectedEnvironment.environmentId === target.environmentId
              ? target.instanceId
              : undefined
          }
        />
      ) : null}
    </>
  );
}

function SelectedEnvironmentProviderSettings({
  environment,
  deviceTabs,
  targetInstanceId,
}: {
  readonly environment: EnvironmentPresentation;
  readonly deviceTabs?: ReactNode;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
}) {
  const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
  if (isPrimary) {
    // The desktop app owns its primary server outright; a browser session
    // checks the scopes its cookie session was granted.
    if (isElectron) {
      return (
        <AccessGatedProviderSettings
          environment={environment}
          operateAccess="granted"
          deviceTabs={deviceTabs}
          targetInstanceId={targetInstanceId}
        />
      );
    }
    return (
      <PrimarySessionGatedProviderSettings
        environment={environment}
        deviceTabs={deviceTabs}
        targetInstanceId={targetInstanceId}
      />
    );
  }
  return (
    <RemoteSessionGatedProviderSettings
      environment={environment}
      deviceTabs={deviceTabs}
      targetInstanceId={targetInstanceId}
    />
  );
}

function PrimarySessionGatedProviderSettings({
  environment,
  deviceTabs,
  targetInstanceId,
}: {
  readonly environment: EnvironmentPresentation;
  readonly deviceTabs?: ReactNode;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
}) {
  const primarySessionState = usePrimarySessionState();
  const operateAccess = resolvePrimaryOperateAccess({
    isPrimary: true,
    hasDesktopBridge: false,
    session: primarySessionState.data,
    isPending: primarySessionState.isPending,
    hasError: primarySessionState.error !== null,
  });
  return (
    <AccessGatedProviderSettings
      environment={environment}
      operateAccess={operateAccess}
      deviceTabs={deviceTabs}
      targetInstanceId={targetInstanceId}
    />
  );
}

function RemoteSessionGatedProviderSettings({
  environment,
  deviceTabs,
  targetInstanceId,
}: {
  readonly environment: EnvironmentPresentation;
  readonly deviceTabs?: ReactNode;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
}) {
  const sessionState = useEnvironmentSessionState(environment.environmentId);
  const operateAccess = resolveRemoteOperateAccess({
    session: sessionState.data,
    isPending: sessionState.isPending,
    hasError: sessionState.hasError,
  });
  return (
    <AccessGatedProviderSettings
      environment={environment}
      operateAccess={operateAccess}
      deviceTabs={deviceTabs}
      targetInstanceId={targetInstanceId}
    />
  );
}

function AccessGatedProviderSettings({
  environment,
  operateAccess,
  deviceTabs,
  targetInstanceId,
}: {
  readonly environment: EnvironmentPresentation;
  readonly operateAccess: ProviderOperateAccess;
  readonly deviceTabs?: ReactNode;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
}) {
  const access = classifyProviderEnvironmentAccess({
    connectionPhase: environment.connection.phase,
    hasServerConfig: environment.serverConfig !== null,
    operateAccess,
  });
  if (access.kind !== "editable" && access.kind !== "read-only") {
    return (
      <EnvironmentUnavailablePlaceholder
        environment={environment}
        access={access}
        deviceTabs={deviceTabs}
      />
    );
  }
  return (
    <EnvironmentProviderSettings
      environmentId={environment.environmentId}
      environmentLabel={environment.label}
      readOnly={access.kind === "read-only"}
      deviceTabs={deviceTabs}
      targetInstanceId={targetInstanceId}
    />
  );
}

export function EnvironmentProviderSettings({
  environmentId,
  environmentLabel,
  readOnly = false,
  deviceTabs,
  targetInstanceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly deviceTabs?: ReactNode;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
  readonly readOnly?: boolean;
}) {
  return (
    <SettingsSection {...searchableSetting("providers")} variant="plain">
      {deviceTabs}
      <ProviderAccountsPanel
        environmentId={environmentId}
        instanceId={targetInstanceId}
        readOnly={readOnly}
        environmentLabel={environmentLabel}
      />
    </SettingsSection>
  );
}

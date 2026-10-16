import { type ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { memo } from "react";
import { InfoIcon, XIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button, InlineButton } from "../ui/button";
import { ErrorDetailsDialog } from "./ErrorDetailsDialog";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Unsupported and broken versions fail mid-turn, so they warn even when ready. */
function getIncompatibleVersion(status: ServerProvider) {
  const compatibility = status.compatibilityAdvisory;
  return compatibility?.status === "unsupported" || compatibility?.status === "broken"
    ? compatibility
    : null;
}

export function getProviderStatusBannerKey(status: ServerProvider | null): string | null {
  if (!status || status.status === "disabled") return null;
  if (status.status === "ready") {
    const incompatible = getIncompatibleVersion(status);
    return incompatible
      ? [status.instanceId, incompatible.status, status.version ?? ""].join("\u0000")
      : null;
  }
  // Antigravity checks saved credentials when a session starts. Its local
  // health check leaves auth unknown after a restart, which is not a failure.
  if (
    status.driver === "antigravity" &&
    status.installed &&
    status.status === "warning" &&
    status.auth.status === "unknown"
  ) {
    return null;
  }
  return [status.instanceId, status.status, status.auth.status, status.message ?? ""].join(
    "\u0000",
  );
}

export function shouldShowProviderStatusBanner(
  status: ServerProvider | null,
  dismissedBannerKey: string | null,
): boolean {
  const bannerKey = getProviderStatusBannerKey(status);
  return bannerKey !== null && bannerKey !== dismissedBannerKey;
}

export function hasProviderSetup(status: ServerProvider): boolean {
  return (
    status.driver === "meerkat" ||
    status.driver === "antigravity" ||
    status.setup?.canAuthenticate === true ||
    status.setup?.canInstall === true
  );
}

/** Model access summaries also appear in the model picker. */
export function getProviderStatusMessage(status: ServerProvider): string {
  const providerName =
    status.driver === "meerkat"
      ? "Model access"
      : status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  if (status.driver === "meerkat") {
    if (!status.installed || status.availability === "unavailable")
      return "Model access is unavailable on this computer. Check Settings > Providers.";
    if (status.auth.status === "unauthenticated")
      return "Connect an account in Settings > Providers to use its models.";
    return status.status === "ready"
      ? "No models are available for the connected accounts."
      : "Could not check model access. Open Settings > Providers to retry.";
  }
  if (status.message) return status.message;
  if (!status.installed && hasProviderSetup(status)) {
    return `Open provider setup to install ${formatProviderDriverKindLabel(status.driver)} on this environment.`;
  }
  if (status.auth.status === "unauthenticated") {
    if (hasProviderSetup(status)) {
      return status.driver === "antigravity"
        ? "Open provider setup to sign in with Google."
        : "Open provider setup to sign in.";
    }
    return "Sign in via the CLI to authenticate again.";
  }
  return status.status === "ready"
    ? "No models are available for this provider."
    : status.status === "error"
      ? `${providerName} provider is unavailable.`
      : `${providerName} provider has limited availability.`;
}

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  onDismiss,
  onOpenProviderSetup,
  status,
}: {
  onDismiss: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  status: ServerProvider | null;
}) {
  if (!status || getProviderStatusBannerKey(status) === null) {
    return null;
  }

  const providerName =
    status.driver === "meerkat"
      ? "Model access"
      : status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const isUnauthenticated = status.status === "error" && status.auth.status === "unauthenticated";
  const incompatible = status.status === "ready" ? getIncompatibleVersion(status) : null;
  const title =
    status.driver === "meerkat"
      ? status.auth.status === "unauthenticated"
        ? "Connect an account"
        : "Model access needs attention"
      : isUnauthenticated
        ? `${providerName} is unauthenticated`
        : incompatible
          ? `${providerName} ${status.version ?? ""} is ${incompatible.status === "broken" ? "known to be broken" : "unsupported"}`
          : `${providerName} provider status`;
  const message = incompatible?.message ?? getProviderStatusMessage(status);
  const details = status.driver === "meerkat" && status.message !== message ? status.message : null;
  const isWarning = status.status === "warning" || incompatible !== null;

  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert
        variant={isWarning ? "warning" : "error"}
        role={incompatible && incompatible.status !== "broken" ? "status" : "alert"}
        surface="glass"
        controlAlignment="first-line"
      >
        <InfoIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>
          {status.driver === "meerkat" ? (
            <>
              <p>{message}</p>
              {details ? (
                <ErrorDetailsDialog
                  key={getProviderStatusBannerKey(status)}
                  description={message}
                  details={details}
                />
              ) : null}
            </>
          ) : (
            <Tooltip>
              <TooltipTrigger render={<div className="line-clamp-3" />}>{message}</TooltipTrigger>
              <TooltipPopup side="top" className="whitespace-pre-wrap">
                {message}
              </TooltipPopup>
            </Tooltip>
          )}
          {onOpenProviderSetup && hasProviderSetup(status) ? (
            <InlineButton onClick={() => onOpenProviderSetup(status.instanceId)}>
              {status.driver === "meerkat" ? "Open provider settings" : "Open provider setup"}
            </InlineButton>
          ) : null}
        </AlertDescription>
        <AlertAction>
          <Button
            aria-label={`Dismiss ${providerName} provider ${status.status}`}
            onClick={onDismiss}
            size="icon-xs"
            variant="ghost-muted"
          >
            <XIcon />
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
});

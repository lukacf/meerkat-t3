import type { AdvertisedEndpoint, DesktopBridge, DesktopWslState } from "@t3tools/contracts";
import { readHostedPairingRequest } from "../../hostedPairing";
import { getPairingTokenFromUrl } from "../../pairingUrl";

type RemotePairingFields = { readonly host: string; readonly pairingCode: string };

export function parsePairingUrlFields(
  input: string,
  origin = window.location.origin,
): RemotePairingFields | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const urlLikeInput =
      /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(trimmed) || trimmed.startsWith("//")
        ? trimmed
        : `https://${trimmed}`;
    const url = new URL(urlLikeInput, origin);
    const hostedPairingRequest = readHostedPairingRequest(url);
    if (hostedPairingRequest)
      return { host: hostedPairingRequest.host, pairingCode: hostedPairingRequest.token };
    const pairingCode = getPairingTokenFromUrl(url);
    return pairingCode ? { host: url.origin, pairingCode } : null;
  } catch {
    return null;
  }
}

export function parseRemotePairingFields(
  input: RemotePairingFields,
  origin = window.location.origin,
): RemotePairingFields {
  const parsedPairingUrl =
    parsePairingUrlFields(input.host, origin) ?? parsePairingUrlFields(input.pairingCode, origin);
  if (parsedPairingUrl) return parsedPairingUrl;
  const host = input.host.trim();
  const pairingCode = input.pairingCode.trim();
  if (!host) throw new Error("Enter a backend host.");
  if (!pairingCode) throw new Error("Enter a pairing code.");
  return { host, pairingCode };
}

type WslEnableBridge = Pick<DesktopBridge, "setWslBackendEnabled" | "setWslDistro" | "setWslOnly">;

/** Network exposure does not disable pairing between clients on the same machine. */
export function pairingEndpointsForExposure(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  networkAccessible: boolean,
): ReadonlyArray<AdvertisedEndpoint> {
  return endpoints.filter(
    (endpoint) =>
      networkAccessible ||
      endpoint.reachability === "loopback" ||
      endpoint.id.startsWith("tailscale-magicdns:"),
  );
}

export function endpointDefaultPreferenceKey(endpoint: AdvertisedEndpoint): string {
  if (endpoint.id.startsWith("desktop-loopback:")) {
    return "desktop-core:loopback:http";
  }
  if (endpoint.id.startsWith("desktop-lan:")) {
    return "desktop-core:lan:http";
  }
  if (endpoint.id.startsWith("tailscale-ip:")) {
    return "tailscale:ip:http";
  }
  if (endpoint.id.startsWith("tailscale-magicdns:")) {
    return "tailscale:magicdns:https";
  }

  let scheme = "unknown";
  try {
    scheme = new URL(endpoint.httpBaseUrl).protocol.replace(/:$/u, "");
  } catch {
    // Keep the stored preference stable even if a custom endpoint is malformed.
  }

  return `${endpoint.provider.id}:${endpoint.reachability}:${scheme}:${endpoint.label}`;
}

export function selectPairingEndpoint(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  defaultEndpointKey?: string | null,
): AdvertisedEndpoint | null {
  const availableEndpoints = endpoints.filter((endpoint) => endpoint.status !== "unavailable");
  if (defaultEndpointKey) {
    const selectedEndpoint = availableEndpoints.find(
      (endpoint) => endpointDefaultPreferenceKey(endpoint) === defaultEndpointKey,
    );
    if (selectedEndpoint) {
      return selectedEndpoint;
    }
  }
  return (
    availableEndpoints.find((endpoint) => endpoint.isDefault) ??
    availableEndpoints.find((endpoint) => endpoint.reachability !== "loopback") ??
    availableEndpoints.find((endpoint) => endpoint.compatibility.hostedHttpsApp === "compatible") ??
    availableEndpoints.find((endpoint) => endpoint.reachability === "loopback") ??
    null
  );
}

/**
 * A QR code encoding a loopback URL makes the scanning device dial itself, so
 * loopback endpoints stay copyable from the endpoint menu but are never
 * offered as QR targets.
 */
export function isQrShareableEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.status !== "unavailable" && endpoint.reachability !== "loopback";
}

export function isWslSettingsRowVisible(input: {
  readonly state: DesktopWslState | null;
  readonly error: string | null;
}): boolean {
  const { state, error } = input;
  return state ? state.available || state.enabled || state.wslOnly : error !== null;
}

export type QrEndpointOption = {
  /** Unique per endpoint instance (AdvertisedEndpoint.id); safe as a React key. */
  readonly id: string;
  /**
   * Stable per endpoint *type* (endpointDefaultPreferenceKey). Multiple
   * endpoints can share one, so it is only used to match the saved default.
   */
  readonly preferenceKey: string;
  /** False for endpoints that stay copyable but must never render as a QR. */
  readonly qrShareable: boolean;
};

/**
 * Resolves which endpoint the share panel shows: the user's explicit pick,
 * else the saved default endpoint, else the first QR-shareable option (so the
 * panel never opens on a loopback QR), else the first option. A stale
 * selectedId (endpoint disappeared) falls back rather than blanking the panel.
 */
export function selectQrEndpointOption<T extends QrEndpointOption>(
  options: ReadonlyArray<T>,
  selectedId: string | null,
  defaultPreferenceKey: string | null,
): T | null {
  return (
    (selectedId !== null ? options.find((option) => option.id === selectedId) : undefined) ??
    (defaultPreferenceKey !== null
      ? options.find((option) => option.preferenceKey === defaultPreferenceKey)
      : undefined) ??
    options.find((option) => option.qrShareable) ??
    options[0] ??
    null
  );
}

export async function applyWslEnableSelection(input: {
  readonly bridge: WslEnableBridge;
  readonly mode: "both" | "wsl-only";
  readonly nextDistro: string | null;
  readonly persistedDistro: string | null;
}): Promise<DesktopWslState> {
  const { bridge, mode, nextDistro, persistedDistro } = input;

  // Stage every preference before enabling. The desktop only relaunches for
  // mode/distro changes while WSL is active, so the final enable observes the
  // complete selection and is the only call that may relaunch.
  await bridge.setWslOnly(mode === "wsl-only");
  if (persistedDistro !== nextDistro) {
    await bridge.setWslDistro(nextDistro);
  }
  return await bridge.setWslBackendEnabled(true);
}

import type { AdvertisedEndpoint, DesktopWslState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyWslEnableSelection,
  isQrShareableEndpoint,
  isWslSettingsRowVisible,
  pairingEndpointsForExposure,
  parsePairingUrlFields,
  parseRemotePairingFields,
  selectPairingEndpoint,
  selectQrEndpointOption,
} from "./ConnectionsSettings.logic";

describe("pairing fields", () => {
  const origin = "http://localhost:3000";
  it.each(["host", "pairingCode"] as const)(
    "accepts a full direct link in the %s field",
    (field) => {
      const input = { host: "", pairingCode: "" };
      input[field] = "https://workspace.example:4000/pair#token=example-pairing";
      expect(parseRemotePairingFields(input, origin)).toEqual({
        host: "https://workspace.example:4000",
        pairingCode: "example-pairing",
      });
    },
  );
  it.each(["host", "pairingCode"] as const)("accepts a hosted link in the %s field", (field) => {
    const input = { host: "", pairingCode: "" };
    input[field] =
      "https://app.example/pair?host=http%3A%2F%2Fworkspace.example%3A4000#token=example-pairing";
    expect(parseRemotePairingFields(input, origin)).toEqual({
      host: "http://workspace.example:4000",
      pairingCode: "example-pairing",
    });
  });
  it("preserves a separately entered code and requires a host for it", () => {
    expect(parsePairingUrlFields("EXAMPLE-CODE", origin)).toBeNull();
    expect(
      parseRemotePairingFields(
        { host: " workspace.example:4000 ", pairingCode: " EXAMPLE-CODE " },
        origin,
      ),
    ).toEqual({
      host: "workspace.example:4000",
      pairingCode: "EXAMPLE-CODE",
    });
    expect(() =>
      parseRemotePairingFields({ host: "", pairingCode: "EXAMPLE-CODE" }, origin),
    ).toThrow("Enter a backend host.");
    expect(() =>
      parseRemotePairingFields({ host: "workspace.example", pairingCode: "" }, origin),
    ).toThrow("Enter a pairing code.");
  });
});

const baseWslState: DesktopWslState = {
  enabled: false,
  distro: null,
  available: true,
  wslOnly: true,
  distros: [],
  preflightError: null,
};

describe("isWslSettingsRowVisible", () => {
  it("shows the retry row when the WSL state failed to load", () => {
    expect(isWslSettingsRowVisible({ state: null, error: "load failed" })).toBe(true);
  });

  it("hides an unavailable and unused WSL snapshot", () => {
    expect(
      isWslSettingsRowVisible({
        state: { ...baseWslState, available: false, wslOnly: false },
        error: null,
      }),
    ).toBe(false);
  });

  it("shows an available WSL snapshot", () => {
    expect(isWslSettingsRowVisible({ state: baseWslState, error: null })).toBe(true);
  });
});

describe("applyWslEnableSelection", () => {
  it("clears WSL-only and updates the distro before enabling both backends", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = true;
    let persistedDistro: string | null = "Ubuntu";
    const setWslDistro = vi.fn(async (distro: string | null) => {
      calls.push(`setWslDistro:${distro ?? "default"}`);
      persistedDistro = distro;
      return { ...baseWslState, distro, wslOnly: persistedWslOnly };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return {
        ...baseWslState,
        enabled,
        distro: persistedDistro,
        wslOnly: persistedWslOnly,
      };
    });
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, distro: persistedDistro, wslOnly: enabled };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "both",
      nextDistro: "Debian",
      persistedDistro: "Ubuntu",
    });

    expect(calls).toEqual(["setWslOnly:false", "setWslDistro:Debian", "setWslBackendEnabled:true"]);
    expect(state).toMatchObject({ enabled: true, distro: "Debian", wslOnly: false });
  });

  it("stages WSL-only before enabling without rewriting an unchanged distro", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = false;
    const setWslDistro = vi.fn(async () => baseWslState);
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, wslOnly: enabled };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return { ...baseWslState, enabled, wslOnly: persistedWslOnly };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "wsl-only",
      nextDistro: null,
      persistedDistro: null,
    });

    expect(calls).toEqual(["setWslOnly:true", "setWslBackendEnabled:true"]);
    expect(setWslDistro).not.toHaveBeenCalled();
    expect(state).toMatchObject({ enabled: true, wslOnly: true });
  });
});

function makeEndpoint(overrides: Partial<AdvertisedEndpoint>): AdvertisedEndpoint {
  return {
    id: "desktop-lan:http://192.168.1.42:4780",
    label: "Local network",
    provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
    httpBaseUrl: "http://192.168.1.42:4780",
    wsBaseUrl: "ws://192.168.1.42:4780",
    reachability: "lan",
    compatibility: { hostedHttpsApp: "unknown", desktopApp: "compatible" },
    source: "desktop-core",
    status: "available",
    ...overrides,
  };
}

describe("local host pairing", () => {
  const local = makeEndpoint({
    id: "desktop-loopback:4780",
    label: "This machine",
    reachability: "loopback",
    httpBaseUrl: "http://127.0.0.1:4780",
    wsBaseUrl: "ws://127.0.0.1:4780",
    compatibility: { hostedHttpsApp: "mixed-content-blocked", desktopApp: "compatible" },
  });
  const lan = makeEndpoint({ isDefault: true });

  it("keeps the local pairing link available with network access off and never offers its QR", () => {
    const endpoints = pairingEndpointsForExposure([local, lan], false);
    expect(endpoints).toEqual([local]);
    expect(selectPairingEndpoint(endpoints)).toBe(local);
    expect(isQrShareableEndpoint(selectPairingEndpoint(endpoints)!)).toBe(false);
    expect(
      parsePairingUrlFields(
        `${local.httpBaseUrl}/pair#token=example-local-pairing`,
        local.httpBaseUrl,
      ),
    ).toEqual({ host: local.httpBaseUrl, pairingCode: "example-local-pairing" });
  });

  it("retains the reachable default when network access is enabled", () => {
    const endpoints = pairingEndpointsForExposure([local, lan], true);
    expect(endpoints).toEqual([local, lan]);
    expect(selectPairingEndpoint(endpoints)).toBe(lan);
    expect(selectPairingEndpoint(endpoints, "desktop-core:loopback:http")).toBe(local);
  });

  it("keeps an independent HTTPS tunnel when LAN exposure is off", () => {
    const tunnel = makeEndpoint({
      id: "tailscale-magicdns:host.example.test",
      reachability: "private-network",
      httpBaseUrl: "https://host.example.test",
      wsBaseUrl: "wss://host.example.test",
    });
    const endpoints = pairingEndpointsForExposure([local, lan, tunnel], false);
    expect(endpoints).toEqual([local, tunnel]);
    expect(selectPairingEndpoint(endpoints)).toBe(tunnel);
  });

  it("falls back from a vanished remote choice but never selects an unavailable endpoint", () => {
    expect(selectPairingEndpoint([local], "desktop-core:lan:http")).toBe(local);
    expect(
      selectPairingEndpoint([{ ...local, status: "unavailable" }], "desktop-core:loopback:http"),
    ).toBeNull();
    expect(selectPairingEndpoint([])).toBeNull();
  });
});

describe("isQrShareableEndpoint", () => {
  it("excludes loopback endpoints so a scanned phone never dials itself", () => {
    expect(
      isQrShareableEndpoint(
        makeEndpoint({
          id: "desktop-loopback:4780",
          reachability: "loopback",
          httpBaseUrl: "http://127.0.0.1:4780",
        }),
      ),
    ).toBe(false);
  });

  it("excludes unavailable endpoints and keeps reachable ones", () => {
    expect(isQrShareableEndpoint(makeEndpoint({ status: "unavailable" }))).toBe(false);
    expect(isQrShareableEndpoint(makeEndpoint({}))).toBe(true);
    expect(
      isQrShareableEndpoint(makeEndpoint({ reachability: "private-network", status: "unknown" })),
    ).toBe(true);
  });
});

describe("selectQrEndpointOption", () => {
  const options = [
    {
      id: "desktop-loopback:4780",
      preferenceKey: "desktop-core:loopback:http",
      qrShareable: false,
    },
    {
      id: "tailscale-ip:http://100.84.12.7:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "tailscale-ip:http://100.84.12.8:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "desktop-lan:http://192.168.1.42:4780",
      preferenceKey: "desktop-core:lan:http",
      qrShareable: true,
    },
  ];

  it("resolves an explicit selection by unique endpoint id, not the shared preference key", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:http://100.84.12.8:4780", null)?.id).toBe(
      "tailscale-ip:http://100.84.12.8:4780",
    );
  });

  it("falls back to the saved default preference key when nothing is selected", () => {
    expect(selectQrEndpointOption(options, null, "desktop-core:lan:http")?.id).toBe(
      "desktop-lan:http://192.168.1.42:4780",
    );
  });

  it("skips non-QR-shareable options in the fallback so the panel never opens on loopback", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:gone", "nope")?.id).toBe(
      "tailscale-ip:http://100.84.12.7:4780",
    );
  });

  it("returns the first option when nothing is QR-shareable, and null when empty", () => {
    const loopbackOnly = options.slice(0, 1);
    expect(selectQrEndpointOption(loopbackOnly, null, null)?.id).toBe("desktop-loopback:4780");
    expect(selectQrEndpointOption([], "anything", "anything")).toBeNull();
  });
});

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopAppBrandingSchema, DesktopEnvironmentBootstrapSchema } from "./ipc.ts";

describe("DesktopAppBrandingSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopAppBrandingSchema);
  const branding = {
    baseName: "Meerkat T3",
    stageLabel: "Prototype",
    displayName: "Meerkat T3 (Prototype)",
  };

  it.each(["Latest", "Internal Validation"])("accepts the %s product stage", (stageLabel) => {
    const current = {
      baseName: "MeerkaT3",
      stageLabel,
      displayName: stageLabel === "Latest" ? "MeerkaT3" : `MeerkaT3 (${stageLabel})`,
      appVersion: "0.0.56",
    };
    expect(decode(current)).toEqual(current);
  });

  it("preserves the running shell version while accepting older desktop payloads", () => {
    expect(decode({ ...branding, appVersion: "0.0.56" })).toEqual({
      ...branding,
      appVersion: "0.0.56",
    });
    expect(decode(branding)).toEqual(branding);
  });
});

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  resolveServerBackedAppDisplayName,
  resolveServerBackedAppStageLabel,
} from "./branding.logic";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();

  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }

  globalThis.window = originalWindow;
});

describe("branding", () => {
  it("uses injected desktop branding when available", async () => {
    vi.stubEnv("APP_VERSION", "0.0.42");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getAppBranding: () => ({
            baseName: "T3 Code",
            stageLabel: "Nightly",
            displayName: "T3 Code (Nightly)",
            appVersion: "0.0.56",
          }),
        },
      },
    });

    const branding = await import("./branding");

    expect(branding.APP_BASE_NAME).toBe("T3 Code");
    expect(branding.APP_STAGE_LABEL).toBe("Nightly");
    expect(branding.APP_DISPLAY_NAME).toBe("T3 Code (Nightly)");
    expect(branding.APP_VERSION).toBe("0.0.56");
  });

  it.each([undefined, ""])(
    "keeps the compiled client version when older desktop branding has version %j",
    async (appVersion) => {
      vi.stubEnv("APP_VERSION", "0.0.42");
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
          desktopBridge: {
            getAppBranding: () => ({
              baseName: "Meerkat T3",
              stageLabel: "Prototype",
              displayName: "Meerkat T3 (Prototype)",
              ...(appVersion === undefined ? {} : { appVersion }),
            }),
          },
        },
      });

      const branding = await import("./branding");
      expect(branding.APP_VERSION).toBe("0.0.42");
    },
  );

  it("uses the web build version without a desktop shell", async () => {
    vi.stubEnv("APP_VERSION", "1.2.3");
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    const branding = await import("./branding");
    expect(branding.APP_VERSION).toBe("1.2.3");
  });

  it("uses the public product name for a standalone production build", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "");
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    const branding = await import("./branding");
    expect(branding.APP_BASE_NAME).toBe("MeerkaT3");
    expect(branding.APP_STAGE_LABEL).toBe("Latest");
    expect(branding.APP_DISPLAY_NAME).toBe("MeerkaT3");
  });

  it("labels standalone development builds explicitly", async () => {
    vi.stubEnv("DEV", true);
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "");
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    const branding = await import("./branding");
    expect(branding.APP_STAGE_LABEL).toBe("Dev");
    expect(branding.APP_DISPLAY_NAME).toBe("MeerkaT3 (Dev)");
  });

  it("preserves the packaged validation label over hosted metadata", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "nightly");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getAppBranding: () => ({
            baseName: "MeerkaT3",
            stageLabel: "Internal Validation",
            displayName: "MeerkaT3 (Internal Validation)",
            appVersion: "0.0.56",
          }),
        },
      },
    });
    const branding = await import("./branding");
    expect(branding.APP_STAGE_LABEL).toBe("Internal Validation");
    expect(branding.APP_DISPLAY_NAME).toBe("MeerkaT3 (Internal Validation)");
  });

  it("normalizes hosted app channel metadata", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "nightly");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBe("nightly");
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBe("Nightly");
    expect(branding.APP_STAGE_LABEL).toBe("Nightly");
    expect(branding.APP_DISPLAY_NAME).toBe("MeerkaT3 (Nightly)");
  });

  it("does not label the latest hosted app channel", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "latest");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBe("latest");
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBe("Latest");
    expect(branding.APP_STAGE_LABEL).toBe("Latest");
    expect(branding.APP_DISPLAY_NAME).toBe("MeerkaT3");
  });

  it("ignores unknown hosted app channels", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "preview");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBeNull();
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBeNull();
  });
});

describe("branding logic", () => {
  it.each(["Dev", "Internal Validation"])(
    "preserves the %s shell identity when connected to a nightly server",
    (stageLabel) => {
      expect(
        resolveServerBackedAppDisplayName({
          baseName: "MeerkaT3",
          fallbackDisplayName: `MeerkaT3 (${stageLabel})`,
          fallbackStageLabel: stageLabel,
          primaryServerVersion: "0.0.56-nightly.20261010.1",
        }),
      ).toBe(`MeerkaT3 (${stageLabel})`);
    },
  );

  it("returns Nightly for nightly primary server versions", () => {
    expect(
      resolveServerBackedAppStageLabel({
        primaryServerVersion: "0.0.28-nightly.20260616.12",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Nightly");
  });

  it("updates the display name for nightly primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "T3 Code",
        fallbackDisplayName: "T3 Code (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.28-nightly.20260616.12",
      }),
    ).toBe("T3 Code (Nightly)");
  });

  it("keeps the fallback display name for stable primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "T3 Code",
        fallbackDisplayName: "T3 Code (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.27",
      }),
    ).toBe("T3 Code (Alpha)");
  });

  it("keeps the fallback display name for malformed nightly primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "T3 Code",
        fallbackDisplayName: "T3 Code (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.28-nightly.20260616",
      }),
    ).toBe("T3 Code (Alpha)");
  });
});

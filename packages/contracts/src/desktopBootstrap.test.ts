import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopBackendBootstrap } from "./desktopBootstrap.ts";

const bootstrap = {
  mode: "desktop",
  noBrowser: true,
  port: 3773,
  host: "127.0.0.1",
  desktopBootstrapToken: "test-token",
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
};
const decode = Schema.decodeUnknownSync(DesktopBackendBootstrap);
const encode = Schema.encodeSync(Schema.fromJsonString(DesktopBackendBootstrap));

describe("DesktopBackendBootstrap parent lifetime", () => {
  it("preserves the dedicated parent lifetime descriptor through the wire envelope", () => {
    const decoded = decode({ ...bootstrap, desktopParentLifetimeFd: 6 });
    expect(JSON.parse(encode(decoded))).toHaveProperty("desktopParentLifetimeFd", 6);
  });

  it("accepts desktop launches without a parent lifetime descriptor", () => {
    expect(decode(bootstrap)).not.toHaveProperty("desktopParentLifetimeFd");
  });

  it.each([0, -1, 1, 2, 3, 4, 5, 6.5, "6"])(
    "rejects invalid parent lifetime descriptor %s",
    (fd) => {
      expect(() => decode({ ...bootstrap, desktopParentLifetimeFd: fd })).toThrow();
    },
  );

  it.each(["desktopTelemetryFd", "desktopTelemetryControlFd"])(
    "rejects a parent lifetime descriptor shared with %s",
    (field) => {
      expect(() => decode({ ...bootstrap, desktopParentLifetimeFd: 6, [field]: 6 })).toThrow();
    },
  );

  it("preserves the distinct bootstrap and telemetry descriptors", () => {
    expect(
      decode({
        ...bootstrap,
        desktopTelemetryFd: 4,
        desktopTelemetryControlFd: 5,
        desktopParentLifetimeFd: 6,
      }),
    ).toMatchObject({
      desktopTelemetryFd: 4,
      desktopTelemetryControlFd: 5,
      desktopParentLifetimeFd: 6,
    });
  });
});

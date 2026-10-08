import * as Schema from "effect/Schema";

import { PortSchema, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DesktopBackendBootstrap = Schema.Struct({
  mode: Schema.Literal("desktop"),
  noBrowser: Schema.Boolean,
  port: PortSchema,
  // Omitted when the desktop launches the backend inside WSL, since the
  // Windows-side baseDir maps to /mnt/c/... and the Linux side should use its
  // own home directory instead.
  t3Home: Schema.optional(Schema.String),
  host: Schema.String,
  desktopBootstrapToken: Schema.String,
  desktopAppVersion: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: PortSchema,
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
  otlpLogsUrl: Schema.optional(Schema.String),
  desktopTelemetryFd: Schema.optionalKey(PositiveInt),
  desktopTelemetryControlFd: Schema.optionalKey(PositiveInt),
  // Dedicated desktop-owned pipe, separate from bootstrap and telemetry.
  // Standalone and WSL launches omit it.
  desktopParentLifetimeFd: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(6))),
  resourceMonitorPath: Schema.optionalKey(TrimmedNonEmptyString),
}).check(
  Schema.makeFilter(
    (bootstrap) =>
      bootstrap.desktopParentLifetimeFd === undefined ||
      (bootstrap.desktopParentLifetimeFd !== bootstrap.desktopTelemetryFd &&
        bootstrap.desktopParentLifetimeFd !== bootstrap.desktopTelemetryControlFd),
  ),
);

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;

/** Written to `<t3Home>/runtime` just before the desktop app stops its
    backend to install an update. The updated app starts a new backend right
    away, so a backend that sees a fresh marker at shutdown keeps its managed
    tunnel. */
export const DESKTOP_UPDATE_RESTART_MARKER_FILE = "desktop-update-restart";

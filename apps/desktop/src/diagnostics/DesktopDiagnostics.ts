// @effect-diagnostics nodeBuiltinImport:off - desktop support reports read only OS/build metadata.
import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { DesktopDiagnosticsExportResult } from "@t3tools/contracts";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";

type StartupStage = "when-ready" | "bootstrap";
type ManifestState = "available" | "missing" | "invalid" | "unreadable";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const version = (value: unknown) => typeof value === "string" && value.length <= 80 && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value) ? value : null;
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T | null =>
  values.find((candidate) => candidate === value) ?? null;
const UnknownJson = Schema.fromJsonString(Schema.Unknown);

/** Build a new allowlisted object. Never spread source records, errors, settings or log lines. */
export function makeSupportReport(input: {
  appVersion: string;
  packaged: boolean;
  platform: string;
  architecture: string;
  osRelease: string;
  versions: Record<string, string | undefined>;
  generatedAt: string;
  manifestState: ManifestState;
  manifest: unknown;
  startupFailure: StartupStage | null;
  quitting: boolean;
  backend: { ready: boolean; desiredRunning: boolean; processRunning: boolean; restartAttempt: number; restartScheduled: boolean };
}) {
  const manifest = record(input.manifest) ? input.manifest : {};
  const build = record(manifest.build) ? manifest.build : {};
  const manifestValid = manifest.format === 1 && version(build.gatewayVersion) !== null &&
    version(build.meerkatVersion) !== null && version(build.mobkitVersion) !== null && hash(build.cargoLockSha256) !== null;
  return {
    format: "meerkat-t3-support-report",
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    product: { name: "Meerkat T3", version: version(input.appVersion), packaged: input.packaged },
    system: {
      platform: oneOf(input.platform, ["darwin", "linux", "win32"]),
      architecture: oneOf(input.architecture, ["arm64", "x64", "ia32"]),
      osRelease: /^\d+(?:\.\d+){1,3}$/.test(input.osRelease) ? input.osRelease : null,
      electron: version(input.versions.electron), node: version(input.versions.node), chromium: version(input.versions.chrome),
    },
    nativeBuild: {
      source: "bundled-manifest-not-a-live-runtime-probe",
      status: input.manifestState === "available" && !manifestValid ? "invalid" : input.manifestState,
      gatewayVersion: manifestValid ? version(build.gatewayVersion) : null,
      meerkatVersion: manifestValid ? version(build.meerkatVersion) : null,
      mobkitVersion: manifestValid ? version(build.mobkitVersion) : null,
      cargoLockSha256: manifestValid ? hash(build.cargoLockSha256) : null,
      platform: manifestValid ? oneOf(build.platform, ["macos", "linux", "windows", "darwin", "win32"]) : null,
      architecture: manifestValid ? oneOf(build.arch, ["aarch64", "x86_64", "arm64", "x64"]) : null,
    },
    health: {
      scope: "local-desktop-primary-backend",
      startupFailure: input.startupFailure,
      quitting: input.quitting,
      backend: {
        ready: input.backend.ready, desiredRunning: input.backend.desiredRunning,
        processRunning: input.backend.processRunning, restartScheduled: input.backend.restartScheduled,
        restartAttempt: Number.isSafeInteger(input.backend.restartAttempt) && input.backend.restartAttempt >= 0 ? Math.min(input.backend.restartAttempt, 1_000_000) : null,
      },
    },
    excluded: ["logs", "error messages and stacks", "prompts and responses", "file and project paths", "project and account names", "credentials", "environment variables", "network addresses", "process command lines", "screenshots"],
  };
}

export class DesktopDiagnostics extends Context.Service<
  DesktopDiagnostics,
  {
    readonly exportReport: Effect.Effect<DesktopDiagnosticsExportResult>;
    readonly recordStartupFailure: (stage: StartupStage) => Effect.Effect<void>;
    readonly offerStartupReport: Effect.Effect<void>;
  }
>()("@t3tools/desktop/diagnostics/DesktopDiagnostics") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const state = yield* DesktopState.DesktopState;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const startupFailure = yield* Ref.make<StartupStage | null>(null);
  const manifestFile = path.join(environment.resourcesPath, "meerkat-runtime", "manifest.json");

  const collect = Effect.gen(function* () {
    let manifest: unknown = null;
    let manifestState: ManifestState = "missing";
    const read = yield* fs.stat(manifestFile).pipe(Effect.result);
    if (read._tag === "Success") {
      if (read.success.size > 1_048_576n) manifestState = "invalid";
      else {
        const contents = yield* fs.readFileString(manifestFile).pipe(Effect.result);
        if (contents._tag === "Success") {
          const parsed = yield* Schema.decodeUnknownEffect(UnknownJson)(contents.success).pipe(Effect.result);
          if (parsed._tag === "Success") {
            manifest = parsed.success;
            manifestState = "available";
          } else manifestState = "invalid";
        } else manifestState = "unreadable";
      }
    } else if (read.failure.reason._tag !== "NotFound") manifestState = "unreadable";
    const primary = yield* pool.primary;
    const snapshot = yield* primary.snapshot;
    return makeSupportReport({
      appVersion: environment.appVersion, packaged: environment.isPackaged,
      platform: environment.platform, architecture: environment.processArch,
      osRelease: NodeOS.release(), versions: process.versions,
      generatedAt: DateTime.formatIso(yield* DateTime.now), manifestState, manifest,
      startupFailure: yield* Ref.get(startupFailure), quitting: yield* Ref.get(state.quitting),
      backend: {
        ready: snapshot.ready, desiredRunning: snapshot.desiredRunning,
        processRunning: Option.isSome(snapshot.activePid), restartAttempt: snapshot.restartAttempt,
        restartScheduled: snapshot.restartScheduled,
      },
    });
  });

  const exportReport = Effect.gen(function* () {
    const folder = yield* dialog.pickFolder({ owner: Option.none(), defaultPath: Option.none() }).pipe(Effect.result);
    if (folder._tag === "Failure") return { status: "failed", filePath: null, errorCategory: "picker-failed" } as const;
    if (Option.isNone(folder.success)) return { status: "cancelled", filePath: null, errorCategory: null } as const;
    const report = yield* collect;
    const id = yield* crypto.randomUUIDv4;
    const filePath = path.join(folder.success.value, `meerkat-t3-support-${id}.json`);
    const json = yield* Schema.encodeEffect(UnknownJson)(report);
    const saved = yield* fs.writeFileString(filePath, `${json}\n`, { flag: "wx", mode: 0o600 }).pipe(Effect.result);
    return saved._tag === "Success"
      ? { status: "saved", filePath, errorCategory: null } as const
      : { status: "failed", filePath: null, errorCategory: "save-failed" } as const;
  }).pipe(Effect.catchCause(() => Effect.succeed({ status: "failed", filePath: null, errorCategory: "report-unavailable" } as const)));

  const offerStartupReport = Effect.gen(function* () {
    const choice = yield* dialog.showMessageBox({
      type: "error", title: "Meerkat T3 could not start", message: "The local workspace could not start.",
      detail: "You can save a support report with app and runtime versions plus startup status. It excludes logs, conversations, credentials, paths, and screenshots. Your saved profile is unchanged.",
      buttons: ["Export support report", "Quit"], defaultId: 0, cancelId: 1,
    });
    if (choice.response === 0) {
      const result = yield* exportReport;
      if (result.status === "saved") yield* dialog.showMessageBox({
        type: "info", title: "Support report saved", message: "Send this file to your prototype distributor.",
        detail: result.filePath ?? "", buttons: ["Quit"],
      });
      else if (result.status === "failed") yield* dialog.showMessageBox({
        type: "error", title: "Report could not be saved", message: "The support report was not saved. Keep the app version and describe the startup failure to your prototype distributor.", buttons: ["Quit"],
      });
    }
  }).pipe(Effect.catchCause(() => Effect.void));

  return DesktopDiagnostics.of({ exportReport, recordStartupFailure: (stage) => Ref.set(startupFailure, stage), offerStartupReport });
});

export const layer = Layer.effect(DesktopDiagnostics, make);

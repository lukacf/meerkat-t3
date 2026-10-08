// @effect-diagnostics nodeBuiltinImport:off - Recorded packaging inputs use SHA-256 byte identities.
import * as NodeCrypto from "node:crypto";

import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const StringMap = Schema.Record(Schema.String, Schema.String);
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

export const DesktopProductionResolutionMetadata = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  platform: Schema.Literals(["mac", "linux", "win"]),
  arch: Schema.Literals(["arm64", "x64", "universal"]),
  packageManager: Schema.String,
  dependencies: StringMap,
  devDependencies: StringMap,
  workspaceSha256: Digest,
  patchSha256: Schema.Record(Schema.String, Digest),
  lockSha256: Digest,
});

const StagePackage = Schema.Struct({
  packageManager: Schema.String,
  dependencies: Schema.optional(StringMap),
  devDependencies: Schema.optional(StringMap),
  optionalDependencies: Schema.optional(StringMap),
});
const StageWorkspace = Schema.Struct({
  patchedDependencies: Schema.optional(StringMap),
});
const LockedDependency = Schema.Struct({ specifier: Schema.String, version: Schema.String });
const LockedDependencies = Schema.Record(Schema.String, LockedDependency);
const ProductionLock = Schema.Struct({
  lockfileVersion: Schema.Literal("9.0"),
  importers: Schema.Record(
    Schema.String,
    Schema.Struct({
      dependencies: Schema.optional(LockedDependencies),
      devDependencies: Schema.optional(LockedDependencies),
      optionalDependencies: Schema.optional(LockedDependencies),
    }),
  ),
  packages: Schema.Record(Schema.String, Schema.Unknown),
  snapshots: Schema.Record(Schema.String, Schema.Unknown),
});
const decodeResolutionMetadata = Schema.decodeEffect(
  Schema.fromJsonString(DesktopProductionResolutionMetadata),
);
const decodeStagePackage = Schema.decodeEffect(Schema.fromJsonString(StagePackage));
const decodeStageWorkspace = Schema.decodeEffect(fromYaml(StageWorkspace));
const decodeProductionLock = Schema.decodeEffect(fromYaml(ProductionLock));

export class DesktopProductionResolutionError extends Schema.TaggedError<DesktopProductionResolutionError>()(
  "DesktopProductionResolutionError",
  { resolutionDir: Schema.String, reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Frozen desktop production resolution at ${this.resolutionDir} is unusable: ${this.reason}. Regenerate and review the production resolution for these inputs before packaging; do not retry with an unlocked install.`;
  }
}

function digest(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function sameMap(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>) {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

export const prepareDesktopProductionResolution = Effect.fn("prepareDesktopProductionResolution")(
  function* (input: {
    readonly resolutionDir: string;
    readonly stageAppDir: string;
    readonly platform: "mac" | "linux" | "win";
    readonly arch: "arm64" | "x64" | "universal";
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const failure = (reason: string, cause?: unknown) =>
      new DesktopProductionResolutionError({
        resolutionDir: input.resolutionDir,
        reason,
        ...(cause === undefined ? {} : { cause }),
      });
    const read = (filePath: string) =>
      fs
        .readFile(filePath)
        .pipe(Effect.mapError((cause) => failure(`Cannot read required input ${filePath}`, cause)));

    const metadataBytes = yield* read(path.join(input.resolutionDir, "resolution.json"));
    const metadata = yield* decodeResolutionMetadata(new TextDecoder().decode(metadataBytes)).pipe(
      Effect.mapError((cause) => failure("Invalid resolution.json metadata", cause)),
    );
    if (metadata.platform !== input.platform || metadata.arch !== input.arch) {
      return yield* failure(`Resolution target does not match ${input.platform}/${input.arch}`);
    }

    const packageBytes = yield* read(path.join(input.stageAppDir, "package.json"));
    const stagePackage = yield* decodeStagePackage(new TextDecoder().decode(packageBytes)).pipe(
      Effect.mapError((cause) => failure("Invalid staged package.json", cause)),
    );
    if (
      stagePackage.packageManager !== metadata.packageManager ||
      !sameMap(stagePackage.dependencies ?? {}, metadata.dependencies) ||
      !sameMap(stagePackage.devDependencies ?? {}, metadata.devDependencies) ||
      Object.keys(stagePackage.optionalDependencies ?? {}).length > 0
    ) {
      return yield* failure("Staged package manager or dependency inputs changed");
    }

    const workspaceBytes = yield* read(path.join(input.stageAppDir, "pnpm-workspace.yaml"));
    if (digest(workspaceBytes) !== metadata.workspaceSha256) {
      return yield* failure("Staged pnpm-workspace.yaml bytes changed");
    }
    const workspace = yield* decodeStageWorkspace(new TextDecoder().decode(workspaceBytes)).pipe(
      Effect.mapError((cause) => failure("Invalid staged pnpm-workspace.yaml", cause)),
    );
    const selectedPatches = [...new Set(Object.values(workspace.patchedDependencies ?? {}))].sort();
    if (
      selectedPatches.length !== Object.keys(metadata.patchSha256).length ||
      selectedPatches.some((selected) => metadata.patchSha256[selected] === undefined)
    ) {
      return yield* failure("Selected patch paths do not match the recorded resolution");
    }
    for (const selected of selectedPatches) {
      if (
        !selected.startsWith("patches/") ||
        selected.includes("\\") ||
        selected.includes("\0") ||
        selected.split("/").some((part) => part === "" || part === "." || part === "..")
      ) {
        return yield* failure(
          "Selected patch path must remain inside the staged patches directory",
        );
      }
      const patchBytes = yield* read(path.join(input.stageAppDir, selected));
      if (digest(patchBytes) !== metadata.patchSha256[selected]) {
        return yield* failure(`Selected patch bytes changed: ${selected}`);
      }
    }

    // Keep the validated bytes in memory: a later source-file change must not
    // replace the lock between its validation and the staged write.
    const lockBytes = yield* read(path.join(input.resolutionDir, "pnpm-lock.yaml"));
    if (digest(lockBytes) !== metadata.lockSha256) {
      return yield* failure("Recorded pnpm-lock.yaml bytes changed");
    }
    const lock = yield* decodeProductionLock(new TextDecoder().decode(lockBytes)).pipe(
      Effect.mapError((cause) =>
        failure("Expected a full production lock with lockfileVersion 9.0", cause),
      ),
    );
    const importer = lock.importers["."];
    if (Object.keys(lock.importers).length !== 1 || importer === undefined) {
      return yield* failure(
        "Production lock must contain only the root importer; workspace locks cannot be reused",
      );
    }
    for (const section of ["dependencies", "devDependencies"] as const) {
      const dependencies = importer[section] ?? {};
      const specifiers = Object.fromEntries(
        Object.entries(dependencies).map(([name, dependency]) => [name, dependency.specifier]),
      );
      if (
        !sameMap(specifiers, metadata[section]) ||
        Object.values(dependencies).some(
          (dependency) =>
            dependency.version.length === 0 ||
            /^(?:workspace|link):/u.test(dependency.version) ||
            /^(?:workspace|link):/u.test(dependency.specifier),
        )
      ) {
        return yield* failure(
          `Production lock ${section} do not match; a pruned or stale lock cannot be reused`,
        );
      }
    }
    if (Object.keys(importer.optionalDependencies ?? {}).length > 0) {
      return yield* failure("Production lock contains unexpected optional dependency inputs");
    }

    yield* fs
      .writeFile(path.join(input.stageAppDir, "pnpm-lock.yaml"), lockBytes)
      .pipe(
        Effect.mapError((cause) =>
          failure("Cannot write the validated lock into the production stage", cause),
        ),
      );
    return ["install", "--prod", "--frozen-lockfile"] as const;
  },
);

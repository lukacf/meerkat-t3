// Configuration preflight runs before workspace installation.
import { resolveMeerkatReleaseRepository } from "../../packages/shared/src/meerkatDistribution.ts";

export const MAC_SIGNING_INPUTS = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
] as const;

export class MacSigningInputsError extends Error {
  readonly _tag = "MacSigningInputsError";
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `Signed Mac packaging requires: ${missing.join(", ")}. Select unsigned mode explicitly to package without Apple credentials.`,
    );
    this.name = "MacSigningInputsError";
    this.missing = missing;
  }
}

export class MacSigningContextError extends Error {
  readonly _tag = "MacSigningContextError";

  constructor() {
    super(
      "Signed Mac packaging is not supported in a pull-request build. Use a reviewed release revision.",
    );
    this.name = "MacSigningContextError";
  }
}

export function requireMacSigningInputs(env: Readonly<Record<string, string | undefined>>): void {
  // electron-builder otherwise skips signing before enforcing forceCodeSigning.
  const pullRequestInputs = [
    "TRAVIS_PULL_REQUEST",
    "CIRCLE_PULL_REQUEST",
    "BITRISE_PULL_REQUEST",
    "APPVEYOR_PULL_REQUEST_NUMBER",
    "GITHUB_BASE_REF",
  ];
  if (pullRequestInputs.some((name) => env[name] && env[name] !== "false")) {
    throw new MacSigningContextError();
  }
  const missing = MAC_SIGNING_INPUTS.filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new MacSigningInputsError(missing);
}

export interface MeerkatMacReleasePlan {
  readonly mode: "signed" | "unsigned" | "internal-unsigned";
  readonly repository: string | undefined;
  readonly environment: string | undefined;
  readonly version: string;
  readonly enableUpdates: boolean;
  readonly artifactPurpose: "release" | "internal-validation";
  readonly args: readonly string[];
}

export function resolveMeerkatMacReleasePlan(
  env: Readonly<Record<string, string | undefined>>,
): MeerkatMacReleasePlan {
  const mode = env.MEERKAT_MAC_RELEASE_MODE;
  if (mode !== "signed" && mode !== "unsigned" && mode !== "internal-unsigned") {
    throw new Error(
      "MEERKAT_MAC_RELEASE_MODE must explicitly be signed, unsigned or internal-unsigned.",
    );
  }
  const repositoryInput = env.MEERKAT_MAC_RELEASE_REPOSITORY || undefined;
  const repository = resolveMeerkatReleaseRepository(repositoryInput);
  if ((repositoryInput || env.GITHUB_REPOSITORY) && !repository) {
    throw new Error(
      "MEERKAT_MAC_RELEASE_REPOSITORY must name the selected non-donor owner/repository.",
    );
  }
  const repositoryName = repository ? `${repository.owner}/${repository.repo}` : undefined;
  if (
    env.GITHUB_REPOSITORY &&
    env.GITHUB_REPOSITORY.toLowerCase() !== repositoryName?.toLowerCase()
  ) {
    throw new Error(
      "The selected release repository must match GITHUB_REPOSITORY for this workflow.",
    );
  }
  const environmentInput = env.MEERKAT_MAC_RELEASE_ENVIRONMENT || undefined;
  const environment = environmentInput?.trim();
  if (
    (env.GITHUB_REPOSITORY && !environment) ||
    (environmentInput &&
      (!environment ||
        environment !== environmentInput ||
        environment.length > 255 ||
        [...environment].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )))
  ) {
    throw new Error("MEERKAT_MAC_RELEASE_ENVIRONMENT must name the selected GitHub environment.");
  }
  const version = env.MEERKAT_MAC_RELEASE_VERSION?.trim();
  if (
    !version ||
    version !== env.MEERKAT_MAC_RELEASE_VERSION ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(version)
  ) {
    throw new Error(
      "MEERKAT_MAC_RELEASE_VERSION must be an explicit desktop version, such as 0.1.0 or 0.1.0-nightly.20261006.1.",
    );
  }
  const updateValue = env.MEERKAT_MAC_RELEASE_ENABLE_UPDATES ?? "false";
  if (updateValue !== "true" && updateValue !== "false") {
    throw new Error("MEERKAT_MAC_RELEASE_ENABLE_UPDATES must be true or false.");
  }
  const enableUpdates = updateValue === "true";
  if (enableUpdates && mode !== "signed") {
    throw new Error("Unsigned Mac packages cannot enable an updater feed. Use manual updates.");
  }
  if (enableUpdates && !repositoryName) {
    throw new Error("Updates require an explicit MEERKAT_MAC_RELEASE_REPOSITORY.");
  }
  if (enableUpdates && !/^\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?$/u.test(version)) {
    throw new Error("Updates require a stable version or the supported nightly version format.");
  }
  const artifactPurpose = mode === "internal-unsigned" ? "internal-validation" : "release";
  return {
    mode,
    repository: repositoryName,
    environment,
    version,
    enableUpdates,
    artifactPurpose,
    args: [
      "scripts/build-desktop-artifact.ts",
      "--platform",
      "mac",
      "--target",
      "dmg",
      "--arch",
      "arm64",
      "--build-version",
      version,
      "--artifact-purpose",
      artifactPurpose,
      "--output-dir",
      mode === "internal-unsigned" ? "release-internal" : "release-mac",
      ...(mode === "signed" ? ["--signed"] : []),
    ],
  };
}

export function createMeerkatMacReleaseEnvironment(
  plan: MeerkatMacReleasePlan,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  if (plan.mode === "signed") requireMacSigningInputs(env);
  const result: Record<string, string | undefined> = {
    ...env,
    T3CODE_DESKTOP_SIGNED: String(plan.mode === "signed"),
    T3CODE_DESKTOP_MOCK_UPDATES: "false",
    T3CODE_DESKTOP_SKIP_BUILD: "false",
    T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "true",
    CSC_IDENTITY_AUTO_DISCOVERY: String(plan.mode === "signed"),
  };
  // The lane uses the API-key notarization contract, without ambient alternate auth.
  for (const key of [
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_KEYCHAIN",
    "APPLE_KEYCHAIN_PROFILE",
  ]) {
    delete result[key];
  }
  if (plan.mode !== "signed") {
    for (const key of [...MAC_SIGNING_INPUTS, "CSC_NAME", "CSC_KEYCHAIN"]) delete result[key];
  }
  if (plan.enableUpdates) {
    result.MEERKAT_DESKTOP_UPDATE_REPOSITORY = plan.repository;
    result.VITE_MEERKAT_RELEASE_REPOSITORY = plan.repository;
  } else {
    delete result.MEERKAT_DESKTOP_UPDATE_REPOSITORY;
    delete result.VITE_MEERKAT_RELEASE_REPOSITORY;
  }
  return result;
}

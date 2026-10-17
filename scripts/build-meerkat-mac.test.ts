// @effect-diagnostics nodeBuiltinImport:off - Synthetic release inputs never invoke a packager.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { buildMeerkatMac } from "./build-meerkat-mac.ts";
import {
  MAC_SIGNING_INPUTS,
  MacSigningContextError,
  MacSigningInputsError,
  createMeerkatMacReleaseEnvironment,
  requireMacSigningInputs,
  resolveMeerkatMacReleasePlan,
} from "./lib/meerkat-mac-release.ts";

const configuration = {
  MEERKAT_MAC_RELEASE_MODE: "internal-unsigned",
  MEERKAT_MAC_RELEASE_REPOSITORY: "example/meerkat-desktop",
  MEERKAT_MAC_RELEASE_ENVIRONMENT: "mac-release",
  MEERKAT_MAC_RELEASE_VERSION: "0.1.0",
  GITHUB_REPOSITORY: "example/meerkat-desktop",
};
const signingInputs = Object.fromEntries(
  MAC_SIGNING_INPUTS.map((key) => [key, "synthetic-test-input"]),
);

describe("explicit Meerkat Mac release configuration", () => {
  it("does not infer a mode or destination from ambient GitHub configuration", () => {
    expect(() =>
      resolveMeerkatMacReleasePlan({ GITHUB_REPOSITORY: configuration.GITHUB_REPOSITORY }),
    ).toThrow("MODE");
    expect(() =>
      resolveMeerkatMacReleasePlan({ ...configuration, MEERKAT_MAC_RELEASE_REPOSITORY: undefined }),
    ).toThrow("REPOSITORY");
    expect(() =>
      resolveMeerkatMacReleasePlan({
        ...configuration,
        MEERKAT_MAC_RELEASE_ENVIRONMENT: undefined,
      }),
    ).toThrow("ENVIRONMENT");
  });

  it.each([
    "pingdotgg/t3code",
    "PingDotGG/T3Code",
    "https://github.com/example/meerkat-desktop",
    "example/meerkat-desktop.git",
    "other/repository",
  ])("refuses a donor, alias or different workflow repository: %s", (repository) => {
    expect(() =>
      resolveMeerkatMacReleasePlan({
        ...configuration,
        MEERKAT_MAC_RELEASE_REPOSITORY: repository,
      }),
    ).toThrow();
  });

  it("requires an explicit valid mode, version and update choice", () => {
    for (const override of [
      { MEERKAT_MAC_RELEASE_MODE: "auto" },
      { MEERKAT_MAC_RELEASE_VERSION: "latest" },
      { MEERKAT_MAC_RELEASE_VERSION: "" },
      { MEERKAT_MAC_RELEASE_ENABLE_UPDATES: "yes" },
      { MEERKAT_MAC_RELEASE_ENABLE_UPDATES: "true" },
    ])
      expect(() => resolveMeerkatMacReleasePlan({ ...configuration, ...override })).toThrow();
  });

  it.each(["unsigned", "signed", "internal-unsigned"])(
    "permits local %s packaging without a repository or CI environment when updates are off",
    (mode) => {
      const plan = resolveMeerkatMacReleasePlan({
        MEERKAT_MAC_RELEASE_MODE: mode,
        MEERKAT_MAC_RELEASE_VERSION: "0.1.0",
      });
      expect(plan.repository).toBeUndefined();
      expect(plan.environment).toBeUndefined();
      expect(plan.enableUpdates).toBe(false);
      expect(plan.artifactPurpose).toBe(
        mode === "internal-unsigned" ? "internal-validation" : "release",
      );
      expect(plan.args.includes("--signed")).toBe(mode === "signed");
      expect(plan.outputDirectory).toBe(
        mode === "internal-unsigned" ? "release-internal" : "release-mac",
      );
    },
  );

  it.each(["", " /tmp/candidate", "/tmp/candidate ", "/tmp/candidate\nother", "--signed"])(
    "refuses an ambiguous output directory: %j",
    (outputDirectory) => {
      expect(() =>
        resolveMeerkatMacReleasePlan({
          ...configuration,
          MEERKAT_MAC_RELEASE_OUTPUT_DIR: outputDirectory,
        }),
      ).toThrow("OUTPUT_DIR");
    },
  );

  it.each(["unsigned", "internal-unsigned"])(
    "refuses updater opt-in for %s even with a repository and signing credentials",
    (mode) => {
      expect(() =>
        resolveMeerkatMacReleasePlan({
          ...configuration,
          ...signingInputs,
          MEERKAT_MAC_RELEASE_MODE: mode,
          MEERKAT_MAC_RELEASE_ENABLE_UPDATES: "true",
        }),
      ).toThrow("Use manual updates");
    },
  );

  it("requires an explicit repository only when local signed packaging opts in to updates", () => {
    const env = {
      MEERKAT_MAC_RELEASE_MODE: "signed",
      MEERKAT_MAC_RELEASE_VERSION: "0.1.0",
      MEERKAT_MAC_RELEASE_ENABLE_UPDATES: "true",
    };
    expect(() => resolveMeerkatMacReleasePlan(env)).toThrow("REPOSITORY");
    expect(
      resolveMeerkatMacReleasePlan({
        ...env,
        MEERKAT_MAC_RELEASE_REPOSITORY: "example/meerkat-desktop",
      }).enableUpdates,
    ).toBe(true);
  });

  it.each(["MEERKAT_MAC_RELEASE_ENVIRONMENT", "MEERKAT_MAC_RELEASE_VERSION"])(
    "refuses edge whitespace in %s so the workflow uses the exact validated value",
    (key) => {
      const value = configuration[key as keyof typeof configuration];
      for (const padded of [` ${value}`, `${value} `]) {
        expect(() => resolveMeerkatMacReleasePlan({ ...configuration, [key]: padded })).toThrow();
      }
    },
  );

  it("enables update metadata only for stable or supported nightly releases", () => {
    const env = {
      ...configuration,
      MEERKAT_MAC_RELEASE_MODE: "signed",
      MEERKAT_MAC_RELEASE_ENABLE_UPDATES: "true",
    };
    for (const version of ["1.0.0-pr.42.1", "1.0.0-preview.20261006.1", "1.0.0-beta.1"]) {
      expect(() =>
        resolveMeerkatMacReleasePlan({ ...env, MEERKAT_MAC_RELEASE_VERSION: version }),
      ).toThrow("Updates require a stable version");
    }
    expect(resolveMeerkatMacReleasePlan(env).enableUpdates).toBe(true);
    expect(
      resolveMeerkatMacReleasePlan({
        ...env,
        MEERKAT_MAC_RELEASE_VERSION: "1.0.0-nightly.20261006.1",
      }).enableUpdates,
    ).toBe(true);
  });

  it.each(MAC_SIGNING_INPUTS)("refuses missing %s without revealing other values", (missing) => {
    const env = { ...signingInputs, [missing]: "   " };
    expect(() => requireMacSigningInputs(env)).toThrow(MacSigningInputsError);
    try {
      requireMacSigningInputs(env);
    } catch (error) {
      expect(error).toBeInstanceOf(MacSigningInputsError);
      expect((error as MacSigningInputsError).missing).toEqual([missing]);
      expect((error as Error).message).not.toContain("synthetic-test-input");
    }
  });

  it.each([
    "TRAVIS_PULL_REQUEST",
    "CIRCLE_PULL_REQUEST",
    "BITRISE_PULL_REQUEST",
    "APPVEYOR_PULL_REQUEST_NUMBER",
    "GITHUB_BASE_REF",
  ])("refuses signed pull-request contexts detected by %s", (name) => {
    expect(() =>
      requireMacSigningInputs({
        ...signingInputs,
        [name]: "review-branch",
        CSC_FOR_PULL_REQUEST: "true",
      }),
    ).toThrow(MacSigningContextError);
    expect(() => requireMacSigningInputs({ ...signingInputs, [name]: "false" })).not.toThrow();
    expect(() => requireMacSigningInputs({ ...signingInputs, [name]: "" })).not.toThrow();
  });

  it.each(["unsigned", "internal-unsigned"])(
    "keeps %s explicit despite ambient signing and updater inputs",
    (mode) => {
      const source: Record<string, string> = {
        ...configuration,
        MEERKAT_MAC_RELEASE_MODE: mode,
        ...signingInputs,
        T3CODE_DESKTOP_SIGNED: "true",
        T3CODE_DESKTOP_SKIP_BUILD: "true",
        T3CODE_DESKTOP_MOCK_UPDATES: "true",
        MEERKAT_DESKTOP_UPDATE_REPOSITORY: "other/repo",
        VITE_MEERKAT_RELEASE_REPOSITORY: "other/repo",
        APPLE_ID: "synthetic-alternate-account",
        APPLE_APP_SPECIFIC_PASSWORD: "synthetic-alternate-password",
        APPLE_KEYCHAIN_PROFILE: "synthetic-profile",
      };
      const plan = resolveMeerkatMacReleasePlan(source);
      const child = createMeerkatMacReleaseEnvironment(plan, source);
      expect(plan.artifactPurpose).toBe(mode === "unsigned" ? "release" : "internal-validation");
      expect(child.T3CODE_DESKTOP_SIGNED).toBe("false");
      expect(child.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
      expect(child.T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR).toBe("true");
      expect(child.T3CODE_DESKTOP_SKIP_BUILD).toBe("false");
      expect(child.T3CODE_DESKTOP_MOCK_UPDATES).toBe("false");
      for (const key of [
        ...MAC_SIGNING_INPUTS,
        "APPLE_ID",
        "APPLE_APP_SPECIFIC_PASSWORD",
        "APPLE_KEYCHAIN_PROFILE",
        "MEERKAT_DESKTOP_UPDATE_REPOSITORY",
        "VITE_MEERKAT_RELEASE_REPOSITORY",
      ])
        expect(child[key]).toBeUndefined();
      expect(source.CSC_LINK).toBe("synthetic-test-input");
    },
  );

  it("selects the explicit owned feed only on request and removes alternate notarization auth", () => {
    const source = {
      ...configuration,
      ...signingInputs,
      MEERKAT_MAC_RELEASE_MODE: "signed",
      MEERKAT_MAC_RELEASE_ENABLE_UPDATES: "true",
      APPLE_ID: "synthetic-alternate-account",
      APPLE_KEYCHAIN_PROFILE: "synthetic-profile",
    };
    const plan = resolveMeerkatMacReleasePlan(source);
    const child = createMeerkatMacReleaseEnvironment(plan, source);
    expect(plan.artifactPurpose).toBe("release");
    expect(child.MEERKAT_DESKTOP_UPDATE_REPOSITORY).toBe(configuration.GITHUB_REPOSITORY);
    expect(child.VITE_MEERKAT_RELEASE_REPOSITORY).toBe(configuration.GITHUB_REPOSITORY);
    expect(child.APPLE_API_KEY_ID).toBe("synthetic-test-input");
    expect(child.APPLE_ID).toBeUndefined();
    expect(child.APPLE_KEYCHAIN_PROFILE).toBeUndefined();
  });
});

describe("Mac build invocation boundary", () => {
  it("passes an explicit candidate directory as one argument without changing release policy", async () => {
    const outputDirectory = "/tmp/MeerkaT3 candidate/0.1.0-preview.1";
    const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const result = await buildMeerkatMac({
      env: {
        MEERKAT_MAC_RELEASE_MODE: "unsigned",
        MEERKAT_MAC_RELEASE_VERSION: "0.1.0-preview.1",
        MEERKAT_MAC_RELEASE_OUTPUT_DIR: outputDirectory,
        MEERKAT_DESKTOP_UPDATE_REPOSITORY: "unselected/repository",
      },
      platform: "darwin",
      arch: "arm64",
      run: async (args, env) => {
        calls.push({ args, env });
        return 0;
      },
    });
    expect(result.plan.outputDirectory).toBe(outputDirectory);
    expect(result.plan.artifactPurpose).toBe("release");
    expect(result.plan.enableUpdates).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(-2)).toEqual(["--output-dir", outputDirectory]);
    expect(calls[0]!.env.T3CODE_DESKTOP_SIGNED).toBe("false");
    expect(calls[0]!.env.MEERKAT_DESKTOP_UPDATE_REPOSITORY).toBeUndefined();
  });

  it("invokes one local unsigned release build without consulting an ambient Apple key path", async () => {
    const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const result = await buildMeerkatMac({
      env: {
        MEERKAT_MAC_RELEASE_MODE: "unsigned",
        MEERKAT_MAC_RELEASE_VERSION: "0.1.0",
        ...signingInputs,
        APPLE_API_KEY: "/nonexistent/unused-unsigned-key.p8",
        T3CODE_DESKTOP_SIGNED: "true",
        MEERKAT_DESKTOP_UPDATE_REPOSITORY: "unselected/repository",
      },
      platform: "darwin",
      arch: "arm64",
      run: async (args, env) => {
        calls.push({ args, env });
        return 0;
      },
    });
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.args.slice(call.args.indexOf("--artifact-purpose"), -2)).toEqual([
      "--artifact-purpose",
      "release",
    ]);
    expect(call.args.slice(-2)).toEqual(["--output-dir", "release-mac"]);
    expect(call.args).not.toContain("--signed");
    expect(call.env.T3CODE_DESKTOP_SIGNED).toBe("false");
    expect(call.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
    expect(call.env.APPLE_API_KEY).toBeUndefined();
    expect(call.env.MEERKAT_DESKTOP_UPDATE_REPOSITORY).toBeUndefined();
  });

  it("never starts a signed packaging process in a pull-request context", async () => {
    let calls = 0;
    await expect(
      buildMeerkatMac({
        env: {
          ...configuration,
          ...signingInputs,
          MEERKAT_MAC_RELEASE_MODE: "signed",
          GITHUB_BASE_REF: "main",
        },
        run: async () => {
          calls++;
          return 0;
        },
      }),
    ).rejects.toThrow(MacSigningContextError);
    expect(calls).toBe(0);
  });

  it("never starts a packaging process when signed inputs are missing", async () => {
    let calls = 0;
    await expect(
      buildMeerkatMac({
        env: { ...configuration, MEERKAT_MAC_RELEASE_MODE: "signed" },
        run: async () => {
          calls++;
          return 0;
        },
      }),
    ).rejects.toThrow(MacSigningInputsError);
    expect(calls).toBe(0);
  });

  it("refuses a missing API key file before packaging", async () => {
    let calls = 0;
    await expect(
      buildMeerkatMac({
        env: {
          ...configuration,
          ...signingInputs,
          MEERKAT_MAC_RELEASE_MODE: "signed",
          APPLE_API_KEY: "/nonexistent/meerkat-release-test-key.p8",
        },
        run: async () => {
          calls++;
          return 0;
        },
      }),
    ).rejects.toThrow("APPLE_API_KEY");
    expect(calls).toBe(0);
  });

  it("checks synthetic signed configuration without running signing or packaging", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "meerkat-mac-release-config-"),
    );
    try {
      const file = NodePath.join(root, "synthetic.p8");
      await NodeFSP.writeFile(file, "synthetic configuration fixture, not a key\n");
      let calls = 0;
      const result = await buildMeerkatMac({
        env: {
          ...configuration,
          ...signingInputs,
          MEERKAT_MAC_RELEASE_MODE: "signed",
          APPLE_API_KEY: file,
        },
        checkOnly: true,
        run: async () => {
          calls++;
          return 0;
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.plan.mode).toBe("signed");
      expect(calls).toBe(0);
      const failed = await buildMeerkatMac({
        env: {
          MEERKAT_MAC_RELEASE_MODE: "signed",
          MEERKAT_MAC_RELEASE_VERSION: "0.1.0",
          ...signingInputs,
          APPLE_API_KEY: file,
        },
        platform: "darwin",
        arch: "arm64",
        run: async (args) => {
          calls++;
          expect(args).toContain("--signed");
          return 19;
        },
      });
      expect(failed.exitCode).toBe(19);
      expect(calls).toBe(1);
      await NodeFSP.unlink(file);
      await NodeFSP.symlink(root, file);
      await expect(
        buildMeerkatMac({
          env: {
            ...configuration,
            ...signingInputs,
            MEERKAT_MAC_RELEASE_MODE: "signed",
            APPLE_API_KEY: file,
          },
          checkOnly: true,
        }),
      ).rejects.toThrow("regular .p8 file");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses the wrong host and preserves packaging failure without unsigned retry", async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      return 19;
    };
    await expect(
      buildMeerkatMac({ env: configuration, platform: "linux", arch: "arm64", run }),
    ).rejects.toThrow("Apple Silicon");
    expect(calls).toBe(0);
    const result = await buildMeerkatMac({
      env: configuration,
      platform: "darwin",
      arch: "arm64",
      run,
    });
    expect(result.exitCode).toBe(19);
    expect(calls).toBe(1);
  });
});

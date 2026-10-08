import type { SourceControlDiscoveryResult } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { expect, it } from "vite-plus/test";
import { buildAddProjectRemoteSourceReadiness, gitCloneSetupHint } from "./cloneSourceReadiness";

function discovery(
  git: "available" | "missing",
  github: "authenticated" | "unauthenticated",
): SourceControlDiscoveryResult {
  const common = { version: Option.none(), detail: Option.none() };
  return {
    versionControlSystems: [
      {
        ...common,
        kind: "git",
        label: "Git",
        implemented: true,
        status: git,
        installHint: "Install Git with your system package manager.",
      },
    ],
    sourceControlProviders: [
      {
        ...common,
        kind: "github",
        label: "GitHub",
        status: "available",
        installHint: "Install gh.",
        auth: {
          status: github,
          account: Option.none(),
          host: Option.none(),
          detail: Option.none(),
        },
      },
    ],
  };
}

it("blocks every clone source when Git is missing even with authenticated GitHub", () => {
  const result = buildAddProjectRemoteSourceReadiness(discovery("missing", "authenticated"));
  expect(Object.values(result).every((source) => !source.ready)).toBe(true);
  expect(result.url.hint).toContain("selected server");
  expect(result.github.hint).toContain("Install Git with your system package manager.");
  expect(gitCloneSetupHint(discovery("missing", "authenticated"))).toContain("rescan");
});

it("restores clone admission after a Git rescan without making URL cloning depend on GitHub login", () => {
  const signedOut = buildAddProjectRemoteSourceReadiness(discovery("available", "unauthenticated"));
  expect(signedOut.url.ready).toBe(true);
  expect(signedOut.github.ready).toBe(false);
  expect(
    buildAddProjectRemoteSourceReadiness(discovery("available", "authenticated")).github.ready,
  ).toBe(true);
  expect(gitCloneSetupHint(discovery("available", "authenticated"))).toBeNull();
});

it("preserves URL cloning for older servers that do not report discovery", () => {
  expect(buildAddProjectRemoteSourceReadiness(null).url.ready).toBe(true);
  expect(buildAddProjectRemoteSourceReadiness(null).github.ready).toBe(false);
});

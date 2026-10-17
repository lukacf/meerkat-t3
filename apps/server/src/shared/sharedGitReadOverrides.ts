import { SharedCheckoutRevisionError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { VcsProcess } from "../vcs/VcsProcess.ts";
import { sharedGitEnvironment } from "./sharedGitEnvironment.ts";

/** Read operations must never invoke repository-configured commands. */
export const sharedGitReadOverrides = Effect.fn("SharedCheckoutRevision.filters")(function* (
  cwd: string,
) {
  const vcs = yield* VcsProcess;
  const fail = (_code: string, message: string) =>
    new SharedCheckoutRevisionError({ code: "unavailable", message });
  const complete = (value: { stdoutTruncated: boolean; stdoutInvalidUtf8?: boolean }) =>
    !value.stdoutTruncated && !value.stdoutInvalidUtf8;
  const overrides = [
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "diff.external=",
    "-c",
    "color.ui=false",
  ];
  const run = (args: ReadonlyArray<string>, maxOutputBytes: number) =>
    vcs
      .run({
        operation: "SharedCheckoutRevision.filters",
        command: "git",
        args: [...overrides, ...args],
        cwd,
        env: sharedGitEnvironment(),
        timeoutMs: 8_000,
        maxOutputBytes,
        outputMode: "truncate",
        appendTruncationMarker: false,
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.mapError(() =>
          fail("unavailable", "Could not verify repository filter configuration."),
        ),
      );
  // Git status/diff may run clean filters even with --no-textconv. Disable every
  // configured driver before inspecting content, and reject filtered changed files.
  const filters = yield* run(
    [
      "config",
      "--null",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process|required)$",
    ],
    32_768,
  );
  if (!complete(filters) || (filters.exitCode !== 0 && filters.exitCode !== 1))
    return yield* fail(
      "unavailable",
      "Could not verify repository filter configuration. No patch was captured.",
    );
  const drivers = new Set<string>();
  for (const key of filters.stdout.split("\0").filter(Boolean)) {
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/.exec(key);
    if (!match || /[\r\n\0]/.test(key) || (!drivers.has(match[1]!) && drivers.size >= 128))
      return yield* fail(
        "unavailable",
        "Repository filter configuration cannot be captured safely.",
      );
    drivers.add(match[1]!);
  }
  for (const driver of drivers)
    for (const [setting, value] of [
      ["clean", ""],
      ["smudge", ""],
      ["process", ""],
      ["required", "false"],
    ])
      overrides.push("-c", `filter.${driver}.${setting}=${value}`);

  return overrides;
});

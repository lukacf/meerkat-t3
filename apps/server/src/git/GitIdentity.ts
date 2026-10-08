import * as Effect from "effect/Effect";
import {
  type GitIdentityInput,
  type GitIdentityUpdateInput,
  type GitIdentityResult,
  VcsRepositoryDetectionError,
} from "@t3tools/contracts";
import { VcsProcess } from "../vcs/VcsProcess.ts";

/** Reads Git's actual author resolution; writes only the explicitly selected repository. */
export const makeGitIdentity = Effect.gen(function* () {
  const process = yield* VcsProcess;
  const run = (cwd: string, args: readonly string[], allowNonZeroExit = false) =>
    process.run({
      operation: "GitIdentity",
      command: "git",
      args,
      cwd,
      allowNonZeroExit,
      maxOutputBytes: 16_384,
    });
  const read = Effect.fn("GitIdentity.read")(function* (input: GitIdentityInput) {
    const root = yield* run(input.cwd, ["rev-parse", "--show-toplevel"], true);
    const repositoryRoot = root.exitCode === 0 ? root.stdout.trim() : null;
    const get = Effect.fnUntraced(function* (key: string, scope?: "local" | "global") {
      if (scope === "local" && repositoryRoot === null) return null;
      const result = yield* run(
        input.cwd,
        ["config", ...(scope ? [`--${scope}`] : []), "--get", key],
        true,
      );
      return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : null;
    });
    const local = {
      name: yield* get("user.name", "local"),
      email: yield* get("user.email", "local"),
    };
    const global = {
      name: yield* get("user.name", "global"),
      email: yield* get("user.email", "global"),
    };
    const configured = { name: yield* get("user.name"), email: yield* get("user.email") };
    const author = yield* run(input.cwd, ["var", "GIT_AUTHOR_IDENT"], true);
    const match =
      author.exitCode === 0 ? /^(.*) <([^<>]+)> \d+ [+-]\d+$/.exec(author.stdout.trim()) : null;
    return {
      repositoryRoot,
      ready: match !== null && configured.name !== null && configured.email !== null,
      effective: match ? { name: match[1] ?? null, email: match[2] ?? null } : configured,
      local,
      global,
    } satisfies GitIdentityResult;
  });
  const update = Effect.fn("GitIdentity.update")(function* (input: GitIdentityUpdateInput) {
    const current = yield* read(input);
    if (!current.repositoryRoot)
      return yield* new VcsRepositoryDetectionError({
        operation: "GitIdentity.update",
        cwd: input.cwd,
        detail: "Initialize Git in this project before saving a repository author.",
      });
    yield* run(input.cwd, ["config", "--local", "--replace-all", "--", "user.name", input.name]);
    yield* run(input.cwd, ["config", "--local", "--replace-all", "--", "user.email", input.email]);
    return yield* read(input);
  });
  return { read, update };
});

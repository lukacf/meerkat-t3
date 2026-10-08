import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcess, type VcsProcessInput } from "../vcs/VcsProcess.ts";
import { makeGitIdentity } from "./GitIdentity.ts";

function fixture(
  options: {
    repository?: boolean;
    missingName?: boolean;
    overridden?: boolean;
    guessed?: boolean;
  } = {},
) {
  const calls: VcsProcessInput[] = [];
  const global: Record<string, string> = {
    "user.name": "Global Name",
    "user.email": "global@example.com",
  };
  const local: Record<string, string> = {};
  if (options.missingName || options.guessed) delete global["user.name"];
  if (options.guessed) delete global["user.email"];
  const layer = Layer.succeed(VcsProcess, {
    run: (input) =>
      Effect.sync(() => {
        calls.push(input);
        let stdout = "";
        let exitCode = 0;
        if (input.args[0] === "rev-parse") {
          stdout = "/workspace";
          if (options.repository === false) exitCode = 128;
        } else if (input.args[0] === "var") {
          const name = local["user.name"] ?? global["user.name"];
          if (options.guessed) stdout = "Local User <local@computer.local> 1791120000 +0000";
          else if (!name) exitCode = 128;
          else
            stdout = options.overridden
              ? "Environment Author <env@example.com> 1791120000 +0000"
              : `${name} <${local["user.email"] ?? global["user.email"]}> 1791120000 +0000`;
        } else if (input.args.includes("--replace-all")) {
          assert(input.args.includes("--local"));
          assert.strictEqual(input.args[3], "--");
          local[input.args[4]!] = input.args[5]!;
        } else {
          const key = input.args.at(-1)!;
          const value = input.args.includes("--local")
            ? local[key]
            : input.args.includes("--global")
              ? global[key]
              : (local[key] ?? global[key]);
          stdout = value ?? "";
          if (!value) exitCode = 1;
        }
        return {
          exitCode: ChildProcessSpawner.ExitCode(exitCode),
          stdout,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
  });
  return { calls, global, local, layer };
}

it.effect("reports global defaults and the effective Git author separately", () => {
  const { layer } = fixture({ overridden: true });
  return Effect.gen(function* () {
    const identity = yield* makeGitIdentity;
    const result = yield* identity.read({ cwd: "/workspace" });
    assert.strictEqual(result.ready, true);
    assert.deepStrictEqual(result.effective, {
      name: "Environment Author",
      email: "env@example.com",
    });
    assert.deepStrictEqual(result.global, { name: "Global Name", email: "global@example.com" });
    assert.deepStrictEqual(result.local, { name: null, email: null });
  }).pipe(Effect.provide(layer));
});

it.effect("writes only the chosen repository and returns Git's verified result", () => {
  const { calls, global, layer } = fixture();
  return Effect.gen(function* () {
    const identity = yield* makeGitIdentity;
    const result = yield* identity.update({
      cwd: "/workspace",
      name: "Project Author",
      email: "private@users.noreply.github.com",
    });
    assert.deepStrictEqual(result.local, {
      name: "Project Author",
      email: "private@users.noreply.github.com",
    });
    assert.deepStrictEqual(result.effective, result.local);
    assert.deepStrictEqual(global, {
      "user.name": "Global Name",
      "user.email": "global@example.com",
    });
    const writes = calls.filter((call) => call.args.includes("--replace-all"));
    assert.strictEqual(writes.length, 2);
    assert(
      writes.every(
        (call) =>
          call.cwd === "/workspace" &&
          call.args.includes("--local") &&
          !call.args.includes("--global"),
      ),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("refuses to save identity outside a Git repository", () => {
  const { calls, layer } = fixture({ repository: false });
  return Effect.gen(function* () {
    const identity = yield* makeGitIdentity;
    const error = yield* identity
      .update({ cwd: "/workspace", name: "Project Author", email: "author@example.com" })
      .pipe(Effect.flip);
    assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
    assert.strictEqual(calls.filter((call) => call.args.includes("--replace-all")).length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("does not claim readiness from a partial global identity", () => {
  const { layer } = fixture({ missingName: true });
  return Effect.gen(function* () {
    const identity = yield* makeGitIdentity;
    const result = yield* identity.read({ cwd: "/workspace" });
    assert.strictEqual(result.ready, false);
    assert.deepStrictEqual(result.effective, { name: null, email: "global@example.com" });
  }).pipe(Effect.provide(layer));
});

it.effect("shows but does not approve an automatically guessed Git identity", () => {
  const { layer } = fixture({ guessed: true });
  return Effect.gen(function* () {
    const identity = yield* makeGitIdentity;
    const result = yield* identity.read({ cwd: "/workspace" });
    assert.strictEqual(result.ready, false);
    assert.deepStrictEqual(result.effective, { name: "Local User", email: "local@computer.local" });
  }).pipe(Effect.provide(layer));
});

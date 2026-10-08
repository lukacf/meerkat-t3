// @effect-diagnostics nodeBuiltinImport:off - this opt-in test exercises real local PTYs and Git worktrees.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  ProjectId,
  type TerminalAttachStreamEvent,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "./Manager.ts";
import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import {
  makeProjectTerminalService,
  makeThreadTerminalLaunchResolver,
  projectTerminalOwnerKey,
} from "./ProjectTerminal.ts";

const testLayer = Layer.mergeAll(SqlitePersistenceMemory, ProcessRunner.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const gitEnv = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

const enabled = process.env.T3CODE_TEST_NATIVE_TERMINALS === "1";

describe.skipIf(!enabled)("native project and thread terminal scope", () => {
  it.live(
    "preserves live shells across a checkout transition and starts new shells in the current scope",
    () =>
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") return;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runner = yield* ProcessRunner.ProcessRunner;
        const sql = yield* SqlClient.SqlClient;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-terminal-scope-" });
        const project = path.join(base, "project with spaces");
        const worktreeA = path.join(base, "worktree-a");
        const worktreeB = path.join(base, "worktree-b");
        yield* fs.makeDirectory(project);
        const git = Effect.fn("fixture.git")(function* (cwd: string, args: string[]) {
          const result = yield* runner.run({ command: "git", args, cwd, env: gitEnv });
          expect(result.code, result.stderr).toBe(0);
          return result.stdout.trim();
        });
        yield* git(project, ["init", "-b", "main"]);
        yield* fs.writeFileString(path.join(project, "scope.txt"), "original\n");
        yield* git(project, ["add", "scope.txt"]);
        yield* git(project, [
          "-c",
          "user.name=T3 fixture",
          "-c",
          "user.email=fixture@localhost",
          "commit",
          "-m",
          "fixture",
        ]);
        yield* git(project, ["worktree", "add", "-b", "branch-a", worktreeA]);
        yield* git(project, ["worktree", "add", "-b", "branch-b", worktreeB]);
        const projectId = ProjectId.make("native-shell-project");
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Shell project',${project},'[]','now','now')`;
        for (const [threadId, cwd] of [
          ["thread-a", worktreeA],
          ["thread-b", worktreeB],
        ]) {
          yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,worktree_path,created_at,updated_at) VALUES (${threadId},${projectId},'Worker','{}',${cwd},'now','now')`;
          yield* sql`INSERT INTO provider_session_runtime (thread_id,provider_name,provider_instance_id,adapter_key,status,last_seen_at) VALUES (${threadId},'meerkat','meerkat','meerkat','ready','now')`;
        }
        const ptyAdapter = yield* NodePtyAdapter.make();
        const manager = yield* TerminalManager.makeWithOptions({
          ptyAdapter,
          logsDir: path.join(base, "terminal-logs"),
          shellResolver: () => "/bin/sh",
          env: {
            ...gitEnv,
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            TERM: "xterm-256color",
            LANG: "C",
            T3CODE_PROJECT_ROOT: "/stale-parent-project",
            T3CODE_WORKTREE_PATH: "/stale-parent-worktree",
          },
          processTable: Effect.succeed([]),
          processKillGraceMs: 100,
        });
        const resolve = yield* makeThreadTerminalLaunchResolver();
        const projectShell = yield* makeProjectTerminalService().pipe(
          Effect.provideService(TerminalManager.TerminalManager, manager),
        );
        const a = yield* resolve({
          threadId: "thread-a",
          terminalId: "same-shell",
          cwd: worktreeB,
        });
        const b = yield* resolve({ threadId: "thread-b", terminalId: "same-shell", cwd: project });
        const projectOwner = projectTerminalOwnerKey(projectId);
        const owners = [a.threadId, b.threadId, projectOwner];
        const outputs = new Map<string, string>();
        const done = new Map<string, Deferred.Deferred<string>>();
        for (const owner of owners) done.set(owner, yield* Deferred.make<string>());
        const unsubscribe = yield* manager.subscribe((event) =>
          Effect.gen(function* () {
            if (event.type !== "output") return;
            const output = (outputs.get(event.threadId) ?? "") + event.data.replaceAll("\r", "");
            outputs.set(event.threadId, output);
            const receipt = done.get(event.threadId);
            if (receipt && output.includes(`\nEND_${event.threadId}\n`)) {
              yield* Deferred.succeed(receipt, output);
            }
          }),
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        const firstA = yield* manager.open({ ...a, cols: 80, rows: 24 });
        const firstB = yield* manager.open({ ...b, cols: 80, rows: 24 });
        const detachProject = yield* projectShell.attach(
          { projectId, terminalId: "same-shell" },
          () => Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(detachProject));
        const command = (owner: string, content: string) =>
          `printf '%s\\n' '${content}' > scope.txt; printf '\\nBEGIN_%s\\n' '${owner}'; pwd -P; git branch --show-current; cat ${owner === projectOwner ? '"$T3CODE_PROJECT_ROOT/scope.txt"' : "scope.txt"}; printf 'END_%s\\n' '${owner}'\r`;
        const write = Effect.fn("fixture.writeThroughProductionResolver")(function* (input: {
          threadId: string;
          terminalId: string;
          data: string;
        }) {
          yield* manager.write(yield* resolve(input));
        });
        yield* write({ ...a, data: command(a.threadId, "only-a") });
        yield* write({ ...b, data: command(b.threadId, "only-b") });
        yield* projectShell.write({
          projectId,
          terminalId: "same-shell",
          data: command(projectOwner, "only-project"),
        });
        for (const [owner, cwd, branch, content] of [
          [a.threadId, worktreeA, "branch-a", "only-a"],
          [b.threadId, worktreeB, "branch-b", "only-b"],
          [projectOwner, project, "main", "only-project"],
        ] as const) {
          const output = yield* Deferred.await(done.get(owner)!).pipe(Effect.timeout("10 seconds"));
          const canonicalCwd = yield* fs.realPath(cwd);
          expect(output).toContain(
            `\nBEGIN_${owner}\n${canonicalCwd}\n${branch}\n${content}\nEND_${owner}\n`,
          );
          expect(yield* fs.readFileString(path.join(cwd, "scope.txt"))).toBe(`${content}\n`);
          expect(yield* git(cwd, ["diff", "--", "scope.txt"])).toContain(`+${content}`);
        }
        expect(firstA.pid).not.toBe(firstB.pid);
        const attached: TerminalAttachStreamEvent[] = [];
        const detachA = yield* manager.attachStream({ ...a, cols: 80, rows: 24 }, (event) =>
          Effect.sync(() => {
            attached.push(event);
          }),
        );
        yield* Effect.addFinalizer(() => Effect.sync(detachA));
        const reopened = attached.find((event) => event.type === "snapshot");
        expect(reopened?.type === "snapshot" && reopened.snapshot.pid).toBe(firstA.pid);
        expect(reopened?.type === "snapshot" && reopened.snapshot.history).toContain("only-a");
        const split = yield* manager.open({ ...a, terminalId: "split-shell", cols: 80, rows: 24 });
        expect(split.pid).not.toBe(firstA.pid);
        expect(split.cwd).toBe(a.cwd);

        const busyStarted = yield* Deferred.make<void>();
        const busyFinished = yield* Deferred.make<void>();
        const releasePath = path.join(base, "release-old-shell");
        let busyOutput = "";
        const detachBusy = yield* manager.subscribe((event) =>
          Effect.gen(function* () {
            if (
              event.type !== "output" ||
              event.threadId !== a.threadId ||
              event.terminalId !== a.terminalId
            )
              return;
            busyOutput += event.data.replaceAll("\r", "");
            if (busyOutput.includes("\nOLD_SHELL_BUSY\n"))
              yield* Deferred.succeed(busyStarted, undefined);
            if (busyOutput.includes("\nOLD_SHELL_FINISHED\n"))
              yield* Deferred.succeed(busyFinished, undefined);
          }),
        );
        yield* Effect.addFinalizer(() => Effect.sync(detachBusy));
        yield* write({
          ...a,
          data: `printf '\\nOLD_SHELL_BUSY\\n'; while [ ! -f '${releasePath}' ]; do sleep 0.05; done; printf '\\nOLD_SHELL_FINISHED\\n'\r`,
        });
        yield* Deferred.await(busyStarted).pipe(Effect.timeout("10 seconds"));

        yield* sql`UPDATE projection_threads SET worktree_path = NULL WHERE thread_id = ${a.threadId}`;
        const afterTransition = yield* resolve(a);
        expect(afterTransition.cwd).toBe(project);
        const transitionSnapshots: TerminalSessionSnapshot[] = [];
        const detachTransition = yield* manager.attachStream(afterTransition, (event) =>
          Effect.sync(() => {
            if (event.type === "snapshot") transitionSnapshots.push(event.snapshot);
          }),
        );
        yield* Effect.addFinalizer(() => Effect.sync(detachTransition));
        expect(transitionSnapshots[0]).toMatchObject({
          pid: firstA.pid,
          cwd: worktreeA,
          status: "running",
        });
        expect(transitionSnapshots[0]?.history).toContain("OLD_SHELL_BUSY");
        expect(transitionSnapshots[0]?.history).toContain("only-a");
        expect((yield* manager.open(afterTransition).pipe(Effect.flip))._tag).toBe(
          "TerminalWorkspaceChangedError",
        );
        expect(
          (yield* write({ ...a, data: "printf 'wrong checkout' > forbidden.txt\r" }).pipe(
            Effect.flip,
          ))._tag,
        ).toBe("TerminalWorkspaceChangedError");
        // Releasing the running job proves that attaching/reopening did not kill its process.
        yield* fs.writeFileString(releasePath, "release\n");
        yield* Deferred.await(busyFinished).pipe(Effect.timeout("10 seconds"));
        expect(yield* fs.exists(path.join(worktreeA, "forbidden.txt"))).toBe(false);
        expect(yield* fs.exists(path.join(project, "forbidden.txt"))).toBe(false);

        const freshTarget = yield* resolve({ ...a, terminalId: "current-checkout" });
        const fresh = yield* manager.open({ ...freshTarget, cols: 80, rows: 24 });
        expect(fresh.pid).not.toBe(firstA.pid);
        expect(fresh.cwd).toBe(project);
        for (const owner of [a.threadId, b.threadId]) {
          outputs.delete(owner);
          done.set(owner, yield* Deferred.make<string>());
        }
        yield* write({ ...freshTarget, data: command(a.threadId, "new-checkout") });
        yield* write({ ...b, data: command(b.threadId, "sibling-survived") });
        for (const [owner, cwd, branch, content] of [
          [a.threadId, project, "main", "new-checkout"],
          [b.threadId, worktreeB, "branch-b", "sibling-survived"],
        ] as const) {
          const output = yield* Deferred.await(done.get(owner)!).pipe(Effect.timeout("10 seconds"));
          const canonicalCwd = yield* fs.realPath(cwd);
          expect(output).toContain(
            `\nBEGIN_${owner}\n${canonicalCwd}\n${branch}\n${content}\nEND_${owner}\n`,
          );
          expect(yield* fs.readFileString(path.join(cwd, "scope.txt"))).toBe(`${content}\n`);
        }
        expect(yield* fs.readFileString(path.join(worktreeA, "scope.txt"))).toBe("only-a\n");
        const finalSnapshots: TerminalSessionSnapshot[] = [];
        for (const target of [a, b]) {
          const detach = yield* manager.attachStream(yield* resolve(target), (event) =>
            Effect.sync(() => {
              if (event.type === "snapshot") finalSnapshots.push(event.snapshot);
            }),
          );
          yield* Effect.addFinalizer(() => Effect.sync(detach));
        }
        expect(finalSnapshots[0]).toMatchObject({
          pid: firstA.pid,
          cwd: worktreeA,
          status: "running",
        });
        expect(finalSnapshots[0]?.history).toContain("OLD_SHELL_FINISHED");
        expect(finalSnapshots[0]?.history).toContain("only-a");
        expect(finalSnapshots[1]).toMatchObject({
          pid: firstB.pid,
          cwd: worktreeB,
          status: "running",
        });
        yield* projectShell.close({ projectId, terminalId: "same-shell" });
        yield* manager.close({ threadId: a.threadId, terminalId: "same-shell" });
        yield* manager.close({ threadId: a.threadId, terminalId: "split-shell" });
        yield* manager.close({ threadId: a.threadId, terminalId: "current-checkout" });
        yield* manager.close({ threadId: b.threadId, terminalId: "same-shell" });
      }).pipe(Effect.provide(testLayer), Effect.scoped),
    30_000,
  );
});

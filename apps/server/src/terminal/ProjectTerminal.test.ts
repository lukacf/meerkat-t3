import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  type ProjectTerminalEvent,
  type TerminalAttachInput,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { TerminalManager } from "./Manager.ts";
import {
  makeProjectTerminalService,
  makeThreadTerminalLaunchResolver,
  projectTerminalOwnerKey,
  projectTerminalEvent,
  threadTerminalMetadata,
} from "./ProjectTerminal.ts";

const projectId = ProjectId.make("project-a");
const target = { projectId, terminalId: "shell-a" };
const snapshot = {
  threadId: projectTerminalOwnerKey(projectId),
  terminalId: target.terminalId,
  cwd: "/workspace/project-a",
  worktreePath: null,
  status: "running" as const,
  pid: 12,
  history: "previous output\r\n",
  exitCode: null,
  exitSignal: null,
  label: "zsh",
  updatedAt: "now",
  sequence: 4,
};

function managerStub(
  onAttach: TerminalManager["Service"]["attachStream"],
  writes: unknown[] = [],
): TerminalManager["Service"] {
  return {
    open: () => Effect.die("Unexpected terminal open"),
    attachStream: onAttach,
    write: (input) =>
      Effect.sync(() => {
        writes.push(input);
      }),
    resize: () => Effect.void,
    clear: () => Effect.void,
    close: () => Effect.void,
    restart: () => Effect.die("Unexpected terminal restart"),
    subscribe: () => Effect.succeed(() => {}),
    subscribeMetadata: () => Effect.succeed(() => {}),
  };
}
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Project','/workspace/project-a','[]','now','now')`;
});

describe("project terminal ownership", () => {
  it.effect("resolves the project directory and script environment for the attached shell", () =>
    Effect.gen(function* () {
      yield* seed;
      const opened: TerminalAttachInput[] = [];
      const received: ProjectTerminalEvent[] = [];
      const writes: unknown[] = [];
      let detached = false;
      const manager = managerStub(
        (input, listener) =>
          Effect.gen(function* () {
            opened.push(input);
            yield* listener({ type: "snapshot", snapshot });
            yield* listener({
              type: "output",
              threadId: projectTerminalOwnerKey(ProjectId.make("other-project")),
              terminalId: input.terminalId,
              data: "foreign",
            });
            yield* listener({
              type: "output",
              threadId: input.threadId,
              terminalId: "other-shell",
              data: "foreign",
            });
            yield* listener({
              type: "output",
              threadId: input.threadId,
              terminalId: input.terminalId ?? "",
              data: "next\r\n",
              sequence: 5,
            });
            return () => {
              detached = true;
            };
          }),
        writes,
      );
      const service = yield* makeProjectTerminalService().pipe(
        Effect.provideService(TerminalManager, manager),
      );
      const detach = yield* service.attach({ ...target, cols: 90, rows: 28 }, (event) =>
        Effect.sync(() => {
          received.push(event);
        }),
      );
      yield* service.write({ ...target, data: "pwd\r" });
      detach();
      expect(detached).toBe(true);
      expect(opened).toEqual([
        {
          threadId: projectTerminalOwnerKey(projectId),
          terminalId: "shell-a",
          cwd: "/workspace/project-a",
          env: { T3CODE_PROJECT_ROOT: "/workspace/project-a" },
          cols: 90,
          rows: 28,
        },
      ]);
      expect(writes).toEqual([
        {
          threadId: projectTerminalOwnerKey(projectId),
          terminalId: "shell-a",
          cwd: "/workspace/project-a",
          data: "pwd\r",
        },
      ]);
      expect(received.map((event) => [event.type, event.data])).toEqual([
        ["snapshot", "previous output\r\n"],
        ["output", "next\r\n"],
      ]);
      expect(received.every((event) => !("threadId" in event))).toBe(true);
      expect(received.every((event) => event.projectId === projectId)).toBe(true);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("refuses missing and deleted projects before attaching or writing", () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* makeProjectTerminalService().pipe(
        Effect.provideService(
          TerminalManager,
          managerStub(() => Effect.die("Must not attach a missing project")),
        ),
      );
      const missing = yield* service
        .attach({ ...target, projectId: ProjectId.make("missing") }, () => Effect.void)
        .pipe(Effect.flip);
      expect(missing.message).toBe("Project not found.");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_projects SET deleted_at = 'now' WHERE project_id = ${projectId}`;
      const deleted = yield* service.write({ ...target, data: "pwd\r" }).pipe(Effect.flip);
      expect(deleted.message).toBe("Project not found.");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it("keeps private project shells out of every thread metadata event", () => {
    const hidden: TerminalSummary = { ...snapshot, hasRunningSubprocess: false };
    const visible: TerminalSummary = { ...hidden, threadId: "ordinary-thread" };
    expect(threadTerminalMetadata({ type: "snapshot", terminals: [hidden, visible] })).toEqual({
      type: "snapshot",
      terminals: [visible],
    });
    expect(threadTerminalMetadata({ type: "upsert", terminal: hidden })).toBeNull();
    expect(
      threadTerminalMetadata({
        type: "remove",
        threadId: hidden.threadId,
        terminalId: hidden.terminalId,
      }),
    ).toBeNull();
    expect(threadTerminalMetadata({ type: "upsert", terminal: visible })).toEqual({
      type: "upsert",
      terminal: visible,
    });
    expect(
      projectTerminalEvent(target, {
        type: "snapshot",
        snapshot: { ...snapshot, threadId: "ordinary-thread" },
      }),
    ).toBeNull();
  });
});

describe("native thread terminal launch authority", () => {
  it.effect("keeps two worktree shells separate from their shared project-agent shell", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      for (const [id, path] of [
        ["worker-a", "/workspace/worktrees/a"],
        ["worker-b", "/workspace/worktrees/b"],
      ]) {
        yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,worktree_path,created_at,updated_at) VALUES (${id},${projectId},'Worker','{}',${path},'now','now')`;
        yield* sql`INSERT INTO provider_session_runtime (thread_id,provider_name,provider_instance_id,adapter_key,status,last_seen_at) VALUES (${id},'meerkat','meerkat','meerkat','ready','now')`;
      }
      const resolve = yield* makeThreadTerminalLaunchResolver();
      const a = yield* resolve({
        threadId: "worker-a",
        terminalId: "term-1",
        cwd: "/workspace/project-a",
        worktreePath: "/incorrect",
      });
      const b = yield* resolve({
        threadId: "worker-b",
        terminalId: "term-1",
        cwd: "/workspace/worktrees/a",
      });
      expect(a).toMatchObject({
        threadId: "worker-a",
        cwd: "/workspace/worktrees/a",
        worktreePath: "/workspace/worktrees/a",
      });
      expect(b).toMatchObject({
        threadId: "worker-b",
        cwd: "/workspace/worktrees/b",
        worktreePath: "/workspace/worktrees/b",
      });
      const attach = yield* resolve({ threadId: "worker-b", terminalId: "term-2" });
      expect(attach).toMatchObject({
        cwd: "/workspace/worktrees/b",
        worktreePath: "/workspace/worktrees/b",
      });
      const shells: TerminalAttachInput[] = [];
      const project = yield* makeProjectTerminalService().pipe(
        Effect.provideService(
          TerminalManager,
          managerStub((input) =>
            Effect.sync(() => {
              shells.push(input);
              return () => {};
            }),
          ),
        ),
      );
      yield* project.attach(target, () => Effect.void);
      expect(shells[0]).toMatchObject({
        threadId: projectTerminalOwnerKey(projectId),
        cwd: "/workspace/project-a",
      });
      yield* sql`UPDATE projection_threads SET worktree_path = NULL WHERE thread_id = 'worker-a'`;
      const main = yield* resolve({ ...a, cwd: "/stale-worktree" });
      expect(main).toMatchObject({ cwd: "/workspace/project-a", worktreePath: null });
      const write = yield* resolve({ threadId: "worker-a", terminalId: "term-1", data: "pwd\r" });
      expect(write).toMatchObject({
        data: "pwd\r",
        executionScope: { cwd: "/workspace/project-a", worktreePath: null },
      });
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("rejects deleted native contexts and preserves unrelated donor draft launches", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,worktree_path,created_at,updated_at) VALUES ('native',${projectId},'Worker','{}','/worktree','now','now')`;
      yield* sql`INSERT INTO provider_session_runtime (thread_id,provider_name,provider_instance_id,adapter_key,status,last_seen_at) VALUES ('native','meerkat','meerkat','meerkat','ready','now')`;
      const resolve = yield* makeThreadTerminalLaunchResolver();
      const draft = { threadId: "unsaved-draft", terminalId: "term-1", cwd: "/new-project" };
      expect(yield* resolve(draft)).toEqual(draft);
      yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,created_at,updated_at) VALUES ('donor',${projectId},'Donor','{}','now','now')`;
      yield* sql`INSERT INTO provider_session_runtime (thread_id,provider_name,provider_instance_id,adapter_key,status,last_seen_at) VALUES ('donor','codex','codex','codex','ready','now')`;
      const donor = { threadId: "donor", terminalId: "term-1", data: "pwd\r" };
      expect(yield* resolve(donor)).toEqual(donor);
      yield* sql`UPDATE projection_threads SET deleted_at = 'now' WHERE thread_id = 'native'`;
      expect((yield* resolve({ ...draft, threadId: "native" }).pipe(Effect.flip))._tag).toBe(
        "TerminalSessionLookupError",
      );
      yield* sql`UPDATE projection_threads SET deleted_at = NULL WHERE thread_id = 'native'`;
      yield* sql`UPDATE projection_projects SET deleted_at = 'now' WHERE project_id = ${projectId}`;
      expect((yield* resolve({ ...draft, threadId: "native" }).pipe(Effect.flip))._tag).toBe(
        "TerminalSessionLookupError",
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});

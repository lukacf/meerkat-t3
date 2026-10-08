import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type MeerkatTeamAgent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import type { MeerkatTeamReader } from "./MeerkatTeamReader.ts";
import { makeMeerkatObservedAgents } from "./MeerkatObservedAgents.ts";
import { makeMeerkatConversationSearch } from "./MeerkatConversationSearch.ts";

const instanceId = ProviderInstanceId.make("native");
function agent(ref: string, projectAgent = false): MeerkatTeamAgent {
  return {
    agentRef: ref,
    mobId: "mob",
    mobLabel: "Mob",
    mobKind: projectAgent ? "domain" : "thread",
    scopeLabel: "Project",
    ...(projectAgent
      ? { projectAgentId: `definition-${ref}` }
      : { threadId: ThreadId.make(`thread-${ref}`) }),
    record: {
      identity: "reviewer",
      display_name: "Reviewer",
      runtime_key: "default",
      runtime_member_id: `member-${ref}`,
      session_id: `session-${ref}`,
      visibility: "retired_readable",
      addressable: false,
      health: "unloaded",
      labels: {},
    },
  };
}
const harness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const observed = yield* makeMeerkatObservedAgents;
  const calls: Array<Parameters<NonNullable<MeerkatTeamReader["search"]>>[0]> = [];
  let stateRoot = "/provider";
  const reader: MeerkatTeamReader = {
    get stateRoot() {
      return stateRoot;
    },
    snapshot: () => Effect.die("Search must not inspect live runtimes"),
    activity: () => Effect.die("Search must not load live activity"),
    search: (request) =>
      Effect.sync(() => {
        calls.push(request);
        return request.query === "needle"
          ? {
              sessionId: request.record.session_id!,
              storeRevision: "7",
              offset: 800,
              source: "assistant" as const,
              snippet: "Old needle reply",
            }
          : null;
      }),
  };
  const instance: ProviderInstance = {
    instanceId,
    driverKind: ProviderDriverKind.make("meerkat"),
    continuationIdentity: {
      driverKind: ProviderDriverKind.make("meerkat"),
      continuationKey: "native",
    },
    displayName: "Native",
    enabled: true,
    meerkatTeam: reader,
    get adapter(): never {
      throw new Error("No runtime admission");
    },
    get snapshot(): never {
      throw new Error("No catalog refresh");
    },
    get textGeneration(): never {
      throw new Error("No model calls");
    },
  };
  const search = yield* makeMeerkatConversationSearch.pipe(
    Effect.provide(
      Layer.mock(ProviderInstanceRegistry)({ listInstances: Effect.succeed([instance]) }),
    ),
  );
  const add = Effect.fnUntraced(function* (ref: string, project: string, projectAgent = false) {
    const projectId = ProjectId.make(project);
    yield* sql`INSERT OR IGNORE INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Repeated project',${`/work/${project}`},'[]','now','now')`;
    const native = agent(ref, projectAgent);
    if (native.threadId)
      yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at) VALUES (${native.threadId},${projectId},'Repeated thread','{}','now','now')`;
    yield* observed.save({
      projectId,
      instanceId,
      providerStateRoot: "/provider",
      projectPath: `/work/${project}`,
      stateRoot: `/state/${project}`,
      agent: native,
      observedAt: "2026-09-28T00:00:00Z",
    });
  });
  return {
    sql,
    search,
    add,
    calls,
    changeProvider: () => {
      stateRoot = "/different-provider";
    },
  };
});

describe("durable native conversation search", () => {
  it.effect(
    "finds unloaded histories with repeated labels using exact project/session targets",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.add("a", "project-a", true);
        yield* h.add("b", "project-b");
        const result = yield* h.search({ query: "needle" });
        expect(result.matches).toMatchObject([
          {
            projectId: "project-a",
            projectAgentId: "definition-a",
            agentRef: "a",
            message: { sessionId: "session-a", storeRevision: "7", offset: 800 },
          },
          {
            projectId: "project-b",
            threadId: "thread-b",
            agentRef: "b",
            message: { sessionId: "session-b" },
          },
        ]);
        expect(
          h.calls.map((call) => [call.projectPath, call.stateRoot, call.record.runtime_member_id]),
        ).toEqual([
          ["/work/project-a", "/state/project-a", "member-a"],
          ["/work/project-b", "/state/project-b", "member-b"],
        ]);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect(
    "does not leak deleted projects or threads, or read a reconfigured provider's storage",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.add("a", "a", true);
        yield* h.add("b", "b");
        yield* h.add("c", "c");
        yield* h.sql`UPDATE projection_projects SET deleted_at='now' WHERE project_id='a'`;
        yield* h.sql`UPDATE projection_threads SET deleted_at='now' WHERE thread_id='thread-b'`;
        h.changeProvider();
        const result = yield* h.search({ query: "reviewer" });
        expect(result.matches.map((match) => match.agentRef)).toEqual(["c"]);
        expect(result.unavailable).toBe(1);
        expect(h.calls).toHaveLength(0);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect(
    "provides bounded continuation without omissions or duplicates and binds cursors to the query",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        for (let index = 0; index < 15; index++) yield* h.add(String(index).padStart(2, "0"), "a");
        const first = yield* h.search({ query: "needle" });
        expect(first.scanned).toBe(12);
        expect(first.matches).toHaveLength(12);
        const next = yield* h.search({ query: "needle", cursor: first.nextCursor! });
        expect(next.scanned).toBe(3);
        expect(next.nextCursor).toBeUndefined();
        expect(
          new Set([...first.matches, ...next.matches].map((match) => match.agentRef)).size,
        ).toBe(15);
        expect(
          (yield* h.search({ query: "different", cursor: first.nextCursor! }).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});

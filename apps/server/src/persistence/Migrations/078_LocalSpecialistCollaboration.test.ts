import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "078_LocalSpecialistCollaboration",
  (it) => {
    it.effect(
      "preserves existing policy and native bindings while allowing explicit local collaboration policy",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 77 });
          for (const mode of ["full-access", "read-only", "repository-read-only"])
            yield* sql`INSERT INTO meerkat_project_agents
      (agent_id,project_id,instance_id,request_id,request_fingerprint,label,role,instructions,model,
        provider_state_root,state_root,mob_id,agent_identity,enabled,archived,created_at,updated_at,access_mode)
      VALUES (${mode},'project','provider',${mode},'fingerprint','API specialist','api','Inspect','model',
        '/provider','/saved/domain',${"native-" + mode},'original-member',1,0,'created','updated',${mode})`;
          const before = yield* sql`SELECT * FROM meerkat_project_agents ORDER BY agent_id`;
          const applied = yield* runMigrations({ toMigrationInclusive: 78 });
          assert.deepEqual(applied, [[78, "LocalSpecialistCollaboration"]]);
          const after = yield* sql`SELECT a.* FROM meerkat_project_agents a ORDER BY a.agent_id`;
          assert.deepEqual(after, before);
          yield* sql`UPDATE meerkat_project_agents SET access_mode = 'read-and-collaborate' WHERE agent_id = 'read-only'`;
          assert.strictEqual(
            (yield* sql<{
              access_mode: string;
            }>`SELECT access_mode FROM meerkat_project_agents WHERE agent_id = 'read-only'`)[0]
              ?.access_mode,
            "read-and-collaborate",
          );
          const rejected =
            yield* sql`UPDATE meerkat_project_agents SET access_mode = 'unrestricted'`.pipe(
              Effect.exit,
            );
          assert.strictEqual(rejected._tag, "Failure");
        }),
    );
  },
);

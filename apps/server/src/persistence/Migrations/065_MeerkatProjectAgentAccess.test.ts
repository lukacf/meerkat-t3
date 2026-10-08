import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "065_MeerkatProjectAgentAccess",
  (it) => {
    it.effect("retains the original full-access policy and durable identity of legacy agents", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 64 });
        yield* sql`INSERT INTO meerkat_project_agents
          (agent_id,project_id,instance_id,request_id,request_fingerprint,label,role,instructions,model,
            provider_state_root,state_root,mob_id,agent_identity,enabled,archived,created_at,updated_at)
          VALUES ('agent','project','provider','request','fingerprint','Reviewer','reviewer','Review','model',
            '/provider','/saved/domain','original-mob','original-member',1,0,'created','updated')`;
        const before = yield* sql`SELECT * FROM meerkat_project_agents`;
        const applied = yield* runMigrations({ toMigrationInclusive: 65 });
        assert.deepEqual(applied, [[65, "MeerkatProjectAgentAccess"]]);
        // Prepare after the schema change rather than reusing the pre-migration SELECT *.
        const after = yield* sql`SELECT agent.* FROM meerkat_project_agents AS agent`;
        assert.deepEqual(after, [{ ...before[0], access_mode: "full-access" }]);
      }),
    );
  },
);

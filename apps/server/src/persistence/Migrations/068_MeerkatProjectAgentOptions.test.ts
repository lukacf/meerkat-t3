import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "068_MeerkatProjectAgentOptions",
  (it) => {
    it.effect("preserves legacy creation identity and leaves its options unspecified", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 67 });
        yield* sql`INSERT INTO meerkat_project_agents
          (agent_id,project_id,instance_id,request_id,request_fingerprint,label,role,instructions,model,
            provider_state_root,state_root,mob_id,agent_identity,enabled,archived,created_at,updated_at)
          VALUES ('agent','project','provider','request','original-fingerprint','Reviewer','reviewer','Review','model',
            '/provider','/saved/domain','original-mob','original-member',1,0,'created','updated')`;
        const before = yield* sql`SELECT * FROM meerkat_project_agents`;
        assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 68 }), [
          [68, "MeerkatProjectAgentOptions"],
        ]);
        const after = yield* sql`SELECT agent.* FROM meerkat_project_agents AS agent`;
        assert.deepEqual(after, [{ ...before[0], options_json: null }]);
      }),
    );
  },
);

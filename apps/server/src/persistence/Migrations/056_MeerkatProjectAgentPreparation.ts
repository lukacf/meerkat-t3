import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE meerkat_project_agents ADD COLUMN assignment_json TEXT`;
  yield* sql`ALTER TABLE meerkat_project_agents ADD COLUMN preparation_json TEXT`;
  yield* sql`CREATE TABLE meerkat_project_agent_setup (
    project_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE, instance_id TEXT NOT NULL, created_at TEXT NOT NULL
  )`;
});

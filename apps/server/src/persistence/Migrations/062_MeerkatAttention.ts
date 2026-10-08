import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE meerkat_attention (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, instance_id TEXT NOT NULL,
    agent_ref TEXT, session_id TEXT, kind TEXT NOT NULL, item_json TEXT NOT NULL,
    active INTEGER NOT NULL, read_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX idx_meerkat_attention_project ON meerkat_attention(project_id,active,updated_at)`;
  yield* sql`CREATE TABLE meerkat_attention_observations (project_id TEXT PRIMARY KEY, observed_at TEXT NOT NULL)`;
});

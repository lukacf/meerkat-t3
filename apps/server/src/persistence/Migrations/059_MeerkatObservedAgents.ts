import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE meerkat_observed_agents (
    agent_ref TEXT PRIMARY KEY,
    durable_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    provider_state_root TEXT NOT NULL,
    project_path TEXT NOT NULL,
    state_root TEXT,
    thread_id TEXT,
    agent_json TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX idx_meerkat_observed_agents_project ON meerkat_observed_agents(project_id, instance_id)`;
});

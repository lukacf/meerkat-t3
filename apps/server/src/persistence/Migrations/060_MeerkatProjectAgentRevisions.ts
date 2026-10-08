import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE meerkat_project_agents ADD COLUMN pending_revision_json TEXT`;
  yield* sql`ALTER TABLE meerkat_project_agents ADD COLUMN revision_version INTEGER NOT NULL DEFAULT 1`;
  yield* sql`CREATE TABLE meerkat_project_agent_revisions (
    agent_id TEXT NOT NULL, revision_id TEXT NOT NULL, version INTEGER NOT NULL,
    instructions TEXT NOT NULL, assignment_json TEXT, preparation_json TEXT,
    created_at TEXT NOT NULL, applied_at TEXT,
    PRIMARY KEY (agent_id, revision_id), UNIQUE(agent_id,version)
  )`;
  yield* sql`CREATE TABLE meerkat_project_agent_studies (
    agent_id TEXT NOT NULL, request_id TEXT NOT NULL, preparation_json TEXT NOT NULL,
    PRIMARY KEY (agent_id, request_id)
  )`;
});

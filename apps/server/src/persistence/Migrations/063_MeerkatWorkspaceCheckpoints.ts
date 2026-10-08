import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE meerkat_workspace_checkpoints (
    id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, mob_id TEXT NOT NULL,
    session_id TEXT NOT NULL, state_root TEXT NOT NULL, project_path TEXT NOT NULL, workspace TEXT NOT NULL,
    before_ref TEXT, after_ref TEXT, started_at TEXT NOT NULL, completed_at TEXT,
    status TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'native', detail TEXT
  )`;
  yield* sql`CREATE INDEX meerkat_workspace_checkpoint_scope ON meerkat_workspace_checkpoints(instance_id,mob_id,project_path,started_at)`;
});

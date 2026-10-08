import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE meerkat_agent_queues (
    target_key TEXT PRIMARY KEY, project_id TEXT NOT NULL, instance_id TEXT NOT NULL,
    durable_id TEXT NOT NULL, binding_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
    waiting_reason TEXT
  )`;
  yield* sql`CREATE TABLE meerkat_agent_queue_items (
    item_id TEXT PRIMARY KEY, target_key TEXT NOT NULL REFERENCES meerkat_agent_queues(target_key),
    request_id TEXT NOT NULL, enqueue_fingerprint TEXT NOT NULL,
    payload_json TEXT NOT NULL, position INTEGER NOT NULL,
    status TEXT NOT NULL, error TEXT, receipt_json TEXT,
    dispatch_session_id TEXT, dispatch_agent_ref TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(target_key,request_id)
  )`;
  yield* sql`CREATE INDEX idx_meerkat_agent_queue_items_target ON meerkat_agent_queue_items(target_key,position)`;
  yield* sql`CREATE UNIQUE INDEX idx_meerkat_agent_queue_one_active
    ON meerkat_agent_queue_items(target_key) WHERE status IN ('dispatching','accepted','uncertain')`;
});

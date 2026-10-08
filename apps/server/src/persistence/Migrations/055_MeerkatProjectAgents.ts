import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE meerkat_project_agents (
    agent_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    label TEXT NOT NULL,
    role TEXT NOT NULL,
    instructions TEXT NOT NULL,
    model TEXT NOT NULL,
    provider_state_root TEXT NOT NULL,
    state_root TEXT NOT NULL,
    mob_id TEXT NOT NULL,
    agent_identity TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    archived INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, instance_id, request_id)
  )`;
  yield* sql`CREATE INDEX idx_meerkat_project_agents_project
    ON meerkat_project_agents(project_id, instance_id)`;
  yield* sql`CREATE TABLE meerkat_thread_connections (
    thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, instance_id TEXT NOT NULL,
    agent_ids_json TEXT NOT NULL, request_id TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  // A durable claim is written before delivery. An uncertain request is never replayed.
  yield* sql`CREATE TABLE meerkat_agent_delivery_receipts (
    project_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, instance_id, request_id)
  )`;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE shared_delegations (
    delegation_id TEXT PRIMARY KEY,
    parent_session_id TEXT NOT NULL,
    owner_participant_id TEXT NOT NULL REFERENCES shared_participants(participant_id),
    request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    UNIQUE(parent_session_id, request_id)
  )`;
  yield* sql`CREATE TABLE shared_local_connections (
    connection_id TEXT PRIMARY KEY,
    owner_session_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    secret_name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    definition_json TEXT,
    UNIQUE(owner_session_id, request_id)
  )`;
  yield* sql`CREATE TABLE shared_local_connection_cancellations (
    owner_session_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    canceled_at TEXT NOT NULL,
    PRIMARY KEY(owner_session_id, request_id)
  )`;
  yield* sql`CREATE TABLE shared_local_delegations (
    local_id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL REFERENCES shared_local_connections(connection_id),
    thread_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    registration_json TEXT NOT NULL,
    definition_json TEXT,
    revoked_at TEXT
  )`;
  yield* sql`CREATE UNIQUE INDEX shared_local_delegations_active_thread
    ON shared_local_delegations(thread_id) WHERE revoked_at IS NULL`;
});

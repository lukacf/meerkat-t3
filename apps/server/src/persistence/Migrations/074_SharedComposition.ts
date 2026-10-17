import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Intent, reservations and routing lineage are application facts, not native lifecycle state.
  yield* sql`CREATE TABLE shared_composition_operations (
    operation_key TEXT PRIMARY KEY, actor_key TEXT NOT NULL, operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, input_json TEXT NOT NULL, definition_json TEXT NOT NULL,
    UNIQUE(actor_key, operation_id)
  )`;
  yield* sql`CREATE TABLE shared_composition_creations (
    operation_key TEXT NOT NULL REFERENCES shared_composition_operations(operation_key),
    creation_key TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, native_target_json TEXT NOT NULL,
    specialist_id TEXT REFERENCES shared_specialists(specialist_id),
    PRIMARY KEY(operation_key, creation_key)
  )`;
  yield* sql`CREATE TABLE shared_composition_targets (
    specialist_id TEXT PRIMARY KEY REFERENCES shared_specialists(specialist_id),
    operation_key TEXT NOT NULL REFERENCES shared_composition_operations(operation_key)
  )`;
  yield* sql`CREATE TABLE shared_composition_recovery (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    after_rowid INTEGER NOT NULL DEFAULT 0,
    through_rowid INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE TABLE shared_specialist_lineage (
    operation_key TEXT NOT NULL REFERENCES shared_composition_operations(operation_key),
    predecessor_id TEXT NOT NULL REFERENCES shared_specialists(specialist_id),
    successor_id TEXT NOT NULL REFERENCES shared_specialists(specialist_id),
    superseded INTEGER NOT NULL CHECK(superseded IN (0, 1)),
    PRIMARY KEY(operation_key, predecessor_id, successor_id)
  )`;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE meerkat_peer_connections (
    edge_id TEXT PRIMARY KEY, source_key TEXT NOT NULL, target_key TEXT NOT NULL,
    source_json TEXT NOT NULL, target_json TEXT NOT NULL, provider_state_root TEXT NOT NULL,
    desired INTEGER NOT NULL, request_id TEXT NOT NULL, last_error TEXT, updated_at TEXT NOT NULL,
    UNIQUE(source_key, target_key)
  )`;
  yield* sql`CREATE INDEX idx_meerkat_peer_connections_source ON meerkat_peer_connections(source_key)`;
  yield* sql`CREATE INDEX idx_meerkat_peer_connections_target ON meerkat_peer_connections(target_key)`;
});

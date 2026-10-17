import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Account product payloads, including reserved copies in immutable inbox batches.
  // This is not SQLite file size or native transcript accounting. Counters are
  // derived in the same transaction as their rows and survive restart/replay.
  yield* sql`CREATE TABLE shared_evidence_usage (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    bytes INTEGER NOT NULL CHECK(bytes >= 0),
    records INTEGER NOT NULL CHECK(records >= 0),
    pending_inbox INTEGER NOT NULL CHECK(pending_inbox >= 0)
  )`;
  yield* sql`INSERT INTO shared_evidence_usage VALUES (1, 0, 0, 0)`;

  // Each immutable context reserves its current-context copy. Knowledge reserves
  // its searchable text copy. An inbox delivery reserves one saved batch copy
  // plus 1 KiB for its envelope and acknowledgement, even before it is fetched.
  // No reservation is released on acknowledgement: those receipts stay retained.
  const tables = [
    {
      table: "shared_context_versions",
      bytes: (row: string) => `2 * length(CAST(${row}.definition_json AS BLOB))`,
    },
    {
      table: "shared_activity",
      bytes: (row: string) => `length(CAST(${row}.definition_json AS BLOB))`,
    },
    {
      table: "shared_knowledge",
      bytes: (row: string) => `2 * length(CAST(${row}.definition_json AS BLOB))`,
    },
    {
      table: "shared_snapshots",
      bytes: (row: string) =>
        `length(CAST(${row}.definition_json AS BLOB)) + length(CAST(${row}.patch AS BLOB))`,
    },
    {
      table: "shared_inbox",
      bytes: (row: string) =>
        `1024 + (SELECT length(CAST(a.definition_json AS BLOB)) FROM shared_activity a WHERE a.sequence = ${row}.sequence)`,
    },
  ];
  for (const { table, bytes } of tables) {
    // Identifiers and expressions are migration constants, never caller input.
    yield* sql.unsafe(`UPDATE shared_evidence_usage SET
      bytes = bytes + (SELECT COALESCE(SUM(${bytes("r")}), 0) FROM ${table} r),
      records = records + (SELECT COUNT(*) FROM ${table}) WHERE singleton = 1`);
    yield* sql.unsafe(`CREATE TRIGGER ${table}_evidence_insert AFTER INSERT ON ${table}
      BEGIN UPDATE shared_evidence_usage SET bytes = bytes + (${bytes("NEW")}),
        records = records + 1 WHERE singleton = 1; END`);
    yield* sql.unsafe(`CREATE TRIGGER ${table}_evidence_update AFTER UPDATE ON ${table}
      BEGIN UPDATE shared_evidence_usage SET bytes = bytes + (${bytes("NEW")}) - (${bytes("OLD")})
        WHERE singleton = 1; END`);
    yield* sql.unsafe(`CREATE TRIGGER ${table}_evidence_delete AFTER DELETE ON ${table}
      BEGIN UPDATE shared_evidence_usage SET bytes = bytes - (${bytes("OLD")}),
        records = records - 1 WHERE singleton = 1; END`);
  }
  yield* sql`UPDATE shared_evidence_usage SET pending_inbox =
    (SELECT COUNT(*) FROM shared_inbox WHERE acknowledged_at IS NULL) WHERE singleton = 1`;
  yield* sql`CREATE TRIGGER shared_inbox_pending_insert AFTER INSERT ON shared_inbox
    BEGIN UPDATE shared_evidence_usage SET pending_inbox = pending_inbox + (NEW.acknowledged_at IS NULL)
      WHERE singleton = 1; END`;
  yield* sql`CREATE TRIGGER shared_inbox_pending_update AFTER UPDATE OF acknowledged_at ON shared_inbox
    BEGIN UPDATE shared_evidence_usage SET pending_inbox = pending_inbox
      + (NEW.acknowledged_at IS NULL) - (OLD.acknowledged_at IS NULL) WHERE singleton = 1; END`;
  yield* sql`CREATE TRIGGER shared_inbox_pending_delete AFTER DELETE ON shared_inbox
    BEGIN UPDATE shared_evidence_usage SET pending_inbox = pending_inbox - (OLD.acknowledged_at IS NULL)
      WHERE singleton = 1; END`;
  // The host overview counts app observations without scanning saved payloads.
  yield* sql`CREATE INDEX shared_requests_outcome_status ON shared_specialist_requests
    (json_extract(definition_json, '$.outcome.status'))`;
  yield* sql`CREATE INDEX shared_composition_status ON shared_composition_operations
    (json_extract(definition_json, '$.status'))`;
});

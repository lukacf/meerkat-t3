import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // This cursor tracks bounded observation work only, never native admission or execution.
  yield* sql`CREATE TABLE shared_specialist_recovery (
    specialist_id TEXT PRIMARY KEY REFERENCES shared_specialists(specialist_id),
    after_rowid INTEGER NOT NULL CHECK (after_rowid >= 0),
    through_rowid INTEGER NOT NULL CHECK (through_rowid >= after_rowid)
  )`;
});

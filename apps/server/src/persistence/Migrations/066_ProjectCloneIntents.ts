import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Written before project creation, so a crash cannot expose an empty clone as ready.
  yield* sql`CREATE TABLE project_clone_intents (
    project_id TEXT PRIMARY KEY,
    intent_json TEXT NOT NULL
  )`;
});

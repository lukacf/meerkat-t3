import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE pending_created_pull_request_links (
    command_id TEXT PRIMARY KEY,
    intent_json TEXT NOT NULL
  )`;
});

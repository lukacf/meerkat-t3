import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Existing claims retain their exact target fence until an exact retry can bind it.
  yield* sql`ALTER TABLE meerkat_agent_delivery_receipts ADD COLUMN stable_fingerprint TEXT`;
});

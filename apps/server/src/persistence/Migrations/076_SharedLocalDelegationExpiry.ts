import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Expired grants retain their original revocation evidence. The broker's
  // transaction enforces one unexpired registration across all task connections.
  yield* sql`DROP INDEX shared_local_delegations_active_thread`;
  yield* sql`CREATE INDEX shared_local_delegations_thread_history
    ON shared_local_delegations(thread_id,local_id) WHERE revoked_at IS NULL`;
});

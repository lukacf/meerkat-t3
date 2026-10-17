import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Widen the saved policy vocabulary without converting any existing session.
  // SQLite cannot alter a column CHECK in place. Keep its original values until
  // the replacement is populated, all within the migration transaction.
  yield* sql`ALTER TABLE meerkat_project_agents RENAME COLUMN access_mode TO previous_access_mode`;
  yield* sql`ALTER TABLE meerkat_project_agents ADD COLUMN access_mode TEXT NOT NULL
    DEFAULT 'full-access' CHECK (access_mode IN ('read-only', 'repository-read-only', 'full-access'))`;
  yield* sql`UPDATE meerkat_project_agents SET access_mode = previous_access_mode`;
  yield* sql`ALTER TABLE meerkat_project_agents DROP COLUMN previous_access_mode`;
});

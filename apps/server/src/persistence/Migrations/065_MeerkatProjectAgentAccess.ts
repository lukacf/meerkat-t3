import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Earlier specialist creation omitted accessMode and used the native Full access default.
  // Preserve those sessions; changing this default to read-only would mislabel their policy.
  yield* sql`ALTER TABLE meerkat_project_agents ADD COLUMN access_mode TEXT NOT NULL
    DEFAULT 'full-access' CHECK (access_mode IN ('read-only', 'full-access'))`;
});

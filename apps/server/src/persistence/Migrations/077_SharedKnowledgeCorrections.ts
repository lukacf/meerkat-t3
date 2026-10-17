import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A derived reverse index preserves the original evidence and the correction's
  // own context. Searching an earlier revision must still reveal later corrections.
  yield* sql`CREATE TABLE shared_knowledge_corrections (
    previous_id TEXT NOT NULL REFERENCES shared_knowledge(evidence_id),
    correction_id TEXT NOT NULL REFERENCES shared_knowledge(evidence_id),
    PRIMARY KEY(previous_id, correction_id)
  )`;
  yield* sql`INSERT INTO shared_knowledge_corrections(previous_id, correction_id)
    SELECT DISTINCT p.evidence_id, c.evidence_id FROM shared_knowledge c
    JOIN json_each(c.definition_json, '$.supersedes') refs
    JOIN shared_knowledge p ON p.evidence_id = refs.value AND p.project_id = c.project_id`;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE shared_specialist_requests (
    request_id TEXT PRIMARY KEY,
    participant_id TEXT NOT NULL REFERENCES shared_participants(participant_id),
    specialist_id TEXT NOT NULL REFERENCES shared_specialists(specialist_id),
    client_request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    native_input_json TEXT NOT NULL,
    native_session_id TEXT,
    native_interaction_id TEXT,
    UNIQUE(participant_id, client_request_id)
  )`;
  yield* sql`CREATE INDEX shared_requests_specialist ON shared_specialist_requests(specialist_id)`;
  yield* sql`CREATE INDEX shared_requests_native_interaction ON shared_specialist_requests(specialist_id, native_session_id, native_interaction_id)`;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE shared_workspace (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), definition_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE shared_participants (
    participant_id TEXT PRIMARY KEY, definition_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE shared_participant_sessions (
    session_id TEXT PRIMARY KEY,
    participant_id TEXT NOT NULL REFERENCES shared_participants(participant_id)
  )`;
  yield* sql`CREATE TABLE shared_projects (
    project_id TEXT PRIMARY KEY, repository TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
    host_project_id TEXT NOT NULL, definition_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE shared_repository_aliases (
    repository TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES shared_projects(project_id)
  )`;
  yield* sql`CREATE TABLE shared_checkouts (
    checkout_id TEXT PRIMARY KEY,
    participant_id TEXT NOT NULL REFERENCES shared_participants(participant_id),
    project_id TEXT NOT NULL REFERENCES shared_projects(project_id),
    environment_id TEXT NOT NULL, local_project_id TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    UNIQUE(participant_id, environment_id, local_project_id)
  )`;
  yield* sql`CREATE TABLE shared_specialists (
    specialist_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL, native_project_id TEXT NOT NULL,
    native_instance_id TEXT NOT NULL, native_agent_id TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    UNIQUE(native_project_id, native_instance_id, native_agent_id)
  )`;
  yield* sql`CREATE TABLE shared_assignments (
    specialist_id TEXT NOT NULL REFERENCES shared_specialists(specialist_id),
    project_id TEXT NOT NULL REFERENCES shared_projects(project_id),
    definition_json TEXT NOT NULL, PRIMARY KEY(specialist_id, project_id)
  )`;
  yield* sql`CREATE TABLE shared_work_contexts (
    context_id TEXT PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES shared_participants(participant_id),
    checkout_id TEXT NOT NULL REFERENCES shared_checkouts(checkout_id),
    project_id TEXT NOT NULL REFERENCES shared_projects(project_id), definition_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX shared_contexts_project ON shared_work_contexts(project_id)`;
  yield* sql`CREATE TABLE shared_context_versions (
    context_id TEXT NOT NULL REFERENCES shared_work_contexts(context_id),
    context_version TEXT NOT NULL, definition_json TEXT NOT NULL,
    PRIMARY KEY(context_id, context_version)
  )`;
  yield* sql`CREATE TABLE shared_interests (
    owner_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES shared_projects(project_id),
    recipient_id TEXT NOT NULL, dimension TEXT NOT NULL CHECK (dimension IN ('all', 'path', 'tag')),
    value TEXT NOT NULL, PRIMARY KEY(owner_id, project_id, dimension, value)
  )`;
  yield* sql`CREATE INDEX shared_interests_match ON shared_interests(project_id, dimension, value, recipient_id)`;
  yield* sql`CREATE TABLE shared_activity (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
    actor_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES shared_projects(project_id),
    context_id TEXT NOT NULL REFERENCES shared_work_contexts(context_id),
    definition_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE shared_inbox (
    recipient_id TEXT NOT NULL, sequence INTEGER NOT NULL REFERENCES shared_activity(sequence),
    acknowledged_at TEXT, PRIMARY KEY(recipient_id, sequence)
  )`;
  yield* sql`CREATE INDEX shared_inbox_pending ON shared_inbox(recipient_id, acknowledged_at, sequence)`;
  yield* sql`CREATE TABLE shared_inbox_batches (
    batch_id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL,
    definition_json TEXT NOT NULL, acknowledged_at TEXT
  )`;
  yield* sql`CREATE UNIQUE INDEX shared_inbox_open_batch ON shared_inbox_batches(recipient_id)
    WHERE acknowledged_at IS NULL`;
  yield* sql`CREATE TABLE shared_snapshots (
    snapshot_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES shared_projects(project_id),
    checkout_id TEXT NOT NULL REFERENCES shared_checkouts(checkout_id),
    definition_json TEXT NOT NULL, patch TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE shared_knowledge (
    evidence_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES shared_projects(project_id),
    context_id TEXT NOT NULL REFERENCES shared_work_contexts(context_id),
    actor_id TEXT NOT NULL, fingerprint TEXT NOT NULL, kind TEXT NOT NULL,
    branch TEXT NOT NULL, revision_commit TEXT NOT NULL, definition_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX shared_knowledge_revision ON shared_knowledge(project_id, branch, revision_commit)`;
  yield* sql`CREATE VIRTUAL TABLE shared_knowledge_search USING fts5(
    evidence_id UNINDEXED, content, tokenize = 'unicode61'
  )`;
});

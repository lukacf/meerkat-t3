import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("079_SharedEvidenceCapacity", (it) => {
  it.effect("accounts old evidence once while retaining batches and acknowledgements", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 78 });
      yield* sql`INSERT INTO shared_participants VALUES ('person', '{}')`;
      yield* sql`INSERT INTO shared_projects VALUES ('project', 'repository', 'request', 'fingerprint', 'host', '{}')`;
      yield* sql`INSERT INTO shared_checkouts VALUES ('checkout', 'person', 'project', 'env', 'local', '{}')`;
      yield* sql`INSERT INTO shared_work_contexts VALUES ('context', 'person', 'checkout', 'project', '{}')`;
      const context = '{"objective":"Read the API"}';
      const activity = '{"summary":"Correct the 漢字 interface"}';
      const knowledge = '{"body":"Keep previous evidence"}';
      const snapshot = '{"sha256":"retained"}';
      const patch = "+UTF-8: 漢字\n";
      yield* sql`INSERT INTO shared_context_versions VALUES ('context', 'version', ${context})`;
      yield* sql`INSERT INTO shared_activity VALUES (1, 'event', 'person', 'fingerprint', 'project', 'context', ${activity})`;
      yield* sql`INSERT INTO shared_knowledge VALUES ('evidence', 'project', 'context', 'person', 'fingerprint', 'fact', 'main', 'commit', ${knowledge})`;
      yield* sql`INSERT INTO shared_snapshots VALUES ('snapshot', 'project', 'checkout', ${snapshot}, ${patch})`;
      yield* sql`INSERT INTO shared_inbox VALUES ('person', 1, NULL), ('another', 1, 'acknowledged')`;
      yield* sql`INSERT INTO shared_inbox_batches VALUES ('saved-batch', 'another', ${activity}, 'acknowledged')`;
      const before = yield* sql`SELECT * FROM shared_inbox_batches`;
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 79 }), [
        [79, "SharedEvidenceCapacity"],
      ]);
      const bytes =
        2 * Buffer.byteLength(context) +
        Buffer.byteLength(activity) +
        2 * Buffer.byteLength(knowledge) +
        Buffer.byteLength(snapshot) +
        Buffer.byteLength(patch) +
        2 * (1024 + Buffer.byteLength(activity));
      const expected = [{ singleton: 1, bytes, records: 6, pending_inbox: 1 }];
      assert.deepEqual(yield* sql`SELECT * FROM shared_evidence_usage`, expected);
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 79 }), []);
      assert.deepEqual(yield* sql`SELECT * FROM shared_evidence_usage`, expected);
      assert.deepEqual(yield* sql`SELECT * FROM shared_inbox_batches`, before);
      yield* sql`UPDATE shared_inbox SET acknowledged_at = 'now' WHERE recipient_id = 'person'`;
      assert.deepEqual(yield* sql`SELECT * FROM shared_evidence_usage`, [
        { singleton: 1, bytes, records: 6, pending_inbox: 0 },
      ]);
      const failed = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO shared_context_versions VALUES ('context', 'second', ${context})`;
            yield* sql`INSERT INTO shared_inbox VALUES ('third', 1, NULL)`;
            return yield* Effect.fail("reject publication");
          }),
        )
        .pipe(Effect.exit);
      assert.strictEqual(failed._tag, "Failure");
      assert.deepEqual(yield* sql`SELECT * FROM shared_evidence_usage`, [
        { singleton: 1, bytes, records: 6, pending_inbox: 0 },
      ]);
      assert.deepEqual(yield* sql`SELECT * FROM shared_inbox_batches`, before);
    }),
  );
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "064_MeerkatCoordinatorReceiptTargets",
  (it) => {
    it.effect(
      "retains legacy acceptance evidence without inventing an original native target",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 63 });
          yield* sql`INSERT INTO meerkat_agent_delivery_receipts
        (project_id,instance_id,request_id,fingerprint,stable_fingerprint,receipt_json,created_at)
        VALUES ('project','native','original','fingerprint','stable','{"status":"uncertain"}','2026-09-28T10:00:00.000Z')`;
          yield* runMigrations({ toMigrationInclusive: 64 });
          const rows =
            yield* sql`SELECT request_id,fingerprint,receipt_json,native_target_json FROM meerkat_agent_delivery_receipts`;
          assert.deepEqual(rows, [
            {
              request_id: "original",
              fingerprint: "fingerprint",
              receipt_json: '{"status":"uncertain"}',
              native_target_json: null,
            },
          ]);
        }),
    );
  },
);

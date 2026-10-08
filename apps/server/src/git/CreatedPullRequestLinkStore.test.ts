import { expect, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { make, type CreatedPullRequestLinkIntent } from "./CreatedPullRequestLinkStore.ts";

const intent: CreatedPullRequestLinkIntent = {
  commandId: CommandId.make("server:created-pr-link:first"),
  threadId: ThreadId.make("original-thread"),
  host: "github.com",
  repository: "owner/repository",
  number: 42,
  url: "https://github.com/owner/repository/pull/42",
};

it.effect("retains exact returned identities in a fresh store until each acknowledgement", () =>
  Effect.gen(function* () {
    const first = yield* make;
    const other = {
      ...intent,
      commandId: CommandId.make("server:created-pr-link:second"),
      threadId: ThreadId.make("another-thread"),
    };
    yield* first.put(intent);
    yield* first.put(other);
    const restarted = yield* make;
    expect(yield* restarted.list).toEqual([intent, other]);
    yield* restarted.remove(intent);
    expect(yield* first.list).toEqual([other]);
    yield* restarted.remove(intent);
    expect(yield* first.list).toEqual([other]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("deduplicates identical writes but refuses to replace an original command identity", () =>
  Effect.gen(function* () {
    const store = yield* make;
    yield* store.put(intent);
    yield* store.put(intent);
    const error = yield* store
      .put({ ...intent, threadId: ThreadId.make("different-thread") })
      .pipe(Effect.flip);
    expect(error._tag).toBe("CreatedPullRequestLinkStoreError");
    expect(error.operation).toBe("put");
    expect(yield* store.list).toEqual([intent]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("a stale acknowledgement cannot delete a different saved result", () =>
  Effect.gen(function* () {
    const store = yield* make;
    yield* store.put(intent);
    yield* store.remove({
      ...intent,
      number: 43,
      url: "https://github.com/owner/repository/pull/43",
    });
    expect(yield* store.list).toEqual([intent]);
    yield* store.remove(intent);
    expect(yield* store.list).toEqual([]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("refuses corrupt stored payloads without discarding the recovery record", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* make;
    yield* store.put(intent);
    yield* sql`UPDATE pending_created_pull_request_links SET intent_json = '{broken'
      WHERE command_id = ${intent.commandId}`;
    expect((yield* store.list.pipe(Effect.flip)).operation).toBe("list");
    const rows = yield* sql`SELECT intent_json FROM pending_created_pull_request_links`;
    expect(rows).toEqual([{ intent_json: "{broken" }]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("refuses a stored command-key mismatch instead of replaying another identity", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* make;
    yield* store.put(intent);
    yield* sql`UPDATE pending_created_pull_request_links SET command_id = 'different-key'
      WHERE command_id = ${intent.commandId}`;
    expect((yield* store.list.pipe(Effect.flip)).operation).toBe("list");
    const rows = yield* sql`SELECT command_id FROM pending_created_pull_request_links`;
    expect(rows).toEqual([{ command_id: "different-key" }]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

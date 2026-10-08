import {
  CommandId,
  ThreadId,
  ThreadPullRequestKey,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** The returned identity, retained until the original link command is acknowledged. */
export const CreatedPullRequestLinkIntent = Schema.Struct({
  threadId: ThreadId,
  commandId: CommandId,
  ...ThreadPullRequestKey.fields,
  url: TrimmedNonEmptyString,
});
export type CreatedPullRequestLinkIntent = typeof CreatedPullRequestLinkIntent.Type;

export class CreatedPullRequestLinkStoreError extends Schema.TaggedError<CreatedPullRequestLinkStoreError>()(
  "CreatedPullRequestLinkStoreError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class CreatedPullRequestLinkStore extends Context.Service<
  CreatedPullRequestLinkStore,
  {
    readonly list: Effect.Effect<
      ReadonlyArray<CreatedPullRequestLinkIntent>,
      CreatedPullRequestLinkStoreError
    >;
    readonly put: (
      intent: CreatedPullRequestLinkIntent,
    ) => Effect.Effect<void, CreatedPullRequestLinkStoreError>;
    readonly remove: (
      intent: CreatedPullRequestLinkIntent,
    ) => Effect.Effect<void, CreatedPullRequestLinkStoreError>;
  }
>()("t3/git/CreatedPullRequestLinkStore") {}

const IntentJson = Schema.fromJsonString(CreatedPullRequestLinkIntent);
const encodeIntent = Schema.encodeEffect(IntentJson);
const decodeIntent = Schema.decodeEffect(IntentJson);
const failure = (operation: string) => (cause: unknown) =>
  Schema.is(CreatedPullRequestLinkStoreError)(cause)
    ? cause
    : new CreatedPullRequestLinkStoreError({
        operation,
        message: "The created pull request link recovery record could not be read or saved.",
        cause,
      });

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return CreatedPullRequestLinkStore.of({
    list: Effect.gen(function* () {
      const rows = yield* sql<{ readonly command_id: string; readonly intent_json: string }>`
        SELECT command_id, intent_json FROM pending_created_pull_request_links ORDER BY command_id
      `;
      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const intent = yield* decodeIntent(row.intent_json);
          if (intent.commandId !== row.command_id) {
            return yield* new CreatedPullRequestLinkStoreError({
              operation: "list",
              message: "A pending pull request link has a mismatched command identity.",
            });
          }
          return intent;
        }),
      );
    }).pipe(Effect.mapError(failure("list"))),
    put: Effect.fn("CreatedPullRequestLinkStore.put")(
      function* (intent: CreatedPullRequestLinkIntent) {
        const json = yield* encodeIntent(intent);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO pending_created_pull_request_links (command_id, intent_json)
              VALUES (${intent.commandId}, ${json})
              ON CONFLICT (command_id) DO NOTHING`;
            const rows = yield* sql<{ readonly intent_json: string }>`
              SELECT intent_json FROM pending_created_pull_request_links
              WHERE command_id = ${intent.commandId}
            `;
            if (rows[0]?.intent_json !== json) {
              return yield* new CreatedPullRequestLinkStoreError({
                operation: "put",
                message: "This link command already belongs to a different pull request or thread.",
              });
            }
          }),
        );
      },
      Effect.mapError(failure("put")),
    ),
    remove: Effect.fn("CreatedPullRequestLinkStore.remove")(
      function* (intent: CreatedPullRequestLinkIntent) {
        const json = yield* encodeIntent(intent);
        // A stale acknowledgement must not discard a different pending identity.
        yield* sql`DELETE FROM pending_created_pull_request_links
          WHERE command_id = ${intent.commandId} AND intent_json = ${json}`;
      },
      Effect.mapError(failure("remove")),
    ),
  });
});

export const layer = Layer.effect(CreatedPullRequestLinkStore, make);

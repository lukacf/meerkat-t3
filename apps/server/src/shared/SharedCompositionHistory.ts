import {
  SharedCompositionHistoryInput,
  SharedCompositionInput,
  SharedCompositionOperation,
  SharedWorkspaceError,
  type SharedCompositionHistory,
  type SharedCompositionHistoryItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SharedActor, SharedWorkspaceStore } from "./SharedWorkspaceStore.ts";

const decodeQuery = Schema.decodeUnknownEffect(SharedCompositionHistoryInput);
const decodeInput = Schema.decodeUnknownEffect(Schema.fromJsonString(SharedCompositionInput));
const decodeOperation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SharedCompositionOperation),
);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const MAX_PAGE_BYTES = 262_144;
const error = (code: SharedWorkspaceError["code"], message: string) =>
  new SharedWorkspaceError({ code, message });

/** Read the composition owner's retained records without advancing or retrying any operation. */
export const makeSharedCompositionHistory = (
  workspace: Pick<SharedWorkspaceStore, "author" | "specialist">,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const read = Effect.fn("SharedCompositionHistory.read")(function* (
      actor: SharedActor,
      raw: SharedCompositionHistoryInput,
    ) {
      // A retained specialist is a workspace fact, but callers must still be current members.
      yield* workspace.author(actor);
      const input = yield* decodeQuery(raw).pipe(
        Effect.mapError(() => error("invalid_input", "Invalid responsibility history query.")),
      );
      yield* workspace.specialist(input.specialistId);
      const cursor = input.cursor?.match(/^composition:([1-9][0-9]{0,18})$/)?.[1];
      if (input.cursor && (!cursor || BigInt(cursor) > 9_223_372_036_854_775_807n))
        return yield* error("invalid_input", "Invalid responsibility history cursor.");
      const limit = input.limit ?? 10;
      // Admission rowids are immutable. New operations do not shift later pages, and
      // retained input finds assignments even after the specialist no longer owns them.
      const rows = yield* sql<{
        cursor: string;
        input_json: string;
        definition_json: string;
      }>`
        SELECT CAST(o.rowid AS TEXT) AS cursor, o.input_json, o.definition_json
        FROM shared_composition_operations o
        WHERE (${cursor ?? null} IS NULL OR o.rowid < CAST(${cursor ?? null} AS INTEGER))
          AND (
            EXISTS (
              SELECT 1 FROM json_each(o.input_json, '$.revisions') revision
              WHERE json_extract(revision.value, '$.specialistId') = ${input.specialistId}
            )
            OR EXISTS (
              SELECT 1 FROM json_each(o.input_json, '$.transitions') transition
              WHERE json_extract(transition.value, '$.predecessorId') = ${input.specialistId}
                OR EXISTS (
                  SELECT 1 FROM json_each(transition.value, '$.successors') successor
                  WHERE json_extract(successor.value, '$.specialistId') = ${input.specialistId}
                )
            )
            OR EXISTS (
              SELECT 1 FROM json_each(o.input_json, '$.peers') peer
              WHERE json_extract(peer.value, '$.source.specialistId') = ${input.specialistId}
                OR json_extract(peer.value, '$.target.specialistId') = ${input.specialistId}
            )
            OR EXISTS (
              SELECT 1 FROM json_each(o.definition_json, '$.creations') creation
              WHERE json_extract(creation.value, '$.specialistId') = ${input.specialistId}
            )
            OR EXISTS (
              SELECT 1 FROM json_each(o.definition_json, '$.lineage') lineage
              WHERE json_extract(lineage.value, '$.predecessorId') = ${input.specialistId}
                OR EXISTS (
                  SELECT 1 FROM json_each(lineage.value, '$.successorIds') successor
                  WHERE successor.value = ${input.specialistId}
                )
            )
          )
        ORDER BY o.rowid DESC LIMIT ${limit + 1}
      `;
      const items: SharedCompositionHistoryItem[] = [];
      let bytes = 0;
      let lastCursor: string | null = null;
      let hasMore = rows.length > limit;
      for (const row of rows.slice(0, limit)) {
        const definition = yield* decodeInput(row.input_json).pipe(
          Effect.mapError(() =>
            error("unavailable", "A retained responsibility change is invalid."),
          ),
        );
        const operation = yield* decodeOperation(row.definition_json).pipe(
          Effect.mapError(() =>
            error("unavailable", "A retained responsibility observation is invalid."),
          ),
        );
        const authorDisplayName = yield* workspace
          .author(
            operation.actor.kind === "participant"
              ? { kind: "participant", participantId: operation.actor.id }
              : { kind: "specialist", specialistId: operation.actor.id },
          )
          .pipe(
            Effect.map((author) => author.displayName),
            Effect.catchTag("SharedWorkspaceError", (cause) =>
              cause.code === "not_joined" || cause.code === "not_found"
                ? Effect.succeed(null)
                : Effect.fail(cause),
            ),
          );
        const item: SharedCompositionHistoryItem = {
          operation,
          authorDisplayName,
          assignments: [
            ...definition.creations.map((creation) => ({
              specialistId:
                operation.creations.find((created) => created.key === creation.key)?.specialistId ??
                null,
              creationKey: creation.key,
              label: creation.label,
              expectedVersion: null,
              assignments: creation.assignments,
            })),
            ...definition.revisions.map((revision) => ({
              specialistId: revision.specialistId,
              creationKey: null,
              label: revision.label ?? null,
              expectedVersion: revision.expectedVersion,
              assignments: revision.assignments,
            })),
          ],
          transitions: definition.transitions,
          peers: definition.peers,
        };
        const size = Buffer.byteLength(encode(item));
        if (bytes + size > MAX_PAGE_BYTES) {
          if (!items.length)
            return yield* error(
              "limit_exceeded",
              "This responsibility record exceeds the history page limit.",
            );
          hasMore = true;
          break;
        }
        bytes += size;
        items.push(item);
        lastCursor = `composition:${row.cursor}`;
      }
      return {
        items,
        nextCursor: hasMore ? lastCursor : null,
        observedAt: DateTime.formatIso(yield* DateTime.now),
      } satisfies SharedCompositionHistory;
    });
    return { read };
  });

import {
  MeerkatConversationSearchError,
  MeerkatConversationSearchInput,
  MeerkatTeamAgent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MeerkatConversationSearchMatch,
  type MeerkatConversationSearchResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";

const PAGE_SIZE = 12;
const Cursor = Schema.fromJsonString(Schema.Struct({ query: Schema.String, after: Schema.String }));
const decodeCursor = Schema.decodeUnknownEffect(Cursor);
const encodeCursor = Schema.encodeSync(Cursor);
const decodeInput = Schema.decodeEffect(MeerkatConversationSearchInput);
const isSearchError = Schema.is(MeerkatConversationSearchError);
const decodeAgent = Schema.decodeUnknownEffect(Schema.fromJsonString(MeerkatTeamAgent));
const Row = Schema.Struct({
  key: Schema.String,
  project_id: ProjectId,
  project_title: Schema.String,
  instance_id: ProviderInstanceId,
  provider_state_root: Schema.String,
  project_path: Schema.String,
  state_root: Schema.NullOr(Schema.String),
  agent_ref: Schema.NullOr(Schema.String),
  agent_json: Schema.NullOr(Schema.String),
  project_agent_id: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  thread_id: Schema.NullOr(ThreadId),
  thread_title: Schema.NullOr(Schema.String),
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

/** Durable identities locate native history. This service neither starts agents nor copies their messages. */
export const makeMeerkatConversationSearch = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const registry = yield* ProviderInstanceRegistry;
  return Effect.fn("MeerkatConversationSearch.search")(function* (
    raw: MeerkatConversationSearchInput,
  ): Effect.fn.Return<MeerkatConversationSearchResult, MeerkatConversationSearchError> {
    return yield* Effect.gen(function* () {
      const input = yield* decodeInput(raw);
      const cursor = input.cursor ? yield* decodeCursor(input.cursor) : undefined;
      if (cursor && cursor.query !== input.query)
        return yield* new MeerkatConversationSearchError({
          message: "Search changed. Start a new search.",
        });
      const rows = yield* sql`
        SELECT * FROM (
          SELECT 'observed:' || o.agent_ref AS key, o.project_id, p.title AS project_title,
            o.instance_id, o.provider_state_root, o.project_path, o.state_root,
            o.agent_ref, o.agent_json, NULL AS project_agent_id, NULL AS label,
            o.thread_id, t.title AS thread_title
          FROM meerkat_observed_agents o
          JOIN projection_projects p ON p.project_id=o.project_id AND p.deleted_at IS NULL
          LEFT JOIN projection_threads t ON t.thread_id=o.thread_id AND t.project_id=o.project_id
          WHERE o.thread_id IS NULL OR (t.deleted_at IS NULL AND t.thread_id IS NOT NULL)
          UNION ALL
          SELECT 'definition:' || d.agent_id AS key, d.project_id, p.title AS project_title,
            d.instance_id, d.provider_state_root, p.workspace_root AS project_path, d.state_root,
            NULL AS agent_ref, NULL AS agent_json, d.agent_id AS project_agent_id, d.label,
            NULL AS thread_id, NULL AS thread_title
          FROM meerkat_project_agents d
          JOIN projection_projects p ON p.project_id=d.project_id AND p.deleted_at IS NULL
          WHERE d.archived=0 AND NOT EXISTS (
            SELECT 1 FROM meerkat_observed_agents o
            WHERE o.project_id=d.project_id AND o.instance_id=d.instance_id
              AND json_extract(o.agent_json,'$.projectAgentId')=d.agent_id
          )
        ) WHERE key > ${cursor?.after ?? ""} ORDER BY key LIMIT ${PAGE_SIZE + 1}
      `.pipe(Effect.flatMap(decodeRows));
      const instances = yield* registry.listInstances;
      const query = input.query.toLocaleLowerCase();
      const results = yield* Effect.forEach(
        rows.slice(0, PAGE_SIZE),
        (row) =>
          Effect.gen(function* () {
            const agent = row.agent_json ? yield* decodeAgent(row.agent_json) : undefined;
            const base: MeerkatConversationSearchMatch = {
              projectId: row.project_id,
              projectTitle: row.project_title,
              instanceId: row.instance_id,
              label: agent?.record.display_name ?? row.label ?? "Agent",
              ...(row.agent_ref ? { agentRef: row.agent_ref } : {}),
              ...(agent?.projectAgentId || row.project_agent_id
                ? { projectAgentId: agent?.projectAgentId ?? row.project_agent_id! }
                : {}),
              ...((agent?.threadId ?? row.thread_id)
                ? { threadId: agent?.threadId ?? row.thread_id! }
                : {}),
              ...(row.thread_title ? { threadTitle: row.thread_title } : {}),
            };
            if (!base.projectAgentId && !base.threadId) return { match: null, unavailable: 0 };
            const nameMatch = [base.label, agent?.record.identity ?? ""].some((name) =>
              name.toLocaleLowerCase().includes(query),
            );
            const instance = instances.find(
              (candidate) =>
                candidate.instanceId === row.instance_id && candidate.driverKind === "meerkat",
            );
            if (!agent?.record.session_id)
              return { match: nameMatch ? base : null, unavailable: 0 };
            if (
              !instance?.enabled ||
              !instance.meerkatTeam?.search ||
              instance.meerkatTeam.stateRoot !== row.provider_state_root
            )
              return { match: nameMatch ? base : null, unavailable: 1 };
            const result = yield* instance.meerkatTeam
              .search({
                projectPath: row.project_path,
                ...(row.state_root ? { stateRoot: row.state_root } : {}),
                mobId: agent.mobId,
                record: agent.record,
                query: input.query,
              })
              .pipe(Effect.result);
            if (result._tag === "Failure")
              return { match: nameMatch ? base : null, unavailable: 1 };
            return {
              match: result.success
                ? { ...base, message: result.success }
                : nameMatch
                  ? base
                  : null,
              unavailable: 0,
            };
          }),
        { concurrency: 2 },
      );
      return {
        matches: results.flatMap((result) => (result.match ? [result.match] : [])),
        scanned: Math.min(rows.length, PAGE_SIZE),
        unavailable: results.reduce((sum, result) => sum + result.unavailable, 0),
        ...(rows.length > PAGE_SIZE
          ? { nextCursor: encodeCursor({ query: input.query, after: rows[PAGE_SIZE - 1]!.key }) }
          : {}),
      };
    }).pipe(
      Effect.mapError((cause) =>
        isSearchError(cause)
          ? cause
          : new MeerkatConversationSearchError({
              message: "Could not search saved agent conversations.",
            }),
      ),
    );
  });
});

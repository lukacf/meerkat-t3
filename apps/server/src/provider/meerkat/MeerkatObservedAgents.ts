import { MeerkatTeamAgent, type ProjectId, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const Row = Schema.Struct({
  agent_ref: Schema.String,
  durable_id: Schema.String,
  provider_state_root: Schema.String,
  project_path: Schema.String,
  state_root: Schema.NullOr(Schema.String),
  agent_json: Schema.String,
  last_seen_at: Schema.String,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
const agentJson = Schema.fromJsonString(MeerkatTeamAgent);
const encodeAgent = Schema.encodeSync(agentJson);
const decodeAgent = Schema.decodeUnknownEffect(agentJson);

/** Discovery index only. Native history and current native status retain authority. */
export const makeMeerkatObservedAgents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const save = Effect.fn("MeerkatObservedAgents.save")(function* (input: {
    projectId: ProjectId;
    instanceId: ProviderInstanceId;
    providerStateRoot: string;
    projectPath: string;
    stateRoot?: string;
    agent: MeerkatTeamAgent;
    observedAt: string;
  }) {
    yield* sql`INSERT INTO meerkat_observed_agents
      (agent_ref,durable_id,project_id,instance_id,provider_state_root,project_path,state_root,thread_id,agent_json,last_seen_at)
      VALUES (${input.agent.agentRef},${input.agent.durableId ?? input.agent.agentRef},${input.projectId},${input.instanceId},
        ${input.providerStateRoot},${input.projectPath},${input.stateRoot ?? null},${input.agent.threadId ?? null},${encodeAgent(input.agent)},${input.observedAt})
      ON CONFLICT(agent_ref) DO UPDATE SET agent_json=excluded.agent_json,last_seen_at=excluded.last_seen_at`;
  });
  const list = Effect.fn("MeerkatObservedAgents.list")(function* (
    projectId: ProjectId,
    instanceId: ProviderInstanceId,
    agentRef?: string,
  ) {
    const rows =
      yield* sql`SELECT o.agent_ref,o.durable_id,o.provider_state_root,o.project_path,o.state_root,o.agent_json,o.last_seen_at
      FROM meerkat_observed_agents o
      WHERE o.project_id=${projectId} AND o.instance_id=${instanceId}
        AND (${agentRef ?? null} IS NULL OR o.agent_ref=${agentRef ?? null})
        AND (o.thread_id IS NULL OR EXISTS (SELECT 1 FROM projection_threads t WHERE t.thread_id=o.thread_id AND t.project_id=o.project_id AND t.deleted_at IS NULL))
      ORDER BY o.last_seen_at DESC, o.rowid DESC`.pipe(Effect.flatMap(decodeRows));
    return yield* Effect.forEach(rows, (row) =>
      decodeAgent(row.agent_json).pipe(Effect.map((agent) => ({ ...row, agent }))),
    );
  });
  return { save, list };
});

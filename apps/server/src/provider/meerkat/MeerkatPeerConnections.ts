import {
  MeerkatPeerEndpoint,
  MeerkatPeerConnectionsInput,
  MeerkatPeerConnectionSetInput,
  MeerkatTeamError,
  type ConsoleIdentityRecord,
  type MeerkatPeerConnection,
  type MeerkatPeerConnections,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { agentFingerprint } from "./MeerkatProjectAgentStore.ts";
import type { MeerkatTeamReader } from "./MeerkatTeamReader.ts";

export interface ResolvedPeerEndpoint {
  readonly reader: MeerkatTeamReader;
  readonly projectPath: string;
  readonly stateRoot: string;
  readonly mobId: string;
  readonly identity: string;
  readonly enabled: boolean;
  readonly record: ConsoleIdentityRecord | null;
  readonly deleted?: boolean;
}
const EndpointJson = Schema.fromJsonString(MeerkatPeerEndpoint);
const encodeEndpoint = Schema.encodeSync(EndpointJson);
const decodeEndpoint = Schema.decodeEffect(EndpointJson);
const decodeConnectionsInput = Schema.decodeEffect(MeerkatPeerConnectionsInput);
const decodeSetInput = Schema.decodeEffect(MeerkatPeerConnectionSetInput);
export const peerEndpointKey = (endpoint: MeerkatPeerEndpoint) =>
  agentFingerprint([
    endpoint.projectId,
    endpoint.instanceId,
    endpoint.kind,
    endpoint.kind === "thread" ? endpoint.threadId : endpoint.agentId,
  ]);
export const peerEdgeId = (a: MeerkatPeerEndpoint, b: MeerkatPeerEndpoint) =>
  agentFingerprint([peerEndpointKey(a), peerEndpointKey(b)].sort());
const Rows = Schema.Array(
  Schema.Struct({
    edge_id: Schema.String,
    source_json: Schema.String,
    target_json: Schema.String,
    provider_state_root: Schema.String,
    desired: Schema.Number,
    request_id: Schema.String,
    last_error: Schema.NullOr(Schema.String),
  }),
);
const Topology = Schema.Struct({
  snapshot: Schema.Struct({
    authority_revisions: Schema.Record(Schema.String, Schema.Number),
    edges: Schema.Array(
      Schema.Struct({
        edge: Schema.Struct({
          a: Schema.Struct({ authority: Schema.String, identity: Schema.String }),
          b: Schema.Struct({ authority: Schema.String, identity: Schema.String }),
        }),
        actual: Schema.Boolean,
        suppressed: Schema.optional(Schema.Boolean),
        desired: Schema.optional(Schema.Boolean),
        operator_added: Schema.optional(Schema.Boolean),
        declared: Schema.optional(Schema.Boolean),
      }),
    ),
  }),
});
const encodeRevisions = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Number)),
);
type Row = (typeof Rows.Type)[number];
export const makeMeerkatPeerConnections = Effect.fn("MeerkatPeers.make")(function* (deps: {
  requireProjectReady: (projectId: ProjectId) => Effect.Effect<void, MeerkatTeamError>;
  resolve: (
    endpoint: MeerkatPeerEndpoint,
    allowDeleted?: boolean,
  ) => Effect.Effect<ResolvedPeerEndpoint, MeerkatTeamError>;
  restore: (endpoint: MeerkatPeerEndpoint) => Effect.Effect<ResolvedPeerEndpoint, MeerkatTeamError>;
  legacyList: (
    endpoint: MeerkatPeerEndpoint,
  ) => Effect.Effect<ReadonlyArray<MeerkatPeerConnection>, MeerkatTeamError>;
  legacySet: (input: MeerkatPeerConnectionSetInput) => Effect.Effect<boolean, MeerkatTeamError>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const fail = (endpoint: MeerkatPeerEndpoint, cause: unknown) =>
    new MeerkatTeamError({
      projectId: endpoint.projectId,
      operation: "agent-connections",
      message: cause instanceof Error ? cause.message : String(cause),
    });
  const rows = (endpoint: MeerkatPeerEndpoint) =>
    sql`SELECT * FROM meerkat_peer_connections WHERE source_key = ${peerEndpointKey(endpoint)} OR target_key = ${peerEndpointKey(endpoint)} ORDER BY updated_at, edge_id`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Rows)),
      Effect.mapError((cause) => fail(endpoint, cause)),
    );
  const observe = Effect.fn("MeerkatPeers.observe")(function* (
    row: Row,
    apply = false,
  ): Effect.fn.Return<MeerkatPeerConnection, MeerkatTeamError> {
    const source = yield* decodeEndpoint(row.source_json).pipe(Effect.orDie);
    const target = yield* decodeEndpoint(row.target_json).pipe(Effect.orDie);
    const base = { edgeId: row.edge_id, source, target, desired: Boolean(row.desired) };
    return yield* Effect.gen(function* (): Effect.fn.Return<
      MeerkatPeerConnection,
      MeerkatTeamError
    > {
      let a = yield* deps.resolve(source, true);
      let b = yield* deps.resolve(target, true);
      if (
        source.instanceId !== target.instanceId ||
        a.reader !== b.reader ||
        a.reader.stateRoot !== row.provider_state_root
      )
        return yield* fail(
          source,
          "Connection provider storage changed. Restore the original provider configuration.",
        );
      const desired = base.desired && !a.deleted && !b.deleted;
      base.desired = desired;
      if (apply && desired) {
        // Saved edges may target another project whose clone has not landed.
        yield* deps.requireProjectReady(source.projectId);
        if (target.projectId !== source.projectId)
          yield* deps.requireProjectReady(target.projectId);
      }
      if (apply && desired && a.enabled && b.enabled) {
        if (!a.record && source.kind === "project-agent") a = yield* deps.restore(source);
        if (!b.record && target.kind === "project-agent") b = yield* deps.restore(target);
      }
      if (apply && (a.deleted || b.deleted))
        yield* sql`UPDATE meerkat_peer_connections SET desired = 0 WHERE edge_id = ${row.edge_id}`.pipe(
          Effect.mapError((cause) => fail(source, cause)),
        );
      if ((!a.enabled && !a.deleted) || (!b.enabled && !b.deleted) || !a.record || !b.record)
        return {
          ...base,
          desired,
          status: !apply && row.last_error && !a.deleted && !b.deleted ? "error" : "unloaded",
          error:
            a.deleted || b.deleted
              ? "A peer was deleted. Native cleanup is pending until its runtime is available."
              : !apply
                ? row.last_error
                : null,
        };
      if (!a.reader.topology || !a.reader.wire)
        return yield* fail(source, "Native topology control is unavailable.");
      const params = {
        sourceProjectPath: a.projectPath,
        sourceExecutionPath: a.projectPath,
        sourceExecutionMode: "local",
        sourceStateRoot: a.stateRoot,
        sourceMobId: a.mobId,
        sourceAgentIdentity: a.identity,
        targetProjectPath: b.projectPath,
        targetExecutionPath: b.projectPath,
        targetExecutionMode: "local",
        targetStateRoot: b.stateRoot,
        targetMobId: b.mobId,
        targetAgentIdentity: b.identity,
      };
      const edge = (snapshot: typeof Topology.Type) =>
        snapshot.snapshot.edges.find(
          (entry) =>
            (entry.edge.a.authority === a.mobId &&
              entry.edge.a.identity === a.identity &&
              entry.edge.b.authority === b.mobId &&
              entry.edge.b.identity === b.identity) ||
            (entry.edge.b.authority === a.mobId &&
              entry.edge.b.identity === a.identity &&
              entry.edge.a.authority === b.mobId &&
              entry.edge.a.identity === b.identity),
        );
      const query = () =>
        a.reader.topology!(params).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Topology)),
          Effect.mapError((cause) => fail(source, cause)),
        );
      let snapshot = yield* query();
      const current = edge(snapshot);
      if (current?.actual && current.suppressed)
        return yield* fail(
          source,
          "Native topology reports a connected edge with contradictory suppression.",
        );
      const nativeDemand = Boolean(
        current && (current.desired || current.operator_added || current.declared),
      );
      const needsRemoval =
        !desired && current && (current.actual || (nativeDemand && !current.suppressed));
      if (apply && (desired ? !current?.actual : needsRemoval)) {
        const reconnect =
          current &&
          (current.suppressed || current.desired || current.operator_added || current.declared);
        yield* a.reader
          .wire(
            {
              ...params,
              expectedRevisions: snapshot.snapshot.authority_revisions,
              ...(desired ? { action: reconnect ? "reconnect" : "connect" } : {}),
              idempotencyKey: agentFingerprint([
                row.edge_id,
                row.request_id,
                String(desired),
                encodeRevisions(snapshot.snapshot.authority_revisions),
              ]),
            },
            desired,
          )
          .pipe(Effect.mapError((cause) => fail(source, cause)));
        snapshot = yield* query();
        if ((edge(snapshot)?.actual ?? false) !== desired)
          return yield* fail(source, "Native peer connection did not reach the requested state.");
      }
      if (a.deleted || b.deleted)
        return {
          ...base,
          desired: false,
          status: edge(snapshot)?.actual ? "connected" : "disconnected",
          error: null,
        };
      if (!apply && row.last_error && (edge(snapshot)?.actual ?? false) !== base.desired)
        return { ...base, status: "error", error: row.last_error };
      return {
        ...base,
        status: edge(snapshot)?.actual ? "connected" : "disconnected",
        error: null,
      };
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed({ ...base, status: "error" as const, error: cause.message }),
      ),
    );
  });
  const list = Effect.fn("MeerkatPeers.list")(function* (
    raw: MeerkatPeerConnectionsInput,
  ): Effect.fn.Return<MeerkatPeerConnections, MeerkatTeamError> {
    const { endpoint } = yield* decodeConnectionsInput(raw).pipe(
      Effect.mapError((cause) => fail(raw.endpoint, cause)),
    );
    yield* deps.resolve(endpoint);
    const saved = yield* rows(endpoint);
    const connections = yield* Effect.forEach(saved, (row) => observe(row));
    return { endpoint, connections: [...connections, ...(yield* deps.legacyList(endpoint))] };
  });
  const set = Effect.fn("MeerkatPeers.set")(function* (
    raw: MeerkatPeerConnectionSetInput,
  ): Effect.fn.Return<MeerkatPeerConnections, MeerkatTeamError> {
    const input = yield* decodeSetInput(raw).pipe(
      Effect.mapError((cause) => fail(raw.source, cause)),
    );
    if (peerEndpointKey(input.source) === peerEndpointKey(input.target))
      return yield* fail(input.source, "Choose two different agents or threads to connect.");
    if (input.source.instanceId !== input.target.instanceId)
      return yield* fail(
        input.source,
        "Peer connections require the same Meerkat provider instance.",
      );
    const previous = (yield* rows(input.source)).find(
      (row) => row.edge_id === peerEdgeId(input.source, input.target),
    );
    const a = yield* deps.resolve(input.source);
    const b = yield* deps.resolve(input.target, !input.connected && Boolean(previous));
    if (input.connected && (!a.enabled || !b.enabled))
      return yield* fail(
        input.source,
        "Restore archived or disconnected endpoints before connecting them.",
      );
    if (a.reader !== b.reader)
      return yield* fail(
        input.source,
        "Peer endpoints do not share the same native runtime authority.",
      );
    if (yield* deps.legacySet(input)) return yield* list({ endpoint: input.source });
    const [source, target] = [input.source, input.target].sort((left, right) =>
      peerEndpointKey(left).localeCompare(peerEndpointKey(right)),
    );
    const edgeId = peerEdgeId(input.source, input.target);
    if (previous && previous.provider_state_root !== a.reader.stateRoot)
      return yield* fail(
        input.source,
        "Connection provider storage changed. Restore the original provider configuration.",
      );
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`INSERT INTO meerkat_peer_connections(edge_id,source_key,target_key,source_json,target_json,provider_state_root,desired,request_id,updated_at)
      VALUES (${edgeId},${peerEndpointKey(source!)},${peerEndpointKey(target!)},${encodeEndpoint(source!)},${encodeEndpoint(target!)},${a.reader.stateRoot},${Number(input.connected)},${input.requestId},${now})
      ON CONFLICT(edge_id) DO UPDATE SET desired=excluded.desired, request_id=excluded.request_id, last_error=NULL, updated_at=excluded.updated_at`.pipe(
      Effect.mapError((cause) => fail(input.source, cause)),
    );
    const row = (yield* rows(input.source)).find((item) => item.edge_id === edgeId)!;
    const applied = yield* observe(row, true);
    yield* sql`UPDATE meerkat_peer_connections SET last_error = ${applied.error} WHERE edge_id = ${edgeId}`.pipe(
      Effect.mapError((cause) => fail(input.source, cause)),
    );
    const result = yield* list({ endpoint: input.source });
    return {
      ...result,
      connections: result.connections.map((connection) =>
        connection.edgeId === edgeId ? applied : connection,
      ),
    };
  });
  const apply = Effect.fn("MeerkatPeers.apply")(function* (endpoint: MeerkatPeerEndpoint) {
    for (const row of yield* rows(endpoint)) {
      const result = yield* observe(row, true);
      yield* sql`UPDATE meerkat_peer_connections SET last_error = ${result.error} WHERE edge_id = ${row.edge_id}`.pipe(
        Effect.mapError((cause) => fail(endpoint, cause)),
      );
      if (result.status === "error") return yield* fail(endpoint, result.error);
    }
  });
  return { list, set, apply };
});

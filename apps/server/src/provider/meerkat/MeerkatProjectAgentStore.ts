// @effect-diagnostics nodeBuiltinImport:off - stable product IDs hash server-owned bindings.
import * as NodeCrypto from "node:crypto";
import {
  MeerkatAgentControlReceipt,
  MeerkatTeamError,
  MeerkatProjectAgentPreparation,
  MeerkatProjectAgentRevision,
  MeerkatProjectAgentAccessMode,
  ProviderOptionSelections,
  type MeerkatProjectAgentCreateInput,
  type ProjectId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const AgentRow = Schema.Struct({
  agent_id: Schema.String,
  project_id: Schema.String,
  instance_id: Schema.String,
  request_id: Schema.String,
  request_fingerprint: Schema.String,
  assignment_json: Schema.NullOr(Schema.String),
  preparation_json: Schema.NullOr(Schema.String),
  pending_revision_json: Schema.NullOr(Schema.String),
  revision_version: Schema.Number,
  label: Schema.String,
  role: Schema.String,
  instructions: Schema.String,
  model: Schema.String,
  options_json: Schema.NullOr(Schema.String),
  access_mode: MeerkatProjectAgentAccessMode,
  provider_state_root: Schema.String,
  state_root: Schema.String,
  mob_id: Schema.String,
  agent_identity: Schema.String,
  enabled: Schema.Number,
  archived: Schema.Number,
  last_error: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
});
export type MeerkatProjectAgentRow = typeof AgentRow.Type;
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(AgentRow));
const encodeTuple = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
export const agentFingerprint = (parts: ReadonlyArray<string>) =>
  NodeCrypto.createHash("sha256").update(encodeTuple(parts)).digest("hex");
const encodeNativeTarget = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const ReceiptJson = Schema.fromJsonString(MeerkatAgentControlReceipt);
const encodeReceipt = Schema.encodeSync(ReceiptJson);
const decodeReceipt = Schema.decodeEffect(ReceiptJson);
const OptionsJson = Schema.fromJsonString(ProviderOptionSelections);
const encodeOptions = Schema.encodeSync(OptionsJson);
const decodeOptions = Schema.decodeEffect(OptionsJson);
const decodeOptionsSync = Schema.decodeSync(OptionsJson);
export const storedModelOptions = (row: MeerkatProjectAgentRow) =>
  row.options_json === null ? undefined : decodeOptionsSync(row.options_json);
const canonicalOptionsJson = (options: ProviderOptionSelections | undefined) => {
  if (options === undefined) return null;
  const ids = new Set<string>();
  for (const { id } of options) {
    if (ids.has(id)) throw new Error("Choose each model option only once.");
    ids.add(id);
  }
  return encodeOptions(
    [...options].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
  );
};

export const MeerkatProjectAgentAssignment = Schema.Struct({
  sourceThreadId: Schema.String,
  proposalId: Schema.String,
  candidateId: Schema.String,
  focus: Schema.String,
  charter: Schema.String,
  ownershipPaths: Schema.Array(Schema.String),
  assignmentId: Schema.String,
  fingerprint: Schema.String,
});
export type MeerkatProjectAgentAssignment = typeof MeerkatProjectAgentAssignment.Type;
const AssignmentJson = Schema.fromJsonString(MeerkatProjectAgentAssignment);
const PreparationJson = Schema.fromJsonString(MeerkatProjectAgentPreparation);
const PendingRevision = Schema.Struct({
  ...MeerkatProjectAgentRevision.fields,
  assignment: MeerkatProjectAgentAssignment,
});
const RevisionJson = Schema.fromJsonString(PendingRevision);
export const decodeAgentRevision = Schema.decodeEffect(RevisionJson);
const encodeRevision = Schema.encodeSync(RevisionJson);
export type PendingAgentRevision = typeof PendingRevision.Type;
const encodeAssignment = Schema.encodeSync(AssignmentJson);
const decodeAssignmentSync = Schema.decodeSync(AssignmentJson);
export const specialistRuntimeInstructions = (
  instructions: string,
  assignment?: MeerkatProjectAgentAssignment | null,
  accessMode?: MeerkatProjectAgentAccessMode,
) =>
  [
    instructions,
    assignment
      ? `Current project responsibility (supersedes older assignment text):\nFocus: ${assignment.focus}\nCharter: ${assignment.charter}\nOwned paths: ${assignment.ownershipPaths.join(", ")}`
      : "",
    accessMode === "repository-read-only"
      ? "You are a persistent shared specialist serving independent work contexts. At the start of each native turn, inspect one bounded shared_workspace inbox.list batch for relevant retained updates. This is a tool pull during this turn, not permission to create a timer or schedule. Use shared_workspace repository tools with the evidence's sharedProjectId and full commit to inspect relevant sources. Never substitute another request's branch, the host checkout, or the latest conversation output. A retained patch is unapplied snapshot evidence, not a materialized checkout. Cite the repository, revision and paths your findings concern. For request-bound activity and knowledge writes, use the exact contextId and contextVersion supplied with this interaction. Peer messages and inbox observations do not grant another caller's task attribution. Use activity.publish_from_inbox or knowledge.record_from_inbox with an exact sealed batch/event source to publish your own relevant observation; the host retains its independent context and original source revision. Keep each response bound to its original request. Acknowledge an inbox batch only after processing it; acknowledgement records product awareness and does not complete native work. Responsibility changes affect future routing; finish already-admitted work under its original binding. Inspect capabilities before requesting composition; do not assume that retirement or in-flight handover is supported."
      : accessMode === "read-and-collaborate"
        ? "Repository knowledge is a dated snapshot. Before answering a new task or peer request, use workspace_read_file, workspace_list_files and workspace_search to inspect the relevant current files within your responsibilities. Update outdated assumptions and cite current evidence. You can exchange messages with connected peers and return findings or implementation guidance to the requesting task. Commands, file changes, browser control and external tools are unavailable."
        : "Repository knowledge is a dated snapshot. Before answering a new task or peer request, inspect the relevant current working files and diffs within your responsibilities. Update outdated assumptions and cite current evidence. Do not change files unless explicitly tasked.",
  ]
    .filter(Boolean)
    .join("\n\n");
export const storedRuntimeInstructions = (row: MeerkatProjectAgentRow) =>
  specialistRuntimeInstructions(
    row.instructions,
    row.assignment_json ? decodeAssignmentSync(row.assignment_json) : null,
    row.access_mode,
  );
const encodePreparation = Schema.encodeSync(PreparationJson);
export const decodeAgentAssignment = Schema.decodeEffect(AssignmentJson);
export const decodeAgentPreparation = Schema.decodeEffect(PreparationJson);
export const agentMetadata = (row: MeerkatProjectAgentRow) =>
  Effect.gen(function* () {
    const assignment = row.assignment_json
      ? yield* decodeAgentAssignment(row.assignment_json)
      : null;
    const preparation = row.preparation_json
      ? yield* decodeAgentPreparation(row.preparation_json)
      : null;
    return {
      ...(row.options_json === null ? {} : { options: yield* decodeOptions(row.options_json) }),
      ...(assignment
        ? {
            focus: assignment.focus,
            charter: assignment.charter,
            ownershipPaths: assignment.ownershipPaths,
          }
        : {}),
      preparation,
      revisionVersion: row.revision_version,
      pendingRevision: row.pending_revision_json
        ? yield* decodeAgentRevision(row.pending_revision_json)
        : null,
    };
  });

/** Desired product config and delivery claims. Runtime state is always observed separately. */
export const makeMeerkatProjectAgentStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;
  const failure = (projectId: ProjectId, cause: unknown) =>
    new MeerkatTeamError({
      projectId,
      operation: "project-agent",
      message: cause instanceof Error ? cause.message : String(cause),
    });
  const list = Effect.fn("MeerkatProjectAgents.list")(function* (projectId: ProjectId) {
    return yield* sql`SELECT * FROM meerkat_project_agents WHERE project_id = ${projectId}
      ORDER BY created_at, agent_id`.pipe(
      Effect.flatMap(decodeRows),
      Effect.mapError((cause) => failure(projectId, cause)),
    );
  });
  const get = Effect.fn("MeerkatProjectAgents.get")(function* (
    projectId: ProjectId,
    agentId: string,
  ) {
    const rows = yield* sql`SELECT * FROM meerkat_project_agents
      WHERE project_id = ${projectId} AND agent_id = ${agentId}`.pipe(
      Effect.flatMap(decodeRows),
      Effect.mapError((cause) => failure(projectId, cause)),
    );
    if (!rows[0]) return yield* failure(projectId, "Project agent not found.");
    return rows[0];
  });
  const create = Effect.fn("MeerkatProjectAgents.create")(function* (
    input: MeerkatProjectAgentCreateInput,
    providerStateRoot: string,
  ) {
    const agentId = `agent-${agentFingerprint([input.projectId, input.instanceId, input.requestId])}`;
    const previous =
      input.accessMode === undefined
        ? yield* sql`SELECT * FROM meerkat_project_agents WHERE agent_id = ${agentId}`.pipe(
            Effect.flatMap(decodeRows),
            Effect.mapError((cause) => failure(input.projectId, cause)),
          )
        : [];
    // A retry from an older client keeps the existing policy. Only genuinely new agents default.
    const accessMode = input.accessMode ?? previous[0]?.access_mode ?? "read-only";
    const optionsJson = yield* Effect.try({
      try: () => canonicalOptionsJson(input.options),
      catch: (cause) => failure(input.projectId, cause),
    });
    const fingerprint = agentFingerprint([
      input.label,
      input.role,
      input.instructions,
      input.model,
      // Full access keeps the original fingerprint for retries of legacy creation requests.
      ...(accessMode === "full-access" ? [] : [accessMode]),
      // Absence retains the exact fingerprint used before model options were supported.
      ...(optionsJson === null ? [] : ["options", optionsJson]),
    ]);
    const stateRoot = path.join(
      providerStateRoot,
      "project-agents",
      agentFingerprint([input.projectId]),
      agentId,
    );
    const now = DateTime.formatIso(yield* DateTime.now);
    const inserted = yield* sql`INSERT INTO meerkat_project_agents
      (agent_id, project_id, instance_id, request_id, request_fingerprint, label, role, instructions, model, options_json, access_mode,
        provider_state_root, state_root, mob_id, agent_identity, enabled, archived, created_at, updated_at)
      VALUES (${agentId},${input.projectId},${input.instanceId},${input.requestId},${fingerprint},
        ${input.label},${input.role},${input.instructions},${input.model},${optionsJson},${accessMode},${providerStateRoot},${stateRoot},
        ${`t3-domain-${agentId}`},${input.role},1,0,${now},${now})
      ON CONFLICT(project_id,instance_id,request_id) DO NOTHING RETURNING agent_id
    `.pipe(Effect.mapError((cause) => failure(input.projectId, cause)));
    const row = yield* get(input.projectId, agentId);
    if (row.request_fingerprint !== fingerprint)
      return yield* failure(
        input.projectId,
        "This creation request ID was already used with different agent settings.",
      );
    if (row.provider_state_root !== providerStateRoot)
      return yield* failure(
        input.projectId,
        "Provider storage changed. Restore the original provider configuration to access this agent.",
      );
    return { row, created: inserted.length > 0 };
  });
  const update = Effect.fn("MeerkatProjectAgents.update")(function* (
    projectId: ProjectId,
    agentId: string,
    patch: { label?: string; enabled?: boolean; archived?: boolean; error?: string | null },
  ) {
    const current = yield* get(projectId, agentId);
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`UPDATE meerkat_project_agents SET label = ${patch.label ?? current.label},
      enabled = ${patch.enabled === undefined ? current.enabled : Number(patch.enabled)},
      archived = ${patch.archived === undefined ? current.archived : Number(patch.archived)},
      last_error = ${patch.error === undefined ? current.last_error : patch.error}, updated_at = ${now}
      WHERE project_id = ${projectId} AND agent_id = ${agentId}`.pipe(
      Effect.mapError((cause) => failure(projectId, cause)),
    );
    return yield* get(projectId, agentId);
  });
  const claimDelivery = Effect.fn("MeerkatProjectAgents.claimDelivery")(function* (
    projectId: ProjectId,
    instanceId: ProviderInstanceId,
    requestId: string,
    fingerprint: string,
    stableFingerprint: string,
    nativeTarget?: unknown,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const pending: MeerkatAgentControlReceipt = {
      status: "uncertain",
      requestId,
      receipt: null,
      message: "Delivery was claimed. Observe native activity before sending again.",
    };
    const targetJson = nativeTarget === undefined ? null : encodeNativeTarget(nativeTarget);
    const inserted = yield* sql`INSERT INTO meerkat_agent_delivery_receipts
      (project_id,instance_id,request_id,fingerprint,stable_fingerprint,receipt_json,created_at,native_target_json)
      VALUES (${projectId},${instanceId},${requestId},${fingerprint},${stableFingerprint},${encodeReceipt(pending)},${now},${targetJson})
      ON CONFLICT(project_id,instance_id,request_id) DO NOTHING RETURNING request_id
    `.pipe(Effect.mapError((cause) => failure(projectId, cause)));
    const rows =
      yield* sql`SELECT fingerprint,stable_fingerprint,receipt_json,native_target_json FROM meerkat_agent_delivery_receipts
      WHERE project_id = ${projectId} AND instance_id = ${instanceId} AND request_id = ${requestId}
    `.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({
                fingerprint: Schema.String,
                stable_fingerprint: Schema.NullOr(Schema.String),
                receipt_json: Schema.String,
                native_target_json: Schema.NullOr(Schema.String),
              }),
            ),
          ),
        ),
        Effect.mapError((cause) => failure(projectId, cause)),
      );
    const row = rows[0];
    if (!row || (row.fingerprint !== fingerprint && row.stable_fingerprint !== stableFingerprint))
      return yield* failure(
        projectId,
        row?.stable_fingerprint === null
          ? "This delivery request belongs to an earlier agent session whose identity cannot be verified. Delivery remains unresolved and was not replayed."
          : "This delivery request ID was already used with different content or target.",
      );
    if (row.stable_fingerprint === null)
      yield* sql`UPDATE meerkat_agent_delivery_receipts SET stable_fingerprint = ${stableFingerprint}
        WHERE project_id = ${projectId} AND instance_id = ${instanceId} AND request_id = ${requestId}
          AND fingerprint = ${fingerprint} AND stable_fingerprint IS NULL`.pipe(
        Effect.mapError((cause) => failure(projectId, cause)),
      );
    const receipt = yield* decodeReceipt(row.receipt_json).pipe(
      Effect.mapError((cause) => failure(projectId, cause)),
    );
    return {
      claimed: inserted.length > 0,
      nativeTarget: row.native_target_json,
      receipt:
        row.fingerprint === fingerprint
          ? receipt
          : {
              ...receipt,
              message:
                receipt.status === "accepted"
                  ? "This message was accepted by the previous agent session. It was not sent to the current session."
                  : "Delivery to the previous agent session remains uncertain. It was not sent to the current session. Check that session's activity before submitting new work.",
            },
    };
  });
  const delivery = Effect.fn("MeerkatProjectAgents.delivery")(function* (
    projectId: ProjectId,
    instanceId: ProviderInstanceId,
    requestId: string,
  ) {
    const rows =
      yield* sql`SELECT fingerprint,receipt_json,native_target_json FROM meerkat_agent_delivery_receipts
      WHERE project_id=${projectId} AND instance_id=${instanceId} AND request_id=${requestId}`.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({
                fingerprint: Schema.String,
                receipt_json: Schema.String,
                native_target_json: Schema.NullOr(Schema.String),
              }),
            ),
          ),
        ),
        Effect.mapError((cause) => failure(projectId, cause)),
      );
    const row = rows[0];
    if (!row) return undefined;
    const receipt = yield* decodeReceipt(row.receipt_json).pipe(
      Effect.mapError((cause) => failure(projectId, cause)),
    );
    return { fingerprint: row.fingerprint, nativeTarget: row.native_target_json, receipt };
  });
  const saveReceipt = Effect.fn("MeerkatProjectAgents.saveReceipt")(function* (
    projectId: ProjectId,
    instanceId: ProviderInstanceId,
    requestId: string,
    receipt: MeerkatAgentControlReceipt,
  ) {
    yield* sql`UPDATE meerkat_agent_delivery_receipts SET receipt_json = ${encodeReceipt(receipt)}
      WHERE project_id = ${projectId} AND instance_id = ${instanceId} AND request_id = ${requestId}`.pipe(
      Effect.mapError((cause) => failure(projectId, cause)),
    );
    return receipt;
  });
  const saveAssignment = (
    projectId: ProjectId,
    agentId: string,
    assignment: MeerkatProjectAgentAssignment,
  ) =>
    sql`
    UPDATE meerkat_project_agents SET assignment_json = ${encodeAssignment(assignment)}
    WHERE project_id = ${projectId} AND agent_id = ${agentId}`.pipe(
      Effect.mapError((cause) => failure(projectId, cause)),
    );
  const savePreparation = (
    projectId: ProjectId,
    agentId: string,
    preparation: MeerkatProjectAgentPreparation,
  ) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO meerkat_project_agent_studies(agent_id,request_id,preparation_json)
      VALUES (${agentId},${preparation.requestId},${encodePreparation(preparation)})
      ON CONFLICT(agent_id,request_id) DO UPDATE SET preparation_json=excluded.preparation_json
      WHERE json_extract(meerkat_project_agent_studies.preparation_json,'$.status') NOT IN ('ready','failed','interrupted')
        OR ${preparation.status} IN ('ready','failed','interrupted')`;
      yield* sql`
    UPDATE meerkat_project_agents SET preparation_json = ${encodePreparation(preparation)}, updated_at = ${preparation.updatedAt}
    WHERE project_id = ${projectId} AND agent_id = ${agentId}
    AND revision_version = ${preparation.revisionVersion ?? 1}
    AND (assignment_json IS NULL OR json_extract(assignment_json,'$.fingerprint')=${preparation.fingerprint})
    AND (preparation_json IS NULL OR json_extract(preparation_json, '$.attempt') < ${preparation.attempt}
      OR (json_extract(preparation_json, '$.attempt') = ${preparation.attempt}
        AND json_extract(preparation_json, '$.requestId') = ${preparation.requestId}
        AND (json_extract(preparation_json, '$.status') NOT IN ('ready','failed','interrupted')
          OR ${preparation.status} IN ('ready','failed','interrupted'))))`.pipe(
        Effect.mapError((cause) => failure(projectId, cause)),
      );
    }).pipe(
      sql.withTransaction,
      Effect.mapError((cause) => failure(projectId, cause)),
    );
  const nextStudyAttempt = (projectId: ProjectId, agentId: string) =>
    sql`SELECT COALESCE(MAX(json_extract(preparation_json,'$.attempt')),0)+1 AS attempt
      FROM meerkat_project_agent_studies WHERE agent_id=${agentId}`.pipe(
      Effect.map((rows) => Number(rows[0]?.attempt ?? 1)),
      Effect.mapError((cause) => failure(projectId, cause)),
    );
  const saveRevision = (projectId: ProjectId, agentId: string, revision: PendingAgentRevision) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`UPDATE meerkat_project_agents SET pending_revision_json=${encodeRevision(revision)},updated_at=${now}
      WHERE project_id=${projectId} AND agent_id=${agentId}`.pipe(
        Effect.mapError((cause) => failure(projectId, cause)),
      );
    });
  const applyRevision = Effect.fn("MeerkatProjectAgents.applyRevision")(function* (
    projectId: ProjectId,
    agentId: string,
    revision: PendingAgentRevision,
  ) {
    const row = yield* get(projectId, agentId);
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`INSERT INTO meerkat_project_agent_revisions
      (agent_id,revision_id,version,instructions,assignment_json,preparation_json,created_at,applied_at)
      VALUES (${agentId},${`version:${row.revision_version}`},${row.revision_version},${row.instructions},${row.assignment_json},${row.preparation_json},${row.created_at},${row.updated_at})
      ON CONFLICT DO NOTHING`;
    yield* sql`UPDATE meerkat_project_agent_revisions SET preparation_json=${row.preparation_json}
      WHERE agent_id=${agentId} AND version=${row.revision_version}`;
    yield* sql`INSERT INTO meerkat_project_agent_revisions
      (agent_id,revision_id,version,instructions,assignment_json,created_at,applied_at)
      VALUES (${agentId},${revision.revisionId},${revision.version},${revision.instructions},${encodeAssignment(revision.assignment)},${revision.createdAt},${now})
      ON CONFLICT DO NOTHING`;
    yield* sql`UPDATE meerkat_project_agents SET instructions=${revision.instructions},
      assignment_json=${encodeAssignment(revision.assignment)},preparation_json=NULL,
      revision_version=${revision.version},pending_revision_json=NULL,updated_at=${now}
      WHERE project_id=${projectId} AND agent_id=${agentId}`;
    return yield* get(projectId, agentId);
  }, sql.withTransaction);
  return {
    list,
    get,
    create,
    update,
    claimDelivery,
    delivery,
    saveReceipt,
    saveAssignment,
    savePreparation,
    saveRevision,
    applyRevision,
    nextStudyAttempt,
  };
});

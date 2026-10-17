// @effect-diagnostics nodeBuiltinImport:off - opaque durable IDs and content fingerprints.
import * as NodeCrypto from "node:crypto";
import * as Config from "effect/Config";
import {
  AuthSharedContributeScope,
  AuthSharedReadScope,
  SharedActivity,
  SharedActivityFromInboxInput,
  SharedActivityPublishInput,
  SharedCheckout,
  SharedCheckoutAttachInput,
  SharedInbox,
  SharedInboxAcknowledgeInput,
  SharedInboxReadInput,
  SharedKnowledge,
  SharedKnowledgeFromInboxInput,
  SharedNativeTarget,
  SharedKnowledgePutInput,
  SharedKnowledgeSearchInput,
  SharedParticipant,
  SharedProject,
  SharedProjectRegisterInput,
  SharedSnapshot,
  SharedSnapshotPutInput,
  SharedSpecialist,
  SharedSpecialistRegisterInput,
  SharedWorkContext,
  SharedWorkContextInput,
  SharedWorkspace,
  SharedWorkspaceConfigureInput,
  SharedWorkspaceError,
  SharedWorkspaceJoinInput,
  SharedDirectoryListInput,
  type SharedProjectPage,
  type SharedProjectSummary,
  type SharedSpecialistPage,
  type SharedSpecialistSummary,
  type SharedRevision,
  type SharedWorkspaceSnapshot,
  type SharedWorkspaceCapacity,
  type SharedKnowledgeSearchResult,
  type SharedKnowledgeSearchHit,
  type SharedCompositionInput,
  type SharedCompositionOperation,
  type SharedDelegationAction,
  type EnvironmentId,
  type SharedSource,
} from "@t3tools/contracts";
import { canonicalSharedRepository } from "@t3tools/shared/sharedRepository";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeSharedDelegationAuthority } from "./SharedDelegationAuthority.ts";

/** Constructed only after the transport or native-tool boundary authenticates its caller. */
export type SharedActor =
  | { readonly kind: "participant"; readonly participantId: string }
  | {
      readonly kind: "local_agent";
      readonly delegationId: string;
      readonly sessionId: string;
      readonly action: SharedDelegationAction;
    }
  | {
      readonly kind: "specialist";
      readonly specialistId: string;
      /** Set only by exact native request correlation, not by an action argument. */
      readonly context?: Pick<
        SharedWorkContext,
        "contextId" | "contextVersion" | "sharedProjectId"
      >;
    };

const fail = (code: SharedWorkspaceError["code"], message: string) =>
  new SharedWorkspaceError({ code, message });
const isWorkspaceError = Schema.is(SharedWorkspaceError);
const storageError = (cause: unknown) =>
  isWorkspaceError(cause) ? cause : fail("unavailable", "Shared workspace storage is unavailable.");
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const MAX_DIRECTORY_RECORD_BYTES = 128 * 1024;
const MAX_DIRECTORY_PAGE_BYTES = 192 * 1024;
const directoryRecord = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Effect.gen(function* () {
    const record = yield* validate(schema, value);
    if (Buffer.byteLength(encode(record)) > MAX_DIRECTORY_RECORD_BYTES)
      return yield* fail(
        "limit_exceeded",
        "This directory definition exceeds 128 KiB. Shorten its descriptions, paths or aliases.",
      );
    return record;
  });
const directoryPage = <A>(values: ReadonlyArray<A>, limit: number, key: (value: A) => string) => {
  const items: A[] = [];
  for (const value of values) {
    if (
      items.length >= limit ||
      Buffer.byteLength(encode({ items: [...items, value], nextCursor: key(value) })) >
        MAX_DIRECTORY_PAGE_BYTES
    )
      break;
    items.push(value);
  }
  return {
    items,
    nextCursor: values.length > items.length && items.length ? key(items[items.length - 1]!) : null,
  };
};
const MAX_EVIDENCE_BYTES = 128 * 1024;
const MAX_PAGE_BYTES = 192 * 1024;
// Operator limits are read once at service startup. Native sessions and request
// receipts are outside evidence admission and can still finish at full capacity.
const PositiveCapacity = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const SharedEvidenceConfig = Config.all({
  maxBytes: Config.schema(PositiveCapacity, "T3CODE_SHARED_EVIDENCE_MAX_BYTES").pipe(
    Config.withDefault(256 * 1024 * 1024),
  ),
  maxRecords: Config.schema(PositiveCapacity, "T3CODE_SHARED_EVIDENCE_MAX_RECORDS").pipe(
    Config.withDefault(100_000),
  ),
  maxPending: Config.schema(PositiveCapacity, "T3CODE_SHARED_INBOX_MAX_PENDING").pipe(
    Config.withDefault(20_000),
  ),
});
const encodedBytes = (value: unknown) => Buffer.byteLength(encode(value), "utf8");
const boundedRecord = (value: unknown, label: string, reserveBytes = 0) =>
  encodedBytes(value) + reserveBytes > MAX_EVIDENCE_BYTES
    ? Effect.fail(
        fail(
          "limit_exceeded",
          `${label} exceeds the 128 KiB encoded evidence limit. Shorten the content, context or source list before publishing.`,
        ),
      )
    : Effect.void;
const boundedPage = (value: unknown) =>
  encodedBytes(value) > MAX_PAGE_BYTES
    ? Effect.fail(
        fail(
          "limit_exceeded",
          "This retained page exceeds the encoded response limit. Its contents have not been changed or acknowledged.",
        ),
      )
    : Effect.void;
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${encode(k)}:${stable(v)}`)
      .join(",")}}`;
  return encode(value);
};
export const sharedFingerprint = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(stable(value)).digest("hex");
const id = (prefix: string) => `${prefix}-${NodeCrypto.randomUUID()}`;
const validate = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => fail("invalid_input", "Invalid shared workspace request.")),
  );
const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(value).pipe(
    Effect.mapError(() => fail("unavailable", "A shared workspace record could not be read.")),
  );
const repositoryKey = (value: string) =>
  Effect.try({
    try: () => canonicalSharedRepository(value),
    catch: (cause) =>
      fail(
        "invalid_input",
        cause instanceof Error ? cause.message : "Invalid repository identity.",
      ),
  });
const validatePaths = (paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (
      paths.some(
        (path) =>
          !path ||
          path.startsWith("/") ||
          path.includes("\\") ||
          path.split("/").some((segment) => segment === ".." || segment === ".") ||
          // eslint-disable-next-line no-control-regex -- paths must reject control characters.
          /[\u0000-\u001f]/.test(path),
      )
    )
      return yield* fail(
        "invalid_input",
        "Affected paths must be repository-relative paths without traversal.",
      );
  });
const pathAncestors = (paths: ReadonlyArray<string>) => [
  ...new Set(
    paths.flatMap((path) => {
      const parts = path.replace(/\/$/, "").split("/");
      return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
    }),
  ),
];
/** The same literal interest projection is used for human contexts and captured task grants. */
export const sharedInterestEntries = (interest: {
  readonly paths: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
}): Array<readonly [string, string]> => [
  ...[...new Set(interest.paths.map((path) => path.replace(/\/$/, "")))].map(
    (value) => ["path", value] as const,
  ),
  ...[...new Set(interest.tags)].map((value) => ["tag", value] as const),
  ...(interest.paths.length || interest.tags.length ? [] : [["all", ""] as const]),
];

/**
 * Product observations and assignments only. Native existence, delivery and
 * completion are deliberately absent. Every external effect belongs in a service
 * outside these transactions, with its native reference retained separately.
 */
export const makeSharedWorkspaceStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const evidenceLimits = yield* SharedEvidenceConfig;
  const { requireSharedDelegation } = yield* makeSharedDelegationAuthority;
  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql.withTransaction(effect).pipe(Effect.mapError(storageError));
  const specialistCapacity = Effect.gen(function* () {
    const rows = yield* sql<{ total: number }>`SELECT
      (SELECT COUNT(*) FROM shared_specialists) +
      (SELECT COUNT(*) FROM shared_composition_creations WHERE specialist_id IS NULL) AS total`;
    return rows[0]?.total ?? 0;
  });
  const evidenceUsage = Effect.gen(function* () {
    const rows = yield* sql<{
      bytes: number;
      records: number;
      pending_inbox: number;
    }>`SELECT bytes, records, pending_inbox FROM shared_evidence_usage WHERE singleton = 1`;
    if (!rows[0]) return yield* fail("unavailable", "Shared evidence accounting is unavailable.");
    return rows[0];
  });
  // Check after staging the product rows, inside their transaction. A refusal
  // rolls back the entire publication, including correction indexes and fan-out.
  // Existing-ID returns and read/ack operations deliberately bypass admission.
  const requireEvidenceCapacity = Effect.fn("SharedWorkspace.requireEvidenceCapacity")(function* (
    newInboxDeliveries = 0,
  ) {
    const used = yield* evidenceUsage;
    if (newInboxDeliveries && used.pending_inbox > evidenceLimits.maxPending)
      return yield* fail(
        "limit_exceeded",
        `The shared inbox backlog would reach ${used.pending_inbox} deliveries (limit ${evidenceLimits.maxPending}). Ask recipients to fetch and acknowledge their pending briefings, then retry this publication. Nothing from this publication was saved.`,
      );
    if (used.bytes > evidenceLimits.maxBytes || used.records > evidenceLimits.maxRecords)
      return yield* fail(
        "limit_exceeded",
        `The shared evidence budget would reach ${used.bytes} bytes and ${used.records} records (limits ${evidenceLimits.maxBytes} bytes and ${evidenceLimits.maxRecords} records). Nothing from this publication was saved. Existing requests, evidence and inbox acknowledgements remain available. Ask the host administrator to back up this profile, check free disk space and raise its server evidence limits before retrying. Acknowledging briefings does not erase retained evidence.`,
      );
  });
  const putInterests = Effect.fn("SharedWorkspace.putInterests")(function* (
    ownerId: string,
    projectId: string,
    recipientId: string,
    interest: { readonly paths: ReadonlyArray<string>; readonly tags: ReadonlyArray<string> },
  ) {
    yield* sql`DELETE FROM shared_interests WHERE owner_id = ${ownerId} AND project_id = ${projectId}`;
    for (const [dimension, value] of sharedInterestEntries(interest))
      yield* sql`INSERT INTO shared_interests(owner_id, project_id, recipient_id, dimension, value)
        VALUES (${ownerId}, ${projectId}, ${recipientId}, ${dimension}, ${value})`;
  });
  const workspace = Effect.gen(function* () {
    const rows = yield* sql<{
      definition_json: string;
    }>`SELECT definition_json FROM shared_workspace WHERE singleton = 1`;
    return rows[0] ? yield* decode(SharedWorkspace, rows[0].definition_json) : null;
  }).pipe(Effect.mapError(storageError));
  const requireWorkspace = workspace.pipe(
    Effect.flatMap((value) =>
      value
        ? Effect.succeed(value)
        : Effect.fail(fail("not_configured", "This environment has no shared workspace.")),
    ),
  );
  const configure = Effect.fn("SharedWorkspace.configure")(function* (
    raw: SharedWorkspaceConfigureInput,
  ) {
    const input = yield* validate(SharedWorkspaceConfigureInput, raw);
    return yield* transaction(
      Effect.gen(function* () {
        const previous = yield* workspace;
        const value: SharedWorkspace = {
          workspaceId: previous?.workspaceId ?? id("workspace"),
          name: input.name,
          limits: input.limits ??
            previous?.limits ?? { maxSpecialists: 24, maxSnapshotBytes: 1_048_576 },
          createdAt: previous?.createdAt ?? (yield* now),
        };
        if ((yield* specialistCapacity) > value.limits.maxSpecialists)
          return yield* fail(
            "limit_exceeded",
            "The specialist limit cannot be lower than existing specialists and reserved creations, including superseded predecessors.",
          );
        yield* sql`INSERT INTO shared_workspace(singleton, definition_json) VALUES (1, ${encode(value)})
        ON CONFLICT(singleton) DO UPDATE SET definition_json = excluded.definition_json`;
        return value;
      }),
    );
  });
  const participant = Effect.fn("SharedWorkspace.participant")(function* (sessionId: string) {
    const rows = yield* sql<{
      definition_json: string;
    }>`SELECT p.definition_json FROM shared_participants p
      JOIN shared_participant_sessions s ON s.participant_id = p.participant_id WHERE s.session_id = ${sessionId}`;
    return rows[0] ? yield* decode(SharedParticipant, rows[0].definition_json) : null;
  });
  const requireParticipant = Effect.fn("SharedWorkspace.requireParticipant")(function* (
    sessionId: string,
  ) {
    const value = yield* participant(sessionId);
    if (!value) return yield* fail("not_joined", "Join the shared workspace before contributing.");
    return value;
  });
  const join = Effect.fn("SharedWorkspace.join")(function* (
    sessionId: string,
    raw: SharedWorkspaceJoinInput,
  ) {
    const input = yield* validate(SharedWorkspaceJoinInput, raw);
    return yield* transaction(
      Effect.gen(function* () {
        yield* requireWorkspace;
        const previous = yield* participant(sessionId);
        const value: SharedParticipant = {
          participantId: previous?.participantId ?? id("participant"),
          kind: "person",
          displayName: input.displayName,
          createdAt: previous?.createdAt ?? (yield* now),
        };
        yield* sql`INSERT INTO shared_participants(participant_id, definition_json)
        VALUES (${value.participantId}, ${encode(value)})
        ON CONFLICT(participant_id) DO UPDATE SET definition_json = excluded.definition_json`;
        yield* sql`INSERT INTO shared_participant_sessions(session_id, participant_id)
        VALUES (${sessionId}, ${value.participantId}) ON CONFLICT(session_id) DO NOTHING`;
        return value;
      }),
    );
  });
  const project = Effect.fn("SharedWorkspace.project")(function* (projectId: string) {
    const rows = yield* sql<{
      definition_json: string;
    }>`SELECT definition_json FROM shared_projects WHERE project_id = ${projectId}`;
    if (!rows[0]) return yield* fail("not_found", "Shared project not found.");
    return yield* directoryRecord(
      SharedProject,
      yield* decode(SharedProject, rows[0].definition_json),
    );
  }, Effect.mapError(storageError));
  const registerProject = Effect.fn("SharedWorkspace.registerProject")(function* (
    raw: SharedProjectRegisterInput,
  ) {
    const input = yield* validate(SharedProjectRegisterInput, raw);
    const repository = yield* repositoryKey(input.repository);
    const aliases = [...new Set(yield* Effect.forEach(input.aliases ?? [], repositoryKey))]
      .filter((key) => key !== repository)
      .sort();
    const fingerprint = sharedFingerprint({ ...input, repository, aliases });
    return yield* transaction(
      Effect.gen(function* () {
        yield* requireWorkspace;
        const old = yield* sql<{
          fingerprint: string;
          definition_json: string;
        }>`SELECT fingerprint, definition_json FROM shared_projects WHERE request_id = ${input.requestId}`;
        if (old[0]) {
          if (old[0].fingerprint !== fingerprint)
            return yield* fail(
              "conflict",
              "This project request ID already has different contents.",
            );
          return yield* decode(SharedProject, old[0].definition_json);
        }
        for (const key of [repository, ...aliases]) {
          const used =
            yield* sql`SELECT project_id FROM shared_repository_aliases WHERE repository = ${key}`;
          if (used.length)
            return yield* fail(
              "conflict",
              "This repository or alias already belongs to a shared project.",
            );
        }
        if (input.forkOf) yield* project(input.forkOf);
        const value = yield* directoryRecord(SharedProject, {
          sharedProjectId: id("project"),
          name: input.name,
          repository,
          aliases,
          forkOf: input.forkOf ?? null,
          hostProjectId: input.hostProjectId,
          createdAt: yield* now,
        });
        yield* sql`INSERT INTO shared_projects(project_id, repository, request_id, fingerprint, host_project_id, definition_json)
        VALUES (${value.sharedProjectId}, ${repository}, ${input.requestId}, ${fingerprint}, ${input.hostProjectId}, ${encode(value)})`;
        for (const key of [repository, ...aliases])
          yield* sql`INSERT INTO shared_repository_aliases(repository, project_id) VALUES (${key}, ${value.sharedProjectId})`;
        return value;
      }),
    );
  });
  const specialist = Effect.fn("SharedWorkspace.specialist")(function* (specialistId: string) {
    const rows = yield* sql<{
      definition_json: string;
    }>`SELECT definition_json FROM shared_specialists WHERE specialist_id = ${specialistId}`;
    if (!rows[0]) return yield* fail("not_found", "Shared specialist not found.");
    return yield* directoryRecord(
      SharedSpecialist,
      yield* decode(SharedSpecialist, rows[0].definition_json),
    );
  }, Effect.mapError(storageError));
  const registerSpecialist = Effect.fn("SharedWorkspace.registerSpecialist")(function* (
    raw: SharedSpecialistRegisterInput,
    reservation?: { readonly operationKey: string; readonly creationKey: string },
  ) {
    const input = yield* validate(SharedSpecialistRegisterInput, raw);
    const fingerprint = sharedFingerprint(input);
    return yield* transaction(
      Effect.gen(function* () {
        const settings = yield* requireWorkspace;
        const old = yield* sql<{
          fingerprint: string;
          definition_json: string;
        }>`SELECT fingerprint, definition_json FROM shared_specialists WHERE request_id = ${input.requestId}`;
        if (old[0]) {
          if (old[0].fingerprint !== fingerprint)
            return yield* fail(
              "conflict",
              "This specialist request ID already has different contents.",
            );
          return yield* decode(SharedSpecialist, old[0].definition_json);
        }
        const duplicate = yield* sql`SELECT specialist_id FROM shared_specialists
        WHERE native_project_id = ${input.nativeTarget.projectId} AND native_instance_id = ${input.nativeTarget.instanceId}
        AND native_agent_id = ${input.nativeTarget.agentId}`;
        if (duplicate.length)
          return yield* fail(
            "conflict",
            "This native specialist is already registered. Revise its assignments instead of creating a copy.",
          );
        if (!reservation) {
          const pending = yield* sql`SELECT creation_key FROM shared_composition_creations
            WHERE specialist_id IS NULL AND (request_id=${input.requestId} OR (
              json_extract(native_target_json,'$.projectId')=${input.nativeTarget.projectId}
              AND json_extract(native_target_json,'$.instanceId')=${input.nativeTarget.instanceId}
              AND json_extract(native_target_json,'$.agentId')=${input.nativeTarget.agentId}))`;
          if (pending.length)
            return yield* fail(
              "conflict",
              "This native identity is reserved by a pending permanent creation. Reconcile that operation first.",
            );
        }
        if (reservation) {
          const reserved = yield* sql<{
            request_id: string;
            native_target_json: string;
            specialist_id: string | null;
          }>`SELECT request_id,native_target_json,specialist_id FROM shared_composition_creations
            WHERE operation_key=${reservation.operationKey} AND creation_key=${reservation.creationKey}`;
          if (
            !reserved[0] ||
            reserved[0].specialist_id !== null ||
            reserved[0].request_id !== input.requestId ||
            sharedFingerprint(yield* decode(SharedNativeTarget, reserved[0].native_target_json)) !==
              sharedFingerprint(input.nativeTarget)
          )
            return yield* fail(
              "conflict",
              "The permanent creation reservation does not match this native target.",
            );
        }
        const used = yield* specialistCapacity;
        if (
          reservation
            ? used > settings.limits.maxSpecialists
            : used >= settings.limits.maxSpecialists
        )
          return yield* fail("limit_exceeded", "The workspace specialist limit has been reached.");
        const projects = new Set<string>();
        for (const assignment of input.assignments) {
          yield* project(assignment.sharedProjectId);
          yield* validatePaths(assignment.paths);
          if (projects.has(assignment.sharedProjectId))
            return yield* fail("invalid_input", "Assign a specialist to each project only once.");
          projects.add(assignment.sharedProjectId);
        }
        const value = yield* directoryRecord(SharedSpecialist, {
          specialistId: id("specialist"),
          nativeTarget: input.nativeTarget,
          label: input.label,
          assignments: input.assignments,
          assignmentVersion: 1,
          supersededAt: null,
          successorId: null,
          createdAt: yield* now,
        });
        yield* sql`INSERT INTO shared_specialists(specialist_id, request_id, fingerprint, native_project_id, native_instance_id, native_agent_id, definition_json)
        VALUES (${value.specialistId}, ${input.requestId}, ${fingerprint}, ${input.nativeTarget.projectId}, ${input.nativeTarget.instanceId}, ${input.nativeTarget.agentId}, ${encode(value)})`;
        for (const assignment of value.assignments) {
          yield* sql`INSERT INTO shared_assignments(specialist_id, project_id, definition_json)
          VALUES (${value.specialistId}, ${assignment.sharedProjectId}, ${encode(assignment)})`;
          yield* putInterests(
            `specialist:${value.specialistId}`,
            assignment.sharedProjectId,
            value.specialistId,
            assignment,
          );
        }
        if (reservation)
          yield* sql`UPDATE shared_composition_creations SET specialist_id=${value.specialistId}
            WHERE operation_key=${reservation.operationKey} AND creation_key=${reservation.creationKey}`;
        return value;
      }),
    );
  });
  // Called inside the operation's completion transaction, after native observations.
  // This changes future routing only. Request rows, knowledge and inboxes are untouched.
  const applyCompositionAssignments = Effect.fn("SharedWorkspace.applyCompositionAssignments")(
    function* (
      operationKey: string,
      revisions: SharedCompositionInput["revisions"],
      lineage: SharedCompositionOperation["lineage"],
      expected: ReadonlyArray<{ specialistId: string; expectedVersion: number }>,
    ) {
      return yield* transaction(
        Effect.gen(function* () {
          for (const target of expected) {
            const current = yield* specialist(target.specialistId);
            const reservation = yield* sql`SELECT specialist_id FROM shared_composition_targets
          WHERE specialist_id=${target.specialistId} AND operation_key=${operationKey}`;
            if (
              !reservation.length ||
              current.supersededAt ||
              current.assignmentVersion !== target.expectedVersion
            )
              return yield* fail(
                "conflict",
                "Specialist responsibilities changed before the future-routing cutover.",
              );
          }
          const changed = new Set([
            ...revisions.map((item) => item.specialistId),
            ...lineage.map((item) => item.predecessorId),
          ]);
          for (const specialistId of changed) {
            const current = yield* specialist(specialistId);
            const revision = revisions.find((item) => item.specialistId === specialistId);
            const transition = lineage.find((item) => item.predecessorId === specialistId);
            const assignments = revision?.assignments ?? current.assignments;
            const projects = new Set<string>();
            for (const assignment of assignments) {
              yield* project(assignment.sharedProjectId);
              yield* validatePaths(assignment.paths);
              if (projects.has(assignment.sharedProjectId))
                return yield* fail("invalid_input", "Assign each project only once.");
              projects.add(assignment.sharedProjectId);
            }
            const value = yield* directoryRecord(SharedSpecialist, {
              ...current,
              label: revision?.label ?? current.label,
              assignments,
              assignmentVersion: current.assignmentVersion + 1,
              supersededAt: transition?.superseded ? yield* now : current.supersededAt,
              successorId:
                transition?.superseded && transition.successorIds.length === 1
                  ? transition.successorIds[0]
                  : current.successorId,
            });
            yield* sql`UPDATE shared_specialists SET definition_json=${encode(value)} WHERE specialist_id=${specialistId}`;
            yield* sql`DELETE FROM shared_assignments WHERE specialist_id=${specialistId}`;
            yield* sql`DELETE FROM shared_interests WHERE owner_id=${`specialist:${specialistId}`}`;
            for (const assignment of value.assignments) {
              yield* sql`INSERT INTO shared_assignments(specialist_id,project_id,definition_json)
            VALUES (${specialistId},${assignment.sharedProjectId},${encode(assignment)})`;
              if (!value.supersededAt)
                yield* putInterests(
                  `specialist:${specialistId}`,
                  assignment.sharedProjectId,
                  specialistId,
                  assignment,
                );
            }
          }
          for (const transition of lineage)
            for (const successorId of transition.successorIds)
              yield* sql`INSERT INTO shared_specialist_lineage(operation_key,predecessor_id,successor_id,superseded)
            VALUES (${operationKey},${transition.predecessorId},${successorId},${Number(transition.superseded)})`;
        }),
      );
    },
  );
  const listProjects = Effect.fn("SharedWorkspace.listProjects")(function* (
    raw: SharedDirectoryListInput,
  ): Effect.fn.Return<SharedProjectPage, SharedWorkspaceError> {
    const input = yield* validate(SharedDirectoryListInput, raw);
    const limit = input.limit ?? 25;
    const rows = yield* sql<{ definition_json: string }>`SELECT definition_json FROM shared_projects
      WHERE project_id > ${input.after ?? ""} ORDER BY project_id LIMIT ${limit + 1}`.pipe(
      Effect.mapError(storageError),
    );
    const values = yield* Effect.forEach(rows, (row) =>
      decode(SharedProject, row.definition_json).pipe(
        Effect.map((value): SharedProjectSummary => ({
          sharedProjectId: value.sharedProjectId,
          name: value.name,
          repository: value.repository,
          forkOf: value.forkOf,
        })),
      ),
    );
    return directoryPage(values, limit, (value) => value.sharedProjectId);
  });
  const listSpecialists = Effect.fn("SharedWorkspace.listSpecialists")(function* (
    raw: SharedDirectoryListInput,
  ): Effect.fn.Return<SharedSpecialistPage, SharedWorkspaceError> {
    const input = yield* validate(SharedDirectoryListInput, raw);
    const limit = input.limit ?? 25;
    const rows = yield* sql<{
      definition_json: string;
    }>`SELECT definition_json FROM shared_specialists
      WHERE specialist_id > ${input.after ?? ""} ORDER BY specialist_id LIMIT ${limit + 1}`.pipe(
      Effect.mapError(storageError),
    );
    const values = yield* Effect.forEach(rows, (row) =>
      decode(SharedSpecialist, row.definition_json).pipe(
        Effect.map((value): SharedSpecialistSummary => ({
          specialistId: value.specialistId,
          label: value.label,
          sharedProjectIds: value.assignments.map((assignment) => assignment.sharedProjectId),
          assignmentVersion: value.assignmentVersion,
          supersededAt: value.supersededAt,
          successorId: value.successorId,
        })),
      ),
    );
    return directoryPage(values, limit, (value) => value.specialistId);
  });
  const checkout = Effect.fn("SharedWorkspace.checkout")(function* (checkoutId: string) {
    const rows = yield* sql<{
      definition_json: string;
    }>`SELECT definition_json FROM shared_checkouts WHERE checkout_id = ${checkoutId}`;
    if (!rows[0]) return yield* fail("not_found", "Shared checkout not found.");
    return yield* decode(SharedCheckout, rows[0].definition_json);
  });
  const attachCheckout = Effect.fn("SharedWorkspace.attachCheckout")(function* (
    sessionId: string,
    raw: SharedCheckoutAttachInput,
  ) {
    const input = yield* validate(SharedCheckoutAttachInput, raw);
    const repository = yield* repositoryKey(input.repository);
    return yield* transaction(
      Effect.gen(function* () {
        yield* requireWorkspace;
        const actor = yield* requireParticipant(sessionId);
        const matches = yield* sql<{
          project_id: string;
        }>`SELECT project_id FROM shared_repository_aliases WHERE repository = ${repository}`;
        const sharedProjectId = matches[0]?.project_id;
        if (!sharedProjectId)
          return yield* fail(
            "not_found",
            "No shared project matches this repository. A host administrator can register it or add an explicit alias.",
          );
        if (input.sharedProjectId && input.sharedProjectId !== sharedProjectId)
          return yield* fail(
            "conflict",
            "The selected shared project does not match this repository.",
          );
        const old = yield* sql<{
          definition_json: string;
        }>`SELECT definition_json FROM shared_checkouts
        WHERE participant_id = ${actor.participantId} AND environment_id = ${input.localEnvironmentId} AND local_project_id = ${input.localProjectId}`;
        if (old[0]) {
          const value = yield* decode(SharedCheckout, old[0].definition_json);
          if (value.sharedProjectId !== sharedProjectId)
            return yield* fail(
              "conflict",
              "This local checkout is already attached to a different shared project.",
            );
          return value;
        }
        const value: SharedCheckout = {
          checkoutId: id("checkout"),
          participantId: actor.participantId,
          sharedProjectId,
          localEnvironmentId: input.localEnvironmentId,
          localProjectId: input.localProjectId,
          repository,
          createdAt: yield* now,
        };
        yield* sql`INSERT INTO shared_checkouts(checkout_id, participant_id, project_id, environment_id, local_project_id, definition_json)
        VALUES (${value.checkoutId}, ${actor.participantId}, ${sharedProjectId}, ${input.localEnvironmentId}, ${input.localProjectId}, ${encode(value)})`;
        return value;
      }),
    );
  });
  const actorId = (actor: SharedActor) =>
    actor.kind === "participant"
      ? actor.participantId
      : actor.kind === "local_agent"
        ? actor.delegationId
        : actor.specialistId;
  const authorizeAction = Effect.fn("SharedWorkspace.authorizeAction")(function* (
    actor: SharedActor,
    action: SharedDelegationAction,
  ) {
    if (actor.kind !== "local_agent") return;
    if (actor.action !== action)
      return yield* fail("forbidden", "The delegated action does not match this operation.");
    yield* requireSharedDelegation(actor.sessionId, actor.delegationId, action);
  });
  const author = Effect.fn("SharedWorkspace.author")(function* (actor: SharedActor) {
    if (actor.kind === "local_agent")
      return (yield* requireSharedDelegation(actor.sessionId, actor.delegationId, actor.action))
        .participant;
    if (actor.kind === "specialist") {
      const value = yield* specialist(actor.specialistId);
      return {
        participantId: value.specialistId,
        kind: "specialist" as const,
        displayName: value.label,
        createdAt: value.createdAt,
      };
    }
    const rows = yield* sql<{
      definition_json: string;
    }>`SELECT definition_json FROM shared_participants WHERE participant_id = ${actor.participantId}`;
    if (!rows[0]) return yield* fail("not_joined", "Shared participant not found.");
    return yield* decode(SharedParticipant, rows[0].definition_json);
  });
  const authorizeContext = Effect.fn("SharedWorkspace.authorizeContext")(function* (
    actor: SharedActor,
    value: SharedWorkContext,
  ) {
    if (actor.kind === "local_agent") {
      const grant = yield* requireSharedDelegation(
        actor.sessionId,
        actor.delegationId,
        actor.action,
      );
      if (
        grant.context.contextId !== value.contextId ||
        grant.context.contextVersion !== value.contextVersion ||
        grant.context.sharedProjectId !== value.sharedProjectId ||
        grant.ownerParticipantId !== value.participantId
      )
        return yield* fail("forbidden", "This immutable task context is outside the delegation.");
    } else if (actor.kind === "participant") {
      if (value.participantId !== actor.participantId)
        return yield* fail("forbidden", "This work context belongs to another participant.");
    } else {
      if (
        actor.context?.contextId === value.contextId &&
        actor.context.contextVersion === value.contextVersion &&
        actor.context.sharedProjectId === value.sharedProjectId
      )
        return;
      const assigned =
        yield* sql`SELECT project_id FROM shared_assignments WHERE specialist_id = ${actor.specialistId} AND project_id = ${value.sharedProjectId}`;
      if (!assigned.length)
        return yield* fail(
          "forbidden",
          "This specialist is not assigned to the work context's project.",
        );
    }
  });
  const context = Effect.fn("SharedWorkspace.context")(function* (
    contextId: string,
    contextVersion?: string,
  ) {
    const rows = contextVersion
      ? yield* sql<{
          definition_json: string;
        }>`SELECT definition_json FROM shared_context_versions WHERE context_id = ${contextId} AND context_version = ${contextVersion}`
      : yield* sql<{
          definition_json: string;
        }>`SELECT definition_json FROM shared_work_contexts WHERE context_id = ${contextId}`;
    if (!rows[0]) return yield* fail("not_found", "Work context not found.");
    return yield* decode(SharedWorkContext, rows[0].definition_json);
  });
  const validateRevision = Effect.fn("SharedWorkspace.validateRevision")(function* (
    checkoutId: string,
    revision: SharedRevision,
  ) {
    if (!revision.snapshotId) return;
    const rows = yield* sql<{
      definition_json: string;
    }>`SELECT definition_json FROM shared_snapshots WHERE snapshot_id = ${revision.snapshotId} AND checkout_id = ${checkoutId}`;
    if (!rows[0])
      return yield* fail(
        "invalid_input",
        "The uncommitted snapshot is not retained for this checkout.",
      );
    const snapshot = yield* decode(SharedSnapshot, rows[0].definition_json);
    if (
      snapshot.revision.commit !== revision.commit ||
      snapshot.revision.branch !== revision.branch
    )
      return yield* fail("conflict", "The snapshot belongs to a different branch or commit.");
  });
  const validateContextRevision = (work: SharedWorkContext, revision: SharedRevision) =>
    validateRevision(
      work.source.kind === "specialist_observation"
        ? work.source.revisionCheckoutId
        : work.checkoutId,
      revision,
    );
  const putContext = Effect.fn("SharedWorkspace.putContext")(function* (
    actor: SharedActor,
    raw: SharedWorkContextInput | SharedWorkContext,
  ) {
    const input = yield* validate(SharedWorkContextInput, raw);
    yield* validatePaths(input.paths);
    return yield* transaction(
      Effect.gen(function* () {
        const attached = yield* checkout(input.checkoutId);
        if (actor.kind !== "participant" || attached.participantId !== actor.participantId)
          return yield* fail(
            "forbidden",
            "Only the checkout's participant can define its task context.",
          );
        yield* validateRevision(input.checkoutId, input.revision);
        const old = yield* sql<{
          definition_json: string;
        }>`SELECT definition_json FROM shared_work_contexts WHERE context_id = ${input.contextId}`;
        if (old[0]) {
          const previous = yield* decode(SharedWorkContext, old[0].definition_json);
          if (
            previous.checkoutId !== input.checkoutId ||
            previous.participantId !== actor.participantId ||
            stable(previous.source) !== stable(input.source)
          )
            return yield* fail(
              "conflict",
              "A work context cannot change its participant, checkout or originating task.",
            );
        }
        const contents = {
          ...input,
          participantId: actor.participantId,
          sharedProjectId: attached.sharedProjectId,
        };
        const contextVersion = sharedFingerprint(contents);
        const retained = yield* sql<{
          definition_json: string;
        }>`SELECT definition_json FROM shared_context_versions
        WHERE context_id = ${input.contextId} AND context_version = ${contextVersion}`;
        const value: SharedWorkContext = retained[0]
          ? yield* decode(SharedWorkContext, retained[0].definition_json)
          : { ...contents, contextVersion, updatedAt: yield* now };
        yield* sql`INSERT INTO shared_work_contexts(context_id, participant_id, checkout_id, project_id, definition_json)
        VALUES (${value.contextId}, ${value.participantId}, ${value.checkoutId}, ${value.sharedProjectId}, ${encode(value)})
        ON CONFLICT(context_id) DO UPDATE SET definition_json = excluded.definition_json`;
        yield* sql`INSERT INTO shared_context_versions(context_id, context_version, definition_json)
        VALUES (${value.contextId}, ${value.contextVersion}, ${encode(value)})
        ON CONFLICT(context_id, context_version) DO NOTHING`;
        yield* putInterests(
          `context:${value.contextId}`,
          value.sharedProjectId,
          value.participantId,
          value,
        );
        if (!retained[0]) yield* requireEvidenceCapacity();
        return value;
      }),
    );
  });
  const recordActivity = Effect.fn("SharedWorkspace.recordActivity")(function* (
    actor: SharedActor,
    raw: SharedActivityPublishInput,
    requiredAction: "activity.publish" | "knowledge.supersede",
    knowledge?: SharedActivity["knowledge"],
    affectedContexts: ReadonlyArray<SharedWorkContext> = [],
  ) {
    const input = yield* validate(SharedActivityPublishInput, raw);
    yield* validatePaths(input.paths);
    const fingerprint = sharedFingerprint({
      actor: actorId(actor),
      input,
      ...(knowledge ? { knowledge } : {}),
    });
    return yield* transaction(
      Effect.gen(function* () {
        yield* authorizeAction(actor, requiredAction);
        const old = yield* sql<{
          fingerprint: string;
          definition_json: string;
        }>`SELECT fingerprint, definition_json FROM shared_activity WHERE event_id = ${input.eventId}`;
        if (old[0]) {
          if (old[0].fingerprint !== fingerprint)
            return yield* fail(
              "conflict",
              "This activity event ID already has different contents or attribution.",
            );
          return yield* decode(SharedActivity, old[0].definition_json);
        }
        const current = yield* context(input.contextId, input.contextVersion);
        yield* authorizeContext(actor, current);
        yield* validateContextRevision(current, input.revision);
        if (stable(current.revision) !== stable(input.revision))
          return yield* fail(
            "conflict",
            "The observation revision differs from its immutable work context. Publish a context version for this revision first.",
          );
        const attributed = yield* author(actor);
        const timestamp = yield* now;
        const captured = current;
        // Include the captured context and UTF-8 JSON expansion, not only the submitted summary.
        // Reserve the remaining digits of SQLite's positive 64-bit sequence before inserting anything.
        yield* boundedRecord(
          {
            ...input,
            ...(knowledge ? { knowledge } : {}),
            sequence: 0,
            author: attributed,
            context: captured,
            createdAt: timestamp,
          },
          "Activity",
          18,
        );
        const inserted = yield* sql<{
          sequence: number;
        }>`INSERT INTO shared_activity(event_id, actor_id, fingerprint, project_id, context_id, definition_json)
        VALUES (${input.eventId}, ${actorId(actor)}, ${fingerprint}, ${current.sharedProjectId}, ${input.contextId}, '') RETURNING sequence`;
        const sequence = inserted[0]!.sequence;
        const value: SharedActivity = {
          ...input,
          ...(knowledge ? { knowledge } : {}),
          sequence,
          author: attributed,
          context: captured,
          createdAt: timestamp,
        };
        yield* sql`UPDATE shared_activity SET definition_json = ${encode(value)} WHERE sequence = ${sequence}`;
        // Explicit briefings may cross projects, but only to actual workspace participants/specialists.
        for (const recipient of input.recipientIds ?? []) {
          const found =
            yield* sql`SELECT participant_id AS id FROM shared_participants WHERE participant_id = ${recipient}
          UNION ALL SELECT specialist_id AS id FROM shared_specialists WHERE specialist_id = ${recipient}`;
          if (!found.length)
            return yield* fail(
              "invalid_input",
              "An activity recipient is not part of this workspace.",
            );
        }
        // Match indexed interests instead of decoding every task context for each
        // publication. Segment prefixes are literal keys, not wildcard programs.
        // A correction reaches readers of the original areas as well as its new
        // area. Its stored context and revision still belong to the correcting task.
        const matchingPaths = [
          ...new Set([...input.paths, ...affectedContexts.flatMap((item) => item.paths)]),
        ];
        const matchingTags = [
          ...new Set([...input.tags, ...affectedContexts.flatMap((item) => item.tags)]),
        ];
        const matched = yield* sql<{ recipient_id: string }>`WITH candidates AS (
          SELECT recipient_id FROM shared_interests
            WHERE project_id = ${current.sharedProjectId} AND dimension = 'all'
          UNION
          SELECT recipient_id FROM shared_interests
            WHERE project_id = ${current.sharedProjectId} AND dimension = 'path'
              AND value IN (SELECT value FROM json_each(${encode(pathAncestors(matchingPaths))}))
          UNION
          SELECT i.recipient_id FROM json_each(${encode(matchingPaths.map((path) => path.replace(/\/$/, "")))}) p
            JOIN shared_interests i ON i.project_id = ${current.sharedProjectId} AND i.dimension = 'path'
              AND i.value >= p.value || '/' AND i.value < p.value || '0'
          UNION
          SELECT recipient_id FROM shared_interests
            WHERE project_id = ${current.sharedProjectId} AND dimension = 'tag'
              AND value IN (SELECT value FROM json_each(${encode(matchingTags)}))
          UNION
          SELECT value AS recipient_id FROM json_each(${encode(input.recipientIds ?? [])})
        ) SELECT DISTINCT c.recipient_id FROM candidates c
        LEFT JOIN shared_specialists s ON s.specialist_id = c.recipient_id
        LEFT JOIN shared_participants p ON p.participant_id = c.recipient_id
        LEFT JOIN shared_delegations d ON d.delegation_id = c.recipient_id
        LEFT JOIN auth_sessions a ON a.session_id = d.parent_session_id
        WHERE c.recipient_id <> ${actorId(actor)}
          AND (s.specialist_id IS NULL OR json_extract(s.definition_json, '$.supersededAt') IS NULL
            OR c.recipient_id IN (SELECT value FROM json_each(${encode(input.recipientIds ?? [])})))
          AND ((d.delegation_id IS NULL AND json_extract(p.definition_json, '$.kind') IS NOT 'local_agent') OR (
            d.delegation_id IS NOT NULL
            AND json_extract(d.definition_json, '$.revokedAt') IS NULL
            AND julianday(json_extract(d.definition_json, '$.expiresAt')) > julianday(${timestamp})
            AND a.revoked_at IS NULL AND julianday(a.expires_at) > julianday(${timestamp})
            AND EXISTS (SELECT 1 FROM json_each(a.scopes) WHERE value = ${AuthSharedReadScope})
            AND EXISTS (SELECT 1 FROM json_each(a.scopes) WHERE value = ${AuthSharedContributeScope})
            AND EXISTS (SELECT 1 FROM shared_participant_sessions ps
              WHERE ps.session_id = d.parent_session_id AND ps.participant_id = d.owner_participant_id)
            AND EXISTS (SELECT 1 FROM json_each(d.definition_json, '$.actions') WHERE value = 'inbox.list')
          ))
        LIMIT 257`;
        const recipients = new Set(matched.map((row) => row.recipient_id));
        recipients.delete(actorId(actor));
        if (recipients.size > 256)
          return yield* fail(
            "limit_exceeded",
            "This observation exceeds the workspace fan-out limit.",
          );
        for (const recipient of recipients)
          yield* sql`INSERT INTO shared_inbox(recipient_id, sequence) VALUES (${recipient}, ${sequence})`;
        yield* requireEvidenceCapacity(recipients.size);
        return value;
      }),
    );
  });
  const publishActivity = Effect.fn("SharedWorkspace.publishActivity")(function* (
    actor: SharedActor,
    raw: SharedActivityPublishInput,
  ) {
    if (raw.eventId.startsWith("knowledge-correction-"))
      return yield* fail(
        "invalid_input",
        "This activity ID prefix is reserved for retained knowledge corrections.",
      );
    return yield* recordActivity(actor, raw, "activity.publish");
  });
  const recipientFor = Effect.fn("SharedWorkspace.recipientFor")(function* (
    actor: SharedActor,
    requested?: string,
  ) {
    yield* author(actor);
    const recipient = actorId(actor);
    if (requested && requested !== recipient)
      return yield* fail("forbidden", "Only the recipient can read or acknowledge its inbox.");
    return recipient;
  });
  const readInbox = Effect.fn("SharedWorkspace.readInbox")(function* (
    actor: SharedActor,
    raw: SharedInboxReadInput,
  ) {
    const input = yield* validate(SharedInboxReadInput, raw);
    return yield* transaction(
      Effect.gen(function* () {
        yield* authorizeAction(actor, "inbox.list");
        const recipientId = yield* recipientFor(actor, input.recipientId);
        const pending = yield* sql<{
          definition_json: string;
        }>`SELECT definition_json FROM shared_inbox_batches WHERE recipient_id = ${recipientId} AND acknowledged_at IS NULL`;
        if (pending[0]) {
          const sealed = yield* decode(SharedInbox, pending[0].definition_json);
          yield* boundedPage(sealed);
          return sealed;
        }
        const limit = input.limit ?? 50;
        const rows = yield* sql<{
          definition_json: string;
        }>`SELECT a.definition_json FROM shared_inbox i
        JOIN shared_activity a ON a.sequence = i.sequence
        WHERE i.recipient_id = ${recipientId} AND i.acknowledged_at IS NULL
        ORDER BY i.sequence LIMIT ${limit + 1}`;
        const events: SharedActivity[] = [];
        const batchId = rows.length ? id("batch") : null;
        for (const row of rows.slice(0, limit)) {
          const event = yield* decode(SharedActivity, row.definition_json);
          const candidate: SharedInbox = {
            recipientId,
            batchId,
            events: [...events, event],
            hasMore: false,
          };
          if (encodedBytes(candidate) > MAX_PAGE_BYTES) {
            if (!events.length)
              return yield* fail(
                "limit_exceeded",
                "This retained activity cannot fit in an inbox page. It has not been skipped or acknowledged.",
              );
            break;
          }
          events.push(event);
        }
        const value: SharedInbox = {
          recipientId,
          batchId,
          events,
          hasMore: rows.length > events.length,
        };
        yield* boundedPage(value);
        if (value.batchId)
          yield* sql`INSERT INTO shared_inbox_batches(batch_id, recipient_id, definition_json)
        VALUES (${value.batchId}, ${recipientId}, ${encode(value)})`;
        return value;
      }),
    );
  });
  const acknowledgeInbox = Effect.fn("SharedWorkspace.acknowledgeInbox")(function* (
    actor: SharedActor,
    raw: SharedInboxAcknowledgeInput,
  ) {
    const input = yield* validate(SharedInboxAcknowledgeInput, raw);
    return yield* transaction(
      Effect.gen(function* () {
        yield* authorizeAction(actor, "inbox.ack");
        const recipientId = yield* recipientFor(actor, input.recipientId);
        const rows = yield* sql<{
          definition_json: string;
          acknowledged_at: string | null;
        }>`SELECT definition_json, acknowledged_at
        FROM shared_inbox_batches WHERE batch_id = ${input.batchId} AND recipient_id = ${recipientId}`;
        if (!rows[0])
          return yield* fail("not_found", "This batch does not belong to the recipient.");
        if (rows[0].acknowledged_at) return;
        const batch = yield* decode(SharedInbox, rows[0].definition_json);
        const timestamp = yield* now;
        for (const event of batch.events)
          yield* sql`UPDATE shared_inbox SET acknowledged_at = ${timestamp}
        WHERE recipient_id = ${recipientId} AND sequence = ${event.sequence}`;
        yield* sql`UPDATE shared_inbox_batches SET acknowledged_at = ${timestamp} WHERE batch_id = ${input.batchId}`;
      }),
    );
  });
  const putSnapshot = Effect.fn("SharedWorkspace.putSnapshot")(function* (
    actor: SharedActor,
    raw: SharedSnapshotPutInput,
  ) {
    const input = yield* validate(SharedSnapshotPutInput, raw);
    return yield* transaction(
      Effect.gen(function* () {
        const settings = yield* requireWorkspace;
        const attached = yield* checkout(input.checkoutId);
        if (actor.kind !== "participant" || attached.participantId !== actor.participantId)
          return yield* fail(
            "forbidden",
            "Only the checkout's participant can publish its uncommitted snapshot.",
          );
        if (input.revision.snapshotId)
          return yield* fail(
            "invalid_input",
            "A new snapshot references a base revision, not another snapshot.",
          );
        const bytes = Buffer.byteLength(input.patch);
        if (bytes > settings.limits.maxSnapshotBytes)
          return yield* fail("limit_exceeded", "This patch exceeds the workspace snapshot limit.");
        const sha256 = NodeCrypto.createHash("sha256").update(input.patch).digest("hex");
        const snapshotId = `snapshot-${sharedFingerprint({ checkoutId: input.checkoutId, revision: input.revision, sha256 })}`;
        const old = yield* sql<{
          definition_json: string;
        }>`SELECT definition_json FROM shared_snapshots WHERE snapshot_id = ${snapshotId}`;
        if (old[0]) return yield* decode(SharedSnapshot, old[0].definition_json);
        const value: SharedSnapshot = {
          snapshotId,
          sharedProjectId: attached.sharedProjectId,
          checkoutId: input.checkoutId,
          revision: input.revision,
          sha256,
          bytes,
          createdAt: yield* now,
        };
        yield* sql`INSERT INTO shared_snapshots(snapshot_id, project_id, checkout_id, definition_json, patch)
        VALUES (${snapshotId}, ${value.sharedProjectId}, ${input.checkoutId}, ${encode(value)}, ${input.patch})`;
        yield* requireEvidenceCapacity();
        return value;
      }),
    );
  });
  const getSnapshot = Effect.fn("SharedWorkspace.getSnapshot")(function* (snapshotId: string) {
    const rows = yield* sql<{
      definition_json: string;
      patch: string;
    }>`SELECT definition_json, patch FROM shared_snapshots WHERE snapshot_id = ${snapshotId}`;
    if (!rows[0]) return yield* fail("not_found", "Retained snapshot not found.");
    return {
      snapshot: yield* decode(SharedSnapshot, rows[0].definition_json),
      patch: rows[0].patch,
    };
  });
  const putKnowledge = Effect.fn("SharedWorkspace.putKnowledge")(function* (
    actor: SharedActor,
    raw: SharedKnowledgePutInput,
  ) {
    const input = yield* validate(SharedKnowledgePutInput, raw);
    const fingerprint = sharedFingerprint({ actor: actorId(actor), input });
    return yield* transaction(
      Effect.gen(function* () {
        yield* authorizeAction(
          actor,
          input.supersedes.length ? "knowledge.supersede" : "knowledge.record",
        );
        const old = yield* sql<{
          fingerprint: string;
          definition_json: string;
        }>`SELECT fingerprint, definition_json FROM shared_knowledge WHERE evidence_id = ${input.evidenceId}`;
        if (old[0]) {
          if (old[0].fingerprint !== fingerprint)
            return yield* fail(
              "conflict",
              "This evidence ID already has different contents. Record a correction with a new ID.",
            );
          return yield* decode(SharedKnowledge, old[0].definition_json);
        }
        const work = yield* context(input.contextId, input.contextVersion);
        yield* authorizeContext(actor, work);
        yield* validateContextRevision(work, input.revision);
        if (stable(work.revision) !== stable(input.revision))
          return yield* fail(
            "conflict",
            "The evidence revision differs from its immutable work context.",
          );
        const affectedContexts: SharedWorkContext[] = [];
        for (const previousId of new Set(input.supersedes)) {
          const previous = yield* sql<{
            definition_json: string;
          }>`SELECT definition_json FROM shared_knowledge WHERE evidence_id = ${previousId} AND project_id = ${work.sharedProjectId}`;
          if (!previous.length)
            return yield* fail(
              "invalid_input",
              "Superseded evidence must exist in the same shared project.",
            );
          const evidence = yield* decode(SharedKnowledge, previous[0]!.definition_json);
          affectedContexts.push(yield* context(evidence.contextId, evidence.contextVersion));
        }
        const value: SharedKnowledge = {
          ...input,
          ...(work.source.kind === "specialist_observation"
            ? { observationSource: work.source }
            : {}),
          sharedProjectId: work.sharedProjectId,
          author: yield* author(actor),
          createdAt: yield* now,
        };
        yield* boundedRecord(value, "Knowledge evidence");
        yield* sql`INSERT INTO shared_knowledge(evidence_id, project_id, context_id, actor_id, fingerprint, kind, branch, revision_commit, definition_json)
        VALUES (${input.evidenceId}, ${work.sharedProjectId}, ${input.contextId}, ${actorId(actor)}, ${fingerprint}, ${input.kind}, ${input.revision.branch}, ${input.revision.commit}, ${encode(value)})`;
        yield* sql`INSERT INTO shared_knowledge_search(evidence_id, content) VALUES (${input.evidenceId}, ${input.title + "\n" + input.body})`;
        for (const previousId of new Set(input.supersedes))
          yield* sql`INSERT INTO shared_knowledge_corrections(previous_id, correction_id) VALUES (${previousId}, ${input.evidenceId})`;
        if (input.supersedes.length)
          yield* recordActivity(
            actor,
            {
              eventId: `knowledge-correction-${sharedFingerprint(input.evidenceId)}`,
              contextId: work.contextId,
              contextVersion: work.contextVersion,
              revision: work.revision,
              kind: "correction",
              summary: `Correction: ${input.title}`,
              paths: work.paths,
              tags: work.tags,
              sources: input.sources,
            },
            "knowledge.supersede",
            { evidenceId: input.evidenceId, supersedes: input.supersedes },
            affectedContexts,
          );
        yield* requireEvidenceCapacity();
        return value;
      }),
    );
  });
  /**
   * A separate authority from native request correlation. The caller has already
   * been observed by the private native tool boundary. The transaction rechecks
   * its registration/assignment and consumes one exact retained delivery.
   */
  const prepareInboxObservation = Effect.fn("SharedWorkspace.prepareInboxObservation")(function* (
    actor: SharedActor,
    authority: { readonly environmentId: EnvironmentId; readonly nativeTarget: SharedNativeTarget },
    source: { readonly batchId: string; readonly eventId: string },
    additionalSources: ReadonlyArray<SharedSource>,
  ) {
    if (actor.kind !== "specialist")
      return yield* fail(
        "forbidden",
        "Only an observed shared specialist can publish from its inbox.",
      );
    const current = yield* specialist(actor.specialistId);
    if (
      current.supersededAt !== null ||
      stable(current.nativeTarget) !== stable(authority.nativeTarget)
    )
      return yield* fail("forbidden", "The specialist's current native registration has changed.");
    const rows = yield* sql<{ definition_json: string }>`
      SELECT definition_json FROM shared_inbox_batches
      WHERE batch_id = ${source.batchId} AND recipient_id = ${actor.specialistId}`;
    if (!rows[0])
      return yield* fail("forbidden", "This sealed batch does not belong to the specialist.");
    const batch = yield* decode(SharedInbox, rows[0].definition_json);
    const matches = batch.events.filter((event) => event.eventId === source.eventId);
    if (
      batch.batchId !== source.batchId ||
      batch.recipientId !== actor.specialistId ||
      matches.length !== 1
    )
      return yield* fail("forbidden", "The source event is not in this specialist's sealed batch.");
    const event = matches[0]!;
    const retained = yield* sql<{ definition_json: string }>`
      SELECT a.definition_json FROM shared_activity a
      JOIN shared_inbox i ON i.sequence = a.sequence
      WHERE a.event_id = ${event.eventId} AND a.sequence = ${event.sequence}
        AND i.recipient_id = ${actor.specialistId}`;
    if (
      !retained[0] ||
      stable(yield* decode(SharedActivity, retained[0].definition_json)) !== stable(event)
    )
      return yield* fail("unavailable", "The retained inbox source could not be verified.");
    const original = yield* context(event.contextId, event.contextVersion);
    if (
      stable(original) !== stable(event.context) ||
      stable(original.revision) !== stable(event.revision)
    )
      return yield* fail(
        "unavailable",
        "The source event's immutable context could not be verified.",
      );
    const assigned = yield* sql`SELECT project_id FROM shared_assignments
      WHERE specialist_id = ${actor.specialistId} AND project_id = ${original.sharedProjectId}`;
    if (
      !assigned.length ||
      !current.assignments.some(
        (assignment) => assignment.sharedProjectId === original.sharedProjectId,
      )
    )
      return yield* fail(
        "forbidden",
        "The specialist is no longer assigned to the source project.",
      );
    yield* validateContextRevision(original, event.revision);
    const sources = [
      ...new Map(
        [...event.sources, ...additionalSources].map((item) => [stable(item), item]),
      ).values(),
    ];
    if (sources.length > 64)
      return yield* fail(
        "limit_exceeded",
        "The inherited and additional source references exceed 64. Remove additional references; retained sources cannot be dropped.",
      );
    const projectDefinition = yield* project(original.sharedProjectId);
    const attributed = yield* author(actor);
    const timestamp = yield* now;
    // These rows satisfy product ownership FKs. They do not assert a native
    // identity or that the source revision exists in the host's working tree.
    yield* sql`INSERT INTO shared_participants(participant_id, definition_json)
      VALUES (${actor.specialistId}, ${encode(attributed)})
      ON CONFLICT(participant_id) DO UPDATE SET definition_json = excluded.definition_json`;
    const checkoutId = `observation-host-${sharedFingerprint({
      specialistId: actor.specialistId,
      projectId: original.sharedProjectId,
      environmentId: authority.environmentId,
    })}`;
    const hostAssociation: SharedCheckout = {
      checkoutId,
      participantId: actor.specialistId,
      sharedProjectId: original.sharedProjectId,
      localEnvironmentId: authority.environmentId,
      localProjectId: projectDefinition.hostProjectId,
      repository: projectDefinition.repository,
      association: "specialist_observation_host",
      createdAt: timestamp,
    };
    yield* sql`INSERT INTO shared_checkouts(checkout_id, participant_id, project_id, environment_id, local_project_id, definition_json)
      VALUES (${checkoutId}, ${actor.specialistId}, ${original.sharedProjectId}, ${authority.environmentId}, ${projectDefinition.hostProjectId}, ${encode(hostAssociation)})
      ON CONFLICT(checkout_id) DO NOTHING`;
    const observationSource = {
      kind: "specialist_observation" as const,
      specialistId: actor.specialistId,
      batchId: source.batchId,
      eventId: event.eventId,
      sequence: event.sequence,
      sourceContextId: original.contextId,
      sourceContextVersion: original.contextVersion,
      revisionCheckoutId:
        original.source.kind === "specialist_observation"
          ? original.source.revisionCheckoutId
          : original.checkoutId,
    };
    const contents = {
      contextId: `observation-${sharedFingerprint({ specialistId: actor.specialistId, source })}`,
      checkoutId,
      source: observationSource,
      objective: `Observe retained activity ${event.eventId}`,
      revision: event.revision,
      paths: event.paths,
      tags: event.tags,
      participantId: actor.specialistId,
      sharedProjectId: original.sharedProjectId,
    };
    const contextVersion = sharedFingerprint(contents);
    const existingContext = yield* sql<{ definition_json: string }>`SELECT definition_json
      FROM shared_work_contexts WHERE context_id = ${contents.contextId}`;
    if (existingContext[0]) {
      const existing = yield* decode(SharedWorkContext, existingContext[0].definition_json);
      if (
        existing.contextVersion !== contextVersion ||
        existing.participantId !== actor.specialistId
      )
        return yield* fail(
          "conflict",
          "The observation context ID is already retained with different ownership or contents.",
        );
    }
    const saved = yield* sql<{ definition_json: string }>`SELECT definition_json
      FROM shared_context_versions WHERE context_id = ${contents.contextId} AND context_version = ${contextVersion}`;
    const observation = saved[0]
      ? yield* decode(SharedWorkContext, saved[0].definition_json)
      : yield* validate(SharedWorkContext, { ...contents, contextVersion, updatedAt: timestamp });
    yield* sql`INSERT INTO shared_work_contexts(context_id, participant_id, checkout_id, project_id, definition_json)
      VALUES (${observation.contextId}, ${actor.specialistId}, ${checkoutId}, ${original.sharedProjectId}, ${encode(observation)})
      ON CONFLICT(context_id) DO NOTHING`;
    yield* sql`INSERT INTO shared_context_versions(context_id, context_version, definition_json)
      VALUES (${observation.contextId}, ${contextVersion}, ${encode(observation)})
      ON CONFLICT(context_id, context_version) DO NOTHING`;
    // Deliberately no putInterests or acknowledgement: observation is neither
    // a subscription nor evidence that the recipient has finished processing.
    return { observation, sources };
  });
  const publishActivityFromInbox = Effect.fn("SharedWorkspace.publishActivityFromInbox")(function* (
    actor: SharedActor,
    authority: { readonly environmentId: EnvironmentId; readonly nativeTarget: SharedNativeTarget },
    raw: SharedActivityFromInboxInput,
  ) {
    const input = yield* Schema.decodeUnknownEffect(SharedActivityFromInboxInput, {
      onExcessProperty: "error",
    })(raw).pipe(
      Effect.mapError(() =>
        fail(
          "invalid_input",
          "Inbox publication accepts content and source batch/event only, not caller identity or revision.",
        ),
      ),
    );
    return yield* transaction(
      Effect.gen(function* () {
        const { observation, sources } = yield* prepareInboxObservation(
          actor,
          authority,
          input.source,
          input.sources ?? [],
        );
        return yield* publishActivity(actor, {
          eventId: input.eventId,
          contextId: observation.contextId,
          contextVersion: observation.contextVersion,
          revision: observation.revision,
          kind: input.kind,
          summary: input.summary,
          paths: observation.paths,
          tags: observation.tags,
          sources,
        });
      }),
    );
  });
  const putKnowledgeFromInbox = Effect.fn("SharedWorkspace.putKnowledgeFromInbox")(function* (
    actor: SharedActor,
    authority: { readonly environmentId: EnvironmentId; readonly nativeTarget: SharedNativeTarget },
    raw: SharedKnowledgeFromInboxInput,
  ) {
    const input = yield* Schema.decodeUnknownEffect(SharedKnowledgeFromInboxInput, {
      onExcessProperty: "error",
    })(raw).pipe(
      Effect.mapError(() =>
        fail(
          "invalid_input",
          "Inbox evidence accepts content and source batch/event only, not caller identity or revision.",
        ),
      ),
    );
    return yield* transaction(
      Effect.gen(function* () {
        const { observation, sources } = yield* prepareInboxObservation(
          actor,
          authority,
          input.source,
          input.sources ?? [],
        );
        return yield* putKnowledge(actor, {
          evidenceId: input.evidenceId,
          contextId: observation.contextId,
          contextVersion: observation.contextVersion,
          revision: observation.revision,
          kind: input.kind,
          title: input.title,
          body: input.body,
          sources,
          supersedes: input.supersedes,
          state: input.state,
        });
      }),
    );
  });
  const searchKnowledge = Effect.fn("SharedWorkspace.searchKnowledge")(function* (
    raw: SharedKnowledgeSearchInput,
  ) {
    const input = yield* validate(SharedKnowledgeSearchInput, raw);
    const before = input.cursor?.slice("knowledge:".length);
    if (before !== undefined && BigInt(before) > 9_223_372_036_854_775_807n)
      return yield* fail("invalid_input", "Invalid knowledge page cursor.");
    const query = input.query?.trim();
    // Treat text as a phrase, not an FTS program. Filters retain branch and revision meaning.
    const match = query ? `"${query.replace(/"/g, '""')}"` : null;
    const limit = input.limit ?? 50;
    const rows = yield* sql<{
      definition_json: string;
      position: string;
    }>`SELECT k.definition_json, CAST(k.rowid AS TEXT) AS position FROM shared_knowledge k
      WHERE (${input.sharedProjectId ?? null} IS NULL OR k.project_id = ${input.sharedProjectId ?? null})
        AND (${input.evidenceId ?? null} IS NULL OR k.evidence_id = ${input.evidenceId ?? null})
        AND (${input.supersedes ?? null} IS NULL OR EXISTS
          (SELECT 1 FROM shared_knowledge_corrections c WHERE c.previous_id = ${input.supersedes ?? null} AND c.correction_id = k.evidence_id))
        AND (${before ?? null} IS NULL OR k.rowid < CAST(${before ?? null} AS INTEGER))
        AND (${input.branch ?? null} IS NULL OR k.branch = ${input.branch ?? null})
        AND (${input.commit ?? null} IS NULL OR k.revision_commit = ${input.commit ?? null})
        AND (${input.kind ?? null} IS NULL OR k.kind = ${input.kind ?? null})
        AND (${match} IS NULL OR k.evidence_id IN
          (SELECT evidence_id FROM shared_knowledge_search WHERE shared_knowledge_search MATCH ${match ?? '""'}))
      ORDER BY k.rowid DESC LIMIT ${limit + 1}`.pipe(Effect.mapError(storageError));
    const records: SharedKnowledgeSearchHit[] = [];
    let nextCursor: string | null = null;
    for (const row of rows.slice(0, limit)) {
      const original = yield* decode(SharedKnowledge, row.definition_json);
      const corrections = yield* sql<{ definition_json: string }>`SELECT k.definition_json
        FROM shared_knowledge_corrections c JOIN shared_knowledge k ON k.evidence_id = c.correction_id
        WHERE c.previous_id = ${original.evidenceId} ORDER BY k.rowid DESC LIMIT 9`.pipe(
        Effect.mapError(storageError),
      );
      const cursor = `knowledge:${row.position}`;
      const references: Array<SharedKnowledgeSearchHit["corrections"][number]> = [];
      for (const entry of corrections.slice(0, 8)) {
        const { evidenceId, title, contextId, contextVersion, revision, author, createdAt } =
          yield* decode(SharedKnowledge, entry.definition_json);
        const next = { evidenceId, title, contextId, contextVersion, revision, author, createdAt };
        // Derived references must never make an admitted evidence record unreadable.
        // The caller can page every correction independently using supersedes.
        if (
          encodedBytes({
            records: [
              { ...original, corrections: [...references, next], hasMoreCorrections: false },
            ],
            hasMore: false,
            nextCursor: cursor,
          }) > MAX_PAGE_BYTES
        )
          break;
        references.push(next);
      }
      const record: SharedKnowledgeSearchHit = {
        ...original,
        corrections: references,
        hasMoreCorrections: corrections.length > references.length,
      };
      // Keep a cursor even in the trial final page so the eventual envelope can never grow past its budget.
      const candidate: SharedKnowledgeSearchResult = {
        records: [...records, record],
        hasMore: false,
        nextCursor: cursor,
      };
      if (encodedBytes(candidate) > MAX_PAGE_BYTES) {
        if (!records.length)
          return yield* fail(
            "limit_exceeded",
            "This retained knowledge record cannot fit in a result page. It has not been skipped.",
          );
        break;
      }
      records.push(record);
      nextCursor = cursor;
    }
    const hasMore = rows.length > records.length;
    const result: SharedKnowledgeSearchResult = {
      records,
      hasMore,
      nextCursor: hasMore ? nextCursor : null,
    };
    yield* boundedPage(result);
    return result;
  });
  const snapshot = Effect.fn("SharedWorkspace.snapshot")(function* (
    sessionId: string,
  ): Effect.fn.Return<SharedWorkspaceSnapshot, SharedWorkspaceError> {
    return yield* Effect.gen(function* () {
      const current = yield* workspace;
      const viewer = yield* participant(sessionId);
      if (!current)
        return { workspace: null, participant: null, projects: [], specialists: [], checkouts: [] };
      const projects = yield* sql<{
        definition_json: string;
      }>`SELECT definition_json FROM shared_projects ORDER BY project_id`;
      const specialists = yield* sql<{
        definition_json: string;
      }>`SELECT definition_json FROM shared_specialists ORDER BY specialist_id`;
      const checkouts = viewer
        ? yield* sql<{
            definition_json: string;
          }>`SELECT definition_json FROM shared_checkouts WHERE participant_id = ${viewer.participantId} ORDER BY checkout_id`
        : [];
      const used = yield* evidenceUsage;
      const pending = yield* sql<{ requests: number; compositions: number }>`SELECT
        (SELECT COUNT(*) FROM shared_specialist_requests
          WHERE json_extract(definition_json, '$.outcome.status') IN ('not_admitted', 'unresolved', 'accepted')) AS requests,
        (SELECT COUNT(*) FROM shared_composition_operations
          WHERE json_extract(definition_json, '$.status') = 'pending') AS compositions`;
      const capacity: SharedWorkspaceCapacity = {
        evidence: {
          bytes: used.bytes,
          maxBytes: evidenceLimits.maxBytes,
          records: used.records,
          maxRecords: evidenceLimits.maxRecords,
        },
        inbox: { pending: used.pending_inbox, maxPending: evidenceLimits.maxPending },
        specialists: {
          registeredAndReserved: yield* specialistCapacity,
          maxSpecialists: current.limits.maxSpecialists,
        },
        pendingRequests: pending[0]!.requests,
        pendingCompositionOperations: pending[0]!.compositions,
      };
      return {
        workspace: current,
        participant: viewer,
        projects: yield* Effect.forEach(projects, (row) =>
          decode(SharedProject, row.definition_json),
        ),
        specialists: yield* Effect.forEach(specialists, (row) =>
          decode(SharedSpecialist, row.definition_json),
        ),
        checkouts: yield* Effect.forEach(checkouts, (row) =>
          decode(SharedCheckout, row.definition_json),
        ),
        capacity,
      };
    }).pipe(Effect.mapError(storageError));
  });
  return {
    workspace,
    configure,
    participant,
    requireParticipant,
    join,
    project,
    registerProject,
    specialist,
    registerSpecialist,
    specialistCapacity,
    applyCompositionAssignments,
    listProjects,
    listSpecialists,
    checkout,
    attachCheckout,
    context,
    putContext,
    authorizeContext,
    authorizeAction,
    validateRevision,
    author,
    publishActivity,
    publishActivityFromInbox,
    readInbox,
    acknowledgeInbox,
    putSnapshot,
    getSnapshot,
    putKnowledge,
    putKnowledgeFromInbox,
    searchKnowledge,
    snapshot,
  };
});
export type SharedWorkspaceStore = Effect.Success<typeof makeSharedWorkspaceStore>;

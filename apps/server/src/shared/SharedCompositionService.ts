import {
  SharedCompositionInput,
  SharedCompositionOperation,
  SharedWorkspaceError,
  type SharedCompositionEvidence,
  type SharedCompositionReference,
  type SharedNativeTarget,
  type SharedSpecialist,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { agentFingerprint } from "../provider/meerkat/MeerkatProjectAgentStore.ts";
import type { makeMeerkatTeamService } from "../provider/meerkat/MeerkatTeamService.ts";
import { sharedReadOnlyNativeAgent } from "./SharedSpecialistService.ts";
import {
  sharedFingerprint,
  type SharedActor,
  type SharedWorkspaceStore,
} from "./SharedWorkspaceStore.ts";

type Team = Pick<
  Effect.Success<typeof makeMeerkatTeamService>,
  | "projectAgentCreate"
  | "projectAgentLifecycle"
  | "projectAgentReviseShared"
  | "projectTeam"
  | "peerConnectionSet"
>;
const fail = (code: SharedWorkspaceError["code"], message: string) =>
  new SharedWorkspaceError({ code, message });
const isSharedWorkspaceError = Schema.is(SharedWorkspaceError);
const failure = (cause: unknown) =>
  isSharedWorkspaceError(cause)
    ? cause
    : fail(
        "unavailable",
        "Composition observation is unavailable. The retained operation can be retried with the same ID.",
      );
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeInput = Schema.decodeUnknownEffect(SharedCompositionInput);
const decodeStoredInput = Schema.decodeEffect(Schema.fromJsonString(SharedCompositionInput));
const decodeOperation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SharedCompositionOperation),
);
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
// eslint-disable-next-line no-control-regex -- Repository paths must reject control characters.
const pathControlCharacters = /[\u0000-\u001f]/;
const actorIdentity = (actor: SharedActor): SharedCompositionOperation["actor"] => {
  if (actor.kind === "participant") return { kind: "participant", id: actor.participantId };
  if (actor.kind === "specialist") return { kind: "specialist", id: actor.specialistId };
  throw fail("invalid_input", "Local agent grants do not authorize workspace composition.");
};
const referenceKey = (ref: SharedCompositionReference) =>
  "specialistId" in ref ? `existing:${ref.specialistId}` : `create:${ref.creationKey}`;
const createRequestId = (operationKey: string, key: string) =>
  `composition-create-${sharedFingerprint([operationKey, key])}`;
const revisionRequestId = (operationKey: string, specialistId: string) =>
  `composition-revision-${sharedFingerprint([operationKey, specialistId])}`;
const responsibilities = (instructions: string, assignments: SharedSpecialist["assignments"]) =>
  `${instructions}\n\nShared project assignments (repository paths are qualified by sharedProjectId, never by the host checkout):\n${encode(assignments)}`;

/** Durable application intent. Every runtime observation is obtained through the existing native adapter. */
export const makeSharedCompositionService = Effect.fn("SharedComposition.make")(function* (
  workspace: SharedWorkspaceStore,
  team: Team,
) {
  const sql = yield* SqlClient.SqlClient;
  // Serialize host callbacks so an older concurrent retry cannot reapply an edge
  // after its operation completed and a later operation was admitted.
  const execution = yield* Semaphore.make(1);
  const load = Effect.fn("SharedComposition.load")(function* (key: string) {
    const rows = yield* sql<{
      fingerprint: string;
      input_json: string;
      definition_json: string;
    }>`SELECT fingerprint,input_json,definition_json
      FROM shared_composition_operations WHERE operation_key=${key}`;
    if (!rows[0]) return undefined;
    return {
      input: yield* decodeStoredInput(rows[0].input_json),
      value: yield* decodeOperation(rows[0].definition_json),
      fingerprint: rows[0].fingerprint,
    };
  });
  const persist = (value: SharedCompositionOperation) =>
    sql`UPDATE shared_composition_operations SET definition_json=${encode(value)} WHERE operation_key=${value.operationKey}`;
  const operationKey = Effect.fn("SharedComposition.operationKey")(function* (
    actor: SharedActor,
    operationId: string,
  ) {
    const identity = yield* Effect.try({ try: () => actorIdentity(actor), catch: failure });
    yield* workspace.author(actor);
    const settings = yield* workspace.workspace;
    if (!settings) return yield* fail("not_configured", "Configure a shared workspace first.");
    return `composition-${sharedFingerprint([settings.workspaceId, identity, operationId])}`;
  });
  const expectedTargets = (input: SharedCompositionInput) => {
    const targets = new Map<string, number>();
    const add = (specialistId: string, expectedVersion: number) => {
      if (targets.has(specialistId) && targets.get(specialistId) !== expectedVersion)
        throw fail(
          "invalid_input",
          "All references to a specialist must use the same assignment version.",
        );
      targets.set(specialistId, expectedVersion);
    };
    for (const revision of input.revisions) add(revision.specialistId, revision.expectedVersion);
    for (const transition of input.transitions) {
      add(transition.predecessorId, transition.expectedVersion);
      for (const ref of transition.successors)
        if ("specialistId" in ref) add(ref.specialistId, ref.expectedVersion);
    }
    for (const peer of input.peers)
      for (const ref of [peer.source, peer.target])
        if ("specialistId" in ref) add(ref.specialistId, ref.expectedVersion);
    return [...targets].map(([specialistId, expectedVersion]) => ({
      specialistId,
      expectedVersion,
    }));
  };
  const validatePlan = Effect.fn("SharedComposition.validatePlan")(function* (
    input: SharedCompositionInput,
  ) {
    if (Buffer.byteLength(encode(input)) > 48 * 1024)
      return yield* fail("limit_exceeded", "Composition input exceeds 48 KiB.");
    const unique = (ids: ReadonlyArray<string>) => new Set(ids).size === ids.length;
    if (
      !unique(input.creations.map((value) => value.key)) ||
      !unique(input.revisions.map((value) => value.specialistId)) ||
      !unique(input.transitions.map((value) => value.predecessorId))
    )
      return yield* fail(
        "invalid_input",
        "Creation keys, revisions and predecessor transitions must be unique.",
      );
    const { kind, creations, revisions, peers, transitions } = input;
    if (
      (kind === "create" && (!creations.length || revisions.length || transitions.length)) ||
      (kind === "revise" &&
        (!revisions.length || creations.length || peers.length || transitions.length)) ||
      (kind === "connect" &&
        (!peers.length || creations.length || revisions.length || transitions.length)) ||
      (kind === "split" && (transitions.length !== 1 || transitions[0]!.successors.length < 2)) ||
      (kind === "consolidate" &&
        (transitions.length < 2 ||
          transitions.some((item) => item.successors.length !== 1 || !item.supersede) ||
          new Set(transitions.map((item) => referenceKey(item.successors[0]!))).size !== 1)) ||
      (kind === "supersede" && (!transitions.length || transitions.some((item) => !item.supersede)))
    )
      return yield* fail(
        "invalid_input",
        "The operation shape does not match its composition kind.",
      );
    if (
      creations.some(
        (item) =>
          !/^[a-z][a-z0-9-]{0,79}$/.test(item.role) ||
          ["ingress", "thread", "user", "assistant", "system"].includes(item.role),
      )
    )
      return yield* fail(
        "invalid_input",
        "Choose a lowercase, nonreserved native specialist role.",
      );
    const superseded = new Set(
      transitions.filter((item) => item.supersede).map((item) => item.predecessorId),
    );
    if (
      transitions.some((item) =>
        item.successors.some((ref) => "specialistId" in ref && superseded.has(ref.specialistId)),
      )
    )
      return yield* fail(
        "invalid_input",
        "A successor cannot also be superseded by this operation.",
      );
    const keys = new Set(creations.map((item) => item.key));
    const refs = [
      ...peers.flatMap((item) => [item.source, item.target]),
      ...transitions.flatMap((item) => item.successors),
    ];
    if (refs.some((ref) => "creationKey" in ref && !keys.has(ref.creationKey)))
      return yield* fail(
        "invalid_input",
        "A creation reference has no definition in this operation.",
      );
    if (
      peers.some((item) => referenceKey(item.source) === referenceKey(item.target)) ||
      transitions.some(
        (item) =>
          !unique(item.successors.map(referenceKey)) ||
          item.successors.some(
            (ref) => "specialistId" in ref && ref.specialistId === item.predecessorId,
          ),
      )
    )
      return yield* fail(
        "invalid_input",
        "A specialist cannot be its own peer or successor, and successors must be distinct.",
      );
    if (
      transitions.some(
        (item) =>
          !item.supersede &&
          !revisions.some((revision) => revision.specialistId === item.predecessorId),
      )
    )
      return yield* fail(
        "invalid_input",
        "A partial split must explicitly revise the predecessor's remaining assignments.",
      );
    for (const item of [...creations, ...revisions]) {
      const projectIds = new Set<string>();
      for (const assignment of item.assignments) {
        yield* workspace.project(assignment.sharedProjectId);
        if (
          projectIds.has(assignment.sharedProjectId) ||
          assignment.paths.some(
            (path) =>
              !path ||
              path.startsWith("/") ||
              path.includes("\\") ||
              pathControlCharacters.test(path) ||
              path.split("/").some((part) => part === "." || part === ".."),
          )
        )
          return yield* fail(
            "invalid_input",
            "Assignments require distinct registered projects and repository-relative paths.",
          );
        projectIds.add(assignment.sharedProjectId);
      }
      if (
        item.instructions &&
        (Buffer.byteLength(responsibilities(item.instructions, item.assignments)) > 48 * 1024 ||
          responsibilities(item.instructions, item.assignments).length > 32_000)
      )
        return yield* fail(
          "limit_exceeded",
          "Rendered responsibilities exceed 32,000 characters or 48 KiB.",
        );
      if ("anchorSharedProjectId" in item && !projectIds.has(item.anchorSharedProjectId))
        return yield* fail(
          "invalid_input",
          "The new specialist must retain an assignment to its anchor project.",
        );
    }
    return yield* Effect.try({ try: () => expectedTargets(input), catch: failure });
  });
  const observe = Effect.fn("SharedComposition.observe")(function* (target: SharedNativeTarget) {
    const roster = yield* team.projectTeam({ projectId: target.projectId });
    const domain = sharedReadOnlyNativeAgent(roster, target);
    const live = roster.providers
      .filter((item) => item.instanceId === target.instanceId)
      .flatMap((item) => item.agents)
      .find((item) => item.projectAgentId === target.agentId && item.agentRef === domain?.agentRef);
    if (!domain || !live?.record.session_id)
      return yield* fail(
        "unavailable",
        "A connected native session with observed repository-read-only policy is required.",
      );
    return live.record.session_id;
  });
  const recordEvidence = Effect.fn("SharedComposition.recordEvidence")(function* (
    key: string,
    evidence: SharedCompositionEvidence,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const retained = yield* load(key);
        if (!retained) return yield* fail("not_found", "Composition operation not found.");
        if (retained.value.status !== "pending") return retained.value;
        const previous = retained.value.evidence.find((entry) => entry.step === evidence.step);
        if (previous) return retained.value;
        const value = {
          ...retained.value,
          evidence: [...retained.value.evidence, evidence],
          detail: null,
          updatedAt: yield* now,
        };
        yield* persist(value);
        return value;
      }),
    );
  });
  const claim = Effect.fn("SharedComposition.claim")(function* (
    actor: SharedActor,
    input: SharedCompositionInput,
    key: string,
  ) {
    const expected = yield* validatePlan(input);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const fingerprint = sharedFingerprint(input);
        const previous = yield* load(key);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            return yield* fail("conflict", "This operation ID already has different contents.");
          return previous.value;
        }
        const settings = yield* workspace.workspace;
        if (!settings) return yield* fail("not_configured", "Configure a shared workspace first.");
        const timestamp = yield* now;
        const created: Array<SharedCompositionOperation["creations"][number]> = [];
        for (const item of input.creations) {
          const anchor = yield* workspace.project(item.anchorSharedProjectId);
          const requestId = createRequestId(key, item.key);
          created.push({
            key: item.key,
            nativeTarget: {
              projectId: anchor.hostProjectId,
              instanceId: item.instanceId,
              agentId: `agent-${agentFingerprint([anchor.hostProjectId, item.instanceId, requestId])}`,
            },
            specialistId: null,
          });
        }
        let detail: string | null = null;
        for (const item of expected) {
          const current = yield* workspace.specialist(item.specialistId);
          const held =
            yield* sql`SELECT specialist_id FROM shared_composition_targets WHERE specialist_id=${item.specialistId}`;
          if (
            current.supersededAt ||
            current.assignmentVersion !== item.expectedVersion ||
            held.length
          )
            detail =
              "The expected assignment version is stale, superseded, or reserved by another pending operation.";
          const revision = input.revisions.find(
            (entry) => entry.specialistId === item.specialistId,
          );
          if (revision) {
            const projects = yield* Effect.forEach(revision.assignments, (assignment) =>
              workspace.project(assignment.sharedProjectId),
            );
            if (
              !projects.some((project) => project.hostProjectId === current.nativeTarget.projectId)
            )
              return yield* fail(
                "invalid_input",
                "An existing specialist must retain its independent anchor project assignment.",
              );
          }
        }
        if (
          (yield* workspace.specialistCapacity) + input.creations.length >
          settings.limits.maxSpecialists
        )
          detail =
            "The specialist limit is reserved by existing specialists and pending creations.";
        const value: SharedCompositionOperation = {
          operationKey: key,
          operationId: input.operationId,
          actor: actorIdentity(actor),
          kind: input.kind,
          status: detail ? "conflict" : "pending",
          detail,
          creations: created,
          evidence: [],
          lineage: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        yield* sql`INSERT INTO shared_composition_operations(operation_key,actor_key,operation_id,fingerprint,input_json,definition_json)
        VALUES (${key},${encode(actorIdentity(actor))},${input.operationId},${fingerprint},${encode(input)},${encode(value)})`;
        if (detail) return value;
        for (const item of expected)
          yield* sql`INSERT INTO shared_composition_targets(specialist_id,operation_key) VALUES (${item.specialistId},${key})`;
        for (const item of created)
          yield* sql`INSERT INTO shared_composition_creations(operation_key,creation_key,request_id,native_target_json)
        VALUES (${key},${item.key},${createRequestId(key, item.key)},${encode(item.nativeTarget)})`;
        return value;
      }),
    );
  });
  const execute = Effect.fn("SharedComposition.execute")(
    function* (actor: SharedActor, raw: SharedCompositionInput) {
      const input = yield* decodeInput(raw).pipe(
        Effect.mapError(() => fail("invalid_input", "Invalid composition operation.")),
      );
      const key = yield* operationKey(actor, input.operationId);
      let value = yield* claim(actor, input, key);
      if (value.status !== "pending") return value;
      const perform = Effect.gen(function* () {
        for (const creation of input.creations) {
          const item = value.creations.find((entry) => entry.key === creation.key)!;
          const requestId = createRequestId(key, creation.key);
          const agent = yield* team.projectAgentCreate({
            ...item.nativeTarget,
            requestId,
            label: creation.label,
            role: creation.role,
            instructions: responsibilities(creation.instructions, creation.assignments),
            model: creation.model,
            ...(creation.options ? { options: creation.options } : {}),
            accessMode: "repository-read-only",
          });
          if (
            agent.agentId !== item.nativeTarget.agentId ||
            agent.projectId !== item.nativeTarget.projectId ||
            agent.instanceId !== item.nativeTarget.instanceId
          )
            return yield* fail(
              "unavailable",
              "Native creation returned a different permanent identity.",
            );
          if (agent.connectionStatus !== "connected") {
            if (agent.archived || !agent.enabled)
              return yield* fail(
                "unavailable",
                "The permanent agent was disabled externally; restore it explicitly before resuming composition.",
              );
            yield* team.projectAgentLifecycle({
              projectId: item.nativeTarget.projectId,
              agentId: item.nativeTarget.agentId,
              action: "connect",
            });
          }
          const sessionId = yield* observe(item.nativeTarget);
          value = yield* recordEvidence(key, {
            step: `create:${creation.key}`,
            kind: "native_identity",
            nativeTarget: item.nativeTarget,
            sessionId,
            observedAt: yield* now,
          });
        }
        const resolve = Effect.fn("SharedComposition.resolve")(function* (
          ref: SharedCompositionReference,
        ) {
          if ("specialistId" in ref)
            return (yield* workspace.specialist(ref.specialistId)).nativeTarget;
          const creation = value.creations.find((item) => item.key === ref.creationKey);
          if (!creation)
            return yield* fail("unavailable", "A permanent successor has no retained identity.");
          return creation.nativeTarget;
        });
        for (const revision of input.revisions) {
          if (
            !revision.instructions ||
            value.evidence.some((item) => item.step === `revise:${revision.specialistId}`)
          )
            continue;
          const specialist = yield* workspace.specialist(revision.specialistId);
          const sessionId = yield* observe(specialist.nativeTarget);
          const requestId = revisionRequestId(key, revision.specialistId);
          const receipt = yield* team.projectAgentReviseShared({
            ...specialist.nativeTarget,
            requestId,
            instructions: responsibilities(revision.instructions, revision.assignments),
          });
          const expectedRevision = `revision-${agentFingerprint([specialist.nativeTarget.agentId, requestId])}`;
          if (!receipt.applied || receipt.revisionId !== expectedRevision)
            return yield* fail(
              "unavailable",
              receipt.detail ?? "Native responsibility activation remains pending.",
            );
          value = yield* recordEvidence(key, {
            step: `revise:${revision.specialistId}`,
            kind: "native_revision",
            nativeTarget: specialist.nativeTarget,
            sessionId,
            revisionId: receipt.revisionId,
            observedAt: yield* now,
          });
        }
        for (const [index, peer] of input.peers.entries()) {
          const source = yield* resolve(peer.source);
          const target = yield* resolve(peer.target);
          yield* observe(source);
          yield* observe(target);
          const receipt = yield* team.peerConnectionSet({
            source: { kind: "project-agent", ...source },
            target: { kind: "project-agent", ...target },
            connected: true,
            requestId: `composition-peer-${sharedFingerprint([key, index])}`,
          });
          const same = (a: typeof receipt.endpoint, b: SharedNativeTarget) =>
            a.kind === "project-agent" &&
            a.projectId === b.projectId &&
            a.instanceId === b.instanceId &&
            a.agentId === b.agentId;
          const edge = receipt.connections.find(
            (item) =>
              (same(item.source, source) && same(item.target, target)) ||
              (same(item.target, source) && same(item.source, target)),
          );
          if (edge?.status !== "connected" || !edge.desired || edge.error)
            return yield* fail(
              "unavailable",
              "The requested native peer edge has not been observed as connected.",
            );
          value = yield* recordEvidence(key, {
            step: `peer:${index}`,
            kind: "native_peer",
            nativeTarget: source,
            peerTarget: target,
            peerEdgeId: edge.edgeId,
            observedAt: yield* now,
          });
        }
        for (const transition of input.transitions) {
          const successors = yield* Effect.forEach(transition.successors, resolve);
          for (const successor of successors) yield* observe(successor);
        }
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const current = (yield* load(key))!.value;
            if (current.status !== "pending") return current;
            // Publish independently owned agents and switch future routing together.
            // A native success before this commit remains recoverable through the intent.
            const creations: Array<SharedCompositionOperation["creations"][number]> = [];
            for (const definition of input.creations) {
              const retained = current.creations.find((entry) => entry.key === definition.key)!;
              const registered = yield* workspace.registerSpecialist(
                {
                  requestId: createRequestId(key, definition.key),
                  nativeTarget: retained.nativeTarget,
                  label: definition.label,
                  assignments: definition.assignments,
                },
                { operationKey: key, creationKey: definition.key },
              );
              creations.push({ ...retained, specialistId: registered.specialistId });
            }
            const lineage: Array<SharedCompositionOperation["lineage"][number]> =
              input.transitions.map((transition) => ({
                predecessorId: transition.predecessorId,
                successorIds: transition.successors.map((ref) =>
                  "specialistId" in ref
                    ? ref.specialistId
                    : creations.find((item) => item.key === ref.creationKey)!.specialistId!,
                ),
                superseded: transition.supersede,
              }));
            yield* workspace.applyCompositionAssignments(
              key,
              input.revisions,
              lineage,
              expectedTargets(input),
            );
            const completed: SharedCompositionOperation = {
              ...current,
              status: "completed",
              detail: null,
              creations,
              lineage,
              updatedAt: yield* now,
            };
            yield* persist(completed);
            yield* sql`DELETE FROM shared_composition_targets WHERE operation_key=${key}`;
            return completed;
          }),
        );
      });
      return yield* perform.pipe(
        Effect.catch((cause) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const current = (yield* load(key))!.value;
              if (current.status !== "pending") return current;
              // Never roll back created agents, native revisions, or edges after uncertain I/O.
              // Retained reservations keep retries on the original targets and definitions.
              const pending = { ...current, detail: failure(cause).message, updatedAt: yield* now };
              yield* persist(pending);
              return pending;
            }),
          ),
        ),
      );
    },
    execution.withPermits(1),
    Effect.mapError(failure),
  );
  const operation = Effect.fn("SharedComposition.operation")(function* (
    actor: SharedActor,
    operationId: string,
  ) {
    const key = yield* operationKey(actor, operationId);
    const retained = yield* load(key);
    if (!retained)
      return yield* fail("not_found", "Composition operation not found for this actor.");
    return retained.value;
  }, Effect.mapError(failure));
  const reserveRecoveryCandidate = Effect.fn("SharedComposition.reserveRecoveryCandidate")(
    function* () {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const progress = yield* sql<{ after_rowid: string; through_rowid: string }>`SELECT
        CAST(after_rowid AS TEXT) AS after_rowid, CAST(through_rowid AS TEXT) AS through_rowid
        FROM shared_composition_recovery WHERE singleton = 1`;
          let after = progress[0]?.after_rowid ?? "0";
          let through = progress[0]?.through_rowid ?? "0";
          if (BigInt(after) >= BigInt(through)) {
            const latest = yield* sql<{ through_rowid: string }>`SELECT
          CAST(COALESCE(MAX(rowid), 0) AS TEXT) AS through_rowid FROM shared_composition_operations`;
            after = "0";
            through = latest[0]!.through_rowid;
          }
          const candidates = yield* sql<{ operation_key: string; rowid_text: string }>`SELECT
        operation_key, CAST(rowid AS TEXT) AS rowid_text FROM shared_composition_operations
        WHERE json_extract(definition_json, '$.status') = 'pending'
          AND rowid > CAST(${after} AS INTEGER) AND rowid <= CAST(${through} AS INTEGER)
        ORDER BY rowid ASC LIMIT 2`;
          const next = candidates.length > 1 ? candidates[0]!.rowid_text : through;
          // Reserve one candidate before I/O. A timeout or restart cannot repeatedly
          // strand later operations, and new arrivals cannot extend this cycle forever.
          yield* sql`INSERT INTO shared_composition_recovery(singleton, after_rowid, through_rowid)
        VALUES (1, CAST(${next} AS INTEGER), CAST(${through} AS INTEGER))
        ON CONFLICT(singleton) DO UPDATE SET after_rowid = excluded.after_rowid,
          through_rowid = excluded.through_rowid`;
          return { candidate: candidates[0], cycleComplete: candidates.length < 2 };
        }),
      );
    },
  );
  const resume = Effect.fn("SharedComposition.resume")(function* (key: string) {
    const retained = yield* load(key);
    if (!retained || retained.value.status !== "pending") return;
    const saved = retained.value.actor;
    const actor: SharedActor =
      saved.kind === "specialist"
        ? { kind: "specialist", specialistId: saved.id }
        : { kind: "participant", participantId: saved.id };
    if (
      retained.value.operationKey !== key ||
      (yield* operationKey(actor, retained.input.operationId)) !== key ||
      retained.fingerprint !== sharedFingerprint(retained.input)
    )
      return yield* fail(
        "conflict",
        "The retained composition identity or intent is inconsistent.",
      );
    // Admission is the saved intent, not a new synthetic tool call. Reuse its actor,
    // exact requests and reservations. Responsibility activation still checks native
    // busy state and acknowledgement through projectAgentReviseShared.
    yield* execute(actor, retained.input);
  });
  const runOnce = Effect.gen(function* () {
    let attempted = 0;
    for (; attempted < 4;) {
      const { candidate, cycleComplete } = yield* reserveRecoveryCandidate();
      if (!candidate) break;
      attempted++;
      // A slow native observation must not monopolize all durable continuations.
      // Interrupted I/O leaves the original idempotent intent and evidence intact.
      yield* resume(candidate.operation_key).pipe(Effect.timeout("15 seconds"), Effect.ignore);
      if (cycleComplete) break;
    }
    return attempted;
  });
  const run = Effect.forever(
    runOnce.pipe(
      Effect.catch(() => Effect.logWarning("Shared composition continuation pass failed")),
      Effect.andThen(Effect.sleep("2 seconds")),
    ),
  );
  return { execute, operation, runOnce, run };
});

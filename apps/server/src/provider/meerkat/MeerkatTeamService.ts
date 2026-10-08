// @effect-diagnostics nodeBuiltinImport:off - opaque references hash native identity tuples.
import * as NodeCrypto from "node:crypto";
import { requireRestoreReviewReleased } from "../../restoreReview.ts";
import {
  MeerkatTeamError,
  MeerkatThreadConnectionsInput,
  MeerkatThreadConnectionsSetInput,
  type MeerkatThreadConnections,
  MeerkatProjectAgentCreateInput,
  MeerkatProjectAgentUpdateInput,
  MeerkatProjectAgentLifecycleInput,
  MeerkatAgentSendInput,
  MeerkatImageRef,
  ModelSelection,
  MeerkatAgentStopInput,
  MeerkatAgentLifecycleInput,
  type MeerkatAgentControlReceipt,
  type MeerkatProjectAgent,
  type ProviderOptionSelections,
  ThreadId,
  MeerkatAgentActivityInput,
  type ConsoleIdentityRecord,
  type MeerkatAgentActivity,
  type MeerkatProjectTeam,
  type MeerkatProjectTeamInput,
  type MeerkatTeamAgent,
  type MeerkatTeamProvider,
  type MeerkatPeerEndpoint,
  type MeerkatPeerConnectionsInput,
  type MeerkatPeerConnectionSetInput,
  type MeerkatPeerConnection,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { extractMeerkatConsoleSkillSelections } from "@t3tools/shared/meerkatSkills";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import {
  ProjectCloneTracker,
  requireProjectCloneReady,
} from "../../project/ProjectCloneTracker.ts";
import type { MeerkatTeamReader, MeerkatDomainDefinition } from "./MeerkatTeamReader.ts";
import { decodeMeerkatModel, meerkatProjectStateRoot } from "../Layers/MeerkatAdapter.ts";
import {
  agentFingerprint,
  agentMetadata,
  decodeAgentRevision,
  decodeAgentAssignment,
  storedRuntimeInstructions,
  storedModelOptions,
  specialistRuntimeInstructions,
  makeMeerkatProjectAgentStore,
  type MeerkatProjectAgentRow,
  type MeerkatProjectAgentAssignment,
  type PendingAgentRevision,
} from "./MeerkatProjectAgentStore.ts";

import { meerkatProviderParams } from "./MeerkatModelOptions.ts";
import { makeMeerkatObservedAgents } from "./MeerkatObservedAgents.ts";

import {
  makeMeerkatProjectProposalService,
  refreshAgentPreparation,
  validateAgentOwnership,
} from "./MeerkatProjectProposalService.ts";
import {
  makeMeerkatPeerConnections,
  peerEdgeId,
  peerEndpointKey,
  type ResolvedPeerEndpoint,
} from "./MeerkatPeerConnections.ts";

const MAX_SCOPES = 64;
// WebSocket handlers and the turn reactor construct separate service facades in one process.
// They must serialize control intent against the same live native provider runtimes.
const mutationLock = Semaphore.makeUnsafe(1);
const connecting = new Set<string>();
const encodeImages = Schema.encodeSync(Schema.fromJsonString(Schema.Array(MeerkatImageRef)));
const encodeModelSelection = Schema.encodeSync(Schema.fromJsonString(ModelSelection));
const encodeConnectionIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeAuthorityRevisions = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Number)),
);
const agentFingerprintForThread = (instanceId: string, threadId: string) =>
  NodeCrypto.createHash("sha256").update(`${instanceId}:${threadId}`).digest("hex");
const decodeActivityInput = Schema.decodeEffect(MeerkatAgentActivityInput);
const decodeCreateInput = Schema.decodeEffect(MeerkatProjectAgentCreateInput);
const decodeUpdateInput = Schema.decodeEffect(MeerkatProjectAgentUpdateInput);
const decodeLifecycleInput = Schema.decodeEffect(MeerkatProjectAgentLifecycleInput);
const decodeSendInput = Schema.decodeEffect(MeerkatAgentSendInput);
const decodeStopInput = Schema.decodeEffect(MeerkatAgentStopInput);
const decodeAgentLifecycleInput = Schema.decodeEffect(MeerkatAgentLifecycleInput);
const decodeConnectionsSetInput = Schema.decodeEffect(MeerkatThreadConnectionsSetInput);
const decodeRevisionReceipt = Schema.decodeUnknownEffect(
  Schema.Struct({ applied: Schema.Literal(true), revisionId: Schema.String }),
);
const decodePeerThreadSelection = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ instanceId: ProviderInstanceId })),
);
const encodeAgentTuple = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String))),
);
const ProjectRow = Schema.Array(Schema.Struct({ workspaceRoot: Schema.String }));
const ScopeRows = Schema.Array(
  Schema.Struct({
    worktreePath: Schema.String,
    total: Schema.Number,
  }),
);

interface ActivityTarget {
  readonly reader: MeerkatTeamReader;
  readonly projectPath: string;
  readonly stateRoot?: string;
  readonly projectAgentId?: string;
  readonly threadId?: ThreadId;
  readonly mobKind: string;
  readonly mobId: string;
  readonly record: ConsoleIdentityRecord;
  readonly ambiguous: boolean;
}

/** Project-owned definitions and controls. Observation never admits or restores runtimes. */
export const makeMeerkatTeamService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;
  const registry = yield* ProviderInstanceRegistry;
  const cloneTracker = yield* ProjectCloneTracker;
  const store = yield* makeMeerkatProjectAgentStore;
  const observedAgents = yield* makeMeerkatObservedAgents;
  const failure = (
    projectId: ProjectId,
    operation: MeerkatTeamError["operation"],
    cause: unknown,
  ) => {
    const error = new MeerkatTeamError({
      projectId,
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
    });
    // Keep native diagnostics in server traces without extending the public error payload.
    if (cause instanceof Error) Object.defineProperty(error, "cause", { value: cause });
    return error;
  };

  const readProject = Effect.fn("MeerkatTeam.readProject")(function* (projectId: ProjectId) {
    const rows = yield* sql`
      SELECT workspace_root AS "workspaceRoot" FROM projection_projects
      WHERE project_id = ${projectId} AND deleted_at IS NULL
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ProjectRow)),
      Effect.mapError((cause) => failure(projectId, "project-team", cause)),
    );
    const project = rows[0];
    if (!project) return yield* failure(projectId, "project-team", "Project not found.");
    return path.resolve(project.workspaceRoot);
  });

  const readScopes = Effect.fn("MeerkatTeam.readScopes")(function* (
    projectId: ProjectId,
    instanceId: ProviderInstanceId,
    workspaceRoot: string,
  ) {
    // Archived threads retain native bindings. Deleted threads and foreign provider instances do not.
    const rows = yield* sql`
      SELECT worktreePath, COUNT(*) OVER() AS total FROM (
        SELECT DISTINCT t.worktree_path AS worktreePath
        FROM projection_threads t JOIN provider_session_runtime r ON r.thread_id = t.thread_id
        WHERE t.project_id = ${projectId} AND t.deleted_at IS NULL
          AND r.provider_name = 'meerkat' AND r.provider_instance_id = ${instanceId}
          AND t.worktree_path IS NOT NULL AND t.worktree_path <> ${workspaceRoot}
        ORDER BY t.worktree_path
      ) LIMIT ${MAX_SCOPES}
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ScopeRows)),
      Effect.mapError((cause) => failure(projectId, "project-team", cause)),
    );
    const scopes = [
      ...new Set([workspaceRoot, ...rows.map((row) => path.resolve(row.worktreePath))]),
    ];
    const omitted = Math.max(0, (rows[0]?.total ?? 0) - rows.length);
    return {
      scopes: scopes.slice(0, MAX_SCOPES),
      total: scopes.length + omitted,
      truncated: omitted > 0 || scopes.length > MAX_SCOPES,
    };
  });

  const projectAgents = Effect.fn("MeerkatTeam.projectAgents")(function* (
    input: MeerkatProjectTeamInput,
  ) {
    yield* readProject(input.projectId);
    const rows = yield* store.list(input.projectId);
    const metadata = yield* Effect.forEach(rows, (row) =>
      agentMetadata(row).pipe(
        Effect.mapError((cause) => failure(input.projectId, "project-agent", cause)),
      ),
    );
    return {
      projectId: input.projectId,
      agents: rows.map((row, index): MeerkatProjectAgent => ({
        ...metadata[index],
        agentId: row.agent_id,
        projectId: input.projectId,
        instanceId: ProviderInstanceId.make(row.instance_id),
        label: row.label,
        role: row.role,
        instructions: row.instructions,
        model: row.model,
        accessMode: row.access_mode,
        enabled: Boolean(row.enabled),
        archived: Boolean(row.archived),
        connectionStatus: row.last_error
          ? "error"
          : !row.enabled || row.archived
            ? "disabled"
            : "unloaded",
        error: row.last_error,
        agentRef: null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    };
  });
  const readTeam = Effect.fn("MeerkatTeam.readTeam")(function* (
    projectId: ProjectId,
    observeWork = false,
  ) {
    const workspaceRoot = yield* readProject(projectId);
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    const savedAgents = yield* store.list(projectId);
    const metadata = yield* Effect.forEach(savedAgents, (row) =>
      agentMetadata(row).pipe(
        Effect.mapError((cause) => failure(projectId, "project-agent", cause)),
      ),
    );
    const projectAgents: Array<{
      -readonly [K in keyof MeerkatProjectAgent]: MeerkatProjectAgent[K];
    }> = savedAgents.map((row, index) => ({
      ...metadata[index],
      agentId: row.agent_id,
      projectId,
      instanceId: ProviderInstanceId.make(row.instance_id),
      label: row.label,
      role: row.role,
      instructions: row.instructions,
      model: row.model,
      accessMode: row.access_mode,
      enabled: Boolean(row.enabled),
      archived: Boolean(row.archived),
      connectionStatus:
        !row.enabled || row.archived
          ? "disabled"
          : connecting.has(row.agent_id)
            ? "connecting"
            : row.last_error
              ? "error"
              : "unloaded",
      error: row.last_error,
      agentRef: null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const instances = yield* registry.listInstances;
    const unavailable = yield* registry.listUnavailable;
    const providers: MeerkatTeamProvider[] = [];
    const targets = new Map<string, ActivityTarget>();
    for (const instance of instances.filter((candidate) => candidate.driverKind === "meerkat")) {
      const scopeSet = yield* readScopes(projectId, instance.instanceId, workspaceRoot);
      const threadRows =
        yield* sql`SELECT t.thread_id AS "threadId", t.worktree_path AS "worktreePath"
        FROM projection_threads t JOIN provider_session_runtime r ON r.thread_id = t.thread_id
        WHERE t.project_id = ${projectId} AND t.deleted_at IS NULL AND r.provider_name = 'meerkat'
          AND r.provider_instance_id = ${instance.instanceId}`.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Array(
                Schema.Struct({
                  threadId: Schema.String,
                  worktreePath: Schema.NullOr(Schema.String),
                }),
              ),
            ),
          ),
          Effect.mapError((cause) => failure(projectId, "project-team", cause)),
        );
      const threadOwners = new Map(
        threadRows.map((row) => [
          `t3-${agentFingerprintForThread(instance.instanceId, row.threadId)}`,
          {
            threadId: ThreadId.make(row.threadId),
            projectPath: path.resolve(row.worktreePath ?? workspaceRoot),
          },
        ]),
      );
      const domains = savedAgents.filter((row) => row.instance_id === instance.instanceId);
      const errors: string[] = scopeSet.truncated
        ? [`Only the first ${MAX_SCOPES} of ${scopeSet.total} execution scopes were observed.`]
        : [];
      const agents: MeerkatTeamAgent[] = [];
      let unloadedScopeCount = 0;
      let loadedMobCount = 0;
      let successfulReads = 0;
      const unloadedScopes = new Set<string>();
      const reader = instance.meerkatTeam;
      if (instance.enabled && reader) {
        // Sequential reads bound work and preserve each successful sibling on partial failure.
        const scopes: Array<{
          projectPath: string;
          stateRoot?: string;
          domain?: MeerkatProjectAgentRow;
        }> = [
          ...scopeSet.scopes.map((projectPath) => ({ projectPath })),
          ...domains
            .filter(
              (row) => row.enabled && !row.archived && row.provider_state_root === reader.stateRoot,
            )
            .map((domain) => ({
              projectPath: workspaceRoot,
              stateRoot: domain.state_root,
              domain,
            })),
        ];
        for (const domain of domains.filter(
          (row) => row.provider_state_root !== reader.stateRoot,
        )) {
          const projected = projectAgents.find((row) => row.agentId === domain.agent_id)!;
          projected.connectionStatus = "error";
          projected.error =
            "Provider storage changed. Restore the original provider configuration to access this agent.";
        }
        for (const { projectPath, stateRoot, domain } of scopes) {
          if (domain?.preparation_json) {
            const projected = projectAgents.find((row) => row.agentId === domain.agent_id)!;
            projected.preparation = yield* refreshAgentPreparation(
              store,
              domain,
              reader,
              projectPath,
            );
          }
          const scopeLabel = domain
            ? `Project agent: ${domain.label}`
            : projectPath === workspaceRoot
              ? "Project workspace"
              : `Worktree: ${path.basename(projectPath)}`;
          const snapshot = yield* reader.snapshot(projectPath, stateRoot).pipe(
            Effect.catch((cause) => {
              errors.push(`${scopeLabel}: ${cause.detail}`);
              const projected =
                domain && projectAgents.find((row) => row.agentId === domain.agent_id);
              if (projected) {
                projected.connectionStatus = "error";
                projected.error = cause.detail;
              }
              return Effect.void;
            }),
          );
          if (!snapshot) continue;
          successfulReads++;
          const scopeKey = encodeAgentTuple([projectPath, stateRoot ?? null]);
          if (!snapshot.loaded) {
            unloadedScopes.add(scopeKey);
            unloadedScopeCount++;
            continue;
          }
          loadedMobCount += snapshot.mobs.length;
          for (const mob of snapshot.mobs) {
            if (domain && mob.mobId !== domain.mob_id) continue;
            if (domain && (mob.accessMode === "read-only" || mob.accessMode === "full-access")) {
              const projected = projectAgents.find((row) => row.agentId === domain.agent_id)!;
              projected.accessMode = mob.accessMode;
            }
            if (mob.consoleStatus !== "ready") {
              errors.push(
                `${scopeLabel} / ${mob.label}: ${mob.error ?? `Console ${mob.consoleStatus}.`}`,
              );
              continue;
            }
            for (const record of mob.identities) {
              const agentRef = NodeCrypto.createHash("sha256")
                .update(
                  encodeAgentTuple([
                    projectId,
                    instance.instanceId,
                    reader.stateRoot,
                    stateRoot ?? null,
                    projectPath,
                    mob.mobId,
                    record.identity,
                    record.runtime_key,
                    record.labels.source_mob_id ?? null,
                    record.runtime_member_id,
                    record.session_id ?? null,
                  ]),
                )
                .digest("hex");
              const owner = threadOwners.get(mob.mobId);
              const ownerThread = owner?.projectPath === projectPath ? owner.threadId : undefined;
              const durableId = agentFingerprint([
                projectId,
                instance.instanceId,
                reader.stateRoot,
                stateRoot ?? "",
                projectPath,
                mob.mobId,
                record.identity,
                record.runtime_key,
                record.labels.source_mob_id ?? "",
                record.runtime_member_id,
              ]);
              const agent: MeerkatTeamAgent = {
                canResume:
                  !!record.labels.source_mob_id &&
                  !!mob.stoppedCrewIds?.includes(record.labels.source_mob_id),
                durableId,
                availability: record.visibility === "retired_readable" ? "retired" : "live",
                lastSeenAt: observedAt,
                work: { status: "unknown", observedAt },
                agentRef,
                mobId: mob.mobId,
                mobLabel: mob.label,
                mobKind: mob.kind,
                scopeLabel,
                ...(domain ? { projectAgentId: domain.agent_id } : {}),
                ...(ownerThread ? { threadId: ownerThread } : {}),
                record,
              };
              agents.push(agent);
              yield* observedAgents
                .save({
                  projectId,
                  instanceId: instance.instanceId,
                  providerStateRoot: reader.stateRoot,
                  projectPath,
                  ...(stateRoot ? { stateRoot } : {}),
                  agent,
                  observedAt,
                })
                .pipe(Effect.mapError((cause) => failure(projectId, "project-team", cause)));
              targets.set(`${instance.instanceId}:${agentRef}`, {
                reader,
                projectPath,
                ...(stateRoot ? { stateRoot } : {}),
                ...(domain ? { projectAgentId: domain.agent_id } : {}),
                ...(ownerThread ? { threadId: ownerThread } : {}),
                mobKind: mob.kind,
                mobId: mob.mobId,
                record,
                // Native consoleTimeline addresses an alias, not a worker incarnation.
                ambiguous:
                  mob.identities.filter((candidate) => candidate.identity === record.identity)
                    .length > 1,
              });
              if (
                domain &&
                record.identity === domain.agent_identity &&
                !record.labels.source_mob_id
              ) {
                const projected = projectAgents.find((row) => row.agentId === domain.agent_id)!;
                projected.connectionStatus = "connected";
                projected.agentRef = agentRef;
                projected.error = null;
              }
            }
          }
        }
      } else if (instance.enabled) {
        errors.push("This Meerkat provider does not expose Team observation.");
      }
      if (!instance.enabled || !reader) {
        for (const projected of projectAgents.filter(
          (row) => row.instanceId === instance.instanceId && row.enabled && !row.archived,
        )) {
          projected.connectionStatus = "error";
          projected.error = !instance.enabled
            ? "Meerkat provider is disabled."
            : "Meerkat provider is unavailable.";
        }
      }
      if (observeWork && reader?.work) {
        if (agents.length > 100)
          errors.push("Current work status is limited to the first 100 native agents.");
        yield* Effect.forEach(
          agents.slice(0, 100),
          (agent, index) =>
            Effect.gen(function* () {
              const target = targets.get(`${instance.instanceId}:${agent.agentRef}`);
              if (!target || target.ambiguous || agent.availability !== "live" || agent.canResume)
                return;
              const work = yield* reader.work!(target).pipe(
                Effect.catch(() => Effect.succeed({ status: "unknown" as const })),
              );
              agents[index] = {
                ...agent,
                work: { ...work, observedAt: DateTime.formatIso(yield* DateTime.now) },
              };
            }),
          { concurrency: 4 },
        );
      }
      const liveIds = new Set(agents.map((agent) => agent.durableId));
      const remembered = yield* observedAgents
        .list(projectId, instance.instanceId)
        .pipe(Effect.mapError((cause) => failure(projectId, "project-team", cause)));
      for (const row of remembered) {
        if (liveIds.has(row.durable_id)) continue;
        liveIds.add(row.durable_id);
        const scopeKey = encodeAgentTuple([row.project_path, row.state_root]);
        const sameStorage = reader?.stateRoot === row.provider_state_root;
        // A loaded owner can still lack a child crew after a restart. Absence
        // is not native retirement evidence.
        const availability =
          sameStorage && unloadedScopes.has(scopeKey)
            ? ("unloaded" as const)
            : sameStorage && row.agent.record.visibility === "retired_readable"
              ? ("retired" as const)
              : ("unknown" as const);
        agents.push({
          ...row.agent,
          canResume: false,
          availability,
          lastSeenAt: row.last_seen_at,
          record: { ...row.agent.record, addressable: false },
          work: { status: availability === "unloaded" ? "unloaded" : "unknown", observedAt },
        });
      }
      providers.push({
        instanceId: instance.instanceId,
        label: instance.displayName ?? "Meerkat MobKit",
        status: !instance.enabled
          ? "disabled"
          : successfulReads === 0
            ? "unavailable"
            : errors.length
              ? "partial"
              : "ready",
        errors,
        totalScopeCount:
          scopeSet.total + domains.filter((row) => row.enabled && !row.archived).length,
        unloadedScopeCount,
        loadedMobCount,
        agents,
      });
    }
    for (const instance of unavailable.filter((candidate) => candidate.driver === "meerkat")) {
      const remembered = yield* observedAgents
        .list(projectId, instance.instanceId)
        .pipe(Effect.mapError((cause) => failure(projectId, "project-team", cause)));
      const durableIds = new Set<string>();
      const dormant: MeerkatTeamAgent[] = [];
      for (const row of remembered) {
        if (durableIds.has(row.durable_id)) continue;
        durableIds.add(row.durable_id);
        dormant.push({
          ...row.agent,
          availability: "unknown",
          record: { ...row.agent.record, addressable: false },
          work: { status: "unknown", observedAt },
        });
      }
      for (const projected of projectAgents.filter(
        (row) => row.instanceId === instance.instanceId && row.enabled && !row.archived,
      )) {
        projected.connectionStatus = "error";
        projected.error = instance.message ?? "Meerkat provider is unavailable.";
      }
      providers.push({
        instanceId: instance.instanceId,
        label: instance.displayName ?? "Meerkat MobKit",
        status: instance.enabled ? "unavailable" : "disabled",
        errors: instance.enabled ? [instance.message ?? "Meerkat provider is unavailable."] : [],
        totalScopeCount: 0,
        unloadedScopeCount: 0,
        loadedMobCount: 0,
        agents: dormant,
      });
    }
    const team: MeerkatProjectTeam = {
      projectId,
      observation: "loaded_runtimes",
      observedAt,
      providers,
      projectAgents,
    };
    return { team, targets };
  });

  const projectTeam = Effect.fn("MeerkatTeam.projectTeam")(function* (
    input: MeerkatProjectTeamInput,
  ) {
    return (yield* readTeam(input.projectId, true)).team;
  });
  const agentActivity = Effect.fn("MeerkatTeam.agentActivity")(function* (
    input: MeerkatAgentActivityInput,
  ): Effect.fn.Return<MeerkatAgentActivity, MeerkatTeamError> {
    const validated = yield* decodeActivityInput(input).pipe(
      Effect.mapError((cause) => failure(input.projectId, "agent-activity", cause)),
    );
    if (validated.transcriptBefore !== undefined && validated.transcriptRevision === undefined)
      return yield* failure(
        validated.projectId,
        "agent-activity",
        "A saved transcript page requires its native revision. Refresh the conversation first.",
      );
    const { targets, team } = yield* readTeam(validated.projectId).pipe(
      Effect.mapError((cause) => failure(validated.projectId, "agent-activity", cause)),
    );
    let target = targets.get(`${validated.instanceId}:${validated.agentRef}`);
    let historical = false;
    let activityAgent = team.providers
      .find((provider) => provider.instanceId === validated.instanceId)
      ?.agents.find((agent) => agent.agentRef === validated.agentRef);
    if (activityAgent?.availability === "retired") target = undefined;
    if (!target) {
      const saved = (yield* observedAgents
        .list(validated.projectId, validated.instanceId, validated.agentRef)
        .pipe(
          Effect.mapError((cause) => failure(validated.projectId, "agent-activity", cause)),
        ))[0];
      const instance = (yield* registry.listInstances).find(
        (candidate) =>
          candidate.instanceId === validated.instanceId && candidate.driverKind === "meerkat",
      );
      if (
        saved &&
        instance?.enabled &&
        instance.meerkatTeam?.stateRoot === saved.provider_state_root
      ) {
        target = {
          reader: instance.meerkatTeam,
          projectPath: saved.project_path,
          ...(saved.state_root ? { stateRoot: saved.state_root } : {}),
          mobKind: saved.agent.mobKind,
          mobId: saved.agent.mobId,
          record: saved.agent.record,
          ambiguous: false,
        };
        historical = true;
        activityAgent = {
          ...saved.agent,
          canResume: false,
          availability: activityAgent?.availability ?? "retired",
          record: { ...saved.agent.record, addressable: false },
          work: { status: "unknown", observedAt: DateTime.formatIso(yield* DateTime.now) },
        };
      }
    }
    // A saved page remains bound to its native session revision even if the
    // owner reconnects while the user is paging through the conversation.
    if (validated.transcriptBefore !== undefined || validated.transcriptRevision !== undefined)
      historical = true;
    if (!target)
      return yield* failure(
        validated.projectId,
        "agent-activity",
        "Agent is not in this project's current ready roster.",
      );
    if (target.ambiguous)
      return yield* failure(
        validated.projectId,
        "agent-activity",
        "Native activity is ambiguous because multiple workers share this identity.",
      );
    if (historical && !target.reader.history)
      return yield* failure(
        validated.projectId,
        "agent-activity",
        "This provider cannot read an unloaded worker session. Reconnect its owning thread or project agent to continue.",
      );
    const query = {
      projectPath: target.projectPath,
      ...(target.stateRoot ? { stateRoot: target.stateRoot } : {}),
      mobId: target.mobId,
      identity: target.record.identity,
      record: target.record,
      limit: validated.limit ?? 50,
      ...(validated.before ? { before: validated.before } : {}),
      ...(validated.after ? { after: validated.after } : {}),
      ...(validated.mode ? { mode: validated.mode } : {}),
      ...(validated.transcriptBefore !== undefined
        ? { transcriptBefore: validated.transcriptBefore }
        : {}),
      ...(validated.transcriptRevision ? { transcriptRevision: validated.transcriptRevision } : {}),
    };
    const history = yield* (
      historical
        ? target.reader.history!(query)
        : target.reader.history
          ? Effect.all(
              {
                timeline: target.reader.activity(query),
                saved: target.reader.history(query),
              },
              { concurrency: 2 },
            ).pipe(
              // Saved messages and live events have separate native authorities.
              // Reconnection must refresh both without substituting saved frames
              // for the live console timeline.
              Effect.map(({ timeline, saved }) => ({ ...saved, timeline })),
            )
          : target.reader.activity(query).pipe(Effect.map((timeline) => ({ timeline })))
    ).pipe(Effect.mapError((cause) => failure(validated.projectId, "agent-activity", cause)));
    return {
      projectId: validated.projectId,
      instanceId: validated.instanceId,
      agentRef: validated.agentRef,
      observedAt: DateTime.formatIso(yield* DateTime.now),
      ...history,
      ...(activityAgent ? { agent: activityAgent } : {}),
    };
  });
  const providerForAgent = Effect.fn("MeerkatTeam.providerForAgent")(function* (
    projectId: ProjectId,
    instanceId: ProviderInstanceId,
  ) {
    const instance = (yield* registry.listInstances).find(
      (item) => item.instanceId === instanceId && item.driverKind === "meerkat",
    );
    if (!instance?.enabled || !instance.meerkatTeam)
      return yield* failure(
        projectId,
        "project-agent",
        "Meerkat provider is unavailable or disabled.",
      );
    return { instance, reader: instance.meerkatTeam };
  });
  const definition = (
    row: MeerkatProjectAgentRow,
    projectPath: string,
  ): MeerkatDomainDefinition => {
    const options = storedModelOptions(row);
    return {
      projectPath,
      stateRoot: row.state_root,
      mobId: row.mob_id,
      identity: row.agent_identity,
      label: row.label,
      role: row.role,
      instructions: storedRuntimeInstructions(row),
      model: row.model,
      ...(options === undefined ? {} : { options }),
      accessMode: row.access_mode,
    };
  };
  const requireAgentModel = Effect.fn("MeerkatTeam.requireAgentModel")(function* (input: {
    projectId: ProjectId;
    operation: MeerkatTeamError["operation"];
    instance: ProviderInstance;
    projectPath: string;
    model: string;
    options?: ProviderOptionSelections;
  }) {
    const catalog = yield* (
      input.instance.snapshotForCwd
        ? input.instance.snapshotForCwd(input.projectPath)
        : input.instance.snapshot.getSnapshot
    ).pipe(Effect.mapError((cause) => failure(input.projectId, input.operation, cause)));
    if (
      (catalog.supportsWorkspaceReadiness === true && !input.instance.snapshotForCwd) ||
      catalog.status === "error" ||
      catalog.status === "disabled" ||
      catalog.installed === false ||
      catalog.enabled === false ||
      catalog.availability === "unavailable"
    )
      return yield* failure(
        input.projectId,
        input.operation,
        "Could not check this workspace's Meerkat models. Refresh the provider and try again.",
      );
    const model = catalog.models.find((candidate) => candidate.slug === input.model);
    if (!model)
      return yield* failure(
        input.projectId,
        input.operation,
        "Choose a model from this workspace's current Meerkat catalog.",
      );
    const selectedIds = new Set<string>();
    for (const { id, value } of input.options ?? []) {
      if (selectedIds.has(id))
        return yield* failure(
          input.projectId,
          input.operation,
          "Choose each model option only once.",
        );
      selectedIds.add(id);
      // Caching is owned by native defaults, including values saved by older clients.
      if (id === "prompt_cache_enabled") continue;
      const descriptor = model.capabilities?.optionDescriptors?.find((option) => option.id === id);
      if (
        !descriptor ||
        (descriptor.type === "select"
          ? value !== "default" && !descriptor.options.some((option) => option.id === value)
          : typeof value !== "boolean")
      )
        return yield* failure(
          input.projectId,
          input.operation,
          "Choose reasoning options from this workspace's current Meerkat model.",
        );
    }
    yield* Effect.try({
      try: () => {
        decodeMeerkatModel(input.model);
        return meerkatProviderParams(input.options);
      },
      catch: (cause) => failure(input.projectId, input.operation, cause),
    });
    if (
      model.credentialState === "needs_auth" ||
      model.credentialState === "reauth_required" ||
      (catalog.auth?.status === "unauthenticated" &&
        model.credentialState !== "connected" &&
        model.credentialState !== "host_managed")
    )
      return yield* failure(
        input.projectId,
        input.operation,
        "Connect this model's account for this workspace before starting new work.",
      );
  });
  const projection = Effect.fn("MeerkatTeam.projection")(function* (
    projectId: ProjectId,
    agentId: string,
  ) {
    const result = (yield* readTeam(projectId)).team.projectAgents.find(
      (row) => row.agentId === agentId,
    );
    if (!result) return yield* failure(projectId, "project-agent", "Project agent not found.");
    return result;
  });
  const connect = Effect.fn("MeerkatTeam.connect")(function* (
    projectId: ProjectId,
    row: MeerkatProjectAgentRow,
    reconcilePeers = true,
  ): Effect.fn.Return<MeerkatProjectAgent, MeerkatTeamError> {
    const projectPath = yield* readProject(projectId);
    const { reader } = yield* providerForAgent(projectId, ProviderInstanceId.make(row.instance_id));
    if (reader.stateRoot !== row.provider_state_root)
      return yield* failure(
        projectId,
        "project-agent",
        "Provider storage changed. Restore its original configuration before connecting.",
      );
    if (!reader.connectDomain)
      return yield* failure(
        projectId,
        "project-agent",
        "This provider cannot connect project agents.",
      );
    connecting.add(row.agent_id);
    yield* store.update(projectId, row.agent_id, { enabled: true, error: null });
    yield* reader.connectDomain(definition(row, projectPath)).pipe(
      Effect.catch((cause) => store.update(projectId, row.agent_id, { error: cause.detail })),
      Effect.ensuring(Effect.sync(() => connecting.delete(row.agent_id))),
    );
    if (reconcilePeers)
      yield* peers.apply({
        kind: "project-agent",
        projectId,
        instanceId: ProviderInstanceId.make(row.instance_id),
        agentId: row.agent_id,
      });
    return yield* projection(projectId, row.agent_id);
  });
  const projectAgentCreate = Effect.fn("MeerkatTeam.projectAgentCreate")(function* (
    raw: MeerkatProjectAgentCreateInput,
  ) {
    const input = yield* decodeCreateInput(raw).pipe(
      Effect.mapError((cause) => failure(raw.projectId, "project-agent", cause)),
    );
    const projectPath = yield* readProject(input.projectId);
    if (
      !/^[a-z][a-z0-9-]{0,79}$/.test(input.role) ||
      ["ingress", "thread", "user", "assistant", "system"].includes(input.role)
    )
      return yield* failure(
        input.projectId,
        "project-agent",
        "Choose a lowercase role using letters, numbers and hyphens, excluding reserved thread roles.",
      );
    yield* Effect.try({
      try: () => decodeMeerkatModel(input.model),
      catch: (cause) => failure(input.projectId, "project-agent", cause),
    });
    const { instance, reader } = yield* providerForAgent(input.projectId, input.instanceId);
    const providerStateRoot = reader.stateRoot;
    const previous = yield* Effect.gen(function* () {
      const existing = (yield* store.list(input.projectId)).find(
        (row) => row.instance_id === input.instanceId && row.request_id === input.requestId,
      );
      if (!existing) return undefined;
      // The store validates the immutable request and storage identity on retries.
      const result = yield* store.create(input, providerStateRoot);
      return yield* projection(input.projectId, result.row.agent_id);
    }).pipe(mutationLock.withPermits(1));
    if (previous) return previous;
    // Workspace discovery must not hold up Stop or claim a creation that cannot start.
    yield* requireAgentModel({
      projectId: input.projectId,
      operation: "project-agent",
      instance,
      projectPath,
      model: input.model,
      ...(input.options === undefined ? {} : { options: input.options }),
    });
    return yield* Effect.gen(function* () {
      const current = yield* providerForAgent(input.projectId, input.instanceId);
      if (
        current.instance !== instance ||
        current.reader.stateRoot !== providerStateRoot ||
        (yield* readProject(input.projectId)) !== projectPath
      )
        return yield* failure(
          input.projectId,
          "project-agent",
          "The project or provider changed while checking this model. Refresh before creating the agent.",
        );
      const result = yield* store.create(input, providerStateRoot);
      if (!result.created) return yield* projection(input.projectId, result.row.agent_id);
      return yield* connect(input.projectId, result.row);
    }).pipe(mutationLock.withPermits(1));
  });
  const applyPendingRevision = Effect.fn("MeerkatTeam.applyPendingRevision")(function* (
    projectId: ProjectId,
    row: MeerkatProjectAgentRow,
  ) {
    if (!row.pending_revision_json) return row;
    const pending = yield* decodeAgentRevision(row.pending_revision_json).pipe(
      Effect.mapError((cause) => failure(projectId, "project-agent", cause)),
    );
    const applied = yield* Effect.gen(function* () {
      if (!row.enabled || row.archived)
        return yield* failure(
          projectId,
          "project-agent",
          "Connect this agent before applying its saved responsibilities.",
        );
      const projectPath = yield* readProject(projectId);
      const { instance, reader } = yield* providerForAgent(
        projectId,
        ProviderInstanceId.make(row.instance_id),
      );
      if (reader.stateRoot !== row.provider_state_root || !instance.meerkatControls)
        return yield* failure(
          projectId,
          "project-agent",
          "The original provider with responsibility revision support is required.",
        );
      const snapshot = yield* reader
        .snapshot(projectPath, row.state_root)
        .pipe(Effect.mapError((cause) => failure(projectId, "project-agent", cause)));
      const record = snapshot.mobs
        .find((mob) => mob.mobId === row.mob_id)
        ?.identities.find(
          (member) => member.identity === row.agent_identity && !member.labels.source_mob_id,
        );
      if (!record || !reader.busy)
        return yield* failure(
          projectId,
          "project-agent",
          "Connect the agent to apply responsibilities at an idle boundary.",
        );
      const busy = yield* reader
        .busy({ projectPath, stateRoot: row.state_root, mobId: row.mob_id, record })
        .pipe(Effect.mapError((cause) => failure(projectId, "project-agent", cause)));
      if (busy)
        return yield* failure(
          projectId,
          "project-agent",
          "Responsibilities saved. Apply them when the agent finishes its current work.",
        );
      const response = yield* Effect.tryPromise({
        try: () =>
          instance.meerkatControls!.request("mobs.v1.domainRevise", {
            projectPath,
            stateRoot: row.state_root,
            mobId: row.mob_id,
            identity: row.agent_identity,
            instructions: specialistRuntimeInstructions(pending.instructions, pending.assignment),
            revisionId: pending.revisionId,
          }),
        catch: (cause) => failure(projectId, "project-agent", cause),
      });
      const receipt = yield* decodeRevisionReceipt(response).pipe(
        Effect.mapError(() =>
          failure(
            projectId,
            "project-agent",
            "Native revision acknowledgement is unavailable. The revision remains pending; retry the same saved revision.",
          ),
        ),
      );
      if (receipt.revisionId !== pending.revisionId)
        return yield* failure(
          projectId,
          "project-agent",
          "Native acknowledgement belongs to another responsibility revision.",
        );
      return yield* store
        .applyRevision(projectId, row.agent_id, pending)
        .pipe(Effect.mapError((cause) => failure(projectId, "project-agent", cause)));
    }).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          yield* store.saveRevision(projectId, row.agent_id, { ...pending, error: cause.message });
          return yield* store.get(projectId, row.agent_id);
        }),
      ),
    );
    return applied;
  });
  const revise = Effect.fn("MeerkatTeam.reviseResponsibilities")(function* (
    projectId: ProjectId,
    row: MeerkatProjectAgentRow,
    assignment: MeerkatProjectAgentAssignment,
    instructions: string,
    requestId: string,
  ) {
    if (row.archived)
      return yield* failure(
        projectId,
        "project-agent",
        "Restore this agent before revising its responsibilities.",
      );
    const projectPath = yield* readProject(projectId);
    yield* Effect.tryPromise({
      try: () => validateAgentOwnership(projectPath, assignment.ownershipPaths),
      catch: (cause) => failure(projectId, "project-agent", cause),
    });
    const revisionId = `revision-${agentFingerprint([row.agent_id, requestId])}`;
    const previous =
      yield* sql`SELECT instructions,assignment_json FROM meerkat_project_agent_revisions WHERE agent_id=${row.agent_id} AND revision_id=${revisionId}`.pipe(
        Effect.mapError((cause) => failure(projectId, "project-agent", cause)),
      );
    if (previous.length) {
      const oldAssignment = yield* decodeAgentAssignment(String(previous[0]?.assignment_json)).pipe(
        Effect.mapError((cause) => failure(projectId, "project-agent", cause)),
      );
      if (
        previous[0]?.instructions !== instructions ||
        oldAssignment.fingerprint !== assignment.fingerprint
      )
        return yield* failure(
          projectId,
          "project-agent",
          "This revision request was already used with different responsibilities.",
        );
      return row;
    }
    if (row.pending_revision_json) {
      const existing = yield* decodeAgentRevision(row.pending_revision_json).pipe(
        Effect.mapError((cause) => failure(projectId, "project-agent", cause)),
      );
      if (
        existing.revisionId !== revisionId ||
        existing.instructions !== instructions ||
        existing.assignment.fingerprint !== assignment.fingerprint
      )
        return yield* failure(
          projectId,
          "project-agent",
          "Apply the saved responsibility revision before creating another revision.",
        );
    } else {
      const pending: PendingAgentRevision = {
        revisionId,
        requestId,
        version: row.revision_version + 1,
        instructions,
        focus: assignment.focus,
        charter: assignment.charter,
        ownershipPaths: assignment.ownershipPaths,
        assignment,
        error: null,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* store.saveRevision(projectId, row.agent_id, pending);
    }
    return yield* applyPendingRevision(projectId, yield* store.get(projectId, row.agent_id));
  });
  const projectAgentUpdate = Effect.fn("MeerkatTeam.projectAgentUpdate")(function* (
    raw: MeerkatProjectAgentUpdateInput,
  ) {
    const input = yield* decodeUpdateInput(raw).pipe(
      Effect.mapError((cause) => failure(raw.projectId, "project-agent", cause)),
    );
    yield* readProject(input.projectId);
    let row = yield* store.update(
      input.projectId,
      input.agentId,
      input.label ? { label: input.label } : {},
    );
    const oldVersion = row.revision_version;
    if (input.revision) {
      const revision = input.revision;
      const fingerprint = agentFingerprint([
        "1",
        row.role,
        revision.focus,
        revision.charter,
        ...revision.ownershipPaths.toSorted(),
      ]);
      row = yield* revise(
        input.projectId,
        row,
        {
          sourceThreadId: "manual",
          proposalId: "manual",
          candidateId: row.role,
          focus: revision.focus,
          charter: revision.charter,
          ownershipPaths: revision.ownershipPaths,
          assignmentId: `domain-recon-${row.role}-${fingerprint.slice(0, 16)}`,
          fingerprint,
        },
        revision.instructions,
        revision.requestId,
      );
    } else if (input.applyPending) row = yield* applyPendingRevision(input.projectId, row);
    if (row.revision_version !== oldVersion)
      yield* proposal
        .prepareUnlocked({ projectId: input.projectId, agentId: row.agent_id, refresh: true })
        .pipe(
          Effect.catch((cause) =>
            store.update(input.projectId, row.agent_id, {
              error: `Responsibilities applied; study needs retry: ${cause.message}`,
            }),
          ),
        );
    return yield* projection(input.projectId, input.agentId);
  }, mutationLock.withPermits(1));
  const projectAgentLifecycle = Effect.fn("MeerkatTeam.projectAgentLifecycle")(function* (
    raw: MeerkatProjectAgentLifecycleInput,
  ) {
    const input = yield* decodeLifecycleInput(raw).pipe(
      Effect.mapError((cause) => failure(raw.projectId, "project-agent", cause)),
    );
    const projectPath = yield* readProject(input.projectId);
    const row = yield* store.get(input.projectId, input.agentId);
    if (input.action === "connect") {
      if (row.archived)
        return yield* failure(
          input.projectId,
          "project-agent",
          "Unarchive this agent before connecting.",
        );
      return yield* connect(input.projectId, row);
    }
    if (input.action === "unarchive") {
      yield* store.update(input.projectId, input.agentId, {
        archived: false,
        enabled: false,
        error: null,
      });
      return yield* projection(input.projectId, input.agentId);
    }
    const { reader } = yield* providerForAgent(
      input.projectId,
      ProviderInstanceId.make(row.instance_id),
    );
    if (reader.stateRoot !== row.provider_state_root || !reader.disconnectDomain)
      return yield* failure(
        input.projectId,
        "project-agent",
        "Original provider storage is required to disconnect this agent.",
      );
    const endpoint: MeerkatPeerEndpoint = {
      kind: "project-agent",
      projectId: input.projectId,
      instanceId: ProviderInstanceId.make(row.instance_id),
      agentId: row.agent_id,
    };
    const existingEdges = (yield* peers.list({ endpoint })).connections;
    // Intent is durable before native teardown; errors remain visible and can be retried.
    yield* Effect.gen(function* () {
      yield* store.update(input.projectId, input.agentId, {
        enabled: false,
        archived: Boolean(row.archived) || input.action === "archive",
        error: null,
      });
      if (input.action === "archive") {
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`UPDATE meerkat_thread_connections SET agent_ids_json=(
          SELECT COALESCE(json_group_array(value),'[]') FROM json_each(agent_ids_json) WHERE value <> ${row.agent_id}
        ), updated_at=${now} WHERE project_id=${input.projectId} AND instance_id=${row.instance_id}`;
        yield* sql`UPDATE meerkat_peer_connections SET desired=0,updated_at=${now}
          WHERE source_key=${peerEndpointKey(endpoint)} OR target_key=${peerEndpointKey(endpoint)}`;
      }
    }).pipe(
      sql.withTransaction,
      Effect.mapError((cause) => failure(input.projectId, "project-agent", cause)),
    );
    // Resolve the saved endpoints even though the product agent is now paused. This removes
    // live routing before unload, without silently resuming another paused peer.
    for (const edge of existingEdges) {
      const cleanup = Effect.gen(function* () {
        const a = yield* resolvePeer(edge.source, true);
        const b = yield* resolvePeer(edge.target, true);
        if (!a.record || !b.record || !a.reader.topology || !a.reader.wire) return;
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
        const topology = yield* a.reader
          .topology(params)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(topologySchema)));
        yield* a.reader.wire(
          {
            ...params,
            expectedRevisions: topology.snapshot.authority_revisions,
            idempotencyKey: agentFingerprint([
              edge.edgeId,
              input.action,
              encodeAuthorityRevisions(topology.snapshot.authority_revisions),
            ]),
          },
          false,
        );
      });
      yield* cleanup.pipe(
        Effect.catch((cause) =>
          store.update(input.projectId, row.agent_id, {
            error: `Connection cleanup needs retry: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
        ),
      );
    }
    yield* Effect.gen(function* () {
      const native = yield* reader.snapshot(projectPath, row.state_root);
      if (native.mobs.some((mob) => mob.mobId === row.mob_id))
        yield* reader.disconnectDomain!(definition(row, projectPath));
    }).pipe(
      Effect.catch((cause) =>
        store.update(input.projectId, input.agentId, {
          error: `Agent cleanup needs retry: ${cause.detail}`,
        }),
      ),
    );
    return yield* projection(input.projectId, input.agentId);
  }, mutationLock.withPermits(1));
  const interactionTarget = Effect.fn("MeerkatTeam.interactionTarget")(function* (input: {
    projectId: ProjectId;
    instanceId: ProviderInstanceId;
    agentRef?: string;
    threadId?: ThreadId;
  }) {
    if (Boolean(input.agentRef) === Boolean(input.threadId))
      return yield* failure(
        input.projectId,
        "agent-control",
        "Choose exactly one agent or thread target.",
      );
    const { targets, team } = yield* readTeam(input.projectId);
    const matches = input.agentRef
      ? [targets.get(`${input.instanceId}:${input.agentRef}`)].filter(
          (value): value is ActivityTarget => value !== undefined,
        )
      : (team.providers.find((provider) => provider.instanceId === input.instanceId)?.agents ?? [])
          .filter(
            (agent) =>
              agent.threadId === input.threadId &&
              agent.mobKind === "thread" &&
              agent.record.runtime_member_id === "ingress" &&
              !agent.record.labels.source_mob_id,
          )
          .flatMap((agent) => {
            const target = targets.get(`${input.instanceId}:${agent.agentRef}`);
            return target ? [target] : [];
          });
    const target = matches[0];
    if (
      matches.length !== 1 ||
      !target ||
      target.ambiguous ||
      !target.record.addressable ||
      target.record.visibility !== "addressable"
    )
      return yield* failure(
        input.projectId,
        "agent-control",
        "This conversation is not an unambiguous live native target.",
      );
    return target;
  });
  const controlTarget = Effect.fn("MeerkatTeam.controlTarget")(function* (input: {
    projectId: ProjectId;
    instanceId: ProviderInstanceId;
    agentRef: string;
  }) {
    const { targets } = yield* readTeam(input.projectId);
    const target = targets.get(`${input.instanceId}:${input.agentRef}`);
    if (
      !target ||
      target.ambiguous ||
      !target.record.addressable ||
      target.record.visibility !== "addressable"
    )
      return yield* failure(
        input.projectId,
        "agent-control",
        "This agent is not an unambiguous addressable member of the current project roster.",
      );
    if (
      target.mobKind === "thread" &&
      target.record.runtime_member_id === "ingress" &&
      !target.record.labels.source_mob_id
    )
      return yield* failure(
        input.projectId,
        "agent-control",
        "Use the thread conversation to message or stop its coordinator.",
      );
    return target;
  });
  const queueTarget = Effect.fn("MeerkatTeam.queueTarget")(function* (input: {
    projectId: ProjectId;
    instanceId: ProviderInstanceId;
    durableId: string;
  }) {
    const { team, targets } = yield* readTeam(input.projectId);
    const agent = team.providers
      .find((provider) => provider.instanceId === input.instanceId)
      ?.agents.find(
        (candidate) => candidate.durableId === input.durableId && candidate.availability === "live",
      );
    const target = agent ? targets.get(`${input.instanceId}:${agent.agentRef}`) : undefined;
    if (
      !agent ||
      !target ||
      target.ambiguous ||
      !target.record.addressable ||
      target.record.visibility !== "addressable"
    )
      return yield* failure(input.projectId, "agent-control", "The native agent is not available.");
    if (agent.projectAgentId) {
      const definition = team.projectAgents.find(
        (candidate) => candidate.agentId === agent.projectAgentId,
      );
      if (!definition?.enabled || definition.archived)
        return yield* failure(
          input.projectId,
          "agent-control",
          "Connect this specialist before queued work continues.",
        );
    }
    return { agent, target };
  });
  const agentSend = Effect.fn("MeerkatTeam.agentSend")(function* (raw: MeerkatAgentSendInput) {
    const input = yield* decodeSendInput(raw).pipe(
      Effect.mapError((cause) => failure(raw.projectId, "agent-control", cause)),
    );
    const messageText = projectComposerContextForProvider({
      text: input.text,
      records: input.context?.records ?? [],
    });
    yield* Effect.try({
      try: () => extractMeerkatConsoleSkillSelections(input.text, input.handlingMode),
      catch: (cause) => failure(input.projectId, "agent-control", cause),
    });
    const target = yield* controlTarget(input);
    const providerStateRoot = target.reader.stateRoot;
    if (!target.reader.send)
      return yield* failure(
        input.projectId,
        "agent-control",
        "This provider cannot send to agents.",
      );
    const selectionKey = input.modelSelection ? encodeModelSelection(input.modelSelection) : "";
    if (!input.text.trim() && !input.images?.length)
      return yield* failure(input.projectId, "agent-control", "A message needs text or an image.");
    const imagesKey = encodeImages(input.images ?? []);
    const fingerprint = agentFingerprint([
      input.agentRef,
      messageText,
      input.handlingMode,
      selectionKey,
      imagesKey,
    ]);
    const stableFingerprint = agentFingerprint([
      input.projectId,
      input.instanceId,
      providerStateRoot,
      target.stateRoot ?? "",
      target.projectPath,
      target.mobId,
      target.record.identity,
      target.record.runtime_key,
      target.record.labels.source_mob_id ?? "",
      messageText,
      input.handlingMode,
      selectionKey,
      imagesKey,
    ]);
    const claimDelivery = () =>
      store.claimDelivery(
        input.projectId,
        input.instanceId,
        input.requestId,
        fingerprint,
        stableFingerprint,
      );
    const existingReceipt = yield* Effect.gen(function* () {
      if (!(yield* store.delivery(input.projectId, input.instanceId, input.requestId)))
        return undefined;
      const claim = yield* claimDelivery();
      if (claim.receipt.status === "uncertain")
        return yield* agentDeliveryReconcileUnlocked(input).pipe(
          Effect.map((receipt) => receipt ?? claim.receipt),
          Effect.orElseSucceed(() => claim.receipt),
        );
      return claim.receipt;
    }).pipe(mutationLock.withPermits(1));
    if (existingReceipt) return existingReceipt;

    if (input.modelSelection) {
      if (input.handlingMode !== "queue")
        return yield* failure(
          input.projectId,
          "agent-control",
          "Model changes apply only to queued turns, not steering.",
        );
      if (input.modelSelection.instanceId !== input.instanceId)
        return yield* failure(
          input.projectId,
          "agent-control",
          "Choose a model from this agent's provider instance.",
        );
      const { instance } = yield* providerForAgent(input.projectId, input.instanceId);
      yield* requireAgentModel({
        projectId: input.projectId,
        operation: "agent-control",
        instance,
        projectPath: target.projectPath,
        model: input.modelSelection.model,
      });
      yield* Effect.try({
        try: () => {
          meerkatProviderParams(input.modelSelection!.options);
          return decodeMeerkatModel(input.modelSelection!.model);
        },
        catch: (cause) => failure(input.projectId, "agent-control", cause),
      });
    }
    const sendInput = {
      ...target,
      text: messageText,
      skillSelectionText: input.text,
      ...(input.images ? { images: input.images } : {}),
      handlingMode: input.handlingMode,
      requestId: input.requestId,
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
    };
    // Catalog reads are definite preflight, not native admission. Keep them
    // outside the shared mutation permit so they cannot delay another Stop.
    const prepared = target.reader.prepareSend
      ? yield* target.reader
          .prepareSend(sendInput)
          .pipe(Effect.mapError((cause) => failure(input.projectId, "agent-control", cause.detail)))
      : { dispatch: () => target.reader.send!(sendInput) };
    return yield* Effect.gen(function* () {
      const current = yield* controlTarget(input);
      if (
        current.reader !== target.reader ||
        current.reader.stateRoot !== providerStateRoot ||
        current.projectPath !== target.projectPath ||
        current.stateRoot !== target.stateRoot ||
        current.mobId !== target.mobId ||
        current.record.identity !== target.record.identity ||
        current.record.runtime_key !== target.record.runtime_key ||
        current.record.runtime_member_id !== target.record.runtime_member_id ||
        current.record.session_id !== target.record.session_id ||
        current.record.labels.source_mob_id !== target.record.labels.source_mob_id
      )
        return yield* failure(
          input.projectId,
          "agent-control",
          "The agent changed while preparing this message. Refresh before sending.",
        );
      if (target.projectAgentId)
        yield* peers.apply({
          kind: "project-agent",
          projectId: input.projectId,
          instanceId: input.instanceId,
          agentId: target.projectAgentId,
        });
      const claim = yield* claimDelivery();
      if (!claim.claimed) {
        if (claim.receipt.status === "uncertain")
          return yield* agentDeliveryReconcileUnlocked(input).pipe(
            Effect.map((receipt) => receipt ?? claim.receipt),
            Effect.orElseSucceed(() => claim.receipt),
          );
        return claim.receipt;
      }
      const result: MeerkatAgentControlReceipt = yield* prepared.dispatch().pipe(
        Effect.map((receipt): MeerkatAgentControlReceipt => ({
          status: "accepted",
          requestId: input.requestId,
          receipt,
          message: null,
        })),
        Effect.catch((cause) =>
          Effect.succeed({
            status: "uncertain" as const,
            requestId: input.requestId,
            receipt: null,
            message: `${cause.detail} Delivery was not replayed. Check native activity before submitting new work.`,
          }),
        ),
      );
      return yield* store.saveReceipt(input.projectId, input.instanceId, input.requestId, result);
    }).pipe(mutationLock.withPermits(1));
  });
  const agentDeliveryReconcileUnlocked = Effect.fn("MeerkatTeam.agentDeliveryReconcile")(function* (
    raw: MeerkatAgentSendInput,
  ) {
    const input = yield* decodeSendInput(raw).pipe(
      Effect.mapError((cause) => failure(raw.projectId, "agent-control", cause)),
    );
    yield* readProject(input.projectId);
    const delivery = yield* store.delivery(input.projectId, input.instanceId, input.requestId);
    if (!delivery) return undefined;
    const fingerprint = agentFingerprint([
      input.agentRef,
      projectComposerContextForProvider({
        text: input.text,
        records: input.context?.records ?? [],
      }),
      input.handlingMode,
      input.modelSelection ? encodeModelSelection(input.modelSelection) : "",
      encodeImages(input.images ?? []),
    ]);
    if (delivery.fingerprint !== fingerprint)
      return yield* failure(
        input.projectId,
        "agent-control",
        "Receipt lookup requires the original agent session and message.",
      );
    const saved = (yield* observedAgents
      .list(input.projectId, input.instanceId, input.agentRef)
      .pipe(Effect.mapError((cause) => failure(input.projectId, "agent-control", cause))))[0];
    const { reader } = yield* providerForAgent(input.projectId, input.instanceId);
    if (!saved || saved.provider_state_root !== reader.stateRoot || !saved.agent.record.session_id)
      return yield* failure(
        input.projectId,
        "agent-control",
        "The original agent session and provider storage are required to reconcile delivery.",
      );
    if (!reader.receipt) return delivery.receipt;
    const receipt = yield* reader
      .receipt({
        projectPath: saved.project_path,
        ...(saved.state_root ? { stateRoot: saved.state_root } : {}),
        mobId: saved.agent.mobId,
        record: saved.agent.record,
        requestId: input.requestId,
      })
      .pipe(Effect.mapError((cause) => failure(input.projectId, "agent-control", cause)));
    if (!receipt) return delivery.receipt;
    const failed = receipt.status === "delivery_failed" || receipt.status === "redacted";
    return yield* store.saveReceipt(input.projectId, input.instanceId, input.requestId, {
      status: failed ? "uncertain" : "accepted",
      requestId: input.requestId,
      receipt: { mobId: saved.agent.mobId, identity: saved.agent.record.identity, receipt },
      message: failed
        ? `Native delivery is ${receipt.status}. The message was not replayed.`
        : null,
    });
  });
  const agentDeliveryReconcile = (input: MeerkatAgentSendInput) =>
    agentDeliveryReconcileUnlocked(input).pipe(mutationLock.withPermits(1));
  const agentStopCrew = Effect.fn("MeerkatTeam.agentStopCrew")(function* (
    raw: MeerkatAgentLifecycleInput,
  ) {
    const input = yield* decodeAgentLifecycleInput(raw).pipe(
      Effect.mapError((cause) => failure(raw.projectId, "agent-control", cause)),
    );
    const target = yield* controlTarget(input);
    if (!target.record.labels.source_mob_id || !target.record.session_id)
      return yield* failure(
        input.projectId,
        "agent-control",
        "Only a live native worker crew can be stopped here.",
      );
    if (!target.reader.stopCrew)
      return yield* failure(
        input.projectId,
        "agent-control",
        "This provider cannot stop native crews.",
      );
    yield* target.reader
      .stopCrew(target)
      .pipe(Effect.mapError((cause) => failure(input.projectId, "agent-control", cause)));
    return (yield* readTeam(input.projectId, true)).team;
  }, mutationLock.withPermits(1));
  const agentResume = Effect.fn("MeerkatTeam.agentResume")(function* (
    raw: MeerkatAgentLifecycleInput,
  ) {
    const input = yield* decodeAgentLifecycleInput(raw).pipe(
      Effect.mapError((cause) => failure(raw.projectId, "agent-control", cause)),
    );
    yield* readProject(input.projectId);
    const saved = (yield* observedAgents
      .list(input.projectId, input.instanceId, input.agentRef)
      .pipe(Effect.mapError((cause) => failure(input.projectId, "agent-control", cause))))[0];
    if (!saved?.agent.record.labels.source_mob_id)
      return yield* failure(
        input.projectId,
        "agent-control",
        "Only a recorded native worker crew can be resumed here.",
      );
    const { reader } = yield* providerForAgent(input.projectId, input.instanceId);
    if (reader.stateRoot !== saved.provider_state_root || !reader.resume)
      return yield* failure(
        input.projectId,
        "agent-control",
        "The original native provider is required to resume this crew.",
      );
    if (saved.agent.projectAgentId) {
      const definition = yield* store.get(input.projectId, saved.agent.projectAgentId);
      if (!definition.enabled || definition.archived)
        return yield* failure(
          input.projectId,
          "agent-control",
          "Connect the owning project agent before resuming its crew.",
        );
      const current = (yield* readTeam(input.projectId)).team.projectAgents.find(
        (agent) => agent.agentId === definition.agent_id,
      );
      if (current?.connectionStatus !== "connected") yield* connect(input.projectId, definition);
    }
    yield* reader
      .resume({
        projectPath: saved.project_path,
        ...(saved.state_root ? { stateRoot: saved.state_root } : {}),
        mobId: saved.agent.mobId,
        record: saved.agent.record,
      })
      .pipe(Effect.mapError((cause) => failure(input.projectId, "agent-control", cause)));
    return (yield* readTeam(input.projectId, true)).team;
  }, mutationLock.withPermits(1));
  const agentStop = Effect.fn("MeerkatTeam.agentStop")(function* (raw: MeerkatAgentStopInput) {
    const input = yield* decodeStopInput(raw).pipe(
      Effect.mapError((cause) => failure(raw.projectId, "agent-control", cause)),
    );
    const target = yield* controlTarget(input);
    if (!target.reader.stop)
      return yield* failure(input.projectId, "agent-control", "This provider cannot stop agents.");
    return yield* target.reader.stop({ ...target, nativeRunId: input.nativeRunId }).pipe(
      Effect.map((receipt): MeerkatAgentControlReceipt => ({
        status: "accepted",
        requestId: null,
        receipt,
        message: "Stop requested. Waiting for the agent to stop.",
      })),
      Effect.mapError((cause) => failure(input.projectId, "agent-control", cause)),
    );
  }, mutationLock.withPermits(1));
  const decodeIds = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
  const connectionContext = Effect.fn("MeerkatTeam.connectionContext")(function* (
    input: MeerkatThreadConnectionsInput,
  ) {
    const workspaceRoot = yield* readProject(input.projectId);
    const { reader } = yield* providerForAgent(input.projectId, input.instanceId);
    const threads =
      yield* sql`SELECT project_id, worktree_path, deleted_at FROM projection_threads WHERE thread_id = ${input.threadId}`.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({
                project_id: Schema.String,
                worktree_path: Schema.NullOr(Schema.String),
                deleted_at: Schema.NullOr(Schema.String),
              }),
            ),
          ),
        ),
        Effect.mapError((cause) => failure(input.projectId, "agent-connections", cause)),
      );
    const thread = threads[0];
    if (thread && (thread.project_id !== input.projectId || thread.deleted_at))
      return yield* failure(
        input.projectId,
        "agent-connections",
        "Thread does not belong to this active project.",
      );
    const bindings =
      yield* sql`SELECT provider_name, provider_instance_id FROM provider_session_runtime WHERE thread_id = ${input.threadId}`.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({
                provider_name: Schema.String,
                provider_instance_id: Schema.NullOr(Schema.String),
              }),
            ),
          ),
        ),
        Effect.mapError((cause) => failure(input.projectId, "agent-connections", cause)),
      );
    if (
      bindings[0] &&
      (bindings[0].provider_name !== "meerkat" ||
        bindings[0].provider_instance_id !== input.instanceId)
    )
      return yield* failure(
        input.projectId,
        "agent-connections",
        "Thread belongs to another provider instance.",
      );
    const selections =
      yield* sql`SELECT project_id,instance_id,agent_ids_json,request_id FROM meerkat_thread_connections WHERE thread_id = ${input.threadId}`.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({
                project_id: Schema.String,
                instance_id: Schema.String,
                agent_ids_json: Schema.String,
                request_id: Schema.String,
              }),
            ),
          ),
        ),
        Effect.mapError((cause) => failure(input.projectId, "agent-connections", cause)),
      );
    const selection = selections[0];
    if (
      selection &&
      (selection.project_id !== input.projectId || selection.instance_id !== input.instanceId)
    )
      return yield* failure(
        input.projectId,
        "agent-connections",
        "Reserved thread selection belongs to another project or provider instance.",
      );
    const rows = (yield* store.list(input.projectId)).filter(
      (row) => row.instance_id === input.instanceId,
    );
    const desiredAgentIds = selection
      ? yield* decodeIds(selection.agent_ids_json).pipe(
          Effect.mapError((cause) => failure(input.projectId, "agent-connections", cause)),
        )
      : rows
          .filter((row) => row.enabled && !row.archived)
          .slice(0, 8)
          .map((row) => row.agent_id);
    const executionPath = path.resolve(thread?.worktree_path ?? workspaceRoot);
    const sourceStateRoot = meerkatProjectStateRoot(path, reader.stateRoot, executionPath);
    const sourceMobId = `t3-${agentFingerprintForThread(input.instanceId, input.threadId)}`;
    return {
      workspaceRoot,
      executionPath,
      sourceStateRoot,
      sourceMobId,
      reader,
      rows,
      desiredAgentIds,
      explicit: Boolean(selection),
      requestId: selection?.request_id ?? `default:${input.threadId}`,
      threadExists: Boolean(thread),
    };
  });
  const topologySchema = Schema.Struct({
    snapshot: Schema.Struct({
      authority_revisions: Schema.Record(Schema.String, Schema.Number),
      edges: Schema.Array(
        Schema.Struct({
          edge: Schema.Struct({
            a: Schema.Struct({ authority: Schema.String, identity: Schema.String }),
            b: Schema.Struct({ authority: Schema.String, identity: Schema.String }),
          }),
          actual: Schema.Boolean,
          desired: Schema.optional(Schema.Boolean),
          suppressed: Schema.optional(Schema.Boolean),
          operator_added: Schema.optional(Schema.Boolean),
          declared: Schema.optional(Schema.Boolean),
        }),
      ),
    }),
  });
  const pairParams = (
    context: Effect.Success<ReturnType<typeof connectionContext>>,
    row: MeerkatProjectAgentRow,
  ) => ({
    sourceProjectPath: context.executionPath,
    sourceExecutionPath: context.executionPath,
    sourceExecutionMode: "local",
    sourceStateRoot: context.sourceStateRoot,
    sourceMobId: context.sourceMobId,
    sourceAgentIdentity: "ingress",
    targetProjectPath: context.workspaceRoot,
    targetExecutionPath: context.workspaceRoot,
    targetExecutionMode: "local",
    targetStateRoot: row.state_root,
    targetMobId: row.mob_id,
    targetAgentIdentity: row.agent_identity,
  });
  const pairEdge = (
    snapshot: typeof topologySchema.Type,
    sourceMobId: string,
    row: MeerkatProjectAgentRow,
  ) =>
    snapshot.snapshot.edges.find(
      (entry) =>
        (entry.edge.a.authority === sourceMobId &&
          entry.edge.a.identity === "ingress" &&
          entry.edge.b.authority === row.mob_id &&
          entry.edge.b.identity === row.agent_identity) ||
        (entry.edge.b.authority === sourceMobId &&
          entry.edge.b.identity === "ingress" &&
          entry.edge.a.authority === row.mob_id &&
          entry.edge.a.identity === row.agent_identity),
    );
  const connectedEdge = (
    snapshot: typeof topologySchema.Type,
    sourceMobId: string,
    row: MeerkatProjectAgentRow,
  ) => pairEdge(snapshot, sourceMobId, row)?.actual ?? false;
  const threadConnections = Effect.fn("MeerkatTeam.threadConnections")(function* (
    input: MeerkatThreadConnectionsInput,
  ): Effect.fn.Return<MeerkatThreadConnections, MeerkatTeamError> {
    const context = yield* connectionContext(input);
    const connections: Array<MeerkatThreadConnections["connections"][number]> = [];
    const native = context.threadExists
      ? yield* context.reader
          .snapshot(context.executionPath)
          .pipe(Effect.mapError((cause) => failure(input.projectId, "agent-connections", cause)))
      : null;
    const sourceLoaded = native?.mobs.some((mob) => mob.mobId === context.sourceMobId) ?? false;
    for (const row of context.rows.filter(
      (row) => !row.archived || context.desiredAgentIds.includes(row.agent_id),
    )) {
      if (
        !sourceLoaded ||
        !row.enabled ||
        row.archived ||
        row.provider_state_root !== context.reader.stateRoot
      ) {
        connections.push({
          agentId: row.agent_id,
          status: "unloaded",
          error:
            row.last_error ??
            (!row.enabled && !row.archived
              ? "Paused. Connect this specialist to resume collaboration."
              : null),
          snapshot: null,
        });
        continue;
      }
      const target = yield* context.reader
        .snapshot(context.workspaceRoot, row.state_root)
        .pipe(Effect.mapError((cause) => failure(input.projectId, "agent-connections", cause)));
      if (!target.mobs.some((mob) => mob.mobId === row.mob_id) || !context.reader.topology) {
        connections.push({
          agentId: row.agent_id,
          status: "unloaded",
          error: null,
          snapshot: null,
        });
        continue;
      }
      const observed = yield* context.reader.topology(pairParams(context, row)).pipe(
        Effect.flatMap((raw) =>
          Schema.decodeUnknownEffect(topologySchema)(raw).pipe(
            Effect.map((snapshot): MeerkatThreadConnections["connections"][number] => ({
              agentId: row.agent_id,
              status: connectedEdge(snapshot, context.sourceMobId, row)
                ? "connected"
                : "disconnected",
              error: null,
              snapshot: raw,
            })),
          ),
        ),
        Effect.catch((cause) =>
          Effect.succeed({
            agentId: row.agent_id,
            status: "error" as const,
            error: cause instanceof Error ? cause.message : String(cause),
            snapshot: null,
          }),
        ),
      );
      connections.push(observed);
    }
    return {
      ...input,
      explicit: context.explicit,
      desiredAgentIds: context.desiredAgentIds,
      connections,
    };
  });
  const applyThreadConnectionsUnlocked = Effect.fn("MeerkatTeam.applyThreadConnections")(function* (
    input: MeerkatThreadConnectionsInput,
    requireSource = false,
  ): Effect.fn.Return<void, MeerkatTeamError> {
    let context = yield* connectionContext(input);
    if (!context.threadExists) {
      if (requireSource)
        return yield* failure(
          input.projectId,
          "agent-connections",
          "Thread disappeared before its connections could be applied.",
        );
      return;
    }
    const source = yield* context.reader
      .snapshot(context.executionPath)
      .pipe(Effect.mapError((cause) => failure(input.projectId, "agent-connections", cause)));
    if (!source.mobs.some((mob) => mob.mobId === context.sourceMobId)) {
      if (requireSource)
        return yield* failure(
          input.projectId,
          "agent-connections",
          "The native thread is unavailable. Its connections were not applied.",
        );
      return;
    }
    if (!context.explicit) {
      const now = DateTime.formatIso(yield* DateTime.now);
      // Defaults belong to this thread once its first turn is admitted. Later project agents
      // are added to new threads, without silently joining existing conversations.
      yield* sql`INSERT INTO meerkat_thread_connections(thread_id,project_id,instance_id,agent_ids_json,request_id,updated_at)
        VALUES (${input.threadId},${input.projectId},${input.instanceId},${encodeConnectionIds(context.desiredAgentIds)},${context.requestId},${now})
        ON CONFLICT(thread_id) DO NOTHING
      `.pipe(Effect.mapError((cause) => failure(input.projectId, "agent-connections", cause)));
      context = yield* connectionContext(input);
    }
    for (const row of context.rows) {
      const desired =
        context.desiredAgentIds.includes(row.agent_id) && Boolean(row.enabled) && !row.archived;
      if (desired && row.provider_state_root !== context.reader.stateRoot)
        return yield* failure(
          input.projectId,
          "agent-connections",
          `${row.label} is bound to different provider storage.`,
        );
      if (row.provider_state_root !== context.reader.stateRoot) continue;
      const native = yield* context.reader
        .snapshot(context.workspaceRoot, row.state_root)
        .pipe(Effect.mapError((cause) => failure(input.projectId, "agent-connections", cause)));
      if (!native.mobs.some((mob) => mob.mobId === row.mob_id)) {
        if (!desired) continue;
        const restored = yield* connect(input.projectId, row);
        if (restored.connectionStatus !== "connected")
          return yield* failure(
            input.projectId,
            "agent-connections",
            restored.error ?? `${row.label} could not connect.`,
          );
      }
      if (!context.reader.topology || !context.reader.wire)
        return yield* failure(
          input.projectId,
          "agent-connections",
          "Native topology control is unavailable.",
        );
      const params = pairParams(context, row);
      const nativeSnapshot = yield* context.reader.topology(params).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(topologySchema)),
        Effect.mapError((cause) => failure(input.projectId, "agent-connections", cause)),
      );
      const previousEdge = pairEdge(nativeSnapshot, context.sourceMobId, row);
      const demand =
        previousEdge &&
        (previousEdge.desired || previousEdge.operator_added || previousEdge.declared);
      if (
        connectedEdge(nativeSnapshot, context.sourceMobId, row) === desired &&
        (desired || !demand || previousEdge?.suppressed)
      )
        continue;
      const reconnect =
        previousEdge &&
        (previousEdge.suppressed ||
          previousEdge.desired ||
          previousEdge.operator_added ||
          previousEdge.declared);
      yield* context.reader
        .wire(
          {
            ...params,
            expectedRevisions: nativeSnapshot.snapshot.authority_revisions,
            ...(desired ? { action: reconnect ? "reconnect" : "connect" } : {}),
            idempotencyKey: agentFingerprint([
              context.requestId,
              row.agent_id,
              String(desired),
              encodeAuthorityRevisions(nativeSnapshot.snapshot.authority_revisions),
            ]),
          },
          desired,
        )
        .pipe(Effect.mapError((cause) => failure(input.projectId, "agent-connections", cause)));
      const checked = yield* context.reader.topology(params).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(topologySchema)),
        Effect.mapError((cause) => failure(input.projectId, "agent-connections", cause)),
      );
      if (connectedEdge(checked, context.sourceMobId, row) !== desired)
        return yield* failure(
          input.projectId,
          "agent-connections",
          `Native connection to ${row.label} did not reach the requested state.`,
        );
    }
  });
  const threadConnectionsSetUnlocked = Effect.fn("MeerkatTeam.threadConnectionsSet")(function* (
    raw: MeerkatThreadConnectionsSetInput,
  ): Effect.fn.Return<MeerkatThreadConnections, MeerkatTeamError> {
    const input = yield* decodeConnectionsSetInput(raw).pipe(
      Effect.mapError((cause) => failure(raw.projectId, "agent-connections", cause)),
    );
    const context = yield* connectionContext(input);
    const ids = [...new Set(input.agentIds)];
    if (
      ids.some(
        (id) =>
          !context.rows.some(
            (row) =>
              row.agent_id === id &&
              (row.enabled || context.desiredAgentIds.includes(id)) &&
              !row.archived &&
              row.provider_state_root === context.reader.stateRoot,
          ),
      )
    )
      return yield* failure(
        input.projectId,
        "agent-connections",
        "Select enabled project agents belonging to this provider instance.",
      );
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`INSERT INTO meerkat_thread_connections(thread_id,project_id,instance_id,agent_ids_json,request_id,updated_at)
      VALUES (${input.threadId},${input.projectId},${input.instanceId},${encodeConnectionIds(ids)},${input.requestId},${now})
      ON CONFLICT(thread_id) DO UPDATE SET agent_ids_json = excluded.agent_ids_json, request_id = excluded.request_id, updated_at = excluded.updated_at
    `.pipe(Effect.mapError((cause) => failure(input.projectId, "agent-connections", cause)));
    yield* applyThreadConnectionsUnlocked(input);
    return yield* threadConnections(input);
  });
  const threadConnectionsSet = (input: MeerkatThreadConnectionsSetInput) =>
    threadConnectionsSetUnlocked(input).pipe(mutationLock.withPermits(1));
  const applyThreadConnections = (input: MeerkatThreadConnectionsInput, requireSource = false) =>
    applyThreadConnectionsUnlocked(input, requireSource).pipe(
      Effect.andThen(
        peers.apply({
          kind: "thread",
          projectId: input.projectId,
          instanceId: input.instanceId,
          threadId: input.threadId,
        }),
      ),
      mutationLock.withPermits(1),
    );
  const resolvePeer = Effect.fn("MeerkatTeam.resolvePeer")(function* (
    endpoint: MeerkatPeerEndpoint,
    allowDeleted = false,
  ): Effect.fn.Return<ResolvedPeerEndpoint, MeerkatTeamError> {
    const projects =
      yield* sql`SELECT workspace_root,deleted_at FROM projection_projects WHERE project_id = ${endpoint.projectId}`.pipe(
        Effect.mapError((cause) => failure(endpoint.projectId, "agent-connections", cause)),
      );
    const project = projects[0];
    if (!project || (!allowDeleted && project.deleted_at))
      return yield* failure(endpoint.projectId, "agent-connections", "Project not found.");
    const workspaceRoot = path.resolve(String(project.workspace_root));
    let deleted = Boolean(project.deleted_at);
    const { reader } = yield* providerForAgent(endpoint.projectId, endpoint.instanceId);
    let projectPath = workspaceRoot;
    let stateRoot: string;
    let mobId: string;
    let identity: string;
    let enabled = true;
    if (endpoint.kind === "project-agent") {
      const row = yield* store.get(endpoint.projectId, endpoint.agentId);
      if (row.instance_id !== endpoint.instanceId || row.provider_state_root !== reader.stateRoot)
        return yield* failure(
          endpoint.projectId,
          "agent-connections",
          "Project agent belongs to another provider or storage root.",
        );
      stateRoot = row.state_root;
      mobId = row.mob_id;
      identity = row.agent_identity;
      enabled = Boolean(row.enabled) && !row.archived;
    } else {
      const threads =
        yield* sql`SELECT project_id,worktree_path,deleted_at,archived_at,model_selection_json FROM projection_threads WHERE thread_id = ${endpoint.threadId}`.pipe(
          Effect.mapError((cause) => failure(endpoint.projectId, "agent-connections", cause)),
        );
      const thread = threads[0];
      if (
        !thread ||
        thread.project_id !== endpoint.projectId ||
        (!allowDeleted && thread.deleted_at)
      )
        return yield* failure(
          endpoint.projectId,
          "agent-connections",
          "Both threads must exist before connecting them.",
        );
      const bindings =
        yield* sql`SELECT provider_name,provider_instance_id FROM provider_session_runtime WHERE thread_id = ${endpoint.threadId}`.pipe(
          Effect.mapError((cause) => failure(endpoint.projectId, "agent-connections", cause)),
        );
      if (bindings[0]) {
        if (
          bindings[0].provider_name !== "meerkat" ||
          bindings[0].provider_instance_id !== endpoint.instanceId
        )
          return yield* failure(
            endpoint.projectId,
            "agent-connections",
            "Thread belongs to another provider instance.",
          );
      } else {
        const selection = yield* decodePeerThreadSelection(thread.model_selection_json).pipe(
          Effect.mapError((cause) => failure(endpoint.projectId, "agent-connections", cause)),
        );
        if (selection.instanceId !== endpoint.instanceId)
          return yield* failure(
            endpoint.projectId,
            "agent-connections",
            "Thread belongs to another provider instance.",
          );
      }
      deleted ||= Boolean(thread.deleted_at);
      enabled = !thread.archived_at;
      projectPath = path.resolve(
        thread.worktree_path ? String(thread.worktree_path) : workspaceRoot,
      );
      stateRoot = meerkatProjectStateRoot(path, reader.stateRoot, projectPath);
      mobId = `t3-${agentFingerprintForThread(endpoint.instanceId, endpoint.threadId)}`;
      identity = "ingress";
    }
    const snapshot = yield* reader
      .snapshot(projectPath, stateRoot)
      .pipe(Effect.mapError((cause) => failure(endpoint.projectId, "agent-connections", cause)));
    const records = snapshot.mobs
      .filter((mob) => mob.mobId === mobId && mob.consoleStatus === "ready")
      .flatMap((mob) => mob.identities)
      .filter((record) => record.identity === identity && !record.labels.source_mob_id);
    if (records.length > 1)
      return yield* failure(
        endpoint.projectId,
        "agent-connections",
        "Native peer endpoint is ambiguous.",
      );
    const record = records[0];
    return {
      reader,
      projectPath,
      stateRoot,
      mobId,
      identity,
      enabled,
      deleted,
      record: record?.addressable && record.visibility === "addressable" ? record : null,
    };
  });
  const restorePeer = Effect.fn("MeerkatTeam.restorePeer")(function* (
    endpoint: MeerkatPeerEndpoint,
  ): Effect.fn.Return<ResolvedPeerEndpoint, MeerkatTeamError> {
    const current = yield* resolvePeer(endpoint);
    if (endpoint.kind === "project-agent" && current.enabled && !current.record) {
      const row = yield* store.get(endpoint.projectId, endpoint.agentId);
      const restored = yield* connect(endpoint.projectId, row, false);
      if (restored.connectionStatus !== "connected")
        return yield* failure(
          endpoint.projectId,
          "agent-connections",
          restored.error ?? `${row.label} could not connect.`,
        );
      return yield* resolvePeer(endpoint);
    }
    return current;
  });
  const legacyPeerList = Effect.fn("MeerkatTeam.legacyPeerList")(function* (
    endpoint: MeerkatPeerEndpoint,
  ): Effect.fn.Return<ReadonlyArray<MeerkatPeerConnection>, MeerkatTeamError> {
    const threadIds =
      endpoint.kind === "thread"
        ? [endpoint.threadId]
        : (yield* sql`SELECT thread_id FROM projection_threads WHERE project_id = ${endpoint.projectId} AND deleted_at IS NULL`.pipe(
            Effect.mapError((cause) => failure(endpoint.projectId, "agent-connections", cause)),
          )).map((row) => ThreadId.make(String(row.thread_id)));
    const connections: MeerkatPeerConnection[] = [];
    for (const threadId of threadIds) {
      const source: MeerkatPeerEndpoint = {
        kind: "thread",
        projectId: endpoint.projectId,
        instanceId: endpoint.instanceId,
        threadId,
      };
      const result = yield* threadConnections(source).pipe(Effect.orElseSucceed(() => null));
      if (!result) continue;
      for (const connection of result.connections) {
        if (endpoint.kind === "project-agent" && connection.agentId !== endpoint.agentId) continue;
        const desired = result.desiredAgentIds.includes(connection.agentId);
        if (!desired && connection.status !== "connected") continue;
        const target: MeerkatPeerEndpoint = {
          kind: "project-agent",
          projectId: endpoint.projectId,
          instanceId: endpoint.instanceId,
          agentId: connection.agentId,
        };
        connections.push({
          edgeId: peerEdgeId(source, target),
          source,
          target,
          desired,
          status: connection.status,
          error: connection.error,
        });
      }
    }
    return connections;
  });
  const peers = yield* makeMeerkatPeerConnections({
    requireProjectReady: (projectId) =>
      requireProjectCloneReady(cloneTracker, projectId).pipe(
        Effect.mapError((cause) => failure(projectId, "agent-connections", cause)),
      ),
    resolve: resolvePeer,
    restore: restorePeer,
    legacyList: legacyPeerList,
    legacySet: Effect.fn("MeerkatTeam.legacyPeerSet")(function* (input) {
      const source =
        input.source.kind === "thread"
          ? input.source
          : input.target.kind === "thread"
            ? input.target
            : null;
      const target =
        input.source.kind === "project-agent"
          ? input.source
          : input.target.kind === "project-agent"
            ? input.target
            : null;
      if (!source || !target || source.projectId !== target.projectId) return false;
      const context = yield* connectionContext(source);
      const agentIds = context.desiredAgentIds.filter((id) => id !== target.agentId);
      if (input.connected) agentIds.push(target.agentId);
      yield* threadConnectionsSetUnlocked({ ...source, agentIds, requestId: input.requestId });
      if (input.connected) yield* restorePeer(target);
      return true;
    }),
  });
  const peerConnections = (input: MeerkatPeerConnectionsInput) => peers.list(input);
  const peerConnectionSet = (input: MeerkatPeerConnectionSetInput) =>
    peers.set(input).pipe(mutationLock.withPermits(1));
  const proposal = yield* makeMeerkatProjectProposalService({
    store,
    lock: mutationLock,
    readProject,
    provider: providerForAgent,
    validateModel: (input) => requireAgentModel({ ...input, operation: "project-agent" }),
    connect,
    project: projection,
    revise,
  });
  const admit =
    <A extends { readonly projectId: ProjectId }, B, E, R>(
      work: (input: A) => Effect.Effect<B, E, R>,
    ) =>
    (input: A) =>
      requireRestoreReviewReleased.pipe(
        Effect.mapError((cause) => failure(input.projectId, "agent-control", cause.message)),
        Effect.andThen(work(input)),
      );
  return {
    ...proposal,
    projectProposalSetup: admit(proposal.projectProposalSetup),
    projectProposalCreate: admit(proposal.projectProposalCreate),
    projectAgentPrepare: admit(proposal.projectAgentPrepare),
    projectTeam,
    projectAgents,
    agentActivity,
    interactionTarget,
    queueTarget,
    projectAgentCreate: admit(projectAgentCreate),
    projectAgentUpdate: (input: Parameters<typeof projectAgentUpdate>[0]) =>
      input.revision || input.applyPending
        ? admit(projectAgentUpdate)(input)
        : projectAgentUpdate(input),
    projectAgentLifecycle: (input: Parameters<typeof projectAgentLifecycle>[0]) =>
      input.action === "connect"
        ? admit(projectAgentLifecycle)(input)
        : projectAgentLifecycle(input),
    agentSend: admit(agentSend),
    agentDeliveryReconcile,
    agentStop,
    agentResume: admit(agentResume),
    agentStopCrew,
    threadConnections,
    threadConnectionsSet: (input: Parameters<typeof threadConnectionsSet>[0]) =>
      input.agentIds.length ? admit(threadConnectionsSet)(input) : threadConnectionsSet(input),
    applyThreadConnections: (input: MeerkatThreadConnectionsInput, requireSource = false) =>
      admit((value: MeerkatThreadConnectionsInput) => applyThreadConnections(value, requireSource))(
        input,
      ),
    peerConnections,
    peerConnectionSet: (input: MeerkatPeerConnectionSetInput) =>
      input.connected
        ? requireRestoreReviewReleased.pipe(
            Effect.mapError((cause) =>
              failure(input.source.projectId, "agent-connections", cause.message),
            ),
            Effect.andThen(peerConnectionSet(input)),
          )
        : peerConnectionSet(input),
  };
});

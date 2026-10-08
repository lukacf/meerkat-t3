// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  RestoreReviewError,
  RestoreReviewItem,
  MeerkatTeamAgent,
  ProviderInstanceId,
  ThreadId,
  type RestoreReviewDestination,
  type RestoreReviewSnapshot,
  type RestoreReviewStatus,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const RESTORE_REVIEW_FILE = "meerkat-restore-review.json";
export const RESTORE_REVIEW_CAPABILITY_FILE = "meerkat-restore-review-capability.json";
export const RESTORE_REVIEW_MESSAGE =
  "This restored profile is paused. Review saved work, confirm recovery, then restart the app before starting or resuming agents.";
const clear: RestoreReviewStatus = {
  status: "clear",
  restoreId: null,
  restoredAt: null,
  backupCreatedAt: null,
  message: "",
};
const MarkerTimestamp = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value;
  }),
);
const RestoreMarker = Schema.Struct({
  version: Schema.Literal(1),
  restoreId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)),
  restoredAt: MarkerTimestamp,
  backupCreatedAt: MarkerTimestamp,
  appVersion: Schema.String.check(Schema.isNonEmpty()),
  consentedAt: Schema.optionalKey(MarkerTimestamp),
});
type RestoreMarker = typeof RestoreMarker.Type;
const decodeMarker = Schema.decodeUnknownSync(Schema.fromJsonString(RestoreMarker));
export function decodeRestoreMarker(raw: string, appVersion: string): RestoreMarker {
  const marker = decodeMarker(raw);
  if (marker.appVersion !== appVersion && !marker.consentedAt)
    throw new Error("Restore marker belongs to another app version.");
  return marker;
}
async function readRegular(file: string): Promise<string | undefined> {
  try {
    const handle = await NodeFSP.open(
      file,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4096)
        throw new Error("Recovery metadata must be a bounded regular file.");
      const buffer = Buffer.alloc(4097);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 4096) throw new Error("Recovery metadata is too large.");
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}
async function writeDurable(file: string, value: unknown) {
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  const content = `${JSON.stringify(value)}\n`;
  try {
    const handle = await NodeFSP.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await NodeFSP.rename(temporary, file);
    const directory = await NodeFSP.open(NodePath.dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    if ((await readRegular(file)) !== content)
      throw new Error("Recovery metadata could not be verified.");
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}
export interface RestoreReviewService {
  /** Captured before startup. Consent never releases this process. */
  readonly held: boolean;
  readonly status: () => RestoreReviewStatus;
  /** Replays current status, then durable consent changes, across all clients. */
  readonly changes?: Stream.Stream<RestoreReviewStatus>;
  readonly consent: (restoreId: string) => Promise<RestoreReviewStatus>;
}
export class ProfileRestoreReview extends Context.Reference<RestoreReviewService | undefined>(
  "t3/ProfileRestoreReview",
  { defaultValue: () => undefined },
) {}

export async function openRestoreReview(
  baseDir: string,
  appVersion: string,
): Promise<RestoreReviewService> {
  const file = NodePath.join(baseDir, RESTORE_REVIEW_FILE);
  let marker: RestoreMarker | undefined;
  let status = clear;
  const listeners = new Set<() => void>();
  try {
    const raw = await readRegular(file);
    if (raw !== undefined) {
      marker = decodeRestoreMarker(raw, appVersion);
      status = {
        status: marker.consentedAt ? "clear" : "required",
        restoreId: marker.restoreId,
        restoredAt: marker.restoredAt,
        backupCreatedAt: marker.backupCreatedAt,
        message: marker.consentedAt ? "" : RESTORE_REVIEW_MESSAGE,
      };
    }
  } catch {
    status = {
      ...clear,
      status: "invalid",
      message:
        "Recovery metadata is unreadable, invalid, or belongs to another app version. Keep this profile paused and restore the verified backup with its original guard-capable app. No agents will start.",
    };
  }
  const held = status.status !== "clear";
  await NodeFSP.mkdir(baseDir, { recursive: true });
  await writeDurable(NodePath.join(baseDir, RESTORE_REVIEW_CAPABILITY_FILE), {
    version: 1,
    appVersion,
  });
  return {
    held,
    status: () => ({ ...status }),
    changes: Stream.callback<RestoreReviewStatus>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const notify = () => {
            Queue.offerUnsafe(queue, { ...status });
          };
          listeners.add(notify);
          notify();
          return notify;
        }),
        (notify) =>
          Effect.sync(() => {
            listeners.delete(notify);
          }),
      ),
    ),
    consent: async (restoreId) => {
      if (!held || !marker || status.status === "invalid" || marker.restoreId !== restoreId)
        throw new Error(
          "Refresh the restore review. This consent does not match the held restore.",
        );
      const current = decodeRestoreMarker((await readRegular(file)) ?? "", appVersion);
      if (
        current.restoreId !== restoreId ||
        current.appVersion !== appVersion ||
        current.restoredAt !== marker.restoredAt ||
        current.backupCreatedAt !== marker.backupCreatedAt
      )
        throw new Error("Recovery metadata changed. Refresh the restore review.");
      await writeDurable(file, {
        ...current,
        consentedAt: current.consentedAt ?? DateTime.formatIso(DateTime.nowUnsafe()),
      });
      status = {
        ...status,
        status: "restart-required",
        message:
          "Recovery consent is saved. Restart the app to resume restored work. This process remains paused.",
      };
      for (const notify of listeners) notify();
      return { ...status };
    },
  };
}
export const restoreReviewHeld = Effect.map(
  ProfileRestoreReview,
  (review) => review?.held ?? false,
);
export const restoreReviewStatus = Effect.map(
  ProfileRestoreReview,
  (review) => review?.status() ?? clear,
);
export const requireRestoreReviewReleased = Effect.gen(function* () {
  const review = yield* ProfileRestoreReview;
  if (review?.held) return yield* new RestoreReviewError({ message: review.status().message });
});
export function commandStartsRestoredWork(command: {
  readonly type: OrchestrationCommand["type"];
  readonly regenerateTitle?: boolean | undefined;
}): boolean {
  return (
    command.type === "thread.turn.start" ||
    command.type === "thread.runtime-mode.set" ||
    command.type === "thread.approval.respond" ||
    command.type === "thread.user-input.respond" ||
    command.type === "thread.checkpoint.revert" ||
    command.type === "thread.conversation.revert" ||
    command.type === "thread.title.refine" ||
    (command.type === "thread.meta.update" && command.regenerateTitle === true)
  );
}

const passiveNativeMethods = new Set([
  "system.v1.health",
  "system.v1.capabilities",
  "system.v1.projectRuntimeInfo",
  "models.v1.catalog",
  "auth.v1.status",
  "auth.v1.loginStart",
  "auth.v1.loginComplete",
  "auth.v1.logout",
  "skills.v1.list",
  "questions.v1.list",
  "approvals.v1.list",
  "mobs.v1.teamSnapshot",
  "mobs.v1.consoleStatus",
  "mobs.v1.consoleHistory",
  "mobs.v1.consoleTimeline",
  "mobs.v1.consoleSearch",
  "mobs.v1.consoleReceipt",
  "mobs.v1.coordinatorWork",
  "mobs.v1.coordinatorSteerReceipt",
  "mobs.v1.runStatus",
  "mobs.v1.threadFollowups",
  "mobs.v1.threadDeliveries",
  "mobs.v1.acknowledgeThreadDelivery",
  "mobs.v1.imageRead",
  "mobs.v1.browserStatus",
  "mobs.v1.topologyPair",
  "mobs.v1.checkpointScope",
  "mobs.v1.consoleStop",
  "mobs.v1.consoleStopCrew",
  "mobs.v1.coordinatorStop",
  "mobs.v1.forceCancel",
  "mobs.v1.destroy",
  "mobs.v1.unpeerLocal",
  "text.v1.cancel",
]);
/** Unknown native methods cannot admit work while a restored profile is held. */
export const nativeMethodAllowedDuringRestoreReview = (method: string) =>
  passiveNativeMethods.has(method);

const InventoryRow = Schema.Struct({
  ...RestoreReviewItem.fields,
  total: Schema.Number,
  queueKey: Schema.optional(Schema.String),
  bindingJson: Schema.optional(Schema.String),
  durableId: Schema.optional(Schema.String),
  observedRef: Schema.optional(Schema.NullOr(Schema.String)),
  definitionId: Schema.optional(Schema.NullOr(Schema.String)),
  threadDeletedAt: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(InventoryRow));
const decodeQueueBinding = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      projectId: Schema.String,
      instanceId: Schema.String,
      durableId: Schema.String,
      providerStateRoot: Schema.String,
      projectPath: Schema.String,
      stateRoot: Schema.NullOr(Schema.String),
      mobId: Schema.String,
      identity: Schema.String,
    }),
  ),
);
const SavedConversation = Schema.Struct({
  agentRef: Schema.String,
  projectId: Schema.String,
  instanceId: ProviderInstanceId,
  durableId: Schema.String,
  providerStateRoot: Schema.String,
  projectPath: Schema.String,
  stateRoot: Schema.NullOr(Schema.String),
  agentJson: Schema.String,
  projectLabel: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  threadLabel: Schema.NullOr(Schema.String),
  agentId: Schema.NullOr(Schema.String),
  agentLabel: Schema.NullOr(Schema.String),
  primaryIdentity: Schema.NullOr(Schema.String),
});
const decodeConversations = Schema.decodeUnknownEffect(Schema.Array(SavedConversation));
const decodeProjectLabels = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
);
const decodeSavedAgent = Schema.decodeUnknownOption(Schema.fromJsonString(MeerkatTeamAgent));
function savedConversationDestination(
  row: typeof SavedConversation.Type,
): RestoreReviewDestination | undefined {
  const decoded = decodeSavedAgent(row.agentJson);
  if (Option.isNone(decoded) || row.projectLabel === null) return undefined;
  const agent = decoded.value;
  if (agent.agentRef !== row.agentRef || (agent.durableId ?? agent.agentRef) !== row.durableId)
    return undefined;
  const worker = !!agent.record.labels.source_mob_id || !!agent.record.labels.spawned_by;
  if (
    row.threadId &&
    row.threadLabel !== null &&
    agent.threadId === row.threadId &&
    !agent.projectAgentId
  )
    return {
      kind: "thread",
      label: `${row.projectLabel} / ${row.threadLabel}${worker ? ` / ${agent.record.display_name}` : ""}`,
      threadId: row.threadId,
      ...(worker ? { member: agent.agentRef } : {}),
    };
  if (
    row.agentId &&
    row.agentLabel !== null &&
    agent.projectAgentId === row.agentId &&
    !agent.threadId
  )
    return {
      kind: "project-agent",
      label: `${row.projectLabel} / ${row.agentLabel}${worker ? ` / ${agent.record.display_name}` : ""}`,
      agentId: row.agentId,
      instanceId: row.instanceId,
      // The project-agent route's member picker does not address child crews.
      // Its existing nativeAgent view opens the exact saved conversation read-only.
      ...(worker || agent.record.identity !== row.primaryIdentity
        ? { nativeAgent: agent.agentRef }
        : {}),
    };
  return undefined;
}
/** This inventory reads consumer records only. It never loads native runtimes. */
export const readRestoreReviewSnapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const status = yield* restoreReviewStatus;
  const queues =
    yield* sql`SELECT 'queued-message' AS kind,i.item_id AS id,q.project_id AS projectId,q.instance_id AS instanceId,NULL AS threadId,'Saved message' AS label,i.status,CASE WHEN json_valid(i.payload_json) THEN substr(COALESCE(json_extract(i.payload_json,'$.text'),'Message with attachments'),1,500) ELSE 'Saved message payload is unreadable.' END AS detail,COUNT(*) OVER() AS total,q.target_key AS queueKey,q.binding_json AS bindingJson,q.durable_id AS durableId FROM meerkat_agent_queue_items i JOIN meerkat_agent_queues q ON q.target_key=i.target_key WHERE i.status NOT IN ('completed','cancelled') ORDER BY i.created_at LIMIT 100`.pipe(
      Effect.flatMap(decodeRows),
    );
  const deliveries =
    yield* sql`SELECT 'uncertain-delivery' AS kind,request_id AS id,project_id AS projectId,instance_id AS instanceId,NULL AS threadId,'Earlier delivery' AS label,'uncertain' AS status,'Check the original delivery receipt before retrying.' AS detail,COUNT(*) OVER() AS total FROM meerkat_agent_delivery_receipts WHERE CASE WHEN json_valid(receipt_json) THEN COALESCE(json_extract(receipt_json,'$.status'),'unknown') != 'accepted' ELSE 1 END ORDER BY created_at LIMIT 100`.pipe(
      Effect.flatMap(decodeRows),
    );
  const sessions =
    yield* sql`SELECT 'interrupted-session' AS kind,r.thread_id AS id,t.project_id AS projectId,r.provider_instance_id AS instanceId,r.thread_id AS threadId,t.title AS label,r.status,'Saved session may contain interrupted work or restart continuation.' AS detail,COUNT(*) OVER() AS total,t.deleted_at AS threadDeletedAt FROM provider_session_runtime r JOIN projection_threads t ON t.thread_id=r.thread_id WHERE r.status IN ('starting','running') OR CASE WHEN json_valid(r.runtime_payload_json) THEN json_extract(r.runtime_payload_json,'$.continueAfterServerUpdate') IS NOT NULL ELSE 0 END ORDER BY r.last_seen_at LIMIT 100`.pipe(
      Effect.flatMap(decodeRows),
    );
  const agents = yield* sql`WITH saved AS (
    SELECT agent_id AS id,project_id AS projectId,instance_id AS instanceId,NULL AS threadId,label,CASE WHEN archived=1 THEN 'archived' WHEN enabled=1 THEN 'saved' ELSE 'disabled' END AS status,'Saved specialist definition. Its last observation may appear separately; unloaded native mailbox contents are unknown.' AS detail,agent_id AS definitionId,NULL AS observedRef FROM meerkat_project_agents
    UNION ALL
    SELECT o.durable_id AS id,o.project_id AS projectId,o.instance_id AS instanceId,o.thread_id AS threadId,CASE WHEN json_valid(o.agent_json) THEN COALESCE(json_extract(o.agent_json,'$.record.display_name'),json_extract(o.agent_json,'$.mobLabel'),'Saved native agent') ELSE 'Unreadable saved agent' END AS label,'last observed' AS status,'Saved native agent or crew observation. Current state and unloaded mailbox contents are unknown.' AS detail,NULL AS definitionId,o.agent_ref AS observedRef FROM meerkat_observed_agents o WHERE o.agent_ref=(SELECT latest.agent_ref FROM meerkat_observed_agents latest WHERE latest.project_id=o.project_id AND latest.instance_id=o.instance_id AND latest.durable_id=o.durable_id ORDER BY latest.last_seen_at DESC,latest.agent_ref LIMIT 1)
  ) SELECT 'saved-agent' AS kind,*,COUNT(*) OVER() AS total FROM saved ORDER BY projectId,id LIMIT 100`.pipe(
    Effect.flatMap(decodeRows),
  );
  const queueKeys = [...new Set(queues.flatMap((row) => (row.queueKey ? [row.queueKey] : [])))];
  const observedRefs = agents.flatMap((row) => (row.observedRef ? [row.observedRef] : []));
  // Resolve only the bounded inventory from durable discovery records. No runtime admission,
  // configuration changes, or queue claims are part of opening a saved conversation.
  const conversations = yield* sql`
    SELECT o.agent_ref AS agentRef,o.project_id AS projectId,o.instance_id AS instanceId,
      o.durable_id AS durableId,o.provider_state_root AS providerStateRoot,
      o.project_path AS projectPath,o.state_root AS stateRoot,o.agent_json AS agentJson,
      p.title AS projectLabel,t.thread_id AS threadId,t.title AS threadLabel,
      d.agent_id AS agentId,d.label AS agentLabel,d.agent_identity AS primaryIdentity
    FROM meerkat_observed_agents o
    LEFT JOIN projection_projects p ON p.project_id=o.project_id AND p.deleted_at IS NULL
    LEFT JOIN projection_threads t ON t.thread_id=o.thread_id AND t.project_id=o.project_id AND t.deleted_at IS NULL
    LEFT JOIN meerkat_project_agents d ON d.project_id=o.project_id AND d.instance_id=o.instance_id
      AND d.provider_state_root=o.provider_state_root AND d.state_root IS o.state_root
      AND d.agent_id=CASE WHEN json_valid(o.agent_json) THEN json_extract(o.agent_json,'$.projectAgentId') END
      AND d.mob_id=CASE WHEN json_valid(o.agent_json) THEN json_extract(o.agent_json,'$.mobId') END
    WHERE o.agent_ref IN ${sql.in(observedRefs.length ? observedRefs : [""])}
      OR o.agent_ref IN (
        SELECT (SELECT latest.agent_ref FROM meerkat_observed_agents latest
          WHERE latest.project_id=q.project_id AND latest.instance_id=q.instance_id AND latest.durable_id=q.durable_id
          ORDER BY latest.last_seen_at DESC,latest.agent_ref LIMIT 1)
        FROM meerkat_agent_queues q WHERE q.target_key IN ${sql.in(queueKeys.length ? queueKeys : [""])}
      )`.pipe(Effect.flatMap(decodeConversations));
  const groups = [queues, deliveries, sessions, agents];
  const projectIds = [...new Set(groups.flatMap((rows) => rows.map((row) => row.projectId)))];
  const projects = yield* sql`SELECT project_id AS id,title FROM projection_projects
    WHERE deleted_at IS NULL AND project_id IN ${sql.in(projectIds.length ? projectIds : [""])}`.pipe(
    Effect.flatMap(decodeProjectLabels),
  );
  const projectLabels = new Map(projects.map((project) => [project.id, project.title]));
  const destinations = new Map<string, RestoreReviewDestination>();
  for (const queue of queues) {
    if (!queue.queueKey || !queue.bindingJson) continue;
    const binding = decodeQueueBinding(queue.bindingJson);
    if (Option.isNone(binding)) continue;
    const saved = binding.value;
    if (
      saved.projectId !== queue.projectId ||
      saved.instanceId !== queue.instanceId ||
      saved.durableId !== queue.durableId
    )
      continue;
    const matches = conversations.filter(
      (row) =>
        row.projectId === saved.projectId &&
        row.instanceId === saved.instanceId &&
        row.durableId === saved.durableId,
    );
    if (matches.length !== 1) continue;
    const row = matches[0]!;
    const agent = decodeSavedAgent(row.agentJson);
    if (
      Option.isNone(agent) ||
      row.providerStateRoot !== saved.providerStateRoot ||
      row.projectPath !== saved.projectPath ||
      row.stateRoot !== saved.stateRoot ||
      agent.value.mobId !== saved.mobId ||
      agent.value.record.identity !== saved.identity
    )
      continue;
    const destination = savedConversationDestination(row);
    if (destination) destinations.set(queue.queueKey, destination);
  }
  return {
    ...status,
    nativeMailbox: "unknown-unloaded" as const,
    counts: {
      queuedMessages: queues[0]?.total ?? 0,
      uncertainDeliveries: deliveries[0]?.total ?? 0,
      interruptedSessions: sessions[0]?.total ?? 0,
      savedAgents: agents[0]?.total ?? 0,
    },
    items: groups.flatMap((rows) =>
      rows.map((row): RestoreReviewItem => {
        const { kind, id, projectId, instanceId, threadId, label, status, detail } = row;
        const projectLabel = projectLabels.get(projectId);
        const observed = row.observedRef
          ? conversations.find((entry) => entry.agentRef === row.observedRef)
          : undefined;
        const destination = row.queueKey
          ? destinations.get(row.queueKey)
          : observed
            ? savedConversationDestination(observed)
            : projectLabel !== undefined && row.definitionId && instanceId
              ? {
                  kind: "project-agent" as const,
                  label: `${projectLabel} / ${label}`,
                  agentId: row.definitionId,
                  instanceId: ProviderInstanceId.make(instanceId),
                }
              : projectLabel !== undefined &&
                  kind === "interrupted-session" &&
                  threadId &&
                  row.threadDeletedAt === null
                ? {
                    kind: "thread" as const,
                    label: `${projectLabel} / ${label}`,
                    threadId: ThreadId.make(threadId),
                  }
                : undefined;
        return {
          kind,
          id,
          projectId,
          instanceId,
          threadId: destination?.kind === "thread" ? destination.threadId : threadId,
          label:
            kind === "queued-message" && destination ? `Message to ${destination.label}` : label,
          status,
          detail,
          ...(destination ? { destination } : {}),
        };
      }),
    ),
    truncated: groups.some((rows) => (rows[0]?.total ?? 0) > rows.length),
  } satisfies RestoreReviewSnapshot;
}).pipe(
  Effect.mapError(
    () =>
      new RestoreReviewError({
        message: "The saved work inventory could not be read. The restore hold is unchanged.",
      }),
  ),
);

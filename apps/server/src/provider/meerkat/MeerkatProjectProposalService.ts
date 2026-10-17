// @effect-diagnostics nodeBuiltinImport:off - ownership checks resolve real repository paths.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  MeerkatProjectProposalSetupInput,
  MeerkatProjectProposalCreateInput,
  MeerkatProjectAgentPrepareInput,
  MeerkatTeamError,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  ProviderOptionSelections,
  type MeerkatProjectAgent,
  type MeerkatProjectAgentPreparation,
  type MeerkatProjectProposal,
  type MeerkatProjectProposalInput,
  type MeerkatProjectProposalCreateResult,
  type ConsoleFrame,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Semaphore from "effect/Semaphore";
import type { ProviderInstance } from "../ProviderDriver.ts";
import type { MeerkatTeamReader } from "./MeerkatTeamReader.ts";
import { nativeWorkCompletion } from "./MeerkatWork.ts";
import {
  normalizeProjectAgentProposal,
  isProjectAgentProposalToolName,
} from "../../../../../scripts/meerkat-project-agent-proposal-contract.mjs";
import {
  agentFingerprint,
  decodeAgentAssignment,
  decodeAgentPreparation,
  type makeMeerkatProjectAgentStore,
  type MeerkatProjectAgentRow,
  type MeerkatProjectAgentAssignment,
} from "./MeerkatProjectAgentStore.ts";

const decodeSetup = Schema.decodeEffect(MeerkatProjectProposalSetupInput);
const decodeCreate = Schema.decodeEffect(MeerkatProjectProposalCreateInput);
const decodePrepare = Schema.decodeEffect(MeerkatProjectAgentPrepareInput);
const decodeOptions = Schema.decodeUnknownEffect(ProviderOptionSelections);
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeSourceRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      project_id: Schema.String,
      deleted_at: Schema.NullOr(Schema.String),
      archived_at: Schema.NullOr(Schema.String),
      model_selection_json: Schema.String,
      provider_name: Schema.NullOr(Schema.String),
      provider_instance_id: Schema.NullOr(Schema.String),
      runtime_payload_json: Schema.NullOr(Schema.String),
      source_busy: Schema.Number,
    }),
  ),
);
const decodeSetupRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ thread_id: Schema.String, instance_id: Schema.String })),
);
const decodeActivities = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ kind: Schema.String, payload_json: Schema.String })),
);
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const parsed = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "string") return object(value);
  try {
    return object(parseJson(value));
  } catch {
    return {};
  }
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const failure = (projectId: ProjectId, error: unknown) =>
  new MeerkatTeamError({ projectId, operation: "project-agent", message: message(error) });
const field = (value: unknown) => (typeof value === "string" && value.length ? value : null);

export const validateAgentOwnership = async (workspaceRoot: string, paths: readonly string[]) => {
  const root = await NodeFSP.realpath(workspaceRoot);
  for (const path of paths) {
    const target = await NodeFSP.realpath(NodePath.resolve(root, path));
    const relative = NodePath.relative(root, target);
    if (
      relative === ".." ||
      relative.startsWith(`..${NodePath.sep}`) ||
      NodePath.isAbsolute(relative)
    )
      throw new Error(`Ownership path escapes the project: ${path}`);
  }
  return root;
};

/** Content evidence includes uncommitted edits. A Git revision alone cannot identify a study. */
export const captureAgentStudyEvidence = async (
  workspaceRoot: string,
  paths: readonly string[],
) => {
  const root = await validateAgentOwnership(workspaceRoot, paths);
  const excludedDirectories = [".git", "node_modules", "target", "dist", ".next", ".turbo"];
  const entries = new Map<string, string>();
  const visitedDirectories = new Set<string>();
  let bytes = 0;
  const visit = async (relative: string): Promise<void> => {
    const target = NodePath.resolve(root, relative);
    const resolved = await NodeFSP.realpath(target);
    const within = NodePath.relative(root, resolved);
    if (within === ".." || within.startsWith(`..${NodePath.sep}`) || NodePath.isAbsolute(within))
      throw new Error(`Study path escapes the project: ${relative}`);
    const link = await NodeFSP.lstat(target);
    if (link.isSymbolicLink()) {
      entries.set(relative, `link:${await NodeFSP.readlink(target)}`);
    }
    const stat = await NodeFSP.stat(target);
    if (stat.isDirectory()) {
      if (visitedDirectories.has(resolved)) return;
      visitedDirectories.add(resolved);
      for (const name of (await NodeFSP.readdir(target)).sort()) {
        if (!excludedDirectories.includes(name)) await visit(NodePath.join(relative, name));
      }
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (entries.size >= 10_000 || bytes > 64 * 1024 * 1024)
        throw new Error(
          "This study scope exceeds 10,000 files or 64 MiB. Narrow the owned paths before refreshing.",
        );
      const content = await NodeFSP.readFile(target);
      entries.set(relative, NodeCrypto.createHash("sha256").update(content).digest("hex"));
    }
  };
  for (const path of paths.toSorted()) await visit(NodePath.normalize(path));
  return {
    contentFingerprint: agentFingerprint(
      [...entries.entries()].sort(([a], [b]) => a.localeCompare(b)).flat(),
    ),
    fileCount: entries.size,
    paths: [...paths],
    excludedDirectories,
  };
};

type Store = Effect.Success<typeof makeMeerkatProjectAgentStore>;
/** A successful completion belongs only to its durable preparation interaction. */
export const refreshAgentPreparation = Effect.fn("MeerkatProposal.refreshPreparation")(function* (
  store: Store,
  row: MeerkatProjectAgentRow,
  reader?: MeerkatTeamReader,
  projectPath?: string,
  requireCompleteHistory = false,
) {
  const preparation = row.preparation_json
    ? yield* decodeAgentPreparation(row.preparation_json).pipe(
        Effect.mapError((cause) => failure(ProjectId.make(row.project_id), cause)),
      )
    : null;
  if (!preparation || ["ready", "failed", "interrupted"].includes(preparation.status))
    return preparation;
  const projectId = ProjectId.make(row.project_id);
  let updated = preparation;
  if (!preparation.interactionId || !reader || !projectPath) {
    updated = {
      ...preparation,
      status: "uncertain",
      error: "Study delivery has no current native completion evidence. It was not replayed.",
    };
  } else {
    // Timeline projection can lag behind native finalization. Match the saved
    // request's acceptance before consulting the canonical work receipt; idle
    // state and another interaction's completion cannot settle this study.
    const snapshot = yield* reader
      .snapshot(projectPath, row.state_root)
      .pipe(Effect.orElseSucceed(() => null));
    const record = snapshot?.mobs
      .find((mob) => mob.mobId === row.mob_id)
      ?.identities.find(
        (member) => member.identity === row.agent_identity && !member.labels.source_mob_id,
      );
    const readExactEvidence = Effect.gen(function* () {
      if (record?.session_id && preparation.inputFrameId && reader.receipt) {
        const target = { projectPath, stateRoot: row.state_root, mobId: row.mob_id, record };
        const acceptance = yield* reader
          .receipt({ ...target, requestId: preparation.requestId })
          .pipe(Effect.orElseSucceed(() => undefined));
        if (
          acceptance &&
          !("kind" in acceptance) &&
          acceptance.interaction_id === preparation.interactionId &&
          acceptance.input_frame_id === preparation.inputFrameId &&
          acceptance.identity === record.identity &&
          acceptance.session_id === record.session_id
        ) {
          const completion = acceptance.completion;
          const terminal =
            completion &&
            completion.interaction_id === preparation.interactionId &&
            completion.runtime_key === record.runtime_key &&
            completion.source.kind !== "session_history" &&
            nativeWorkCompletion([completion], record)
              ? completion
              : undefined;
          const work =
            !terminal && reader.work
              ? yield* reader.work(target).pipe(Effect.orElseSucceed(() => null))
              : null;
          return { terminal, work };
        }
      }
      return null;
    });
    const readPage = (cursor?: string, before?: string) =>
      reader
        .activity({
          projectPath,
          stateRoot: row.state_root,
          mobId: row.mob_id,
          identity: row.agent_identity,
          limit: 100,
          mode: cursor === undefined ? "recent" : "since",
          ...(cursor ? { after: cursor } : {}),
          ...(before ? { before } : {}),
        })
        .pipe(Effect.orElseSucceed(() => null));
    let page = yield* readPage();
    if (page) {
      const findTerminal = (frames: ReadonlyArray<ConsoleFrame>) =>
        frames
          .toReversed()
          .find(
            (frame) =>
              frame.interaction_id === preparation.interactionId &&
              [
                "interaction_complete",
                "interaction_failed",
                "interaction_cancelled",
                "message_delivery_failed",
              ].includes(frame.kind),
          );
      let terminal = findTerminal(page.frames);
      let historyComplete = false;
      if (!terminal) {
        // Recent preserves input anchors and may omit a study's old terminal.
        // Since pagination follows native cursors without interpreting their value.
        const seen = new Set<string>();
        const frontier = page.latest_cursor;
        let after = "";
        while (!terminal) {
          page = yield* readPage(after, frontier);
          if (!page) break;
          terminal = findTerminal(page.frames);
          if (terminal || page.exhausted === true) {
            historyComplete = true;
            break;
          }
          const next = page.next_cursor;
          if (!next || seen.has(next)) break;
          seen.add(next);
          after = next;
        }
      }
      const evidence = !terminal ? yield* readExactEvidence : null;
      terminal ??= evidence?.terminal;
      const work = evidence?.work;
      const completion =
        work?.latestCompletion &&
        "interactionId" in work.latestCompletion &&
        work.latestCompletion.interactionId === preparation.interactionId
          ? work.latestCompletion
          : undefined;
      if (!terminal && !completion && work?.status === "idle") {
        // Finalization can land after the history frontier but before idle is
        // observed. Check one fresh page before treating that older absence as
        // current evidence; only this study's exact terminal can settle it.
        const current = yield* readPage();
        if (current) terminal = findTerminal(current.frames);
      }
      // Work currently groups cancelled and failed outcomes together. Only an
      // exact terminal failure report can decide interrupted versus failed.
      if (!terminal && completion?.status === "failed" && requireCompleteHistory)
        return yield* failure(
          projectId,
          "Native study ended but its failure report is not available. Preparation was not retried.",
        );
      if (!terminal && !completion && !historyComplete && requireCompleteHistory)
        return yield* failure(
          projectId,
          "Native study history could not be checked completely. Preparation was not retried.",
        );
      if (completion?.status === "completed")
        updated = {
          ...preparation,
          status: "ready",
          error: null,
        };
      else if (terminal)
        updated = {
          ...preparation,
          status:
            terminal.kind === "interaction_complete"
              ? "ready"
              : terminal.kind === "interaction_cancelled" ||
                  object(object(terminal.payload).error_report).class === "cancelled"
                ? "interrupted"
                : "failed",
          error:
            terminal.kind === "interaction_complete"
              ? null
              : (field(object(terminal.payload).error) ??
                field(object(terminal.payload).message) ??
                "Native study did not complete successfully."),
        };
      else {
        const busy = work
          ? work.status === "running"
          : reader.busy && record
            ? yield* reader
                .busy({ projectPath, stateRoot: row.state_root, mobId: row.mob_id, record })
                .pipe(Effect.orElseSucceed(() => null))
            : null;
        updated = {
          ...preparation,
          status:
            completion?.status === "failed"
              ? "uncertain"
              : busy === true
                ? "studying"
                : "uncertain",
          error:
            completion?.status === "failed"
              ? "Native study ended; its exact failure report is not available yet. It was not replayed."
              : busy === true
                ? null
                : historyComplete
                  ? "Study has no current native completion or active run evidence. It was not replayed."
                  : "Native study history could not be checked completely. It was not replayed.",
        };
      }
    } else {
      if (requireCompleteHistory)
        return yield* failure(
          projectId,
          "Native study history is unavailable. Preparation was not retried.",
        );
      updated = {
        ...preparation,
        status: "uncertain",
        error: "Native study history is unavailable. Delivery was not replayed.",
      };
    }
  }
  if (updated.status !== preparation.status || updated.error !== preparation.error) {
    updated = { ...updated, updatedAt: DateTime.formatIso(yield* DateTime.now) };
    yield* store.savePreparation(projectId, row.agent_id, updated);
    const current = yield* store.get(projectId, row.agent_id);
    if (current.preparation_json)
      return yield* decodeAgentPreparation(current.preparation_json).pipe(
        Effect.mapError((cause) => failure(projectId, cause)),
      );
  }
  return updated;
});

export const makeMeerkatProjectProposalService = (deps: {
  store: Store;
  lock: Semaphore.Semaphore;
  readProject: (id: ProjectId) => Effect.Effect<string, MeerkatTeamError>;
  provider: (
    id: ProjectId,
    instance: ProviderInstanceId,
  ) => Effect.Effect<{ instance: ProviderInstance; reader: MeerkatTeamReader }, MeerkatTeamError>;
  validateModel: (input: {
    projectId: ProjectId;
    instance: ProviderInstance;
    projectPath: string;
    model: string;
    options?: ProviderOptionSelections;
  }) => Effect.Effect<void, MeerkatTeamError>;
  connect: (
    id: ProjectId,
    row: MeerkatProjectAgentRow,
  ) => Effect.Effect<MeerkatProjectAgent, MeerkatTeamError>;
  project: (id: ProjectId, agentId: string) => Effect.Effect<MeerkatProjectAgent, MeerkatTeamError>;
  revise: (
    id: ProjectId,
    row: MeerkatProjectAgentRow,
    assignment: MeerkatProjectAgentAssignment,
    instructions: string,
    requestId: string,
  ) => Effect.Effect<MeerkatProjectAgentRow, MeerkatTeamError>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const source = Effect.fn("MeerkatProposal.source")(function* (
      projectId: ProjectId,
      threadId: ThreadId,
      absent = false,
    ) {
      yield* deps.readProject(projectId);
      const rows =
        yield* sql`SELECT t.project_id,t.deleted_at,t.archived_at,t.model_selection_json,r.provider_name,r.provider_instance_id,r.runtime_payload_json,
        EXISTS(SELECT 1 FROM projection_turns pending WHERE pending.thread_id=t.thread_id AND pending.state IN ('pending','running')) AS source_busy
      FROM projection_threads t LEFT JOIN provider_session_runtime r ON r.thread_id=t.thread_id WHERE t.thread_id=${threadId}`.pipe(
          Effect.flatMap(decodeSourceRows),
          Effect.mapError((cause) => failure(projectId, cause)),
        );
      const row = rows[0];
      if (!row && absent) return null;
      if (!row || row.project_id !== projectId || row.deleted_at || row.archived_at)
        return yield* failure(
          projectId,
          "Proposal source is not an active conversation in this project.",
        );
      const selection = parsed(row.model_selection_json);
      const instanceId = field(row.provider_instance_id) ?? field(selection.instanceId);
      const runtime = parsed(row.runtime_payload_json);
      const runtimeSelection = object(runtime.modelSelection);
      const model = field(runtime.model) ?? field(runtimeSelection.model) ?? field(selection.model);
      if (!instanceId || !model || (row.provider_name && row.provider_name !== "meerkat"))
        return yield* failure(projectId, "Proposal source must use a Meerkat provider and model.");
      const provider = yield* deps.provider(projectId, ProviderInstanceId.make(instanceId));
      const matches = (candidate: Record<string, unknown>) =>
        field(candidate.instanceId) === instanceId && field(candidate.model) === model;
      return {
        ...provider,
        instanceId: ProviderInstanceId.make(instanceId),
        model,
        modelOptions: matches(runtimeSelection)
          ? runtimeSelection.options
          : matches(selection)
            ? selection.options
            : undefined,
        bound: Boolean(row.provider_name),
        busy: Boolean(row.source_busy) || Boolean(field(runtime.activeTurnId)),
      };
    });
    const projectProposal = Effect.fn("MeerkatProposal.query")(function* (
      input: MeerkatProjectProposalInput,
    ): Effect.fn.Return<MeerkatProjectProposal, MeerkatTeamError> {
      yield* deps.readProject(input.projectId);
      const bindings =
        yield* sql`SELECT thread_id,instance_id FROM meerkat_project_agent_setup WHERE project_id=${input.projectId}`.pipe(
          Effect.flatMap(decodeSetupRows),
          Effect.mapError((cause) => failure(input.projectId, cause)),
        );
      let binding = bindings[0];
      if (!input.sourceThreadId && binding) {
        const existing =
          yield* sql`SELECT deleted_at,archived_at FROM projection_threads WHERE thread_id=${binding.thread_id}`.pipe(
            Effect.mapError((cause) => failure(input.projectId, cause)),
          );
        if (existing[0]?.deleted_at || existing[0]?.archived_at) binding = undefined;
      }
      const threadId = input.sourceThreadId ?? (binding ? ThreadId.make(binding.thread_id) : null);
      const empty: MeerkatProjectProposal = {
        projectId: input.projectId,
        isSetupThread: Boolean(threadId && binding?.thread_id === threadId),
        isSourceThreadPersisted: false,
        sourceThreadId: threadId,
        instanceId: null,
        model: null,
        available: false,
        status: "none",
        error: null,
        proposal: null,
      };
      if (!threadId) {
        if (!input.instanceId) return empty;
        const provider = yield* deps.provider(input.projectId, input.instanceId);
        const available = provider.reader.proposalAvailable
          ? yield* provider.reader.proposalAvailable().pipe(Effect.orElseSucceed(() => false))
          : false;
        return {
          ...empty,
          instanceId: input.instanceId,
          available,
          status: available ? "none" : "unavailable",
        };
      }
      const context = yield* source(input.projectId, threadId, true);
      if (!context) {
        if (!binding || binding.thread_id !== threadId) return empty;
        const provider = yield* deps.provider(
          input.projectId,
          ProviderInstanceId.make(binding.instance_id),
        );
        const available = provider.reader.proposalAvailable
          ? yield* provider.reader.proposalAvailable().pipe(Effect.orElseSucceed(() => false))
          : false;
        return {
          ...empty,
          instanceId: ProviderInstanceId.make(binding.instance_id),
          available,
          status: available ? "none" : "unavailable",
        };
      }
      const available = context.reader.proposalAvailable
        ? yield* context.reader.proposalAvailable().pipe(Effect.orElseSucceed(() => false))
        : false;
      const base = {
        ...empty,
        isSourceThreadPersisted: true,
        instanceId: context.instanceId,
        model: context.model,
        available,
      };
      if (!available)
        return {
          ...base,
          status: "unavailable",
          error: "The selected Meerkat runtime does not expose the project-agent proposal tool.",
        };
      if (!context.bound) return base;
      if (context.busy) return { ...base, status: "pending" };
      const rows =
        yield* sql`SELECT kind,payload_json FROM projection_thread_activities WHERE thread_id=${threadId} AND kind IN ('tool.started','tool.completed') ORDER BY COALESCE(sequence,0),created_at,activity_id`.pipe(
          Effect.flatMap(decodeActivities),
          Effect.mapError((cause) => failure(input.projectId, cause)),
        );
      let result: MeerkatProjectProposal = base;
      const calls = new Set<string>();
      const argumentsByCall = new Map<string, unknown>();
      let latestCall: string | null = null;
      for (const row of rows) {
        const payload = parsed(row.payload_json);
        const data = object(payload.data);
        if (!isProjectAgentProposalToolName(data.toolName)) continue;
        const proposalId = field(data.toolId);
        const callKey = field(payload.toolCallId) ?? proposalId;
        if (callKey && !calls.has(callKey)) {
          calls.add(callKey);
          latestCall = callKey;
        }
        if (callKey && data.toolArguments !== undefined)
          argumentsByCall.set(callKey, data.toolArguments);
        if (callKey && callKey !== latestCall) continue;
        result = { ...base, status: "pending", proposal: null };
        if (row.kind !== "tool.completed") continue;
        const toolResult = parsed(data.toolResult);
        if (
          !proposalId ||
          payload.status !== "completed" ||
          data.isError === true ||
          toolResult.isError === true
        ) {
          result = {
            ...base,
            status: "invalid",
            error: "The latest proposal tool call did not succeed.",
          };
          continue;
        }
        const proposal = normalizeProjectAgentProposal(
          data.toolArguments ?? (callKey ? argumentsByCall.get(callKey) : undefined),
          { proposalId },
        );
        result = proposal
          ? { ...base, status: "ready", proposal }
          : {
              ...base,
              status: "invalid",
              error: "The latest successful tool call has an invalid project-agent proposal.",
            };
      }
      return result;
    });
    const projectProposalSetup = Effect.fn("MeerkatProposal.setup")(function* (
      raw: MeerkatProjectProposalSetupInput,
    ) {
      const input = yield* decodeSetup(raw).pipe(
        Effect.mapError((cause) => failure(raw.projectId, cause)),
      );
      const context = yield* source(input.projectId, input.sourceThreadId, true);
      if (context && context.instanceId !== input.instanceId)
        return yield* failure(
          input.projectId,
          "Setup conversation belongs to another provider instance.",
        );
      const provider = context ?? (yield* deps.provider(input.projectId, input.instanceId));
      const available = provider.reader.proposalAvailable
        ? yield* provider.reader.proposalAvailable().pipe(Effect.orElseSucceed(() => false))
        : false;
      if (!available)
        return yield* failure(
          input.projectId,
          "The selected Meerkat runtime does not expose the project-agent proposal tool.",
        );
      const existing =
        yield* sql`SELECT project_id,instance_id,agent_ids_json FROM meerkat_thread_connections WHERE thread_id=${input.sourceThreadId}`.pipe(
          Effect.mapError((cause) => failure(input.projectId, cause)),
        );
      if (
        existing[0] &&
        (existing[0].project_id !== input.projectId || existing[0].instance_id !== input.instanceId)
      )
        return yield* failure(
          input.projectId,
          "This reserved conversation belongs to another project or provider instance.",
        );
      if (existing[0] && existing[0].agent_ids_json !== "[]")
        return yield* failure(
          input.projectId,
          "Setup conversation must be Solo before binding a project-agent proposal.",
        );
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`INSERT INTO meerkat_project_agent_setup(project_id,thread_id,instance_id,created_at) VALUES (${input.projectId},${input.sourceThreadId},${input.instanceId},${now}) ON CONFLICT(project_id) DO UPDATE SET thread_id=excluded.thread_id,instance_id=excluded.instance_id`.pipe(
        Effect.mapError((cause) => failure(input.projectId, cause)),
      );
      yield* sql`INSERT INTO meerkat_thread_connections(thread_id,project_id,instance_id,agent_ids_json,request_id,updated_at) VALUES (${input.sourceThreadId},${input.projectId},${input.instanceId},'[]',${`proposal:${input.sourceThreadId}`},${now}) ON CONFLICT(thread_id) DO NOTHING`.pipe(
        Effect.mapError((cause) => failure(input.projectId, cause)),
      );
      return input;
    }, deps.lock.withPermits(1));

    const prepare = Effect.fn("MeerkatProposal.prepare")(function* (
      input: MeerkatProjectAgentPrepareInput,
    ) {
      const row = yield* deps.store.get(input.projectId, input.agentId);
      if (!row.assignment_json)
        return yield* failure(
          input.projectId,
          "This agent has no accepted proposal assignment to prepare.",
        );
      if (!row.enabled || row.archived)
        return yield* failure(
          input.projectId,
          "Connect and unarchive this agent before preparation.",
        );
      if (row.pending_revision_json)
        return yield* failure(
          input.projectId,
          "Apply the pending responsibilities before starting a fresh study.",
        );
      const assignment = yield* decodeAgentAssignment(row.assignment_json).pipe(
        Effect.mapError((cause) => failure(input.projectId, cause)),
      );
      const projectPath = yield* deps.readProject(input.projectId);
      const { reader } = yield* deps.provider(
        input.projectId,
        ProviderInstanceId.make(row.instance_id),
      );
      if (reader.stateRoot !== row.provider_state_root)
        return yield* failure(
          input.projectId,
          "Original provider storage is required for preparation.",
        );
      const previous = yield* refreshAgentPreparation(
        deps.store,
        row,
        reader,
        projectPath,
        input.retry === true || input.refresh === true,
      );
      if (
        previous &&
        (previous.status === "studying" ||
          (!input.refresh && (!input.retry || previous.status === "ready")))
      )
        return yield* deps.project(input.projectId, row.agent_id);
      const observed = yield* deps.project(input.projectId, row.agent_id);
      const connected =
        observed.connectionStatus === "connected"
          ? observed
          : yield* deps.connect(input.projectId, row);
      if (!connected.agentRef || connected.connectionStatus !== "connected")
        return yield* failure(
          input.projectId,
          connected.error ?? "Agent could not connect for its study.",
        );
      const snapshot = yield* reader
        .snapshot(projectPath, row.state_root)
        .pipe(Effect.mapError((cause) => failure(input.projectId, cause)));
      const record = snapshot.mobs
        .find((mob) => mob.mobId === row.mob_id)
        ?.identities.find(
          (member) => member.identity === row.agent_identity && !member.labels.source_mob_id,
        );
      if (!record || !record.addressable || !reader.send)
        return yield* failure(input.projectId, "Agent is not addressable for study.");
      if (previous) {
        if (!reader.busy)
          return yield* failure(
            input.projectId,
            "Native run status is unavailable. Preparation was not retried.",
          );
        const busy = yield* reader
          .busy({ projectPath, stateRoot: row.state_root, mobId: row.mob_id, record })
          .pipe(Effect.mapError((cause) => failure(input.projectId, cause)));
        if (busy)
          return yield* failure(
            input.projectId,
            "The native agent is still busy. Stop or wait for it before retrying preparation.",
          );
      }
      const contentEvidence = yield* Effect.tryPromise({
        try: () => captureAgentStudyEvidence(projectPath, assignment.ownershipPaths),
        catch: (cause) => failure(input.projectId, cause),
      });
      const evidence = { ...contentEvidence, capturedAt: DateTime.formatIso(yield* DateTime.now) };
      const attempt = Math.max(
        previous ? previous.attempt + 1 : 1,
        yield* deps.store.nextStudyAttempt(input.projectId, row.agent_id),
      );
      const requestId = `domain-study:${assignment.assignmentId}:v${row.revision_version}:${attempt}`;
      let preparation: MeerkatProjectAgentPreparation = {
        assignmentId: assignment.assignmentId,
        fingerprint: assignment.fingerprint,
        attempt,
        revisionVersion: row.revision_version,
        status: "dispatching",
        requestId,
        interactionId: null,
        inputFrameId: null,
        error: null,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
        evidence,
      };
      yield* deps.store.savePreparation(input.projectId, row.agent_id, preparation);
      yield* deps.store.update(input.projectId, row.agent_id, { error: null });
      const text = `Refresh the domain study for ${row.label}.\nFocus: ${assignment.focus}\nCharter: ${assignment.charter}\nOwned repository paths: ${assignment.ownershipPaths.join(", ")}\nStudy snapshot: ${evidence.contentFingerprint} captured ${evidence.capturedAt}, including current working files. Generated directories excluded from the fingerprint: ${evidence.excludedDirectories.join(", ")}.\nInspect these exact paths and relevant callers, interfaces, tests, documentation and workflows using read-only operations. Compare against your previous brief, identify changed assumptions, and replace stale knowledge. Do not create, edit, delete, or otherwise modify any file, including documentation, plans, notes, summaries, and Domain Brief files. Do not contact external services or run deployed systems. Return one concise Domain Brief in your final conversation response only. Explain boundaries, architecture, invariants, important files, tests, and concrete risks, citing inspected repository paths. This is a snapshot, so re-inspect relevant working files before later advice or changes. Do not create a filesystem artifact or start implementation. Once the brief is complete, end the interaction without additional tasks.`;
      const receipt = yield* reader
        .send({
          projectPath,
          stateRoot: row.state_root,
          mobId: row.mob_id,
          record,
          text,
          handlingMode: "queue",
          requestId,
        })
        .pipe(
          Effect.map((value) => ({ value, error: null as string | null })),
          Effect.catch((cause) => Effect.succeed({ value: null, error: cause.detail })),
        );
      const native = object(object(receipt.value).receipt);
      const interactionId = field(native.interaction_id);
      preparation = {
        ...preparation,
        status: interactionId ? "studying" : "uncertain",
        interactionId,
        inputFrameId: field(native.input_frame_id),
        error:
          receipt.error ??
          (interactionId
            ? null
            : "Native delivery did not return an interaction identity. It was not replayed."),
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* deps.store.savePreparation(input.projectId, row.agent_id, preparation);
      return yield* deps.project(input.projectId, row.agent_id);
    });
    const projectAgentPrepare = Effect.fn("MeerkatProposal.prepareRequested")(function* (
      raw: MeerkatProjectAgentPrepareInput,
    ) {
      const input = yield* decodePrepare(raw).pipe(
        Effect.mapError((cause) => failure(raw.projectId, cause)),
      );
      return yield* prepare(input);
    }, deps.lock.withPermits(1));
    const projectProposalCreate = Effect.fn("MeerkatProposal.createSelected")(function* (
      raw: MeerkatProjectProposalCreateInput,
    ): Effect.fn.Return<MeerkatProjectProposalCreateResult, MeerkatTeamError> {
      const input = yield* decodeCreate(raw).pipe(
        Effect.mapError((cause) => failure(raw.projectId, cause)),
      );
      const latest = yield* projectProposal(input);
      if (
        !latest.proposal ||
        latest.status !== "ready" ||
        latest.proposal.proposalId !== input.proposalId ||
        !latest.instanceId ||
        !latest.model
      )
        return yield* failure(
          input.projectId,
          "This is not the latest successful native project-agent proposal.",
        );
      const ids = [...new Set(input.candidateIds)];
      if (
        !ids.length ||
        ids.some((id) => !latest.proposal!.agents.some((agent) => agent.id === id))
      )
        return yield* failure(
          input.projectId,
          "Select candidates from the current native proposal.",
        );
      const workspaceRoot = yield* deps.readProject(input.projectId);
      const results: Array<MeerkatProjectProposalCreateResult["results"][number]> = [];
      for (const candidateId of ids) {
        const candidate = latest.proposal.agents.find((item) => item.id === candidateId)!;
        let savedAgentId: string | null = null;
        const result = yield* Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => validateAgentOwnership(workspaceRoot, candidate.ownershipPaths),
            catch: (cause) => failure(input.projectId, cause),
          });
          const fingerprint = agentFingerprint([
            "1",
            candidate.role,
            candidate.focus,
            candidate.charter,
            ...candidate.ownershipPaths.toSorted(),
          ]);
          const assignment: MeerkatProjectAgentAssignment = {
            sourceThreadId: input.sourceThreadId,
            proposalId: input.proposalId,
            candidateId,
            focus: candidate.focus,
            charter: candidate.charter,
            ownershipPaths: candidate.ownershipPaths,
            fingerprint,
            assignmentId: `domain-recon-${candidate.role}-${fingerprint.slice(0, 16)}`,
          };
          const collaboration =
            input.accessMode === "repository-read-only"
              ? "Preserve this domain's context. Collaborate through attributed requests in the shared workspace; direct peer messaging, shell commands and file changes are unavailable. Re-inspect relevant repository files before giving advice; previous study is a dated snapshot."
              : "Preserve this domain's context and collaborate through native Meerkat messaging. Re-inspect relevant working files before giving advice or making changes; previous study is a dated snapshot. Make changes only when explicitly tasked.";
          const instructions = `You are ${candidate.label}, a long-lived project specialist.\nFocus: ${candidate.focus}\nCharter: ${candidate.charter}\nOwnership paths: ${candidate.ownershipPaths.join(", ")}\n${collaboration}`;
          let revised = false;
          const requestId = `proposal:${input.proposalId}:${candidateId}`;
          const saved = yield* deps.store.list(input.projectId);
          // An admitted creation keeps its original model and options across retries,
          // even when the source thread's picker has changed in the meantime.
          let admitted: MeerkatProjectAgentRow | undefined;
          for (const item of saved.filter((item) => item.request_id === requestId)) {
            const original = item.assignment_json
              ? yield* decodeAgentAssignment(item.assignment_json).pipe(
                  Effect.mapError((cause) => failure(input.projectId, cause)),
                )
              : null;
            if (
              original?.sourceThreadId === input.sourceThreadId &&
              original.proposalId === input.proposalId &&
              original.candidateId === candidateId
            ) {
              admitted = item;
              break;
            }
          }
          if (admitted && (admitted.archived || !admitted.enabled))
            return yield* failure(
              input.projectId,
              "This proposal agent is archived or disconnected. Restore it explicitly before preparing again.",
            );
          let row =
            admitted ??
            saved.find(
              (item) =>
                item.instance_id === latest.instanceId &&
                item.role === candidate.role &&
                !item.archived,
            );
          if (
            row &&
            input.accessMode === "repository-read-only" &&
            row.access_mode !== "repository-read-only"
          )
            return yield* failure(
              input.projectId,
              "An existing local agent owns this role with different permissions. It was not changed or shared. Propose a distinct role for the shared specialist.",
            );
          if (row) {
            const existing = row.assignment_json
              ? yield* decodeAgentAssignment(row.assignment_json).pipe(
                  Effect.mapError((cause) => failure(input.projectId, cause)),
                )
              : null;
            if (!existing || existing.fingerprint !== fingerprint) {
              if (row.access_mode === "repository-read-only") {
                const registered = yield* sql`SELECT specialist_id FROM shared_specialists
                  WHERE native_project_id=${input.projectId} AND native_instance_id=${row.instance_id}
                  AND native_agent_id=${row.agent_id}`;
                if (registered.length)
                  return yield* failure(
                    input.projectId,
                    "This specialist is already shared. Revise its assignments through the shared workspace to preserve shared composition history.",
                  );
              }
              row = yield* deps.revise(
                input.projectId,
                row,
                assignment,
                instructions,
                `proposal:${input.proposalId}:${candidateId}`,
              );
              revised = true;
            }
          } else {
            const provider = yield* deps.provider(input.projectId, latest.instanceId!);
            const providerStateRoot = provider.reader.stateRoot;
            const context = yield* source(input.projectId, input.sourceThreadId);
            if (
              !context ||
              context.instanceId !== latest.instanceId ||
              context.model !== latest.model
            )
              return yield* failure(
                input.projectId,
                "The proposal's model changed while preparing these agents. Review the proposal again.",
              );
            const options =
              context.modelOptions === undefined
                ? undefined
                : yield* decodeOptions(context.modelOptions).pipe(
                    Effect.mapError((cause) => failure(input.projectId, cause)),
                  );
            yield* deps.validateModel({
              projectId: input.projectId,
              instance: provider.instance,
              projectPath: workspaceRoot,
              model: latest.model!,
              ...(options === undefined ? {} : { options }),
            });
            const current = yield* deps.provider(input.projectId, latest.instanceId!);
            if (
              current.instance !== provider.instance ||
              current.reader.stateRoot !== providerStateRoot ||
              (yield* deps.readProject(input.projectId)) !== workspaceRoot
            )
              return yield* failure(
                input.projectId,
                "The project or provider changed while checking this model. Review the proposal again.",
              );
            const created = yield* Effect.gen(function* () {
              const created = yield* deps.store.create(
                {
                  projectId: input.projectId,
                  instanceId: latest.instanceId!,
                  model: latest.model!,
                  ...(options === undefined ? {} : { options }),
                  accessMode: input.accessMode ?? "read-only",
                  requestId,
                  label: candidate.label,
                  role: candidate.role,
                  instructions,
                },
                providerStateRoot,
              );
              if (created.row.archived || !created.row.enabled)
                return yield* failure(
                  input.projectId,
                  "This proposal agent is archived or disconnected. Restore it explicitly before preparing again.",
                );
              yield* deps.store.saveAssignment(input.projectId, created.row.agent_id, assignment);
              return created;
            }).pipe(
              sql.withTransaction,
              Effect.mapError((cause) => failure(input.projectId, cause)),
            );
            row = created.row;
          }
          savedAgentId = row.agent_id;
          const agent = row.pending_revision_json
            ? yield* deps.project(input.projectId, row.agent_id)
            : yield* prepare({
                projectId: input.projectId,
                agentId: row.agent_id,
                ...(revised ? { refresh: true } : {}),
              });
          return { candidateId, agent, error: null };
        }).pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              const agent = savedAgentId
                ? yield* deps
                    .project(input.projectId, savedAgentId)
                    .pipe(Effect.orElseSucceed(() => null))
                : null;
              return { candidateId, agent, error: message(cause) };
            }),
          ),
        );
        results.push(result);
      }
      return {
        projectId: input.projectId,
        sourceThreadId: input.sourceThreadId,
        proposalId: input.proposalId,
        results,
      };
    }, deps.lock.withPermits(1));
    return {
      projectProposal,
      projectProposalSetup,
      projectProposalCreate,
      projectAgentPrepare,
      prepareUnlocked: prepare,
    };
  });

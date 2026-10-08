import * as NodeCrypto from "node:crypto";
import { requireRestoreReviewReleased } from "../../restoreReview.ts";
import {
  CommandId,
  ModelSelection,
  TurnId,
  type OrchestrationSession,
  type ProviderSession,
  type MeerkatReconnectThreadReceipt,
  MeerkatThreadRecoveryError,
  MeerkatThreadRecoveryReceipt,
  type MeerkatRecoverThreadInput,
  type MeerkatThreadRecovery,
  type MeerkatThreadRecoveryTarget,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { meerkatProjectStateRoot } from "../Layers/MeerkatAdapter.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";

const Cursor = Schema.Struct({
  version: Schema.Literal(1),
  threadId: Schema.String,
  mobId: Schema.String,
  projectPath: Schema.String,
  stateRoot: Schema.String,
  lastRunId: Schema.optional(Schema.String),
});
const Marker = Schema.Struct({ version: Schema.Literal(1), runId: Schema.optional(Schema.String) });
const decodeCursor = Schema.decodeUnknownEffect(Cursor);
const decodeMarker = Schema.decodeEffect(Schema.fromJsonString(Marker));
const decodeLocation = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      workspace_root: Schema.String,
      worktree_path: Schema.NullOr(Schema.String),
    }),
  ),
);
const NativeStatus = Schema.Struct({
  runId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  mobId: Schema.NullOr(Schema.String),
  status: Schema.Literals(["running", "completed", "failed", "cancelled", "unknown", "recovered"]),
  canRecover: Schema.optional(Schema.Boolean),
  recoveryReason: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeStatus = Schema.decodeUnknownSync(NativeStatus);
const decodeReceipt = Schema.decodeUnknownSync(MeerkatThreadRecoveryReceipt);
const decodeSavedModel = Schema.decodeUnknownEffect(
  Schema.Struct({ modelSelection: Schema.optional(ModelSelection) }),
);
const recoveredMessage =
  "Interrupted work was stopped. Its outcome remains unknown. Review any external effects before sending a new message; your saved conversation is preserved.";
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Recovery targets come exclusively from the persisted provider binding and dispatch marker. */
export const makeMeerkatThreadRecoveryService = Effect.fn("makeMeerkatThreadRecoveryService")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const registry = yield* ProviderInstanceRegistry;
    const directory = yield* ProviderSessionDirectory;
    const engine = yield* OrchestrationEngineService;
    const projection = yield* ProjectionSnapshotQuery;
    const lock = yield* Semaphore.make(1);
    const fail = (input: MeerkatThreadRecoveryTarget, cause: unknown) =>
      new MeerkatThreadRecoveryError({
        projectId: input.projectId,
        threadId: input.threadId,
        message: errorText(cause),
      });
    const target = Effect.fn("ThreadRecovery.target")(function* (
      input: MeerkatThreadRecoveryTarget,
    ) {
      const locations = yield* sql`SELECT p.workspace_root,t.worktree_path FROM projection_threads t
      JOIN projection_projects p ON p.project_id=t.project_id
      WHERE t.thread_id=${input.threadId} AND t.project_id=${input.projectId}
      AND t.deleted_at IS NULL AND p.deleted_at IS NULL`.pipe(
        Effect.flatMap(decodeLocation),
        Effect.mapError((cause) => fail(input, cause)),
      );
      const location = locations[0];
      if (!location)
        return yield* fail(input, "This thread does not belong to the selected project.");
      const saved = yield* directory
        .getBinding(input.threadId)
        .pipe(Effect.mapError((cause) => fail(input, cause)));
      if (Option.isNone(saved)) return null;
      const binding = saved.value;
      if (binding.provider !== "meerkat" || binding.providerInstanceId !== input.instanceId)
        return yield* fail(
          input,
          "This thread belongs to a different provider connection. Refresh the conversation.",
        );
      const instance = yield* registry.getInstance(input.instanceId);
      if (
        !instance?.enabled ||
        instance.driverKind !== "meerkat" ||
        !instance.meerkatControls ||
        !instance.meerkatTeam
      )
        return yield* fail(
          input,
          "This Meerkat connection is unavailable. Reconnect before checking interrupted work.",
        );
      if (binding.resumeCursor == null) return null;
      const cursor = yield* decodeCursor(binding.resumeCursor).pipe(
        Effect.mapError((cause) => fail(input, cause)),
      );
      const projectPath = path.resolve(location.worktree_path ?? location.workspace_root);
      const stateRoot = meerkatProjectStateRoot(path, instance.meerkatTeam.stateRoot, projectPath);
      const mobId = `t3-${NodeCrypto.createHash("sha256").update(`${input.instanceId}:${input.threadId}`).digest("hex")}`;
      if (
        cursor.threadId !== input.threadId ||
        cursor.projectPath !== projectPath ||
        cursor.stateRoot !== stateRoot ||
        cursor.mobId !== mobId
      )
        return yield* fail(
          input,
          "The saved operation identity no longer matches this thread and workspace. Recovery was not attempted.",
        );
      const markerPath = path.join(stateRoot, "t3-dispatch", `${mobId}.json`);
      const hasMarker = yield* fs
        .exists(markerPath)
        .pipe(Effect.mapError((cause) => fail(input, cause)));
      const marker = hasMarker
        ? yield* fs.readFileString(markerPath).pipe(
            Effect.flatMap(decodeMarker),
            Effect.mapError((cause) => fail(input, cause)),
          )
        : null;
      return {
        instance,
        binding,
        cursor,
        params: { projectPath, stateRoot, mobId, threadId: input.threadId },
        runId: marker ? (marker.runId ?? null) : (cursor.lastRunId ?? null),
        legacyMarker: marker !== null && !marker.runId,
      };
    });
    const inspect = Effect.fn("ThreadRecovery.inspect")(function* (
      input: MeerkatThreadRecoveryTarget,
    ) {
      const resolved = yield* target(input);
      if (!resolved || (!resolved.runId && !resolved.legacyMarker))
        return {
          resolved,
          native: null,
          state: {
            status: "none",
            runId: null,
            canRecover: false,
            message: "No interrupted operation is recorded.",
          } satisfies MeerkatThreadRecovery,
        };
      if (resolved.legacyMarker || !resolved.runId)
        return {
          resolved,
          native: null,
          state: {
            status: "unavailable",
            runId: null,
            canRecover: false,
            message:
              "This older dispatch has no operation identity. It cannot be safely stopped from this conversation. The original message will not be replayed.",
          } satisfies MeerkatThreadRecovery,
        };
      const native = yield* Effect.tryPromise({
        try: async () => {
          const result = decodeStatus(
            await resolved.instance.meerkatControls!.request("mobs.v1.runStatus", {
              ...resolved.params,
              runId: resolved.runId,
            }),
          );
          if (
            result.runId !== resolved.runId ||
            result.threadId !== input.threadId ||
            result.mobId !== resolved.params.mobId
          )
            throw Error(
              "The runtime returned a different operation identity. Recovery was not attempted.",
            );
          return result;
        },
        catch: (cause) => fail(input, cause),
      });
      let state: MeerkatThreadRecovery;
      if (native.status === "running")
        state = {
          status: "running",
          runId: resolved.runId,
          canRecover: false,
          message: "The original operation is still running. Reconnect to follow its progress.",
        };
      else if (native.status === "recovered")
        state = {
          status: "recovered",
          runId: resolved.runId,
          canRecover: false,
          message: recoveredMessage,
        };
      else if (native.status !== "unknown")
        state = {
          status: "settled",
          runId: resolved.runId,
          canRecover: false,
          message:
            "The original operation has a terminal receipt. Reconnect to continue the saved conversation.",
        };
      else
        state = {
          status: native.canRecover ? "interrupted" : "unavailable",
          runId: resolved.runId,
          canRecover: native.canRecover === true,
          message: native.canRecover
            ? "The last operation has no confirmed outcome. Stop its remaining work before continuing. Any external effects still need review; the message will not be replayed."
            : (native.recoveryReason ??
              "The runtime cannot prove ownership of this interrupted operation. Recovery is unavailable; the message will not be replayed."),
        };
      return { resolved, native, state };
    });
    const status = Effect.fn("ThreadRecovery.status")(function* (
      input: MeerkatThreadRecoveryTarget,
    ) {
      return (yield* inspect(input)).state;
    });
    const threadState = Effect.fn("ThreadRecovery.threadState")(function* (
      input: MeerkatRecoverThreadInput,
    ) {
      const snapshot = yield* projection
        .getThreadShellById(input.threadId)
        .pipe(Effect.mapError((cause) => fail(input, cause)));
      if (Option.isNone(snapshot) || snapshot.value.projectId !== input.projectId)
        return yield* fail(input, "The conversation is no longer available in this project.");
      const thread = snapshot.value;
      if (
        thread.session?.providerInstanceId !== input.instanceId ||
        (thread.session.activeTurnId !== null && thread.session.activeTurnId !== input.runId) ||
        (thread.latestTurn?.state === "running" && thread.latestTurn.turnId !== input.runId)
      )
        return yield* fail(
          input,
          "A newer operation or provider owns this conversation. Refresh before continuing.",
        );
      return thread;
    });
    const finalize = Effect.fn("ThreadRecovery.finalize")(function* (
      input: MeerkatRecoverThreadInput,
      expectedInstance: ProviderInstance,
      sessionStatus: OrchestrationSession["status"],
      resumed?: ProviderSession,
    ) {
      const thread = yield* threadState(input);
      const timestamp = DateTime.formatIso(yield* DateTime.now);
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* target(input);
            if (!current || current.runId !== input.runId || current.instance !== expectedInstance)
              return yield* fail(
                input,
                "The saved operation changed before its session could be updated.",
              );
            yield* directory
              .upsert({
                ...current.binding,
                status: resumed ? "running" : "stopped",
                ...(resumed?.resumeCursor !== undefined
                  ? { resumeCursor: resumed.resumeCursor }
                  : {}),
                runtimePayload: {
                  activeTurnId: sessionStatus === "running" ? input.runId : null,
                  lastError: null,
                  continueAfterServerUpdate: null,
                  continueAfterServerUpdatePrepared: null,
                },
              })
              .pipe(Effect.mapError((cause) => fail(input, cause)));
          }),
        )
        .pipe(Effect.mapError((cause) => fail(input, cause)));
      // The engine compares the current session in its serialized command queue.
      yield* engine
        .dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(
            `meerkat-recovery:${input.threadId}:${input.runId}:${NodeCrypto.randomUUID()}`,
          ),
          threadId: input.threadId,
          expectedCurrent: thread.session,
          expectedThreadUpdatedAt: thread.updatedAt,
          session: {
            ...thread.session!,
            threadId: input.threadId,
            providerName: "meerkat",
            providerInstanceId: input.instanceId,
            runtimeMode: resumed?.runtimeMode ?? thread.session!.runtimeMode,
            status: sessionStatus,
            activeTurnId: sessionStatus === "running" ? TurnId.make(input.runId) : null,
            lastError: null,
            updatedAt: timestamp,
          },
          createdAt: timestamp,
        })
        .pipe(Effect.mapError((cause) => fail(input, cause)));
    });
    const recover = Effect.fn("ThreadRecovery.recover")(function* (
      input: MeerkatRecoverThreadInput,
    ) {
      // Native cold cleanup materializes the session, which can resume saved work.
      yield* requireRestoreReviewReleased.pipe(
        Effect.mapError((cause) => fail(input, cause.message)),
      );
      const { resolved, state } = yield* inspect(input);
      if (!resolved || resolved.runId !== input.runId)
        return yield* fail(
          input,
          "The interrupted operation changed. Refresh before stopping work.",
        );
      if (state.status !== "recovered" && !state.canRecover)
        return yield* fail(
          input,
          state.status === "running"
            ? "This operation is still running. Reconnect and use its live stop control."
            : state.message,
        );
      if (
        !resolved.instance.adapter.withSessionRecovery ||
        !resolved.instance.adapter.releaseRecoveredSession
      )
        return yield* fail(
          input,
          "This provider connection does not support safe session recovery.",
        );
      return yield* resolved.instance.adapter
        .withSessionRecovery(
          input.threadId,
          input.runId,
          Effect.gen(function* () {
            const before = yield* target(input);
            if (!before || before.runId !== input.runId || before.instance !== resolved.instance)
              return yield* fail(
                input,
                "The provider connection changed. Refresh before recovery.",
              );
            yield* threadState(input);
            // Recovered operations remain idempotent so a lost cleanup reply can be reconciled.
            const receipt = yield* Effect.tryPromise({
              try: async () => {
                const result = decodeReceipt(
                  await resolved.instance.meerkatControls!.request("mobs.v1.recoverThread", {
                    ...resolved.params,
                    runId: input.runId,
                  }),
                );
                if (result.runId !== input.runId)
                  throw Error("The runtime did not confirm cleanup of the selected operation.");
                return result;
              },
              catch: (cause) => fail(input, cause),
            });
            const current = yield* target(input);
            if (!current || current.runId !== input.runId || current.instance !== resolved.instance)
              return yield* fail(
                input,
                "The saved operation changed during cleanup. Refresh before continuing.",
              );
            yield* threadState(input);
            yield* resolved.instance.adapter.releaseRecoveredSession!(
              input.threadId,
              input.runId,
            ).pipe(Effect.mapError((cause) => fail(input, cause)));
            yield* finalize(input, resolved.instance, "stopped");
            return receipt;
          }),
        )
        .pipe(Effect.mapError((cause) => fail(input, cause)));
    }, lock.withPermits(1));
    const reconnect = Effect.fn("ThreadRecovery.reconnect")(function* (
      input: MeerkatRecoverThreadInput,
    ): Effect.fn.Return<MeerkatReconnectThreadReceipt, MeerkatThreadRecoveryError> {
      yield* requireRestoreReviewReleased.pipe(
        Effect.mapError((cause) => fail(input, cause.message)),
      );
      const { resolved, state, native } = yield* inspect(input);
      if (
        !resolved ||
        resolved.runId !== input.runId ||
        !native ||
        (state.status !== "running" && state.status !== "settled")
      )
        return yield* fail(
          input,
          "This operation cannot be reconnected. Refresh to check whether cleanup is needed.",
        );
      if (
        !resolved.instance.adapter.withSessionRecovery ||
        !resolved.instance.adapter.reconnectSession
      )
        return yield* fail(input, "This provider connection does not support safe reconnection.");
      return yield* resolved.instance.adapter
        .withSessionRecovery(
          input.threadId,
          input.runId,
          Effect.gen(function* () {
            const before = yield* inspect(input);
            if (
              !before.resolved ||
              before.resolved.runId !== input.runId ||
              before.resolved.instance !== resolved.instance ||
              !before.native ||
              (before.state.status !== "running" && before.state.status !== "settled")
            )
              return yield* fail(
                input,
                "The provider connection changed. Refresh before reconnecting.",
              );
            const thread = yield* threadState(input);
            const terminalStatus =
              before.native.status === "failed"
                ? "error"
                : before.native.status === "cancelled"
                  ? "interrupted"
                  : null;
            if (terminalStatus !== null && thread.latestTurn?.state === "running") {
              // Preserve the known terminal outcome before reattachment,
              // without claiming that a session is live.
              yield* finalize(input, resolved.instance, terminalStatus);
            }
            const savedModel = yield* decodeSavedModel(resolved.binding.runtimePayload ?? {}).pipe(
              Effect.mapError((cause) => fail(input, cause)),
            );
            const modelSelection = savedModel.modelSelection ?? thread.modelSelection;
            if (modelSelection.instanceId !== input.instanceId)
              return yield* fail(
                input,
                "The saved model belongs to a different provider. Refresh before reconnecting.",
              );
            const session = yield* resolved.instance.adapter.reconnectSession!({
              threadId: input.threadId,
              providerInstanceId: input.instanceId,
              provider: resolved.binding.provider,
              expectedRunId: input.runId,
              cwd: resolved.params.projectPath,
              title: thread.title,
              modelSelection,
              resumeCursor: resolved.binding.resumeCursor,
              runtimeMode: resolved.binding.runtimeMode ?? thread.runtimeMode,
            }).pipe(Effect.mapError((cause) => fail(input, cause)));
            if (
              session.threadId !== input.threadId ||
              session.providerInstanceId !== input.instanceId ||
              (session.status !== "running" && session.status !== "ready") ||
              (session.status === "running" && session.activeTurnId !== input.runId)
            )
              return yield* fail(input, "The adapter did not reconnect the selected operation.");
            const observed = yield* inspect(input);
            if (
              !observed.resolved ||
              observed.resolved.instance !== resolved.instance ||
              observed.resolved.runId !== input.runId ||
              !observed.native ||
              (observed.state.status !== "running" && observed.state.status !== "settled")
            )
              return yield* fail(
                input,
                "The original operation changed while reconnecting. Refresh before continuing.",
              );
            if ((session.status === "running") !== (observed.native.status === "running"))
              return yield* fail(
                input,
                "The operation finished while reconnecting. Refresh to reconcile its terminal receipt.",
              );
            const observedTerminalStatus =
              observed.native.status === "failed"
                ? "error"
                : observed.native.status === "cancelled"
                  ? "interrupted"
                  : null;
            const currentThread = yield* threadState(input);
            if (observedTerminalStatus !== null && currentThread.latestTurn?.state === "running")
              yield* finalize(input, resolved.instance, observedTerminalStatus);
            // The old run's outcome belongs to its receipt and turn history. A
            // reattached ready session can accept a new message even after failure.
            // finalize reads the current snapshot again after any settlement above.
            yield* finalize(
              input,
              resolved.instance,
              session.status === "running" ? "running" : "ready",
              session,
            );
            return { runId: input.runId, reconnected: true as const, status: session.status };
          }),
        )
        .pipe(Effect.mapError((cause) => fail(input, cause)));
    }, lock.withPermits(1));
    return { status, recover, reconnect };
  },
);

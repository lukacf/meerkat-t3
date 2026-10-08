import {
  OrchestrationDispatchCommandError,
  type CommandId,
  type OrchestrationClientOrigin,
  type OrchestrationRetryPreparedTurnInput,
  type ThreadId,
  type ThreadPreparedTurn,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export type PreparedTurnRecoveryState =
  | { readonly status: "accepted"; readonly sequence: number }
  | { readonly status: "pending"; readonly preparedTurn: ThreadPreparedTurn }
  | {
      readonly status: "rejected";
      readonly preparedTurn: ThreadPreparedTurn | null;
      readonly message: string;
    }
  | { readonly status: "missing" };

export class PreparedTurnRecovery extends Context.Service<
  PreparedTurnRecovery,
  {
    readonly get: (input: {
      readonly threadId: ThreadId;
      readonly recoveryId: CommandId;
    }) => Effect.Effect<PreparedTurnRecoveryState, OrchestrationDispatchCommandError>;
    readonly retry: (
      input: OrchestrationRetryPreparedTurnInput,
      preflight: (
        prepared: ThreadPreparedTurn,
      ) => Effect.Effect<void, OrchestrationDispatchCommandError>,
      options?: { readonly origin?: OrchestrationClientOrigin },
    ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
  }
>()("t3/orchestration/PreparedTurnRecovery") {}

export const make = Effect.gen(function* () {
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const failure = (cause: unknown) =>
    new OrchestrationDispatchCommandError({
      message:
        cause instanceof Error
          ? cause.message
          : "The prepared message could not be read or retried. Its saved copy has been retained.",
      cause,
      bootstrapThreadDisposition: "retained",
    });

  const get: PreparedTurnRecovery["Service"]["get"] = Effect.fn("PreparedTurnRecovery.get")(
    function* (input) {
      const receipt = yield* receipts.getByCommandId({ commandId: input.recoveryId });
      if (Option.isSome(receipt)) {
        if (
          receipt.value.aggregateKind !== "thread" ||
          receipt.value.aggregateId !== input.threadId
        ) {
          return yield* new OrchestrationDispatchCommandError({
            message:
              "This request belongs to another thread. Its delivery cannot be replayed here.",
          });
        }
        if (receipt.value.status === "accepted")
          return { status: "accepted", sequence: receipt.value.resultSequence } as const;
      }
      const thread = yield* query.getThreadDetailById(input.threadId);
      const prepared =
        Option.isSome(thread) && thread.value.preparedTurn?.recoveryId === input.recoveryId
          ? thread.value.preparedTurn
          : null;
      if (Option.isSome(receipt))
        return {
          status: "rejected",
          preparedTurn: prepared,
          message:
            receipt.value.error ??
            "The original request was rejected. Edit its saved message before sending a new request.",
        } as const;
      if (!prepared) return { status: "missing" } as const;
      if (prepared.phase === "released")
        return {
          status: "rejected",
          preparedTurn: prepared,
          message: "This message was released for editing.",
        } as const;
      return { status: "pending", preparedTurn: prepared } as const;
    },
    Effect.mapError(failure),
  );

  const retry: PreparedTurnRecovery["Service"]["retry"] = Effect.fn("PreparedTurnRecovery.retry")(
    function* (input, preflight, options) {
      const state = yield* get(input);
      if (state.status === "accepted") return { sequence: state.sequence };
      if (state.status !== "pending")
        return yield* new OrchestrationDispatchCommandError({
          message:
            state.status === "rejected"
              ? state.message
              : "The original prepared message is unavailable. No new work was sent.",
          bootstrapThreadDisposition: "retained",
        });
      const prepared = state.preparedTurn;
      if (prepared.expectedCwd !== input.expectedCwd || prepared.phase !== "blocked")
        return yield* new OrchestrationDispatchCommandError({
          message:
            "Checkout preparation is still owned by its original request or has not finished. Review the saved thread before retrying.",
          bootstrapThreadDisposition: "retained",
        });
      if (
        (prepared.setup === "not_started" || prepared.setup === "sync_running") &&
        input.continueAfterInterruptedSetup !== true
      )
        return yield* new OrchestrationDispatchCommandError({
          message:
            "Setup did not finish. Confirm that you want to continue without rerunning setup.",
          bootstrapThreadDisposition: "retained",
        });
      yield* preflight(prepared);
      // The engine rechecks the saved command and binding in its serialized queue.
      // A concurrent accepted retry returns its receipt; a release rejects this ID.
      return yield* engine.dispatch(prepared.command, {
        ...options,
        preparedTurnRecoveryId: prepared.recoveryId,
        ...(input.continueAfterInterruptedSetup !== undefined
          ? { continueAfterInterruptedSetup: input.continueAfterInterruptedSetup }
          : {}),
      });
    },
    Effect.mapError(failure),
  );

  return PreparedTurnRecovery.of({ get, retry });
});

export const layer = Layer.effect(PreparedTurnRecovery, make);

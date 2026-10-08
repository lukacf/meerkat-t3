import { requireRestoreReviewReleased } from "../../restoreReview.ts";
import {
  CommandId,
  MeerkatControlError,
  MeerkatCoordinatorWork,
  MeerkatCoordinatorStopReceipt,
  type MeerkatCoordinatorTarget,
  type MeerkatCoordinatorControl,
  type MeerkatCoordinatorSteer,
  type MeerkatAgentControlReceipt,
  type ConsoleIdentityRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { extractMeerkatSkillSelections } from "@t3tools/shared/meerkatSkills";
import { ServerConfig } from "../../config.ts";
import { normalizeDispatchCommand } from "../../orchestration/Normalizer.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { meerkatProjectStateRoot } from "../Layers/MeerkatAdapter.ts";
import { agentFingerprint, makeMeerkatProjectAgentStore } from "./MeerkatProjectAgentStore.ts";
import { prepareMeerkatContent } from "./MeerkatMedia.ts";
import type { makeMeerkatTeamService } from "./MeerkatTeamService.ts";

const decodeWork = Schema.decodeUnknownSync(MeerkatCoordinatorWork);
const decodeStop = Schema.decodeUnknownSync(MeerkatCoordinatorStopReceipt);
const ConsoleReceipt = Schema.Struct({
  identity: Schema.String,
  session_id: Schema.String,
  input_frame_id: Schema.String,
  interaction_id: Schema.String,
  cursor: Schema.String,
  status: Schema.String,
});
const RuntimeReceipt = Schema.Struct({
  kind: Schema.Literal("runtime_input"),
  identity: Schema.String,
  sessionId: Schema.String,
  inputId: Schema.String,
  requestId: Schema.String,
  idempotencyKey: Schema.String,
  status: Schema.Literal("accepted"),
});
const Receipt = Schema.Union([RuntimeReceipt, ConsoleReceipt]);
const decodeReceipt = Schema.decodeUnknownSync(Receipt);
const encodeUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeLookup = Schema.decodeUnknownSync(
  Schema.Struct({ found: Schema.Boolean, receipt: Schema.optional(Schema.Unknown) }),
);
const decodeReply = Schema.decodeUnknownSync(Schema.Struct({ receipt: Schema.Unknown }));
const NativeTarget = Schema.Struct({
  providerStateRoot: Schema.String,
  params: Schema.Struct({
    projectPath: Schema.String,
    stateRoot: Schema.String,
    mobId: Schema.String,
    expected: Schema.Struct({
      identity: Schema.String,
      runtimeKey: Schema.String,
      runtimeMemberId: Schema.String,
      sessionId: Schema.String,
      sourceMobId: Schema.NullOr(Schema.String),
    }),
  }),
});
const decodeNativeTarget = Schema.decodeUnknownSync(Schema.fromJsonString(NativeTarget));
const expectedFor = (record: ConsoleIdentityRecord) => ({
  identity: record.identity,
  runtimeKey: record.runtime_key,
  runtimeMemberId: record.runtime_member_id,
  sessionId: record.session_id ?? null,
  sourceMobId: record.labels.source_mob_id ?? null,
});
/** Native work stays native; only the submitted user message is appended to T3 history. */
export const makeMeerkatCoordinatorWorkService = Effect.fn("makeMeerkatCoordinatorWorkService")(
  function* (team: Pick<Effect.Success<typeof makeMeerkatTeamService>, "interactionTarget">) {
    const registry = yield* ProviderInstanceRegistry;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    const engine = yield* OrchestrationEngineService;
    const store = yield* makeMeerkatProjectAgentStore;
    const lock = yield* Semaphore.make(1);
    const failure = (input: MeerkatCoordinatorTarget, cause: unknown) =>
      new MeerkatControlError({
        projectId: input.projectId,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    const target = Effect.fn("CoordinatorWork.target")(function* (input: MeerkatCoordinatorTarget) {
      const instance = yield* registry.getInstance(input.instanceId);
      if (!instance?.enabled || !instance.meerkatControls || !instance.meerkatTeam)
        return yield* failure(input, "This Meerkat connection is unavailable.");
      const resolved = yield* team
        .interactionTarget(input)
        .pipe(Effect.mapError((cause) => failure(input, cause)));
      if (!resolved.record.session_id)
        return yield* failure(input, "The coordinator has no live native session.");
      return {
        providerStateRoot: resolved.reader.stateRoot,
        request: instance.meerkatControls.request,
        params: {
          projectPath: resolved.projectPath,
          stateRoot:
            resolved.stateRoot ??
            meerkatProjectStateRoot(path, resolved.reader.stateRoot, resolved.projectPath),
          mobId: resolved.mobId,
          expected: expectedFor(resolved.record),
        },
      };
    });
    const work = Effect.fn("CoordinatorWork.work")(function* (input: MeerkatCoordinatorTarget) {
      const { request, params } = yield* target(input);
      return yield* Effect.tryPromise({
        try: async () => {
          const result = decodeWork(await request("mobs.v1.coordinatorWork", params));
          if (result.sessionId !== params.expected.sessionId)
            throw Error("Coordinator session changed; refresh the conversation.");
          return result;
        },
        catch: (cause) => failure(input, cause),
      });
    });
    const stop = Effect.fn("CoordinatorWork.stop")(function* (input: MeerkatCoordinatorControl) {
      const { request, params } = yield* target(input);
      if (params.expected.sessionId !== input.sessionId)
        return yield* failure(input, "This work belongs to a previous coordinator session.");
      return yield* Effect.tryPromise({
        try: async () => {
          const receipt = decodeStop(
            await request("mobs.v1.coordinatorStop", {
              ...params,
              inputId: input.inputId,
              nativeRunId: input.nativeRunId,
            }),
          );
          if (
            !receipt.accepted ||
            receipt.sessionId !== input.sessionId ||
            receipt.inputId !== input.inputId ||
            receipt.nativeRunId !== input.nativeRunId
          )
            throw Error("The native runtime did not confirm stopping the selected work.");
          return receipt;
        },
        catch: (cause) => failure(input, cause),
      });
    });
    const steer = Effect.fn("CoordinatorWork.steer")(function* (
      input: MeerkatCoordinatorSteer,
    ): Effect.fn.Return<
      MeerkatAgentControlReceipt,
      MeerkatControlError,
      Effect.Services<ReturnType<typeof normalizeDispatchCommand>>
    > {
      const requestId = `coordinator-steer:${input.threadId}:${input.message.messageId}`;
      if (!input.receiptOnly) {
        const selection = yield* Effect.try({
          try: () => extractMeerkatSkillSelections(input.message.text),
          catch: (cause) => failure(input, cause),
        });
        if (selection.skillReferences.length)
          return yield* failure(
            input,
            "Skills start with a new turn. Send this as a new message or queue it for later.",
          );
      }
      // This fingerprints the exact original client request. The resolved native
      // target is captured atomically with the claim, never read from a new roster.
      const fingerprint = agentFingerprint([
        encodeUnknown({ ...input, createdAt: undefined, receiptOnly: undefined }),
      ]);
      const saved = yield* store
        .delivery(input.projectId, input.instanceId, requestId)
        .pipe(Effect.mapError((cause) => failure(input, cause)));
      const uncertain = (message: string): MeerkatAgentControlReceipt => ({
        status: "uncertain",
        requestId,
        receipt: null,
        message,
      });
      const accepted = (raw: unknown, expectedIdentity: string): MeerkatAgentControlReceipt => {
        const receipt = decodeReceipt(raw);
        if ("kind" in receipt) {
          if (
            receipt.identity !== expectedIdentity ||
            receipt.sessionId !== input.sessionId ||
            receipt.requestId !== requestId ||
            receipt.inputId.length === 0 ||
            receipt.idempotencyKey.length === 0
          )
            throw Error("Native steering admission does not match this message and session.");
          return { status: "accepted", requestId, receipt, message: null };
        }
        if (
          receipt.identity !== expectedIdentity ||
          receipt.session_id !== input.sessionId ||
          receipt.status === "delivery_failed" ||
          receipt.status === "redacted"
        )
          throw Error("Native steering delivery is unresolved.");
        return { status: "accepted", requestId, receipt, message: null };
      };
      const reconcile = Effect.fn("CoordinatorWork.reconcile")(function* (
        receipt: MeerkatAgentControlReceipt,
        nativeTarget: string | null,
      ) {
        if (receipt.status === "accepted") return receipt;
        if (nativeTarget === null)
          return uncertain(
            "The original native target was not saved. Delivery remains unresolved and was not replayed.",
          );
        const original = yield* Effect.try({
          try: () => decodeNativeTarget(nativeTarget),
          catch: (cause) => failure(input, cause),
        });
        if (original.params.expected.sessionId !== input.sessionId)
          return yield* failure(input, "Receipt lookup belongs to a different native session.");
        const instance = yield* registry.getInstance(input.instanceId);
        if (
          !instance?.enabled ||
          !instance.meerkatControls ||
          instance.meerkatTeam?.stateRoot !== original.providerStateRoot
        )
          return yield* failure(
            input,
            "The original Meerkat connection and storage are required to check delivery.",
          );
        const reconciled = yield* Effect.tryPromise({
          try: async () => {
            const value = decodeLookup(
              await instance.meerkatControls!.request("mobs.v1.coordinatorSteerReceipt", {
                ...original.params,
                idempotencyKey: requestId,
              }),
            );
            return value.found
              ? accepted(value.receipt, original.params.expected.identity)
              : uncertain(
                  "Native acceptance is not yet confirmed. Check delivery again; this request will not be sent again.",
                );
          },
          catch: (cause) => failure(input, cause),
        });
        if (reconciled.status === "accepted")
          yield* store
            .saveReceipt(input.projectId, input.instanceId, requestId, reconciled)
            .pipe(Effect.mapError((cause) => failure(input, cause)));
        return reconciled;
      });
      if (saved) {
        if (saved.fingerprint !== fingerprint)
          return yield* failure(
            input,
            "Check delivery with the original message and native target. Changed or legacy requests are not replayed.",
          );
        return yield* reconcile(saved.receipt, saved.nativeTarget);
      }
      if (input.receiptOnly)
        return uncertain(
          "No saved submission was found. Delivery remains unresolved; no message was sent.",
        );
      yield* requireRestoreReviewReleased.pipe(
        Effect.mapError((cause) => failure(input, cause.message)),
      );
      const { request, params, providerStateRoot } = yield* target(input);
      if (params.expected.sessionId !== input.sessionId)
        return yield* failure(input, "This work belongs to a previous coordinator session.");
      const claim = yield* store
        .claimDelivery(input.projectId, input.instanceId, requestId, fingerprint, fingerprint, {
          providerStateRoot,
          params,
        })
        .pipe(Effect.mapError((cause) => failure(input, cause)));
      if (!claim.claimed) return yield* reconcile(claim.receipt, claim.nativeTarget);
      const result = yield* Effect.gen(function* () {
        const normalized = yield* normalizeDispatchCommand({
          type: "thread.turn.start",
          commandId: CommandId.make(requestId),
          threadId: input.threadId,
          message: { ...input.message, role: "user" },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: input.createdAt,
        });
        if (normalized.type !== "thread.turn.start")
          return yield* failure(input, "Could not prepare the steering message.");
        const text = projectComposerContextForProvider({
          text: normalized.message.text,
          records: normalized.message.context?.records ?? [],
        });
        const content = yield* Effect.tryPromise({
          try: () =>
            prepareMeerkatContent({
              text,
              attachments: normalized.message.attachments,
              attachmentsDir: config.attachmentsDir,
              scope: params,
              client: { request: (method, params) => request(method, params ?? {}) },
              readFile: (file) => Effect.runPromise(fs.readFile(file)),
            }),
          catch: (cause) => failure(input, cause),
        });
        yield* engine.dispatch({
          type: "thread.message.user.append",
          commandId: CommandId.make(`${requestId}:message`),
          threadId: input.threadId,
          message: normalized.message,
          createdAt: normalized.createdAt,
        });
        return yield* Effect.tryPromise({
          try: async () => {
            const result = decodeReply(
              await request("mobs.v1.coordinatorSteer", {
                ...params,
                inputId: input.inputId,
                nativeRunId: input.nativeRunId,
                idempotencyKey: requestId,
                content,
              }),
            );
            return accepted(result.receipt, params.expected.identity);
          },
          catch: (cause) => failure(input, cause),
        });
      }).pipe(
        Effect.mapError((cause) => failure(input, cause)),
        Effect.result,
      );
      const receipt: MeerkatAgentControlReceipt =
        result._tag === "Success"
          ? result.success
          : {
              status: "uncertain",
              requestId,
              receipt: null,
              message: `Steering was not confirmed. The message was not replayed: ${result.failure.message}`,
            };
      yield* store
        .saveReceipt(input.projectId, input.instanceId, requestId, receipt)
        .pipe(Effect.mapError((cause) => failure(input, cause)));
      return receipt;
    }, lock.withPermits(1));
    return { work, stop, steer };
  },
);

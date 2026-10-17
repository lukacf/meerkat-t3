import {
  SharedActivityPublishInput,
  SharedDelegationInvokeInput,
  SharedDirectoryListInput,
  SharedDiscoveryInput,
  SharedInboxAcknowledgeInput,
  SharedInboxReadInput,
  SharedKnowledgePutInput,
  SharedKnowledgeSearchInput,
  SharedProjectDetailInput,
  SharedSpecialistDetailInput,
  SharedSpecialistRequestInput,
  SharedSpecialistSendInput,
  SharedWorkspaceError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { makeSharedDelegationService } from "./SharedDelegationService.ts";
import { makeSharedDiscoveryService } from "./SharedDiscoveryService.ts";
import type { makeSharedSpecialistService } from "./SharedSpecialistService.ts";
import type { SharedWorkspaceStore } from "./SharedWorkspaceStore.ts";

const invalid = () =>
  new SharedWorkspaceError({
    code: "invalid_input",
    message: "Invalid delegated action arguments.",
  });
const parse = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(invalid));

/** Remote parent authentication plus the retained grant supplies all caller authority. */
export const makeSharedDelegationInvoker = (
  workspace: SharedWorkspaceStore,
  delegations: Effect.Success<ReturnType<typeof makeSharedDelegationService>>,
  specialists: Pick<
    Effect.Success<ReturnType<typeof makeSharedSpecialistService>>,
    "sendDelegated" | "requestDelegated"
  >,
) => {
  const discovery = makeSharedDiscoveryService(workspace);
  const invoke = Effect.fn("SharedDelegationInvoker.invoke")(function* (
    sessionId: string,
    raw: SharedDelegationInvokeInput,
  ) {
    const input = yield* parse(SharedDelegationInvokeInput, raw);
    const { actor, grant } = yield* delegations.authorize(sessionId, input);
    const args = input.arguments;
    const bound = <A extends { contextId: string; contextVersion: string }>(value: A) =>
      value.contextId === grant.context.contextId &&
      value.contextVersion === grant.context.contextVersion
        ? Effect.succeed(value)
        : Effect.fail(
            new SharedWorkspaceError({
              code: "forbidden",
              message: "This action must use the delegation's exact immutable task context.",
            }),
          );
    switch (input.action) {
      case "projects.list":
        return yield* workspace.listProjects(yield* parse(SharedDirectoryListInput, args));
      case "projects.get":
        return yield* workspace.project(
          (yield* parse(SharedProjectDetailInput, args)).sharedProjectId,
        );
      case "specialists.list":
        return yield* discovery.discover(yield* parse(SharedDiscoveryInput, args));
      case "specialists.get":
        return yield* workspace.specialist(
          (yield* parse(SharedSpecialistDetailInput, args)).specialistId,
        );
      case "specialists.send":
        return yield* specialists.sendDelegated(
          actor,
          yield* bound(yield* parse(SharedSpecialistSendInput, args)),
        );
      case "specialists.request":
        return yield* specialists.requestDelegated(
          actor,
          (yield* parse(SharedSpecialistRequestInput, args)).requestId,
        );
      case "inbox.list":
        return yield* workspace.readInbox(actor, yield* parse(SharedInboxReadInput, args));
      case "inbox.ack":
        yield* workspace.acknowledgeInbox(actor, yield* parse(SharedInboxAcknowledgeInput, args));
        return { acknowledged: true, meaning: "Product batch acknowledgement only." };
      case "activity.publish":
        return yield* workspace.publishActivity(
          actor,
          yield* bound(yield* parse(SharedActivityPublishInput, args)),
        );
      case "knowledge.search":
        return yield* workspace.searchKnowledge(yield* parse(SharedKnowledgeSearchInput, args));
      case "knowledge.record":
      case "knowledge.supersede": {
        const record = yield* bound(yield* parse(SharedKnowledgePutInput, args));
        if (input.action === "knowledge.supersede" && !record.supersedes.length)
          return yield* invalid();
        return yield* workspace.putKnowledge(actor, record);
      }
    }
  });
  return { invoke };
};

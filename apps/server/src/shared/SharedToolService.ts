import {
  SharedActivityPublishInput,
  SharedActivityFromInboxInput,
  SharedCompositionInput,
  SharedCompositionOperationInput,
  SharedInboxAcknowledgeInput,
  SharedInboxReadInput,
  SharedKnowledgePutInput,
  SharedKnowledgeFromInboxInput,
  SharedKnowledgeSearchInput,
  SharedSpecialist,
  SharedWorkspaceError,
  type SharedWorkContext,
  SharedDirectoryListInput,
  SharedProjectDetailInput,
  SharedSpecialistDetailInput,
  SharedDiscoveryInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { makeMeerkatTeamService } from "../provider/meerkat/MeerkatTeamService.ts";
import {
  sharedReadOnlyNativeAgent,
  type makeSharedSpecialistService,
} from "./SharedSpecialistService.ts";
import type { SharedWorkspaceStore, SharedActor } from "./SharedWorkspaceStore.ts";
import type { SharedToolInvocation, SharedToolResponse } from "./SharedToolHost.ts";
import { makeSharedDiscoveryService } from "./SharedDiscoveryService.ts";
import type { makeSharedCompositionService } from "./SharedCompositionService.ts";

const fail = (code: SharedWorkspaceError["code"], message: string) =>
  new SharedWorkspaceError({ code, message });
const isSharedError = Schema.is(SharedWorkspaceError);
const parse = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() =>
      fail("invalid_input", "Invalid arguments for this shared workspace action."),
    ),
  );
export type SharedRepositoryTools = {
  readonly list: (args: unknown) => Effect.Effect<unknown, SharedWorkspaceError>;
  readonly read: (args: unknown) => Effect.Effect<unknown, SharedWorkspaceError>;
  readonly search: (args: unknown) => Effect.Effect<unknown, SharedWorkspaceError>;
};

/** Only the private native transport supplies identity. Tool arguments supply product data. */
export const makeSharedToolService = Effect.fn("SharedToolService.make")(function* (
  workspace: SharedWorkspaceStore,
  specialists: Pick<
    Effect.Success<ReturnType<typeof makeSharedSpecialistService>>,
    "contextForInteraction"
  >,
  team: Pick<Effect.Success<typeof makeMeerkatTeamService>, "projectTeam">,
  repositories: SharedRepositoryTools,
  composition?: Pick<
    Effect.Success<ReturnType<typeof makeSharedCompositionService>>,
    "execute" | "operation"
  >,
  observationHost?: { readonly environmentId: EnvironmentId },
) {
  const sql = yield* SqlClient.SqlClient;
  const discovery = makeSharedDiscoveryService(workspace);
  const nativeActor = Effect.fn("SharedToolService.nativeActor")(function* (
    invocation: SharedToolInvocation,
  ) {
    // This application binding only locates candidates. A fresh native observation
    // must confirm the process-asserted mob/session and the actual access policy.
    const candidates = yield* sql<{
      definition_json: string;
    }>`SELECT s.definition_json FROM shared_specialists s
      JOIN meerkat_project_agents a ON a.agent_id = s.native_agent_id
        AND a.project_id = s.native_project_id AND a.instance_id = s.native_instance_id
      WHERE a.mob_id = ${invocation.mobId} LIMIT 101`;
    if (candidates.length > 100)
      return yield* fail("limit_exceeded", "Too many native specialist bindings.");
    const matches: SharedSpecialist[] = [];
    for (const row of candidates) {
      const specialist = yield* parse(Schema.fromJsonString(SharedSpecialist), row.definition_json);
      const target = specialist.nativeTarget;
      const roster = yield* team.projectTeam({ projectId: target.projectId });
      const definition = sharedReadOnlyNativeAgent(roster, target);
      const live = roster.providers
        .find((provider) => provider.instanceId === target.instanceId)
        ?.agents.find(
          (agent) =>
            agent.projectAgentId === target.agentId &&
            agent.mobId === invocation.mobId &&
            agent.record.session_id === invocation.sessionId &&
            agent.availability === "live" &&
            agent.record.addressable &&
            agent.agentRef === definition?.agentRef,
        );
      if (live && definition) matches.push(specialist);
    }
    if (matches.length !== 1)
      return yield* fail(
        "forbidden",
        "The native caller has no unambiguous live shared specialist binding.",
      );
    return matches[0]!;
  });
  const invoke = Effect.fn("SharedToolService.invoke")(
    function* (
      invocation: SharedToolInvocation,
    ): Effect.fn.Return<SharedToolResponse, SharedWorkspaceError> {
      const specialist = yield* nativeActor(invocation).pipe(
        Effect.mapError((cause) =>
          isSharedError(cause)
            ? cause
            : fail("unavailable", "Native caller verification is unavailable."),
        ),
      );
      const actor: SharedActor = { kind: "specialist", specialistId: specialist.specialistId };
      const boundContext = Effect.gen(function* () {
        if (!invocation.interactionId)
          return yield* fail(
            "forbidden",
            "This turn has no native participant-request binding. It cannot publish under a participant's task context.",
          );
        return yield* specialists.contextForInteraction(
          specialist.specialistId,
          invocation.sessionId,
          invocation.interactionId,
        );
      });
      const requireContext = Effect.fn("SharedToolService.requireContext")(function* (input: {
        contextId: string;
        contextVersion: string;
      }): Effect.fn.Return<SharedWorkContext, SharedWorkspaceError> {
        const context = yield* boundContext;
        if (
          input.contextId !== context.contextId ||
          input.contextVersion !== context.contextVersion
        )
          return yield* fail(
            "forbidden",
            "This action's work context does not belong to the native interaction.",
          );
        return context;
      });
      const args = invocation.arguments;
      switch (invocation.action) {
        case "projects.list":
          return {
            content: yield* workspace.listProjects(yield* parse(SharedDirectoryListInput, args)),
          };
        case "projects.get":
          return {
            content: yield* workspace.project(
              (yield* parse(SharedProjectDetailInput, args)).sharedProjectId,
            ),
          };
        case "specialists.list":
          return {
            content: yield* discovery.discover(yield* parse(SharedDiscoveryInput, args)),
          };
        case "specialists.get":
          return {
            content: yield* workspace.specialist(
              (yield* parse(SharedSpecialistDetailInput, args)).specialistId,
            ),
          };
        case "specialists.create":
        case "specialists.update":
        case "specialists.connect":
        case "specialists.split":
        case "specialists.consolidate":
        case "specialists.supersede": {
          if (!composition)
            return yield* fail("unavailable", "Shared composition is not configured on this host.");
          const kind = {
            "specialists.create": "create",
            "specialists.update": "revise",
            "specialists.connect": "connect",
            "specialists.split": "split",
            "specialists.consolidate": "consolidate",
            "specialists.supersede": "supersede",
          }[invocation.action];
          const input = yield* parse(SharedCompositionInput, { ...args, kind });
          return { content: yield* composition.execute(actor, input) };
        }
        case "operations.get": {
          if (!composition)
            return yield* fail("unavailable", "Shared composition is not configured on this host.");
          const input = yield* parse(SharedCompositionOperationInput, args);
          return { content: yield* composition.operation(actor, input.operationId) };
        }
        case "inbox.list":
          return {
            content: yield* workspace.readInbox(actor, yield* parse(SharedInboxReadInput, args)),
          };
        case "inbox.ack":
          yield* workspace.acknowledgeInbox(actor, yield* parse(SharedInboxAcknowledgeInput, args));
          return {
            content: { acknowledged: true, meaning: "Product batch acknowledgement only." },
          };
        case "activity.publish": {
          const input = yield* parse(SharedActivityPublishInput, args);
          const context = yield* requireContext(input);
          return { content: yield* workspace.publishActivity({ ...actor, context }, input) };
        }
        case "activity.publish_from_inbox": {
          if (!observationHost)
            return yield* fail("unavailable", "Inbox observation publication is not configured.");
          const input = yield* Schema.decodeUnknownEffect(SharedActivityFromInboxInput, {
            onExcessProperty: "error",
          })(args).pipe(
            Effect.mapError(() =>
              fail(
                "invalid_input",
                "Supply content and source batch/event only; author, context and revision are host-derived.",
              ),
            ),
          );
          return {
            content: yield* workspace.publishActivityFromInbox(
              actor,
              {
                environmentId: observationHost.environmentId,
                nativeTarget: specialist.nativeTarget,
              },
              input,
            ),
          };
        }
        case "knowledge.search":
          return {
            content: yield* workspace.searchKnowledge(
              yield* parse(SharedKnowledgeSearchInput, args),
            ),
          };
        case "knowledge.record":
        case "knowledge.supersede": {
          const input = yield* parse(SharedKnowledgePutInput, args);
          const context = yield* requireContext(input);
          if (invocation.action === "knowledge.supersede" && !input.supersedes.length)
            return yield* fail(
              "invalid_input",
              "A correction must reference the retained evidence it supersedes.",
            );
          return { content: yield* workspace.putKnowledge({ ...actor, context }, input) };
        }
        case "knowledge.record_from_inbox": {
          if (!observationHost)
            return yield* fail("unavailable", "Inbox observation publication is not configured.");
          const input = yield* Schema.decodeUnknownEffect(SharedKnowledgeFromInboxInput, {
            onExcessProperty: "error",
          })(args).pipe(
            Effect.mapError(() =>
              fail(
                "invalid_input",
                "Supply content and source batch/event only; author, context and revision are host-derived.",
              ),
            ),
          );
          return {
            content: yield* workspace.putKnowledgeFromInbox(
              actor,
              {
                environmentId: observationHost.environmentId,
                nativeTarget: specialist.nativeTarget,
              },
              input,
            ),
          };
        }
        case "repository.list":
          return { content: yield* repositories.list(args) };
        case "repository.read":
          return { content: yield* repositories.read(args) };
        case "repository.search":
          return { content: yield* repositories.search(args) };
        default:
          return yield* fail("invalid_input", "This shared workspace action is not supported.");
      }
    },
    Effect.mapError((cause) =>
      isSharedError(cause)
        ? cause
        : fail(
            "unavailable",
            "The shared tool action is unavailable. Reconcile its ID before retrying.",
          ),
    ),
  );
  return { invoke };
});

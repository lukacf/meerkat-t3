import type { makeSharedDelegationService } from "./SharedDelegationService.ts";
import type { makeSharedLocalDelegationService } from "./SharedLocalDelegationService.ts";
import type { makeSharedDelegationInvoker } from "./SharedDelegationInvoker.ts";
import {
  AuthSharedReadScope,
  AuthSharedContributeScope,
  AuthSharedAdminScope,
  SharedWorkspaceError,
  EnvironmentAuthorizationError,
  SharedWorkspaceRpcGroup,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { type AuthenticatedSession, EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { SessionStore } from "../auth/SessionStore.ts";
import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import type { makeMeerkatTeamService } from "../provider/meerkat/MeerkatTeamService.ts";
import type { SharedWorkspaceStore, SharedActor } from "./SharedWorkspaceStore.ts";
import {
  sharedReadOnlyNativeAgent,
  type makeSharedSpecialistService,
} from "./SharedSpecialistService.ts";
import { sharedDelegationContext } from "./SharedDelegationContext.ts";
import { makeSharedCheckoutRevision } from "./SharedCheckoutRevision.ts";
import { makeSharedRepositoryReader } from "./SharedRepositoryReader.ts";
import { makeSharedCompositionHistory } from "./SharedCompositionHistory.ts";
import { makeSharedDiscoveryService } from "./SharedDiscoveryService.ts";
import type { makeSharedCompositionService } from "./SharedCompositionService.ts";

const isSharedError = Schema.is(SharedWorkspaceError);

export const makeSharedWorkspaceRpcLayer = (
  currentSession: AuthenticatedSession,
  services: {
    readonly sharedWorkspace: SharedWorkspaceStore;
    readonly sharedDelegations: Effect.Success<ReturnType<typeof makeSharedDelegationService>>;
    readonly sharedLocalDelegations: Effect.Success<
      ReturnType<typeof makeSharedLocalDelegationService>
    >;
    readonly sharedDelegationInvoker: ReturnType<typeof makeSharedDelegationInvoker>;
    readonly sharedComposition: Effect.Success<ReturnType<typeof makeSharedCompositionService>>;
    readonly sharedSpecialists: Effect.Success<ReturnType<typeof makeSharedSpecialistService>>;
    readonly meerkatTeam: Effect.Success<typeof makeMeerkatTeamService>;
  },
) =>
  SharedWorkspaceRpcGroup.toLayer(
    Effect.gen(function* () {
      const { sharedWorkspace, sharedSpecialists, sharedComposition, meerkatTeam } = services;
      const { sharedDelegations, sharedLocalDelegations, sharedDelegationInvoker } = services;
      const currentSessionId = currentSession.sessionId;
      const serverEnvironment = yield* ServerEnvironment;
      const serverAuth = yield* EnvironmentAuth;
      const sessions = yield* SessionStore;
      const sharedRepositories = yield* makeSharedRepositoryReader(sharedWorkspace);
      const discovery = makeSharedDiscoveryService(sharedWorkspace);
      const compositionHistory = yield* makeSharedCompositionHistory(sharedWorkspace);
      const sharedCheckoutRevision = yield* makeSharedCheckoutRevision;
      const sharedError = (cause: unknown) =>
        isSharedError(cause)
          ? cause
          : new SharedWorkspaceError({
              code: "unavailable",
              message: "The shared workspace is unavailable.",
            });
      const sharedActor = sharedWorkspace.requireParticipant(currentSessionId).pipe(
        Effect.map((participant): SharedActor => ({
          kind: "participant",
          participantId: participant.participantId,
        })),
        Effect.mapError(sharedError),
      );
      const authorize = <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) => {
        const requiredScope = requiredScopeForRpcMethod(method);
        return currentSession.scopes.includes(requiredScope)
          ? effect
          : Effect.fail(
              new EnvironmentAuthorizationError({
                requiredScope,
                message: `The authenticated token is missing required scope: ${requiredScope}.`,
              }),
            );
      };
      const sharedObserve = <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
        authorize(
          method,
          Effect.gen(function* () {
            const active = yield* sessions.listActive();
            const observedAt = yield* DateTime.now;
            if (
              !active.some((session) => session.sessionId === currentSessionId) ||
              (currentSession.expiresAt &&
                currentSession.expiresAt.epochMilliseconds <= observedAt.epochMilliseconds)
            )
              return yield* new SharedWorkspaceError({
                code: "forbidden",
                message: "This shared connection has expired or been revoked.",
              });
            return yield* effect;
          }).pipe(Effect.mapError(sharedError)),
        );
      return SharedWorkspaceRpcGroup.of({
        [WS_METHODS.sharedDelegationSession]: () =>
          sharedObserve(
            WS_METHODS.sharedDelegationSession,
            Effect.gen(function* () {
              const workspace = yield* sharedWorkspace.workspace;
              const participant = yield* sharedWorkspace.requireParticipant(currentSessionId);
              const active = (yield* sessions.listActive()).find(
                (session) => session.sessionId === currentSessionId,
              );
              if (!workspace || !active)
                return yield* new SharedWorkspaceError({
                  code: "not_configured",
                  message: "Join a configured shared workspace before connecting a task.",
                });
              return {
                environmentId: yield* serverEnvironment.getEnvironmentId,
                workspaceId: workspace.workspaceId,
                participantId: participant.participantId,
                canContribute: currentSession.scopes.includes(AuthSharedContributeScope),
                expiresAt: DateTime.formatIso(active.expiresAt),
              };
            }),
          ),
        [WS_METHODS.sharedDelegationContext]: (input) =>
          sharedObserve(
            WS_METHODS.sharedDelegationContext,
            sharedDelegationContext(sharedWorkspace, currentSessionId, input),
          ),
        [WS_METHODS.sharedDelegationRegister]: (input) =>
          sharedObserve(
            WS_METHODS.sharedDelegationRegister,
            sharedDelegations.register(currentSessionId, input),
          ),
        [WS_METHODS.sharedDelegationRevoke]: (input) =>
          sharedObserve(
            WS_METHODS.sharedDelegationRevoke,
            sharedDelegations.revoke(currentSessionId, input),
          ),
        [WS_METHODS.sharedDelegationInvoke]: (input) =>
          sharedObserve(
            WS_METHODS.sharedDelegationInvoke,
            sharedDelegationInvoker.invoke(currentSessionId, input),
          ),
        [WS_METHODS.sharedLocalConnectionCreate]: (input) =>
          sharedObserve(
            WS_METHODS.sharedLocalConnectionCreate,
            sharedLocalDelegations.connect(currentSessionId, input),
          ),
        [WS_METHODS.sharedLocalConnectionList]: () =>
          sharedObserve(
            WS_METHODS.sharedLocalConnectionList,
            sharedLocalDelegations.list(currentSessionId),
          ),
        [WS_METHODS.sharedLocalConnectionDisconnect]: (input) =>
          sharedObserve(
            WS_METHODS.sharedLocalConnectionDisconnect,
            sharedLocalDelegations.disconnect(currentSessionId, input.connectionId),
          ),
        [WS_METHODS.sharedLocalConnectionCancelSetup]: (input) =>
          sharedObserve(
            WS_METHODS.sharedLocalConnectionCancelSetup,
            sharedLocalDelegations.cancelSetup(currentSessionId, input),
          ),
        [WS_METHODS.sharedLocalDelegationEnable]: (input) =>
          sharedObserve(
            WS_METHODS.sharedLocalDelegationEnable,
            sharedLocalDelegations.enable(currentSessionId, input),
          ),
        [WS_METHODS.sharedLocalDelegationList]: (input) =>
          sharedObserve(
            WS_METHODS.sharedLocalDelegationList,
            sharedLocalDelegations.listDelegations(currentSessionId, input.connectionId),
          ),
        [WS_METHODS.sharedLocalDelegationRevoke]: (input) =>
          sharedObserve(
            WS_METHODS.sharedLocalDelegationRevoke,
            sharedLocalDelegations.revoke(currentSessionId, input.localId),
          ),
        [WS_METHODS.sharedWorkspaceSession]: () =>
          sharedObserve(
            WS_METHODS.sharedWorkspaceSession,
            Effect.gen(function* () {
              return {
                environment: yield* serverEnvironment.getDescriptor,
                auth: yield* serverAuth.getDescriptor(),
                snapshot: yield* sharedWorkspace.snapshot(currentSessionId),
                permissions: {
                  read: currentSession.scopes.includes(AuthSharedReadScope),
                  contribute: currentSession.scopes.includes(AuthSharedContributeScope),
                  admin: currentSession.scopes.includes(AuthSharedAdminScope),
                },
              };
            }),
          ),
        [WS_METHODS.sharedWorkspaceConfigure]: (input) =>
          sharedObserve(WS_METHODS.sharedWorkspaceConfigure, sharedWorkspace.configure(input)),
        [WS_METHODS.sharedWorkspaceJoin]: (input) =>
          sharedObserve(
            WS_METHODS.sharedWorkspaceJoin,
            sharedWorkspace.join(currentSessionId, input),
          ),
        [WS_METHODS.sharedProjectRegister]: (input) =>
          sharedObserve(
            WS_METHODS.sharedProjectRegister,
            Effect.gen(function* () {
              const verified = yield* sharedRepositories.verifyRegistration(input);
              return yield* sharedWorkspace.registerProject(verified);
            }),
          ),
        [WS_METHODS.sharedSpecialistRegister]: (input) =>
          sharedObserve(
            WS_METHODS.sharedSpecialistRegister,
            Effect.gen(function* () {
              const native = input.nativeTarget;
              const roster = yield* meerkatTeam.projectTeam({ projectId: native.projectId });
              const agent = sharedReadOnlyNativeAgent(roster, native);
              if (!agent)
                return yield* new SharedWorkspaceError({
                  code: "forbidden",
                  message:
                    "Register a connected specialist whose native policy is observed as repository-read-only.",
                });
              const projects = yield* Effect.forEach(input.assignments, (assignment) =>
                sharedWorkspace.project(assignment.sharedProjectId),
              );
              if (!projects.some((project) => project.hostProjectId === native.projectId))
                return yield* new SharedWorkspaceError({
                  code: "forbidden",
                  message: "The specialist must have an assignment to its host project.",
                });
              return yield* sharedWorkspace.registerSpecialist(input);
            }),
          ),
        [WS_METHODS.sharedCheckoutAttach]: (input) =>
          sharedObserve(
            WS_METHODS.sharedCheckoutAttach,
            sharedWorkspace.attachCheckout(currentSessionId, input),
          ),
        [WS_METHODS.sharedWorkContextPut]: (input) =>
          sharedObserve(
            WS_METHODS.sharedWorkContextPut,
            sharedActor.pipe(Effect.flatMap((actor) => sharedWorkspace.putContext(actor, input))),
          ),
        [WS_METHODS.sharedActivityPublish]: (input) =>
          sharedObserve(
            WS_METHODS.sharedActivityPublish,
            sharedActor.pipe(
              Effect.flatMap((actor) => sharedWorkspace.publishActivity(actor, input)),
            ),
          ),
        [WS_METHODS.sharedInboxRead]: (input) =>
          sharedObserve(
            WS_METHODS.sharedInboxRead,
            sharedActor.pipe(Effect.flatMap((actor) => sharedWorkspace.readInbox(actor, input))),
          ),
        [WS_METHODS.sharedInboxAcknowledge]: (input) =>
          sharedObserve(
            WS_METHODS.sharedInboxAcknowledge,
            sharedActor.pipe(
              Effect.flatMap((actor) => sharedWorkspace.acknowledgeInbox(actor, input)),
            ),
          ),
        [WS_METHODS.sharedSnapshotPut]: (input) =>
          sharedObserve(
            WS_METHODS.sharedSnapshotPut,
            sharedActor.pipe(Effect.flatMap((actor) => sharedWorkspace.putSnapshot(actor, input))),
          ),
        [WS_METHODS.sharedKnowledgePut]: (input) =>
          sharedObserve(
            WS_METHODS.sharedKnowledgePut,
            sharedActor.pipe(Effect.flatMap((actor) => sharedWorkspace.putKnowledge(actor, input))),
          ),
        [WS_METHODS.sharedKnowledgeSearch]: (input) =>
          sharedObserve(
            WS_METHODS.sharedKnowledgeSearch,
            sharedActor.pipe(Effect.andThen(sharedWorkspace.searchKnowledge(input))),
          ),
        [WS_METHODS.sharedSpecialistConversation]: (input) =>
          sharedObserve(
            WS_METHODS.sharedSpecialistConversation,
            sharedSpecialists.conversation(currentSessionId, input),
          ),
        [WS_METHODS.sharedSpecialistSend]: (input) =>
          sharedObserve(
            WS_METHODS.sharedSpecialistSend,
            sharedSpecialists.send(currentSessionId, input),
          ),
        [WS_METHODS.sharedSpecialistRequest]: (input) =>
          sharedObserve(
            WS_METHODS.sharedSpecialistRequest,
            sharedSpecialists.request(currentSessionId, input.requestId),
          ),
        [WS_METHODS.sharedSpecialistDiscover]: (input) =>
          sharedObserve(WS_METHODS.sharedSpecialistDiscover, discovery.discover(input)),
        [WS_METHODS.sharedCompositionExecute]: (input) =>
          sharedObserve(
            WS_METHODS.sharedCompositionExecute,
            sharedActor.pipe(Effect.flatMap((actor) => sharedComposition.execute(actor, input))),
          ),
        [WS_METHODS.sharedCompositionHistory]: (input) =>
          sharedObserve(
            WS_METHODS.sharedCompositionHistory,
            sharedActor.pipe(Effect.flatMap((actor) => compositionHistory.read(actor, input))),
          ),
        [WS_METHODS.sharedCompositionOperation]: (input) =>
          sharedObserve(
            WS_METHODS.sharedCompositionOperation,
            sharedActor.pipe(
              Effect.flatMap((actor) => sharedComposition.operation(actor, input.operationId)),
            ),
          ),
        [WS_METHODS.sharedCheckoutPatch]: (input) =>
          authorize(WS_METHODS.sharedCheckoutPatch, sharedCheckoutRevision.patch(input)),
        [WS_METHODS.sharedCheckoutRevision]: (input) =>
          authorize(WS_METHODS.sharedCheckoutRevision, sharedCheckoutRevision.read(input)),
      });
    }),
  );

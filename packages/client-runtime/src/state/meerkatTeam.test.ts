import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MeerkatTeamError,
  ProjectId,
  ProviderInstanceId,
  WS_METHODS,
  type MeerkatProjectAgent,
  type MeerkatProjectAgentCreateInput,
  type MeerkatProjectTeamInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createMeerkatTeamEnvironmentAtoms } from "./meerkatTeam.ts";

const ENVIRONMENT = EnvironmentId.make("environment-1");
const OTHER_ENVIRONMENT = EnvironmentId.make("environment-2");
const PROJECT = ProjectId.make("project-1");
const OTHER_PROJECT = ProjectId.make("project-2");
const INSTANCE = ProviderInstanceId.make("meerkat-default");
const NOW = "2026-09-29T09:00:00.000Z";

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

describe("Meerkat project agent creation", () => {
  for (const succeeds of [true, false]) {
    it.effect(
      succeeds
        ? "refreshes both mounted rosters only in the created agent's project and environment"
        : "leaves both mounted rosters unchanged when creation fails",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const reads: string[] = [];
            const creations: Array<{
              environmentId: EnvironmentId;
              input: MeerkatProjectAgentCreateInput;
            }> = [];
            const agents = new Map<string, readonly MeerkatProjectAgent[]>();
            const supervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();
            for (const environmentId of [ENVIRONMENT, OTHER_ENVIRONMENT]) {
              const client = {
                [WS_METHODS.meerkatProjectTeam]: ({ projectId }: MeerkatProjectTeamInput) =>
                  Effect.sync(() => {
                    reads.push(`${environmentId}:${projectId}:team`);
                    return {
                      projectId,
                      observedAt: NOW,
                      observation: "loaded_runtimes" as const,
                      providers: [],
                      projectAgents: agents.get(`${environmentId}:${projectId}`) ?? [],
                    };
                  }),
                [WS_METHODS.meerkatProjectAgents]: ({ projectId }: MeerkatProjectTeamInput) =>
                  Effect.sync(() => {
                    reads.push(`${environmentId}:${projectId}:agents`);
                    return {
                      projectId,
                      agents: agents.get(`${environmentId}:${projectId}`) ?? [],
                    };
                  }),
                [WS_METHODS.meerkatProjectAgentCreate]: (input: MeerkatProjectAgentCreateInput) =>
                  Effect.gen(function* () {
                    creations.push({ environmentId, input });
                    if (!succeeds) {
                      return yield* new MeerkatTeamError({
                        operation: "project-agent",
                        projectId: input.projectId,
                        message: "Agent creation was rejected.",
                      });
                    }
                    const agent: MeerkatProjectAgent = {
                      agentId: "architect",
                      projectId: input.projectId,
                      instanceId: input.instanceId,
                      label: input.label,
                      role: input.role,
                      instructions: input.instructions,
                      model: input.model,
                      enabled: true,
                      archived: false,
                      connectionStatus: "unloaded",
                      error: null,
                      agentRef: null,
                      createdAt: NOW,
                      updatedAt: NOW,
                    };
                    agents.set(`${environmentId}:${input.projectId}`, [agent]);
                    return agent;
                  }),
              } as unknown as WsRpcProtocolClient;
              const connectionState: SupervisorConnectionState = {
                ...AVAILABLE_CONNECTION_STATE,
                desired: true,
                network: "online",
                phase: "connected",
                attempt: 1,
                generation: 1,
              };
              supervisors.set(
                environmentId,
                EnvironmentSupervisor.of({
                  target: new PrimaryConnectionTarget({
                    environmentId,
                    label: environmentId,
                    httpBaseUrl: `https://${environmentId}.example.test`,
                    wsBaseUrl: `wss://${environmentId}.example.test`,
                  }),
                  state: yield* SubscriptionRef.make(connectionState),
                  session: yield* SubscriptionRef.make(Option.some(session(client))),
                  prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
                  connect: Effect.void,
                  disconnect: Effect.void,
                  retryNow: Effect.void,
                }),
              );
            }
            const run: EnvironmentRegistry["Service"]["run"] = (environmentId, effect) =>
              Effect.provideService(effect, EnvironmentSupervisor, supervisors.get(environmentId)!);
            const followStream: EnvironmentRegistry["Service"]["followStream"] = (
              environmentId,
              stream,
            ) =>
              Stream.provideService(stream, EnvironmentSupervisor, supervisors.get(environmentId)!);
            const environmentRegistry = EnvironmentRegistry.of({
              run,
              followStream,
            } as unknown as EnvironmentRegistry["Service"]);
            const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, environmentRegistry));
            const atoms = createMeerkatTeamEnvironmentAtoms(runtime);
            const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
              Effect.sync(() => value.dispose()),
            );
            const scopes = [
              { environmentId: ENVIRONMENT, input: { projectId: PROJECT } },
              { environmentId: ENVIRONMENT, input: { projectId: OTHER_PROJECT } },
              { environmentId: OTHER_ENVIRONMENT, input: { projectId: PROJECT } },
            ].map((target) => ({
              ...target,
              team: atoms.projectTeam(target),
              agents: atoms.projectAgents(target),
            }));

            for (const scope of scopes) {
              const stopTeam = registry.mount(scope.team);
              const stopAgents = registry.mount(scope.agents);
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  stopTeam();
                  stopAgents();
                }),
              );
              expect(
                (yield* AtomRegistry.getResult(registry, scope.team, { suspendOnWaiting: true }))
                  .projectAgents,
              ).toEqual([]);
              expect(
                (yield* AtomRegistry.getResult(registry, scope.agents, { suspendOnWaiting: true }))
                  .agents,
              ).toEqual([]);
            }
            // A synchronous result can be revalidated on its first SWR mount
            // once the environment is already connected (staleTime is zero).
            // Capture those completed startup reads before asserting the exact
            // additional reads caused by the command below.
            const initialReads = [...reads];
            expect([...new Set(initialReads)].sort()).toEqual(
              scopes
                .flatMap((scope) => [
                  `${scope.environmentId}:${scope.input.projectId}:agents`,
                  `${scope.environmentId}:${scope.input.projectId}:team`,
                ])
                .sort(),
            );
            const input: MeerkatProjectAgentCreateInput = {
              projectId: PROJECT,
              instanceId: INSTANCE,
              requestId: "create-architect",
              label: "Architect",
              role: "architect",
              instructions: "Study the repository architecture.",
              model: "test-model",
            };
            const result = yield* Effect.promise(() =>
              atoms.projectAgentCreate.run(registry, { environmentId: ENVIRONMENT, input }),
            );
            expect(AsyncResult.isSuccess(result)).toBe(succeeds);
            expect(AsyncResult.isFailure(result)).toBe(!succeeds);
            expect(creations).toEqual([{ environmentId: ENVIRONMENT, input }]);

            for (const scope of scopes) {
              const expectedIds =
                succeeds && scope.environmentId === ENVIRONMENT && scope.input.projectId === PROJECT
                  ? ["architect"]
                  : [];
              const team = yield* AtomRegistry.getResult(registry, scope.team, {
                suspendOnWaiting: true,
              });
              const projectAgents = yield* AtomRegistry.getResult(registry, scope.agents, {
                suspendOnWaiting: true,
              });
              expect(team.projectAgents.map((agent) => agent.agentId)).toEqual(expectedIds);
              expect(projectAgents.agents.map((agent) => agent.agentId)).toEqual(expectedIds);
            }
            expect(reads.slice(initialReads.length).sort()).toEqual(
              succeeds
                ? [`${ENVIRONMENT}:${PROJECT}:agents`, `${ENVIRONMENT}:${PROJECT}:team`]
                : [],
            );
          }),
        ),
    );
  }
});

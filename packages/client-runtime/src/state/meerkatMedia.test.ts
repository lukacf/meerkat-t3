import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MeerkatMediaError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type MeerkatBrowserGrant,
  type MeerkatBrowserGrantInput,
  type MeerkatMediaTarget,
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
import { createMeerkatMediaAtoms } from "./meerkatMedia.ts";

const ENVIRONMENT = EnvironmentId.make("environment-1");
const OTHER_ENVIRONMENT = EnvironmentId.make("environment-2");
const TARGET: MeerkatMediaTarget = {
  projectId: ProjectId.make("project-1"),
  instanceId: ProviderInstanceId.make("meerkat-default"),
  agentRef: "reviewer",
};
const HOST = ThreadId.make("browser-workspace");

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

describe("Meerkat browser sharing", () => {
  for (const succeeds of [true, false]) {
    it.effect(
      succeeds
        ? "refreshes separate status consumers for the same target after granting and revoking"
        : "preserves cached status consumers when a browser grant fails",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const reads: string[] = [];
            const grants = new Map<string, typeof MeerkatBrowserGrant.Type>();
            const key = (environmentId: EnvironmentId, input: MeerkatMediaTarget) =>
              JSON.stringify([
                environmentId,
                input.projectId,
                input.instanceId,
                input.agentRef,
                input.threadId,
              ]);
            const supervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();
            for (const environmentId of [ENVIRONMENT, OTHER_ENVIRONMENT]) {
              const client = {
                [WS_METHODS.meerkatBrowserStatus]: (input: MeerkatMediaTarget) =>
                  Effect.sync(() => {
                    const targetKey = key(environmentId, input);
                    reads.push(targetKey);
                    return grants.get(targetKey) ?? { enabled: false };
                  }),
                [WS_METHODS.meerkatBrowserGrant]: (input: MeerkatBrowserGrantInput) =>
                  Effect.gen(function* () {
                    if (!succeeds) {
                      return yield* new MeerkatMediaError({
                        projectId: input.projectId,
                        message: "Browser grant was rejected.",
                      });
                    }
                    const result = input.enabled
                      ? { enabled: true, hostThreadId: input.hostThreadId }
                      : { enabled: false };
                    grants.set(key(environmentId, input), result);
                    return result;
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
            const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
              Effect.sync(() => value.dispose()),
            );
            // The handoff screen and each agent panel have independent factories.
            const writer = createMeerkatMediaAtoms(runtime);
            const scopes = [
              { environmentId: ENVIRONMENT, input: TARGET },
              {
                environmentId: ENVIRONMENT,
                input: {
                  agentRef: TARGET.agentRef,
                  instanceId: TARGET.instanceId,
                  projectId: TARGET.projectId,
                },
              },
              { environmentId: OTHER_ENVIRONMENT, input: TARGET },
              {
                environmentId: ENVIRONMENT,
                input: { ...TARGET, projectId: ProjectId.make("other-project") },
              },
              {
                environmentId: ENVIRONMENT,
                input: { ...TARGET, instanceId: ProviderInstanceId.make("other-provider") },
              },
              { environmentId: ENVIRONMENT, input: { ...TARGET, agentRef: "other-agent" } },
              {
                environmentId: ENVIRONMENT,
                input: { ...TARGET, agentRef: undefined, threadId: HOST },
              },
            ].map((target) => ({
              ...target,
              status: createMeerkatMediaAtoms(runtime).browserStatus(target),
            }));
            for (const scope of scopes) {
              const unmount = registry.mount(scope.status);
              yield* Effect.addFinalizer(() => Effect.sync(unmount));
              expect(
                yield* AtomRegistry.getResult(registry, scope.status, { suspendOnWaiting: true }),
              ).toEqual({ enabled: false });
            }

            for (const enabled of succeeds ? [true, false] : [true]) {
              const initialReads = reads.length;
              const result = yield* Effect.promise(() =>
                writer.browserGrant.run(registry, {
                  environmentId: ENVIRONMENT,
                  input: { ...TARGET, enabled, ...(enabled ? { hostThreadId: HOST } : {}) },
                }),
              );
              expect(AsyncResult.isSuccess(result)).toBe(succeeds);
              expect(AsyncResult.isFailure(result)).toBe(!succeeds);
              for (const scope of scopes) {
                const status = yield* AtomRegistry.getResult(registry, scope.status, {
                  suspendOnWaiting: true,
                });
                expect(status).toEqual(
                  succeeds &&
                    enabled &&
                    key(scope.environmentId, scope.input) === key(ENVIRONMENT, TARGET)
                    ? { enabled: true, hostThreadId: HOST }
                    : { enabled: false },
                );
              }
              expect(reads.slice(initialReads)).toEqual(
                succeeds ? [key(ENVIRONMENT, TARGET), key(ENVIRONMENT, TARGET)] : [],
              );
            }
          }),
        ),
    );
  }
});

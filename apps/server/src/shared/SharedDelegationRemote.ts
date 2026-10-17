import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { SharedWorkspaceError, SharedWorkspaceRpcGroup, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type * as Scope from "effect/Scope";
import type {
  SharedDelegationRemote,
  SharedRemoteConnection,
} from "./SharedLocalDelegationService.ts";
import { sharedConnectionOrigin } from "./SharedLocalDelegationService.ts";

type Client = RpcClient.FromGroup<typeof SharedWorkspaceRpcGroup, RpcClientError>;
const unavailable = () =>
  new SharedWorkspaceError({
    code: "unavailable",
    message: "The shared host did not confirm this operation. Retry using the same request ID.",
  });

/** A bounded, one-operation connection. Never automatically replay a mutation. */
export const withSharedDelegationClient = Effect.fn("SharedDelegationRemote.client")(function* <
  A,
  E,
>(connection: SharedRemoteConnection, use: (client: Client) => Effect.Effect<A, E, Scope.Scope>) {
  const origin = yield* sharedConnectionOrigin(connection.origin);
  const url = new URL("/ws", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const protocol = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({ retryTransientErrors: false, retryPolicy: Schedule.recurs(0) }),
  ).pipe(
    Layer.provide(
      Socket.layerWebSocket(url.href).pipe(
        Layer.provide(
          Layer.succeed(
            Socket.WebSocketConstructor,
            (address, protocols) =>
              new NodeSocket.NodeWS.WebSocket(address, protocols as string | string[] | undefined, {
                headers: { authorization: `Bearer ${connection.credential}` },
                followRedirects: false,
                handshakeTimeout: 10_000,
                maxPayload: 256 * 1024,
                perMessageDeflate: false,
              }) as unknown as globalThis.WebSocket,
          ),
        ),
      ),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(SharedWorkspaceRpcGroup);
      const observed = yield* client[WS_METHODS.sharedDelegationSession]({});
      const expected = connection.expected;
      if (
        !observed.canContribute ||
        (expected &&
          (observed.environmentId !== expected.environmentId ||
            observed.workspaceId !== expected.workspaceId ||
            observed.participantId !== expected.participantId))
      )
        return yield* new SharedWorkspaceError({
          code: "forbidden",
          message: "The remote connection identity or permissions changed. Reconnect this account.",
        });
      return yield* use(client);
    }).pipe(Effect.provide(protocol), Effect.timeout("40 seconds")),
  ).pipe(
    // Socket and protocol errors can include headers or URLs. Expose no underlying cause.
    Effect.mapError(unavailable),
  );
});

export const sharedDelegationRemote: SharedDelegationRemote = {
  context: (connection, input) =>
    withSharedDelegationClient(connection, (client) =>
      client[WS_METHODS.sharedDelegationContext](input),
    ),
  session: (connection) =>
    withSharedDelegationClient(connection, (client) =>
      client[WS_METHODS.sharedDelegationSession]({}),
    ),
  register: (connection, input) =>
    withSharedDelegationClient(connection, (client) =>
      client[WS_METHODS.sharedDelegationRegister](input),
    ),
  revoke: (connection, delegationId) =>
    withSharedDelegationClient(connection, (client) =>
      client[WS_METHODS.sharedDelegationRevoke]({ delegationId }),
    ),
  invoke: (connection, input) =>
    withSharedDelegationClient(connection, (client) =>
      client[WS_METHODS.sharedDelegationInvoke](input),
    ),
};

import type {
  AuthCreatePairingCredentialInput,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  AuthSessionState,
  EnvironmentId,
  ServerConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/unstable/http";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand, followStreamInEnvironment } from "./runtime.ts";

function initialConfigOption<E>(
  initialConfig: Effect.Effect<ServerConfig | null, E>,
): Effect.Effect<Option.Option<ServerConfig>> {
  return initialConfig.pipe(
    Effect.map(Option.fromNullishOr),
    Effect.catch((error) =>
      Effect.logWarning("Could not load the initial environment configuration.").pipe(
        Effect.annotateLogs({ ...safeErrorLogAttributes(error) }),
        Effect.as(Option.none<ServerConfig>()),
      ),
    ),
  );
}

// Bounded like the snapshot fetches: a wedged environment must not pin the
// permissions check (and with it the settings UI) in a loading state for long.
const DEFAULT_SESSION_STATE_TIMEOUT_MS = 6_000;

const currentEnvironmentHttpContext = Effect.gen(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) {
    return yield* new EnvironmentRpcUnavailableError({
      environmentId: supervisor.target.environmentId,
      message: "Reconnect this environment to manage shared access.",
    });
  }
  return {
    prepared: prepared.value,
    signer: yield* Effect.serviceOption(ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(RemoteEnvironmentAuthorization),
    group: "auth" as const,
    timeoutMs: DEFAULT_SESSION_STATE_TIMEOUT_MS,
  };
});

/**
 * Read the granted scopes of this client's session on one environment via its
 * `/api/auth/session` endpoint, using the connection's authentication method
 * and refreshing relay credentials when needed.
 */
export const fetchEnvironmentSessionState = Effect.fn(
  "clientRuntime.state.fetchEnvironmentSessionState",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "auth",
    method: "GET",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/auth/session"),
    timeoutMs: input.timeoutMs ?? DEFAULT_SESSION_STATE_TIMEOUT_MS,
    request: ({ client, headers }) => client.session({ headers }),
    // This endpoint returns 200 with authenticated:false for expired credentials.
    isUnauthorizedResponse: (response) => !response.authenticated,
  });
});

export function createEnvironmentSessionAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  const initialConfigAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              SubscriptionRef.changes(supervisor.session).pipe(
                Stream.mapEffect(
                  Option.match({
                    onNone: () => Effect.succeed(Option.none<ServerConfig>()),
                    onSome: (session) => initialConfigOption(session.initialConfig),
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
      { initialValue: Option.none() },
    ),
  );

  // This is only the bootstrap config captured when a transport session is
  // established. Consumers that need current provider/settings state must use
  // createServerEnvironmentAtoms(...).configValueAtom instead.
  const initialConfigValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ServerConfig | null =>
      Option.getOrNull(
        Option.getOrElse(AsyncResult.value(get(initialConfigAtom(environmentId))), () =>
          Option.none(),
        ),
      ),
    ).pipe(Atom.withLabel(`environment-config-value:${environmentId}`)),
  );

  const preparedConnectionAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.pipe(
            Effect.map((supervisor) => SubscriptionRef.changes(supervisor.prepared)),
          ),
        ),
      ),
      { initialValue: Option.none<PreparedConnection>() },
    ),
  );

  const preparedConnectionValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrElse(AsyncResult.value(get(preparedConnectionAtom(environmentId))), () =>
        Option.none<PreparedConnection>(),
      ),
    ).pipe(Atom.withLabel(`environment-prepared-connection:${environmentId}`)),
  );

  // Keyed on the prepared connection's identity: a reconnect (new credential,
  // new base URL) swaps the prepared value, which re-runs the fetch, so scope
  // changes from re-pairing are picked up without an explicit refresh.
  const sessionStateAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom((get) => {
        const prepared = Option.getOrNull(get(preparedConnectionValueAtom(environmentId)));
        if (prepared === null) {
          return Effect.never;
        }
        return Effect.gen(function* () {
          const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
          const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
          return yield* fetchEnvironmentSessionState({ prepared, signer, remoteAuthorization });
        });
      })
      .pipe(
        Atom.swr({ staleTime: 30_000, revalidateOnMount: true }),
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-session-state:${environmentId}`),
      ),
  );

  const sessionStateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): AuthSessionState | null =>
        Option.getOrNull(AsyncResult.value(get(sessionStateAtom(environmentId)))) ?? null,
    ).pipe(Atom.withLabel(`environment-session-state-value:${environmentId}`)),
  );

  return {
    createPairingCredential: createEnvironmentCommand(runtime, {
      label: "environment-session:create-pairing-credential",
      execute: (input: AuthCreatePairingCredentialInput) =>
        Effect.gen(function* () {
          const context = yield* currentEnvironmentHttpContext;
          let httpBaseUrl = context.prepared.httpBaseUrl;
          const created = yield* executeAuthenticatedEnvironmentHttpRequest({
            ...context,
            method: "POST",
            url: (base) => {
              // Relay authorization can renew the endpoint. Return the origin
              // that issued this credential, never the renderer's primary host.
              httpBaseUrl = base;
              return environmentEndpointUrl(base, "/api/auth/pairing-token");
            },
            request: ({ client, headers }) => client.pairingCredential({ headers, payload: input }),
          });
          return { ...created, httpBaseUrl };
        }),
    }),
    listPairingLinks: createEnvironmentCommand(runtime, {
      label: "environment-session:list-pairing-links",
      execute: (_input: Record<string, never>) =>
        Effect.gen(function* () {
          const context = yield* currentEnvironmentHttpContext;
          return yield* executeAuthenticatedEnvironmentHttpRequest({
            ...context,
            method: "GET",
            url: (base) => environmentEndpointUrl(base, "/api/auth/pairing-links"),
            request: ({ client, headers }) => client.pairingLinks({ headers }),
          });
        }),
    }),
    revokePairingLink: createEnvironmentCommand(runtime, {
      label: "environment-session:revoke-pairing-link",
      execute: (input: AuthRevokePairingLinkInput) =>
        Effect.gen(function* () {
          const context = yield* currentEnvironmentHttpContext;
          return yield* executeAuthenticatedEnvironmentHttpRequest({
            ...context,
            method: "POST",
            url: (base) => environmentEndpointUrl(base, "/api/auth/pairing-links/revoke"),
            request: ({ client, headers }) => client.revokePairingLink({ headers, payload: input }),
          });
        }),
    }),
    listClientSessions: createEnvironmentCommand(runtime, {
      label: "environment-session:list-client-sessions",
      execute: (_input: Record<string, never>) =>
        Effect.gen(function* () {
          const context = yield* currentEnvironmentHttpContext;
          return yield* executeAuthenticatedEnvironmentHttpRequest({
            ...context,
            method: "GET",
            url: (base) => environmentEndpointUrl(base, "/api/auth/clients"),
            request: ({ client, headers }) => client.clients({ headers }),
          });
        }),
    }),
    revokeClientSession: createEnvironmentCommand(runtime, {
      label: "environment-session:revoke-client-session",
      execute: (input: AuthRevokeClientSessionInput) =>
        Effect.gen(function* () {
          const context = yield* currentEnvironmentHttpContext;
          return yield* executeAuthenticatedEnvironmentHttpRequest({
            ...context,
            method: "POST",
            url: (base) => environmentEndpointUrl(base, "/api/auth/clients/revoke"),
            request: ({ client, headers }) => client.revokeClient({ headers, payload: input }),
          });
        }),
    }),
    // Commands must read current supervisor state, not a possibly unmounted stream
    // projection whose initial value is None even when the transport is connected.
    observePreparedConnection: createEnvironmentCommand(runtime, {
      label: "environment-session:observe-prepared-connection",
      execute: (_input: Record<string, never>) =>
        EnvironmentSupervisor.pipe(
          Effect.flatMap((supervisor) => SubscriptionRef.get(supervisor.prepared)),
          Effect.map(Option.getOrNull),
        ),
    }),
    initialConfigAtom,
    initialConfigValueAtom,
    preparedConnectionAtom,
    preparedConnectionValueAtom,
    sessionStateAtom,
    sessionStateValueAtom,
  };
}

import { expect, it } from "@effect/vitest";
import { AuthSessionId, AuthSharedParticipantScopes, EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/unstable/http";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentNotRegisteredError, EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";

const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

const target = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("shared-host"),
  label: "Shared host",
  connectionId: "paired-host",
  sharedWorkspace: true,
});
const connection: PreparedConnection = {
  environmentId: target.environmentId,
  label: target.label,
  httpBaseUrl: "https://shared.example",
  socketUrl: "wss://shared.example/ws",
  httpAuthorization: { _tag: "Bearer", token: "fixture-credential" },
  target,
};

it.effect(
  "reads the current scoped connection with no mounted projection and observes replacement/removal",
  () =>
    Effect.gen(function* () {
      const prepared = yield* SubscriptionRef.make(Option.some(connection));
      const supervisor = EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected",
        }),
        session: yield* SubscriptionRef.make(Option.none<RpcSession>()),
        prepared,
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const scopedCalls: EnvironmentId[] = [];
      const run: EnvironmentRegistry["Service"]["run"] = (environmentId, effect) => {
        scopedCalls.push(environmentId);
        return environmentId === target.environmentId
          ? Effect.provideService(effect, EnvironmentSupervisor, supervisor)
          : Effect.fail(new EnvironmentNotRegisteredError({ environmentId }));
      };
      const environments = EnvironmentRegistry.of({
        run,
        // A cold UI projection has not observed its initial supervisor value yet.
        // Command execution must not depend on waiting for that subscription.
        followStream: () => Stream.never,
      } as unknown as EnvironmentRegistry["Service"]);
      const runtime = Atom.runtime(
        Layer.merge(
          Layer.succeed(EnvironmentRegistry, environments),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() =>
              Effect.die("Connection observation must not issue HTTP requests."),
            ),
          ),
        ),
      );
      const session = createEnvironmentSessionAtoms(runtime);
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      expect(registry.get(session.preparedConnectionValueAtom(target.environmentId))).toEqual(
        Option.none(),
      );
      const read = (environmentId = target.environmentId) =>
        Effect.promise(() =>
          session.observePreparedConnection.run(registry, { environmentId, input: {} }),
        );
      const first = yield* read();
      expect(first).toMatchObject({ _tag: "Success", value: connection });
      const replacement = {
        ...connection,
        target: new BearerConnectionTarget({ ...target, connectionId: "replacement-account" }),
        httpAuthorization: { _tag: "Bearer" as const, token: "replacement-fixture" },
      };
      yield* SubscriptionRef.set(prepared, Option.some(replacement));
      expect(yield* read()).toMatchObject({ _tag: "Success", value: replacement });
      yield* SubscriptionRef.set(prepared, Option.none());
      expect(yield* read()).toMatchObject({ _tag: "Success", value: null });
      expect(yield* read(EnvironmentId.make("other-host"))).toMatchObject({ _tag: "Failure" });
      expect(scopedCalls).toEqual([
        target.environmentId,
        target.environmentId,
        target.environmentId,
        "other-host",
      ]);
    }).pipe(Effect.scoped),
);

it.effect(
  "routes invitation and client access commands to the current host, strips secrets, and preserves scope refusals",
  () =>
    Effect.gen(function* () {
      const prepared = yield* SubscriptionRef.make(Option.some(connection));
      const supervisor = EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected",
        }),
        session: yield* SubscriptionRef.make(Option.none<RpcSession>()),
        prepared,
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const calls: Array<{ url: string; authorization: string | null; payload: unknown }> = [];
      const fetchFixture: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const body = await request.text();
        calls.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
          payload: body ? decodeJson(body) : null,
        });
        if (request.headers.get("authorization") === "Bearer participant") {
          return Response.json(
            {
              _tag: "EnvironmentScopeRequiredError",
              code: "insufficient_scope",
              requiredScope: "access:write",
              traceId: "fixture-trace",
            },
            { status: 403 },
          );
        }
        if (request.url.endsWith("/api/auth/pairing-token")) {
          return Response.json({
            id: "invite-1",
            credential: "one-time-secret",
            label: "Alice",
            expiresAt: "2026-10-17T10:05:00Z",
          });
        }
        if (request.url.endsWith("/api/auth/pairing-links")) {
          return Response.json([
            {
              id: "invite-1",
              scopes: AuthSharedParticipantScopes,
              subject: "one-time-token",
              label: "Alice",
              createdAt: "2026-10-17T10:00:00Z",
              expiresAt: "2026-10-17T10:05:00Z",
              credential: "must-not-survive-decoding",
            },
          ]);
        }
        if (request.url.endsWith("/api/auth/pairing-links/revoke"))
          return Response.json({ revoked: true });
        if (request.url.endsWith("/api/auth/clients")) {
          return Response.json([
            {
              sessionId: "participant-client",
              subject: "one-time-token",
              scopes: AuthSharedParticipantScopes,
              method: "bearer-access-token",
              client: { label: "Alice's desktop", deviceType: "desktop" },
              issuedAt: "2026-10-17T10:00:00Z",
              expiresAt: "2026-10-18T10:00:00Z",
              lastConnectedAt: null,
              connected: false,
              current: false,
              credential: "must-not-survive-decoding",
            },
          ]);
        }
        if (request.url.endsWith("/api/auth/clients/revoke"))
          return Response.json({ revoked: true });
        throw new Error("Unexpected fixture endpoint");
      };
      const scopedCalls: EnvironmentId[] = [];
      const run: EnvironmentRegistry["Service"]["run"] = (environmentId, effect) => {
        scopedCalls.push(environmentId);
        return environmentId === target.environmentId
          ? Effect.provideService(effect, EnvironmentSupervisor, supervisor)
          : Effect.fail(new EnvironmentNotRegisteredError({ environmentId }));
      };
      const runtime = Atom.runtime(
        Layer.merge(
          Layer.succeed(
            EnvironmentRegistry,
            EnvironmentRegistry.of({
              run,
              followStream: () => Stream.never,
            } as unknown as EnvironmentRegistry["Service"]),
          ),
          remoteHttpClientLayer(fetchFixture),
        ),
      );
      const session = createEnvironmentSessionAtoms(runtime);
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const address = { environmentId: target.environmentId };
      const created = yield* Effect.promise(() =>
        session.createPairingCredential.run(registry, {
          ...address,
          input: { label: "Alice", scopes: AuthSharedParticipantScopes },
        }),
      );
      expect(created).toMatchObject({
        _tag: "Success",
        value: {
          id: "invite-1",
          credential: "one-time-secret",
          httpBaseUrl: "https://shared.example",
        },
      });
      expect(calls[0]).toEqual({
        url: "https://shared.example/api/auth/pairing-token",
        authorization: "Bearer fixture-credential",
        payload: { label: "Alice", scopes: AuthSharedParticipantScopes },
      });
      const listed = yield* Effect.promise(() =>
        session.listPairingLinks.run(registry, { ...address, input: {} }),
      );
      expect(listed).toMatchObject({
        _tag: "Success",
        value: [{ id: "invite-1", label: "Alice", scopes: AuthSharedParticipantScopes }],
      });
      if (listed._tag === "Success") expect(listed.value[0]).not.toHaveProperty("credential");
      yield* SubscriptionRef.set(
        prepared,
        Option.some({
          ...connection,
          httpBaseUrl: "https://replacement.example",
          httpAuthorization: { _tag: "Bearer", token: "replacement" },
        }),
      );
      const revoked = yield* Effect.promise(() =>
        session.revokePairingLink.run(registry, { ...address, input: { id: "invite-1" } }),
      );
      expect(revoked).toMatchObject({ _tag: "Success", value: { revoked: true } });
      expect(calls[2]).toEqual({
        url: "https://replacement.example/api/auth/pairing-links/revoke",
        authorization: "Bearer replacement",
        payload: { id: "invite-1" },
      });
      const clients = yield* Effect.promise(() =>
        session.listClientSessions.run(registry, { ...address, input: {} }),
      );
      expect(clients).toMatchObject({
        _tag: "Success",
        value: [{ sessionId: "participant-client", current: false }],
      });
      if (clients._tag === "Success") expect(clients.value[0]).not.toHaveProperty("credential");
      expect(calls[3]).toEqual({
        url: "https://replacement.example/api/auth/clients",
        authorization: "Bearer replacement",
        payload: null,
      });
      expect(
        yield* Effect.promise(() =>
          session.revokeClientSession.run(registry, {
            ...address,
            input: { sessionId: AuthSessionId.make("participant-client") },
          }),
        ),
      ).toMatchObject({ _tag: "Success", value: { revoked: true } });
      expect(calls[4]).toEqual({
        url: "https://replacement.example/api/auth/clients/revoke",
        authorization: "Bearer replacement",
        payload: { sessionId: "participant-client" },
      });
      yield* SubscriptionRef.set(
        prepared,
        Option.some({ ...connection, httpAuthorization: { _tag: "Bearer", token: "participant" } }),
      );
      const denied = yield* Effect.promise(() =>
        session.createPairingCredential.run(registry, {
          ...address,
          input: { scopes: AuthSharedParticipantScopes },
        }),
      );
      expect(denied._tag).toBe("Failure");
      if (denied._tag === "Failure")
        expect(Cause.squash(denied.cause)).toMatchObject({ code: "insufficient_scope" });
      expect(calls[5]?.url).toBe("https://shared.example/api/auth/pairing-token");
      const deniedClientRevocation = yield* Effect.promise(() =>
        session.revokeClientSession.run(registry, {
          ...address,
          input: { sessionId: AuthSessionId.make("participant-client") },
        }),
      );
      expect(deniedClientRevocation._tag).toBe("Failure");
      if (deniedClientRevocation._tag === "Failure")
        expect(Cause.squash(deniedClientRevocation.cause)).toMatchObject({
          code: "insufficient_scope",
        });
      yield* SubscriptionRef.set(prepared, Option.none());
      expect(
        (yield* Effect.promise(() =>
          session.listPairingLinks.run(registry, { ...address, input: {} }),
        ))._tag,
      ).toBe("Failure");
      expect(
        (yield* Effect.promise(() =>
          session.createPairingCredential.run(registry, {
            environmentId: EnvironmentId.make("primary"),
            input: { scopes: AuthSharedParticipantScopes },
          }),
        ))._tag,
      ).toBe("Failure");
      expect(calls).toHaveLength(7);
      expect(scopedCalls).toEqual([
        target.environmentId,
        target.environmentId,
        target.environmentId,
        target.environmentId,
        target.environmentId,
        target.environmentId,
        target.environmentId,
        target.environmentId,
        "primary",
      ]);
    }).pipe(Effect.scoped),
);

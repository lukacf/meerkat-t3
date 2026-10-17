import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  SharedActivity,
  SharedWorkspaceError,
  type SharedDelegationRegisterInput,
  type SharedDelegationInvokeInput,
  type SharedLocalAgentBinding,
  type SharedActivityPublishInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSecretStore, SecretStorePersistError } from "../auth/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeSharedWorkspaceStore } from "./SharedWorkspaceStore.ts";
import type { SharedLocalCheckoutValidator } from "./SharedLocalCheckoutValidator.ts";
import { sharedDelegationContext } from "./SharedDelegationContext.ts";
import { makeSharedDelegationService } from "./SharedDelegationService.ts";
import { makeSharedDelegationInvoker } from "./SharedDelegationInvoker.ts";
import {
  makeSharedLocalDelegationService,
  sharedConnectionOrigin,
  type SharedDelegationRemote,
} from "./SharedLocalDelegationService.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeActivity = Schema.decodeUnknownSync(Schema.fromJsonString(SharedActivity));
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const observed = yield* DateTime.now;
  const timestamp = DateTime.formatIso(observed);
  const expiry = DateTime.formatIso(DateTime.add(observed, { hours: 1 }));
  for (const session of ["remote-session", "other-session", "local-session"])
    yield* sql`INSERT INTO auth_sessions(session_id,subject,scopes,method,issued_at,expires_at)
      VALUES (${session},${session},'["shared:read","shared:contribute"]','pairing',${timestamp},${expiry})`;
  const store = yield* makeSharedWorkspaceStore;
  const settings = yield* store.configure({ name: "Shared workspace" });
  const owner = yield* store.join("remote-session", { displayName: "Owner" });
  yield* store.join("other-session", { displayName: "Other" });
  const project = yield* store.registerProject({
    requestId: "api",
    name: "API",
    repository: "https://github.com/example/api",
    hostProjectId: ProjectId.make("host"),
  });
  const checkout = yield* store.attachCheckout("remote-session", {
    localEnvironmentId: EnvironmentId.make("local-env"),
    localProjectId: ProjectId.make("local-project"),
    repository: project.repository,
  });
  const context = yield* store.putContext(
    { kind: "participant", participantId: owner.participantId },
    {
      contextId: "context",
      checkoutId: checkout.checkoutId,
      source: { kind: "thread", threadId: ThreadId.make("thread") },
      objective: "Update API",
      revision: { branch: "feature", commit: "a".repeat(40), applicability: "branch" },
      paths: ["src"],
      tags: ["api"],
    },
  );
  let binding: SharedLocalAgentBinding = {
    environmentId: checkout.localEnvironmentId,
    projectId: checkout.localProjectId,
    threadId: ThreadId.make("thread"),
    instanceId: ProviderInstanceId.make("meerkat"),
    mobId: "local-mob",
    sessionId: "native-session",
  };
  const input: SharedDelegationRegisterInput = {
    requestId: "grant",
    label: "API task",
    binding,
    contextId: context.contextId,
    contextVersion: context.contextVersion,
    actions: [
      "activity.publish",
      "inbox.list",
      "inbox.ack",
      "specialists.send",
      "specialists.request",
    ],
    expiresAt: DateTime.formatIso(DateTime.add(observed, { minutes: 10 })),
  };
  const grants = yield* makeSharedDelegationService(store);
  const invoker = makeSharedDelegationInvoker(store, grants, {
    sendDelegated: () => Effect.die("No specialist execution expected in this fixture"),
    requestDelegated: () => Effect.die("No specialist receipt expected in this fixture"),
  });
  const activity: SharedActivityPublishInput = {
    eventId: "event",
    contextId: context.contextId,
    contextVersion: context.contextVersion,
    revision: context.revision,
    kind: "finding",
    summary: "A compatibility issue",
    paths: ["src/api.ts"],
    tags: ["api"],
    sources: [],
  };
  const secretValues = new Map<string, Uint8Array>();
  let refuseRemoval = false;
  const secrets: ServerSecretStore["Service"] = {
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(secretValues.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        secretValues.set(name, value);
      }),
    create: (name, value) =>
      Effect.suspend(() =>
        secretValues.has(name)
          ? Effect.fail(
              new SecretStorePersistError({ resource: name, cause: new Error("duplicate") }),
            )
          : Effect.sync(() => {
              secretValues.set(name, value);
            }),
      ),
    remove: (name) =>
      Effect.suspend(() =>
        refuseRemoval
          ? Effect.fail(
              new SecretStorePersistError({
                resource: name,
                cause: new Error("fixture removal failure"),
              }),
            )
          : Effect.sync(() => {
              secretValues.delete(name);
            }),
      ),
    getOrCreateRandom: () => Effect.die("not used"),
  };
  const invocations: SharedDelegationInvokeInput[] = [];
  const registrations: SharedDelegationRegisterInput[] = [];
  const remote: SharedDelegationRemote = {
    context: (_, raw) => sharedDelegationContext(store, "remote-session", raw),
    session: () =>
      Effect.succeed({
        environmentId: EnvironmentId.make("remote-env"),
        workspaceId: settings.workspaceId,
        participantId: owner.participantId,
        canContribute: true,
      }),
    register: (_, raw) =>
      Effect.gen(function* () {
        registrations.push(raw);
        return yield* grants.register("remote-session", raw);
      }),
    revoke: (_, delegationId) => grants.revoke("remote-session", { delegationId }),
    invoke: (_, invocation) =>
      Effect.gen(function* () {
        const { actor } = yield* grants.authorize("remote-session", invocation);
        invocations.push(invocation);
        if (invocation.action === "activity.publish")
          return yield* store.publishActivity(
            actor,
            invocation.arguments as unknown as SharedActivityPublishInput,
          );
        return { accepted: true };
      }),
  };
  const makeBroker = (
    overrides: Partial<SharedDelegationRemote> = {},
    resolver = () => Effect.succeed(binding),
    validateCheckout: SharedLocalCheckoutValidator = () => Effect.void,
  ) =>
    makeSharedLocalDelegationService({ ...remote, ...overrides }, resolver, validateCheckout).pipe(
      Effect.provideService(ServerSecretStore, secrets),
    );
  const connectInput = {
    requestId: "setup",
    label: "Shared server",
    origin: "https://shared.example",
    credential: "private-fixture-credential",
    expected: {
      environmentId: EnvironmentId.make("remote-env"),
      workspaceId: settings.workspaceId,
      participantId: owner.participantId,
    },
    consent: true as const,
  };
  const enableInput = (connectionId: string) => ({
    connectionId,
    requestId: "enable",
    threadId: binding.threadId,
    label: input.label,
    contextId: context.contextId,
    contextVersion: context.contextVersion,
    actions: input.actions,
    expiresAt: input.expiresAt,
  });
  const invocation = {
    version: 1 as const,
    mobId: binding.mobId,
    sessionId: binding.sessionId,
    runId: "run",
    callId: "call",
    interactionId: "interaction",
    action: "activity.publish",
    arguments: activity as unknown as Record<string, unknown>,
  };
  return {
    sql,
    store,
    owner,
    context,
    grants,
    invoker,
    input,
    activity,
    secretValues,
    refuseRemoval: (value: boolean) => {
      refuseRemoval = value;
    },
    makeBroker,
    connectInput,
    enableInput,
    invocation,
    invocations,
    registrations,
    changeBinding: () => {
      binding = { ...binding, sessionId: "replacement-session" };
    },
  };
});

describe("host-recognized local agent delegation", () => {
  it.effect("accepts canonical remote expiry receipts for an equivalent offset request", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const broker = yield* f.makeBroker();
      const connection = yield* broker.connect("local-session", f.connectInput);
      const expiresAt = DateTime.formatIso(
        DateTime.makeUnsafe(Date.parse(f.input.expiresAt) - 12 * 60 * 60 * 1000),
      ).replace("Z", "-12:00");
      const enabled = yield* broker.enable("local-session", {
        ...f.enableInput(connection.connectionId),
        expiresAt,
      });
      expect(enabled.grant!.expiresAt).toBe(f.input.expiresAt);
      expect(f.registrations[0]!.expiresAt).toBe(expiresAt);
      const revoked = yield* broker.revoke("local-session", enabled.localId);
      expect(revoked.grant!.revokedAt).not.toBeNull();
      expect(revoked.revokedAt).not.toBeNull();
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "retains an admitted immutable checkout proof across response loss and rejects unverified new admissions",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        let proofs = 0;
        let deny = false;
        const validate: SharedLocalCheckoutValidator = () =>
          Effect.suspend(() => {
            proofs += 1;
            return deny
              ? Effect.fail(
                  new SharedWorkspaceError({ code: "conflict", message: "changed checkout" }),
                )
              : Effect.void;
          });
        const offline = yield* f.makeBroker(
          {
            register: () =>
              Effect.fail(
                new SharedWorkspaceError({ code: "unavailable", message: "response lost" }),
              ),
          },
          undefined,
          validate,
        );
        const connection = yield* offline.connect("local-session", f.connectInput);
        const input = f.enableInput(connection.connectionId);
        expect((yield* offline.enable("local-session", input).pipe(Effect.flip)).code).toBe(
          "unavailable",
        );
        expect(proofs).toBe(1);
        deny = true;
        const restarted = yield* f.makeBroker({}, undefined, validate);
        const granted = yield* restarted.enable("local-session", input);
        expect(granted.grant!.context.contextVersion).toBe(f.context.contextVersion);
        expect(proofs).toBe(1);
        expect(
          (yield* restarted
            .enable("local-session", { ...input, requestId: "new" })
            .pipe(Effect.flip)).code,
        ).toBe("conflict");
        expect(proofs).toBe(2);
        expect((yield* f.sql`SELECT local_id FROM shared_local_delegations`).length).toBe(1);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("returns only the authenticated participant's immutable context proof", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const input = { contextId: f.context.contextId, contextVersion: f.context.contextVersion };
      expect((yield* sharedDelegationContext(f.store, "remote-session", input)).context).toEqual(
        f.context,
      );
      expect(
        (yield* sharedDelegationContext(f.store, "other-session", input).pipe(Effect.flip)).code,
      ).toBe("forbidden");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("announces the captured objective once only with publication consent", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.grants.register("remote-session", {
        ...f.input,
        requestId: "read-only",
        actions: ["inbox.list"],
      });
      expect(yield* f.sql`SELECT event_id FROM shared_activity`).toEqual([]);
      const grant = yield* f.grants.register("remote-session", f.input);
      const retained = yield* f.sql<{ definition_json: string }>`SELECT definition_json
        FROM shared_activity ORDER BY sequence`;
      expect(retained).toHaveLength(1);
      expect(decodeActivity(retained[0]!.definition_json)).toMatchObject({
        eventId: `task-started-${grant.delegationId}`,
        kind: "task_started",
        summary: f.context.objective,
        context: f.context,
        revision: f.context.revision,
        paths: f.context.paths,
        tags: f.context.tags,
        author: {
          participantId: grant.delegationId,
          kind: "local_agent",
          provenance: {
            kind: "participant_broker_assertion",
            ownerParticipantId: f.owner.participantId,
            localThreadId: f.input.binding.threadId,
          },
        },
      });
      yield* f.store.putContext(
        { kind: "participant", participantId: f.owner.participantId },
        {
          ...f.context,
          objective: "A newer objective must not rewrite the original announcement",
          revision: { ...f.context.revision, commit: "b".repeat(40) },
        },
      );
      expect(yield* f.grants.register("remote-session", f.input)).toEqual(grant);
      expect(yield* f.sql`SELECT definition_json FROM shared_activity ORDER BY sequence`).toEqual(
        retained,
      );
      const { actor } = yield* f.grants.authorize("remote-session", {
        delegationId: grant.delegationId,
        action: "activity.publish",
      });
      yield* f.store.publishActivity(actor, f.activity);
      const events = yield* f.sql<{ definition_json: string }>`SELECT definition_json
        FROM shared_activity ORDER BY sequence`;
      expect(events.map((row) => decodeActivity(row.definition_json).kind)).toEqual([
        "task_started",
        "finding",
      ]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "renews an elapsed grant without rewriting revocation or confusing native routing",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const broker = yield* f.makeBroker();
        const connection = yield* broker.connect("local-session", f.connectInput);
        const previous = yield* broker.enable(
          "local-session",
          f.enableInput(connection.connectionId),
        );
        const remoteBefore = yield* f.sql`SELECT definition_json FROM shared_delegations
          WHERE delegation_id=${previous.grant!.delegationId}`;
        yield* TestClock.adjust("10 minutes");
        const renewed = yield* broker.enable("local-session", {
          ...f.enableInput(connection.connectionId),
          requestId: "renew",
          expiresAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 10 })),
        });
        expect(renewed.localId).not.toBe(previous.localId);
        expect(renewed.grant?.delegationId).not.toBe(previous.grant?.delegationId);
        const history = yield* broker.listDelegations("local-session", connection.connectionId);
        expect(history).toHaveLength(2);
        expect(history.find((row) => row.localId === previous.localId)).toEqual(previous);
        expect(
          history.every((row) => row.revokedAt === null && row.grant?.revokedAt === null),
        ).toBe(true);
        const result = yield* broker.invoke(f.invocation);
        expect(result).toMatchObject({ author: { participantId: renewed.grant!.delegationId } });
        expect(f.invocations.map((call) => call.delegationId)).toEqual([
          renewed.grant!.delegationId,
        ]);
        expect(
          yield* f.sql`SELECT definition_json FROM shared_delegations
        WHERE delegation_id=${previous.grant!.delegationId}`,
        ).toEqual(remoteBefore);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("releases an expired unconfirmed registration on another stored connection", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const offline = yield* f.makeBroker({
        register: () =>
          Effect.fail(new SharedWorkspaceError({ code: "unavailable", message: "offline" })),
      });
      const previousConnection = yield* offline.connect("local-session", f.connectInput);
      yield* offline
        .enable("local-session", f.enableInput(previousConnection.connectionId))
        .pipe(Effect.flip);
      const previous = (yield* offline.listDelegations(
        "local-session",
        previousConnection.connectionId,
      ))[0]!;
      expect(previous.grant).toBeNull();
      const broker = yield* f.makeBroker();
      const connection = yield* broker.connect("local-session", {
        ...f.connectInput,
        requestId: "second-connection",
      });
      const input = {
        ...f.enableInput(connection.connectionId),
        requestId: "replacement",
        expiresAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 20 })),
      };
      expect((yield* broker.enable("local-session", input).pipe(Effect.flip)).code).toBe(
        "conflict",
      );
      yield* TestClock.adjust("10 minutes");
      const renewed = yield* broker.enable("local-session", input);
      expect(
        yield* broker.listDelegations("local-session", previousConnection.connectionId),
      ).toEqual([previous]);
      yield* broker.invoke(f.invocation);
      expect(f.invocations.map((call) => call.delegationId)).toEqual([renewed.grant!.delegationId]);
      expect(previous.revokedAt).toBeNull();
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("admits only one unexpired renewal when two requests race", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const broker = yield* f.makeBroker();
      const connection = yield* broker.connect("local-session", f.connectInput);
      yield* broker.enable("local-session", f.enableInput(connection.connectionId));
      yield* TestClock.adjust("10 minutes");
      const expiresAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 10 }));
      const results = yield* Effect.forEach(
        ["renew-a", "renew-b"],
        (requestId) =>
          broker
            .enable("local-session", {
              ...f.enableInput(connection.connectionId),
              requestId,
              expiresAt,
            })
            .pipe(Effect.match({ onSuccess: () => "enabled", onFailure: (error) => error.code })),
        { concurrency: 2 },
      );
      expect(results.toSorted()).toEqual(["conflict", "enabled"]);
      expect(yield* broker.listDelegations("local-session", connection.connectionId)).toHaveLength(
        2,
      );
      yield* broker.invoke(f.invocation);
      expect(f.invocations).toHaveLength(1);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("does not release admission for missing or malformed expiry evidence", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const broker = yield* f.makeBroker();
      const connection = yield* broker.connect("local-session", f.connectInput);
      const previous = yield* broker.enable(
        "local-session",
        f.enableInput(connection.connectionId),
      );
      yield* TestClock.adjust("10 minutes");
      const input = {
        ...f.enableInput(connection.connectionId),
        requestId: "renew",
        expiresAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 10 })),
      };
      const original = f.registrations[0]!;
      for (const expiresAt of [
        undefined,
        null,
        "not-a-date",
        "2451545",
        "1970-01-01",
        "1970-01-01T00:00:00",
      ]) {
        yield* f.sql`UPDATE shared_local_delegations SET registration_json=${encode({ ...original, expiresAt })}
          WHERE local_id=${previous.localId}`;
        expect((yield* broker.enable("local-session", input).pipe(Effect.flip)).code).toBe(
          "conflict",
        );
      }
      expect(yield* f.sql`SELECT local_id FROM shared_local_delegations`).toHaveLength(1);
      expect(f.registrations).toHaveLength(1);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("skips expired history across lookup pages without hiding the current grant", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const broker = yield* f.makeBroker();
      const connection = yield* broker.connect("local-session", f.connectInput);
      const previous = yield* broker.enable(
        "local-session",
        f.enableInput(connection.connectionId),
      );
      for (let index = 0; index < 101; index++)
        yield* f.sql`INSERT INTO shared_local_delegations(local_id,connection_id,thread_id,fingerprint,registration_json,definition_json,revoked_at)
          SELECT ${`000-expired-${String(index).padStart(3, "0")}`},connection_id,thread_id,fingerprint,registration_json,definition_json,revoked_at
          FROM shared_local_delegations WHERE local_id=${previous.localId}`;
      yield* TestClock.adjust("10 minutes");
      const renewed = yield* broker.enable("local-session", {
        ...f.enableInput(connection.connectionId),
        requestId: "renew",
        expiresAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 10 })),
      });
      yield* broker.invoke(f.invocation);
      expect(f.invocations.map((call) => call.delegationId)).toEqual([renewed.grant!.delegationId]);
      expect(yield* broker.listDelegations("local-session", connection.connectionId)).toHaveLength(
        103,
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("cancels an unconfirmed setup before a delayed remote observation returns", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const broker = yield* f.makeBroker({
        session: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return { ...f.connectInput.expected, canContribute: true };
          }),
      });
      const pending = yield* broker
        .connect("local-session", f.connectInput)
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(entered);
      expect(f.secretValues.size).toBe(1);
      expect(yield* broker.list("local-session")).toEqual([]);
      const result = yield* broker.cancelSetup("local-session", {
        requestId: f.connectInput.requestId,
      });
      expect(result).toEqual({
        canceled: true,
        requestId: f.connectInput.requestId,
        cleanup: null,
      });
      expect(f.secretValues.size).toBe(0);
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(pending)).code).toBe("forbidden");
      const restarted = yield* f.makeBroker();
      expect(
        (yield* restarted.connect("local-session", f.connectInput).pipe(Effect.flip)).code,
      ).toBe("forbidden");
      expect(
        yield* restarted.cancelSetup("local-session", { requestId: f.connectInput.requestId }),
      ).toEqual(result);
      expect(f.secretValues.size).toBe(0);
      expect(yield* restarted.list("local-session")).toEqual([]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "keeps cancellation owner-scoped and durable even before setup reaches the server",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const broker = yield* f.makeBroker();
        const request = { requestId: f.connectInput.requestId };
        yield* broker.cancelSetup("other-session", request);
        // Another local owner using the same opaque request ID does not affect this owner.
        const connection = yield* broker.connect("local-session", f.connectInput);
        expect(connection.revokedAt).toBeNull();
        expect(f.secretValues.size).toBe(1);
        expect(
          (yield* broker.connect("other-session", f.connectInput).pipe(Effect.flip)).code,
        ).toBe("forbidden");
        yield* f.sql`UPDATE auth_sessions SET revoked_at=issued_at WHERE session_id='other-session'`;
        expect((yield* broker.cancelSetup("other-session", request).pipe(Effect.flip)).code).toBe(
          "forbidden",
        );
        expect(f.secretValues.size).toBe(1);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("retries failed secret deletion after permanently canceling a pending setup", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const broker = yield* f.makeBroker({
        session: () =>
          Effect.fail(new SharedWorkspaceError({ code: "unavailable", message: "offline" })),
      });
      yield* broker.connect("local-session", f.connectInput).pipe(Effect.flip);
      const request = { requestId: f.connectInput.requestId };
      f.refuseRemoval(true);
      expect((yield* broker.cancelSetup("local-session", request).pipe(Effect.flip)).code).toBe(
        "unavailable",
      );
      expect(f.secretValues.size).toBe(1);
      expect(yield* f.sql`SELECT request_id FROM shared_local_connection_cancellations`).toEqual([
        { request_id: request.requestId },
      ]);
      const restarted = yield* f.makeBroker();
      expect(
        (yield* restarted.connect("local-session", f.connectInput).pipe(Effect.flip)).code,
      ).toBe("forbidden");
      f.refuseRemoval(false);
      expect(yield* restarted.cancelSetup("local-session", request)).toEqual({
        canceled: true,
        ...request,
        cleanup: null,
      });
      expect(f.secretValues.size).toBe(0);
      expect(yield* restarted.cancelSetup("local-session", request)).toEqual({
        canceled: true,
        ...request,
        cleanup: null,
      });
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("canceling a response-lost confirmed setup disconnects its existing grants", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const broker = yield* f.makeBroker();
      const connection = yield* broker.connect("local-session", f.connectInput);
      yield* broker.enable("local-session", f.enableInput(connection.connectionId));
      yield* f.sql`UPDATE auth_sessions SET revoked_at=issued_at WHERE session_id='remote-session'`;
      const result = yield* broker.cancelSetup("local-session", {
        requestId: connection.requestId,
      });
      expect(result.cleanup).toMatchObject({
        connection: { connectionId: connection.connectionId },
        remoteRevocation: "unconfirmed",
      });
      expect(f.secretValues.size).toBe(0);
      expect((yield* broker.invoke(f.invocation).pipe(Effect.asVoid, Effect.flip)).code).toBe(
        "forbidden",
      );
      expect(
        (yield* broker.listDelegations("local-session", connection.connectionId))[0]?.revokedAt,
      ).not.toBeNull();
      expect(
        yield* broker.cancelSetup("local-session", { requestId: connection.requestId }),
      ).toEqual(result);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "removes the secret and records unconfirmed revocation when the remote parent login is revoked",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const broker = yield* f.makeBroker();
        const connection = yield* broker.connect("local-session", f.connectInput);
        const local = yield* broker.enable("local-session", f.enableInput(connection.connectionId));
        yield* f.sql`UPDATE auth_sessions SET revoked_at=issued_at WHERE session_id='remote-session'`;
        const result = yield* broker.disconnect("local-session", connection.connectionId);
        expect(result.remoteRevocation).toBe("unconfirmed");
        expect(result.connection.requestId).toBe(f.connectInput.requestId);
        expect(result.connection.revokedAt).not.toBeNull();
        expect(f.secretValues.size).toBe(0);
        expect(yield* broker.list("local-session")).toEqual([result.connection]);
        expect((yield* broker.invoke(f.invocation).pipe(Effect.asVoid, Effect.flip)).code).toBe(
          "forbidden",
        );
        expect(
          (yield* broker.listDelegations("local-session", connection.connectionId))[0],
        ).toMatchObject({
          localId: local.localId,
          revokedAt: result.connection.revokedAt,
          grant: { revokedAt: null },
        });
        expect(
          (yield* broker.disconnect("local-session", connection.connectionId)).remoteRevocation,
        ).toBe("unconfirmed");
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "removes an expired pending connection without claiming its unknown registration was revoked",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        let registrations = 0;
        const broker = yield* f.makeBroker({
          register: () => {
            registrations++;
            return Effect.fail(
              new SharedWorkspaceError({
                code: "unavailable",
                message: "The host was not reached",
              }),
            );
          },
        });
        const connection = yield* broker.connect("local-session", f.connectInput);
        yield* broker
          .enable("local-session", f.enableInput(connection.connectionId))
          .pipe(Effect.flip);
        expect(
          (yield* broker.listDelegations("local-session", connection.connectionId))[0]?.grant,
        ).toBeNull();
        yield* TestClock.adjust("11 minutes");
        const result = yield* broker.disconnect("local-session", connection.connectionId);
        expect(result.remoteRevocation).toBe("unconfirmed");
        expect(f.secretValues.size).toBe(0);
        expect(registrations).toBe(1);
        expect(
          (yield* broker.disconnect("local-session", connection.connectionId)).remoteRevocation,
        ).toBe("unconfirmed");
        expect(registrations).toBe(1);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "deletes the credential before a bounded remote attempt and retains uncertainty after timeout",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const entered = yield* Deferred.make<void>();
        const broker = yield* f.makeBroker({
          revoke: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never;
            }),
        });
        const connection = yield* broker.connect("local-session", f.connectInput);
        yield* broker.enable("local-session", f.enableInput(connection.connectionId));
        const pending = yield* broker
          .disconnect("local-session", connection.connectionId)
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        expect(f.secretValues.size).toBe(0);
        expect((yield* broker.invoke(f.invocation).pipe(Effect.asVoid, Effect.flip)).code).toBe(
          "forbidden",
        );
        yield* TestClock.adjust("11 seconds");
        expect((yield* Fiber.join(pending)).remoteRevocation).toBe("unconfirmed");
        expect((yield* broker.list("local-session"))[0]?.remoteRevocation).toBe("unconfirmed");
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("does not persist removal proof if secure secret deletion failed", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const broker = yield* f.makeBroker();
      const connection = yield* broker.connect("local-session", f.connectInput);
      f.refuseRemoval(true);
      expect(
        (yield* broker.disconnect("local-session", connection.connectionId).pipe(Effect.flip)).code,
      ).toBe("unavailable");
      expect(f.secretValues.size).toBe(1);
      const disabled = (yield* broker.list("local-session"))[0]!;
      expect(disabled.revokedAt).not.toBeNull();
      expect(disabled.remoteRevocation).toBeUndefined();
      f.refuseRemoval(false);
      expect(
        (yield* broker.disconnect("local-session", connection.connectionId)).remoteRevocation,
      ).toBe("confirmed");
      expect(f.secretValues.size).toBe(0);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("rejects forged context, inbox identity and ungranted or revoked remote reads", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const grant = yield* f.grants.register("remote-session", {
        ...f.input,
        actions: [...f.input.actions, "projects.list"],
      });
      const invoke = (
        action: SharedDelegationInvokeInput["action"],
        arguments_: Record<string, unknown> = {},
      ) =>
        f.invoker.invoke("remote-session", {
          delegationId: grant.delegationId,
          action,
          arguments: arguments_,
        });
      expect(yield* invoke("projects.list")).toMatchObject({ items: [{ name: "API" }] });
      expect((yield* invoke("knowledge.search").pipe(Effect.asVoid, Effect.flip)).code).toBe(
        "forbidden",
      );
      expect(
        (yield* f.invoker
          .invoke("other-session", {
            delegationId: grant.delegationId,
            action: "projects.list",
            arguments: {},
          })
          .pipe(Effect.asVoid, Effect.flip)).code,
      ).toBe("forbidden");
      expect(
        (yield* invoke("activity.publish", { ...f.activity, contextVersion: "forged" }).pipe(
          Effect.asVoid,
          Effect.flip,
        )).code,
      ).toBe("forbidden");
      expect(
        (yield* invoke("inbox.list", { recipientId: f.owner.participantId }).pipe(
          Effect.asVoid,
          Effect.flip,
        )).code,
      ).toBe("forbidden");
      expect(yield* invoke("inbox.list")).toMatchObject({ recipientId: grant.delegationId });
      expect(
        yield* invoke("activity.publish", {
          ...f.activity,
          author: f.owner,
          participantId: f.owner.participantId,
        }),
      ).toMatchObject({
        author: { kind: "local_agent", participantId: grant.delegationId },
      });
      yield* f.grants.revoke("remote-session", { delegationId: grant.delegationId });
      expect((yield* invoke("projects.list").pipe(Effect.asVoid, Effect.flip)).code).toBe(
        "forbidden",
      );
      const next = yield* f.grants.register("remote-session", {
        ...f.input,
        requestId: "next",
        actions: ["projects.list"],
      });
      yield* f.sql`UPDATE auth_sessions SET revoked_at=issued_at WHERE session_id='remote-session'`;
      expect(
        (yield* f.invoker
          .invoke("remote-session", {
            delegationId: next.delegationId,
            action: "projects.list",
            arguments: {},
          })
          .pipe(Effect.asVoid, Effect.flip)).code,
      ).toBe("forbidden");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("routes broker-derived knowledge through exact remote context and action checks", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const broker = yield* f.makeBroker({
        invoke: (_, input) => f.invoker.invoke("remote-session", input),
      });
      const connection = yield* broker.connect("local-session", f.connectInput);
      const local = yield* broker.enable("local-session", {
        ...f.enableInput(connection.connectionId),
        actions: ["knowledge.record", "knowledge.supersede"],
      });
      const evidence = {
        evidenceId: "first",
        kind: "finding",
        title: "Compatibility",
        body: "A retained observation",
        sources: [],
        supersedes: [],
        state: "open",
      };
      expect(
        yield* broker.invoke({ ...f.invocation, action: "knowledge.record", arguments: evidence }),
      ).toMatchObject({
        author: { kind: "local_agent", participantId: local.grant!.delegationId },
        contextId: f.context.contextId,
        contextVersion: f.context.contextVersion,
        revision: f.context.revision,
      });
      const correction = {
        ...evidence,
        evidenceId: "correction",
        body: "Corrected observation",
        supersedes: ["first"],
      };
      // Having both capabilities does not let the record action silently become supersede.
      expect(
        (yield* f.invoker
          .invoke("remote-session", {
            delegationId: local.grant!.delegationId,
            action: "knowledge.record",
            arguments: {
              ...correction,
              contextId: f.context.contextId,
              contextVersion: f.context.contextVersion,
              revision: f.context.revision,
            },
          })
          .pipe(Effect.asVoid, Effect.flip)).code,
      ).toBe("forbidden");
      expect(
        yield* broker.invoke({
          ...f.invocation,
          action: "knowledge.supersede",
          arguments: correction,
        }),
      ).toMatchObject({ evidenceId: "correction", supersedes: ["first"] });
      expect(yield* f.sql`SELECT evidence_id FROM shared_knowledge`).toHaveLength(2);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("reuses a durable connection claim across overlapping setup and a lost response", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let first = true;
      const make = () =>
        f.makeBroker({
          session: () =>
            Effect.gen(function* () {
              if (first) {
                first = false;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              return {
                environmentId: EnvironmentId.make("remote-env"),
                workspaceId: f.connectInput.expected.workspaceId,
                participantId: f.owner.participantId,
                canContribute: true,
              };
            }),
        });
      const broker = yield* make();
      const initial = yield* broker.connect("local-session", f.connectInput).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const restarted = yield* make();
      const overlapping = yield* restarted.connect("local-session", f.connectInput);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(initial)).toEqual(overlapping);
      // The initial caller may have lost its response; this retry reads the durable result.
      expect(yield* restarted.connect("local-session", f.connectInput)).toEqual(overlapping);
      expect(yield* f.sql`SELECT connection_id FROM shared_local_connections`).toHaveLength(1);
      expect(f.secretValues.size).toBe(1);
      expect(
        (yield* restarted
          .connect("local-session", { ...f.connectInput, credential: "different-private-value" })
          .pipe(Effect.flip)).code,
      ).toBe("conflict");
      expect(
        (yield* restarted
          .connect("local-session", { ...f.connectInput, origin: "https://other.example" })
          .pipe(Effect.flip)).code,
      ).toBe("conflict");
      const metadata = yield* f.sql`SELECT * FROM shared_local_connections`;
      expect(encode(metadata)).not.toContain(f.connectInput.credential);
      expect(encode(metadata)).not.toContain("different-private-value");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "retains exact context and attributes publication to the saved broker-asserted agent",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const grant = yield* f.grants.register("remote-session", f.input);
        expect(
          yield* f.grants.register("remote-session", {
            ...f.input,
            actions: f.input.actions.toReversed(),
          }),
        ).toEqual(grant);
        expect(
          (yield* f.grants
            .register("remote-session", { ...f.input, label: "changed" })
            .pipe(Effect.flip)).code,
        ).toBe("conflict");
        const { actor } = yield* f.grants.authorize("remote-session", {
          delegationId: grant.delegationId,
          action: "activity.publish",
        });
        yield* f.store.putContext(
          { kind: "participant", participantId: f.owner.participantId },
          { ...f.context, objective: "A newer task revision" },
        );
        const published = yield* f.store.publishActivity(actor, f.activity);
        expect(published.author.kind).toBe("local_agent");
        expect(published.author.provenance).toMatchObject({
          kind: "participant_broker_assertion",
          ownerParticipantId: f.owner.participantId,
          localThreadId: "thread",
        });
        expect(published.context).toEqual(f.context);
        expect(published.context.participantId).toBe(f.owner.participantId);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("does not confirm a connection for a different remote identity", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const broker = yield* f.makeBroker({
        session: () =>
          Effect.succeed({
            ...f.connectInput.expected,
            participantId: "different-person",
            canContribute: true,
          }),
      });
      expect((yield* broker.connect("local-session", f.connectInput).pipe(Effect.flip)).code).toBe(
        "conflict",
      );
      expect(yield* broker.list("local-session")).toEqual([]);
      expect(
        yield* f.sql`SELECT connection_id FROM shared_local_connections WHERE definition_json IS NOT NULL`,
      ).toHaveLength(0);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("supplies the saved task context and revision without model context identifiers", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const broker = yield* f.makeBroker();
      const connection = yield* broker.connect("local-session", f.connectInput);
      const local = yield* broker.enable("local-session", {
        ...f.enableInput(connection.connectionId),
        actions: [...f.input.actions, "knowledge.record", "knowledge.supersede"],
      });
      // A newer task context must not change what this previously enabled grant publishes.
      yield* f.store.putContext(
        { kind: "participant", participantId: f.owner.participantId },
        {
          ...f.context,
          objective: "Changed objective",
          revision: { ...f.context.revision, commit: "b".repeat(40) },
        },
      );
      const {
        contextId: _contextId,
        contextVersion: _contextVersion,
        revision: _revision,
        ...activity
      } = f.activity;
      const published = yield* broker.invoke({ ...f.invocation, arguments: activity });
      expect(published).toMatchObject({ context: f.context, revision: f.context.revision });
      for (const action of [
        "specialists.send",
        "knowledge.record",
        "knowledge.supersede",
      ] as const) {
        yield* broker.invoke({ ...f.invocation, action, arguments: { content: "An observation" } });
        expect(f.invocations.at(-1)).toEqual({
          delegationId: local.grant!.delegationId,
          action,
          arguments: {
            content: "An observation",
            contextId: f.context.contextId,
            contextVersion: f.context.contextVersion,
            ...(action === "specialists.send" ? {} : { revision: f.context.revision }),
          },
        });
      }
      const count = f.invocations.length;
      for (const action of [
        "specialists.send",
        "activity.publish",
        "knowledge.record",
        "knowledge.supersede",
      ] as const) {
        for (const arguments_ of [
          { contextId: "other-context" },
          { contextVersion: "other-version" },
        ])
          expect(
            (yield* broker
              .invoke({ ...f.invocation, action, arguments: arguments_ })
              .pipe(Effect.asVoid, Effect.flip)).code,
          ).toBe("forbidden");
        if (action !== "specialists.send")
          expect(
            (yield* broker
              .invoke({
                ...f.invocation,
                action,
                arguments: { revision: { ...f.context.revision, commit: "b".repeat(40) } },
              })
              .pipe(Effect.asVoid, Effect.flip)).code,
          ).toBe("forbidden");
      }
      expect(f.invocations).toHaveLength(count);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("rejects cross-owner grants, another task binding and ungranted actions", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      expect((yield* f.grants.register("other-session", f.input).pipe(Effect.flip)).code).toBe(
        "forbidden",
      );
      expect(
        (yield* f.grants
          .register("remote-session", {
            ...f.input,
            binding: { ...f.input.binding, threadId: ThreadId.make("other") },
          })
          .pipe(Effect.flip)).code,
      ).toBe("forbidden");
      const grant = yield* f.grants.register("remote-session", f.input);
      expect(
        (yield* f.grants
          .authorize("other-session", {
            delegationId: grant.delegationId,
            action: "activity.publish",
          })
          .pipe(Effect.flip)).code,
      ).toBe("forbidden");
      expect(
        (yield* f.grants
          .authorize("remote-session", {
            delegationId: grant.delegationId,
            action: "knowledge.record",
          })
          .pipe(Effect.flip)).code,
      ).toBe("forbidden");
      const { actor } = yield* f.grants.authorize("remote-session", {
        delegationId: grant.delegationId,
        action: "inbox.list",
      });
      expect((yield* f.store.publishActivity(actor, f.activity).pipe(Effect.flip)).code).toBe(
        "forbidden",
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("revalidates revocation even for an already retained activity retry", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const grant = yield* f.grants.register("remote-session", f.input);
      const { actor } = yield* f.grants.authorize("remote-session", {
        delegationId: grant.delegationId,
        action: "activity.publish",
      });
      yield* f.store.publishActivity(actor, f.activity);
      yield* f.grants.revoke("remote-session", { delegationId: grant.delegationId });
      expect((yield* f.store.publishActivity(actor, f.activity).pipe(Effect.flip)).code).toBe(
        "forbidden",
      );
      expect((yield* f.grants.register("remote-session", f.input)).revokedAt).not.toBeNull();
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("honors expiry and parent-session revocation without reauthorizing the model", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const grant = yield* f.grants.register("remote-session", f.input);
      yield* TestClock.adjust("11 minutes");
      expect(
        (yield* f.grants
          .authorize("remote-session", {
            delegationId: grant.delegationId,
            action: "activity.publish",
          })
          .pipe(Effect.flip)).code,
      ).toBe("forbidden");
      yield* f.sql`UPDATE auth_sessions SET revoked_at=issued_at WHERE session_id='remote-session'`;
      expect(
        (yield* f.grants
          .register("remote-session", { ...f.input, requestId: "next" })
          .pipe(Effect.flip)).code,
      ).toBe("forbidden");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "keeps credentials private and resolves the current native session before dispatch",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const broker = yield* f.makeBroker();
        const connection = yield* broker.connect("local-session", f.connectInput);
        const local = yield* broker.enable("local-session", f.enableInput(connection.connectionId));
        const published = yield* broker.invoke(f.invocation);
        expect(published).toMatchObject({
          author: { kind: "local_agent", participantId: local.grant!.delegationId },
        });
        const rows =
          yield* f.sql`SELECT definition_json FROM shared_local_connections UNION ALL SELECT registration_json FROM shared_local_delegations UNION ALL SELECT definition_json FROM shared_local_delegations`;
        expect(encode(rows)).not.toContain(f.connectInput.credential);
        expect(encode([connection, local, yield* broker.list("local-session")])).not.toContain(
          f.connectInput.credential,
        );
        expect(f.secretValues.size).toBe(1);
        f.changeBinding();
        expect(
          (yield* broker
            .invoke({
              ...f.invocation,
              arguments: {
                ...f.invocation.arguments,
                delegationId: local.grant!.delegationId,
                sessionId: "replacement-session",
              },
            })
            .pipe(Effect.asVoid, Effect.flip)).code,
        ).toBe("forbidden");
        expect(f.invocations).toHaveLength(1);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("recovers an uncertain registration by its same ID across broker restart", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let loseReply = true;
      const broker = yield* f.makeBroker({
        register: (_, raw) =>
          Effect.gen(function* () {
            f.registrations.push(raw);
            const grant = yield* f.grants.register("remote-session", raw);
            if (loseReply) {
              loseReply = false;
              return yield* new SharedWorkspaceError({
                code: "unavailable",
                message: f.connectInput.credential,
              });
            }
            return grant;
          }),
      });
      const connection = yield* broker.connect("local-session", f.connectInput);
      const failure = yield* broker
        .enable("local-session", f.enableInput(connection.connectionId))
        .pipe(Effect.flip);
      expect(failure.message).not.toContain(f.connectInput.credential);
      const restarted = yield* f.makeBroker();
      const local = yield* restarted.enable(
        "local-session",
        f.enableInput(connection.connectionId),
      );
      expect(local.grant).not.toBeNull();
      expect(new Set(f.registrations.map((value) => value.requestId)).size).toBe(1);
      expect(yield* f.sql`SELECT delegation_id FROM shared_delegations`).toHaveLength(1);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("stops dispatch when revocation happens during fresh native observation", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let block = false;
      const broker = yield* f.makeBroker({}, () =>
        Effect.gen(function* () {
          if (block) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
          return f.input.binding;
        }),
      );
      const connection = yield* broker.connect("local-session", f.connectInput);
      const local = yield* broker.enable("local-session", f.enableInput(connection.connectionId));
      block = true;
      const pending = yield* broker
        .invoke(f.invocation)
        .pipe(Effect.asVoid, Effect.flip, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* broker.revoke("local-session", local.localId);
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(pending)).code).toBe("forbidden");
      expect(f.invocations).toHaveLength(0);
      yield* broker.disconnect("local-session", connection.connectionId);
      yield* broker.disconnect("local-session", connection.connectionId);
      expect(f.secretValues.size).toBe(0);
      expect((yield* broker.connect("local-session", f.connectInput).pipe(Effect.flip)).code).toBe(
        "forbidden",
      );
      expect(f.secretValues.size).toBe(0);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "requires explicit consent and refuses credential-bearing or insecure remote URLs",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const broker = yield* f.makeBroker();
        expect(
          (yield* broker
            .connect("local-session", { ...f.connectInput, consent: false } as never)
            .pipe(Effect.flip)).code,
        ).toBe("invalid_input");
        for (const origin of [
          "http://remote.example",
          "https://user:password@shared.example",
          "https://shared.example/path",
          "https://shared.example/?token=secret",
        ])
          expect((yield* sharedConnectionOrigin(origin).pipe(Effect.flip)).code).toBe(
            "invalid_input",
          );
        expect(yield* sharedConnectionOrigin("http://127.0.0.1:3000")).toBe(
          "http://127.0.0.1:3000",
        );
        expect(f.secretValues.size).toBe(0);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});

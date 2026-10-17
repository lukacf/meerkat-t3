import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type SharedLocalConnection,
  type SharedLocalDelegation,
  type SharedWorkContext,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  assertTaskAccessSession,
  clearCanceledTaskSetup,
  clearRemovedTaskAccount,
  enableTaskAccess,
  readTaskAccess,
  saveTaskAccess,
  startNewTaskAccessRequest,
  taskAccessAttemptExpired,
  taskAccessExpiry,
  taskAccessStatus,
  type TaskAccessSetup,
} from "./sharedTaskAccessState";

const now = "2026-10-17T12:00:00.000Z";
function fixture(): TaskAccessSetup {
  return {
    scope: {
      localEnvironmentId: EnvironmentId.make("local"),
      localProjectId: ProjectId.make("catalog"),
      localConnectionKey: "local",
      hostEnvironmentId: EnvironmentId.make("host"),
      hostConnectionKey: "paired-host",
      workspaceId: "workspace",
      participantId: "alice",
      checkoutId: "checkout",
      sharedProjectId: "catalog-shared",
    },
    connectionRequestId: "connect-request",
    connectionLabel: "Product",
    origin: "https://shared.example",
    connection: null,
    attempt: {
      requestId: "grant-request",
      threadId: ThreadId.make("task"),
      label: "Catalog task",
      context: {
        contextId: "context",
        checkoutId: "checkout",
        source: { kind: "thread", threadId: ThreadId.make("task") },
        objective: "Review catalog transactions",
        revision: { branch: "feature/catalog", commit: "a".repeat(40), applicability: "branch" },
        paths: [],
        tags: [],
      },
      contextVersion: null,
      actions: ["specialists.send", "specialists.request"],
      expiresAt: "2026-10-17T13:00:00.000Z",
      result: null,
    },
  };
}
function connection(): SharedLocalConnection {
  return {
    connectionId: "local-account",
    requestId: "connect-request",
    label: "Product",
    origin: "https://shared.example",
    environmentId: EnvironmentId.make("host"),
    workspaceId: "workspace",
    participantId: "alice",
    createdAt: now,
    revokedAt: null,
  };
}
function context(setup = fixture()): SharedWorkContext {
  return {
    ...setup.attempt!.context,
    contextVersion: "version-one",
    participantId: "alice",
    sharedProjectId: "catalog-shared",
    updatedAt: now,
  };
}
function result(setup = fixture()): SharedLocalDelegation {
  return {
    localId: "local-grant",
    connectionId: "local-account",
    threadId: ThreadId.make("task"),
    revokedAt: null,
    grant: {
      delegationId: "remote-grant",
      ownerParticipantId: "alice",
      participant: {
        participantId: "task-actor",
        displayName: "Catalog task",
        kind: "local_agent",
        createdAt: now,
      },
      binding: {
        environmentId: EnvironmentId.make("local"),
        projectId: ProjectId.make("catalog"),
        threadId: ThreadId.make("task"),
        instanceId: ProviderInstanceId.make("meerkat"),
        mobId: "mob",
        sessionId: "session",
      },
      context: context(setup),
      actions: setup.attempt!.actions,
      expiresAt: setup.attempt!.expiresAt,
      createdAt: now,
      revokedAt: null,
    },
  };
}
function harness() {
  let saved = fixture();
  const actions = {
    persist: vi.fn((value: TaskAccessSetup) => {
      saved = value;
      return true;
    }),
    putContext: vi.fn(async () => context()),
    createConnection: vi.fn(async () => connection()),
    enable: vi.fn(async () => result()),
  };
  return { actions, saved: () => saved };
}
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("personal shared task access", () => {
  it("binds a retained context and exact native task before granting access", async () => {
    const { actions } = harness();
    const saved = await enableTaskAccess(fixture(), actions);
    expect(actions.createConnection).toHaveBeenCalledExactlyOnceWith({
      requestId: "connect-request",
      label: "Product",
      origin: "https://shared.example",
      expected: { environmentId: "host", workspaceId: "workspace", participantId: "alice" },
      consent: true,
    });
    expect(actions.enable).toHaveBeenCalledExactlyOnceWith({
      connectionId: "local-account",
      requestId: "grant-request",
      threadId: "task",
      label: "Catalog task",
      contextId: "context",
      contextVersion: "version-one",
      actions: ["specialists.send", "specialists.request"],
      expiresAt: "2026-10-17T13:00:00.000Z",
    });
    expect(saved.attempt?.result?.grant?.delegationId).toBe("remote-grant");
    expect(JSON.stringify(saved)).not.toContain("credential");
  });
  it("recovers a lost connection response using its original ID and immutable context", async () => {
    const { actions, saved } = harness();
    actions.createConnection.mockRejectedValueOnce(new Error("response lost"));
    await expect(enableTaskAccess(fixture(), actions)).rejects.toThrow("response lost");
    expect(saved().attempt?.contextVersion).toBe("version-one");
    await enableTaskAccess(saved(), actions);
    expect(actions.putContext).toHaveBeenCalledTimes(1);
    expect(actions.createConnection.mock.calls[0]).toEqual(actions.createConnection.mock.calls[1]);
  });
  it("retries an uncertain grant without extending its expiry or changing its request", async () => {
    const { actions, saved } = harness();
    actions.enable.mockRejectedValueOnce(new Error("grant response lost"));
    await expect(enableTaskAccess(fixture(), actions)).rejects.toThrow("grant response lost");
    await enableTaskAccess(saved(), actions);
    expect(actions.createConnection).toHaveBeenCalledTimes(1);
    expect(actions.enable.mock.calls[0]).toEqual(actions.enable.mock.calls[1]);
  });
  it("does not forward a credential or enable access when durable state cannot be saved", async () => {
    const { actions } = harness();
    actions.persist.mockReturnValue(false);
    await expect(enableTaskAccess(fixture(), actions)).rejects.toThrow("could not be saved");
    expect(actions.putContext).not.toHaveBeenCalled();
    expect(actions.createConnection).not.toHaveBeenCalled();
    expect(actions.enable).not.toHaveBeenCalled();
  });
  it("stops after a context-binding persistence failure", async () => {
    const { actions } = harness();
    actions.persist.mockReturnValueOnce(true).mockReturnValue(false);
    await expect(enableTaskAccess(fixture(), actions)).rejects.toThrow("could not be saved");
    expect(actions.createConnection).not.toHaveBeenCalled();
  });
  it("rejects a context from another revision, actor, or shared project", async () => {
    for (const change of [
      { participantId: "bob" },
      { sharedProjectId: "payments" },
      { revision: { ...context().revision, commit: "b".repeat(40) } },
    ]) {
      const { actions } = harness();
      actions.putContext.mockResolvedValue({ ...context(), ...change });
      await expect(enableTaskAccess(fixture(), actions)).rejects.toThrow("different task context");
      expect(actions.createConnection).not.toHaveBeenCalled();
    }
  });
  it("rejects a different remote identity before enabling", async () => {
    const { actions } = harness();
    actions.createConnection.mockResolvedValue({ ...connection(), participantId: "bob" });
    await expect(enableTaskAccess(fixture(), actions)).rejects.toThrow("different or disabled");
    expect(actions.enable).not.toHaveBeenCalled();
  });
  it("rejects a widened or rebound returned grant", async () => {
    const { actions } = harness();
    const granted = result();
    actions.enable.mockResolvedValue({
      ...granted,
      grant: { ...granted.grant!, actions: ["knowledge.record"] },
    });
    await expect(enableTaskAccess(fixture(), actions)).rejects.toThrow(
      "differ from the saved request",
    );
  });
  it("retains an unconfirmed grant as retryable, without reporting success", async () => {
    const { actions } = harness();
    actions.enable.mockResolvedValue({ ...result(), grant: null });
    const saved = await enableTaskAccess(fixture(), actions);
    expect(saved.attempt?.result).toBeNull();
    expect(saved.attempt?.requestId).toBe("grant-request");
    expect(taskAccessStatus({ ...result(), grant: null }, Date.parse(now))).toBe(
      "Awaiting confirmation",
    );
  });
  it("prevents another tab from replacing or widening a pending request", () => {
    const setup = fixture();
    expect(saveTaskAccess(setup)).toBe(true);
    expect(saveTaskAccess({ ...setup, attempt: null })).toBe(false);
    expect(
      saveTaskAccess({ ...setup, attempt: { ...setup.attempt!, actions: ["knowledge.record"] } }),
    ).toBe(false);
    expect(
      saveTaskAccess({ ...setup, attempt: { ...setup.attempt!, contextVersion: "version-one" } }),
    ).toBe(true);
    expect(
      saveTaskAccess({ ...setup, attempt: { ...setup.attempt!, contextVersion: "version-two" } }),
    ).toBe(false);
    expect(readTaskAccess(setup.scope)?.attempt?.contextVersion).toBe("version-one");
  });
  it("caps grants to the paired account expiry and rejects changed accounts", () => {
    expect(taskAccessExpiry("2026-10-17T18:00:00.000Z", Date.parse(now))).toBe(
      "2026-10-17T13:00:00.000Z",
    );
    expect(taskAccessExpiry("2026-10-17T12:20:00.000Z", Date.parse(now))).toBe(
      "2026-10-17T12:20:00.000Z",
    );
    expect(() => taskAccessExpiry(now, Date.parse(now))).toThrow("expired");
    expect(() =>
      assertTaskAccessSession(fixture().scope, {
        environmentId: EnvironmentId.make("host"),
        workspaceId: "other",
        participantId: "alice",
        canContribute: true,
        expiresAt: now,
      }),
    ).toThrow("account has changed");
  });
  it("starts a new expired request without deleting the account or allowing stale-tab resurrection", () => {
    const setup = { ...fixture(), connection: connection() };
    expect(saveTaskAccess(setup)).toBe(true);
    const next = startNewTaskAccessRequest(setup, Date.parse("2026-10-17T14:00:00.000Z"));
    expect(next).toMatchObject({ connection: connection(), attempt: null, requestGeneration: 1 });
    expect(readTaskAccess(setup.scope)?.connection?.revokedAt).toBeNull();
    expect(saveTaskAccess(setup)).toBe(false);
    const newRequest = {
      ...next!,
      attempt: { ...setup.attempt!, requestId: "new-request" },
    };
    expect(saveTaskAccess(newRequest)).toBe(true);
    expect(startNewTaskAccessRequest(setup, Date.parse("2026-10-17T14:00:00.000Z"))).toBeNull();
    expect(readTaskAccess(setup.scope)?.attempt?.requestId).toBe("new-request");
  });
  it("keeps an unexpired, canceled, or newly confirmed attempt unchanged", () => {
    const setup = fixture();
    expect(saveTaskAccess(setup)).toBe(true);
    expect(startNewTaskAccessRequest(setup, Date.parse(now))).toBeNull();
    for (const expiresAt of ["invalid", "2025", "2026-10-17T11:00:00"])
      expect(taskAccessAttemptExpired({ ...setup.attempt!, expiresAt }, Date.parse(now))).toBe(
        false,
      );
    const confirmed = { ...setup, attempt: { ...setup.attempt!, result: result() } };
    expect(saveTaskAccess(confirmed)).toBe(true);
    expect(startNewTaskAccessRequest(setup, Date.parse("2026-10-17T14:00:00.000Z"))).toBeNull();
    expect(startNewTaskAccessRequest(confirmed, Date.parse("2026-10-17T14:00:00.000Z"))).toBeNull();
    const canceled = { ...confirmed, cancelRequested: true as const };
    expect(saveTaskAccess(canceled)).toBe(true);
    expect(startNewTaskAccessRequest(canceled, Date.parse("2026-10-17T14:00:00.000Z"))).toBeNull();
    expect(readTaskAccess(setup.scope)).toEqual(canceled);
  });
  it("keeps the original expired request when its reset cannot be saved", () => {
    const setup = fixture();
    expect(saveTaskAccess(setup)).toBe(true);
    const storage = localStorage;
    vi.stubGlobal("localStorage", {
      ...storage,
      setItem: () => {
        throw new Error("disk full");
      },
    });
    expect(startNewTaskAccessRequest(setup, Date.parse("2026-10-17T14:00:00.000Z"))).toBeNull();
    expect(readTaskAccess(setup.scope)?.attempt?.requestId).toBe(setup.attempt!.requestId);
  });
  it("distinguishes local blocking, confirmed revocation, and expiry", () => {
    const row = result();
    expect(taskAccessStatus({ ...row, revokedAt: now }, Date.parse(now))).toBe(
      "Blocked locally; remote confirmation pending",
    );
    expect(
      taskAccessStatus(
        { ...row, revokedAt: now, grant: { ...row.grant!, revokedAt: now } },
        Date.parse(now),
      ),
    ).toBe("Revoked");
    expect(taskAccessStatus(row, Date.parse("2026-10-17T14:00:00.000Z"))).toBe("Expired");
  });
  it("recovers cleanup after a lost creation response only by its original request ID", () => {
    const setup = fixture();
    expect(saveTaskAccess(setup)).toBe(true);
    const removed = { ...connection(), revokedAt: now, remoteRevocation: "unconfirmed" as const };
    expect(
      clearRemovedTaskAccount(setup.scope, { ...removed, requestId: "another-create-request" }),
    ).toBe(false);
    expect(clearRemovedTaskAccount(setup.scope, removed)).toBe(true);
    expect(readTaskAccess(setup.scope)).toBeNull();
  });
  it("clears recovery state only for the exact removed backend account", () => {
    const setup = { ...fixture(), connection: connection() };
    expect(saveTaskAccess(setup)).toBe(true);
    expect(clearRemovedTaskAccount(setup.scope, connection())).toBe(false);
    const removed = { ...connection(), revokedAt: now, remoteRevocation: "unconfirmed" as const };
    expect(
      clearRemovedTaskAccount(setup.scope, { ...removed, connectionId: "other-account" }),
    ).toBe(false);
    expect(clearRemovedTaskAccount(setup.scope, removed)).toBe(true);
    expect(readTaskAccess(setup.scope)).toBeNull();
  });
  it("retains cancellation intent and prevents another tab from retrying creation", async () => {
    const setup = fixture();
    const canceled = { ...setup, cancelRequested: true as const };
    expect(saveTaskAccess(canceled)).toBe(true);
    expect(saveTaskAccess(setup)).toBe(false);
    const { actions } = harness();
    await expect(enableTaskAccess(canceled, actions)).rejects.toThrow("cancellation is pending");
    expect(actions.createConnection).not.toHaveBeenCalled();
    expect(actions.putContext).not.toHaveBeenCalled();
    expect(readTaskAccess(setup.scope)?.cancelRequested).toBe(true);
  });
  it("clears an unconfirmed setup only after cancellation of its exact creation request", () => {
    const setup = { ...fixture(), cancelRequested: true as const };
    expect(saveTaskAccess(setup)).toBe(true);
    const receipt = {
      canceled: true as const,
      requestId: setup.connectionRequestId,
      cleanup: null,
    };
    expect(clearCanceledTaskSetup(setup.scope, "other-request", receipt)).toBe(false);
    expect(
      clearCanceledTaskSetup(setup.scope, setup.connectionRequestId, {
        ...receipt,
        requestId: "other-request",
      }),
    ).toBe(false);
    expect(readTaskAccess(setup.scope)).not.toBeNull();
    expect(clearCanceledTaskSetup(setup.scope, setup.connectionRequestId, receipt)).toBe(true);
    expect(readTaskAccess(setup.scope)).toBeNull();
  });
  it("requires a full removal receipt if setup already has a confirmed connection", () => {
    const setup = { ...fixture(), connection: connection(), cancelRequested: true as const };
    expect(saveTaskAccess(setup)).toBe(true);
    const receipt = {
      canceled: true as const,
      requestId: setup.connectionRequestId,
      cleanup: null,
    };
    expect(clearCanceledTaskSetup(setup.scope, setup.connectionRequestId, receipt)).toBe(false);
    expect(
      clearCanceledTaskSetup(setup.scope, setup.connectionRequestId, {
        ...receipt,
        cleanup: {
          connection: { ...connection(), revokedAt: now, remoteRevocation: "unconfirmed" },
          remoteRevocation: "unconfirmed",
        },
      }),
    ).toBe(true);
    expect(readTaskAccess(setup.scope)).toBeNull();
  });
  it("keeps the canceled setup retryable if local recovery storage cannot be removed", () => {
    const setup = { ...fixture(), cancelRequested: true as const };
    expect(saveTaskAccess(setup)).toBe(true);
    const storage = localStorage;
    vi.stubGlobal("localStorage", {
      ...storage,
      removeItem: () => {
        throw new Error("unavailable");
      },
    });
    expect(
      clearCanceledTaskSetup(setup.scope, setup.connectionRequestId, {
        canceled: true,
        requestId: setup.connectionRequestId,
        cleanup: null,
      }),
    ).toBe(false);
    expect(readTaskAccess(setup.scope)?.cancelRequested).toBe(true);
  });
});

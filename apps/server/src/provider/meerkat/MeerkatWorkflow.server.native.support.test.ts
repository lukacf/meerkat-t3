import { MEERKAT_REQUIRED_METHODS } from "@t3tools/shared/meerkatRuntime";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  closeOwnedServer,
  fixtureTimeoutMs,
  ownedServerShutdownBudget,
  validateFixtureHealth,
} from "./MeerkatWorkflow.server.native.support.ts";

describe("owned fixture server shutdown", () => {
  afterEach(() => vi.useRealTimers());

  it("reserves the native gateway horizon and remaining server cleanup", () => {
    expect(ownedServerShutdownBudget(352_000)).toBe(397_000);
    expect(ownedServerShutdownBudget(1)).toBe(372_000);
    expect(ownedServerShutdownBudget(360_000)).toBe(405_000);
    expect(fixtureTimeoutMs(240_000)).toBe(1_205_000);
    expect(fixtureTimeoutMs(240_000, 1, false)).toBe(645_000);
    expect(fixtureTimeoutMs(300_000, 2)).toBe(1_670_000);
    expect(fixtureTimeoutMs(300_000, 2, false)).toBe(1_110_000);
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 360_001])
      expect(() => ownedServerShutdownBudget(invalid)).toThrow("native shutdown horizon");
  });

  it("keeps waiting beyond the former 30-second cutoff and accepts ordinary exit", async () => {
    vi.useFakeTimers();
    const exited = Promise.withResolvers<{ code: number | null; signal: null }>();
    const child = { pid: 123, exitCode: null, signalCode: null, kill: vi.fn(() => true) };
    const requested = vi.fn();
    const closed = closeOwnedServer(
      child,
      exited.promise,
      ownedServerShutdownBudget(352_000),
      requested,
    );
    const settled = vi.fn();
    void closed.then(settled);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(settled).not.toHaveBeenCalled();
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
    exited.resolve({ code: 130, signal: null });
    await expect(closed).resolves.toEqual({ code: 130, signal: null });
    expect(requested).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports expired cleanup without force-killing a still-owned process", async () => {
    vi.useFakeTimers();
    const exited = Promise.withResolvers<{ code: number | null; signal: null }>();
    const child = { pid: 123, exitCode: null, signalCode: null, kill: vi.fn(() => true) };
    const closed = closeOwnedServer(
      child,
      exited.promise,
      ownedServerShutdownBudget(352_000),
      vi.fn(),
    );
    const failure = expect(closed).rejects.toThrow("Deadline waiting for owned T3 server shutdown");
    await vi.advanceTimersByTimeAsync(397_000);
    await failure;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
    expect(child.exitCode).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not call a signal termination or unrelated failure a graceful shutdown", async () => {
    for (const stopped of [
      { code: null, signal: "SIGKILL" as const },
      { code: 1, signal: null },
      { code: 130, signal: null },
    ]) {
      const child = {
        pid: 123,
        exitCode: stopped.code,
        signalCode: stopped.signal,
        kill: vi.fn(() => true),
      };
      await expect(
        closeOwnedServer(child, Promise.resolve(stopped), 397_000, vi.fn()),
      ).rejects.toThrow("PID 123 exited without orderly cleanup");
      expect(child.kill).not.toHaveBeenCalled();
    }
  });

  it("does not signal an already-exited process", async () => {
    const child = { pid: 123, exitCode: 0, signalCode: null, kill: vi.fn(() => true) };
    const requested = vi.fn();
    await expect(
      closeOwnedServer(child, Promise.resolve({ code: 0, signal: null }), 397_000, requested),
    ).resolves.toEqual({ code: 0, signal: null });
    expect(child.kill).not.toHaveBeenCalled();
    expect(requested).not.toHaveBeenCalled();
  });
});

const laterAccountMethods = new Set<string>([
  "auth.v1.check",
  "auth.v1.configure",
  "auth.v1.deviceStart",
  "auth.v1.devicePoll",
  "auth.v1.delete",
  "auth.v1.default",
]);
const build = {
  gatewayVersion: "0.1.0",
  meerkatVersion: "0.8.51",
  mobkitVersion: "0.8.46",
  cargoLockSha256: "a".repeat(64),
  platform: "macos",
  arch: "aarch64",
};
const health = { ok: true, runtime: "mobkit", build };
const historicalCapabilities = {
  contractVersion: "pure-mobkit-runtime-v1",
  methods: MEERKAT_REQUIRED_METHODS.filter((method) => !laterAccountMethods.has(method)),
};
const historicalContract = "pre-account-auth-0.8.51-0.8.46";

describe("packaged predecessor fixture health", () => {
  it("accepts only the explicitly selected predecessor contract without later account methods", () => {
    expect(validateFixtureHealth(health, historicalCapabilities, historicalContract)).toEqual(
      build,
    );
    expect(() => validateFixtureHealth(health, historicalCapabilities)).toThrow(
      "missing required methods: auth.v1.check",
    );
  });

  it("keeps the current package account capabilities mandatory", () => {
    const current = {
      ...health,
      build: { ...build, meerkatVersion: "0.9.2", mobkitVersion: "0.9.2" },
    };
    expect(() => validateFixtureHealth(current, historicalCapabilities)).toThrow(
      "missing required methods: auth.v1.check",
    );
    expect(
      validateFixtureHealth(current, {
        ...historicalCapabilities,
        methods: [...MEERKAT_REQUIRED_METHODS],
      }),
    ).toEqual(current.build);
    expect(() =>
      validateFixtureHealth(current, historicalCapabilities, historicalContract),
    ).toThrow();
  });

  it("does not waive historical execution, receipt, image, or auth capabilities", () => {
    for (const omitted of [
      "mobs.v1.createThreadMob",
      "mobs.v1.consoleHistory",
      "mobs.v1.imageRead",
      "auth.v1.status",
    ]) {
      expect(() =>
        validateFixtureHealth(
          health,
          {
            ...historicalCapabilities,
            methods: historicalCapabilities.methods.filter((method) => method !== omitted),
          },
          historicalContract,
        ),
      ).toThrow(`missing required historical methods: ${omitted}`);
    }
  });

  it("rejects malformed identity and mismatched historical runtime tuples", () => {
    for (const invalid of [
      { ...health, ok: false },
      { ...health, runtime: "other" },
      { ...health, build: { ...build, meerkatVersion: "0.8.50" } },
      { ...health, build: { ...build, mobkitVersion: "0.8.47" } },
      { ...health, build: { ...build, cargoLockSha256: "not-a-lock-hash" } },
      { ...health, build: { ...build, gatewayVersion: "" } },
    ]) {
      expect(() =>
        validateFixtureHealth(invalid, historicalCapabilities, historicalContract),
      ).toThrow();
    }
    expect(() =>
      validateFixtureHealth(
        health,
        {
          ...historicalCapabilities,
          contractVersion: "unrelated-runtime",
        },
        historicalContract,
      ),
    ).toThrow();
  });
});

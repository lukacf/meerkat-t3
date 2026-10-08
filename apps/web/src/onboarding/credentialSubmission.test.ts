import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { attemptCredentialSetup, requireCredentialSetupReady } from "./credentialSubmission";

const variables = [{ name: "OPENAI_API_KEY", value: "test-key", sensitive: true }];
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("native"),
  driver: ProviderDriverKind.make("meerkat"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-04T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("credential provider check", () => {
  it.each([
    ["missing target", undefined],
    ["disabled instance", { ...provider, enabled: false }],
    ["disabled status", { ...provider, status: "disabled" as const }],
    ["unavailable runtime", { ...provider, availability: "unavailable" as const }],
    ["missing runtime", { ...provider, installed: false }],
    ["missing credentials", { ...provider, auth: { status: "unauthenticated" as const } }],
    ["failed check", { ...provider, status: "error" as const }],
    ["warning", { ...provider, status: "warning" as const }],
  ])("keeps %s retryable even when the refresh request succeeded", async (_, result) => {
    const save = vi.fn().mockResolvedValue(undefined);
    const check = () => requireCredentialSetupReady(result);
    const outcome = await attemptCredentialSetup({
      stage: "save",
      variables,
      save,
      check: async () => check(),
    });
    expect(outcome).toMatchObject({ ok: false, stage: "check" });
    expect(save).toHaveBeenCalledExactlyOnceWith(variables);
  });

  it("preserves the authoritative runtime diagnostic", () => {
    expect(() =>
      requireCredentialSetupReady({
        ...provider,
        status: "error",
        message: "The configured account requires sign-in again.",
      }),
    ).toThrow("The configured account requires sign-in again.");
    expect(() =>
      requireCredentialSetupReady({ ...provider, status: "error", message: " " }),
    ).toThrow("this provider is not ready");
  });

  it("accepts runtime readiness without inventing credential validation for host-managed auth", () => {
    expect(() => requireCredentialSetupReady(provider)).not.toThrow();
    expect(() =>
      requireCredentialSetupReady({ ...provider, auth: { status: "unknown" } }),
    ).not.toThrow();
  });
});

describe("credential setup retry", () => {
  it("retries the same in-memory input after a failed save", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("Computer disconnected"))
      .mockResolvedValue(undefined);
    const check = vi.fn().mockResolvedValue(undefined);
    const attempt = { variables, save, check };
    const failed = await attemptCredentialSetup({ ...attempt, stage: "save" });
    expect(failed).toEqual({ ok: false, stage: "save", message: "Computer disconnected" });
    expect(check).not.toHaveBeenCalled();
    if (failed.ok) throw new Error("Expected a failed save");
    expect(await attemptCredentialSetup({ ...attempt, stage: failed.stage })).toEqual({ ok: true });
    expect(save.mock.calls).toEqual([[variables], [variables]]);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("retries only the check after credentials were saved successfully", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const check = vi
      .fn()
      .mockRejectedValueOnce(new Error("Probe timed out"))
      .mockResolvedValue(undefined);
    const attempt = { variables, save, check };
    const failed = await attemptCredentialSetup({ ...attempt, stage: "save" });
    expect(failed).toEqual({ ok: false, stage: "check", message: "Probe timed out" });
    if (failed.ok) throw new Error("Expected a failed check");
    expect(await attemptCredentialSetup({ ...attempt, stage: failed.stage })).toEqual({ ok: true });
    expect(save).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(2);
    expect(failed).not.toHaveProperty("variables");
  });
});

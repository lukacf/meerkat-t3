import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { RuntimeMode } from "@t3tools/contracts";
import { executionModeError, executionModesForProvider } from "@t3tools/shared/executionModes";
import { meerkatExecutionModeError, validateMeerkatAccessMode } from "./MeerkatExecutionModes.ts";

const decodeRuntimeMode = Schema.decodeSync(Schema.fromJsonString(RuntimeMode));

describe("native execution mode admission", () => {
  it("round-trips the read-only mode through saved contracts", () => {
    expect(decodeRuntimeMode('"read-only"')).toBe("read-only");
    expect(executionModesForProvider("meerkat")).toEqual([
      "read-only",
      "approval-required",
      "full-access",
    ]);
  });
  it("admits only enforced Meerkat modes with matching explicit policies", () => {
    expect(
      meerkatExecutionModeError({
        runtimeMode: "read-only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
      }),
    ).toBeNull();
    expect(meerkatExecutionModeError({ runtimeMode: "full-access" })).toBeNull();
    expect(meerkatExecutionModeError({ runtimeMode: "approval-required" })).toBeNull();
    expect(
      meerkatExecutionModeError({
        runtimeMode: "approval-required",
        approvalPolicy: "untrusted",
        sandboxMode: "danger-full-access",
      }),
    ).toBeNull();
    expect(
      meerkatExecutionModeError({ runtimeMode: "approval-required", approvalPolicy: "never" }),
    ).toContain("does not match");
    expect(
      meerkatExecutionModeError({
        runtimeMode: "approval-required",
        sandboxMode: "workspace-write",
      }),
    ).toContain("does not match");
    for (const runtimeMode of ["auto", "auto-accept-edits"] as const) {
      expect(meerkatExecutionModeError({ runtimeMode })).toContain("supported access mode");
    }
    expect(
      meerkatExecutionModeError({ runtimeMode: "read-only", approvalPolicy: "on-request" }),
    ).toContain("approval");
    expect(
      meerkatExecutionModeError({ runtimeMode: "read-only", sandboxMode: "danger-full-access" }),
    ).toContain("does not match");
  });
  it("requires a native confirmation, including reconnect and old binaries", () => {
    expect(() => validateMeerkatAccessMode("read-only", { accessMode: "read-only" })).not.toThrow();
    expect(() =>
      validateMeerkatAccessMode("approval-required", { accessMode: "approval-required" }),
    ).not.toThrow();
    expect(() =>
      validateMeerkatAccessMode("approval-required", { accessMode: "full-access" }),
    ).toThrow("No message was sent");
    expect(() =>
      validateMeerkatAccessMode("full-access", { accessMode: "full-access" }),
    ).not.toThrow();
    expect(() => validateMeerkatAccessMode("read-only", { accessMode: "full-access" })).toThrow(
      "No message was sent",
    );
    expect(() => validateMeerkatAccessMode("read-only", {})).toThrow("did not confirm");
    expect(() => validateMeerkatAccessMode("full-access", { accessMode: "read-only" })).toThrow();
  });
  it("never passes a Meerkat-only mode into a donor adapter's permissive default", () => {
    for (const provider of [
      "codex",
      "claude",
      "cursor",
      "grok",
      "opencode",
      "antigravity",
    ] as const) {
      expect(executionModeError(provider, "read-only")).toContain("supported access mode");
      expect(executionModeError(provider, "full-access")).toBeNull();
    }
  });
});

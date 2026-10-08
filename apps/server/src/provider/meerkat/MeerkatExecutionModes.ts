import type { ProviderSessionStartInput, RuntimeMode } from "@t3tools/contracts";
import { executionModeError } from "@t3tools/shared/executionModes";

export function meerkatExecutionModeError(
  input: Pick<ProviderSessionStartInput, "runtimeMode" | "approvalPolicy" | "sandboxMode">,
): string | null {
  const unsupported = executionModeError("meerkat", input.runtimeMode);
  if (unsupported) return unsupported;
  const approvalPolicy = input.runtimeMode === "approval-required" ? "untrusted" : "never";
  if (input.approvalPolicy && input.approvalPolicy !== approvalPolicy) {
    return "The explicit approval policy does not match this native access mode. Supervised Meerkat conversations ask before every tool call.";
  }
  const sandboxMode = input.runtimeMode === "read-only" ? "read-only" : "danger-full-access";
  if (input.sandboxMode && input.sandboxMode !== sandboxMode) {
    return "The sandbox choice does not match this conversation's native access mode.";
  }
  return null;
}

/** A native response is required before the app may claim access enforcement. */
export function validateMeerkatAccessMode(requested: RuntimeMode, response: unknown): void {
  const mode =
    typeof response === "object" && response !== null && "accessMode" in response
      ? response.accessMode
      : undefined;
  if (mode !== requested) {
    throw new Error(
      "The native runtime did not confirm the requested access mode. No message was sent.",
    );
  }
}

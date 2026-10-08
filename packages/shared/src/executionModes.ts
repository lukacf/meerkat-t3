import type { RuntimeMode } from "@t3tools/contracts";

export const MEERKAT_EXECUTION_MODES = ["read-only", "approval-required", "full-access"] as const;
export const DONOR_EXECUTION_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const;

export function executionModesForProvider(provider: string): readonly RuntimeMode[] {
  return provider === "meerkat" ? MEERKAT_EXECUTION_MODES : DONOR_EXECUTION_MODES;
}

/** Fail before adapter dispatch; no unsupported provider may fall back to full access. */
export function executionModeError(provider: string, mode: RuntimeMode): string | null {
  if (executionModesForProvider(provider).includes(mode)) return null;
  return provider === "meerkat"
    ? "Meerkat supports Read-only, Supervised and Full access. Choose a supported access mode."
    : "Read-only access is supported by Meerkat. Choose a supported access mode for this provider.";
}

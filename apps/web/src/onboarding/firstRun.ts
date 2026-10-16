import type { OnboardingProgress } from "@t3tools/contracts/settings";
import { useCallback } from "react";

import { ensureClientSettingsHydrated, persistClientSettingsUpdate } from "../hooks/useSettings";

/**
 * Marks first-run onboarding finished (or skipped) so FirstRunGate never
 * routes to the welcome wizard again. The gate itself lives in
 * `components/onboarding/FirstRunGate.tsx`.
 */
export function useCompleteOnboarding(): () => Promise<void> {
  return useCallback(async () => {
    await ensureClientSettingsHydrated();
    const onboardingCompletedAt = new Date().toISOString();
    await persistClientSettingsUpdate((current) => ({
      ...current,
      onboardingCompletedAt,
      onboardingProgress: null,
    }));
  }, []);
}

/** One persisted record owns the setup journey, including specialist setup or a saved legacy first task. */
export async function saveOnboardingProgress(progress: OnboardingProgress): Promise<void> {
  await ensureClientSettingsHydrated();
  await persistClientSettingsUpdate((current) => ({
    ...current,
    onboardingCompletedAt: null,
    onboardingProgress: progress,
  }));
}

import type { OnboardingProgress } from "@t3tools/contracts/settings";

export interface FirstTaskEvidence {
  readonly environmentId: string;
  readonly projectId: string;
  readonly threadId: string | null;
  readonly latestTurn: {
    readonly state: string;
    readonly requestedAt: string;
    readonly assistantMessageId: string | null;
  } | null;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
    readonly streaming?: boolean;
  }>;
}

/** Imported history, failed turns and unrelated threads cannot complete setup. */
export function isFirstTaskLocation(
  progress: OnboardingProgress,
  evidence: Pick<FirstTaskEvidence, "environmentId" | "projectId" | "threadId">,
): boolean {
  return (
    progress.step === "first-task" &&
    evidence.threadId !== null &&
    progress.projectRef?.environmentId === evidence.environmentId &&
    progress.projectRef?.projectId === evidence.projectId &&
    progress.threadId !== null &&
    progress.threadId === evidence.threadId
  );
}

export function isOnboardingTask(
  progress: OnboardingProgress,
  evidence: FirstTaskEvidence,
): boolean {
  return isFirstTaskLocation(progress, evidence) && evidence.latestTurn !== null;
}

export function hasSuccessfulFirstReply(
  progress: OnboardingProgress,
  evidence: FirstTaskEvidence,
): boolean {
  if (!isOnboardingTask(progress, evidence) || evidence.latestTurn?.state !== "completed")
    return false;
  return evidence.messages.some(
    (message) =>
      message.id === evidence.latestTurn?.assistantMessageId &&
      message.role === "assistant" &&
      !message.streaming &&
      message.text.trim().length > 0,
  );
}

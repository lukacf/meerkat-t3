import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type OnboardingProgress,
} from "@t3tools/contracts/settings";
const persistence = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
}));
vi.mock("~/localApi", () => ({ ensureLocalApi: () => ({ persistence }) }));
import { saveOnboardingProgress } from "./firstRun";
import { __resetClientSettingsPersistenceForTests, getClientSettings } from "../hooks/useSettings";
const progress: OnboardingProgress = {
  step: "agents",
  environmentIds: [EnvironmentId.make("computer")],
  startedAt: "2026-10-04T10:00:00.000Z",
  projectRef: null,
  threadId: null,
};
beforeEach(() => {
  persistence.getClientSettings.mockReset().mockResolvedValue(null);
  persistence.setClientSettings.mockReset().mockResolvedValue(undefined);
  __resetClientSettingsPersistenceForTests();
});
afterEach(() => vi.restoreAllMocks());
describe("persisting the setup journey", () => {
  it("saves the resumable stage without completing setup or overwriting preferences", async () => {
    persistence.getClientSettings.mockResolvedValue({
      ...DEFAULT_CLIENT_SETTINGS,
      wordWrap: true,
      onboardingCompletedAt: "2026-10-01T10:00:00.000Z",
    });
    await saveOnboardingProgress(progress);
    expect(getClientSettings()).toMatchObject({
      wordWrap: true,
      onboardingCompletedAt: null,
      onboardingProgress: progress,
    });
    expect(persistence.setClientSettings).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        wordWrap: true,
        onboardingCompletedAt: null,
        onboardingProgress: progress,
      }),
    );
  });
  it("does not let a failed persistence operation appear to advance setup", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    persistence.setClientSettings.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(saveOnboardingProgress(progress)).rejects.toThrow("disk unavailable");
    expect(getClientSettings().onboardingProgress).toBeNull();
    expect(getClientSettings().onboardingCompletedAt).toBeNull();
  });
});

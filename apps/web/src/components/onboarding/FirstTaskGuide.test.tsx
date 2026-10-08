import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type OnboardingProgress,
} from "@t3tools/contracts/settings";

const persistence = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
}));
const navigation = vi.hoisted(() => ({
  navigate: vi.fn(),
  threads: [] as Array<{ environmentId: string; id: string }>,
  submissionPending: false,
}));
vi.mock("~/localApi", () => ({ ensureLocalApi: () => ({ persistence }) }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigation.navigate }));
vi.mock("../../state/entities", () => ({ useThreadShells: () => navigation.threads }));
vi.mock("../../composerDraftStore", () => ({
  useBackgroundDraftSubmissionPending: () => navigation.submissionPending,
}));
vi.mock("../ui/button", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<"button"> & { size?: string; variant?: string }) => <button {...props} />,
}));

import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  getClientSettings,
} from "../../hooks/useSettings";
import { FirstTaskGuide } from "./FirstTaskGuide";

const environmentId = EnvironmentId.make("computer");
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("first-task");
const progress: OnboardingProgress = {
  step: "first-task",
  environmentIds: [environmentId],
  startedAt: "2026-10-04T10:00:00.000Z",
  projectRef: { environmentId, projectId },
  threadId,
};
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  persistence.getClientSettings.mockReset().mockResolvedValue(null);
  persistence.setClientSettings.mockReset().mockResolvedValue(undefined);
  navigation.navigate.mockReset();
  navigation.threads = [];
  navigation.submissionPending = false;
  __resetClientSettingsPersistenceForTests();
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingProgress: progress,
    onboardingCompletedAt: null,
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  __resetClientSettingsPersistenceForTests();
  vi.unstubAllGlobals();
});

async function render(
  replied = false,
  overrides: Partial<ComponentProps<typeof FirstTaskGuide>> = {},
) {
  await act(async () => {
    const view = (
      <FirstTaskGuide
        environmentId={environmentId}
        projectId={projectId}
        threadId={threadId}
        isDraft={false}
        latestTurn={
          replied
            ? {
                state: "completed",
                requestedAt: "2026-10-04T10:01:00.000Z",
                assistantMessageId: "answer",
              }
            : null
        }
        messages={
          replied ? [{ id: "answer", role: "assistant", text: "This project contains..." }] : []
        }
        {...overrides}
      />
    );
    if (renderer) renderer.update(view);
    else renderer = create(view);
  });
}

async function click(label: string) {
  const button = renderer!.root
    .findAllByType("button")
    .find((item) => item.children.includes(label));
  expect(button, `Missing ${label} action`).toBeDefined();
  await act(async () => button!.props.onClick());
}

it("retries a failed skip before any reply and completes only after persistence succeeds", async () => {
  persistence.setClientSettings.mockRejectedValueOnce(new Error("disk unavailable"));
  await render();
  expect(persistence.setClientSettings).not.toHaveBeenCalled();

  await click("Skip setup");
  expect(getClientSettings().onboardingProgress).toEqual(progress);
  expect(getClientSettings().onboardingCompletedAt).toBeNull();
  expect(JSON.stringify(renderer!.toJSON())).toContain("Could not skip setup. Try again.");

  await click("Retry skipping setup");
  expect(persistence.setClientSettings).toHaveBeenCalledTimes(2);
  expect(getClientSettings().onboardingProgress).toBeNull();
  expect(getClientSettings().onboardingCompletedAt).not.toBeNull();
  expect(renderer!.toJSON()).toBeNull();
});

it("preserves a successful reply's setup progress after a failed save and retries that save", async () => {
  persistence.setClientSettings.mockRejectedValueOnce(new Error("disk unavailable"));
  await render(true);
  expect(persistence.setClientSettings).toHaveBeenCalledTimes(1);
  expect(getClientSettings().onboardingProgress).toEqual(progress);
  expect(getClientSettings().onboardingCompletedAt).toBeNull();
  expect(JSON.stringify(renderer!.toJSON())).toContain("Could not save setup progress. Try again.");
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("Saving setup...");

  await click("Retry saving setup");
  expect(persistence.setClientSettings).toHaveBeenCalledTimes(2);
  expect(getClientSettings().onboardingProgress).toBeNull();
  expect(getClientSettings().onboardingCompletedAt).not.toBeNull();
  expect(renderer!.toJSON()).toBeNull();
});

it("keeps the first task through background promotion before its server shell arrives", async () => {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingProgress: { ...progress, threadId: null },
    onboardingCompletedAt: null,
  });
  await render(false, { isDraft: true });
  expect(getClientSettings().onboardingProgress?.threadId).toBe(threadId);

  navigation.submissionPending = true;
  await render(false, { threadId: ThreadId.make("fresh-background-draft"), isDraft: true });
  expect(getClientSettings().onboardingProgress?.threadId).toBe(threadId);
  const waiting = renderer!.root
    .findAllByType("button")
    .find((button) => button.children.includes("Starting first task..."));
  expect(waiting?.props.disabled).toBe(true);

  // The RPC can settle before the thread projection reaches this client.
  navigation.submissionPending = false;
  await render(false, { threadId: ThreadId.make("fresh-background-draft"), isDraft: true });
  expect(getClientSettings().onboardingProgress?.threadId).toBe(threadId);
  expect(persistence.setClientSettings).toHaveBeenCalledTimes(1);

  navigation.threads = [{ environmentId, id: threadId }];
  await render(false, {
    latestTurn: {
      state: "error",
      requestedAt: "2026-10-04T10:01:00.000Z",
      assistantMessageId: null,
    },
  });
  expect(JSON.stringify(renderer!.toJSON())).toContain("Your first task");
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("Finish your setup");
  expect(getClientSettings().onboardingCompletedAt).toBeNull();

  await render(true);
  expect(getClientSettings().onboardingProgress).toBeNull();
  expect(getClientSettings().onboardingCompletedAt).not.toBeNull();
});

it("replaces a missing first task only by explicit choice after saving recovery", async () => {
  const replacement = ThreadId.make("replacement-first-task");
  await render(false, { threadId: ThreadId.make("unrelated-task") });
  expect(getClientSettings().onboardingProgress?.threadId).toBe(threadId);
  expect(persistence.setClientSettings).not.toHaveBeenCalled();

  persistence.setClientSettings.mockRejectedValueOnce(new Error("disk unavailable"));
  await click("Choose a new first task");
  expect(getClientSettings().onboardingProgress?.threadId).toBe(threadId);
  expect(navigation.navigate).not.toHaveBeenCalled();

  await click("Retry saving setup");
  expect(getClientSettings().onboardingProgress?.threadId).toBeNull();
  expect(navigation.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/projects/$projectId/start",
    params: { environmentId, projectId },
  });
  await render(false, { threadId: replacement, isDraft: true });
  expect(getClientSettings().onboardingProgress?.threadId).toBe(replacement);
  expect(getClientSettings().onboardingCompletedAt).toBeNull();
});

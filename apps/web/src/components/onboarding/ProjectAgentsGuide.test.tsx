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
const workspace = vi.hoisted(() => ({
  status: "live",
  threads: [] as Array<{ id: string; environmentId: string; projectId: string }>,
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => ({
    status: workspace.status,
    snapshot: { _id: "Option", _tag: "Some", value: { threads: workspace.threads } },
  }),
}));
vi.mock("../../state/shell", () => ({ environmentShell: { stateValueAtom: () => "shell" } }));
vi.mock("../../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () => ({
      status: workspace.status,
      snapshot: { _id: "Option", _tag: "Some", value: { threads: workspace.threads } },
    }),
  },
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("~/localApi", () => ({ ensureLocalApi: () => ({ persistence }) }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../ui/button", () => ({ Button: "button" }));
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  getClientSettings,
} from "../../hooks/useSettings";
import { ProjectAgentsGuide } from "./ProjectAgentsGuide";
const environmentId = EnvironmentId.make("remote");
const projectId = ProjectId.make("project");
const sourceThreadId = ThreadId.make("proposal-thread");
const progress: OnboardingProgress = {
  step: "project-agents",
  environmentIds: [environmentId],
  startedAt: "2026-10-08T12:00:00.000Z",
  projectRef: { environmentId, projectId },
  threadId: null,
};
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  persistence.getClientSettings.mockReset().mockResolvedValue(null);
  persistence.setClientSettings.mockReset().mockResolvedValue(undefined);
  navigate.mockReset();
  workspace.status = "live";
  workspace.threads = [{ id: "another-proposal", environmentId: "remote", projectId: "project" }];
  __resetClientSettingsPersistenceForTests();
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingProgress: progress,
    onboardingCompletedAt: null,
    wordWrap: true,
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  __resetClientSettingsPersistenceForTests();
  vi.unstubAllGlobals();
});
async function render(overrides: Partial<ComponentProps<typeof ProjectAgentsGuide>> = {}) {
  await act(async () => {
    const view = (
      <ProjectAgentsGuide
        environmentId={environmentId}
        projectId={projectId}
        sourceThreadId={sourceThreadId}
        {...overrides}
      />
    );
    if (renderer) renderer.update(view);
    else renderer = create(view);
  });
}
function button(label: string) {
  return renderer!.root.findAllByType("button").find((item) => item.children.includes(label));
}
async function click(label: string) {
  const item = button(label);
  expect(item).toBeDefined();
  expect(item!.props.disabled).not.toBe(true);
  await act(async () => item!.props.onClick());
}

it("saves the bound proposal for reload without treating a proposal reply as completion", async () => {
  await render();
  expect(getClientSettings().onboardingProgress).toEqual({ ...progress, threadId: sourceThreadId });
  expect(getClientSettings().onboardingCompletedAt).toBeNull();
  expect(button("Continue to specialists")).toBeUndefined();
  const saved = getClientSettings();
  act(() => renderer!.unmount());
  renderer = undefined;
  __resetClientSettingsPersistenceForTests();
  persistence.getClientSettings.mockResolvedValue(saved);
  await render();
  expect(getClientSettings().onboardingProgress).toEqual(saved.onboardingProgress);
  expect(navigate).not.toHaveBeenCalled();
});
it("continues only explicitly after applied assignments, preserving preparation and preferences", async () => {
  await render({ acceptedAgentId: "domain-owner", preparationLabel: "1 studying" });
  expect(getClientSettings().onboardingCompletedAt).toBeNull();
  await click("Continue to specialists");
  expect(getClientSettings()).toMatchObject({ onboardingProgress: null, wordWrap: true });
  expect(getClientSettings().onboardingCompletedAt).not.toBeNull();
  expect(navigate).toHaveBeenCalledWith({
    to: "/$environmentId/agents/$agentId",
    params: { environmentId, agentId: "domain-owner" },
    search: { project: projectId },
  });
});
it("keeps failed completion resumable and retries without another model submission", async () => {
  await render({ acceptedAgentId: "domain-owner" });
  persistence.setClientSettings.mockRejectedValueOnce(new Error("disk unavailable"));
  await click("Continue to specialists");
  expect(getClientSettings().onboardingCompletedAt).toBeNull();
  expect(getClientSettings().onboardingProgress?.threadId).toBe(sourceThreadId);
  expect(navigate).not.toHaveBeenCalled();
  await click("Retry");
  await click("Continue to specialists");
  expect(getClientSettings().onboardingProgress).toBeNull();
});
it("blocks completion while assignment observations need attention and allows explicit skip", async () => {
  await render({ acceptedAgentId: "domain-owner", blocked: true });
  expect(button("Continue to specialists")!.props.disabled).toBe(true);
  await click("Skip setup");
  expect(getClientSettings().onboardingProgress).toBeNull();
  expect(navigate).toHaveBeenCalledWith({
    to: "/$environmentId/projects/$projectId/start",
    params: { environmentId, projectId },
    search: {},
  });
});
it.each([
  { ...progress, step: "first-task" as const, threadId: ThreadId.make("legacy-task") },
  { ...progress, projectRef: { environmentId, projectId: ProjectId.make("other") } },
  { ...progress, threadId: ThreadId.make("another-proposal") },
])("does not claim legacy, other-project, or other-proposal work", async (other) => {
  __setClientSettingsForTests({ ...getClientSettings(), onboardingProgress: other });
  await render({ acceptedAgentId: "domain-owner" });
  expect(renderer!.toJSON()).toBeNull();
  expect(persistence.setClientSettings).not.toHaveBeenCalled();
  expect(getClientSettings().onboardingProgress).toEqual(other);
});
it("leaves setup intact when opening Help", async () => {
  await render();
  const saved = getClientSettings();
  await click("Help");
  expect(navigate).toHaveBeenCalledWith({ to: "/help", search: { topic: "agents" } });
  expect(getClientSettings()).toEqual(saved);
});
it("does not complete a newer journey that changes during a queued save", async () => {
  await render({ acceptedAgentId: "domain-owner" });
  let release!: () => void;
  persistence.setClientSettings.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  act(() => button("Continue to specialists")!.props.onClick());
  await act(async () => {
    await Promise.resolve();
    __setClientSettingsForTests({
      ...getClientSettings(),
      onboardingProgress: { ...progress, startedAt: "2026-10-08T13:00:00.000Z" },
    });
    release();
  });
  expect(getClientSettings().onboardingProgress?.startedAt).toBe("2026-10-08T13:00:00.000Z");
  expect(getClientSettings().onboardingCompletedAt).toBeNull();
  expect(navigate).not.toHaveBeenCalled();
});

it("rebinds a deleted saved setup thread to the authoritative proposal after shell hydration", async () => {
  const stale = { ...progress, threadId: ThreadId.make("deleted-proposal") };
  __setClientSettingsForTests({ ...getClientSettings(), onboardingProgress: stale });
  workspace.status = "synchronizing";
  await render();
  expect(getClientSettings().onboardingProgress).toEqual(stale);
  expect(persistence.setClientSettings).not.toHaveBeenCalled();
  workspace.status = "live";
  await render();
  expect(getClientSettings().onboardingProgress).toEqual({ ...stale, threadId: sourceThreadId });
  expect(getClientSettings().onboardingCompletedAt).toBeNull();
  expect(navigate).not.toHaveBeenCalled();
});

it.each(["empty", "cached", "synchronizing"])(
  "does not replace a saved thread from a %s shell",
  async (status) => {
    const saved = { ...progress, threadId: ThreadId.make("saved-proposal") };
    __setClientSettingsForTests({ ...getClientSettings(), onboardingProgress: saved });
    workspace.status = status;
    await render();
    expect(getClientSettings().onboardingProgress).toEqual(saved);
    expect(persistence.setClientSettings).not.toHaveBeenCalled();
  },
);
it.each(["cached", "thread-arrived"])(
  "rechecks live absence after a queued binding write: %s",
  async (change) => {
    const saved = { ...progress, threadId: ThreadId.make("saved-proposal") };
    __setClientSettingsForTests({ ...getClientSettings(), onboardingProgress: saved });
    let release!: () => void;
    persistence.setClientSettings.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { persistClientSettingsUpdate } = await import("../../hooks/useSettings");
    const pending = persistClientSettingsUpdate((current) => ({ ...current, wordWrap: false }));
    await act(async () => {
      await Promise.resolve();
    });
    await render();
    if (change === "cached") workspace.status = "cached";
    else
      workspace.threads.push({
        id: "saved-proposal",
        environmentId: "remote",
        projectId: "project",
      });
    await act(async () => {
      release();
      await pending;
    });
    expect(getClientSettings().onboardingProgress).toEqual(saved);
    expect(getClientSettings().wordWrap).toBe(false);
  },
);

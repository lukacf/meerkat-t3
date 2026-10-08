import { describe, expect, it, vi } from "vite-plus/test";
import type { RuntimeMode } from "@t3tools/contracts";

const testState = vi.hoisted(() => {
  let completeProjectFileRead: (value: null) => void = () => undefined;
  let projectFileRead = Promise.resolve<null>(null);
  let targetSettings = {
    defaultThreadEnvMode: "local" as "local" | "worktree",
    newWorktreesStartFromOrigin: false,
    defaultModelSelection: null,
    defaultRuntimeMode: "full-access" as RuntimeMode,
  };
  type StoredDraft = {
    readonly draftId: string;
    readonly environmentId: string;
    readonly projectId?: string;
    readonly promotedTo: null;
    readonly threadId: string;
    readonly logicalProjectKey?: string;
    readonly environmentSelection?: "auto" | "manual";
    readonly loadBalancedEnvironmentId?: string | null;
    readonly branch?: string | null;
    readonly worktreePath?: string | null;
    readonly envMode?: "local" | "worktree";
    readonly startFromOrigin?: boolean;
  };
  let storedDraft: StoredDraft | null = null;
  let activeDraft: StoredDraft | null = null;
  let routeTarget: { kind: "draft"; draftId: string } | null = null;
  const router = {
    state: {
      location: { href: "/" },
      matches: [{ params: {} }],
    },
    navigate: vi.fn(async (request: { readonly params: { readonly draftId: string } }) => {
      router.state.location.href = `/draft/${request.params.draftId}`;
    }),
  };
  const draftStore = {
    getComposerDraft: vi.fn(() => ({})),
    getDraftSessionByLogicalProjectKey: vi.fn(() => storedDraft),
    getDraftSessionByProjectRef: vi.fn(() => storedDraft),
    getDraftSession: vi.fn(() => activeDraft),
    getDraftThread: vi.fn(() => null),
    applyStickyState: vi.fn(),
    setDraftThreadContext: vi.fn(),
    setLogicalProjectDraftThreadId: vi.fn(),
    setModelSelection: vi.fn(),
  };
  let draftHasContent = false;

  return {
    completeProjectFileRead: (value: null) => completeProjectFileRead(value),
    draftStore,
    get draftHasContent() {
      return draftHasContent;
    },
    setDraftHasContent(value: boolean) {
      draftHasContent = value;
    },
    get projectFileRead() {
      return projectFileRead;
    },
    get targetSettings() {
      return targetSettings;
    },
    get routeTarget() {
      return routeTarget;
    },
    setActiveDraft(draft: StoredDraft) {
      activeDraft = draft;
      routeTarget = { kind: "draft", draftId: draft.draftId };
      router.state.location.href = `/draft/${draft.draftId}`;
    },
    reset(
      nextStoredDraft: typeof storedDraft,
      workspaceDefaults = {
        envMode: "local" as "local" | "worktree",
        startFromOrigin: false,
      },
    ) {
      storedDraft = nextStoredDraft;
      activeDraft = null;
      routeTarget = null;
      draftHasContent = false;
      targetSettings = {
        defaultThreadEnvMode: workspaceDefaults.envMode,
        newWorktreesStartFromOrigin: workspaceDefaults.startFromOrigin,
        defaultModelSelection: null,
        defaultRuntimeMode: "full-access",
      };
      router.state.location.href = "/";
      router.navigate.mockClear();
      draftStore.setDraftThreadContext.mockClear();
      draftStore.setLogicalProjectDraftThreadId.mockClear();
      projectFileRead = new Promise<null>((resolve) => {
        completeProjectFileRead = resolve;
      });
    },
    router,
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "primary-settings"
      ? { newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin }
      : new Map([
          [
            "environment-primary",
            {
              settings: {
                ...testState.targetSettings,
                newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin,
              },
            },
          ],
          ["environment-ssh", { settings: testState.targetSettings }],
        ]),
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopedProjectKey: () => "remote-project",
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("@t3tools/contracts", () => ({
  DEFAULT_RUNTIME_MODE: "default",
  DEFAULT_SERVER_SETTINGS: {},
}));
vi.mock("@t3tools/shared/projectSettings", () => ({
  // Environment settings pass through; the tests set project fields on the
  // project record, which the hook still honors until the server folds them.
  // With a file argument the env mode resolves like the real chain.
  resolveProjectSettings: (
    settings: Record<string, unknown>,
    _projectId: unknown,
    _project: unknown,
    projectFile?: { defaultThreadEnvMode?: "local" | "worktree" } | null,
  ) => ({
    settings:
      projectFile === undefined
        ? settings
        : {
            ...settings,
            defaultThreadEnvMode:
              settings.defaultThreadEnvMode ?? projectFile?.defaultThreadEnvMode ?? "local",
          },
    sources: { defaultModelSelection: "environment", defaultThreadEnvMode: "environment" },
    overrides: {},
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
  useRouter: () => testState.router,
}));
vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../components/Sidebar.logic", () => ({ orderItemsByPreferredIds: () => [] }));
vi.mock("../composerDraftStore", () => {
  const useComposerDraftStore = Object.assign(() => null, {
    getState: () => testState.draftStore,
  });
  return {
    composerDraftHasUserContent: () => testState.draftHasContent,
    markPromotedDraftThreadByRef: vi.fn(),
    useComposerDraftStore,
  };
});

describe("project home drafts", () => {
  const projectRef = { environmentId: "environment-ssh", projectId: "project-remote" } as never;

  it("resumes an invested draft without navigation or resetting its model and workspace", async () => {
    testState.reset({
      draftId: "draft-home",
      threadId: "thread-home",
      environmentId: "environment-ssh",
      projectId: "project-remote",
      promotedTo: null,
    });
    testState.setDraftHasContent(true);
    testState.draftStore.setModelSelection.mockClear();
    testState.draftStore.applyStickyState.mockClear();
    const opened = await useNewThreadHandler()(projectRef, { destination: "project-home" });
    expect(opened).toEqual({ draftId: "draft-home", threadId: "thread-home" });
    expect(testState.router.navigate).not.toHaveBeenCalled();
    expect(testState.draftStore.setDraftThreadContext).not.toHaveBeenCalled();
    expect(testState.draftStore.setModelSelection).not.toHaveBeenCalled();
    expect(testState.draftStore.applyStickyState).not.toHaveBeenCalled();
  });

  it("prepares a local draft with environment defaults and leaves the home route in place", async () => {
    testState.reset(null, { envMode: "worktree", startFromOrigin: true });
    testState.router.state.location.href = "/environment-ssh/projects/project-remote/start";
    const opened = await useNewThreadHandler()(projectRef, { destination: "project-home" });
    expect(opened).toEqual({ draftId: "draft-delayed", threadId: "thread-delayed" });
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      projectRef,
      "draft-delayed",
      expect.objectContaining({ envMode: "worktree", startFromOrigin: true }),
    );
    expect(testState.router.navigate).not.toHaveBeenCalled();
    expect(testState.router.state.location.href).toBe(
      "/environment-ssh/projects/project-remote/start",
    );
  });

  it("keeps New thread distinct from resuming invested home work", async () => {
    testState.reset({
      draftId: "draft-home",
      threadId: "thread-home",
      environmentId: "environment-ssh",
      projectId: "project-remote",
      promotedTo: null,
    });
    testState.setDraftHasContent(true);
    const opened = await useNewThreadHandler()(projectRef);
    expect(opened?.draftId).toBe("draft-delayed");
    expect(testState.router.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { draftId: "draft-delayed" } }),
    );
  });
});
vi.mock("../lib/chatThreadActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/chatThreadActions")>()),
  hasExplicitComposerModelSelection: () => false,
  resolveNewThreadModelSelectionOverride: () => null,
}));
vi.mock("../lib/t3ProjectFileDefaults", () => ({
  readT3ProjectFile: () => testState.projectFileRead,
}));
vi.mock("../lib/utils", () => ({
  newDraftId: () => "draft-delayed",
  newThreadId: () => "thread-delayed",
}));
vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => "remote-project",
  getProjectOrderKey: () => "remote-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => ({
  readProjects: () => [
    {
      id: "project-remote",
      environmentId: "environment-ssh",
      workspaceRoot: "/remote/project",
      defaultThreadEnvMode: null,
      defaultModelSelection: null,
    },
  ],
  readThreadShell: () => null,
  useProjects: () => [],
  useThread: () => null,
}));
vi.mock("../state/server", () => ({
  environmentServerConfigsAtom: {},
  primaryServerSettingsAtom: "primary-settings",
}));
vi.mock("../threadRoutes", () => ({ resolveThreadRouteTarget: () => testState.routeTarget }));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: () => [],
}));
vi.mock("./useSettings", () => ({ useClientSettings: () => ({}) }));

import { useNewThreadHandler } from "./useHandleNewThread";

describe.each([
  ["new", null],
  [
    "reusable",
    {
      draftId: "draft-existing",
      environmentId: "environment-ssh",
      promotedTo: null,
      threadId: "thread-existing",
    },
  ],
])("useNewThreadHandler with a %s draft", (_, draft) => {
  it("applies an explicit checkout choice before navigation instead of leaving automatic selection active", async () => {
    testState.reset(
      draft
        ? {
            ...draft,
            projectId: "project-remote",
            environmentSelection: "auto",
            loadBalancedEnvironmentId: "environment-primary",
            branch: "old-branch",
            worktreePath: "/remote/old-worktree",
            envMode: "worktree",
            startFromOrigin: true,
          }
        : null,
    );
    const projectRef = { environmentId: "environment-ssh", projectId: "project-remote" } as never;
    const opened = await useNewThreadHandler()(projectRef, {
      environmentSelection: "manual",
      loadBalancedEnvironmentId: null,
    });

    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      projectRef,
      opened!.draftId,
      expect.objectContaining({ environmentSelection: "manual", loadBalancedEnvironmentId: null }),
    );
    expect(
      testState.draftStore.setLogicalProjectDraftThreadId.mock.invocationCallOrder[0],
    ).toBeLessThan(testState.router.navigate.mock.invocationCallOrder[0]!);
    if (draft) {
      expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
        "remote-project",
        projectRef,
        draft.draftId,
        expect.objectContaining({
          branch: null,
          worktreePath: null,
          envMode: "local",
          startFromOrigin: false,
          environmentSelection: "manual",
          loadBalancedEnvironmentId: null,
        }),
      );
      expect(testState.draftStore.setDraftThreadContext).toHaveBeenCalledWith(
        draft.draftId,
        expect.objectContaining({
          branch: null,
          worktreePath: null,
          envMode: "local",
          startFromOrigin: false,
          environmentSelection: "manual",
          loadBalancedEnvironmentId: null,
        }),
      );
    }
  });

  it.each(["approval-required", "auto-accept-edits", "auto", "full-access"] as const)(
    "uses the target environment's %s permissions for new threads",
    async (runtimeMode) => {
      testState.reset(draft);
      testState.targetSettings.defaultRuntimeMode = runtimeMode;
      const projectRef = {
        environmentId: "environment-ssh",
        projectId: "project-remote",
      } as never;
      const pendingOpen = useNewThreadHandler()(projectRef);
      testState.completeProjectFileRead(null);
      const opened = await pendingOpen;

      expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
        "remote-project",
        projectRef,
        opened!.draftId,
        expect.objectContaining({ runtimeMode }),
      );
    },
  );

  it("abandons a delayed draft open when the user navigates elsewhere", async () => {
    testState.reset(draft);
    const openThread = useNewThreadHandler();
    const pendingOpen = openThread(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { replace: true },
    );

    testState.router.state.location.href = "/usage";
    testState.completeProjectFileRead(null);
    await pendingOpen;

    expect(testState.router.state.location.href).toBe("/usage");
    expect(testState.router.navigate).not.toHaveBeenCalled();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "uses the target environment's start-from-origin default of %s",
    async (startFromOrigin) => {
      testState.reset(draft, { envMode: "worktree", startFromOrigin });
      const openThread = useNewThreadHandler();
      const projectRef = {
        environmentId: "environment-ssh",
        projectId: "project-remote",
      } as never;
      const pendingOpen = openThread(projectRef);

      testState.completeProjectFileRead(null);
      const opened = await pendingOpen;

      expect(opened).toEqual({
        draftId: draft?.draftId ?? "draft-delayed",
        threadId: draft?.threadId ?? "thread-delayed",
      });
      expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
        "remote-project",
        projectRef,
        opened!.draftId,
        expect.objectContaining({ envMode: "worktree", startFromOrigin }),
      );
      if (draft) {
        expect(testState.draftStore.setDraftThreadContext).toHaveBeenCalledWith(
          draft.draftId,
          expect.objectContaining({ envMode: "worktree", startFromOrigin }),
        );
      }
    },
  );

  it.each([true, false])(
    "preserves an explicit start-from-origin choice of %s",
    async (startFromOrigin) => {
      testState.reset(draft, { envMode: "worktree", startFromOrigin: !startFromOrigin });
      const openThread = useNewThreadHandler();
      const projectRef = {
        environmentId: "environment-ssh",
        projectId: "project-remote",
      } as never;

      const opened = await openThread(projectRef, { envMode: "worktree", startFromOrigin });

      expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
        "remote-project",
        projectRef,
        opened!.draftId,
        expect.objectContaining({ envMode: "worktree", startFromOrigin }),
      );
    },
  );
});

describe("explicit checkout intent on retained drafts", () => {
  const projectRef = { environmentId: "environment-ssh", projectId: "project-remote" } as never;
  const retained = {
    draftId: "draft-retained",
    threadId: "thread-retained",
    environmentId: "environment-ssh",
    projectId: "project-remote",
    logicalProjectKey: "remote-project",
    promotedTo: null,
    environmentSelection: "auto" as const,
    loadBalancedEnvironmentId: "environment-primary",
  };
  const manual = { environmentSelection: "manual" as const, loadBalancedEnvironmentId: null };

  it("marks an already-open empty draft manual without moving or resetting its checkout controls", async () => {
    testState.reset(null);
    testState.setActiveDraft(retained);
    const opened = await useNewThreadHandler()(projectRef, manual);

    expect(opened).toEqual({ draftId: retained.draftId, threadId: retained.threadId });
    expect(testState.draftStore.setDraftThreadContext).toHaveBeenCalledWith(
      retained.draftId,
      manual,
    );
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      projectRef,
      retained.draftId,
      expect.objectContaining(manual),
    );
    expect(testState.router.navigate).not.toHaveBeenCalled();
  });

  it("keeps explicit checkout intent when a concurrent request creates the reusable draft", async () => {
    testState.reset(null);
    testState.draftStore.getDraftSessionByLogicalProjectKey
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(retained);
    const opened = await useNewThreadHandler()(projectRef, manual);

    expect(opened).toEqual({ draftId: retained.draftId, threadId: retained.threadId });
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledExactlyOnceWith(
      "remote-project",
      projectRef,
      retained.draftId,
      expect.objectContaining(manual),
    );
    expect(
      testState.draftStore.setLogicalProjectDraftThreadId.mock.invocationCallOrder[0],
    ).toBeLessThan(testState.router.navigate.mock.invocationCallOrder[0]!);
  });

  it("resumes invested project-home work with only the explicit environment intent changed", async () => {
    testState.reset(retained);
    testState.setDraftHasContent(true);
    testState.draftStore.setModelSelection.mockClear();
    testState.draftStore.applyStickyState.mockClear();
    const opened = await useNewThreadHandler()(projectRef, {
      destination: "project-home",
      ...manual,
    });

    expect(opened).toEqual({ draftId: retained.draftId, threadId: retained.threadId });
    expect(testState.draftStore.setDraftThreadContext).toHaveBeenCalledExactlyOnceWith(
      retained.draftId,
      manual,
    );
    expect(testState.draftStore.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
    expect(testState.draftStore.setModelSelection).not.toHaveBeenCalled();
    expect(testState.draftStore.applyStickyState).not.toHaveBeenCalled();
    expect(testState.router.navigate).not.toHaveBeenCalled();
  });
});

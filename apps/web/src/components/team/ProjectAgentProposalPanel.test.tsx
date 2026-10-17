import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MeerkatProjectAgent,
  type MeerkatProjectAgentProposal,
  type MeerkatProjectProposal,
  type MeerkatProjectTeam,
  type SharedWorkspaceSession,
  type SharedSpecialistRegisterInput,
  type SharedProject,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { act, type PropsWithChildren } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: null as ClientSettings | null,
  persist: vi.fn(),
  proposal: null as MeerkatProjectProposal | null,
  team: null as MeerkatProjectTeam | null,
  teamError: null as string | null,
  sharedError: null as string | null,
  create: vi.fn(),
  prepare: vi.fn(),
  startTurn: vi.fn(),
  refresh: vi.fn(),
  navigate: vi.fn(),
  shared: null as SharedWorkspaceSession | null,
  share: vi.fn(),
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: ClientSettings) => unknown) => select(state.settings!),
  persistClientSettingsUpdate: async (update: (settings: ClientSettings) => ClientSettings) => {
    const next = update(state.settings!);
    await state.persist(next);
    state.settings = next;
    return next;
  },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../lib/utils", () => ({ newMessageId: () => "message" }));
vi.mock("../../state/meerkatTeam", () => ({
  meerkatTeamEnvironment: {
    projectProposal: () => "proposal",
    projectTeam: () => "team",
    projectProposalCreate: "create",
    projectAgentPrepare: "prepare",
  },
  useVisibleTeamRefresh: () => {},
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => ({
    status: "live",
    snapshot: { _id: "Option", _tag: "Some", value: { threads: [] } },
  }),
}));
vi.mock("./useRestoreReview", () => ({
  useRestoreReviewWorkBlock: () => null,
  readRestoreReviewWorkBlock: () => null,
}));
vi.mock("../../state/shell", () => ({ environmentShell: { stateValueAtom: () => "shell" } }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { startTurn: "startTurn" } }));
vi.mock("../../state/sharedWorkspace", () => ({
  sharedWorkspaceEnvironment: { session: () => "shared", registerSpecialist: "share" },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: string) => ({
    data: query === "proposal" ? state.proposal : query === "shared" ? state.shared : state.team,
    error: query === "team" ? state.teamError : query === "shared" ? state.sharedError : null,
    isPending: false,
    refresh: state.refresh,
  }),
  formatEnvironmentQueryError: (cause: unknown) => String(cause),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "create" | "prepare" | "startTurn" | "share") => state[command],
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/badge", () => ({ Badge: "span" }));
vi.mock("../ui/checkbox", () => ({ Checkbox: "input" }));
vi.mock("./ProjectAgentPermissions", () => ({
  ProjectAgentPermissions: ({
    value,
    onChange,
    disabled,
  }: {
    value: string;
    onChange: (value: string) => void;
    disabled: boolean;
  }) => (
    <select
      aria-label="New agent permissions"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
  projectAgentPermissionLabel: (mode: string | undefined) => mode ?? "Permissions unavailable",
}));
vi.mock("../ui/dialog", async () => {
  const { createContext, useContext } = await import("react");
  const Context = createContext({ open: false, onOpenChange: (_open: boolean) => {} });
  const Container = ({ children }: PropsWithChildren) => <div>{children}</div>;
  return {
    Dialog: (
      props: PropsWithChildren<{ open: boolean; onOpenChange: (open: boolean) => void }>,
    ) => <Context value={props}>{props.children}</Context>,
    DialogPopup: ({ children }: PropsWithChildren) => {
      const context = useContext(Context);
      return context.open ? (
        <div role="dialog">
          <button onClick={() => context.onOpenChange(false)}>Close review</button>
          {children}
        </div>
      ) : null;
    },
    DialogHeader: Container,
    DialogTitle: Container,
    DialogDescription: Container,
    DialogPanel: Container,
    DialogFooter: Container,
  };
});

import { ProjectAgentProposalPanel } from "./ProjectAgentProposalPanel";

const projectId = ProjectId.make("project");
const instanceId = ProviderInstanceId.make("meerkat");
const sourceThreadId = ThreadId.make("setup");
const proposal: MeerkatProjectAgentProposal = {
  proposalId: "proposal",
  title: "Project specialists",
  summary: null,
  agents: [
    {
      id: "architect",
      role: "architect",
      label: "Architect",
      focus: "Runtime",
      charter: "Own the runtime.",
      ownershipPaths: ["src/runtime"],
      recommended: true,
    },
  ],
};
const prepared: MeerkatProjectAgent = {
  ...proposal.agents[0]!,
  agentId: "architect-agent",
  projectId,
  instanceId,
  instructions: "Own the runtime.",
  model: "openai:model",
  accessMode: "full-access",
  enabled: true,
  archived: false,
  connectionStatus: "connected",
  agentRef: "native-agent",
  error: null,
  createdAt: "2026-09-29T07:00:00.000Z",
  updatedAt: "2026-09-29T07:01:00.000Z",
  preparation: {
    assignmentId: "study",
    fingerprint: "assignment",
    attempt: 1,
    status: "ready",
    requestId: "request",
    interactionId: "interaction",
    inputFrameId: "input",
    error: null,
    updatedAt: "2026-09-29T07:01:00.000Z",
  },
};
const sharedProject: SharedProject = {
  sharedProjectId: "shared-project",
  hostProjectId: projectId,
  name: "Project",
  repository: "github.com/example/project",
  aliases: [],
  forkOf: null,
  createdAt: "2026-10-17T07:00:00.000Z",
};
const sharedDefinition = (input: SharedSpecialistRegisterInput) => ({
  ...input,
  specialistId: "shared-specialist",
  assignmentVersion: 0,
  supersededAt: null,
  successorId: null,
  createdAt: sharedProject.createdAt,
});
function useSharedHost() {
  state.shared = {
    ...state.shared!,
    snapshot: { ...state.shared!.snapshot, projects: [sharedProject] },
  };
}
const props = {
  environmentId: EnvironmentId.make("local"),
  projectId,
  sourceThreadId,
  projectTitle: "Project",
  busy: false,
  modelSelection: { instanceId, model: "openai:model" },
  runtimeMode: "full-access" as const,
};
let renderer: ReactTestRenderer | undefined;
const button = (label: string) =>
  renderer!.root.findAllByType("button").find(
    (node) =>
      node.children
        .filter((child) => typeof child !== "object")
        .join("")
        .trim() === label,
  )!;
const content = () => JSON.stringify(renderer!.toJSON());
const render = () =>
  act(() => {
    if (renderer) renderer.update(<ProjectAgentProposalPanel {...props} />);
    else renderer = create(<ProjectAgentProposalPanel {...props} />);
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.proposal = {
    projectId,
    sourceThreadId,
    instanceId,
    model: "openai:model",
    isSetupThread: true,
    isSourceThreadPersisted: true,
    available: true,
    status: "ready",
    error: null,
    proposal,
  };
  state.team = {
    projectId,
    observedAt: "2026-09-29T07:00:00.000Z",
    observation: "loaded_runtimes",
    providers: [],
    projectAgents: [],
  };
  state.settings = { ...DEFAULT_CLIENT_SETTINGS, onboardingCompletedAt: null };
  state.shared = {
    snapshot: { projects: [], specialists: [] },
    permissions: { admin: true },
  } as unknown as SharedWorkspaceSession;
  state.share
    .mockReset()
    .mockImplementation(async ({ input }: { input: SharedSpecialistRegisterInput }) => ({
      _tag: "Success",
      value: sharedDefinition(input),
    }));
  state.sharedError = null;
  state.persist.mockReset().mockResolvedValue(undefined);
  state.teamError = null;
  state.create.mockReset();
  state.prepare.mockReset();
  state.startTurn.mockReset();
  state.refresh.mockReset();
  state.navigate.mockReset();
});

describe("shared specialist proposal onboarding", () => {
  it("prepares repository-only specialists and publishes the same identity and reviewed assignment", async () => {
    useSharedHost();
    const studying = {
      ...prepared,
      accessMode: "repository-read-only" as const,
      preparation: { ...prepared.preparation!, status: "studying" as const },
    };
    state.create.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        results: [{ candidateId: "architect", agent: studying, error: null }],
      },
    });
    render();
    act(() => button("Review proposal").props.onClick());
    expect(renderer!.root.findAllByProps({ "aria-label": "New agent permissions" })).toHaveLength(
      0,
    );
    expect(content()).toContain("These specialists belong to a shared host");
    await act(async () => button("Apply 1 assignment").props.onClick());
    expect(state.create).toHaveBeenCalledWith({
      environmentId: props.environmentId,
      input: {
        projectId,
        sourceThreadId,
        proposalId: proposal.proposalId,
        candidateIds: ["architect"],
        accessMode: "repository-read-only",
      },
    });
    expect(button("Share specialist")).toBeUndefined();
    state.team = {
      ...state.team!,
      projectAgents: [{ ...prepared, accessMode: "repository-read-only" }],
    };
    render();
    await act(async () => button("Share specialist").props.onClick());
    const request = state.share.mock.calls[0]![0];
    expect(request).toMatchObject({
      environmentId: props.environmentId,
      input: {
        nativeTarget: { projectId, instanceId, agentId: prepared.agentId },
        label: prepared.label,
        assignments: [
          {
            sharedProjectId: sharedProject.sharedProjectId,
            charter: proposal.agents[0]!.charter,
            paths: ["src/runtime"],
            tags: [],
          },
        ],
      },
    });
    expect(request.input.requestId).toMatch(/^shared-proposal:[a-f0-9]{64}$/);
    expect(content()).toContain('"Shared"');
    expect(button("Share specialist")).toBeUndefined();
    expect(state.persist).not.toHaveBeenCalled();
    await act(async () => button("Manage shared host").props.onClick());
    expect(state.navigate).toHaveBeenLastCalledWith({ to: "/settings/connections" });
  });

  it.each(["read-only", "read-and-collaborate", "full-access"] as const)(
    "does not convert or prepare a local role with %s permissions",
    (accessMode) => {
      useSharedHost();
      state.team = { ...state.team!, projectAgents: [{ ...prepared, accessMode }] };
      render();
      act(() => button("Review proposal").props.onClick());
      expect(content()).toContain("Local agent has different permissions");
      expect(button("Apply 1 assignment")).toBeUndefined();
      expect(button("Share specialist")).toBeUndefined();
      expect(button("Retry study")).toBeUndefined();
      expect(state.create).not.toHaveBeenCalled();
      expect(state.prepare).not.toHaveBeenCalled();
      expect(state.share).not.toHaveBeenCalled();
    },
  );

  it("retries an uncertain publication with the same request and recognizes registration after remount", async () => {
    useSharedHost();
    state.team = {
      ...state.team!,
      projectAgents: [{ ...prepared, accessMode: "repository-read-only" }],
    };
    state.share.mockResolvedValueOnce({ _tag: "Failure", cause: "disconnected" });
    render();
    act(() => button("View agents").props.onClick());
    await act(async () => button("Share specialist").props.onClick());
    expect(content()).toContain("Could not confirm sharing");
    await act(async () => button("Share specialist").props.onClick());
    expect(state.share.mock.calls[1]![0]).toEqual(state.share.mock.calls[0]![0]);
    const definition = sharedDefinition(state.share.mock.calls[0]![0].input);
    state.shared = {
      ...state.shared!,
      snapshot: { ...state.shared!.snapshot, specialists: [definition] },
    };
    act(() => renderer!.unmount());
    renderer = undefined;
    render();
    act(() => button("View agents").props.onClick());
    expect(button("Share specialist")).toBeUndefined();
    expect(content()).toContain('"Shared"');
    expect(state.share).toHaveBeenCalledTimes(2);
  });

  it("keeps published assignment revisions in the shared workspace", () => {
    useSharedHost();
    const agent = {
      ...prepared,
      accessMode: "repository-read-only" as const,
      charter: "Existing shared charter",
    };
    state.team = { ...state.team!, projectAgents: [agent] };
    state.shared = {
      ...state.shared!,
      snapshot: {
        ...state.shared!.snapshot,
        specialists: [
          sharedDefinition({
            requestId: "already-shared",
            nativeTarget: { projectId, instanceId, agentId: agent.agentId },
            label: agent.label,
            assignments: [
              {
                sharedProjectId: sharedProject.sharedProjectId,
                charter: agent.charter,
                paths: agent.ownershipPaths!,
                tags: [],
              },
            ],
          }),
        ],
      },
    };
    render();
    act(() => button("Review proposal").props.onClick());
    expect(content()).toContain("manage assignments in the shared workspace");
    expect(button("Apply 1 assignment")).toBeUndefined();
    expect(button("Share specialist")).toBeUndefined();
    expect(button("Manage shared host")).toBeDefined();
  });

  it.each(["loading", "error", "participant"])(
    "refuses creation when host context is %s",
    async (status) => {
      useSharedHost();
      if (status === "loading") state.shared = null;
      if (status === "error") state.sharedError = "Host access unavailable";
      if (status === "participant")
        state.shared = {
          ...state.shared!,
          permissions: { ...state.shared!.permissions, admin: false },
        };
      render();
      act(() => button("Review proposal").props.onClick());
      const apply = button("Apply 1 assignment");
      expect(apply.props.disabled).toBe(true);
      await act(async () => apply.props.onClick());
      expect(state.create).not.toHaveBeenCalled();
    },
  );
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("proposal command recovery", () => {
  it.each(["read-and-collaborate", "read-only", "full-access"])(
    "uses the chosen permissions for new agents: %s",
    async (mode) => {
      state.create.mockResolvedValueOnce({
        _tag: "Success",
        value: {
          results: [
            { candidateId: "architect", agent: { ...prepared, accessMode: mode }, error: null },
          ],
        },
      });
      render();
      act(() => button("Review proposal").props.onClick());
      const permissions = renderer!.root.findByProps({ "aria-label": "New agent permissions" });
      expect(permissions.props.value).toBe("read-and-collaborate");
      act(() => permissions.props.onChange({ target: { value: mode } }));
      await act(async () => button("Apply 1 assignment").props.onClick());
      expect(state.create).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ accessMode: mode, candidateIds: ["architect"] }),
        }),
      );
    },
  );

  it("shows an existing specialist's actual permissions without offering a mode change", () => {
    state.team = { ...state.team!, projectAgents: [prepared] };
    render();
    act(() => button("View agents").props.onClick());
    expect(renderer!.root.findAllByProps({ "aria-label": "New agent permissions" })).toHaveLength(
      0,
    );
    expect(content()).toContain("full-access");
    expect(content()).toContain("Existing agents keep their permissions");
  });

  it.each([true, false])(
    "keeps a failed request visible when review closes before completion: %s",
    async (closeWhilePending) => {
      let complete: (value: unknown) => void = () => {};
      state.create.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      render();
      act(() => button("Review proposal").props.onClick());
      act(() => button("Apply 1 assignment").props.onClick());
      if (closeWhilePending) act(() => button("Close review").props.onClick());
      await act(async () => complete({ _tag: "Failure", cause: "Assignment service unavailable" }));
      if (!closeWhilePending) act(() => button("Close review").props.onClick());

      expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
      expect(renderer!.root.findByProps({ role: "alert" }).children).toContain(
        "Assignment service unavailable",
      );
      expect(button("Review issues")).toBeDefined();

      act(() => button("Review issues").props.onClick());
      state.create.mockResolvedValueOnce({
        _tag: "Success",
        value: { results: [{ candidateId: "architect", agent: prepared, error: null }] },
      });
      await act(async () => button("Apply 1 assignment").props.onClick());
      act(() => button("Close review").props.onClick());
      expect(state.create).toHaveBeenCalledTimes(2);
      expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
      expect(content()).toContain("1 agent ready");
      expect(button("View agents")).toBeDefined();
    },
  );

  it("surfaces a failed roster observation over previously ready progress and offers recovery", () => {
    state.team = { ...state.team!, projectAgents: [prepared] };
    state.teamError = "Could not load project agents";
    render();
    expect(content()).toContain("Needs attention");
    expect(renderer!.root.findByProps({ role: "alert" }).children).toContain(state.teamError);
    act(() => button("Review issues").props.onClick());
    act(() => button("Retry loading agents").props.onClick());
    expect(state.refresh).toHaveBeenCalledOnce();
    state.teamError = null;
    render();
    act(() => button("Close review").props.onClick());
    expect(content()).toContain("1 agent ready");
    expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  });
});

describe("specialist onboarding completion", () => {
  function beginSetup() {
    state.settings = {
      ...state.settings!,
      onboardingProgress: {
        step: "project-agents",
        environmentIds: [props.environmentId],
        startedAt: "2026-10-08T12:00:00.000Z",
        projectRef: { environmentId: props.environmentId, projectId },
        threadId: sourceThreadId,
      },
    };
  }
  it("a ready proposal and unrelated agents cannot finish the setup journey", () => {
    beginSetup();
    state.team = { ...state.team!, projectAgents: [{ ...prepared, focus: "An unrelated domain" }] };
    render();
    expect(button("Continue to specialists")).toBeUndefined();
    expect(state.settings!.onboardingCompletedAt).toBeNull();
    expect(state.persist).not.toHaveBeenCalled();
  });
  it("successful apply offers explicit completion while preparation is still running", async () => {
    beginSetup();
    state.create.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        projectId,
        sourceThreadId,
        proposalId: proposal.proposalId,
        results: [
          {
            candidateId: "architect",
            agent: { ...prepared, preparation: { ...prepared.preparation!, status: "studying" } },
            error: null,
          },
        ],
      },
    });
    render();
    act(() => button("Review proposal").props.onClick());
    await act(async () => button("Apply 1 assignment").props.onClick());
    act(() => button("Close review").props.onClick());
    expect(state.settings!.onboardingCompletedAt).toBeNull();
    expect(content()).toContain("1 studying");
    await act(async () => button("Continue to specialists").props.onClick());
    expect(state.settings!.onboardingProgress).toBeNull();
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/agents/$agentId",
      params: { environmentId: props.environmentId, agentId: prepared.agentId },
      search: { project: projectId },
    });
    expect(state.startTurn).not.toHaveBeenCalled();
  });
  it("reload recognizes current applied assignments and does not repeat study", async () => {
    beginSetup();
    state.team = { ...state.team!, projectAgents: [prepared] };
    render();
    expect(button("Continue to specialists")).toBeDefined();
    expect(state.settings!.onboardingCompletedAt).toBeNull();
    await act(async () => button("Continue to specialists").props.onClick());
    expect(state.create).not.toHaveBeenCalled();
    expect(state.startTurn).not.toHaveBeenCalled();
  });
  it.each(["failed", "interrupted", "uncertain"] as const)(
    "does not complete from a %s assignment",
    (status) => {
      beginSetup();
      state.team = {
        ...state.team!,
        projectAgents: [{ ...prepared, preparation: { ...prepared.preparation!, status } }],
      };
      render();
      expect(button("Continue to specialists")).toBeUndefined();
      expect(state.settings!.onboardingCompletedAt).toBeNull();
    },
  );
});

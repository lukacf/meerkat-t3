import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type MeerkatProjectAgent,
  type ServerProvider,
  type SharedWorkspaceSnapshot,
} from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentPresentation } from "../../state/environments";

const state = vi.hoisted(() => ({
  snapshot: null as SharedWorkspaceSnapshot | null,
  projects: [] as EnvironmentProject[],
  providers: [] as ServerProvider[],
  agents: [] as MeerkatProjectAgent[],
  admin: true,
  connected: true,
  error: null as string | null,
  configure: vi.fn(),
  registerProject: vi.fn(),
  registerSpecialist: vi.fn(),
  create: vi.fn(),
  connect: vi.fn(),
  refresh: vi.fn(),
  focus: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ Link: "a" }));
vi.mock("../../state/sharedWorkspace", () => ({
  sharedWorkspaceEnvironment: {
    configure: "configure",
    registerProject: "registerProject",
    registerSpecialist: "registerSpecialist",
  },
  useSharedDirectory: () => ({
    snapshot: state.snapshot,
    connected: state.connected,
    error: state.error,
    isPending: false,
    permissions: { admin: state.admin },
    refresh: state.refresh,
  }),
}));
vi.mock("../../state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("../../state/meerkatTeam", () => ({
  meerkatTeamEnvironment: {
    projectAgents: () => "agents",
    projectAgentCreate: "create",
    projectAgentLifecycle: "connect",
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { agents: state.agents },
    error: null,
    refresh: state.refresh,
  }),
  formatEnvironmentQueryError: (value: string) => value,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (
    command: "configure" | "registerProject" | "registerSpecialist" | "create" | "connect",
  ) => state[command],
}));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: "configs" }));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => new Map() } }));
vi.mock("../../hooks/useProviderWorkspaceReadiness", () => ({
  useProviderWorkspaceReadiness: () => ({
    providers: state.providers,
    pendingInstanceIds: new Set(),
  }),
}));
vi.mock("../team/agentModelReadiness", () => ({ getAgentModelSendBlock: () => null }));
vi.mock("../team/useRestoreReview", () => ({
  readRestoreReviewWorkBlock: () => null,
  useRestoreReviewWorkBlock: () => null,
}));
vi.mock("../team/ProjectAgentModelFields", () => ({
  ProjectAgentModelFields: ({ model }: { model?: { slug: string } }) => (
    <div data-model={model?.slug ?? "none"} />
  ),
}));
vi.mock("./FoldedSettingsSection", () => ({ FoldedSettingsSection: "section" }));
vi.mock("./SharedHostInvitations", () => ({ SharedHostInvitations: "aside" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/collapsible", () => ({
  Collapsible: "section",
  CollapsibleTrigger: "button",
  CollapsiblePanel: "div",
}));
vi.mock("../ui/select", () => ({
  Select: "select",
  SelectItem: "option",
  SelectPopup: "optgroup",
  SelectTrigger: "span",
  SelectValue: "span",
}));
import { SharedHostSettings } from "./SharedHostSettings";
import { readSharedHostSetup } from "./sharedHostSetup";

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("catalog");
const instanceId = ProviderInstanceId.make("native");
const now = "2026-10-17T08:00:00.000Z";
const host = {
  environmentId,
  label: "Host",
  serverConfig: { providers: [] },
} as unknown as EnvironmentPresentation;
const project: EnvironmentProject = {
  id: projectId,
  environmentId,
  title: "Catalog",
  workspaceRoot: "/work/catalog",
  repositoryIdentity: {
    canonicalKey: "unused",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:Example/Catalog.git",
    },
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
};
const agent: MeerkatProjectAgent = {
  projectId,
  instanceId,
  agentId: "search-agent",
  label: "Search",
  role: "search",
  instructions: "Own search relevance",
  model: "account-model",
  accessMode: "repository-read-only",
  enabled: true,
  archived: false,
  connectionStatus: "connected",
  error: null,
  agentRef: null,
  createdAt: now,
  updatedAt: now,
};
function snapshot(): SharedWorkspaceSnapshot {
  return {
    workspace: {
      workspaceId: "product",
      name: "Product",
      limits: { maxSpecialists: 24, maxSnapshotBytes: 1024 },
      createdAt: now,
    },
    participant: null,
    projects: [
      {
        sharedProjectId: "shared-catalog",
        hostProjectId: projectId,
        repository: "github.com/example/catalog",
        name: "Catalog",
        aliases: [],
        forkOf: null,
        createdAt: now,
      },
    ],
    specialists: [],
    checkouts: [],
  };
}
let rendered: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rows = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => rows.set(key, value),
  });
  state.snapshot = snapshot();
  state.projects = [project];
  state.agents = [];
  state.providers = [];
  state.admin = true;
  state.connected = true;
  state.error = null;
  for (const command of [
    state.configure,
    state.registerProject,
    state.registerSpecialist,
    state.create,
    state.connect,
    state.refresh,
    state.focus,
  ])
    command.mockReset();
  state.configure.mockResolvedValue({ _tag: "Success", value: snapshot().workspace });
  state.registerProject.mockResolvedValue({ _tag: "Success", value: snapshot().projects[0] });
  state.create.mockResolvedValue({ _tag: "Success", value: agent });
  state.connect.mockResolvedValue({ _tag: "Success", value: agent });
  state.registerSpecialist.mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: {
      ...input,
      specialistId: "shared-search",
      assignmentVersion: 0,
      supersededAt: null,
      successorId: null,
      createdAt: now,
    },
  }));
});
afterEach(async () => {
  await act(async () => rendered?.unmount());
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => {
    rendered = create(<SharedHostSettings host={host} />, {
      createNodeMock: (element) => (element.type === "button" ? { focus: state.focus } : null),
    });
  });
}
const text = () =>
  JSON.stringify(rendered!.toJSON(), (key, value) => (key === "render" ? undefined : value));
const step = (title: string) =>
  rendered!.root
    .findAllByType("section")
    .find((entry) => entry.props["data-setup-step"] === title)!;
const button = (label: string) =>
  rendered!.root.findAllByType("button").find((entry) => entry.children.includes(label))!;
const change = async (label: string, value: string) =>
  act(async () =>
    rendered!.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } }),
  );
const submitSpecialist = async () =>
  act(async () => rendered!.root.findAllByType("form")[1]!.props.onSubmit({ preventDefault() {} }));

describe("shared host settings", () => {
  it("opens repository-generated specialists on the selected host, not the personal environment", async () => {
    await render();
    const generate = button("Generate specialists");
    expect(generate.props.disabled).toBe(false);
    expect(generate.props.render.props).toMatchObject({
      to: "/$environmentId/projects/$projectId/agents/propose",
      params: { environmentId: host.environmentId, projectId },
    });
    expect(text()).toContain("Shared specialists keep repository-only access");
    await act(async () => rendered!.unmount());
    state.admin = false;
    await render();
    expect(button("Generate specialists")).toBeUndefined();
  });
  it("returns to the selected host project after reopening settings", async () => {
    const other = { ...project, id: ProjectId.make("other-project"), title: "Billing" };
    state.projects = [project, other];
    await render();
    await act(async () =>
      rendered!.root
        .findAllByType("select")
        .find((entry) => entry.props.value === projectId)!
        .props.onValueChange(other.id),
    );
    await act(async () => rendered!.unmount());
    await render();
    expect(
      rendered!.root.findAllByType("select").some((entry) => entry.props.value === other.id),
    ).toBe(true);
    expect(step("Repository").props.open).toBe(true);
  });
  it("opens only the next step and retains draft fields while editing a completed step", async () => {
    await render();
    expect(step("Workspace").props.open).toBe(false);
    expect(step("Repository").props.open).toBe(false);
    expect(step("Specialist").props.open).toBe(true);
    expect(
      rendered!.root.findByProps({ "aria-label": "Edit workspace" }).props["aria-expanded"],
    ).toBe(false);
    await change("Shared specialist name", "Search responsibility");
    await change("Shared specialist responsibility", "Own query relevance");
    await act(async () => step("Workspace").props.onOpenChange(true));
    expect(step("Workspace").props.open).toBe(true);
    expect(step("Specialist").props.open).toBe(false);
    expect(state.focus).not.toHaveBeenCalled();
    await act(async () => step("Specialist").props.onOpenChange(true));
    expect(step("Workspace").props.open).toBe(false);
    expect(step("Specialist").props.open).toBe(true);
    expect(rendered!.root.findByProps({ "aria-label": "Shared specialist name" }).props.value).toBe(
      "Search responsibility",
    );
    expect(
      rendered!.root.findByProps({ "aria-label": "Shared specialist responsibility" }).props.value,
    ).toBe("Own query relevance");
  });
  it("does not expose host setup to a shared participant", async () => {
    state.admin = false;
    await render();
    expect(rendered!.toJSON()).toBeNull();
    expect(state.create).not.toHaveBeenCalled();
  });
  it("keeps cached configuration visible offline without allowing mutations", async () => {
    state.connected = false;
    await render();
    expect(text()).toContain("Reconnect this host");
    expect(button("Save name").props.disabled).toBe(true);
    await act(async () =>
      rendered!.root.findAllByType("form")[0]!.props.onSubmit({ preventDefault() {} }),
    );
    expect(state.configure).not.toHaveBeenCalled();
  });
  it("configures a workspace using the local administrative environment", async () => {
    state.snapshot = { ...snapshot(), workspace: null };
    await render();
    await change("Shared workspace name", " Search platform ");
    await act(async () =>
      rendered!.root.findByType("form").props.onSubmit({ preventDefault() {} }),
    );
    expect(state.configure).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { name: "Search platform" },
    });
    expect(state.registerProject).not.toHaveBeenCalled();
    state.snapshot = { ...snapshot(), projects: [] };
    await act(async () => rendered!.update(<SharedHostSettings host={host} />));
    expect(step("Workspace").props.open).toBe(false);
    expect(step("Repository").props.open).toBe(true);
  });
  it("registers the existing local project with a canonical remote and persists its identity", async () => {
    state.snapshot = { ...snapshot(), projects: [] };
    await render();
    await act(async () => button("Register project").props.onClick());
    expect(state.registerProject).toHaveBeenCalledWith({
      environmentId,
      input: {
        requestId: expect.any(String),
        hostProjectId: projectId,
        name: "Catalog",
        repository: "github.com/example/catalog",
      },
    });
    expect(
      readSharedHostSetup({ environmentId, workspaceId: "product", projectId }).project
        ?.sharedProjectId,
    ).toBe("shared-catalog");
    expect(text()).toContain("Project specialists");
    expect(step("Repository").props.open).toBe(false);
    expect(step("Specialist").props.open).toBe(true);
  });
  it("shows host verification errors without pretending the project is registered", async () => {
    state.snapshot = { ...snapshot(), projects: [] };
    state.registerProject.mockResolvedValue({
      _tag: "Failure",
      cause: "The current Git remote differs from this registration.",
    });
    await render();
    await act(async () => button("Register project").props.onClick());
    expect(text()).toContain("current Git remote differs");
    expect(text()).toContain("Retry project registration");
    expect(text()).not.toContain("Ongoing responsibility");
  });
  it("does not invent a model when no account-backed model is available", async () => {
    await render();
    await change("Shared specialist name", "Search");
    await change("Shared specialist responsibility", "Own search relevance");
    expect(button("Create and share specialist").props.disabled).toBe(true);
    await submitSpecialist();
    expect(state.create).not.toHaveBeenCalled();
  });
  it("creates a specialist with the authenticated catalog model and repository-only access", async () => {
    state.providers = [
      {
        instanceId,
        driver: ProviderDriverKind.make("meerkat"),
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: now,
        models: [
          {
            slug: "account-model",
            name: "Connected account model",
            isDefault: true,
            isCustom: false,
            credentialState: "connected",
            capabilities: {},
          },
        ],
        slashCommands: [],
        skills: [],
      },
    ];
    await render();
    await change("Shared specialist name", "Search");
    await change("Shared specialist responsibility", "Own search relevance");
    expect(button("Create and share specialist").props.disabled).toBe(false);
    await submitSpecialist();
    expect(state.create).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        requestId: expect.any(String),
        projectId,
        instanceId,
        label: "Search",
        role: "search",
        instructions: "Own search relevance",
        model: "account-model",
        options: [],
        accessMode: "repository-read-only",
      },
    });
    expect(state.registerSpecialist).toHaveBeenCalledOnce();
    expect(text()).toContain("Registered in this shared workspace");
    expect(step("Workspace").props.open).toBe(false);
    expect(step("Repository").props.open).toBe(false);
    expect(step("Specialist").props.open).toBe(false);
    expect(state.focus).toHaveBeenCalledOnce();
  });
  it("can register an existing repository-only specialist without a new model or new agent", async () => {
    state.agents = [
      agent,
      { ...agent, agentId: "full-access-agent", label: "Full access", accessMode: "full-access" },
    ];
    await render();
    expect(
      rendered!.root
        .findAllByType("option")
        .some((entry) => entry.props.value === "full-access-agent"),
    ).toBe(false);
    await act(async () =>
      rendered!.root
        .findAllByType("select")
        .find((entry) => entry.props.value === "new")!
        .props.onValueChange(agent.agentId),
    );
    await submitSpecialist();
    expect(state.create).not.toHaveBeenCalled();
    expect(state.connect).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { projectId, agentId: agent.agentId, action: "connect" },
    });
    expect(state.registerSpecialist).toHaveBeenCalledWith({
      environmentId,
      input: {
        requestId: expect.any(String),
        nativeTarget: { projectId, instanceId, agentId: agent.agentId },
        label: agent.label,
        assignments: [
          { sharedProjectId: "shared-catalog", charter: agent.instructions, paths: [], tags: [] },
        ],
      },
    });
    expect(text()).toContain("Existing agent binding:");
    expect(text()).toContain("Registered in this shared workspace");
  });
  it("keeps a lost registration recoverable after the settings component remounts", async () => {
    state.agents = [agent];
    state.registerSpecialist.mockResolvedValueOnce({ _tag: "Failure", cause: "Connection lost" });
    await render();
    await act(async () =>
      rendered!.root
        .findAllByType("select")
        .find((entry) => entry.props.value === "new")!
        .props.onValueChange(agent.agentId),
    );
    await submitSpecialist();
    const first = state.registerSpecialist.mock.calls[0];
    expect(text()).toContain("Resume specialist setup");
    state.snapshot = {
      ...snapshot(),
      specialists: [
        {
          specialistId: "shared-search",
          nativeTarget: { projectId, instanceId, agentId: agent.agentId },
          label: agent.label,
          assignments: [
            { sharedProjectId: "shared-catalog", charter: agent.instructions, paths: [], tags: [] },
          ],
          assignmentVersion: 0,
          supersededAt: null,
          successorId: null,
          createdAt: now,
        },
      ],
    };
    await act(async () => rendered!.unmount());
    await render();
    expect(text()).toContain("Resume specialist setup");
    expect(text()).not.toContain("Add another specialist");
    expect(step("Specialist").props.open).toBe(true);
    await act(async () => button("Resume specialist setup").props.onClick());
    expect(state.registerSpecialist.mock.calls[1]).toEqual(first);
    expect(state.create).not.toHaveBeenCalled();
  });
  it("explains the missing local project rather than showing other machines' repositories", async () => {
    state.projects = [{ ...project, environmentId: EnvironmentId.make("other") }];
    await render();
    expect(text()).toContain("Choose a checkout for this host");
    expect(text()).toContain("Add host repository");
    expect(text()).not.toContain("/work/catalog");
  });
});

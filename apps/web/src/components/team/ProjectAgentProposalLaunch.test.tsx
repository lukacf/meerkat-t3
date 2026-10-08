import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ProviderOptionSelections,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";

type Config = Pick<ServerConfig, "providers" | "settings">;
const state = vi.hoisted(() => ({
  visible: null as Config | null,
  latest: null as Config | null,
  create: vi.fn(),
  bind: vi.fn(),
  start: vi.fn(),
  navigate: vi.fn(),
  threadShellReady: false,
  search: {} as Record<string, unknown>,
}));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: "configs" }));
vi.mock("../../rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => new Map([["environment", state.latest]]) },
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ environmentId: "environment", serverConfig: state.visible }],
  }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [{ environmentId: "environment", id: "project", workspaceRoot: "/b" }],
  useThreadShell: (ref: unknown) => (state.threadShellReady && ref ? {} : null),
}));
vi.mock("../../hooks/useProviderWorkspaceReadiness", async () => {
  const { resolveProviderWorkspaceReadiness } =
    await import("@t3tools/client-runtime/providerWorkspaceReadiness");
  return {
    useProviderWorkspaceReadiness: ({
      providers,
      cwd,
    }: {
      providers: ServerProvider[];
      cwd?: string;
    }) => resolveProviderWorkspaceReadiness(providers, cwd),
  };
});
vi.mock("../../state/meerkatTeam", () => ({
  meerkatTeamEnvironment: { projectProposal: () => "query", projectProposalSetup: "bind" },
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { create: "create", startTurn: "start" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "create" | "bind" | "start") => state[command],
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { available: true }, isPending: false, error: null }),
  formatEnvironmentQueryError: () => "Request failed",
}));
vi.mock("./useRestoreReview", () => ({
  readRestoreReviewWorkBlock: () => null,
  useRestoreReviewWorkBlock: () => null,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => state.navigate,
    Link: "a",
    createFileRoute:
      () =>
      (options: {
        component: () => ReactNode;
        validateSearch: (search: Record<string, unknown>) => unknown;
      }) => ({
        options,
        useParams: () => ({ environmentId: "environment", projectId: "project" }),
        useSearch: () => options.validateSearch(state.search),
      }),
    redirect: vi.fn(),
  };
});
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("../ui/select", () => ({
  Select: ({
    onValueChange,
    ...props
  }: {
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => <select {...props} onChange={(event) => onValueChange(event.target.value)} />,
  SelectItem: "option",
  SelectPopup: "optgroup",
  SelectTrigger: "span",
  SelectValue: "output",
}));
import { ProjectAgentProposalLaunch } from "./ProjectAgentProposalLaunch";
import { Route as ProposalRoute } from "../../routes/$environmentId.projects.$projectId.agents.propose";

const environmentId = EnvironmentId.make("environment");
const projectId = ProjectId.make("project");
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const native: ServerProvider = {
    instanceId: ProviderInstanceId.make("native"),
    driver: ProviderDriverKind.make("meerkat"),
    enabled: true,
    installed: true,
    version: null,
    status: "warning",
    auth: { status: "unauthenticated" },
    checkedAt: "2026-10-04T00:00:00.000Z",
    models: [],
    skills: [],
    slashCommands: [],
    supportsWorkspaceReadiness: true,
    workspaceSnapshots: [
      {
        cwd: "/b",
        checkedAt: "2026-10-04T00:00:00.000Z",
        skills: [],
        slashCommands: [],
        readiness: {
          status: "ready",
          auth: { status: "authenticated" },
          models: ["one", "two"].map((id) => ({
            slug: `openai:${id}`,
            name: id,
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                { id: "prompt_cache_enabled", label: "Prompt caching", type: "boolean" as const },
                {
                  id: "reasoning_effort",
                  label: "Effort",
                  type: "select" as const,
                  options: (id === "one" ? ["low", "high"] : ["low"]).map((value) => ({
                    id: value,
                    label: value === "high" ? "High" : "Low",
                  })),
                },
              ],
            },
            credentialState: "connected",
          })),
        },
      },
    ],
  };
  state.visible = state.latest = {
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: { [native.instanceId]: { driver: native.driver, config: {} } },
    },
    providers: [native],
  };
  state.create.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  state.bind.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  state.start.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  state.navigate.mockReset();
  state.threadShellReady = false;
  state.search = {};
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
const launch = () =>
  renderer!.root
    .findAllByType("button")
    .find((button) => button.children.join("") === "Start repository study")!;
const retry = () =>
  renderer!.root
    .findAllByType("button")
    .find((button) => button.children.join("") === "Retry setup")!;
const select = (label: string) =>
  renderer!.root
    .findAllByType("select")
    .find((entry) => entry.findAllByProps({ "aria-label": label }).length > 0)!;
const changeSelect = (label: string, value: string) =>
  act(async () => select(label).props.onChange({ target: { value } }));

function proposal(selectedModel?: ModelSelection) {
  return (
    <ProjectAgentProposalLaunch
      environmentId={environmentId}
      projectId={projectId}
      {...(selectedModel ? { selectedModel } : {})}
    />
  );
}
async function renderRoute() {
  const Component = ProposalRoute.options.component!;
  await Component.preload?.();
  return <Component />;
}

const routeOptions: Array<{ options: ProviderOptionSelections | undefined }> = [
  { options: undefined },
  { options: [] },
  { options: [{ id: "reasoning_effort", value: "high" }] },
];
it.each(routeOptions)(
  "preserves declared route reasoning through creation and the first study message (%j)",
  async ({ options }) => {
    state.search = {
      instance: "native",
      model: "openai:one",
      ...(options !== undefined ? { options } : {}),
    };
    await act(async () => {
      renderer = create(await renderRoute());
    });
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Prompt caching");
    await act(async () => launch().props.onClick());
    const expected = {
      instanceId: "native",
      model: "openai:one",
      ...(options !== undefined ? { options } : {}),
    };
    expect(state.create.mock.calls[0]![0].input.modelSelection).toEqual(expected);
    expect(state.start.mock.calls[0]![0].input.modelSelection).toEqual(expected);
  },
);

it("clears inherited reasoning on model change and sends the newly declared level", async () => {
  await act(async () => {
    renderer = create(
      proposal({
        instanceId: ProviderInstanceId.make("native"),
        model: "openai:one",
        options: [{ id: "reasoning_effort", value: "high" }],
      }),
    );
  });
  await changeSelect("Agent model", "openai:two");
  expect(select("Agent reasoning level").props.value).toBe("default");
  await changeSelect("Agent reasoning level", "low");
  await act(async () => launch().props.onClick());
  expect(state.create.mock.calls[0]![0].input.modelSelection).toEqual({
    instanceId: "native",
    model: "openai:two",
    options: [{ id: "reasoning_effort", value: "low" }],
  });
  expect(state.start.mock.calls[0]![0].input.modelSelection).toEqual(
    state.create.mock.calls[0]![0].input.modelSelection,
  );
});

it("keeps unsupported saved reasoning visible and requires an explicit supported choice", async () => {
  state.search = {
    instance: "native",
    model: "openai:one",
    options: [{ id: "reasoning_effort", value: "removed" }],
  };
  await act(async () => {
    renderer = create(await renderRoute());
  });
  expect(JSON.stringify(renderer!.toJSON())).toContain("removed (unavailable)");
  expect(launch().props.disabled).toBe(true);
  await act(async () => launch().props.onClick());
  expect(state.create).not.toHaveBeenCalled();
  expect(state.bind).not.toHaveBeenCalled();
  expect(state.start).not.toHaveBeenCalled();
  await changeSelect("Agent reasoning level", "default");
  await act(async () => launch().props.onClick());
  expect(state.create.mock.calls[0]![0].input.modelSelection.options).toEqual([]);
  expect(state.start.mock.calls[0]![0].input.modelSelection.options).toEqual([]);
});

it("retains the original reasoning after a failed bind even if defaults change before retry", async () => {
  const original: ModelSelection = {
    instanceId: ProviderInstanceId.make("native"),
    model: "openai:one",
    options: [{ id: "reasoning_effort", value: "high" }],
  };
  state.bind.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("Response lost") });
  await act(async () => {
    renderer = create(proposal(original));
  });
  await act(async () => launch().props.onClick());
  expect(state.create).toHaveBeenCalledOnce();
  expect(state.start).not.toHaveBeenCalled();
  await act(async () =>
    renderer!.update(
      proposal({
        ...original,
        model: "openai:two",
        options: [{ id: "reasoning_effort", value: "low" }],
      }),
    ),
  );
  expect(select("Agent model").props.value).toBe("openai:one");
  expect(select("Agent reasoning level").props.value).toBe("high");
  expect(renderer!.root.findAllByType("select").every((entry) => entry.props.disabled)).toBe(true);
  await act(async () => retry().props.onClick());
  expect(state.create).toHaveBeenCalledOnce();
  expect(state.start.mock.calls[0]![0].input.modelSelection).toEqual(original);
});

it("opens the created conversation without starting when reasoning remains unavailable after binding", async () => {
  const ready = state.latest!;
  const original: ModelSelection = {
    instanceId: ProviderInstanceId.make("native"),
    model: "openai:one",
    options: [{ id: "reasoning_effort", value: "high" }],
  };
  state.bind.mockImplementationOnce(async () => {
    state.latest = {
      ...ready,
      providers: ready.providers.map((provider) => ({
        ...provider,
        workspaceSnapshots: (provider.workspaceSnapshots ?? []).map((snapshot) => {
          const readiness = snapshot.readiness;
          return readiness?.status === "ready"
            ? {
                ...snapshot,
                readiness: {
                  ...readiness,
                  models: readiness.models.map((model) => ({
                    ...model,
                    capabilities: { optionDescriptors: [] },
                  })),
                },
              }
            : snapshot;
        }),
      })),
    };
    return { _tag: "Success", value: {} };
  });
  await act(async () => {
    renderer = create(proposal(original));
  });
  await act(async () => launch().props.onClick());
  expect(state.create).toHaveBeenCalledOnce();
  expect(state.bind).toHaveBeenCalledOnce();
  expect(state.start).not.toHaveBeenCalled();
  expect(renderer!.root.findByProps({ role: "alert" }).children.join("")).toContain(
    "The saved reasoning level is unavailable",
  );
  state.visible = state.latest;
  await act(async () => renderer!.update(proposal(original)));
  expect(renderer!.root.findAllByType("select")).toHaveLength(0);
  expect(JSON.stringify(renderer!.toJSON())).toContain("high (unavailable)");
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("Choose a supported level");
  const open = renderer!.root
    .findAllByType("button")
    .find((button) => button.children.join("") === "Open setup conversation")!;
  expect(open.props.disabled).toBe(false);
  expect(state.navigate).not.toHaveBeenCalled();
  await act(async () => open.props.onClick());
  expect(state.navigate).not.toHaveBeenCalled();
  state.threadShellReady = true;
  await act(async () => renderer!.update(proposal(original)));
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: state.create.mock.calls[0]![0].input.threadId },
    replace: true,
  });
  expect(state.create).toHaveBeenCalledOnce();
  expect(state.bind).toHaveBeenCalledOnce();
  expect(state.start).not.toHaveBeenCalled();
  expect(state.create.mock.calls[0]![0].input.modelSelection).toEqual(original);
});

it("leaves model choice editable when scoped auth invalidates before the first click", async () => {
  await act(async () => {
    renderer = create(
      <ProjectAgentProposalLaunch environmentId={environmentId} projectId={projectId} />,
    );
  });
  const ready = state.latest!;
  state.latest = {
    ...ready,
    providers: ready.providers.map((provider) => ({ ...provider, workspaceSnapshots: [] })),
  };
  await act(async () => launch().props.onClick());
  expect(state.create).not.toHaveBeenCalled();
  expect(renderer!.root.findByProps({ role: "alert" }).children.join("")).toContain(
    "Checking models for this workspace",
  );
  expect(renderer!.root.findAllByType("select").every((select) => !select.props.disabled)).toBe(
    true,
  );
  await act(async () =>
    renderer!.root.findAllByType("select")[1]!.props.onChange({ target: { value: "openai:two" } }),
  );
  state.latest = ready;
  await act(async () => launch().props.onClick());
  expect(state.create).toHaveBeenCalledOnce();
  expect(state.create.mock.calls[0]![0].input.modelSelection.model).toBe("openai:two");
  expect(state.start).toHaveBeenCalledOnce();
});

it("does not start model work if the workspace check disappears during setup binding", async () => {
  state.bind.mockImplementation(async () => {
    state.latest = {
      ...state.latest!,
      providers: state.latest!.providers.map((provider) => ({
        ...provider,
        workspaceSnapshots: [],
      })),
    };
    return { _tag: "Success", value: {} };
  });
  await act(async () => {
    renderer = create(
      <ProjectAgentProposalLaunch environmentId={environmentId} projectId={projectId} />,
    );
  });
  await act(async () => launch().props.onClick());
  expect(state.create).toHaveBeenCalledOnce();
  expect(state.bind).toHaveBeenCalledOnce();
  expect(state.start).not.toHaveBeenCalled();
  expect(renderer!.root.findByProps({ role: "alert" }).children.join("")).toContain(
    "Checking models for this workspace",
  );
});

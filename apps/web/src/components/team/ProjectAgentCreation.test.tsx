import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  create: vi.fn(),
  navigate: vi.fn(),
  restoreBlock: null as string | null,
  modelBlock: null as { reason: string } | null,
  providers: [] as ServerProvider[],
  proposalError: null as string | null,
}));
vi.mock("../../hooks/useProviderWorkspaceReadiness", () => ({
  useProviderWorkspaceReadiness: ({ providers }: { providers: ServerProvider[] }) => ({
    providers,
    pendingInstanceIds: new Set(),
  }),
}));
vi.mock("../../state/meerkatTeam", () => ({
  meerkatTeamEnvironment: {
    projectAgentCreate: "create",
    projectAgents: () => "agents",
    projectProposal: () => "proposal",
  },
  useVisibleTeamRefresh: () => {},
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.create }));
vi.mock("../../state/query", () => ({
  formatEnvironmentQueryError: (cause: Error) => cause.message,
  useEnvironmentQuery: (query: string) => ({
    data: query === "agents" ? { agents: [] } : { available: true },
    error: query === "proposal" ? state.proposalError : null,
    isPending: false,
  }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { environmentId: "environment-a", id: "project-a", workspaceRoot: "/project-a" },
  ],
}));
vi.mock("../../state/projectClones", () => ({ useProjectClone: () => null }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "environment-a",
        entry: { target: { _tag: "PrimaryConnectionTarget" } },
        serverConfig: { providers: state.providers },
      },
    ],
  }),
}));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => new Map() } }));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("./agentModelReadiness", () => ({ getAgentModelSendBlock: () => state.modelBlock }));
vi.mock("./useRestoreReview", () => ({
  readRestoreReviewWorkBlock: () => state.restoreBlock,
  useRestoreReviewWorkBlock: () => state.restoreBlock,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate, Link: "a" }));
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    render: _render,
    ...props
  }: ComponentProps<"button"> & { render?: ReactNode }) => <button {...props}>{children}</button>,
}));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/select", () => ({
  Select: ({
    children,
    onValueChange,
    ...props
  }: {
    children: ReactNode;
    onValueChange: (value: string) => void;
  }) => (
    <select {...props} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: "span",
  SelectValue: "output",
  SelectPopup: "optgroup",
  SelectItem: "option",
}));
vi.mock("../ui/popover", () => ({
  Popover: "div",
  PopoverTrigger: "span",
  PopoverPopup: "div",
  PopoverTitle: "h3",
}));
vi.mock("../ui/tooltip", () => ({ Tooltip: "div", TooltipTrigger: "span", TooltipPopup: "span" }));

import { ProjectAgentSetup } from "./ProjectAgentSetup";
import { ProjectStart } from "./ProjectStart";
import { createProjectAgentCreationDraftStore } from "./projectAgentCreationDraftStore";

const scope = {
  environmentId: EnvironmentId.make("environment-a"),
  projectId: ProjectId.make("project-a"),
  cwd: "/project-a",
};
const instanceId = ProviderInstanceId.make("native-a");
const receipt = { agentId: "original-agent", projectId: scope.projectId, instanceId };
let renderer: ReactTestRenderer | undefined;
let storage: Storage;
function makeStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
    clear: () => entries.clear(),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((node) => node.children.includes(label))!;
function renderedText(
  node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null,
): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(renderedText).join("");
  return node?.children?.map(renderedText).join("") ?? "";
}
const text = () => renderedText(renderer?.toJSON() ?? null);
const changeSelect = (label: string, value: string) =>
  act(async () => {
    const select = renderer!.root
      .findAllByType("select")
      .find((node) => node.findAllByProps({ "aria-label": label }).length > 0)!;
    select.props.onChange({ target: { value } });
  });
const fill = async (label = "Security reviewer", instructions = "Check boundaries") => {
  await act(async () =>
    renderer!.root.findByType("input").props.onChange({ target: { value: label } }),
  );
  await act(async () =>
    renderer!.root.findByType("textarea").props.onChange({ target: { value: instructions } }),
  );
};
const submit = () =>
  act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => {} }));
const setup = (
  onCreated = vi.fn(),
  overrides: Partial<ComponentProps<typeof ProjectAgentSetup>> = {},
) => (
  <ProjectAgentSetup
    {...scope}
    providers={state.providers}
    onCreated={onCreated}
    onCancel={() => {}}
    {...overrides}
  />
);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  storage = makeStorage();
  vi.stubGlobal("localStorage", storage);
  state.create
    .mockReset()
    .mockResolvedValue({ _tag: "Failure", cause: new Error("Response lost") });
  state.navigate.mockReset();
  state.restoreBlock = null;
  state.modelBlock = null;
  state.proposalError = null;
  state.providers = [
    {
      instanceId,
      driver: ProviderDriverKind.make("meerkat"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-04T00:00:00.000Z",
      models: [
        {
          slug: "openai:review-model",
          name: "Review model",
          isDefault: true,
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              { id: "prompt_cache_enabled", label: "Prompt caching", type: "boolean" },
              {
                id: "reasoning_effort",
                label: "Effort",
                type: "select",
                options: [
                  { id: "low", label: "Low" },
                  { id: "high", label: "High" },
                ],
              },
            ],
          },
          credentialState: "connected",
        },
      ],
      skills: [],
      slashCommands: [],
    },
  ];
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("shares only matching composer account guidance while retaining agent creation gates and distinct errors", async () => {
  const modelSelection = { instanceId, model: "openai:review-model" };
  state.providers = state.providers.map((provider) => ({
    ...provider,
    status: "warning",
    auth: { status: "unauthenticated" },
    models: provider.models.map((model) => ({ ...model, credentialState: "needs_auth" })),
  }));
  const accountSetup = {
    ...modelSelection,
    environmentId: scope.environmentId,
    cwd: scope.cwd,
    replacesProviderBanner: true,
    providerMessage: "Connect the project account.",
  };
  const renderStart = (
    notice: ComponentProps<typeof ProjectStart>["accountSetup"] = accountSetup,
  ) => (
    <ProjectStart
      environmentId={scope.environmentId}
      projectId={scope.projectId}
      modelSelection={modelSelection}
      accountSetup={notice}
    />
  );
  await act(async () => {
    renderer = create(renderStart());
  });
  expect(text()).not.toContain("No usable model");
  await act(async () => button("Add agent").props.onClick());
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/projects/$projectId/agents/new",
    params: { environmentId: scope.environmentId, projectId: scope.projectId },
    search: {},
  });
  expect(state.create).not.toHaveBeenCalled();

  state.proposalError = "The proposal capability check failed.";
  await act(async () => renderer!.update(renderStart()));
  expect(text()).toContain(state.proposalError);
  for (const changed of [
    { environmentId: EnvironmentId.make("another-environment") },
    { cwd: "/another-checkout" },
    { instanceId: ProviderInstanceId.make("another-provider") },
    { model: "anthropic:other" },
  ]) {
    await act(async () => renderer!.update(renderStart({ ...accountSetup, ...changed })));
    expect(text()).toContain("No usable model");
    expect(text()).toContain(state.proposalError);
  }
  state.providers = state.providers.map((provider) => ({
    ...provider,
    auth: { status: "unknown" },
    models: [],
  }));
  await act(async () => renderer!.update(renderStart()));
  expect(text()).toContain("No usable model");
  expect(state.create).not.toHaveBeenCalled();
});

it("creates a local collaborator with the preferred reasoning and no visible cache control", async () => {
  const options = [{ id: "reasoning_effort", value: "high" }];
  await act(async () => {
    renderer = create(
      setup(vi.fn(), { preferredModel: { instanceId, model: "openai:review-model", options } }),
    );
  });
  expect(text()).toContain("Reasoning level");
  expect(text()).toContain("High");
  expect(text()).toContain("Read and collaborate");
  expect(text()).not.toContain("Prompt caching");
  await fill();
  await submit();
  expect(state.create.mock.calls[0]![0].input.options).toEqual(options);
  expect(state.create.mock.calls[0]![0].input.accessMode).toBe("read-and-collaborate");
  expect(
    createProjectAgentCreationDraftStore(scope, storage).getState().draft.value.options,
  ).toEqual(options);
});

it("keeps qualified menu identity while showing a short selected model and submitting its exact slug", async () => {
  state.providers = state.providers.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => ({
      ...model,
      name: `[${model.slug}] ${model.name}`,
      shortName: model.name,
    })),
  }));
  await act(async () => {
    renderer = create(setup());
  });
  const trigger = renderer!.root.findByProps({ "aria-label": "Agent model" });
  expect(trigger.findByType("output").children.join("")).toBe("Review model");
  expect(trigger.props.title).toBe("[openai:review-model] Review model");
  expect(
    renderer!.root
      .findAllByType("option")
      .find((node) => node.props.value === "openai:review-model")
      ?.children.join(""),
  ).toBe("[openai:review-model] Review model");
  await fill();
  await submit();
  expect(state.create.mock.calls[0]![0].input.model).toBe("openai:review-model");
});

it("keeps the displayed reasoning with a saved form after its preferred defaults change", async () => {
  const preferredModel = {
    instanceId,
    model: "openai:review-model",
    options: [{ id: "reasoning_effort", value: "high" }],
  };
  await act(async () => {
    renderer = create(setup(vi.fn(), { preferredModel }));
  });
  await fill();
  await act(async () => renderer!.unmount());
  await act(async () => {
    renderer = create(
      setup(vi.fn(), {
        preferredModel: { ...preferredModel, options: [{ id: "reasoning_effort", value: "low" }] },
      }),
    );
  });
  await submit();
  expect(state.create.mock.calls[0]![0].input.options).toEqual(preferredModel.options);
});

it("restores unavailable reasoning without substituting a default, then accepts an explicit change", async () => {
  await act(async () => {
    renderer = create(setup());
  });
  await fill();
  await changeSelect("Agent reasoning level", "high");
  await act(async () => renderer!.unmount());
  state.providers[0] = {
    ...state.providers[0]!,
    models: [
      {
        ...state.providers[0]!.models[0]!,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoning_effort",
              label: "Effort",
              type: "select",
              options: [{ id: "low", label: "Low" }],
            },
          ],
        },
      },
    ],
  };
  await act(async () => {
    renderer = create(setup());
  });
  expect(text()).toContain("high (unavailable)");
  await submit();
  expect(state.create).not.toHaveBeenCalled();
  expect(
    createProjectAgentCreationDraftStore(scope, storage).getState().draft.value.options,
  ).toEqual([{ id: "reasoning_effort", value: "high" }]);
  await changeSelect("Agent reasoning level", "default");
  await submit();
  expect(state.create.mock.calls[0]![0].input.options).toEqual([]);
});

it("clears old reasoning on an explicit model change before a new selection", async () => {
  state.providers[0] = {
    ...state.providers[0]!,
    models: [
      ...state.providers[0]!.models,
      {
        slug: "anthropic:other",
        name: "Other model",
        isDefault: false,
        isCustom: false,
        credentialState: "connected",
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: [{ id: "medium", label: "Medium" }],
            },
          ],
        },
      },
    ],
  };
  await act(async () => {
    renderer = create(
      setup(vi.fn(), {
        preferredModel: {
          instanceId,
          model: "openai:review-model",
          options: [{ id: "reasoning_effort", value: "high" }],
        },
      }),
    );
  });
  await fill();
  await changeSelect("Agent model", "anthropic:other");
  expect(
    createProjectAgentCreationDraftStore(scope, storage).getState().draft.value.options,
  ).toEqual([]);
  await changeSelect("Agent reasoning level", "medium");
  await submit();
  expect(state.create.mock.calls[0]![0].input).toMatchObject({
    model: "anthropic:other",
    options: [{ id: "effort", value: "medium" }],
  });
});

it("clears reasoning when the user chooses another provider", async () => {
  const other = ProviderInstanceId.make("native-b");
  state.providers.push({ ...state.providers[0]!, instanceId: other });
  await act(async () => {
    renderer = create(
      setup(vi.fn(), {
        preferredModel: {
          instanceId,
          model: "openai:review-model",
          options: [{ id: "reasoning_effort", value: "high" }],
        },
      }),
    );
  });
  await fill();
  await changeSelect("Agent provider", other);
  await submit();
  expect(state.create.mock.calls[0]![0].input).toMatchObject({ instanceId: other, options: [] });
});

it("carries reasoning into both setup routes and retains a legacy request after composer changes", async () => {
  const original = {
    instanceId,
    model: "openai:review-model",
    options: [{ id: "reasoning_effort", value: "high" }],
  };
  const legacy = createProjectAgentCreationDraftStore(scope, storage, () => "legacy-preset");
  const saved = legacy.getState().beginPreset({
    ...original,
    projectId: scope.projectId,
    label: "Architect",
    role: "architect",
    instructions: "Saved architecture assignment",
    accessMode: "read-only",
  })!;
  legacy.getState().finish(saved.input.requestId, "Response lost");
  const renderStart = (modelSelection = original) => (
    <ProjectStart
      environmentId={scope.environmentId}
      projectId={scope.projectId}
      modelSelection={modelSelection}
    />
  );
  await act(async () => {
    renderer = create(renderStart());
  });
  await act(async () => button("Add agent").props.onClick());
  expect(state.navigate).toHaveBeenCalledWith(
    expect.objectContaining({
      to: "/$environmentId/projects/$projectId/agents/new",
      search: { instance: instanceId, model: original.model, options: original.options },
    }),
  );
  await act(async () => button("Suggest agents").props.onClick());
  expect(state.navigate).toHaveBeenCalledWith(
    expect.objectContaining({
      to: "/$environmentId/projects/$projectId/agents/propose",
      search: { instance: instanceId, model: original.model, options: original.options },
    }),
  );
  expect(state.create).not.toHaveBeenCalled();
  await act(async () => button("Retry same request").props.onClick());
  const first = state.create.mock.calls[0]![0];
  expect(first.input).toEqual(saved.input);
  expect(first.input.options).toEqual(original.options);
  await act(async () => renderer!.unmount());
  await act(async () => {
    renderer = create(
      renderStart({ ...original, options: [{ id: "reasoning_effort", value: "low" }] }),
    );
  });
  await act(async () => button("Retry same request").props.onClick());
  expect(state.create).toHaveBeenNthCalledWith(2, first);
});

it("reopens an uncertain custom request without auto-submitting and retries its original payload", async () => {
  await act(async () => {
    renderer = create(setup());
  });
  await fill();
  await submit();
  const first = state.create.mock.calls[0]![0];
  expect(state.create).toHaveBeenCalledTimes(1);
  await act(async () => renderer!.unmount());
  await act(async () => {
    renderer = create(setup());
  });
  expect(state.create).toHaveBeenCalledTimes(1);
  expect(renderer!.root.findByType("input").props.value).toBe("Security reviewer");
  expect(text()).toContain("settings are locked");
  state.providers = [];
  await act(async () => renderer!.update(setup()));
  await act(async () => button("Retry same request").props.onClick());
  expect(state.create).toHaveBeenNthCalledWith(2, first);
});

it("retains failed input and old recovery when the user explicitly edits a new request", async () => {
  await act(async () => {
    renderer = create(setup());
  });
  await fill();
  await submit();
  const first = state.create.mock.calls[0]![0];
  await act(async () => button("Edit as a new request").props.onClick());
  expect(renderer!.root.findByType("textarea").props.value).toBe("Check boundaries");
  await fill("Security reviewer", "Corrected boundaries");
  await submit();
  const second = state.create.mock.calls[1]![0];
  expect(second.input.requestId).not.toBe(first.input.requestId);
  expect(second.input.instructions).toBe("Corrected boundaries");
  await act(async () => button("Discard draft").props.onClick());
  expect(renderer!.root.findByType("input").props.value).toBe("");
  expect(createProjectAgentCreationDraftStore(scope, storage).getState().attempts).toHaveLength(2);
  expect(
    renderer!.root
      .findAllByType("button")
      .filter((node) => node.children.includes("Retry same request")),
  ).toHaveLength(2);
});

it("saves a late accepted response to its old project without navigating the new project", async () => {
  const pending = deferred<{ _tag: "Success"; value: typeof receipt }>();
  state.create.mockReturnValueOnce(pending.promise);
  const oldCreated = vi.fn();
  const newCreated = vi.fn();
  await act(async () => {
    renderer = create(setup(oldCreated));
  });
  await fill();
  await submit();
  await act(async () =>
    renderer!.update(
      setup(newCreated, { projectId: ProjectId.make("project-b"), cwd: "/project-b" }),
    ),
  );
  expect(renderer!.root.findByType("input").props.value).toBe("");
  await act(async () => pending.resolve({ _tag: "Success", value: receipt }));
  expect(oldCreated).not.toHaveBeenCalled();
  expect(newCreated).not.toHaveBeenCalled();
  await act(async () => renderer!.update(setup(oldCreated)));
  expect(text()).toContain("Created");
  await act(async () => button("Open created agent").props.onClick());
  expect(oldCreated).toHaveBeenCalledExactlyOnceWith(receipt);
  expect(state.create).toHaveBeenCalledTimes(1);
});

it("does not dispatch a captured submit after its project scope changes", async () => {
  await act(async () => {
    renderer = create(setup());
  });
  await fill();
  const oldSubmit = renderer!.root.findByType("form").props.onSubmit;
  const nextScope = { projectId: ProjectId.make("project-b"), cwd: "/project-b" };
  await act(async () => renderer!.update(setup(vi.fn(), nextScope)));
  await act(async () => oldSubmit({ preventDefault: () => {} }));
  expect(state.create).not.toHaveBeenCalled();
  const oldStore = createProjectAgentCreationDraftStore(scope, storage).getState();
  expect(oldStore.attempts).toHaveLength(1);
  expect(oldStore.attempts[0]!.input.instructions).toBe("Check boundaries");
  expect(oldStore.pendingIds).toEqual([]);
  expect(
    createProjectAgentCreationDraftStore({ ...scope, ...nextScope }, storage).getState().attempts,
  ).toEqual([]);
  await act(async () => renderer!.update(setup()));
  await act(async () => button("Retry same request").props.onClick());
  expect(state.create).toHaveBeenCalledExactlyOnceWith({
    environmentId: scope.environmentId,
    input: oldStore.attempts[0]!.input,
  });
});

it("does not dispatch a captured recovery action after unmount", async () => {
  await act(async () => {
    renderer = create(setup());
  });
  await fill();
  await submit();
  const oldRetry = button("Retry same request").props.onClick;
  const original = state.create.mock.calls[0]![0];
  await act(async () => renderer!.unmount());
  await act(async () => oldRetry());
  expect(state.create).toHaveBeenCalledTimes(1);
  const recovered = createProjectAgentCreationDraftStore(scope, storage).getState();
  expect(recovered.attempts[0]!.input).toEqual(original.input);
  expect(recovered.pendingIds).toEqual([]);
});

it("blocks dispatch when the request cannot be persisted and keeps typed instructions", async () => {
  await act(async () => {
    renderer = create(setup());
  });
  await fill();
  const realSet = storage.setItem;
  storage.setItem = (key, value) => {
    if (key.includes(":request:")) throw new Error("quota");
    realSet(key, value);
  };
  await submit();
  expect(state.create).not.toHaveBeenCalled();
  expect(text()).toContain("Could not save");
  expect(renderer!.root.findByType("textarea").props.value).toBe("Check boundaries");
  storage.setItem = realSet;
  await submit();
  expect(state.create).toHaveBeenCalledTimes(1);
});

it("keeps restore-held creation passive while a saved acceptance can still open", async () => {
  state.create.mockResolvedValueOnce({ _tag: "Success", value: receipt });
  const onCreated = vi.fn();
  await act(async () => {
    renderer = create(setup(onCreated));
  });
  await fill();
  state.restoreBlock = "Restart required";
  await submit();
  expect(state.create).not.toHaveBeenCalled();
  state.restoreBlock = null;
  await submit();
  expect(onCreated).toHaveBeenCalledTimes(1);
  state.restoreBlock = "Restart required";
  await act(async () => renderer!.update(setup(onCreated)));
  await act(async () => button("Open created agent").props.onClick());
  expect(onCreated).toHaveBeenCalledTimes(2);
  expect(state.create).toHaveBeenCalledTimes(1);
});

it("preserves a legacy draft's role while its visible name and assignment are edited", async () => {
  const legacy = createProjectAgentCreationDraftStore(scope, storage, () => "legacy-draft");
  const saved = {
    custom: false,
    label: "Architect",
    role: "architect",
    instructions: "Saved architecture assignment",
    instanceId,
    chosenModel: "openai:review-model",
  };
  legacy.getState().updateDraft(saved);
  await act(async () => {
    renderer = create(setup());
  });
  expect(createProjectAgentCreationDraftStore(scope, storage).getState().draft.value).toMatchObject(
    saved,
  );
  expect(state.create).not.toHaveBeenCalled();
  await fill("Platform architecture", "Own the project's integration boundaries");
  await submit();
  expect(state.create.mock.calls[0]![0].input).toMatchObject({
    requestId: "legacy-draft",
    label: "Platform architecture",
    role: "architect",
    instructions: "Own the project's integration boundaries",
    instanceId,
    model: "openai:review-model",
  });
});

it("does not replace a recovered explicit model with a different catalog default", async () => {
  const store = createProjectAgentCreationDraftStore(scope, storage, () => "draft");
  store.getState().updateDraft({
    label: "Reviewer",
    role: "reviewer",
    instructions: "Saved input",
    instanceId,
    chosenModel: "openai:missing",
  });
  await act(async () => {
    renderer = create(setup());
  });
  expect(text()).toContain("openai:missing");
  await submit();
  expect(state.create).not.toHaveBeenCalled();
  expect(renderer!.root.findByType("textarea").props.value).toBe("Saved input");
});

it("waits for the exact checkout before editing or dispatching a setup", async () => {
  await act(async () => {
    renderer = create(setup(vi.fn(), { cwd: undefined }));
  });
  expect(renderer!.root.findByType("input").props.disabled).toBe(true);
  expect(text()).toContain("Loading the project checkout");
  await submit();
  expect(state.create).not.toHaveBeenCalled();
  expect(storage.length).toBe(0);
  await act(async () => renderer!.update(setup()));
  await fill("Loaded reviewer", "Known checkout only");
  await submit();
  expect(state.create).toHaveBeenCalledTimes(1);
  expect(
    createProjectAgentCreationDraftStore(scope, storage).getState().draft.value.instructions,
  ).toBe("Known checkout only");
});

it("recovers a legacy preset across remount even while the roster still reports no agents", async () => {
  const legacy = createProjectAgentCreationDraftStore(scope, storage, () => "legacy-preset");
  const saved = legacy.getState().beginPreset({
    projectId: scope.projectId,
    instanceId,
    label: "Architect",
    role: "architect",
    instructions: "Saved architecture assignment",
    model: "openai:review-model",
    accessMode: "read-only",
  })!;
  legacy.getState().finish(saved.input.requestId, "Response lost");
  const renderStart = () => (
    <ProjectStart
      environmentId={scope.environmentId}
      projectId={scope.projectId}
      modelSelection={null}
    />
  );
  await act(async () => {
    renderer = create(renderStart());
  });
  expect(state.create).not.toHaveBeenCalled();
  await act(async () => button("Retry same request").props.onClick());
  const first = state.create.mock.calls[0]![0];
  expect(first.input).toEqual(saved.input);
  await act(async () => renderer!.unmount());
  state.providers = [
    {
      ...state.providers[0]!,
      models: [
        {
          slug: "openai:changed-default",
          name: "Changed",
          isCustom: false,
          isDefault: true,
          capabilities: null,
        },
      ],
    },
  ];
  await act(async () => {
    renderer = create(renderStart());
  });
  expect(state.create).toHaveBeenCalledTimes(1);
  await act(async () => button("Retry same request").props.onClick());
  expect(state.create).toHaveBeenNthCalledWith(2, first);
  state.create.mockResolvedValueOnce({ _tag: "Success", value: receipt });
  await act(async () => button("Retry same request").props.onClick());
  expect(state.create).toHaveBeenNthCalledWith(3, first);
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/agents/$agentId",
    params: { environmentId: scope.environmentId, agentId: receipt.agentId },
    search: { project: scope.projectId },
  });
});

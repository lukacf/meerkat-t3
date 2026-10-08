import { act, useState, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import {
  EnvironmentId,
  type MeerkatAgentReasoningObservation,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  models: [] as ServerProviderModel[],
  scoped: {} as Partial<import("@t3tools/contracts").ServerProvider>,
}));
vi.mock("../../hooks/useProviderWorkspaceReadiness", () => ({
  useProviderWorkspaceReadiness: () => undefined,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "environment",
        serverConfig: {
          providers: [
            {
              instanceId: "native-work",
              driver: "meerkat",
              models: state.models,
              ...state.scoped,
            },
          ],
        },
      },
    ],
  }),
}));
vi.mock("@tanstack/react-router", () => ({ Link: "a" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: "section",
  PopoverTitle: "h2",
  PopoverTrigger: "button",
}));
vi.mock("../ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => children,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("../ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return children;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: ({ children }: { children: ReactNode }) => (
      <aside role="tooltip">{children}</aside>
    ),
  };
});
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

import { AgentModelControls } from "./AgentModelControls";

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.scoped = {};
  state.models = [
    {
      slug: "openai:example",
      name: "Example",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          { id: "prompt_cache_enabled", label: "Prompt caching", type: "boolean" },
          {
            id: "reasoning_effort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
              { id: "xhigh", label: "Xhigh" },
            ],
          },
        ],
      },
    },
  ];
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("sets reasoning on the current catalog model without requiring a redundant model pick", async () => {
  const onChange = vi.fn();
  await act(async () => {
    renderer = create(
      <AgentModelControls
        environmentId={EnvironmentId.make("environment")}
        instanceId={ProviderInstanceId.make("native-work")}
        settingsScope={{}}
        value={undefined}
        currentModel="example"
        onChange={onChange}
      />,
    );
  });
  await act(async () => {
    renderer!.root.findAllByType("select")[1]!.props.onChange({ target: { value: "high" } });
  });
  expect(onChange).toHaveBeenCalledExactlyOnceWith({
    instanceId: "native-work",
    model: "openai:example",
    options: [{ id: "reasoning_effort", value: "high" }],
  });
});

it("selects only the exact workspace model and retains a saved override while another scope loads", async () => {
  const onChange = vi.fn();
  const scopedModel: ServerProviderModel = {
    ...state.models[0]!,
    slug: "openai:project-b",
    name: "Project B",
    credentialState: "connected",
  };
  state.scoped = {
    supportsWorkspaceReadiness: true,
    models: state.models.map((model) => ({ ...model, credentialState: "needs_auth" })),
    workspaceSnapshots: [
      {
        cwd: "/b",
        checkedAt: "2026-10-04T00:00:00.000Z",
        skills: [],
        slashCommands: [],
        readiness: { status: "ready", auth: { status: "authenticated" }, models: [scopedModel] },
      },
    ],
  };
  const props = {
    environmentId: EnvironmentId.make("environment"),
    instanceId: ProviderInstanceId.make("native-work"),
    settingsScope: {},
    value: { instanceId: ProviderInstanceId.make("native-work"), model: scopedModel.slug },
    onChange,
  };
  await act(async () => {
    renderer = create(<AgentModelControls {...props} cwd="/b" />);
  });
  await act(async () =>
    renderer!.root
      .findAllByType("select")[0]!
      .props.onChange({ target: { value: scopedModel.slug } }),
  );
  expect(onChange).toHaveBeenCalledExactlyOnceWith(props.value);
  onChange.mockClear();
  await act(async () => renderer!.update(<AgentModelControls {...props} cwd="/b/worktree" />));
  await act(async () =>
    renderer!.root
      .findAllByType("select")[0]!
      .props.onChange({ target: { value: scopedModel.slug } }),
  );
  expect(onChange).not.toHaveBeenCalled();
  await act(async () =>
    renderer!.root.findAllByType("select")[0]!.props.onChange({ target: { value: "current" } }),
  );
  expect(onChange).toHaveBeenCalledExactlyOnceWith(undefined);
});

it("does not copy obsolete cache choices into a new reasoning selection", async () => {
  const onChange = vi.fn();
  await act(async () => {
    renderer = create(
      <AgentModelControls
        environmentId={EnvironmentId.make("environment")}
        instanceId={ProviderInstanceId.make("native-work")}
        settingsScope={{}}
        value={{
          instanceId: ProviderInstanceId.make("native-work"),
          model: "openai:example",
          options: [{ id: "prompt_cache_enabled", value: false }],
        }}
        currentModel="example"
        onChange={onChange}
      />,
    );
  });
  await act(async () => {
    renderer!.root.findAllByType("select")[1]!.props.onChange({ target: { value: "low" } });
  });
  expect(onChange).toHaveBeenCalledExactlyOnceWith({
    instanceId: "native-work",
    model: "openai:example",
    options: [{ id: "reasoning_effort", value: "low" }],
  });
});

it("keeps the closed reasoning label readable when selecting and resetting a level", async () => {
  function ControlledAgentModel() {
    const [value, setValue] = useState<ModelSelection | undefined>();
    return (
      <AgentModelControls
        environmentId={EnvironmentId.make("environment")}
        instanceId={ProviderInstanceId.make("native-work")}
        settingsScope={{}}
        value={value}
        currentModel="example"
        onChange={setValue}
      />
    );
  }
  await act(async () => {
    renderer = create(<ControlledAgentModel />);
  });
  const reasoningLabel = () =>
    renderer!.root
      .findByProps({ "aria-label": "Reasoning level" })
      .findByType("output")
      .children.join("");
  expect(reasoningLabel()).toBe("Reasoning level: Keep current");

  await act(async () => {
    renderer!.root.findAllByType("select")[1]!.props.onChange({ target: { value: "low" } });
  });
  expect(reasoningLabel()).toBe("Reasoning level: Low");

  await act(async () => {
    renderer!.root.findAllByType("select")[1]!.props.onChange({ target: { value: "default" } });
  });
  expect(reasoningLabel()).toBe("Reasoning level: Model default");

  await act(async () => {
    renderer!.root.findAllByType("select")[0]!.props.onChange({ target: { value: "current" } });
  });
  expect(reasoningLabel()).toBe("Reasoning level: Keep current");
});

it("follows native reasoning observations without replacing explicit next-message intent", async () => {
  const onChange = vi.fn();
  function Controls({ observed }: { observed: MeerkatAgentReasoningObservation | undefined }) {
    const [value, setValue] = useState<ModelSelection | undefined>();
    return (
      <AgentModelControls
        environmentId={EnvironmentId.make("environment")}
        instanceId={ProviderInstanceId.make("native-work")}
        settingsScope={{}}
        currentModel="example"
        currentModelProvider="openai"
        currentReasoning={observed}
        value={value}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
    );
  }
  const configured = (level: string): MeerkatAgentReasoningObservation => ({
    kind: "configured",
    values: [{ parameter: "reasoning_effort", value: level }],
  });
  const label = () =>
    renderer!.root
      .findByProps({ "aria-label": "Reasoning level" })
      .findByType("output")
      .children.join("");
  await act(async () => {
    renderer = create(<Controls observed={configured("xhigh")} />);
  });
  expect(label()).toBe("Reasoning level: Current: Xhigh");
  await act(async () => renderer!.update(<Controls observed={configured("high")} />));
  expect(label()).toBe("Reasoning level: Current: High");
  expect(onChange).not.toHaveBeenCalled();
  await act(async () =>
    renderer!.root.findAllByType("select")[1]!.props.onChange({ target: { value: "low" } }),
  );
  expect(onChange).toHaveBeenLastCalledWith({
    instanceId: "native-work",
    model: "openai:example",
    options: [{ id: "reasoning_effort", value: "low" }],
  });
  await act(async () => renderer!.update(<Controls observed={{ kind: "unknown" }} />));
  expect(label()).toBe("Reasoning level: Low");
  await act(async () =>
    renderer!.root.findAllByType("select")[0]!.props.onChange({ target: { value: "current" } }),
  );
  expect(label()).toBe("Reasoning level: Keep current");
  expect(onChange).toHaveBeenLastCalledWith(undefined);
  await act(async () => renderer!.update(<Controls observed={{ kind: "default" }} />));
  expect(label()).toBe("Reasoning level: Current: Model default");
  await act(async () => renderer!.update(<Controls observed={undefined} />));
  expect(label()).toBe("Reasoning level: Keep current");
});

it("shows independent native settings and nonpreset budgets without silently selecting them", async () => {
  const onChange = vi.fn();
  await act(async () => {
    renderer = create(
      <AgentModelControls
        environmentId={EnvironmentId.make("environment")}
        instanceId={ProviderInstanceId.make("native-work")}
        settingsScope={{}}
        currentModel="example"
        currentReasoning={{
          kind: "configured",
          values: [
            { parameter: "effort", value: "high" },
            { parameter: "thinking", value: "4500" },
          ],
        }}
        value={undefined}
        onChange={onChange}
      />,
    );
  });
  expect(
    renderer!.root
      .findByProps({ "aria-label": "Reasoning level" })
      .findByType("output")
      .children.join(""),
  ).toBe("Reasoning level: Current: High + 4,500 tokens");
  expect(
    renderer!.root
      .findAllByType("p")
      .some((node) =>
        node.children.join("").includes("Some current settings are not offered here"),
      ),
  ).toBe(true);
  expect(renderer!.root.findAllByType("select")[1]!.props.value).toBe("current");
  expect(onChange).not.toHaveBeenCalled();
});

it("uses the native provider to distinguish equal model ids while keeping selected labels short", async () => {
  state.models = [
    { ...state.models[0]!, name: "[openai:example] Example", shortName: "Example" },
    {
      ...state.models[0]!,
      slug: "self_hosted:example",
      name: "[self_hosted:example] Example",
      shortName: "Example",
    },
  ];
  const onChange = vi.fn();
  await act(async () => {
    renderer = create(
      <AgentModelControls
        environmentId={EnvironmentId.make("environment")}
        instanceId={ProviderInstanceId.make("native-work")}
        settingsScope={{}}
        currentModel="example"
        currentModelProvider="openai"
        value={undefined}
        onChange={onChange}
      />,
    );
  });
  const trigger = renderer!.root.findByProps({ "aria-label": "Choose model" });
  expect(trigger.findByType("output").children.join("")).toBe("Current: Example");
  expect(trigger.props.title).toBeUndefined();
  expect(
    renderer!.root.findAllByProps({ role: "tooltip" }).map((node) => node.children.join("")),
  ).toEqual(["[openai:example] Example", "[openai:example] Example"]);
  expect(
    renderer!.root
      .findAllByType("option")
      .filter((node) => String(node.props.value).endsWith(":example"))
      .map((node) => node.children.join("")),
  ).toEqual(["[openai:example] Example", "[self_hosted:example] Example"]);
  await act(async () =>
    renderer!.root.findAllByType("select")[1]!.props.onChange({ target: { value: "high" } }),
  );
  expect(onChange).toHaveBeenCalledExactlyOnceWith({
    instanceId: "native-work",
    model: "openai:example",
    options: [{ id: "reasoning_effort", value: "high" }],
  });
});

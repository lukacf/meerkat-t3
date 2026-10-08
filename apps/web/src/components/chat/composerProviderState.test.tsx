import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { getProviderOptionDescriptors } from "@t3tools/shared/model";
import { getProviderModelCapabilities } from "../../providerModels";
import { resolveMeerkatTurnDispatch } from "../../meerkatTurnDispatch";
import { ProviderInstanceId } from "@t3tools/contracts";
import { buildTraitsOptionSelections } from "./TraitsPicker";
import {
  getComposerPromptInjectionState,
  getComposerProviderState,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
  withImplicitFastModeDefault,
} from "./composerProviderState";

// Everything in composerProviderState is now data-driven by the model's
// optionDescriptors, so these tests use a single synthetic provider/model and
// vary only the descriptor shape per scenario.

const PROVIDER: ProviderDriverKind = ProviderDriverKind.make("codex");
const MODEL = "test-model";

function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  promptInjectedValues?: ReadonlyArray<string>,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  const defaultId = options.find((option) => option.isDefault)?.id;
  return {
    id,
    label: id,
    type: "select",
    options: [...options],
    ...(defaultId ? { currentValue: defaultId } : {}),
    ...(promptInjectedValues && promptInjectedValues.length > 0
      ? { promptInjectedValues: [...promptInjectedValues] }
      : {}),
  };
}

function booleanDescriptor(
  id: string,
  currentValue?: boolean,
): Extract<ProviderOptionDescriptor, { type: "boolean" }> {
  return {
    id,
    label: id,
    type: "boolean",
    ...(typeof currentValue === "boolean" ? { currentValue } : {}),
  };
}

function modelWith(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<ServerProviderModel> {
  return [
    { slug: MODEL, name: MODEL, isCustom: false, capabilities: { optionDescriptors: descriptors } },
  ];
}

function selections(
  ...entries: Array<[string, string | boolean]>
): ReadonlyArray<ProviderOptionSelection> {
  return entries.map(([id, value]) => ({ id, value }));
}

const ULTRATHINK_FRAME_CLASSES = {
  composerFrameClassName: "ultrathink-frame",
  composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.07)_inset]",
  modelPickerIconClassName: "ultrathink-chroma",
} as const;

describe("getComposerProviderState", () => {
  it("keeps unavailable native reasoning for admission while filtering hidden controls", () => {
    const state = getComposerProviderState({
      provider: ProviderDriverKind.make("meerkat"),
      model: MODEL,
      models: modelWith([
        selectDescriptor("reasoning_effort", [{ id: "low", label: "Low", isDefault: true }]),
      ]),
      modelOptions: selections(
        ["prompt_cache_enabled", false],
        ["reasoning_effort", "high"],
        ["reasoning_context", "all"],
      ),
      planModeEnabled: false,
    });
    expect(state.promptEffort).toBe("high");
    expect(state.modelOptionsForDispatch).toEqual(selections(["reasoning_effort", "high"]));
  });

  it("removes an explicit Model default draft choice before native dispatch", () => {
    const state = getComposerProviderState({
      provider: ProviderDriverKind.make("meerkat"),
      model: MODEL,
      models: modelWith([
        selectDescriptor("reasoning_effort", [{ id: "low", label: "Low", isDefault: true }]),
      ]),
      modelOptions: selections(["prompt_cache_enabled", false], ["reasoning_effort", "default"]),
      planModeEnabled: false,
    });
    expect(state.promptEffort).toBeNull();
    expect(state.modelOptionsForDispatch).toBeUndefined();
  });

  it("keeps steering on the original native option bag after reasoning metadata disappears", () => {
    const options = selections(["reasoning_effort", "high"], ["prompt_cache_enabled", false]);
    const activeModel = {
      instanceId: ProviderInstanceId.make("native-work"),
      model: MODEL,
      options,
    };
    const state = getComposerProviderState({
      provider: ProviderDriverKind.make("meerkat"),
      model: MODEL,
      models: modelWith([]),
      modelOptions: options,
      preserveNativeTurnOptions: true,
      planModeEnabled: false,
    });
    expect(state.modelOptionsForDispatch).toEqual(options);
    expect(
      resolveMeerkatTurnDispatch({
        provider: "meerkat",
        phase: "running",
        activeModel,
        selectedModel: {
          instanceId: activeModel.instanceId,
          model: activeModel.model,
          ...(state.modelOptionsForDispatch ? { options: state.modelOptionsForDispatch } : {}),
        },
      }),
    ).toEqual({ handlingMode: "steer", blockReason: null });
  });

  it("allows steering after changing native reasoning away from and back to its active level", () => {
    const provider = ProviderDriverKind.make("meerkat");
    const options = selections(
      ["prompt_cache_enabled", false],
      ["reasoning_context", "all"],
      ["reasoning_effort", "high"],
    );
    const descriptor = selectDescriptor("reasoning_effort", [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ]);
    const models = modelWith([descriptor]);
    const activeModel = {
      instanceId: ProviderInstanceId.make("native-work"),
      model: MODEL,
      options,
    };
    const state = getComposerProviderState({
      provider,
      model: MODEL,
      models,
      modelOptions: options,
      planModeEnabled: false,
      preserveNativeTurnOptions: true,
    });
    expect(
      resolveMeerkatTurnDispatch({
        provider: "meerkat",
        phase: "running",
        activeModel,
        selectedModel: {
          instanceId: activeModel.instanceId,
          model: activeModel.model,
          ...(state.modelOptionsForDispatch ? { options: state.modelOptionsForDispatch } : {}),
        },
      }),
    ).toEqual({ handlingMode: "steer", blockReason: null });
    const changedOptions = buildTraitsOptionSelections(
      provider,
      [{ ...descriptor, currentValue: "low" }],
      options,
    );
    const changed = getComposerProviderState({
      provider,
      model: MODEL,
      models,
      modelOptions: changedOptions,
      planModeEnabled: false,
      preserveNativeTurnOptions: true,
    });
    expect(
      resolveMeerkatTurnDispatch({
        provider: "meerkat",
        phase: "running",
        activeModel,
        selectedModel: {
          instanceId: activeModel.instanceId,
          model: activeModel.model,
          ...(changed.modelOptionsForDispatch ? { options: changed.modelOptionsForDispatch } : {}),
        },
      }).blockReason,
    ).toContain("Steering keeps the active model");
    const restoredOptions = buildTraitsOptionSelections(
      provider,
      [{ ...descriptor, currentValue: "high" }],
      changedOptions,
    );
    const restored = getComposerProviderState({
      provider,
      model: MODEL,
      models,
      modelOptions: restoredOptions,
      planModeEnabled: false,
      preserveNativeTurnOptions: true,
    });
    expect(
      resolveMeerkatTurnDispatch({
        provider: "meerkat",
        phase: "running",
        activeModel,
        selectedModel: {
          instanceId: activeModel.instanceId,
          model: activeModel.model,
          ...(restored.modelOptionsForDispatch
            ? { options: restored.modelOptionsForDispatch }
            : {}),
        },
      }),
    ).toEqual({ handlingMode: "steer", blockReason: null });
    expect(
      getComposerProviderState({
        provider,
        model: MODEL,
        models,
        modelOptions: restoredOptions,
        planModeEnabled: false,
      }).modelOptionsForDispatch,
    ).toEqual(selections(["reasoning_effort", "high"]));
  });
  it("dispatches an explicit native reasoning level without reviving stale cache controls", () => {
    const state = getComposerProviderState({
      provider: ProviderDriverKind.make("meerkat"),
      model: MODEL,
      models: modelWith([
        booleanDescriptor("prompt_cache_enabled"),
        selectDescriptor("reasoning_effort", [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ]),
        selectDescriptor("reasoning_mode", [{ id: "concise", label: "Concise" }]),
      ]),
      modelOptions: selections(
        ["prompt_cache_enabled", false],
        ["reasoning_effort", "high"],
        ["reasoning_mode", "concise"],
      ),
      planModeEnabled: false,
    });
    expect(state.promptEffort).toBe("high");
    expect(state.modelOptionsForDispatch).toEqual(selections(["reasoning_effort", "high"]));
  });
  it("derives a stable prompt injection state for ordinary prompt edits", () => {
    expect(getComposerPromptInjectionState("Investigate this failure")).toBe("none");
    expect(getComposerPromptInjectionState("Ultrathink:\nInvestigate this failure")).toBe(
      "ultrathink",
    );
  });

  it("uses descriptor defaults for display without dispatching them as overrides", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("effort", [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ]),
      ]),
      modelOptions: undefined,
      planModeEnabled: true,
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: "high",
      modelOptionsForDispatch: undefined,
    });
  });

  it("lets selections override defaults and propagates them through dispatch", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("effort", [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ]),
        booleanDescriptor("fastMode"),
      ]),
      modelOptions: selections(["effort", "low"], ["fastMode", true]),
      planModeEnabled: true,
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: "low",
      modelOptionsForDispatch: selections(["effort", "low"], ["fastMode", true]),
    });
  });

  it("preserves selections that match defaults so deepMerge can overwrite prior state", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("effort", [{ id: "high", label: "High", isDefault: true }]),
        booleanDescriptor("fastMode"),
      ]),
      modelOptions: selections(["effort", "high"], ["fastMode", false]),
      planModeEnabled: true,
    });

    expect(state.modelOptionsForDispatch).toEqual(
      selections(["effort", "high"], ["fastMode", false]),
    );
  });

  it("drops selections for descriptors the model does not declare", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([booleanDescriptor("thinking")]),
      modelOptions: selections(["effort", "max"], ["thinking", false]),
      planModeEnabled: true,
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: null,
      modelOptionsForDispatch: selections(["thinking", false]),
    });
  });

  it("derives promptEffort from the first select descriptor and preserves all others for dispatch", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("effort", [{ id: "high", label: "High", isDefault: true }]),
        selectDescriptor("contextWindow", [
          { id: "200k", label: "200k", isDefault: true },
          { id: "1m", label: "1M" },
        ]),
        selectDescriptor("agent", [
          { id: "build", label: "Build", isDefault: true },
          { id: "plan", label: "Plan" },
        ]),
      ]),
      modelOptions: selections(["agent", "plan"]),
      planModeEnabled: true,
    });

    expect(state.promptEffort).toBe("high");
    expect(state.modelOptionsForDispatch).toEqual(selections(["agent", "plan"]));
  });

  it("drops the plan agent from dispatch when legacy plan mode is disabled", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("agent", [
          { id: "build", label: "Build", isDefault: true },
          { id: "plan", label: "Plan" },
        ]),
      ]),
      modelOptions: selections(["agent", "plan"]),
      planModeEnabled: false,
    });

    expect(state.modelOptionsForDispatch).toEqual(selections(["agent", "build"]));
  });

  it("drops the agent descriptor entirely when plan is the only option and plan mode is disabled", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("agent", [{ id: "plan", label: "Plan", isDefault: true }]),
      ]),
      modelOptions: selections(["agent", "plan"]),
      planModeEnabled: false,
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: null,
      modelOptionsForDispatch: undefined,
    });
  });

  it("falls back to a surviving agent when plan was the descriptor default and plan mode is disabled", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("agent", [
          { id: "plan", label: "Plan", isDefault: true },
          { id: "research", label: "Research" },
        ]),
      ]),
      modelOptions: undefined,
      planModeEnabled: false,
    });

    expect(state.modelOptionsForDispatch).toBeUndefined();
  });

  it("returns undefined dispatch options when the model declares no descriptors", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([]),
      modelOptions: selections(["anything", "value"]),
      planModeEnabled: true,
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: null,
      modelOptionsForDispatch: undefined,
    });
  });

  it("preserves explicit options when the selected model is absent from the catalog", () => {
    const state = getComposerProviderState({
      provider: ProviderDriverKind.make("opencode"),
      model: "opencode/kimi-k3",
      models: [
        {
          slug: "opencode/big-pickle",
          name: "Big Pickle",
          isCustom: false,
          capabilities: {},
        },
      ],
      modelOptions: selections(["variant", "max"], ["agent", "build"]),
      planModeEnabled: false,
    });

    expect(state.modelOptionsForDispatch).toEqual(
      selections(["variant", "max"], ["agent", "build"]),
    );
  });

  it.each(["codex", "claudeAgent", "cursor", "grok"])(
    "does not preserve unknown options for a missing %s model",
    (provider) => {
      const state = getComposerProviderState({
        provider: ProviderDriverKind.make(provider),
        model: "missing-model",
        models: modelWith([]),
        modelOptions: selections(["unknown", "value"]),
        planModeEnabled: true,
      });

      expect(state.modelOptionsForDispatch).toBeUndefined();
    },
  );

  it("preserves explicit options while the catalog is empty", () => {
    const state = getComposerProviderState({
      provider: ProviderDriverKind.make("opencode"),
      model: "opencode/kimi-k3",
      models: [],
      modelOptions: selections(["variant", "max"], ["agent", "build"]),
      planModeEnabled: false,
    });

    expect(state.modelOptionsForDispatch).toEqual(
      selections(["variant", "max"], ["agent", "build"]),
    );
  });

  it("validates options for a known model selected through a legacy alias", () => {
    const state = getComposerProviderState({
      provider: ProviderDriverKind.make("claudeAgent"),
      model: "legacy-test-model",
      models: [
        {
          slug: "test-model",
          name: "Test Model",
          aliases: ["legacy-test-model"],
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              selectDescriptor("effort", [
                { id: "low", label: "Low" },
                { id: "high", label: "High", isDefault: true },
              ]),
            ],
          },
        },
      ],
      modelOptions: selections(["effort", "low"], ["unknown", "value"]),
      planModeEnabled: false,
    });

    expect(state.modelOptionsForDispatch).toEqual(selections(["effort", "low"]));
  });

  it("still drops the plan agent when an absent model has a saved plan selection", () => {
    const state = getComposerProviderState({
      provider: ProviderDriverKind.make("opencode"),
      model: "opencode/kimi-k3",
      models: [],
      modelOptions: selections(["variant", "max"], ["agent", "plan"]),
      planModeEnabled: false,
    });

    expect(state.modelOptionsForDispatch).toEqual(selections(["variant", "max"]));
  });

  it("adds ultrathink class names when the prompt triggers a promptInjectedValues descriptor", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor(
          "effort",
          [
            { id: "medium", label: "Medium" },
            { id: "high", label: "High", isDefault: true },
            { id: "ultrathink", label: "Ultrathink" },
          ],
          ["ultrathink"],
        ),
      ]),
      promptInjectionState: getComposerPromptInjectionState(
        "Ultrathink:\nInvestigate this failure",
      ),
      modelOptions: selections(["effort", "medium"]),
      planModeEnabled: true,
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: "medium",
      modelOptionsForDispatch: selections(["effort", "medium"]),
      ...ULTRATHINK_FRAME_CLASSES,
    });
  });

  it("does not add ultrathink class names when the descriptor has no promptInjectedValues", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("effort", [{ id: "high", label: "High", isDefault: true }]),
      ]),
      promptInjectionState: getComposerPromptInjectionState(
        "Ultrathink:\nInvestigate this failure",
      ),
      modelOptions: undefined,
      planModeEnabled: true,
    });

    expect(state).not.toHaveProperty("composerFrameClassName");
    expect(state).not.toHaveProperty("composerSurfaceClassName");
    expect(state).not.toHaveProperty("modelPickerIconClassName");
  });

  it("defaults fastMode to false when the provider reports true but the user has not selected it", () => {
    const state = getComposerProviderState({
      provider: ProviderDriverKind.make("cursor"),
      model: MODEL,
      models: modelWith([booleanDescriptor("fastMode", true)]),
      modelOptions: undefined,
      planModeEnabled: true,
    });

    expect(state.modelOptionsForDispatch).toEqual(selections(["fastMode", false]));
  });

  it("keeps explicit fastMode true when the user selected Fast", () => {
    const state = getComposerProviderState({
      provider: ProviderDriverKind.make("cursor"),
      model: MODEL,
      models: modelWith([booleanDescriptor("fastMode", true)]),
      modelOptions: selections(["fastMode", true]),
      planModeEnabled: true,
    });

    expect(state.modelOptionsForDispatch).toEqual(selections(["fastMode", true]));
  });

  it("keeps explicit fastMode false when the user selected Normal", () => {
    const state = getComposerProviderState({
      provider: ProviderDriverKind.make("cursor"),
      model: MODEL,
      models: modelWith([booleanDescriptor("fastMode", true)]),
      modelOptions: selections(["fastMode", false]),
      planModeEnabled: true,
    });

    expect(state.modelOptionsForDispatch).toEqual(selections(["fastMode", false]));
  });
});

describe("withImplicitFastModeDefault", () => {
  it("injects fastMode false only when the model exposes fastMode and no selection exists", () => {
    expect(
      withImplicitFastModeDefault(
        {
          optionDescriptors: [booleanDescriptor("fastMode", true)],
        },
        undefined,
      ),
    ).toEqual(selections(["fastMode", false]));

    expect(
      withImplicitFastModeDefault(
        {
          optionDescriptors: [booleanDescriptor("fastMode", true)],
        },
        selections(["fastMode", true]),
      ),
    ).toEqual(selections(["fastMode", true]));
  });

  it("does not add fastMode when the model does not expose it", () => {
    expect(
      withImplicitFastModeDefault(
        {
          optionDescriptors: [booleanDescriptor("thinking", true)],
        },
        undefined,
      ),
    ).toBeUndefined();
  });
});

describe("trait controls fastMode display", () => {
  it("resolves traits fastMode to Normal when the provider defaults to true without a user selection", () => {
    const models = modelWith([booleanDescriptor("fastMode", true)]);
    const provider = ProviderDriverKind.make("cursor");
    const caps = getProviderModelCapabilities(models, MODEL, provider);
    const resolved = withImplicitFastModeDefault(caps, undefined);
    const descriptors = getProviderOptionDescriptors({ caps, selections: resolved });
    const fastMode = descriptors.find((descriptor) => descriptor.id === "fastMode");

    expect(fastMode?.type).toBe("boolean");
    if (fastMode?.type === "boolean") {
      expect(fastMode.currentValue).toBe(false);
    }
  });
});

describe("provider traits render guards", () => {
  it("returns null when no thread target is provided", () => {
    const models = modelWith([
      selectDescriptor("effort", [{ id: "high", label: "High", isDefault: true }]),
    ]);
    const args = {
      provider: PROVIDER,
      model: MODEL,
      models,
      modelOptions: undefined,
      prompt: "",
      onPromptChange: () => {},
      planModeEnabled: true,
    };

    expect(renderProviderTraitsPicker(args)).toBeNull();
    expect(renderProviderTraitsMenuContent(args)).toBeNull();
  });
});

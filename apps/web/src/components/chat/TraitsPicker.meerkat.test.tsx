import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createModelSelection } from "@t3tools/shared/model";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/menu", async () => {
  const { cloneElement, isValidElement } = await import("react");
  const childrenOnly = ({ children }: { children: ReactNode }) => children;
  return {
    Menu: childrenOnly,
    MenuGroup: childrenOnly,
    MenuPopup: childrenOnly,
    MenuSeparator: "hr",
    MenuTrigger: ({ render, children }: { render: ReactNode; children: ReactNode }) =>
      isValidElement(render) ? cloneElement(render, undefined, children) : children,
    MenuRadioGroup: ({
      onValueChange,
      children,
      value,
    }: {
      onValueChange: (value: string) => void;
      children: ReactNode;
      value: string;
    }) => (
      <select value={value} onChange={(event) => onValueChange(event.target.value)}>
        {children}
      </select>
    ),
    MenuRadioItem: ({
      value,
      children,
      disabled,
    }: {
      value: string;
      children: ReactNode;
      disabled?: boolean;
    }) => (
      <option value={value} disabled={disabled}>
        {children}
      </option>
    ),
  };
});
vi.mock("../ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => children,
    TooltipPopup: () => null,
    TooltipTrigger: ({ render, children }: { render: ReactNode; children: ReactNode }) =>
      isValidElement(render) ? cloneElement(render, undefined, children) : children,
  };
});
vi.mock("./ComposerControl", () => ({
  ComposerControl: "button",
  ComposerControlChevron: () => null,
  ComposerControlIcon: () => null,
}));

import { deriveEffectiveComposerModelState, useComposerDraftStore } from "../../composerDraftStore";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { TraitsPicker } from "./TraitsPicker";
import { getComposerProviderState } from "./composerProviderState";
import { getComposerModelSendBlock } from "./composerModelReadiness";
import { resolveMeerkatTurnDispatch } from "../../meerkatTurnDispatch";

const driver = ProviderDriverKind.make("meerkat");
const instanceId = ProviderInstanceId.make("native-work");
const threadRef = scopeThreadRef(
  EnvironmentId.make("native-env"),
  ThreadId.make("reasoning-draft"),
);
const threadKey = scopedThreadKey(threadRef);
const MODEL = "openai:reasoning-fixture";
const saved = createModelSelection(instanceId, MODEL, [{ id: "reasoning_effort", value: "high" }]);
let renderer: ReactTestRenderer | undefined;

function models(removedControl: boolean): ServerProviderModel[] {
  return [
    {
      slug: MODEL,
      name: "Reasoning fixture",
      isCustom: false,
      credentialState: "connected",
      capabilities: {
        optionDescriptors: removedControl
          ? []
          : [
              {
                id: "reasoning_effort",
                label: "Reasoning",
                type: "select",
                currentValue: "low",
                options: [{ id: "low", label: "Low", isDefault: true }],
              },
            ],
      },
    },
  ];
}

function provider(catalog: ServerProviderModel[]): ServerProvider {
  return {
    driver,
    instanceId,
    enabled: true,
    installed: true,
    status: "ready",
    version: null,
    auth: { status: "authenticated" },
    checkedAt: "2026-10-05T00:00:00.000Z",
    models: catalog,
    slashCommands: [],
    skills: [],
  };
}

function effective(catalog: ServerProviderModel[]) {
  return deriveEffectiveComposerModelState({
    draft: useComposerDraftStore.getState().draftsByThreadKey[threadKey] ?? null,
    providers: [provider(catalog)],
    selectedProvider: driver,
    selectedInstanceId: instanceId,
    threadModelSelection: saved,
    projectModelSelection: null,
    settings: DEFAULT_UNIFIED_SETTINGS,
  });
}

function dispatch(catalog: ServerProviderModel[]) {
  return getComposerProviderState({
    provider: driver,
    model: MODEL,
    models: catalog,
    modelOptions: effective(catalog).modelOptions?.[instanceId],
    planModeEnabled: false,
  }).modelOptionsForDispatch;
}

function block(catalog: ServerProviderModel[]) {
  return getComposerModelSendBlock({
    entries: deriveProviderInstanceEntries([provider(catalog)]),
    selections: [createModelSelection(instanceId, MODEL, dispatch(catalog))],
    modelOptionsByInstance: new Map([
      [
        instanceId,
        catalog.map((model) => ({
          slug: model.slug,
          name: model.name,
          isCustom: model.isCustom,
        })),
      ],
    ]),
    nativeInstanceIds: new Set([instanceId]),
    catalogKnown: true,
    continuesActiveTurn: false,
  });
}

function reset() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

function Composer({ catalog }: { catalog: ServerProviderModel[] }) {
  const draft = useComposerDraftStore((state) => state.draftsByThreadKey[threadKey]);
  return (
    <TraitsPicker
      provider={driver}
      instanceId={instanceId}
      threadRef={threadRef}
      model={MODEL}
      models={catalog}
      modelOptions={draft?.modelSelectionByProvider[instanceId]?.options ?? saved.options}
      prompt="Review the implementation"
      onPromptChange={() => {}}
      planModeEnabled={false}
    />
  );
}

async function reload() {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = undefined;
  await vi.advanceTimersByTimeAsync(300);
  reset();
  await useComposerDraftStore.persist.rehydrate();
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  reset();
  await useComposerDraftStore.persist.clearStorage();
});
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = undefined;
  reset();
  await useComposerDraftStore.persist.clearStorage();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([
  { removedControl: false, choice: "level:low", expected: "low", label: "Low" },
  { removedControl: false, choice: "model-default", expected: "default", label: "Model default" },
  { removedControl: true, choice: "model-default", expected: "default", label: null },
])(
  "recovers a reloaded stale choice with $choice (removed control: $removedControl)",
  async ({ removedControl, choice, expected, label }) => {
    const catalog = models(removedControl);
    useComposerDraftStore.getState().setModelSelection(threadRef, saved, { explicit: true });
    await reload();
    await act(async () => {
      renderer = create(<Composer catalog={catalog} />);
    });
    expect(
      renderer!.root
        .findAllByType("button")
        .some((button) => button.props["aria-label"] === "high (unavailable)"),
    ).toBe(true);
    expect(
      renderer!.root.findAllByType("option").find((option) => option.props.value === "unavailable")
        ?.props.disabled,
    ).toBe(true);
    expect(dispatch(catalog)).toEqual(saved.options);
    expect(block(catalog)?.reason).toContain("saved reasoning level is unavailable");

    await act(async () => {
      renderer!.root.findByType("select").props.onChange({ target: { value: choice } });
    });
    await reload();
    await act(async () => {
      renderer = create(<Composer catalog={catalog} />);
    });
    expect(effective(catalog).modelOptions?.[instanceId]).toEqual([
      { id: "reasoning_effort", value: expected },
    ]);
    expect(dispatch(catalog)).toEqual(
      expected === "default" ? undefined : [{ id: "reasoning_effort", value: expected }],
    );
    expect(block(catalog)).toBeNull();
    expect(
      renderer!.root
        .findAllByType("button")
        .some((button) => button.props["aria-label"] === "high (unavailable)"),
    ).toBe(false);
    if (label)
      expect(
        renderer!.root
          .findAllByType("button")
          .some((button) => button.props["aria-label"] === label),
      ).toBe(true);
    else expect(renderer!.root.findAllByType("select")).toHaveLength(0);
  },
);

it.each([false, true])(
  "keeps steering after Model default is sent and composer content clears (legacy hidden controls: %s)",
  async (legacyControls) => {
    const catalog = models(false);
    const hiddenOptions = legacyControls
      ? [
          { id: "prompt_cache_enabled", value: false },
          { id: "reasoning_context", value: "all" },
        ]
      : [];
    useComposerDraftStore
      .getState()
      .setModelSelection(
        threadRef,
        createModelSelection(instanceId, MODEL, [
          ...hiddenOptions,
          { id: "reasoning_effort", value: "high" },
        ]),
        { explicit: true },
      );
    useComposerDraftStore.getState().setPrompt(threadRef, "Review the implementation");
    await act(async () => {
      renderer = create(<Composer catalog={catalog} />);
    });
    await act(async () => {
      renderer!.root.findByType("select").props.onChange({ target: { value: "model-default" } });
    });
    const fresh = resolveMeerkatTurnDispatch({
      provider: "meerkat",
      phase: "ready",
      selectedModel: createModelSelection(instanceId, MODEL, dispatch(catalog)),
    });
    expect(fresh).toEqual({
      handlingMode: "queue",
      modelSelection: createModelSelection(instanceId, MODEL),
      blockReason: null,
    });
    if (!fresh.modelSelection) throw new Error("Expected the admitted fresh selection");
    const activeModel = fresh.modelSelection;
    await act(async () => {
      useComposerDraftStore.getState().clearComposerContent(threadRef);
    });
    expect(useComposerDraftStore.getState().draftsByThreadKey[threadKey]?.prompt).toBe("");
    expect(effective(catalog).modelOptions?.[instanceId]).toEqual([
      ...hiddenOptions,
      { id: "reasoning_effort", value: "default" },
    ]);
    const steer = () => {
      const running = getComposerProviderState({
        provider: driver,
        model: MODEL,
        models: catalog,
        modelOptions: effective(catalog).modelOptions?.[instanceId],
        preserveNativeTurnOptions: true,
        planModeEnabled: false,
      });
      return resolveMeerkatTurnDispatch({
        provider: "meerkat",
        phase: "running",
        activeModel,
        selectedModel: createModelSelection(instanceId, MODEL, running.modelOptionsForDispatch),
      });
    };
    expect(steer()).toEqual({ handlingMode: "steer", blockReason: null });
    // Choosing Model default again on an already-default active turn is also inert.
    await act(async () => {
      renderer!.root.findByType("select").props.onChange({ target: { value: "model-default" } });
    });
    expect(steer()).toEqual({ handlingMode: "steer", blockReason: null });
    await act(async () => {
      renderer!.root.findByType("select").props.onChange({ target: { value: "level:low" } });
    });
    expect(steer().blockReason).toContain("active model");
  },
);

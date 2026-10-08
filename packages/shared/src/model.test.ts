import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type ModelCapabilities } from "@t3tools/contracts";

import {
  applyClaudePromptEffortPrefix,
  buildExplicitProviderOptionSelectionsFromDescriptors,
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getMeerkatReasoningSelection,
  getProviderOptionDescriptors,
  getProviderModelControlCapabilities,
  readCustomModelEntries,
  toCustomModelSetting,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
} from "./model.ts";

const codexCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "xhigh", label: "Extra High" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    },
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

const claudeCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
        { id: "ultrathink", label: "Ultrathink" },
      ],
      currentValue: "high",
      promptInjectedValues: ["ultrathink"],
    },
    {
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [
        { id: "200k", label: "200k" },
        { id: "1m", label: "1M", isDefault: true },
      ],
      currentValue: "1m",
    },
  ],
});

describe("native model controls", () => {
  it.each(["level", "control"] as const)(
    "retains explicit reasoning after its %s disappears without replacing it with a default",
    (removed) => {
      const capabilities: ModelCapabilities = {
        optionDescriptors:
          removed === "control"
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
      };
      const selection = getMeerkatReasoningSelection(capabilities, [
        { id: "prompt_cache_enabled", value: false },
        { id: "reasoning_effort", value: "high" },
        { id: "reasoning_context", value: "all" },
      ]);
      expect(selection).toMatchObject({
        options: [{ id: "reasoning_effort", value: "high" }],
        unavailable: true,
        label: "high (unavailable)",
      });
      expect(
        getMeerkatReasoningSelection(capabilities, [
          { id: "prompt_cache_enabled", value: false },
          { id: "reasoning_effort", value: "default" },
        ]),
      ).toMatchObject({ options: undefined, unavailable: false, label: "Model default" });
    },
  );

  it("does not reinterpret a saved reasoning key when the native control changes", () => {
    const selected = getMeerkatReasoningSelection(
      {
        optionDescriptors: [
          {
            id: "thinking_level",
            label: "Thinking",
            type: "select",
            options: [{ id: "high", label: "High" }],
          },
        ],
      },
      [{ id: "reasoning_effort", value: "high" }],
    );
    expect(selected.unavailable).toBe(true);
    expect(selected.options).toEqual([{ id: "reasoning_effort", value: "high" }]);
  });

  it("keeps only the declared reasoning choice when an older catalog exposes cache and other parameters", () => {
    const nativeCaps: ModelCapabilities = {
      optionDescriptors: [
        { id: "prompt_cache_enabled", label: "Prompt caching", type: "boolean" },
        {
          id: "text_verbosity",
          label: "Detail",
          type: "select",
          options: [{ id: "short", label: "Short" }],
        },
        {
          id: "thinking",
          label: "Thinking",
          type: "select",
          options: [{ id: "adaptive", label: "Adaptive" }],
        },
        {
          id: "effort",
          label: "Effort",
          type: "select",
          options: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        },
      ],
    };
    const caps = getProviderModelControlCapabilities("meerkat", nativeCaps);
    const selections = [
      { id: "prompt_cache_enabled", value: false },
      { id: "effort", value: "high" },
    ];
    const descriptors = getProviderOptionDescriptors({ caps, selections });
    expect(descriptors).toEqual([
      {
        id: "effort",
        label: "Reasoning level",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
        currentValue: "high",
      },
    ]);
    expect(buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, selections)).toEqual([
      { id: "effort", value: "high" },
    ]);
    expect(nativeCaps.optionDescriptors).toHaveLength(4);
    expect(selections[0]).toEqual({ id: "prompt_cache_enabled", value: false });
  });

  it("does not manufacture levels for a model without a declared reasoning select", () => {
    expect(
      getProviderModelControlCapabilities("meerkat", {
        optionDescriptors: [
          { id: "prompt_cache_enabled", label: "Prompt caching", type: "boolean" },
        ],
      }).optionDescriptors,
    ).toEqual([]);
    expect(getProviderModelControlCapabilities("meerkat", null).optionDescriptors).toEqual([]);
  });

  it("preserves declared budget-only choices and donor controls", () => {
    const budgetCaps: ModelCapabilities = {
      optionDescriptors: [
        {
          id: "thinking_budget",
          label: "Thinking budget",
          type: "select",
          options: [
            { id: "default", label: "Default" },
            { id: "2048", label: "2,048 tokens" },
          ],
        },
      ],
    };
    expect(
      getProviderModelControlCapabilities("meerkat", budgetCaps).optionDescriptors?.[0],
    ).toEqual({
      ...budgetCaps.optionDescriptors?.[0],
      label: "Reasoning level",
    });
    expect(getProviderModelControlCapabilities("codex", codexCaps)).toBe(codexCaps);
    expect(getProviderModelControlCapabilities("claudeAgent", claudeCaps)).toBe(claudeCaps);
  });
});

describe("descriptor helpers", () => {
  it("applies selection values to capability descriptors", () => {
    expect(
      getProviderOptionDescriptors({
        caps: claudeCaps,
        selections: [
          { id: "effort", value: "medium" },
          { id: "contextWindow", value: "200k" },
        ],
      }),
    ).toEqual([
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "ultrathink", label: "Ultrathink" },
        ],
        currentValue: "medium",
        promptInjectedValues: ["ultrathink"],
      },
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [
          { id: "200k", label: "200k" },
          { id: "1m", label: "1M", isDefault: true },
        ],
        currentValue: "200k",
      },
    ]);
  });

  it("builds wire-format option selections from descriptors", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });

    expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
  });

  it("builds dispatch options only from explicit selections", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [{ id: "fastMode", value: true }],
    });

    expect(buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, undefined)).toBe(
      undefined,
    );
    expect(
      buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, [
        { id: "fastMode", value: true },
      ]),
    ).toEqual([{ id: "fastMode", value: true }]);
  });

  it("stores option selection arrays in model selections", () => {
    expect(
      createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
  });

  it("reads typed option selection values", () => {
    const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);

    expect(getProviderOptionStringSelectionValue(selection.options, "reasoningEffort")).toBe(
      "high",
    );
    expect(getProviderOptionStringSelectionValue(selection.options, "fastMode")).toBeUndefined();
    expect(getProviderOptionBooleanSelectionValue(selection.options, "fastMode")).toBe(true);
    expect(
      getProviderOptionBooleanSelectionValue(selection.options, "reasoningEffort"),
    ).toBeUndefined();
    expect(getModelSelectionStringOptionValue(selection, "reasoningEffort")).toBe("high");
    expect(getModelSelectionBooleanOptionValue(selection, "fastMode")).toBe(true);
  });
});

describe("applyClaudePromptEffortPrefix", () => {
  it("keeps slash commands intact when ultrathink is selected", () => {
    expect(applyClaudePromptEffortPrefix("/compact", "ultrathink")).toBe("/compact");
    expect(applyClaudePromptEffortPrefix(" /compact keep recent errors ", "ultrathink")).toBe(
      "/compact keep recent errors",
    );
    expect(applyClaudePromptEffortPrefix(" /review src/model.ts ", "ultrathink")).toBe(
      "/review src/model.ts",
    );
    expect(applyClaudePromptEffortPrefix("/security-review", "ultrathink")).toBe(
      "/security-review",
    );
    expect(applyClaudePromptEffortPrefix("/plugin:skill run", "ultrathink")).toBe(
      "/plugin:skill run",
    );
    expect(applyClaudePromptEffortPrefix("/deploy.prod to staging", "ultrathink")).toBe(
      "/deploy.prod to staging",
    );
  });

  it("still adds the ultrathink prefix to ordinary prompts", () => {
    expect(applyClaudePromptEffortPrefix("Investigate this failure", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate this failure",
    );
    expect(applyClaudePromptEffortPrefix("/home/theo/app.ts crashed on load", "ultrathink")).toBe(
      "Ultrathink:\n/home/theo/app.ts crashed on load",
    );
  });
});

describe("readCustomModelEntries", () => {
  const capabilities: ModelCapabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
        currentValue: "high",
      },
    ],
  };

  it("resolves bare slugs and entries, trimming and deduplicating on slug", () => {
    expect(
      readCustomModelEntries([
        " bare ",
        { slug: "named", name: " Named ", capabilities },
        "bare",
        { slug: "named", name: "Second" },
        "",
        { name: "no slug" },
        42,
      ]),
    ).toEqual([
      { slug: "bare", name: "bare", capabilities: null },
      { slug: "named", name: "Named", capabilities },
    ]);
  });

  it("drops unparseable capabilities but keeps the entry", () => {
    expect(
      readCustomModelEntries([{ slug: "x", capabilities: { optionDescriptors: "nope" } }]),
    ).toEqual([{ slug: "x", name: "x", capabilities: null }]);
    expect(readCustomModelEntries("not a list")).toEqual([]);
  });

  it("writes the compact stored shape back", () => {
    expect(toCustomModelSetting({ slug: "x", name: "x", capabilities: null })).toBe("x");
    expect(
      toCustomModelSetting({ slug: "x", name: "x", capabilities: { optionDescriptors: [] } }),
    ).toBe("x");
    expect(toCustomModelSetting({ slug: "x", name: "X", capabilities })).toEqual({
      slug: "x",
      name: "X",
      capabilities,
    });
  });
});

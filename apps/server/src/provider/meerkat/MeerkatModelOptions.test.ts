import { describe, expect, it } from "vite-plus/test";
import {
  projectMeerkatCapabilities,
  meerkatProviderParams,
  resolveMeerkatProviderParams,
} from "./MeerkatModelOptions.ts";

describe("native model options", () => {
  it("exposes only the selected model's declared effort levels", () => {
    const capabilities = projectMeerkatCapabilities("openai", {
      properties: {
        reasoning_effort: { type: "string", enum: ["low", "high"] },
        temperature: { type: "number" },
      },
    });
    expect(capabilities?.optionDescriptors).toEqual([
      {
        id: "reasoning_effort",
        label: "Reasoning level",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
    ]);
    expect(projectMeerkatCapabilities("openai", undefined)).toBeNull();
    expect(
      projectMeerkatCapabilities("self_hosted", { properties: { effort: { enum: ["max"] } } }),
    ).toBeNull();
  });
  it("projects the pinned native Astra schema as reasoning choices only", () => {
    const levels = ["low", "medium", "high", "xhigh", "max"];
    const capabilities = projectMeerkatCapabilities("openai", {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt_cache_enabled: { type: "boolean", description: "Enable prompt caching." },
        reasoning_context: { type: "string", enum: ["all", "last"] },
        reasoning_effort: { type: "string", enum: levels, description: "Reasoning effort level." },
        text_verbosity: { type: "string", enum: ["low", "medium", "high"] },
      },
    });
    expect(capabilities?.optionDescriptors).toEqual([
      {
        id: "reasoning_effort",
        label: "Reasoning level",
        type: "select",
        options: levels.map((id) => ({ id, label: id[0]?.toUpperCase() + id.slice(1) })),
      },
    ]);
  });
  it("keeps declared nullable reasoning enums and omits the null sentinel", () => {
    const capabilities = projectMeerkatCapabilities("openai", {
      properties: {
        reasoning_effort: { type: ["string", "null"], enum: [null, "low", "high"] },
        prompt_cache_enabled: { type: "boolean" },
      },
    });
    expect(capabilities?.optionDescriptors).toEqual([
      {
        id: "reasoning_effort",
        label: "Reasoning level",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
    ]);
  });
  it("prefers native effort over a second thinking control", () => {
    expect(
      projectMeerkatCapabilities("anthropic", {
        properties: {
          thinking: { type: "object", properties: { type: { enum: ["adaptive"] } } },
          effort: { type: "string", enum: ["high", "max"] },
        },
      })?.optionDescriptors?.map((entry) => entry.id),
    ).toEqual(["effort"]);
    expect(
      projectMeerkatCapabilities("openai", {
        properties: {
          prompt_cache_enabled: { type: "boolean" },
        },
      }),
    ).toBeNull();
  });
  it("maps native thinking modes and budgets without inventing unsupported adaptive mode", () => {
    const capabilities = projectMeerkatCapabilities("anthropic", {
      properties: { thinking: { type: "object", properties: { type: { enum: ["enabled"] } } } },
    });
    const descriptor = capabilities?.optionDescriptors?.[0];
    expect(descriptor?.type === "select" && descriptor.options.map((option) => option.id)).toEqual([
      "default",
      "2048",
      "8192",
      "16000",
    ]);
    expect(
      meerkatProviderParams([
        { id: "thinking", value: "8192" },
        { id: "effort", value: "high" },
      ]),
    ).toEqual({ thinking: { type: "enabled", budget_tokens: 8192 }, effort: "high" });
    expect(meerkatProviderParams([{ id: "thinking", value: "adaptive" }])).toEqual({
      thinking: { type: "adaptive" },
    });
    expect(meerkatProviderParams([{ id: "thinking", value: "default" }])).toBeUndefined();
    expect(() => meerkatProviderParams([{ id: "thinking", value: "huge" }])).toThrow();
  });
  it("keeps Gemini legacy budgets available alongside nested native thinking schema", () => {
    const capabilities = projectMeerkatCapabilities("gemini", {
      properties: {
        thinking: { type: "object", properties: { thinking_budget: { type: "integer" } } },
        thinking_budget: { type: "integer" },
      },
    });
    expect(capabilities?.optionDescriptors?.map((entry) => entry.id)).toEqual(["thinking_budget"]);
    expect(meerkatProviderParams([{ id: "thinking_budget", value: "8192" }])).toEqual({
      thinking_budget: 8192,
    });
  });
});

describe("native cache delegation", () => {
  const catalog = (schema: unknown) => ({
    catalog: {
      providers: [
        { provider: "openai", models: [{ id: "exact-model", profile: { params_schema: schema } }] },
      ],
    },
  });
  const scope = {
    projectPath: "/workspace",
    configStateRoot: "/private-realm",
    provider: "openai",
    model: "exact-model",
  };

  it.each([false, true])(
    "omits saved cache %s without modifying the immutable selection",
    async (value) => {
      const options = [
        { id: "reasoning_effort", value: "low" },
        { id: "prompt_cache_enabled", value },
      ];
      expect(
        await resolveMeerkatProviderParams({
          ...scope,
          options,
          client: {
            request: async () =>
              catalog({ properties: { prompt_cache_enabled: { type: "boolean" } } }),
          },
        }),
      ).toEqual({ reasoning_effort: "low" });
      expect(options[1]?.value).toBe(value);
    },
  );

  it("leaves cache policy unset even when the model schema declares a cache boolean", async () => {
    expect(
      await resolveMeerkatProviderParams({
        ...scope,
        options: undefined,
        client: {
          request: async () =>
            catalog({ properties: { prompt_cache_enabled: { type: "boolean" } } }),
        },
      }),
    ).toBeUndefined();
  });

  it("does not send unsupported cache fields to older OpenAI models or other providers", async () => {
    const options = [{ id: "prompt_cache_enabled", value: false }];
    expect(
      await resolveMeerkatProviderParams({
        ...scope,
        options,
        client: {
          request: async () => catalog({ properties: { reasoning_effort: { enum: ["high"] } } }),
        },
      }),
    ).toBeUndefined();
    for (const provider of ["anthropic", "gemini", "self_hosted"]) {
      expect(
        await resolveMeerkatProviderParams({
          ...scope,
          provider,
          options,
          client: {
            request: async () => {
              throw new Error("No catalog query is needed for this provider");
            },
          },
        }),
      ).toBeUndefined();
    }
  });

  it("refuses an absent or ambiguous exact model before native admission", async () => {
    const entry = {
      id: "other",
      profile: { params_schema: { properties: { prompt_cache_enabled: { type: "boolean" } } } },
    };
    for (const models of [
      [entry],
      [
        { ...entry, id: "exact-model" },
        { ...entry, id: "exact-model" },
      ],
    ]) {
      await expect(
        resolveMeerkatProviderParams({
          ...scope,
          options: undefined,
          client: {
            request: async () => ({ catalog: { providers: [{ provider: "openai", models }] } }),
          },
        }),
      ).rejects.toThrow("Choose a model again");
    }
  });
});

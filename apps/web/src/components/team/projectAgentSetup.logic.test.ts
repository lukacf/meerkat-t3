import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveProviderWorkspaceReadiness } from "@t3tools/client-runtime/providerWorkspaceReadiness";
import {
  customProjectAgentRole,
  existingProjectAgentPreset,
  PROJECT_AGENT_PRESETS,
  projectAgentPreferredOptions,
  projectAgentReasoningControl,
  resolveProjectAgentModel,
  validateAgentSetupSearch,
} from "./projectAgentSetup.logic";

const model = (slug: string, isDefault = false) => ({
  slug,
  name: slug,
  isDefault,
  isCustom: false,
  capabilities: {},
});
function provider(instance: string, overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instance),
    driver: ProviderDriverKind.make("meerkat"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-25T00:00:00.000Z",
    models: [model("default", true), model("chosen")],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("project agent onboarding", () => {
  it("inherits reasoning only for the exact preferred provider and model", () => {
    const native = provider("native");
    const options = [{ id: "reasoning_effort", value: "high" }];
    const preferred = { instanceId: native.instanceId, model: "chosen", options };
    expect(projectAgentPreferredOptions(preferred, native, native.models[1])).toEqual(options);
    expect(projectAgentPreferredOptions(preferred, native, native.models[0])).toBeUndefined();
    expect(
      projectAgentPreferredOptions(preferred, provider("other"), native.models[1]),
    ).toBeUndefined();
    expect(projectAgentPreferredOptions(preferred, native, undefined)).toBeUndefined();
  });

  it("keeps unsupported saved reasoning visible while ignoring historical cache choices", () => {
    const selected = {
      ...model("native"),
      capabilities: {
        optionDescriptors: [
          { id: "prompt_cache_enabled", label: "Prompt caching", type: "boolean" as const },
          {
            id: "reasoning_effort",
            label: "Effort",
            type: "select" as const,
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    };
    for (const value of [false, true]) {
      expect(
        projectAgentReasoningControl(selected, [{ id: "prompt_cache_enabled", value }]),
      ).toMatchObject({
        descriptor: { id: "reasoning_effort", label: "Reasoning level" },
        unavailable: false,
        value: "default",
        label: "Model default",
      });
    }
    const options = [{ id: "reasoning_effort", value: "removed" }];
    expect(projectAgentReasoningControl(selected, options)).toMatchObject({
      unavailable: true,
      label: "removed (unavailable)",
    });
    expect(projectAgentReasoningControl({ capabilities: null }, options).unavailable).toBe(true);
    expect(options).toEqual([{ id: "reasoning_effort", value: "removed" }]);
  });

  it("carries reasoning through the custom-agent route without reinterpreting its value", () => {
    const search = {
      instance: "native",
      model: "openai:chosen",
      options: [{ id: "reasoning_effort", value: "high" }],
    };
    expect(validateAgentSetupSearch(search)).toEqual(search);
    expect(validateAgentSetupSearch({ instance: "native", model: "chosen" })).toEqual({
      instance: "native",
      model: "chosen",
    });
    expect(
      validateAgentSetupSearch({ ...search, options: [{ id: "reasoning_effort", value: {} }] }),
    ).toEqual({ instance: "native", model: "openai:chosen" });
  });

  it("proposes and creates agents from the chosen project's model projection", () => {
    const native = provider("meerkat", {
      supportsWorkspaceReadiness: true,
      models: [{ ...model("openai:default-a", true), credentialState: "needs_auth" }],
      workspaceSnapshots: [
        {
          cwd: "/project-b",
          checkedAt: "2026-10-04T00:00:00.000Z",
          skills: [],
          slashCommands: [],
          readiness: {
            status: "ready",
            auth: { status: "authenticated" },
            models: [{ ...model("openai:project-b", true), credentialState: "connected" }],
          },
        },
      ],
    });
    const selected = (cwd: string) =>
      resolveProjectAgentModel(
        resolveProviderWorkspaceReadiness([native], cwd).providers,
        null,
        null,
        null,
      );
    expect(selected("/project-b").model?.slug).toBe("openai:project-b");
    expect(selected("/project-a").model).toBeUndefined();
    expect(selected("/project-b/worktree").model).toBeUndefined();
  });
  it("does not create a specialist with an explicitly unavailable account or silently switch its chosen model", () => {
    const ready = provider("meerkat", {
      models: [
        { ...model("missing", true), credentialState: "needs_auth" },
        { ...model("ready"), credentialState: "connected" },
      ],
    });
    expect(resolveProjectAgentModel([ready], null, null, null).model?.slug).toBe("ready");
    expect(
      resolveProjectAgentModel([ready], null, ready.instanceId, "missing").model,
    ).toBeUndefined();
    expect(
      resolveProjectAgentModel(
        [ready],
        { instanceId: ready.instanceId, model: "missing" },
        null,
        null,
      ).model,
    ).toBeUndefined();
  });
  it("uses the project's configured provider and model, with an explicit user selection taking priority", () => {
    const first = provider("first");
    const second = provider("second");
    const preferred = { instanceId: second.instanceId, model: "chosen" };
    expect(resolveProjectAgentModel([first, second], preferred, null, null)).toEqual({
      provider: second,
      model: second.models[1],
    });
    expect(resolveProjectAgentModel([first, second], preferred, first.instanceId, null)).toEqual({
      provider: first,
      model: first.models[0],
    });
    expect(
      resolveProjectAgentModel([first, second], preferred, second.instanceId, "default").model,
    ).toEqual(second.models[0]);
  });

  it("falls back only to an available enabled Meerkat instance and to a catalog model", () => {
    const disabled = provider("disabled", { enabled: false });
    const unavailable = provider("unavailable", { availability: "unavailable" });
    const codex = provider("codex", { driver: ProviderDriverKind.make("codex") });
    const ready = provider("ready");
    const preferred = { instanceId: disabled.instanceId, model: "missing" };
    expect(
      resolveProjectAgentModel(
        [disabled, unavailable, codex, ready],
        preferred,
        unavailable.instanceId,
        "missing",
      ),
    ).toEqual({ provider: ready, model: ready.models[0] });
    expect(resolveProjectAgentModel([disabled, unavailable, codex], preferred, null, null)).toEqual(
      { provider: undefined, model: undefined },
    );
  });

  it("reuses a preset by role or prior label only inside the selected provider", () => {
    const agents = [
      { instanceId: "other", role: "architect", label: "Architect" },
      { instanceId: "selected", role: "architecture", label: "Architect" },
    ];
    expect(existingProjectAgentPreset(agents, "selected", PROJECT_AGENT_PRESETS[0])).toBe(
      agents[1],
    );
    expect(existingProjectAgentPreset(agents, "missing", PROJECT_AGENT_PRESETS[0])).toBeUndefined();
  });

  it("can set up Meerkat specialists while the task composer uses another provider", () => {
    const codex = provider("codex", { driver: ProviderDriverKind.make("codex") });
    const meerkat = provider("meerkat");
    const draftSelection = { instanceId: codex.instanceId, model: "chosen" };
    expect(resolveProjectAgentModel([codex, meerkat], draftSelection, null, null)).toEqual({
      provider: meerkat,
      model: meerkat.models[0],
    });
    expect(draftSelection).toEqual({ instanceId: codex.instanceId, model: "chosen" });
  });

  it("derives a valid stable custom role from a human name", () => {
    expect(customProjectAgentRole("  API / Design Expert  ")).toBe("api-design-expert");
    expect(customProjectAgentRole("42 Storage specialist")).toBe("storage-specialist");
    expect(customProjectAgentRole("研究員")).toBe("specialist");
    expect(customProjectAgentRole("A".repeat(120))).toHaveLength(80);
  });
});

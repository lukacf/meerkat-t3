import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { meerkatSteeringFailure, resolveMeerkatTurnDispatch } from "./meerkatTurnDispatch";

const model = { instanceId: ProviderInstanceId.make("meerkat"), model: "openai:gpt-test" };
const base = { provider: "meerkat", selectedModel: model, activeModel: model };

describe("Meerkat turn dispatch", () => {
  it("sends an idle message or queue released after terminal as a new queued turn", () => {
    expect(resolveMeerkatTurnDispatch({ ...base, phase: "ready" })).toEqual({
      handlingMode: "queue",
      modelSelection: model,
      blockReason: null,
    });
  });

  it("steers the current app run without model or option overrides", () => {
    expect(resolveMeerkatTurnDispatch({ ...base, phase: "running" })).toEqual({
      handlingMode: "steer",
      blockReason: null,
    });
  });

  it("blocks model changes during steering", () => {
    expect(
      resolveMeerkatTurnDispatch({
        ...base,
        phase: "running",
        selectedModel: { ...model, model: "anthropic:other" },
      }).blockReason,
    ).toContain("active model");
    expect(
      resolveMeerkatTurnDispatch({
        ...base,
        phase: "running",
        selectedModel: { ...model, options: [{ id: "effort", value: "high" }] },
      }).blockReason,
    ).toContain("active model");
  });

  it("steers a fresh default turn despite draft-only default and hidden controls", () => {
    expect(
      resolveMeerkatTurnDispatch({
        ...base,
        phase: "running",
        selectedModel: {
          ...model,
          options: [
            { id: "reasoning_effort", value: "default" },
            { id: "prompt_cache_enabled", value: false },
            { id: "reasoning_context", value: "all" },
          ],
        },
      }),
    ).toEqual({ handlingMode: "steer", blockReason: null });
  });

  it("continues comparing hidden native options when they belong to the actual active turn", () => {
    const activeModel = {
      ...model,
      options: [
        { id: "prompt_cache_enabled", value: false },
        { id: "reasoning_context", value: "all" },
      ],
    };
    expect(
      resolveMeerkatTurnDispatch({
        ...base,
        phase: "running",
        activeModel,
        selectedModel: {
          ...activeModel,
          options: [...activeModel.options, { id: "reasoning_effort", value: "default" }],
        },
      }),
    ).toEqual({ handlingMode: "steer", blockReason: null });
    for (const options of [
      [
        { id: "prompt_cache_enabled", value: true },
        { id: "reasoning_context", value: "all" },
      ],
      [
        { id: "prompt_cache_enabled", value: false },
        { id: "reasoning_context", value: "none" },
      ],
      [{ id: "prompt_cache_enabled", value: false }],
    ]) {
      expect(
        resolveMeerkatTurnDispatch({
          ...base,
          phase: "running",
          activeModel,
          selectedModel: { ...model, options },
        }).blockReason,
      ).toContain("active model");
    }
  });

  it("rejects deliberate reasoning and provider changes despite retained draft metadata", () => {
    const activeModel = { ...model, options: [{ id: "reasoning_effort", value: "high" }] };
    for (const value of ["low", "default"]) {
      expect(
        resolveMeerkatTurnDispatch({
          ...base,
          phase: "running",
          activeModel,
          selectedModel: {
            ...model,
            options: [
              { id: "reasoning_effort", value },
              { id: "prompt_cache_enabled", value: false },
            ],
          },
        }).blockReason,
      ).toContain("active model");
    }
    expect(
      resolveMeerkatTurnDispatch({
        ...base,
        phase: "running",
        selectedModel: { ...model, instanceId: ProviderInstanceId.make("another-native") },
      }).blockReason,
    ).toContain("active model");
  });

  it("recovers only a correlated rejected steering message for explicit retry", () => {
    expect(
      meerkatSteeringFailure({
        kind: "provider.turn.start.failed",
        payload: { requestId: "steer-1", detail: "Run ended" },
      }),
    ).toEqual({ requestId: "steer-1", detail: "Run ended" });
    expect(
      meerkatSteeringFailure({
        kind: "provider.turn.start.failed",
        payload: { detail: "Unknown request" },
      }),
    ).toBeNull();
    expect(
      meerkatSteeringFailure({ kind: "tool.completed", payload: { requestId: "steer-1" } }),
    ).toBeNull();
  });

  it("preserves other providers' existing dispatch behavior", () => {
    expect(resolveMeerkatTurnDispatch({ ...base, provider: "codex", phase: "running" })).toEqual({
      modelSelection: model,
      blockReason: null,
    });
  });
});

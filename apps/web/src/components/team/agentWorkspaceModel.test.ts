import type { ServerProviderModel } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveAgentWorkspaceModel } from "./agentWorkspaceModel";

function model(
  slug: string,
  credentialState: ServerProviderModel["credentialState"] = "connected",
  isDefault = false,
): ServerProviderModel {
  return {
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
    ...(credentialState ? { credentialState } : {}),
    isDefault,
  };
}

describe("native workspace model selection", () => {
  it("preserves the exact qualified model and a unique raw native model before the default", () => {
    const current = model("openai:review");
    const models = [model("anthropic:default", "connected", true), current];
    expect(resolveAgentWorkspaceModel(models, "review").model).toBe(current);
    expect(resolveAgentWorkspaceModel(models, "openai:review").model).toBe(current);
  });

  it.each(["openai", "self_hosted"])(
    "resolves the observed %s provider when model names collide",
    (provider) => {
      const otherProvider = provider === "openai" ? "self_hosted" : "openai";
      const current = model(`${provider}:shared`);
      const models = [model(`${otherProvider}:shared`, "connected", true), current];
      for (const name of ["shared", `${provider}:shared`]) {
        expect(resolveAgentWorkspaceModel(models, name, provider)).toEqual({
          model: current,
          blockedReason: null,
        });
      }
    },
  );

  it.each(["shared", "openai:shared", undefined])(
    "blocks unavailable observed provider/model %s instead of choosing a fallback",
    (current) => {
      const models = [
        model("self_hosted:shared", "connected", true),
        model("openai:other", "connected"),
      ];
      expect(resolveAgentWorkspaceModel(models, current, "openai")).toEqual({
        model: undefined,
        blockedReason:
          "The agent's current model is unavailable in this workspace. Check Settings > Providers.",
      });
    },
  );

  it("requires reconnection for the observed provider despite another usable raw-name match", () => {
    const models = [
      model("self_hosted:shared", "connected", true),
      { ...model("openai:shared", "reauth_required"), subProvider: "openai" },
    ];
    expect(resolveAgentWorkspaceModel(models, "shared", "openai")).toEqual({
      model: undefined,
      blockedReason: "Reconnect openai in Settings > Providers.",
    });
  });

  it("never substitutes another account when the current model needs reconnection", () => {
    const current = { ...model("openai:review", "reauth_required"), subProvider: "openai" };
    const models = [model("anthropic:default", "connected", true), current];
    for (const name of ["review", "openai:review"]) {
      expect(resolveAgentWorkspaceModel(models, name)).toEqual({
        model: undefined,
        blockedReason: "Reconnect openai in Settings > Providers.",
      });
    }
  });

  it("prefers a connected fallback even if a stale or host-managed model is default", () => {
    const connected = model("openai:ready");
    const models = [model("anthropic:missing", "needs_auth", true), connected];
    expect(resolveAgentWorkspaceModel(models, undefined).model).toBe(connected);
    expect(
      resolveAgentWorkspaceModel([model("custom:default", "host_managed", true), connected], "old")
        .model,
    ).toBe(connected);
  });

  it("retains the default fallback for an ambiguous raw name when its provider is unknown", () => {
    const preferred = model("openai:shared", "connected", true);
    expect(resolveAgentWorkspaceModel([model("anthropic:shared"), preferred], "shared").model).toBe(
      preferred,
    );
  });

  it("requires detected credentials before using unknown or host-managed models", () => {
    for (const state of [undefined, "unknown", "host_managed"] as const) {
      const { credentialState: _, ...base } = model("custom:ready");
      const current = { ...base, ...(state ? { credentialState: state } : {}) };
      expect(resolveAgentWorkspaceModel([current], "ready")).toEqual({
        model: undefined,
        blockedReason: expect.stringContaining("Check this provider"),
      });
    }
  });

  it("explains how to recover when no model can be selected", () => {
    expect(resolveAgentWorkspaceModel([model("openai:missing", "needs_auth")], undefined)).toEqual({
      model: undefined,
      blockedReason: "Connect a model in Settings > Providers before opening a task.",
    });
  });
});

import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { providerModelKey } from "../../modelOrdering";
import { duplicateModelPickerNames, groupModelPickerModels } from "./modelPickerGroups";
import { getDisplayModelName, type ModelEsque } from "./providerIconUtils";

const instanceId = ProviderInstanceId.make("meerkat");
const model = (slug: string, catalogTier?: ModelEsque["catalogTier"]) => ({
  instanceId,
  slug,
  name: slug,
  credentialState: "connected" as const,
  catalogTier,
});

describe("native model chooser groups", () => {
  it("preserves favorites and native recommendations before the remaining supported models", () => {
    const favorite = model("favorite", "supported");
    const supported = model("alphabetically-first", "supported");
    const recommended = model("recommended", "recommended");
    const secondRecommended = model("second-recommendation", "recommended");
    const input = [supported, favorite, recommended, secondRecommended];
    const groups = groupModelPickerModels(
      input,
      new Set([providerModelKey(instanceId, favorite.slug)]),
    );
    expect(groups.map((group) => group.label)).toEqual([
      "Favorites",
      "Recommended",
      "Other supported models",
    ]);
    expect(groups.flatMap((group) => group.models)).toEqual([
      favorite,
      recommended,
      secondRecommended,
      supported,
    ]);
    expect(input).toEqual([supported, favorite, recommended, secondRecommended]);
  });

  it("never invents recommendation or support for unclassified and configured models", () => {
    const groups = groupModelPickerModels(
      [model("no-tier"), model("deployment", "custom"), model("supported", "supported")],
      new Set(),
    );
    expect(groups.map((group) => group.label)).toEqual([
      "Supported models",
      "Configured models",
      "Other models",
    ]);
    expect(groups.some((group) => group.label === "Recommended")).toBe(false);
  });

  it("keeps an unavailable recommendation out of the available favorites and recommendations", () => {
    const unavailable = {
      ...model("expired", "recommended"),
      credentialState: "reauth_required" as const,
    };
    const available = model("working", "recommended");
    const groups = groupModelPickerModels(
      [unavailable, available],
      new Set([providerModelKey(instanceId, unavailable.slug)]),
    );
    expect(groups).toEqual([
      { label: "Recommended", models: [available] },
      { label: "Unavailable models", models: [unavailable] },
    ]);
  });
});

describe("duplicate chooser names", () => {
  it("keeps a model maker in the human name when account provenance is separate", () => {
    const native = {
      ...model("gemini:gemini-3.5-pro"),
      name: "Gemini 3.5 Pro",
      subProvider: "gemini",
      accountLabel: "GitHub Copilot · King",
    };
    expect(getDisplayModelName(native)).toBe("Gemini 3.5 Pro");
    expect(
      getDisplayModelName({ slug: "vendor/model", name: "Vendor / Model", subProvider: "Vendor" }),
    ).toBe("Model");
  });

  it("uses account labels to distinguish accounts and reserves IDs for variants within one account", () => {
    const first = {
      ...model("anthropic:claude-haiku-4.5"),
      name: "Claude Haiku 4.5",
      accountLabel: "GitHub Copilot · King",
    };
    const otherAccount = {
      ...model("anthropic:claude-haiku-4-5"),
      name: first.name,
      accountLabel: "Anthropic API key · Personal",
    };
    expect(duplicateModelPickerNames([first, otherAccount], true).size).toBe(0);
    const dated = { ...first, slug: "anthropic:claude-haiku-4.5-20261001" };
    expect([...duplicateModelPickerNames([first, otherAccount, dated], true)]).toEqual([
      providerModelKey(instanceId, first.slug),
      providerModelKey(instanceId, dated.slug),
    ]);
  });

  it("disambiguates visible short names using exact model identity without merging aliases", () => {
    const first = {
      ...model("anthropic:haiku-current", "recommended"),
      name: "Haiku current alias",
      shortName: "Claude Haiku 4.5",
    };
    const second = {
      ...model("anthropic:haiku-20260101", "supported"),
      name: "Haiku dated model",
      shortName: "Claude Haiku 4.5",
    };
    const unique = { ...model("anthropic:opus", "recommended"), name: "Claude Opus" };
    expect([...duplicateModelPickerNames([first, second, unique], true)]).toEqual([
      providerModelKey(instanceId, first.slug),
      providerModelKey(instanceId, second.slug),
    ]);
    expect(duplicateModelPickerNames([first, second, unique], false).size).toBe(0);
  });
});

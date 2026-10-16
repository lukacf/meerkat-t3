import { describe, expect, it } from "vite-plus/test";
import {
  currentModelCredentialRequirement,
  modelCredentialRequirement,
  modelsWithCredentialsFirst,
} from "./modelCredentials";

describe("model credential readiness", () => {
  it("directs reconnect to the account serving the model instead of its protocol family", () => {
    expect(
      modelCredentialRequirement(
        {
          credentialState: "reauth_required",
          subProvider: "gemini",
          accountLabel: "GitHub Copilot · King",
        },
        true,
      ),
    ).toBe("Reconnect GitHub Copilot · King in Settings > Providers.");
  });

  it.each([undefined, "unknown", "host_managed"] as const)(
    "requires positive native account access for %s credentials",
    (credentialState) => {
      expect(
        modelCredentialRequirement({ credentialState, subProvider: "OpenAI" }, true),
      ).toContain("Check OpenAI");
    },
  );
  it("enables native models only after their account is detected", () => {
    expect(modelCredentialRequirement({ credentialState: "connected" }, true)).toBeNull();
  });
  it("checks the current native model when no override was selected without guessing an ambiguous binding", () => {
    const models = [
      {
        slug: "openai:shared",
        name: "shared",
        subProvider: "openai",
        credentialState: "reauth_required" as const,
        isCustom: false,
        capabilities: null,
      },
    ];
    expect(currentModelCredentialRequirement(models, undefined, "shared")).toContain(
      "Reconnect openai",
    );
    expect(currentModelCredentialRequirement(models, undefined, "openai:shared")).toContain(
      "Reconnect openai",
    );
    expect(
      currentModelCredentialRequirement(
        [...models, { ...models[0]!, slug: "other:shared" }],
        undefined,
        "shared",
      ),
    ).toBeNull();
  });
  it("keeps a usable provider ahead of a model that needs a separate account", () => {
    const anthropic = {
      slug: "anthropic:example",
      subProvider: "anthropic",
      credentialState: "needs_auth" as const,
    };
    const openai = {
      slug: "openai:example",
      subProvider: "openai",
      credentialState: "connected" as const,
    };
    const input = [anthropic, openai];
    expect(modelsWithCredentialsFirst(input)).toEqual([openai, anthropic]);
    expect(input).toEqual([anthropic, openai]);
    expect(modelCredentialRequirement(anthropic)).toContain("Connect anthropic");
    expect(modelCredentialRequirement(openai)).toBeNull();
  });

  it("does not invent an auth failure for older servers or host-managed bindings", () => {
    for (const credentialState of [undefined, "unknown", "host_managed", "connected"] as const) {
      expect(modelCredentialRequirement({ credentialState })).toBeNull();
    }
    expect(
      modelCredentialRequirement({ credentialState: "reauth_required", subProvider: "openai" }),
    ).toContain("Reconnect openai");
  });
});

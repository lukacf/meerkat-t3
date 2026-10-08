import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { resolveProviderWorkspaceReadiness } from "@t3tools/client-runtime/providerWorkspaceReadiness";
import { describe, expect, it } from "vite-plus/test";
import { toAppModelOption, type AppModelOption } from "../../modelSelection";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  getComposerModelSendBlock,
  getProjectHomeAccountSetup,
  projectHomeAccountSetupMessage,
  resolveComposerPrimaryActionAvailability,
} from "./composerModelReadiness";

describe("composer primary-action availability", () => {
  const connected = {
    environmentUnavailable: false,
    noProviderAvailable: false,
    providerCatalogPending: false,
    projectSelectionRequired: false,
    sendDisabledReason: null,
  };

  it("keeps a removed provider blocked without calling the connected computer disconnected", () => {
    const unavailable = resolveComposerPrimaryActionAvailability({
      ...connected,
      noProviderAvailable: true,
    });
    expect(unavailable).toEqual({
      isEnvironmentUnavailable: false,
      sendDisabledReason: "The selected provider is unavailable. Check provider settings.",
    });

    expect(resolveComposerPrimaryActionAvailability(connected)).toEqual({
      isEnvironmentUnavailable: false,
      sendDisabledReason: null,
    });
  });

  it("keeps a project-less draft blocked and distinguishes catalog loading from absence", () => {
    expect(
      resolveComposerPrimaryActionAvailability({ ...connected, projectSelectionRequired: true }),
    ).toEqual({
      isEnvironmentUnavailable: false,
      sendDisabledReason: "Choose a project to send a message.",
    });
    expect(
      resolveComposerPrimaryActionAvailability({
        ...connected,
        noProviderAvailable: true,
        providerCatalogPending: true,
      }),
    ).toEqual({
      isEnvironmentUnavailable: false,
      sendDisabledReason: "Checking available providers...",
    });
  });

  it("preserves actual disconnection and a more specific existing admission reason", () => {
    const offline = resolveComposerPrimaryActionAvailability({
      ...connected,
      environmentUnavailable: true,
      noProviderAvailable: true,
      sendDisabledReason: "Recover the saved message first",
    });
    expect(offline).toEqual({
      isEnvironmentUnavailable: true,
      sendDisabledReason: "Recover the saved message first",
    });
    expect(
      resolveComposerPrimaryActionAvailability({ ...connected, environmentUnavailable: true }),
    ).toEqual({ isEnvironmentUnavailable: true, sendDisabledReason: null });
  });

  it("preserves the existing primary-action disabled boundary for every blocker combination", () => {
    for (const environmentUnavailable of [false, true]) {
      for (const noProviderAvailable of [false, true]) {
        for (const projectSelectionRequired of [false, true]) {
          for (const sendDisabledReason of [null, "Messages loading"]) {
            const state = resolveComposerPrimaryActionAvailability({
              environmentUnavailable,
              noProviderAvailable,
              projectSelectionRequired,
              sendDisabledReason,
              providerCatalogPending: false,
            });
            expect(state.isEnvironmentUnavailable || state.sendDisabledReason !== null).toBe(
              environmentUnavailable ||
                noProviderAvailable ||
                projectSelectionRequired ||
                sendDisabledReason !== null,
            );
          }
        }
      }
    }
  });
});

const nativeModel: AppModelOption = {
  slug: "openai:example",
  name: "Example",
  isCustom: false,
  subProvider: "openai",
  credentialState: "connected",
};

function entry(overrides: Partial<ServerProvider> = {}) {
  return deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make("meerkat_work"),
      driver: ProviderDriverKind.make("meerkat"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-04T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
      ...overrides,
    },
  ])[0]!;
}

function readiness(
  provider = entry(),
  options: ReadonlyArray<AppModelOption> = [nativeModel],
  selected = nativeModel.slug,
  overrides: Partial<Parameters<typeof getComposerModelSendBlock>[0]> = {},
) {
  return getComposerModelSendBlock({
    entries: [provider],
    selections: [{ instanceId: provider.instanceId, model: selected }],
    modelOptionsByInstance: new Map([[provider.instanceId, options]]),
    catalogKnown: true,
    continuesActiveTurn: false,
    nativeInstanceIds: new Set(provider.driverKind === "meerkat" ? [provider.instanceId] : []),
    ...overrides,
  });
}

describe("saved native reasoning admission", () => {
  it.each(["level", "control"] as const)(
    "blocks the same available model after its reasoning %s disappears until the choice is resolved",
    (removed) => {
      const provider = entry({
        models: [
          {
            ...nativeModel,
            capabilities: {
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
            },
          },
        ],
      });
      const selection = {
        instanceId: provider.instanceId,
        model: nativeModel.slug,
        options: [{ id: "reasoning_effort", value: "high" }],
      };
      expect(
        readiness(provider, [nativeModel], nativeModel.slug, {
          selections: [selection],
        })?.reason,
      ).toContain("saved reasoning level is unavailable");
      expect(
        readiness(provider, [nativeModel], nativeModel.slug, {
          selections: [selection],
          continuesActiveTurn: true,
        }),
      ).toBeNull();
      for (const options of [undefined, [{ id: "reasoning_effort", value: "default" }]]) {
        expect(
          readiness(provider, [nativeModel], nativeModel.slug, {
            selections: [
              {
                instanceId: provider.instanceId,
                model: nativeModel.slug,
                ...(options ? { options } : {}),
              },
            ],
          }),
        ).toBeNull();
      }
      if (removed === "level") {
        expect(
          readiness(provider, [nativeModel], nativeModel.slug, {
            selections: [{ ...selection, options: [{ id: "reasoning_effort", value: "low" }] }],
          }),
        ).toBeNull();
      }
    },
  );
});

describe("composer model admission", () => {
  it("blocks a captured selection when scoped readiness disappears before dispatch", () => {
    const provider = entry();
    expect(readiness(provider)).toBeNull();
    expect(
      readiness(provider, [nativeModel], nativeModel.slug, {
        pendingWorkspaceInstanceIds: new Set([provider.instanceId]),
      }),
    ).toEqual({ reason: "Checking models for this workspace...", action: null });
    expect(
      readiness(provider, [nativeModel], nativeModel.slug, {
        pendingWorkspaceInstanceIds: new Set([provider.instanceId]),
        continuesActiveTurn: true,
      }),
    ).toBeNull();
  });

  it("blocks a failed exact workspace check even if it retained a cached model", () => {
    expect(
      readiness(entry({ supportsWorkspaceReadiness: true, status: "error" }))?.reason,
    ).toContain("Could not check models for this workspace");
  });
  it.each(["required", "invalid", "restart-required"] as const)(
    "holds restored %s work even for active-turn replies",
    (status) => {
      const restoreReview = {
        status,
        restoreId: "restore",
        restoredAt: null,
        backupCreatedAt: null,
        message: "Paused",
      };
      const provider = entry();
      const input = { restoreReview, continuesActiveTurn: true };
      expect(readiness(provider, [nativeModel], nativeModel.slug, input)?.reason).toContain(
        "paused",
      );
      expect(
        readiness(provider, [nativeModel], nativeModel.slug, {
          ...input,
          restoreReview: { ...restoreReview, status: "clear" },
        }),
      ).toBeNull();
    },
  );
  it.each(["gpt-6-astra", "claude-fable-5", "openai:old-model"])(
    "blocks stale selection %s with account setup guidance when the native catalog is empty",
    (selected) => {
      const provider = entry({ status: "warning", auth: { status: "unauthenticated" } });
      expect(readiness(provider, [], selected)).toEqual({
        reason: "Connect a model account to send.",
        accountSetup: { instanceId: provider.instanceId, model: selected },
        action: {
          kind: "settings",
          instanceId: provider.instanceId,
          label: "Connect model account",
        },
      });
    },
  );

  it("does not invent a missing credential during catalog loading or an empty refresh", () => {
    const provider = entry({ auth: { status: "unknown" } });
    expect(readiness(provider, [], "old", { catalogKnown: false })).toEqual({
      reason: "Checking available models...",
      action: null,
    });
    expect(readiness(provider, [], "old")).toEqual({
      reason: expect.stringContaining("No models are available"),
      action: {
        kind: "settings",
        instanceId: provider.instanceId,
        label: "Open provider settings",
      },
    });
  });

  it.each([undefined, "unknown", "host_managed", "connected"] as const)(
    "permits a catalog model with %s credentials while runtime auth remains unknown",
    (credentialState) => {
      const option = { ...nativeModel, credentialState };
      expect(readiness(entry({ auth: { status: "unknown" } }), [option])).toBeNull();
    },
  );

  it.each(["needs_auth", "reauth_required"] as const)(
    "routes explicit %s for the selected account to its exact instance",
    (credentialState) => {
      const provider = entry();
      const block = readiness(provider, [{ ...nativeModel, credentialState }]);
      expect(block?.reason).toBe(
        credentialState === "reauth_required"
          ? "Reconnect this model account to send."
          : "Connect a model account to send.",
      );
      expect(block?.accountSetup).toEqual({
        instanceId: provider.instanceId,
        model: nativeModel.slug,
      });
      expect(block?.action).toEqual({
        kind: "settings",
        instanceId: provider.instanceId,
        label: "Connect model account",
      });
    },
  );

  it("uses per-model native credentials without treating another missing account as an all-model failure", () => {
    const provider = entry({ auth: { status: "unauthenticated" } });
    expect(readiness(provider)).toBeNull();
    expect(readiness(provider, [{ ...nativeModel, credentialState: "host_managed" }])).toBeNull();
    expect(readiness(provider, [{ ...nativeModel, credentialState: "unknown" }])).not.toBeNull();
  });

  it("rejects a missing or unavailable selected option even when other models exist", () => {
    expect(readiness(entry(), [nativeModel], "missing")?.action).toEqual({
      kind: "models",
      label: "Choose model",
    });
    expect(readiness(entry(), [{ ...nativeModel, isUnavailable: true }])).not.toBeNull();
  });

  it("requires the exact native catalog slug rather than accepting an unqualified name or alias", () => {
    expect(readiness(entry(), [nativeModel], nativeModel.name)).not.toBeNull();
    expect(
      readiness(entry(), [{ ...nativeModel, aliases: ["example-alias"] }], "example-alias"),
    ).not.toBeNull();
    expect(readiness(entry(), [{ ...nativeModel, isCustom: true }])).toBeNull();
  });

  it("blocks stale catalogs for disabled, removed, unavailable, or uninstalled instances", () => {
    const provider = entry();
    for (const unavailable of [
      { ...provider, enabled: false },
      { ...provider, isAvailable: false },
      { ...provider, installed: false },
      { ...provider, status: "disabled" as const },
    ]) {
      expect(readiness(unavailable)).not.toBeNull();
    }
    expect(readiness(provider, [nativeModel], nativeModel.slug, { entries: [] })).not.toBeNull();
  });

  it("keeps unavailable machine guidance actionable even when a captured workspace check is pending", () => {
    const provider = entry({ supportsWorkspaceReadiness: true });
    for (const unavailable of [
      { ...provider, enabled: false },
      { ...provider, isAvailable: false },
      { ...provider, installed: false, status: "error" as const },
      { ...provider, status: "disabled" as const },
      { ...provider, snapshot: { ...provider.snapshot, enabled: false } },
    ]) {
      const pending = { pendingWorkspaceInstanceIds: new Set([provider.instanceId]) };
      const block = readiness(unavailable, [], nativeModel.slug, pending);
      expect(block?.reason).toContain("provider is unavailable");
      expect(block?.action).toEqual({
        kind: "settings",
        instanceId: provider.instanceId,
        label: "Open provider settings",
      });
      expect(
        readiness(unavailable, [], nativeModel.slug, { ...pending, continuesActiveTurn: true }),
      ).toBeNull();
    }
  });

  it("checks every selection using its exact instance instead of a same-driver catalog", () => {
    const first = entry();
    const second = entry({ instanceId: ProviderInstanceId.make("meerkat_personal") });
    const input = {
      entries: [first, second],
      selections: [first, second].map((provider) => ({
        instanceId: provider.instanceId,
        model: nativeModel.slug,
      })),
      modelOptionsByInstance: new Map([
        [first.instanceId, [nativeModel]],
        [second.instanceId, []],
      ]),
    };
    expect(readiness(first, [nativeModel], nativeModel.slug, input)?.action).toEqual({
      kind: "settings",
      instanceId: second.instanceId,
      label: "Open provider settings",
    });
  });

  it("leaves active native steering and answers available during catalog changes", () => {
    expect(
      readiness(entry(), [], "old", { catalogKnown: false, continuesActiveTurn: true }),
    ).toBeNull();
    expect(
      readiness(entry({ auth: { status: "unauthenticated" } }), [], "old", {
        continuesActiveTurn: true,
      }),
    ).toBeNull();
  });

  it.each(["antigravity", "codex", "claudeAgent", "opencode"])(
    "preserves %s custom-model and startup admission while retaining explicit credential blocks",
    (driver) => {
      const provider = entry({
        driver: ProviderDriverKind.make(driver),
        auth: { status: "unknown" },
      });
      expect(readiness(provider, [], "custom-model", { catalogKnown: false })).toBeNull();
      const authModel = {
        ...nativeModel,
        credentialState: "needs_auth" as const,
        capabilities: null,
      };
      expect(readiness({ ...provider, models: [authModel] }, [authModel])).not.toBeNull();
    },
  );

  it("rechecks the original native identity when the provider disappears during preparation", () => {
    const provider = entry();
    expect(readiness(provider)).toBeNull();
    expect(readiness(provider, [], nativeModel.slug, { entries: [] })?.action).toEqual({
      kind: "settings",
      instanceId: provider.instanceId,
      label: "Open provider settings",
    });
  });
});

const homeEnvironmentId = EnvironmentId.make("home-environment");
const missingAccountModel = { ...nativeModel, credentialState: "needs_auth" as const };
function homeAccountInput() {
  const provider = entry({
    status: "warning",
    auth: { status: "unauthenticated" },
    message: "Use the project account. Contact your administrator if access has changed.",
  });
  return {
    environmentId: homeEnvironmentId,
    cwd: "/repo",
    provider: provider.snapshot,
    modelSendBlock: readiness(provider, [missingAccountModel]),
    noticeVisible: true,
    providerBannerVisible: true,
  };
}

describe("scoped composer account guidance", () => {
  it("preserves custom provider prose in one scoped notice without changing its send block", () => {
    const input = homeAccountInput();
    const originalBlock = input.modelSendBlock;
    const accountSetup = getProjectHomeAccountSetup(input);
    expect(accountSetup).toMatchObject({
      environmentId: homeEnvironmentId,
      cwd: "/repo",
      instanceId: input.provider.instanceId,
      model: nativeModel.slug,
      replacesProviderBanner: true,
      providerMessage: input.provider.message,
    });
    expect(projectHomeAccountSetupMessage({ ...input, accountSetup })).toBe(input.provider.message);
    expect(input.modelSendBlock).toBe(originalBlock);
    expect(input.modelSendBlock?.reason).toBe("Connect a model account to send.");
    expect(input.modelSendBlock?.action).toMatchObject({
      kind: "settings",
      instanceId: input.provider.instanceId,
    });
  });

  it("does not resurrect a dismissed banner or consolidate a hidden composer notice", () => {
    const input = homeAccountInput();
    expect(getProjectHomeAccountSetup({ ...input, noticeVisible: false })).toBeNull();
    const accountSetup = getProjectHomeAccountSetup({ ...input, providerBannerVisible: false });
    expect(accountSetup).toMatchObject({ replacesProviderBanner: false, providerMessage: null });
    expect(projectHomeAccountSetupMessage({ ...input, accountSetup })).toBeNull();
  });

  it("follows the current model and active-turn state without hiding another account's warning", () => {
    const input = homeAccountInput();
    const provider = entry(input.provider);
    const connectedModel = { ...nativeModel, slug: "anthropic:connected" };
    const options = [missingAccountModel, connectedModel];
    for (const [model, continuesActiveTurn, shouldConsolidate] of [
      [missingAccountModel.slug, false, true],
      [connectedModel.slug, false, false],
      [missingAccountModel.slug, true, false],
      [missingAccountModel.slug, false, true],
    ] as const) {
      const modelSendBlock = readiness(provider, options, model, { continuesActiveTurn });
      const accountSetup = getProjectHomeAccountSetup({ ...input, modelSendBlock });
      expect(accountSetup?.replacesProviderBanner ?? false).toBe(shouldConsolidate);
      expect(projectHomeAccountSetupMessage({ ...input, accountSetup, modelSendBlock })).toBe(
        shouldConsolidate ? input.provider.message : null,
      );
      if (shouldConsolidate) {
        expect(modelSendBlock?.accountSetup).toEqual({
          instanceId: provider.instanceId,
          model: missingAccountModel.slug,
        });
        expect(modelSendBlock?.action).toMatchObject({
          kind: "settings",
          instanceId: provider.instanceId,
        });
      } else expect(modelSendBlock).toBeNull();
    }
  });

  it.each([
    { status: "error" },
    { status: "disabled" },
    { enabled: false },
    { installed: false },
    { availability: "unavailable" },
    { auth: { status: "unknown" } },
    { driver: ProviderDriverKind.make("codex") },
  ] satisfies Partial<ServerProvider>[])("keeps distinct provider state %j visible", (change) => {
    const input = homeAccountInput();
    expect(
      getProjectHomeAccountSetup({ ...input, provider: { ...input.provider, ...change } }),
    ).toBeNull();
  });

  it.each(["unsupported", "broken"] as const)(
    "keeps %s compatibility guidance visible",
    (status) => {
      const input = homeAccountInput();
      expect(
        getProjectHomeAccountSetup({
          ...input,
          provider: {
            ...input.provider,
            compatibilityAdvisory: {
              status,
              message: "Update the runtime.",
              recommendedVersion: "2.0.0",
              recommendedRange: null,
            },
          },
        }),
      ).toBeNull();
    },
  );

  it("retains a noncredential warning alongside a selected account block", () => {
    const input = homeAccountInput();
    const accountSetup = getProjectHomeAccountSetup({
      ...input,
      provider: { ...input.provider, auth: { status: "authenticated" } },
    });
    expect(accountSetup).toMatchObject({ replacesProviderBanner: false, providerMessage: null });
  });

  it("does not replace useful no-model, restore, pending, or active-turn guidance", () => {
    const input = homeAccountInput();
    const provider = entry();
    const blocks = [
      readiness(provider, [], "removed"),
      readiness(provider, [missingAccountModel], nativeModel.slug, {
        pendingWorkspaceInstanceIds: new Set([provider.instanceId]),
      }),
      readiness(provider, [missingAccountModel], nativeModel.slug, {
        continuesActiveTurn: true,
      }),
      readiness(provider, [missingAccountModel], nativeModel.slug, {
        restoreReview: {
          status: "required",
          restoreId: "restored-profile",
          restoredAt: null,
          backupCreatedAt: null,
          message: "Review restored work",
        },
      }),
    ];
    for (const modelSendBlock of blocks)
      expect(getProjectHomeAccountSetup({ ...input, modelSendBlock })).toBeNull();
    for (const credentialState of ["connected", "host_managed"] as const) {
      const modelSendBlock = readiness(entry({ auth: { status: "unauthenticated" } }), [
        { ...nativeModel, credentialState },
      ]);
      expect(getProjectHomeAccountSetup({ ...input, modelSendBlock })).toBeNull();
    }
  });

  it("does not reuse an explanation after the environment, checkout, model, or instance changes", () => {
    const input = homeAccountInput();
    const accountSetup = getProjectHomeAccountSetup(input);
    for (const scope of [
      { environmentId: EnvironmentId.make("another-environment") },
      { cwd: "/repo/other-checkout" },
      { cwd: null },
    ]) {
      expect(projectHomeAccountSetupMessage({ ...input, accountSetup, ...scope })).toBeNull();
    }
    for (const selection of [
      { instanceId: input.provider.instanceId, model: "anthropic:other" },
      { instanceId: ProviderInstanceId.make("native-other"), model: nativeModel.slug },
    ]) {
      expect(
        projectHomeAccountSetupMessage({
          ...input,
          accountSetup,
          modelSendBlock: { reason: "Connect account", action: null, accountSetup: selection },
        }),
      ).toBeNull();
    }
  });

  it("keeps the primary provider banner when another multi-model selection needs an account", () => {
    const input = homeAccountInput();
    const primary = entry();
    const secondary = entry({ instanceId: ProviderInstanceId.make("native-secondary") });
    const modelSendBlock = readiness(primary, [nativeModel], nativeModel.slug, {
      entries: [primary, secondary],
      selections: [primary, secondary].map((provider) => ({
        instanceId: provider.instanceId,
        model: nativeModel.slug,
      })),
      modelOptionsByInstance: new Map([
        [primary.instanceId, [nativeModel]],
        [secondary.instanceId, [missingAccountModel]],
      ]),
    });
    expect(modelSendBlock?.accountSetup?.instanceId).toBe(secondary.instanceId);
    expect(getProjectHomeAccountSetup({ ...input, modelSendBlock })).toBeNull();
  });

  it("uses only the exact checkout readiness, including a missing snapshot after navigation", () => {
    const input = homeAccountInput();
    const machine = {
      ...input.provider,
      supportsWorkspaceReadiness: true,
      workspaceSnapshots: [
        {
          cwd: "/repo",
          checkedAt: input.provider.checkedAt,
          skills: [],
          slashCommands: [],
          readiness: {
            status: "warning" as const,
            auth: { status: "unauthenticated" as const },
            message: input.provider.message,
            models: [{ ...missingAccountModel, capabilities: null }],
          },
        },
        {
          cwd: "/other",
          checkedAt: input.provider.checkedAt,
          skills: [],
          slashCommands: [],
          readiness: {
            status: "ready" as const,
            auth: { status: "authenticated" as const },
            models: [{ ...nativeModel, capabilities: null }],
          },
        },
      ],
    };
    for (const cwd of ["/repo", "/other", "/unknown"]) {
      const workspace = resolveProviderWorkspaceReadiness([machine], cwd);
      const provider = deriveProviderInstanceEntries(workspace.providers)[0]!;
      const modelSendBlock = readiness(
        provider,
        provider.models.map(toAppModelOption),
        nativeModel.slug,
        {
          pendingWorkspaceInstanceIds: workspace.pendingInstanceIds,
        },
      );
      const accountSetup = getProjectHomeAccountSetup({
        ...input,
        cwd,
        provider: provider.snapshot,
        modelSendBlock,
      });
      if (cwd === "/repo") expect(accountSetup?.cwd).toBe(cwd);
      else expect(accountSetup).toBeNull();
    }
  });
});

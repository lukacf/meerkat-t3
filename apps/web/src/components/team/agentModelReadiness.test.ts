import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type MeerkatAgentWork,
  type ServerProvider,
  type ServerProviderModel,
  type ServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { getAgentDeliveryRetryBlock, getAgentModelSendBlock } from "./agentModelReadiness";

const instanceId = ProviderInstanceId.make("meerkat_work");
const model: ServerProviderModel = {
  slug: "openai:example",
  name: "Example",
  isCustom: false,
  subProvider: "openai",
  credentialState: "connected",
  capabilities: null,
};
const modelAuth: NonNullable<MeerkatAgentWork["modelAuth"]> = {
  state: "connected",
  source: "pinned",
  provider: "openai",
  realmId: "global",
  bindingId: "work-account",
  profileId: "Work-account",
};
function config(
  overrides: Partial<ServerProvider> = {},
): Pick<ServerConfig, "providers" | "settings"> {
  const provider: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("meerkat"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-04T00:00:00.000Z",
    models: [model],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
  return {
    providers: [provider],
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: { [provider.instanceId]: { driver: provider.driver, config: {} } },
    },
  };
}
function block(overrides: Partial<Parameters<typeof getAgentModelSendBlock>[0]> = {}) {
  return getAgentModelSendBlock({
    instanceId,
    selection: { instanceId, model: model.slug },
    currentModel: "example",
    modelAuth,
    steering: false,
    serverConfig: config(),
    ...overrides,
  });
}

describe("specialist model admission", () => {
  it("admits B's explicit models only using B's account projection", () => {
    const serverConfig = config({
      supportsWorkspaceReadiness: true,
      auth: { status: "unauthenticated" },
      models: [{ ...model, credentialState: "needs_auth" }],
      workspaceSnapshots: [
        {
          cwd: "/repo/b",
          checkedAt: "2026-10-04T00:00:00.000Z",
          skills: [],
          slashCommands: [],
          readiness: { status: "ready", auth: { status: "authenticated" }, models: [model] },
        },
      ],
    });
    const selection = { instanceId, model: model.slug };
    expect(block({ serverConfig, cwd: "/repo/b", selection })).toBeNull();
    expect(block({ serverConfig, cwd: "/repo/a", selection })?.reason).toContain(
      "Checking models for this workspace",
    );
    expect(block({ serverConfig, cwd: "/repo/b/worktree", selection })?.reason).toContain(
      "Checking models for this workspace",
    );
    const signedOut = {
      ...serverConfig,
      providers: serverConfig.providers.map((provider) => ({
        ...provider,
        auth: { status: "authenticated" as const },
        models: [model],
        workspaceSnapshots: [
          {
            ...provider.workspaceSnapshots![0]!,
            readiness: {
              status: "warning" as const,
              auth: { status: "unauthenticated" as const },
              models: [{ ...model, credentialState: "reauth_required" as const }],
            },
          },
        ],
      })),
    };
    expect(block({ serverConfig: signedOut, cwd: "/repo/b", selection })?.action).toMatchObject({
      kind: "settings",
      instanceId,
      label: "Connect model account",
    });
  });

  it("keeps active steering available while an exact workspace check is missing or failed", () => {
    const serverConfig = config({ supportsWorkspaceReadiness: true, workspaceSnapshots: [] });
    expect(block({ serverConfig, cwd: "/repo", steering: true })).toBeNull();
    expect(block({ serverConfig, cwd: "/repo" })?.reason).toContain("Checking");
  });

  it.each([
    { installed: false, status: "error" },
    { enabled: false },
    { status: "disabled" },
    { availability: "unavailable" },
  ] satisfies Partial<ServerProvider>[])(
    "blocks explicit and current-model sends with Settings guidance for an ineligible machine %j",
    (overrides) => {
      const serverConfig = config({
        ...overrides,
        supportsWorkspaceReadiness: true,
        workspaceSnapshots: [],
      });
      for (const selection of [undefined, { instanceId, model: model.slug }]) {
        const result = block({ serverConfig, cwd: "/repo", selection });
        expect(result?.reason).toContain("Model access is unavailable");
        expect(result?.action).toEqual({
          kind: "settings",
          instanceId,
          label: "Open provider settings",
        });
        expect(block({ serverConfig, cwd: "/repo", selection, steering: true })).toBeNull();
      }
    },
  );

  it("does not let pending scope hide an instance disabled by current settings", () => {
    const initial = config({ supportsWorkspaceReadiness: true, workspaceSnapshots: [] });
    const serverConfig = {
      ...initial,
      settings: {
        ...initial.settings,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("meerkat"), config: {}, enabled: false },
        },
      },
    };
    for (const selection of [undefined, { instanceId, model: model.slug }]) {
      expect(block({ serverConfig, cwd: "/repo", selection })?.reason).toContain(
        "Model access is unavailable",
      );
    }
  });
  it.each(["required", "invalid", "restart-required"] as const)(
    "holds restored %s work for both new turns and steering",
    (status) => {
      const serverConfig = {
        ...config(),
        restoreReview: {
          status,
          restoreId: "restore",
          restoredAt: null,
          backupCreatedAt: null,
          message: "Paused",
        },
      };
      for (const steering of [false, true]) {
        expect(block({ serverConfig, steering, selection: undefined })?.reason).toContain("paused");
        expect(
          block({
            serverConfig: {
              ...serverConfig,
              restoreReview: { ...serverConfig.restoreReview, status: "clear" },
            },
            steering,
            selection: undefined,
          }),
        ).toBeNull();
      }
    },
  );
  it("requires an exact override from this agent's current native catalog", () => {
    expect(block()).toBeNull();
    for (const slug of ["example", "Example", "openai:removed"]) {
      expect(block({ selection: { instanceId, model: slug } })?.action).toEqual({
        kind: "models",
        label: "Choose model",
      });
    }
    expect(
      block({
        selection: { instanceId: ProviderInstanceId.make("meerkat_personal"), model: model.slug },
      })?.reason,
    ).toContain("another provider");
  });

  it("blocks stale overrides through empty and removed catalogs without guessing credentials", () => {
    expect(block({ serverConfig: undefined })).toEqual({
      reason: "Checking available models...",
      action: null,
    });
    expect(
      block({ serverConfig: config({ models: [], auth: { status: "unknown" } }) })?.reason,
    ).toContain("No models are available");
    expect(block({ serverConfig: { ...config(), providers: [] } })?.action).toEqual({
      kind: "settings",
      instanceId,
      label: "Open provider settings",
    });
  });

  it("admits an exact connected session account independently of the current default catalog", () => {
    expect(block({ selection: undefined, serverConfig: undefined })).toBeNull();
    expect(
      block({
        selection: undefined,
        serverConfig: config({ models: [], auth: { status: "unknown" } }),
      }),
    ).toBeNull();
    expect(block({ selection: undefined, currentModel: "older-session-model" })).toBeNull();
    expect(
      block({
        selection: undefined,
        serverConfig: config({
          supportsWorkspaceReadiness: true,
          workspaceSnapshots: [],
          auth: { status: "unauthenticated" },
          models: [{ ...model, credentialState: "needs_auth" }],
        }),
      }),
    ).toBeNull();
  });

  it.each([undefined, "unknown", "host_managed"] as const)(
    "does not use another connected account to infer %s session access",
    (state) => {
      const currentAuth = state ? { ...modelAuth, state } : undefined;
      expect(
        block({ selection: undefined, currentModel: "older-session-model", modelAuth: currentAuth })
          ?.reason,
      ).toContain("Could not confirm access to this agent's model account");
      expect(block({ selection: undefined, modelAuth: currentAuth })?.action).toEqual({
        kind: "settings",
        instanceId,
        label: "Open provider settings",
      });
      expect(block({ selection: undefined, modelAuth: currentAuth, steering: true })).toBeNull();
      expect(block({ modelAuth: currentAuth })).toBeNull();
    },
  );

  it.each(["needs_auth", "reauth_required"] as const)(
    "blocks known %s for explicit and current models",
    (credentialState) => {
      const serverConfig = config({ models: [{ ...model, credentialState }] });
      expect(block({ serverConfig })?.action).toEqual({
        kind: "settings",
        instanceId,
        label: "Connect model account",
      });
      expect(
        block({
          serverConfig,
          selection: undefined,
          modelAuth: { ...modelAuth, state: credentialState },
        })?.action,
      ).toEqual({
        kind: "settings",
        instanceId,
        label: "Connect model account",
      });
    },
  );

  it("blocks only the retained session account, independently of provider default authentication", () => {
    const signedOut = config({ models: [], auth: { status: "unauthenticated" } });
    expect(
      block({
        serverConfig: config(),
        selection: undefined,
        modelAuth: { ...modelAuth, state: "needs_auth" },
      })?.action,
    ).toEqual({
      kind: "settings",
      instanceId,
      label: "Connect model account",
    });
    expect(block({ serverConfig: signedOut, selection: undefined })).toBeNull();
    expect(
      block({
        selection: undefined,
        modelAuth: { ...modelAuth, state: "reauth_required", accountLabel: "Original account" },
      })?.reason,
    ).toContain('Reconnect the "Original account" account');
  });

  it("does not disable live steering for a missing catalog, missing account, or saved override", () => {
    expect(block({ steering: true, serverConfig: undefined })).toBeNull();
    expect(
      block({
        steering: true,
        serverConfig: config({ models: [], auth: { status: "unauthenticated" } }),
      }),
    ).toBeNull();
  });

  it("honors an instance disabled in current settings before its probe changes", () => {
    const serverConfig = {
      ...config(),
      settings: {
        ...config().settings,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("meerkat"), config: {}, enabled: false },
        },
      },
    };
    expect(block({ serverConfig })?.reason).toContain("Model access is unavailable");
  });
});

describe("explicit specialist delivery retry", () => {
  const attempt = {
    requestId: "original-request",
    agentRef: "original-session",
    text: "Keep this exact message",
    mode: "queue" as const,
    modelSelection: { instanceId, model: model.slug },
  };
  const now = Date.parse("2026-10-04T00:01:00.000Z");
  const input = {
    attempt,
    absentRequestId: attempt.requestId,
    currentAgentRef: attempt.agentRef,
    addressable: true,
    work: { status: "idle", observedAt: new Date(now).toISOString() },
    now,
    instanceId,
    currentModel: "example",
    serverConfig: config(),
  };

  it("admits only an explicit same-session retry after a receipt absence", () => {
    expect(getAgentDeliveryRetryBlock(input)).toBeNull();
    expect(getAgentDeliveryRetryBlock({ ...input, absentRequestId: undefined })?.reason).toContain(
      "Check the earlier delivery",
    );
    expect(
      getAgentDeliveryRetryBlock({ ...input, absentRequestId: "another-request" })?.reason,
    ).toContain("Check the earlier delivery");
    expect(
      getAgentDeliveryRetryBlock({ ...input, currentAgentRef: "replacement-session" })?.reason,
    ).toContain("replacement agent");
    expect(getAgentDeliveryRetryBlock({ ...input, addressable: false })?.reason).toContain(
      "Reconnect",
    );
  });

  it("holds earlier steering and busy or stale session observations", () => {
    expect(
      getAgentDeliveryRetryBlock({ ...input, attempt: { ...attempt, mode: "steer" } })?.reason,
    ).toContain("steering request");
    expect(
      getAgentDeliveryRetryBlock({ ...input, work: { ...input.work, status: "running" } })?.reason,
    ).toContain("become idle");
    expect(getAgentDeliveryRetryBlock({ ...input, now: now + 30_001 })?.reason).toContain(
      "become idle",
    );
    expect(getAgentDeliveryRetryBlock({ ...input, work: undefined })?.reason).toContain(
      "become idle",
    );
  });

  it("rechecks the original model without changing the immutable retry payload", () => {
    const retained = structuredClone(attempt);
    expect(
      getAgentDeliveryRetryBlock({ ...input, serverConfig: config({ models: [] }) }),
    ).not.toBeNull();
    expect(
      getAgentDeliveryRetryBlock({
        ...input,
        serverConfig: config({ models: [{ ...model, credentialState: "needs_auth" }] }),
      }),
    ).not.toBeNull();
    expect(attempt).toEqual(retained);
  });
  it("rechecks the retained account for a retry without a model override", () => {
    const withoutOverride = {
      requestId: attempt.requestId,
      agentRef: attempt.agentRef,
      text: attempt.text,
      mode: attempt.mode,
    };
    const retained = structuredClone(withoutOverride);
    const retry = { ...input, attempt: withoutOverride, modelAuth };
    expect(getAgentDeliveryRetryBlock(retry)).toBeNull();
    expect(
      getAgentDeliveryRetryBlock({
        ...retry,
        modelAuth: { ...modelAuth, state: "needs_auth" },
      })?.reason,
    ).toContain("Connect this agent's model account");
    expect(getAgentDeliveryRetryBlock({ ...retry, modelAuth: undefined })?.reason).toContain(
      "Could not confirm access",
    );
    expect(withoutOverride).toEqual(retained);
  });
  it("holds an explicit retry after restore without changing its original receipt identity", () => {
    const retained = structuredClone(attempt);
    expect(
      getAgentDeliveryRetryBlock({
        ...input,
        serverConfig: {
          ...config(),
          restoreReview: {
            status: "required",
            restoreId: "restore",
            restoredAt: null,
            backupCreatedAt: null,
            message: "Paused",
          },
        },
      })?.reason,
    ).toContain("paused");
    expect(attempt).toEqual(retained);
  });
});

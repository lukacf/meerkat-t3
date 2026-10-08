import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { getProviderSummary } from "./providerStatus";
import {
  preserveSettingsNativeModelSelection,
  resolveSettingsProviderReadiness,
  settingsModelUnavailableLabel,
} from "./settingsProviderReadiness";

const environmentId = EnvironmentId.make("remote");
const instanceId = ProviderInstanceId.make("meerkat");
const modelA: ServerProviderModel = {
  slug: "openai:fixture-a",
  name: "Fixture A",
  isCustom: true,
  capabilities: null,
};
const modelB: ServerProviderModel = { ...modelA, slug: "openai:fixture-b", name: "Fixture B" };
function member(id: string, environment = environmentId): SidebarProjectGroupMember {
  return {
    id: ProjectId.make(id),
    environmentId: environment,
    workspaceRoot: `/projects/${id}`,
    title: id,
    physicalProjectKey: `${environment}:${id}`,
    environmentLabel: "Remote",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
  };
}
const a = member("a");
const b = member("b");
const target = { environmentId, projectId: b.id };
const scope = { kind: "checkout" as const, members: [a, b] };
const native: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("meerkat"),
  enabled: true,
  installed: true,
  status: "warning",
  auth: { status: "unauthenticated" },
  version: "0.8.50",
  models: [modelA],
  checkedAt: "2026-10-04T00:00:00.000Z",
  skills: [],
  slashCommands: [],
  supportsWorkspaceReadiness: true,
  workspaceSnapshots: [
    {
      cwd: b.workspaceRoot,
      checkedAt: "2026-10-04T01:00:00.000Z",
      skills: [],
      slashCommands: [],
      readiness: {
        status: "ready",
        auth: { status: "authenticated", label: "B account" },
        models: [modelB],
      },
    },
  ],
};

describe("Settings checkout provider truth", () => {
  it("offers B models and B account without changing the inherited A setting or machine snapshot", () => {
    const saved = { instanceId, model: modelA.slug };
    const result = resolveSettingsProviderReadiness(scope, target, [native]);
    const selection = resolveDefaultProviderModelSelection(result.providers, saved);
    expect(selection).toBe(saved);
    expect(settingsModelUnavailableLabel(result.providers, selection)).toBe(
      `${modelA.slug} (Unavailable)`,
    );
    const options = getCustomModelOptionsByInstance(
      DEFAULT_UNIFIED_SETTINGS,
      result.providers,
      instanceId,
      saved.model,
    ).get(instanceId);
    expect(options?.map((model) => model.slug)).toEqual([modelB.slug]);
    expect(getProviderSummary(result.providers[0]).headline).toBe(
      "Credentials detected · B account",
    );
    expect(native.auth.status).toBe("unauthenticated");
    expect(native.models).toEqual([modelA]);
  });

  it("keeps an explicit auxiliary preference visible instead of silently displaying a fallback", () => {
    const providers = resolveSettingsProviderReadiness(scope, target, [native]).providers;
    const saved = {
      instanceId,
      model: modelA.slug,
      options: [{ id: "reasoning_effort", value: "high" }],
    };
    const resolved = resolveAppModelSelectionState(
      { ...DEFAULT_UNIFIED_SETTINGS, textGenerationModelSelection: saved },
      providers,
    );
    expect(resolved.model).toBe(modelB.slug);
    expect(preserveSettingsNativeModelSelection(providers, saved, resolved)).toBe(saved);
    expect(preserveSettingsNativeModelSelection(providers, null, resolved)).toBe(resolved);
    expect(
      settingsModelUnavailableLabel(providers, { instanceId, model: modelB.slug }),
    ).toBeUndefined();
  });

  it("shows unknown account and no models while the exact B row is absent or invalidated", () => {
    for (const candidate of [
      { ...native, workspaceSnapshots: [] },
      {
        ...native,
        workspaceSnapshots: [{ ...native.workspaceSnapshots![0]!, cwd: a.workspaceRoot }],
      },
    ]) {
      const result = resolveSettingsProviderReadiness(scope, target, [candidate]);
      expect(result.cwd).toBe(b.workspaceRoot);
      expect(result.pendingInstanceIds.has(instanceId)).toBe(true);
      expect(result.providers[0]).toMatchObject({
        auth: { status: "unknown" },
        models: [],
        installed: true,
        version: "0.8.50",
      });
      expect(getProviderSummary(result.providers[0], true).headline).toBe(
        "Checking checkout account",
      );
    }
  });

  it("matches both project and environment rather than the first same-machine member", () => {
    const collision = { ...b, environmentId: EnvironmentId.make("other"), workspaceRoot: "/wrong" };
    const result = resolveSettingsProviderReadiness(
      { kind: "project", members: [a, collision, b] },
      target,
      [native],
    );
    expect(result.cwd).toBe(b.workspaceRoot);
    expect(result.providers[0]?.models).toEqual([modelB]);
    const missing = resolveSettingsProviderReadiness(
      { kind: "project", members: [a, collision] },
      target,
      [native],
    );
    expect(missing.cwd).toBeNull();
    expect(missing.providers[0]?.models).toEqual([]);
  });

  it("never broadens a missing project target or stale Settings selection to the default realm", () => {
    expect(resolveSettingsProviderReadiness(scope, null, [native]).providers[0]?.models).toEqual(
      [],
    );
    expect(
      resolveSettingsProviderReadiness({ kind: "unavailable", members: [] }, target, [native])
        .providers[0]?.auth.status,
    ).toBe("unknown");
  });

  it.each(["all", "environment"] as const)(
    "retains the machine snapshot for %s defaults",
    (kind) => {
      const providers = [native];
      const result = resolveSettingsProviderReadiness(
        { kind, members: [] },
        { environmentId, projectId: null },
        providers,
      );
      expect(result.providers).toBe(providers);
      expect(result.projectScoped).toBe(false);
      expect(result.pendingInstanceIds.size).toBe(0);
    },
  );

  it("keeps donor and capability-absent server behavior intact at project scope", () => {
    const { supportsWorkspaceReadiness: _capability, ...legacy } = native;
    const donor = { ...native, driver: ProviderDriverKind.make("codex") };
    const result = resolveSettingsProviderReadiness(scope, target, [legacy, donor]);
    expect(result.providers).toEqual([legacy, donor]);
    expect(result.providers[0]).toBe(legacy);
    expect(result.providers[1]).toBe(donor);
    expect(result.pendingInstanceIds.size).toBe(0);
  });

  it.each([{ installed: false }, { enabled: false }, { availability: "unavailable" as const }])(
    "does not show a never-ending checkout check for an ineligible machine: %j",
    (state) => {
      const result = resolveSettingsProviderReadiness(scope, target, [
        { ...native, ...state, workspaceSnapshots: [] },
      ]);
      expect(result.pendingInstanceIds.size).toBe(0);
      expect(result.providers[0]?.models).toEqual([]);
    },
  );
});

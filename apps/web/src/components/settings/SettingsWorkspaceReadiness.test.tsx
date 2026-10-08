import { act, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import type { resolveSettingsProviderReadiness } from "./settingsProviderReadiness";
import { deriveProviderInstanceEntries } from "../../providerInstances";

type Scope = NonNullable<Parameters<typeof resolveSettingsProviderReadiness>[0]>;
type Target = NonNullable<Parameters<typeof resolveSettingsProviderReadiness>[1]> & {
  label: string;
  settings: typeof DEFAULT_UNIFIED_SETTINGS;
};
type Environment = {
  environmentId: EnvironmentId;
  isPrimary: boolean;
  label: string;
  serverConfig: { providers: ServerProvider[]; settings: typeof DEFAULT_UNIFIED_SETTINGS } | null;
};
const state = vi.hoisted(() => ({
  refresh: vi.fn(),
  save: vi.fn(),
  access: "granted" as "granted" | "denied" | "pending",
  desktop: false,
  primarySessionRead: vi.fn(),
  context: null as { scope: Scope; target: Target | null; targets: Target[] } | null,
  environments: [] as Environment[],
}));
vi.mock("../../env", () => ({
  get isElectron() {
    return state.desktop;
  },
}));
vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => {
    state.primarySessionRead();
    return {
      data:
        state.access === "pending"
          ? null
          : {
              authenticated: true,
              scopes: state.access === "granted" ? ["orchestration:operate"] : [],
            },
      isPending: state.access === "pending",
      error: null,
    };
  },
}));
vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({
    data:
      state.access === "pending"
        ? null
        : {
            authenticated: true,
            scopes: state.access === "granted" ? ["orchestration:operate"] : [],
          },
    isPending: state.access === "pending",
    hasError: false,
  }),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { refreshProviders: "refresh" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.refresh }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("./SettingsScopeContext", () => ({
  useOptionalSettingsScope: () => state.context,
  useSettingsScope: () => state.context,
}));
import { SettingsWorkspaceReadiness } from "./SettingsWorkspaceReadiness";
import { useSettingsProviderReadiness } from "./useSettingsProviderReadiness";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";

const environmentId = EnvironmentId.make("remote");
const instanceId = ProviderInstanceId.make("meerkat");
const settings: typeof DEFAULT_UNIFIED_SETTINGS = {
  ...DEFAULT_UNIFIED_SETTINGS,
  providerInstances: {
    [instanceId]: { driver: ProviderDriverKind.make("meerkat"), enabled: true },
  },
};
const stamp = "2026-10-04T00:00:00.000Z";
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
    createdAt: stamp,
    updatedAt: stamp,
  };
}
const a = member("a");
const b = member("b");
function provider(cwds: string[] = []): ServerProvider {
  const model = (slug: string) => ({ slug, name: slug, isCustom: true, capabilities: null });
  return {
    instanceId,
    driver: ProviderDriverKind.make("meerkat"),
    enabled: true,
    installed: true,
    status: "warning",
    auth: { status: "unauthenticated" },
    version: null,
    models: [model("openai:default-a")],
    checkedAt: stamp,
    skills: [],
    slashCommands: [],
    supportsWorkspaceReadiness: true,
    workspaceSnapshots: cwds.map((cwd) => ({
      cwd,
      checkedAt: stamp,
      skills: [],
      slashCommands: [],
      readiness: {
        status: "ready",
        auth: { status: "authenticated" },
        models: [model("openai:common"), model(`openai:${cwd}`)],
      },
    })),
  };
}
function target(member: SidebarProjectGroupMember): Target {
  return {
    environmentId: member.environmentId,
    projectId: member.id,
    label: member.title,
    settings,
  };
}
function environment(providers: ServerProvider[], id = environmentId): Environment {
  return {
    environmentId: id,
    isPrimary: false,
    label: id,
    serverConfig: { providers, settings },
  };
}
function ModelCheck({ model }: { model: string }) {
  const readiness = useSettingsProviderReadiness(
    environmentId,
    state.environments[0]?.serverConfig?.providers ?? [],
  );
  const blocked = useScopedModelDisabledReason(
    settings,
    deriveProviderInstanceEntries(readiness.providers),
  );
  return (
    <>
      <output>
        {readiness.providers.flatMap((row) => row.models.map((model) => model.slug)).join(",")}
      </output>
      <button
        onClick={() => {
          if (!blocked(instanceId, model)) state.save({ instanceId, model });
        }}
      >
        Choose model
      </button>
      <span>{blocked(instanceId, model)}</span>
    </>
  );
}
function Harness({ model }: { model: string }) {
  return (
    <SettingsWorkspaceReadiness scope={state.context!.scope} environments={state.environments}>
      <ModelCheck model={model} />
    </SettingsWorkspaceReadiness>
  );
}
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.refresh.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { providers: [provider([a.workspaceRoot, b.workspaceRoot])] },
  });
  state.save.mockReset();
  state.access = "granted";
  state.desktop = false;
  state.primarySessionRead.mockReset();
  state.context = {
    scope: { kind: "checkout", members: [b] },
    target: target(b),
    targets: [target(b)],
  };
  state.environments = [environment([provider([b.workspaceRoot])])];
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("probes every exact selected checkout, including two on the same environment, then rechecks invalidation", async () => {
  const scope: Scope = { kind: "project", members: [a, b] };
  await act(async () => {
    renderer = create(
      <SettingsWorkspaceReadiness scope={scope} environments={[environment([provider()])]} />,
    );
  });
  expect(state.refresh.mock.calls.map(([request]) => request)).toEqual([
    { environmentId, input: { instanceId, cwd: a.workspaceRoot } },
    { environmentId, input: { instanceId, cwd: b.workspaceRoot } },
  ]);
  await act(async () =>
    renderer!.update(
      <SettingsWorkspaceReadiness
        scope={scope}
        environments={[environment([provider([a.workspaceRoot, b.workspaceRoot])])]}
      />,
    ),
  );
  expect(state.refresh).toHaveBeenCalledTimes(2);
  await act(async () =>
    renderer!.update(
      <SettingsWorkspaceReadiness
        scope={scope}
        environments={[environment([provider([a.workspaceRoot])])]}
      />,
    ),
  );
  expect(state.refresh).toHaveBeenCalledTimes(3);
  expect(state.refresh.mock.lastCall?.[0].input.cwd).toBe(b.workspaceRoot);
});

it("does not probe environment defaults, unavailable selections, or disconnected members", async () => {
  for (const kind of ["all", "environment", "unavailable"] as const) {
    await act(async () => {
      renderer = create(
        <SettingsWorkspaceReadiness
          scope={{ kind, members: [b] }}
          environments={[environment([provider()])]}
        />,
      );
    });
    await act(async () => renderer!.unmount());
  }
  await act(async () => {
    renderer = create(
      <SettingsWorkspaceReadiness
        scope={{ kind: "checkout", members: [b] }}
        environments={[{ environmentId, isPrimary: false, serverConfig: null }]}
      />,
    );
  });
  expect(state.refresh).not.toHaveBeenCalled();
});

it("uses the explicit representative target instead of the first same-machine checkout", async () => {
  state.context = {
    scope: { kind: "project", members: [a, b] },
    target: target(b),
    targets: [target(a), target(b)],
  };
  state.environments = [environment([provider([a.workspaceRoot, b.workspaceRoot])])];
  await act(async () => {
    renderer = create(<Harness model="openai:common" />);
  });
  expect(renderer!.root.findByType("output").children).toEqual([
    "openai:common,openai:/projects/b",
  ]);
  act(() => renderer!.root.findByType("button").props.onClick());
  expect(state.save).toHaveBeenCalledOnce();
});

it("prevents a B-only model being saved to grouped A and B targets", async () => {
  state.context = {
    scope: { kind: "project", members: [a, b] },
    target: target(b),
    targets: [target(a), target(b)],
  };
  state.environments = [environment([provider([a.workspaceRoot, b.workspaceRoot])])];
  await act(async () => {
    renderer = create(<Harness model="openai:/projects/b" />);
  });
  expect(renderer!.root.findByType("span").children[0]).toContain(a.workspaceRoot);
  act(() => renderer!.root.findByType("button").props.onClick());
  expect(state.save).not.toHaveBeenCalled();
});

it("stops offering the default catalog while pending and admits a choice only after exact readiness arrives", async () => {
  state.environments = [environment([provider()])];
  await act(async () => {
    renderer = create(<Harness model="openai:common" />);
  });
  expect(renderer!.root.findByType("output").children).toEqual([]);
  expect(renderer!.root.findByType("span").children[0]).toContain(
    "Checking models for /projects/b",
  );
  act(() => renderer!.root.findByType("button").props.onClick());
  expect(state.save).not.toHaveBeenCalled();
  state.environments = [environment([provider([b.workspaceRoot])])];
  await act(async () => renderer!.update(<Harness model="openai:common" />));
  act(() => renderer!.root.findByType("button").props.onClick());
  expect(state.save).toHaveBeenCalledOnce();
  state.environments = [environment([provider()])];
  await act(async () => renderer!.update(<Harness model="openai:common" />));
  act(() => renderer!.root.findByType("button").props.onClick());
  expect(state.save).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "waits for actual operate permission before probing (primary=%s), and cancels probing on denial",
  async (primary) => {
    vi.useFakeTimers();
    state.access = "pending";
    state.environments = [{ ...environment([provider()]), isPrimary: primary }];
    await act(async () => {
      renderer = create(<Harness model="openai:common" />);
    });
    expect(state.refresh).not.toHaveBeenCalled();
    expect(renderer!.root.findByType("span").children[0]).toContain(
      "Waiting for connection permissions",
    );
    state.access = "denied";
    await act(async () => renderer!.update(<Harness model="openai:common" />));
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(state.refresh).not.toHaveBeenCalled();
    expect(renderer!.root.findByType("output").children).toEqual([]);
    expect(renderer!.root.findByType("span").children[0]).toContain("Reconnect with permission");
    state.access = "granted";
    await act(async () => renderer!.update(<Harness model="openai:common" />));
    expect(state.refresh).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, cwd: b.workspaceRoot },
    });
    state.access = "denied";
    await act(async () => renderer!.update(<Harness model="openai:common" />));
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(state.refresh).toHaveBeenCalledOnce();
  },
);

it("allows only the owned desktop primary without a cookie permission lookup", async () => {
  state.desktop = true;
  state.access = "denied";
  state.environments = [{ ...environment([provider()]), isPrimary: true }];
  await act(async () => {
    renderer = create(<Harness model="openai:common" />);
  });
  expect(state.refresh).toHaveBeenCalledOnce();
  expect(state.primarySessionRead).not.toHaveBeenCalled();
});

it("keeps an exact cached checkout catalog readable on a read-only connection", async () => {
  state.access = "denied";
  await act(async () => {
    renderer = create(<Harness model="openai:common" />);
  });
  expect(state.refresh).not.toHaveBeenCalled();
  expect(renderer!.root.findByType("output").children).toEqual([
    "openai:common,openai:/projects/b",
  ]);
});

it("preserves an unsaved Settings edit as grouped environments are added, reordered, and removed", async () => {
  state.access = "denied";
  const otherId = EnvironmentId.make("other");
  const otherMember = member("other", otherId);
  const scope: Scope = { kind: "project", members: [b, otherMember] };
  const first = environment([provider([b.workspaceRoot])]);
  const other = environment([provider([otherMember.workspaceRoot])], otherId);
  const mount = vi.fn(() => "");
  function Draft() {
    const [value, setValue] = useState(mount);
    return <input value={value} onChange={(event) => setValue(event.target.value)} />;
  }
  await act(async () => {
    renderer = create(
      <SettingsWorkspaceReadiness scope={scope} environments={[first]}>
        <Draft />
      </SettingsWorkspaceReadiness>,
    );
  });
  act(() =>
    renderer!.root.findByType("input").props.onChange({ target: { value: "unsaved edit" } }),
  );
  for (const environments of [[first, other], [other, first], [first], []]) {
    await act(async () =>
      renderer!.update(
        <SettingsWorkspaceReadiness scope={scope} environments={environments}>
          <Draft />
        </SettingsWorkspaceReadiness>,
      ),
    );
    expect(renderer!.root.findByType("input").props.value).toBe("unsaved edit");
  }
  expect(mount).toHaveBeenCalledOnce();
  expect(state.refresh).not.toHaveBeenCalled();
});

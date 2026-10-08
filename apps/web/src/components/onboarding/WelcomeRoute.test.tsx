import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type OnboardingProgress,
} from "@t3tools/contracts/settings";
import { Atom } from "effect/unstable/reactivity";
import { act, useState, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const persistence = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
}));
const workspace = vi.hoisted(() => ({
  environments: [] as Array<{
    environmentId: EnvironmentId;
    label: string;
    connection: { phase: "connected" };
  }>,
  projectMounts: vi.fn(),
  providers: vi.fn(),
  config: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  navigate: vi.fn<() => Promise<void>>(),
}));
vi.mock("~/localApi", () => ({ ensureLocalApi: () => ({ persistence }) }));
vi.mock("@clerk/react", () => ({ useAuth: () => ({}) }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => workspace.navigate,
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: "/welcome" }),
  createFileRoute: () => (options: { component: () => ReactNode }) => ({
    options,
    useRouteContext: () => ({ authGateState: { status: "authenticated" } }),
  }),
}));
vi.mock("../NoProjectsHero", () => ({
  NoProjectsHero: () => <button>Add project</button>,
}));
vi.mock("../../cloud/publicConfig", () => ({
  hasCloudPublicConfig: () => false,
  resolveRelayTracingConfig: () => null,
  resolveCloudPublicConfig: (): import("../../cloud/publicConfig").CloudPublicConfig => ({
    clerkPublishableKey: null,
    clerkJwtTemplate: null,
    relayUrl: null,
    relayTracing: { tracesUrl: null, tracesDataset: null, tracesToken: null },
  }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: workspace.environments, isReady: true }),
  usePrimaryEnvironment: () => workspace.environments[0],
}));
vi.mock("../../onboarding/useProjectScans", () => ({ useProjectScans: () => [] }));
vi.mock("../../state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/server")>();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: workspace.providers,
      configValueAtom: workspace.config,
      refreshProviders: "refresh",
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => workspace.refresh }));
vi.mock("../ThreadTerminalDrawer", () => ({ TerminalViewport: () => null }));
vi.mock("../cloud/CloudEnvironmentConnectList", () => ({
  CloudEnvironmentConnectRows: () => null,
}));
vi.mock("../clerk/useT3ConnectAuthPrompt", () => ({ useT3ConnectAuthPrompt: () => vi.fn() }));
vi.mock("./OnboardingCredentials", () => ({ OnboardingCredentials: () => null }));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/wizard", () => ({
  WizardPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  WizardPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  WizardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  WizardSteps: ({
    steps,
    isStepDisabled,
    onStepChange,
  }: ComponentProps<typeof import("../ui/wizard").WizardSteps>) => (
    <nav>
      {steps.map((label, index) => (
        <button
          key={label}
          disabled={isStepDisabled?.(index)}
          onClick={() => onStepChange?.(index)}
        >
          {label}
        </button>
      ))}
    </nav>
  ),
}));
vi.mock("../ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));
vi.mock("../ui/collapsible", () => ({
  Collapsible: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  CollapsiblePanel: () => null,
}));
vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: workspace.toast } }));
vi.mock("../ui/button", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<"button"> & { size?: string; variant?: string }) => <button {...props} />,
}));
vi.mock("./OnboardingProjectStep", () => ({
  OnboardingProjectStep: ({
    environmentIds,
    initialProjectRef,
  }: ComponentProps<typeof import("./OnboardingProjectStep").OnboardingProjectStep>) => {
    const [draft, setDraft] = useState(() => {
      workspace.projectMounts();
      return "";
    });
    return (
      <section aria-label="Project setup">
        <output>{environmentIds.join(",")}</output>
        <output>{initialProjectRef?.projectId}</output>
        <input value={draft} onChange={(event) => setDraft(event.target.value)} />
      </section>
    );
  },
}));

import {
  __resetClientSettingsPersistenceForTests,
  getClientSettings,
  persistClientSettingsUpdate,
} from "../../hooks/useSettings";
import { Route as WelcomeRoute } from "../../routes/welcome";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("saved-remote");
const projectId = ProjectId.make("saved-project");
const threadId = ThreadId.make("saved-first-task");
const progress: OnboardingProgress = {
  step: "projects",
  environmentIds: [remote],
  startedAt: "2026-10-05T10:00:00.000Z",
  projectRef: { environmentId: remote, projectId },
  threadId: null,
};
const savedSettings: ClientSettings = {
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: null,
  onboardingProgress: progress,
};
let renderer: ReactTestRenderer | undefined;

function deferredSettings() {
  let resolve!: (value: ClientSettings | null) => void;
  const promise = new Promise<ClientSettings | null>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function render() {
  const Component = WelcomeRoute.options.component!;
  await Component.preload?.();
  await act(async () => {
    renderer = create(<Component />);
  });
}

async function click(label: string) {
  const button = renderer!.root
    .findAllByType("button")
    .find((node) => node.children.includes(label))!;
  expect(button).toBeDefined();
  expect(button.props.disabled).not.toBe(true);
  await act(async () => button.props.onClick());
}

async function deselectRemote() {
  const checkbox = renderer!.root.findAllByProps({ type: "checkbox" })[1]!;
  expect(checkbox.props.checked).toBe(true);
  await act(async () => checkbox.props.onChange({ target: { checked: false } }));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { activeElement: null, body: {} });
  persistence.getClientSettings.mockReset();
  persistence.setClientSettings.mockReset().mockResolvedValue(undefined);
  workspace.environments = [local, remote].map((environmentId) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected" },
  }));
  workspace.projectMounts.mockReset();
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("meerkat"),
    driver: ProviderDriverKind.make("meerkat"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-05T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  workspace.providers.mockReset().mockReturnValue(Atom.make([provider]));
  workspace.config.mockReset().mockReturnValue(Atom.make(null));
  workspace.refresh.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  workspace.toast.mockReset();
  workspace.navigate.mockReset().mockResolvedValue(undefined);
  __resetClientSettingsPersistenceForTests();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  __resetClientSettingsPersistenceForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["projects", "first-task"] as const)(
  "waits for a cold direct welcome read before restoring saved %s progress",
  async (step) => {
    const read = deferredSettings();
    persistence.getClientSettings.mockReturnValueOnce(read.promise);
    await render();
    expect(renderer!.toJSON()).toBeNull();
    expect(workspace.projectMounts).not.toHaveBeenCalled();
    expect(persistence.setClientSettings).not.toHaveBeenCalled();

    await act(async () => {
      read.resolve({ ...savedSettings, onboardingProgress: { ...progress, step } });
      await read.promise;
    });
    expect(renderer!.root.findByProps({ "aria-label": "Project setup" })).toBeDefined();
    expect(renderer!.root.findAllByType("output").map((node) => node.children.join(""))).toEqual([
      remote,
      projectId,
    ]);
    expect(workspace.projectMounts).toHaveBeenCalledOnce();
    expect(persistence.setClientSettings).not.toHaveBeenCalled();
    expect(workspace.navigate).not.toHaveBeenCalled();
  },
);

it("retains an open project draft through later settings updates", async () => {
  persistence.getClientSettings.mockResolvedValueOnce(savedSettings);
  await render();
  await act(async () =>
    renderer!.root.findByType("input").props.onChange({
      target: { value: "/work/unfinished-project" },
    }),
  );

  await act(async () => {
    await persistClientSettingsUpdate((current) => ({ ...current, wordWrap: !current.wordWrap }));
  });
  expect(renderer!.root.findByType("input").props.value).toBe("/work/unfinished-project");
  expect(workspace.projectMounts).toHaveBeenCalledOnce();
  expect(getClientSettings().onboardingProgress).toEqual(progress);
  expect(workspace.navigate).not.toHaveBeenCalled();
});

it("keeps failed reads retryable without mounting or writing default progress", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const retry = deferredSettings();
  persistence.getClientSettings
    .mockRejectedValueOnce(new Error("storage unavailable"))
    .mockReturnValueOnce(retry.promise);
  await render();
  expect(renderer!.root.findByType("h1").children.join("")).toBe("Could not read settings");
  expect(
    renderer!.root.findAllByType("button").some((node) => node.children.includes("Add project")),
  ).toBe(false);
  expect(workspace.projectMounts).not.toHaveBeenCalled();
  expect(persistence.setClientSettings).not.toHaveBeenCalled();

  await act(async () => renderer!.root.findByType("button").props.onClick());
  expect(renderer!.root.findByType("button").props.disabled).toBe(true);
  expect(
    renderer!.root.findAllByType("button").some((node) => node.children.includes("Add project")),
  ).toBe(false);
  expect(workspace.projectMounts).not.toHaveBeenCalled();
  expect(persistence.setClientSettings).not.toHaveBeenCalled();

  await act(async () => {
    retry.resolve(savedSettings);
    await retry.promise;
  });
  expect(renderer!.root.findByProps({ "aria-label": "Project setup" })).toBeDefined();
  expect(renderer!.root.findAllByType("output").map((node) => node.children.join(""))).toEqual([
    remote,
    projectId,
  ]);
  expect(persistence.getClientSettings).toHaveBeenCalledTimes(2);
  expect(persistence.setClientSettings).not.toHaveBeenCalled();
  expect(workspace.navigate).not.toHaveBeenCalled();
});

it("clears the prior project and first task when setup switches to another computer", async () => {
  persistence.getClientSettings.mockResolvedValueOnce({
    ...savedSettings,
    onboardingProgress: { ...progress, threadId },
  });
  await render();
  await click("Connect");
  await deselectRemote();
  await click("Continue");
  await click("Continue");

  expect(getClientSettings().onboardingProgress).toEqual({
    ...progress,
    environmentIds: [local],
    projectRef: null,
    threadId: null,
  });
  expect(renderer!.root.findAllByType("output").map((node) => node.children.join(""))).toEqual([
    local,
    "",
  ]);
  expect(workspace.navigate).not.toHaveBeenCalled();
});

it("retains the reviewed project and first task while its computer remains selected", async () => {
  persistence.getClientSettings.mockResolvedValueOnce({
    ...savedSettings,
    onboardingProgress: { ...progress, threadId },
  });
  await render();
  await click("Connect");
  await click("Continue");
  await click("Continue");

  expect(getClientSettings().onboardingProgress).toEqual({
    ...progress,
    environmentIds: [local, remote],
    threadId,
  });
  expect(renderer!.root.findAllByType("output").map((node) => node.children.join(""))).toEqual([
    `${local},${remote}`,
    projectId,
  ]);
});

it("keeps saved project and thread identity when a changed computer selection cannot persist", async () => {
  persistence.getClientSettings.mockResolvedValueOnce({
    ...savedSettings,
    onboardingProgress: { ...progress, threadId },
  });
  await render();
  await click("Connect");
  await deselectRemote();
  persistence.setClientSettings.mockRejectedValueOnce(new Error("storage unavailable"));
  await click("Continue");

  expect(getClientSettings().onboardingProgress).toEqual({
    ...progress,
    step: "connection",
    threadId,
  });
  expect(renderer!.root.findByType("h1").children.join("")).toBe("Connect your computers");
  expect(workspace.toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Could not save setup progress" }),
  );
  expect(workspace.projectMounts).toHaveBeenCalledOnce();

  await click("Continue");
  await click("Continue");
  expect(getClientSettings().onboardingProgress).toEqual({
    ...progress,
    environmentIds: [local],
    projectRef: null,
    threadId: null,
  });
});

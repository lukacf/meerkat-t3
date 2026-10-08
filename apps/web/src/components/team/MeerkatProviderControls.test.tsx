import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MeerkatAuthConnection,
  type MeerkatAuthFlow,
  type MeerkatAuthOverview,
  type MeerkatAuthScope,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveSettingsScope } from "../settings/settingsScope";
import {
  retainSettingsScope,
  validateSettingsRouteSearch,
} from "../settings/settingsScopeNavigation";
import { meerkatConnectionSetup } from "./MeerkatProviderControls.logic";

const state = vi.hoisted(() => ({
  data: { connections: [] } as typeof MeerkatAuthOverview.Type | null,
  error: null as string | null,
  isPending: false,
  status: vi.fn((_input: unknown) => "status"),
  command: vi.fn(),
  navigate: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
}));
vi.mock("../../state/meerkatControls", () => ({
  meerkatControlsEnvironment: {
    authStatus: (input: unknown) => state.status(input),
    authAction: "action",
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.data,
    error: state.error,
    isPending: state.isPending,
    refresh: state.refresh,
  }),
  formatEnvironmentQueryError: (cause: unknown) => String(cause),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.command }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));

import { MeerkatProviderControls } from "./MeerkatProviderControls";

const props = {
  environmentId: EnvironmentId.make("remote-machine"),
  projectId: ProjectId.make("project"),
  instanceId: ProviderInstanceId.make("meerkat-work"),
};
const connection = (overrides: Partial<MeerkatAuthConnection> = {}): MeerkatAuthConnection => ({
  provider: "openai",
  displayName: "OpenAI",
  realmId: "env_default",
  bindingId: "default",
  profileId: "default",
  source: "env",
  state: "needs_auth",
  supportsInteractiveLogin: false,
  ...overrides,
});
let renderer: ReactTestRenderer | undefined;
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((node) => node.children.includes(label));
const text = () => JSON.stringify(renderer!.toJSON());
const render = (threadTarget?: MeerkatAuthScope["threadTarget"]) =>
  act(() => {
    renderer = create(<MeerkatProviderControls {...props} threadTarget={threadTarget} />);
  });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.data = { connections: [connection()] };
  state.error = null;
  state.isPending = false;
  state.status.mockClear();
  state.command.mockReset();
  state.navigate.mockReset();
  state.refresh.mockReset();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const targetA = { threadId: ThreadId.make("thread-a"), expectedCwd: "/workspace/worktree-a" };
const targetB = { threadId: ThreadId.make("thread-b"), expectedCwd: "/workspace/worktree-b" };
const scopedOverview = (target: typeof targetA): typeof MeerkatAuthOverview.Type => ({
  connections: [connection({ supportsInteractiveLogin: true, source: "managed_store" })],
  workspace: { projectId: props.projectId, threadId: target.threadId, cwd: target.expectedCwd },
});
const flowResult = (overrides: Partial<MeerkatAuthFlow> = {}) => ({
  _tag: "Success" as const,
  value: {
    flowId: "flow-a",
    authorizeUrl: null,
    status: "connected" as const,
    message: "Signed in.",
    ...overrides,
  } satisfies MeerkatAuthFlow,
});
function useFlowTimers() {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
}

describe("Meerkat credential setup", () => {
  it("opens the owning provider Credentials settings without retaining an unrelated project scope", async () => {
    const root = createRootRoute();
    const settings = createRoute({
      getParentRoute: () => root,
      path: "settings",
      validateSearch: validateSettingsRouteSearch,
      search: { middlewares: [retainSettingsScope] },
    });
    const providers = createRoute({
      getParentRoute: () => settings,
      path: "providers",
      validateSearch: (raw: Record<string, unknown>) => ({
        ...(typeof raw.environmentId === "string" ? { environmentId: raw.environmentId } : {}),
        ...(typeof raw.instanceId === "string" ? { instanceId: raw.instanceId } : {}),
      }),
    });
    const router = createRouter({
      routeTree: root.addChildren([settings.addChildren([providers])]),
      history: createMemoryHistory({
        initialEntries: ["/settings/providers?machine=other&project=unrelated&checkout=old"],
      }),
    });
    await router.load();
    state.navigate.mockImplementation((input) => router.navigate(input));
    render();
    expect(button("Sign in")).toBeUndefined();
    expect(text()).toContain("OPENAI_API_KEY");
    expect(text()).toContain("In Credentials");
    await act(async () => {
      await button("Set up credentials")!.props.onClick();
      await state.navigate.mock.results[0]!.value;
    });
    expect(router.state.location.pathname).toBe("/settings/providers");
    expect(router.state.location.hash).toBe("provider-environment");
    expect(router.state.location.search).toEqual({
      machine: props.environmentId,
      environmentId: props.environmentId,
      instanceId: props.instanceId,
    });
    expect(
      resolveSettingsScope(
        router.state.location.search,
        [],
        [{ environmentId: props.environmentId, label: "Work machine" }],
      ),
    ).toMatchObject({ kind: "environment", environmentId: props.environmentId });
    expect(state.command).not.toHaveBeenCalled();

    state.data = { connections: [connection({ state: "connected" })] };
    act(() => renderer!.update(<MeerkatProviderControls {...props} />));
    expect(button("Set up credentials")).toBeUndefined();
    expect(text()).toContain("Connected");
  });

  it("keeps configured OAuth sign-in on its scoped native flow", async () => {
    state.data = {
      connections: [
        connection({
          realmId: "workspace",
          source: "managed_store",
          supportsInteractiveLogin: true,
        }),
      ],
    };
    state.command.mockResolvedValue({
      _tag: "Success",
      value: {
        flowId: "signed-in",
        authorizeUrl: null,
        status: "connected",
        message: "Signed in.",
      },
    });
    render();
    expect(button("Set up credentials")).toBeUndefined();
    await act(async () => button("Sign in")!.props.onClick());
    expect(state.command).toHaveBeenCalledWith({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        instanceId: props.instanceId,
        provider: "openai",
        action: "start",
      },
    });
    expect(text()).toContain("Signed in.");
    expect(state.refresh).toHaveBeenCalledOnce();
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("requires the exact thread workspace before offering account actions", () => {
    state.data = { connections: scopedOverview(targetA).connections };
    render(targetA);
    expect(button("Sign in")).toBeUndefined();
    expect(text()).toContain("does not match");
    state.data = scopedOverview(targetB);
    act(() => renderer!.update(<MeerkatProviderControls {...props} threadTarget={targetA} />));
    expect(button("Sign in")).toBeUndefined();
    expect(text()).not.toContain(`Checkout: ${targetB.expectedCwd}`);
    state.data = scopedOverview(targetA);
    act(() => renderer!.update(<MeerkatProviderControls {...props} threadTarget={targetA} />));
    expect(button("Sign in")).toBeDefined();
    expect(text()).toContain(targetA.expectedCwd);
    expect(state.status).toHaveBeenLastCalledWith({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, instanceId: props.instanceId, threadTarget: targetA },
    });
  });

  it("blocks a previously captured action after account status becomes unavailable", async () => {
    state.data = scopedOverview(targetA);
    render(targetA);
    const signIn = button("Sign in")!.props.onClick;
    state.error = "The thread was removed.";
    act(() => renderer!.update(<MeerkatProviderControls {...props} threadTarget={targetA} />));
    await act(async () => signIn());
    expect(state.command).not.toHaveBeenCalled();
    expect(button("Sign in")).toBeUndefined();
    expect(text()).toContain("The thread was removed.");
  });

  it("shows a missing thread account check without offering the default project's connections", () => {
    state.data = null;
    state.isPending = true;
    render(targetA);
    expect(text()).toContain("Checking connections...");
    expect(button("Sign in")).toBeUndefined();
    state.isPending = false;
    act(() => renderer!.update(<MeerkatProviderControls {...props} threadTarget={targetA} />));
    expect(text()).toContain("account status is unavailable");
    expect(button("Refresh connections")).toBeDefined();
    expect(state.command).not.toHaveBeenCalled();
  });

  it("excludes duplicate starts and ignores completion after switching thread scope", async () => {
    state.data = scopedOverview(targetA);
    let resolvePending!: (result: ReturnType<typeof flowResult>) => void;
    const pending = new Promise<ReturnType<typeof flowResult>>((resolve) => {
      resolvePending = resolve;
    });
    state.command.mockReturnValue(pending);
    render(targetA);
    const signIn = button("Sign in")!.props.onClick;
    act(() => {
      signIn();
      signIn();
    });
    expect(state.command).toHaveBeenCalledOnce();
    state.data = scopedOverview(targetB);
    act(() => renderer!.update(<MeerkatProviderControls {...props} threadTarget={targetB} />));
    await act(async () => {
      resolvePending(flowResult({ message: "OLD_SCOPE_RESULT" }));
      await pending;
    });
    expect(text()).not.toContain("OLD_SCOPE_RESULT");
    expect(state.refresh).not.toHaveBeenCalled();
    await act(async () => signIn());
    expect(state.command).toHaveBeenCalledOnce();
    state.command.mockResolvedValue(flowResult());
    await act(async () => button("Sign in")!.props.onClick());
    expect(state.command).toHaveBeenLastCalledWith({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        instanceId: props.instanceId,
        threadTarget: targetB,
        provider: "openai",
        action: "start",
      },
    });
  });

  it("keeps polling and manual completion on the original thread account scope", async () => {
    useFlowTimers();
    state.data = scopedOverview(targetA);
    state.command.mockResolvedValue(
      flowResult({ status: "waiting", authorizeUrl: "https://example.test/login", message: null }),
    );
    render(targetA);
    await act(async () => button("Sign in")!.props.onClick());
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(state.command).toHaveBeenLastCalledWith({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        instanceId: props.instanceId,
        threadTarget: targetA,
        provider: "openai",
        action: "status",
        flowId: "flow-a",
      },
    });
    const callbackUrl = "http://127.0.0.1/callback?code=private-test-code";
    act(() =>
      renderer!.root.findByType("input").props.onChange({ target: { value: callbackUrl } }),
    );
    state.command.mockResolvedValue(flowResult());
    await act(async () => button("Complete sign-in")!.props.onClick());
    expect(state.command).toHaveBeenLastCalledWith({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        instanceId: props.instanceId,
        threadTarget: targetA,
        provider: "openai",
        action: "complete",
        flowId: "flow-a",
        callbackUrl,
      },
    });
    expect(text()).not.toContain("private-test-code");
    expect(state.refresh).toHaveBeenCalledOnce();
  });

  it("drops the old callback and cancels its polling when the checkout changes", async () => {
    useFlowTimers();
    state.data = scopedOverview(targetA);
    state.command.mockResolvedValue(
      flowResult({ status: "waiting", authorizeUrl: "https://example.test/login", message: null }),
    );
    render(targetA);
    await act(async () => button("Sign in")!.props.onClick());
    act(() =>
      renderer!.root
        .findByType("input")
        .props.onChange({ target: { value: "private-old-callback" } }),
    );
    const complete = button("Complete sign-in")!.props.onClick;
    const changed = { ...targetA, expectedCwd: "/workspace/replaced-checkout" };
    state.data = scopedOverview(changed);
    act(() => renderer!.update(<MeerkatProviderControls {...props} threadTarget={changed} />));
    await act(async () => {
      complete();
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(state.command).toHaveBeenCalledOnce();
    expect(text()).not.toContain("private-old-callback");
    expect(button("Complete sign-in")).toBeUndefined();
  });

  it("retains the thread account target when opening environment Credentials", async () => {
    state.data = { ...scopedOverview(targetA), connections: [connection()] };
    render(targetA);
    await act(async () => button("Set up credentials")!.props.onClick());
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/settings/providers",
      search: {
        environmentId: props.environmentId,
        instanceId: props.instanceId,
        machine: props.environmentId,
        project: undefined,
        checkout: undefined,
        accountProject: props.projectId,
        accountThread: targetA.threadId,
        accountCwd: targetA.expectedCwd,
      },
      hash: "provider-environment",
    });
    expect(state.command).not.toHaveBeenCalled();
  });

  it.each(["cancel", "logout"] as const)("keeps %s bound to the thread account", async (action) => {
    useFlowTimers();
    state.data = scopedOverview(targetA);
    if (action === "logout")
      state.data = {
        ...state.data,
        connections: [connection({ supportsInteractiveLogin: true, state: "connected" })],
      };
    state.command.mockResolvedValue(flowResult({ status: "waiting", message: null }));
    render(targetA);
    if (action === "cancel") await act(async () => button("Sign in")!.props.onClick());
    state.command.mockResolvedValue(
      flowResult({ status: action === "cancel" ? "cancelled" : "disconnected", flowId: null }),
    );
    await act(async () => button(action === "cancel" ? "Cancel" : "Sign out")!.props.onClick());
    expect(state.command).toHaveBeenLastCalledWith({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        instanceId: props.instanceId,
        threadTarget: targetA,
        provider: "openai",
        action,
        ...(action === "cancel" ? { flowId: "flow-a" } : {}),
      },
    });
  });

  it.each([
    ["openai", "OPENAI_API_KEY"],
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["gemini", "GEMINI_API_KEY"],
  ])("offers the native environment fallback for %s", (provider, variable) => {
    const setup = meerkatConnectionSetup(connection({ provider }));
    expect(setup.label).toBe("Credentials needed");
    expect(setup.environmentSetup).toBe(true);
    expect(setup.interactive).toBe(false);
    expect(setup.instructions).toContain(variable);
  });

  it("does not invent a standard API-key variable for a configured credential source", () => {
    const setup = meerkatConnectionSetup(connection({ realmId: "company", source: "command" }));
    expect(setup.environmentSetup).toBe(true);
    expect(setup.instructions).not.toContain("OPENAI_API_KEY");
    expect(setup.instructions).toContain("configured credentials on the host");
  });

  it("leaves connected and host-managed credentials alone", () => {
    for (const status of ["connected", "host_managed"] as const) {
      const setup = meerkatConnectionSetup(connection({ state: status }));
      expect(setup.environmentSetup).toBe(false);
      expect(setup.instructions).toBeNull();
    }
  });
});

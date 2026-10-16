import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type MeerkatAuthConnection,
  type MeerkatAuthFlow,
  type MeerkatAuthMethod,
  type MeerkatAuthOverview,
} from "@t3tools/contracts";
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  data: { connections: [] } as typeof MeerkatAuthOverview.Type | null,
  error: null as string | null,
  isPending: false,
  status: vi.fn((_input: unknown) => "status"),
  command: vi.fn(),
  refresh: vi.fn(),
  refreshProviders: vi.fn(),
  openExternal: vi.fn(),
  copyText: vi.fn(),
}));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: state.openExternal } }),
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({
  writeTextToClipboard: (...args: unknown[]) => state.copyText(...args),
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
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    refreshProviders: "refresh",
    providersValueAtom: (id: EnvironmentId) => id,
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (id: EnvironmentId) =>
    id === environmentId
      ? [
          {
            instanceId,
            driver: ProviderDriverKind.make("meerkat"),
            enabled: true,
            installed: true,
            version: null,
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-10-10T00:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ]
      : [],
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "action" ? state.command : state.refreshProviders,
}));
vi.mock("../ui/button", () => ({
  Button: ({ render, children, ...props }: { render?: ReactElement; children?: ReactNode }) =>
    render ? cloneElement(render, props, children) : <button {...props}>{children}</button>,
}));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/menu", () => ({
  Menu: "div",
  MenuTrigger: ({ render, children, ...props }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, props, children),
  MenuPopup: "div",
  MenuItem: "button",
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogPopup: "div",
  DialogHeader: "div",
  DialogTitle: "h3",
  DialogDescription: "p",
  DialogPanel: "div",
  DialogFooter: "div",
}));

import { MeerkatProviderControls } from "./MeerkatProviderControls";
import { ProviderAccountsPanel } from "../settings/ProviderAccountsPanel";

const environmentId = EnvironmentId.make("remote-machine");
const instanceId = ProviderInstanceId.make("meerkat-work");
const projectId = ProjectId.make("project");
const props = { environmentId, instanceId };
const targetA = { threadId: ThreadId.make("thread-a"), expectedCwd: "/workspace/worktree-a" };
const targetB = { threadId: ThreadId.make("thread-b"), expectedCwd: "/workspace/worktree-b" };
const methods: MeerkatAuthMethod[] = [
  {
    id: "chatgpt",
    provider: "openai",
    displayName: "ChatGPT",
    authMethod: "oauth",
    backendKind: "chatgpt",
    flow: "browser",
    description: "Sign in with ChatGPT",
    fields: [],
  },
  {
    id: "copilot",
    provider: "copilot",
    displayName: "GitHub Copilot",
    authMethod: "oauth",
    backendKind: "copilot",
    flow: "device",
    description: "Use GitHub",
    fields: [],
  },
  {
    id: "openai-key",
    provider: "openai",
    displayName: "OpenAI API",
    authMethod: "api_key",
    backendKind: "openai_api",
    flow: "secret",
    description: "Use an API key",
    fields: [],
  },
];
const connection = (overrides: Partial<MeerkatAuthConnection> = {}): MeerkatAuthConnection => ({
  provider: "openai",
  displayName: "OpenAI",
  realmId: "global",
  bindingId: "work",
  profileId: "work",
  source: "managed_store",
  state: "needs_auth",
  supportsInteractiveLogin: true,
  authMethod: "oauth",
  backendKind: "chatgpt",
  loginFlow: "browser",
  editable: true,
  supportsDefault: true,
  supportsRemoval: true,
  supportsSecretUpdate: false,
  ...overrides,
});
const identity = (account: MeerkatAuthConnection) => ({
  provider: account.provider,
  realmId: account.realmId,
  bindingId: account.bindingId,
  profileId: account.profileId,
});
const flowResult = (overrides: Partial<MeerkatAuthFlow> = {}) => ({
  _tag: "Success" as const,
  value: {
    flowId: "flow-a",
    authorizeUrl: null,
    status: "connected",
    message: "Signed in.",
    ...overrides,
  } satisfies MeerkatAuthFlow,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let renderer: ReactTestRenderer | undefined;
const nodeText = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(nodeText).join("");
const buttons = (label: string) =>
  renderer!.root.findAllByType("button").filter((node) => nodeText(node) === label);
const button = (label: string) => {
  const result = buttons(label)[0];
  if (!result) throw new Error(`Button missing: ${label}`);
  return result;
};
const text = () => JSON.stringify(renderer!.toJSON());
const render = (extra: Partial<Parameters<typeof ProviderAccountsPanel>[0]> = {}) =>
  act(() => {
    renderer = create(<ProviderAccountsPanel {...props} {...extra} />);
  });
const update = (extra: Partial<Parameters<typeof ProviderAccountsPanel>[0]> = {}) =>
  act(() => {
    renderer!.update(<ProviderAccountsPanel {...props} {...extra} />);
  });
const click = async (label: string) =>
  act(async () => {
    await button(label).props.onClick();
  });
const submit = async () =>
  act(async () => {
    renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} });
  });
const fill = (placeholder: string, value: string) =>
  act(() => {
    renderer!.root
      .findAllByType("input")
      .find((node) => node.props.placeholder === placeholder)!
      .props.onChange({ target: { value } });
  });
const choose = async (name: string) => {
  await click("Add account");
  await act(async () => {
    const option = renderer!.root
      .findAllByType("button")
      .find((node) => nodeText(node).startsWith(name));
    if (!option) throw new Error(`Method missing: ${name}`);
    option.props.onClick();
  });
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  state.data = { connections: [], methods };
  state.error = null;
  state.isPending = false;
  state.status.mockClear();
  state.command.mockReset().mockResolvedValue(flowResult());
  state.refresh.mockReset();
  state.refreshProviders.mockReset().mockResolvedValue({ _tag: "Success" });
  state.openExternal.mockReset().mockResolvedValue(undefined);
  state.copyText.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Native provider account UI", () => {
  it("starts projectless with native sign-in methods and no runtime picker", async () => {
    render();
    expect(state.status).toHaveBeenLastCalledWith({ environmentId, input: { instanceId } });
    expect(text()).toContain("Your models start here");
    await click("Add account");
    expect(text()).toContain("ChatGPT");
    expect(text()).toContain("GitHub Copilot");
    expect(text()).toContain("OpenAI API");
    expect(text()).not.toContain("Claude Code");
    expect(text()).not.toContain("Meerkat MobKit");
    expect(state.command).not.toHaveBeenCalled();
  });

  it("saves API keys explicitly, clears them, and never echoes native errors", async () => {
    render();
    await choose("OpenAI API");
    expect(button("Save API key").props.disabled).toBe(true);
    fill("Paste your API key", "fixture-secret");
    expect(state.command).not.toHaveBeenCalled();
    state.command.mockResolvedValueOnce({ _tag: "Failure", cause: "invalid fixture-secret" });
    await submit();
    expect(state.command).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        instanceId,
        action: "configure",
        provider: "openai",
        methodId: "openai-key",
        fields: {},
        secret: "fixture-secret",
      },
    });
    expect(text()).not.toContain("fixture-secret");
    expect(text()).toContain("Could not connect this account");
    expect(renderer!.root.findByType("input").props.value).toBe("");
    expect(state.refreshProviders).not.toHaveBeenCalled();
  });

  it("chains browser configuration with the returned exact account and clears callback input", async () => {
    const account = connection({ bindingId: "new-account", profileId: "new-profile" });
    state.command
      .mockResolvedValueOnce(flowResult({ status: "disconnected", connection: account }))
      .mockResolvedValueOnce(
        flowResult({ status: "waiting", authorizeUrl: "https://auth.example/login" }),
      )
      .mockResolvedValueOnce(flowResult());
    render();
    await choose("ChatGPT");
    await submit();
    expect(state.command.mock.calls[1]?.[0]).toEqual({
      environmentId,
      input: { instanceId, ...identity(account), action: "start" },
    });
    await click("Open sign-in page");
    expect(state.openExternal).toHaveBeenCalledExactlyOnceWith("https://auth.example/login");
    fill("Callback URL", "http://localhost/callback?code=fixture-code");
    await click("Complete sign-in");
    expect(state.command.mock.calls[2]?.[0]).toEqual({
      environmentId,
      input: {
        instanceId,
        ...identity(account),
        action: "complete",
        flowId: "flow-a",
        callbackUrl: "http://localhost/callback?code=fixture-code",
      },
    });
    expect(text()).not.toContain("fixture-code");
    expect(text()).toContain("Account connected");
    expect(state.refreshProviders).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, refreshModels: true },
    });
  });

  it("keeps a saved API key successful when native activation needs a selection", async () => {
    const account = connection({
      authMethod: "api_key",
      backendKind: "openai_api",
      state: "connected",
      supportsInteractiveLogin: false,
      supportsSecretUpdate: true,
      isDefault: false,
    });
    state.command.mockResolvedValueOnce(
      flowResult({
        connection: account,
        defaultActivation: { status: "needs_selection", providers: [] },
      }),
    );
    state.refresh.mockImplementation(() => {
      state.data = { methods, connections: [account] };
    });
    render();
    await choose("OpenAI API");
    fill("Paste your API key", "fixture-secret");
    await submit();
    expect(text()).toContain("API key saved. Choose which account to use in Models below.");
    expect(text()).not.toContain("Could not connect");
    expect(text()).not.toContain("fixture-secret");
    expect(button("Use this account").props.disabled).toBe(false);
    expect(state.refreshProviders).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, refreshModels: true },
    });
  });

  it("shows a committed but unverified key without offering its models or retrying sign-in", async () => {
    const account = connection({
      authMethod: "api_key",
      backendKind: "openai_api",
      state: "unknown",
      supportsInteractiveLogin: false,
      supportsSecretUpdate: true,
      isDefault: false,
      models: [],
    });
    state.command.mockResolvedValueOnce(
      flowResult({
        status: "disconnected",
        connection: account,
        credentialsSaved: true,
        defaultActivation: { status: "needs_selection", providers: [] },
      }),
    );
    state.refresh.mockImplementation(() => {
      state.data = { methods, connections: [account] };
    });
    render();
    await choose("OpenAI API");
    fill("Paste your API key", "fixture-secret");
    await submit();
    expect(text()).toContain("API key saved. Refresh account status to check the connection.");
    expect(text()).toContain("Not verified");
    expect(text()).not.toContain("Could not connect");
    expect(text()).not.toContain("fixture-secret");
    expect(buttons("Save API key")).toHaveLength(0);
    expect(buttons("Use this account")).toHaveLength(0);
    expect(state.command).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((node) => node.props["aria-label"] === "Refresh accounts and models")!
        .props.onClick();
    });
    expect(state.refreshProviders).toHaveBeenCalledTimes(2);
    expect(state.command).toHaveBeenCalledTimes(1);
  });

  it("shows a browser launch failure through status polling and lets the user copy the current link", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const url = "https://auth.example/login?state=private-state&code_challenge=private-challenge";
    state.data = { methods, connections: [connection()] };
    state.command.mockResolvedValue(flowResult({ status: "waiting", authorizeUrl: url }));
    state.openExternal.mockRejectedValueOnce(new Error(`OS failed opening ${url}`));
    render();
    await click("Sign in");
    await click("Open sign-in page");
    expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(url);
    expect(text()).toContain("Could not open the sign-in page. Copy the link");
    expect(text()).not.toContain("private-state");
    expect(text()).not.toContain("private-challenge");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(state.command).toHaveBeenLastCalledWith({
      environmentId,
      input: { instanceId, ...identity(connection()), action: "status", flowId: "flow-a" },
    });
    expect(text()).toContain("Could not open the sign-in page. Copy the link");
    await click("Copy sign-in link");
    expect(state.copyText).toHaveBeenCalledExactlyOnceWith(url, "sign-in link");
    expect(button("Link copied")).toBeDefined();
    expect(text()).not.toContain("Could not open");
    expect(text()).not.toContain("private-state");
  });

  it("keeps sign-in successful when native account activation needs a selection", async () => {
    const account = connection({ isDefault: false });
    state.data = { methods, connections: [account] };
    state.command
      .mockResolvedValueOnce(
        flowResult({ status: "waiting", authorizeUrl: "https://auth.example/login" }),
      )
      .mockResolvedValueOnce(
        flowResult({
          defaultActivation: { status: "needs_selection", providers: [] },
          message: "private native activation diagnostics",
        }),
      );
    state.refresh.mockImplementationOnce(() => {
      state.data = {
        methods,
        connections: [{ ...account, state: "connected" }],
      };
    });
    render();
    await click("Sign in");
    fill("Callback URL", "http://localhost/callback?code=fixture-code");
    await click("Complete sign-in");
    expect(text()).toContain("Account connected. Choose which account to use in Models below.");
    expect(text()).not.toContain("private native activation diagnostics");
    expect(text()).not.toContain("Waiting for sign-in");
    expect(buttons("Complete sign-in")).toHaveLength(0);
    expect(button("Use this account").props.disabled).toBe(false);
    expect(state.refreshProviders).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, refreshModels: true },
    });
    await click("Use this account");
    expect(state.command).toHaveBeenLastCalledWith({
      environmentId,
      input: { instanceId, ...identity(account), action: "default" },
    });
    expect(text()).toContain("Default account updated.");
  });

  it("keeps copy failures safe and allows another explicit browser launch", async () => {
    const url = "https://auth.example/login?state=private-state";
    state.data = { methods, connections: [connection()] };
    state.command.mockResolvedValue(flowResult({ status: "waiting", authorizeUrl: url }));
    state.copyText.mockRejectedValueOnce(new Error(`Clipboard rejected ${url}`));
    render();
    await click("Sign in");
    await click("Copy sign-in link");
    expect(text()).toContain("Could not copy the sign-in link");
    expect(text()).not.toContain("private-state");
    await click("Open sign-in page");
    expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(url);
    expect(text()).not.toContain("Could not copy");
    expect(state.command).toHaveBeenCalledTimes(1);
  });

  it("does not apply a late browser launch failure to a cancelled sign-in", async () => {
    const launched = deferred<void>();
    state.data = { methods, connections: [connection()] };
    state.command
      .mockResolvedValueOnce(
        flowResult({ status: "waiting", authorizeUrl: "https://auth.example/login" }),
      )
      .mockResolvedValueOnce(flowResult({ status: "cancelled" }));
    state.openExternal.mockImplementationOnce(async () => {
      await launched.promise;
      throw new Error("Late browser failure");
    });
    render();
    await click("Sign in");
    let opening!: Promise<void>;
    await act(async () => {
      opening = button("Open sign-in page").props.onClick();
    });
    expect(state.openExternal).toHaveBeenCalledTimes(1);
    await click("Cancel sign-in");
    await act(async () => {
      launched.resolve();
      await opening;
    });
    expect(text()).not.toContain("Could not open");
    expect(buttons("Open sign-in page")).toHaveLength(0);
  });

  it("fences retained launch and copy handlers when account access becomes read-only", async () => {
    state.data = { methods, connections: [connection()] };
    state.command.mockResolvedValue(
      flowResult({ status: "waiting", authorizeUrl: "https://auth.example/login" }),
    );
    render();
    await click("Sign in");
    const open = button("Open sign-in page").props.onClick;
    const copy = button("Copy sign-in link").props.onClick;
    update({ readOnly: true });
    expect(button("Open sign-in page").props.disabled).toBe(true);
    expect(button("Copy sign-in link").props.disabled).toBe(true);
    await act(async () => {
      await open();
      await copy();
    });
    expect(state.openExternal).not.toHaveBeenCalled();
    expect(state.copyText).not.toHaveBeenCalled();
  });

  for (const nextAction of ["Close", "Start again"]) {
    it(`receives terminal browser expiry and offers ${nextAction} without another cancel request`, async () => {
      vi.useFakeTimers();
      vi.stubGlobal("window", { setTimeout, clearTimeout });
      const expiresAt = new Date(Date.now() + 1_000).toISOString();
      const account = connection();
      state.data = { methods, connections: [account] };
      state.command
        .mockResolvedValueOnce(
          flowResult({
            status: "waiting",
            authorizeUrl: "https://auth.example/expired",
            expiresAt,
          }),
        )
        .mockResolvedValueOnce(
          flowResult({ status: "failed", expiresAt, message: "internal-sensitive-expiry" }),
        )
        .mockResolvedValueOnce(
          flowResult({
            status: "waiting",
            flowId: "flow-b",
            authorizeUrl: "https://auth.example/new",
          }),
        );
      render();
      await click("Sign in");
      expect(text()).toContain("Sign-in expires at");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(state.command).toHaveBeenLastCalledWith({
        environmentId,
        input: { instanceId, ...identity(account), action: "status", flowId: "flow-a" },
      });
      expect(text()).toContain("This sign-in has ended. Start again to continue.");
      expect(text()).not.toContain("Waiting for sign-in");
      expect(text()).not.toContain("internal-sensitive-expiry");
      expect(buttons("Cancel sign-in")).toHaveLength(0);
      expect(buttons("Open sign-in page")).toHaveLength(0);
      expect(buttons("Complete sign-in")).toHaveLength(0);
      expect(buttons("Start again")).toHaveLength(1);
      expect(buttons("Close")).toHaveLength(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(state.command).toHaveBeenCalledTimes(2);
      await click(nextAction);
      expect(text()).not.toContain("This sign-in has ended");
      expect(state.command.mock.calls.some(([call]) => call.input.action === "cancel")).toBe(false);
      if (nextAction === "Start again") {
        expect(state.command).toHaveBeenLastCalledWith({
          environmentId,
          input: { instanceId, ...identity(account), action: "start" },
        });
        expect(text()).toContain("Waiting for sign-in");
        await click("Open sign-in page");
        expect(state.openExternal).toHaveBeenCalledWith("https://auth.example/new");
      } else {
        expect(state.command).toHaveBeenCalledTimes(2);
        expect(buttons("Open sign-in page")).toHaveLength(0);
        expect(buttons("Start again")).toHaveLength(0);
      }
    });
  }

  it("receives a failed completion as terminal instead of retaining the old pending flow", async () => {
    state.data = { methods, connections: [connection()] };
    state.command
      .mockResolvedValueOnce(
        flowResult({ status: "waiting", authorizeUrl: "https://auth.example/login" }),
      )
      .mockResolvedValueOnce(
        flowResult({ status: "failed", message: "private native completion diagnostics" }),
      );
    render();
    await click("Sign in");
    fill("Callback URL", "http://localhost/callback?code=private-code");
    await click("Complete sign-in");
    expect(text()).toContain("This sign-in has ended");
    expect(text()).not.toContain("Waiting for sign-in");
    expect(text()).not.toContain("private-code");
    expect(text()).not.toContain("private native completion diagnostics");
    await click("Close");
    expect(state.command.mock.calls.map(([call]) => call.input.action)).toEqual([
      "start",
      "complete",
    ]);
  });

  it("keeps checking a commit the server still considers pending after its callback deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const expiresAt = new Date(Date.now() + 1_000).toISOString();
    state.data = { methods, connections: [connection()] };
    state.command
      .mockResolvedValueOnce(
        flowResult({ status: "waiting", authorizeUrl: "https://auth.example/login", expiresAt }),
      )
      .mockResolvedValueOnce(flowResult({ status: "waiting", expiresAt }))
      .mockResolvedValueOnce(flowResult({ status: "connected", expiresAt }));
    render();
    await click("Sign in");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(text()).toContain("Waiting for sign-in");
    expect(text()).not.toContain("expired");
    expect(buttons("Start again")).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(state.command.mock.calls.map(([call]) => call.input.action)).toEqual([
      "start",
      "status",
      "status",
    ]);
    expect(text()).toContain("Account connected");
    expect(buttons("Cancel sign-in")).toHaveLength(0);
  });

  it("does not treat a status or cancel network failure as confirmed terminality", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    state.data = { methods, connections: [connection()] };
    state.command
      .mockResolvedValueOnce(
        flowResult({ status: "waiting", authorizeUrl: "https://auth.example/login" }),
      )
      .mockResolvedValueOnce({ _tag: "Failure", cause: "Network unavailable" })
      .mockResolvedValueOnce({ _tag: "Failure", cause: "Cancel response unavailable" })
      .mockResolvedValueOnce(flowResult({ status: "cancelled", flowId: null }));
    render();
    await click("Sign in");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(text()).toContain("Waiting for sign-in");
    expect(buttons("Check again")).toHaveLength(1);
    expect(buttons("Start again")).toHaveLength(0);
    await click("Cancel sign-in");
    expect(text()).toContain("The account request did not complete");
    expect(text()).toContain("Waiting for sign-in");
    expect(buttons("Cancel sign-in")).toHaveLength(1);
    await click("Cancel sign-in");
    expect(buttons("Cancel sign-in")).toHaveLength(0);
    expect(text()).not.toContain("Waiting for sign-in");
    expect(state.command.mock.calls.map(([call]) => call.input.action)).toEqual([
      "start",
      "status",
      "cancel",
      "cancel",
    ]);
  });

  it("keeps new account creation and its sign-in global inside a conversation view", async () => {
    state.data = {
      methods,
      connections: [],
      workspace: { projectId, threadId: targetA.threadId, cwd: targetA.expectedCwd },
    };
    const account = connection();
    state.command
      .mockResolvedValueOnce(flowResult({ status: "disconnected", connection: account }))
      .mockResolvedValueOnce(
        flowResult({ status: "waiting", authorizeUrl: "https://auth.example/login" }),
      )
      .mockResolvedValueOnce(flowResult({ status: "cancelled" }));
    render({ projectId, threadTarget: targetA });
    await choose("ChatGPT");
    await submit();
    await click("Cancel sign-in");
    expect(state.command.mock.calls.map(([call]) => call.input)).toEqual([
      { instanceId, action: "configure", provider: "openai", methodId: "chatgpt", fields: {} },
      { instanceId, ...identity(account), action: "start" },
      { instanceId, ...identity(account), action: "cancel", flowId: "flow-a" },
    ]);
  });

  it("retries sign-in after configuration without creating a duplicate account", async () => {
    const account = connection({ profileId: "new-profile" });
    state.command
      .mockResolvedValueOnce(flowResult({ status: "disconnected", connection: account }))
      .mockResolvedValueOnce({ _tag: "Failure", cause: "native start failed" })
      .mockResolvedValueOnce(flowResult({ status: "waiting" }));
    render();
    await choose("ChatGPT");
    await submit();
    expect(text()).toContain("Could not connect this account");
    await submit();
    expect(state.command.mock.calls.map(([call]) => call.input.action)).toEqual([
      "configure",
      "start",
      "start",
    ]);
    expect(state.command.mock.calls[2]?.[0].input).toEqual({
      instanceId,
      ...identity(account),
      action: "start",
    });
  });

  it("activates a connected account from its model card and refreshes native model choices", async () => {
    const inactiveDefault = connection({
      backendKind: "copilot",
      bindingId: "inactive-copilot",
      profileId: "inactive-copilot",
      state: "needs_auth",
      isDefault: true,
    });
    const account = connection({
      accountLabel: "Personal ChatGPT",
      state: "connected",
      isDefault: false,
      models: [
        {
          id: "gpt-6-astra",
          displayName: "GPT-6 Astra",
          tier: "recommended",
          recommended: true,
        },
      ],
    });
    state.data = {
      methods,
      workspace: { projectId, threadId: targetA.threadId, cwd: targetA.expectedCwd },
      connections: [inactiveDefault, account],
    };
    const pending = deferred<ReturnType<typeof flowResult>>();
    state.command.mockReturnValueOnce(pending.promise);
    state.refresh.mockImplementationOnce(() => {
      state.data = {
        ...state.data!,
        connections: [
          { ...inactiveDefault, isDefault: false },
          { ...account, isDefault: true },
        ],
      };
    });
    render({ projectId, threadTarget: targetA });
    expect(text()).toContain("GPT-6 Astra");
    expect(text()).not.toContain("Choose Use by default");
    expect(buttons("Use this account")).toHaveLength(1);
    const activate = button("Use this account").props.onClick;
    await click("Use this account");
    expect(state.command).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        instanceId,
        projectId,
        threadTarget: targetA,
        ...identity(account),
        action: "default",
      },
    });
    expect(button("Use this account").props.disabled).toBe(true);
    await act(async () => activate());
    expect(state.command).toHaveBeenCalledTimes(1);
    expect(state.refresh).not.toHaveBeenCalled();
    await act(async () => pending.resolve(flowResult()));
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.refreshProviders).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, refreshModels: true },
    });
    expect(text()).toContain("Default account updated.");
    expect(text()).toContain("GPT-6 Astra");
    expect(buttons("Use this account")).toHaveLength(0);
  });

  it.each(["read-only", "different checkout"])(
    "rejects model-card activation after switching to %s",
    async (change) => {
      state.data = {
        methods,
        workspace: { projectId, threadId: targetA.threadId, cwd: targetA.expectedCwd },
        connections: [connection({ state: "connected", isDefault: false })],
      };
      render({ projectId, threadTarget: targetA });
      const activate = button("Use this account").props.onClick;
      update(
        change === "read-only"
          ? { projectId, threadTarget: targetA, readOnly: true }
          : { projectId, threadTarget: targetB },
      );
      if (change === "read-only") expect(button("Use this account").props.disabled).toBe(true);
      else expect(text()).toContain("no longer matches");
      await act(async () => activate());
      expect(state.command).not.toHaveBeenCalled();
      expect(state.refreshProviders).not.toHaveBeenCalled();
    },
  );

  it("does not turn a failed native default-account receipt into a success notice", async () => {
    state.data = { methods, connections: [connection({ state: "connected" })] };
    state.command.mockResolvedValueOnce(
      flowResult({ status: "failed", message: "internal-sensitive-detail" }),
    );
    render();
    await click("Use this account");
    expect(text()).toContain("The account request did not complete");
    expect(text()).not.toContain("Default account updated");
    expect(text()).not.toContain("internal-sensitive-detail");
    expect(state.refreshProviders).not.toHaveBeenCalled();
  });

  it("uses Copilot's returned route identity and polls only the server-owned device flow", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const account = connection({
      provider: "anthropic",
      backendKind: "copilot",
      loginFlow: "device",
    });
    state.command
      .mockResolvedValueOnce(flowResult({ status: "disconnected", connection: account }))
      .mockResolvedValueOnce(
        flowResult({
          status: "waiting",
          userCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
          intervalSeconds: 5,
        }),
      )
      .mockResolvedValueOnce(flowResult());
    render();
    await choose("GitHub Copilot");
    await submit();
    expect(state.command.mock.calls[1]?.[0]).toEqual({
      environmentId,
      input: { instanceId, ...identity(account), action: "deviceStart" },
    });
    expect(text()).toContain("ABCD-1234");
    expect(text()).not.toContain("Callback URL");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(state.command.mock.calls[2]?.[0]).toEqual({
      environmentId,
      input: {
        instanceId,
        ...identity(account),
        action: "devicePoll",
        flowId: "flow-a",
      },
    });
    expect(state.command.mock.calls.some(([call]) => "deviceCode" in call.input)).toBe(false);
  });

  it.each(["openai", "anthropic", "gemini"])(
    "reconnects a Copilot %s route through its account method",
    async (provider) => {
      const account = connection({
        provider,
        displayName: `GitHub Copilot (${provider})`,
        backendKind: "copilot",
        loginFlow: "device",
        state: "reauth_required",
      });
      state.data = { methods, connections: [account] };
      state.command.mockResolvedValueOnce(flowResult({ status: "waiting", userCode: "ABCD-1234" }));
      render();
      expect(text()).not.toContain(account.displayName);
      await click("Sign in again");
      expect(state.command).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: { instanceId, ...identity(account), action: "deviceStart" },
      });
      expect(text()).toContain("GitHub Copilot");
      expect(text()).toContain("ABCD-1234");
      expect(text()).not.toContain("Callback URL");
    },
  );

  it("keeps same-provider accounts separate for reconnect and removal", async () => {
    const first = connection({ bindingId: "personal", profileId: "personal", state: "connected" });
    const second = connection({ bindingId: "work", profileId: "work", state: "connected" });
    state.data = { methods, connections: [first, second] };
    render();
    await act(async () => {
      buttons("Remove account")[1]!.props.onClick();
    });
    expect(text()).toContain("Saved agents and conversations");
    await act(async () => {
      buttons("Remove account").at(-1)!.props.onClick();
    });
    expect(state.command).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        instanceId,
        ...identity(second),
        action: "delete",
      },
    });
  });

  it.each(["connected", "needs_auth"] as const)(
    "removes a %s account and its default/model groups after refreshing native status",
    async (accountState) => {
      const account = connection({
        accountLabel: "King",
        state: accountState,
        isDefault: true,
        models: [
          {
            id: "fixture-model",
            displayName: "Account-specific model",
            tier: "supported",
            recommended: true,
          },
        ],
      });
      state.data = { methods, connections: [account] };
      const removal = deferred<ReturnType<typeof flowResult>>();
      state.command.mockReturnValueOnce(removal.promise);
      state.refresh.mockImplementationOnce(() => {
        state.data = { methods, connections: [] };
      });
      render();
      expect(text()).toContain("King");
      if (accountState === "connected") expect(text()).toContain("Account-specific model");
      await click("Remove account");
      expect(text()).toContain("saved account configuration and credentials from this device");
      expect(text()).toContain("Saved agents and conversations stay available");

      await act(async () => {
        const confirm = buttons("Remove account").at(-1)!;
        confirm.props.onClick();
        confirm.props.onClick();
      });
      expect(state.command).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: { instanceId, ...identity(account), action: "delete" },
      });
      expect(state.refresh).not.toHaveBeenCalled();
      expect(text()).toContain("King");
      expect(button("Removing...").props.disabled).toBe(true);

      await act(async () => removal.resolve(flowResult({ status: "disconnected" })));
      expect(state.refresh).toHaveBeenCalledOnce();
      expect(state.refreshProviders).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: { instanceId, refreshModels: true },
      });
      expect(text()).toContain("Account removed. Saved conversations are kept.");
      expect(text()).toContain("Your models start here");
      expect(text()).not.toContain("King");
      expect(text()).not.toContain("Account-specific model");
      expect(
        renderer!.root.findAllByType("span").filter((node) => nodeText(node) === "Default"),
      ).toHaveLength(0);
    },
  );

  it("keeps an account and shows a retryable error when native removal fails", async () => {
    const account = connection({ accountLabel: "King", state: "connected", isDefault: true });
    state.data = { methods, connections: [account] };
    state.command.mockResolvedValueOnce({
      _tag: "Failure",
      error: "private-credential-diagnostic",
    });
    render();
    await click("Remove account");
    await act(async () => buttons("Remove account").at(-1)!.props.onClick());

    expect(state.refresh).toHaveBeenCalledOnce();
    expect(state.refreshProviders).toHaveBeenCalledOnce();
    expect(text()).toContain("King");
    expect(text()).not.toContain("Account removed.");
    expect(text()).not.toContain("private-credential-diagnostic");
    expect(renderer!.root.findAllByProps({ role: "alert" }).map(nodeText)).toEqual([
      "Could not remove this account. Try again.",
    ]);
    expect(buttons("Remove account").at(-1)!.props.disabled).toBe(false);
    await click("Keep account");
    expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    expect(text()).toContain("King");
  });

  it("offers removal for a disconnected configured account without a sign-in action", () => {
    state.data = {
      methods,
      connections: [
        connection({
          state: "needs_auth",
          supportsInteractiveLogin: false,
          supportsSecretUpdate: false,
          supportsRemoval: true,
        }),
      ],
    };
    render();
    expect(buttons("Sign in")).toHaveLength(0);
    expect(buttons("Remove account")).toHaveLength(1);
  });

  it.each([false, undefined])(
    "does not infer removal from editable credentials when supportsRemoval is %s",
    (supportsRemoval) => {
      state.data = {
        methods,
        connections: [connection({ state: "connected", editable: true, supportsRemoval })],
      };
      render();
      expect(buttons("Sign in again")).toHaveLength(1);
      expect(buttons("Remove account")).toHaveLength(0);
    },
  );

  it("shows a shared Copilot account once and preserves exact targets for defaults and removal", async () => {
    const routes = ["openai", "anthropic", "gemini"].map((provider) =>
      connection({
        provider,
        displayName: `GitHub Copilot (${provider})`,
        bindingId: `copilot-${provider}`,
        profileId: `king-${provider}`,
        accountLabel: "King",
        accountId: "opaque-login-id",
        credentialAccount: { realm: "global", account: "shared-copilot" },
        backendKind: "copilot",
        loginFlow: "device",
        state: "connected",
        isDefault: provider === "openai",
        modelsVerified: true,
        models: [
          {
            id: provider === "openai" ? "gpt-6-astra" : "claude-haiku-4.5",
            displayName: provider === "openai" ? "GPT-6 Astra" : "Claude Haiku 4.5",
            tier: "supported",
            recommended: false,
          },
        ],
      }),
    );
    state.data = { methods, connections: routes };
    render();
    expect(
      renderer!.root
        .findAllByType("button")
        .filter((node) => node.props["aria-label"] === "Actions for King"),
    ).toHaveLength(1);
    expect(
      renderer!.root.findAllByType("h3").filter((node) => nodeText(node) === "GitHub Copilot"),
    ).toHaveLength(1);
    expect(
      renderer!.root.findAllByType("span").filter((node) => nodeText(node) === "Claude Haiku 4.5"),
    ).toHaveLength(1);
    expect(text()).not.toContain("opaque-login-id");
    expect(text()).toContain("Default for OpenAI");
    expect(buttons("Sign in again")).toHaveLength(1);
    expect(buttons("Remove account")).toHaveLength(1);

    expect(buttons("Use for OpenAI")).toHaveLength(0);
    expect(buttons("Use for Anthropic")).toHaveLength(1);
    await click("Use for Google");
    expect(state.command).toHaveBeenLastCalledWith({
      environmentId,
      input: { instanceId, ...identity(routes[2]!), action: "default" },
    });
    expect(state.command).toHaveBeenCalledTimes(1);

    await click("Sign in again");
    expect(state.command).toHaveBeenLastCalledWith({
      environmentId,
      input: { instanceId, ...identity(routes[0]!), action: "deviceStart" },
    });
    expect(state.command).toHaveBeenCalledTimes(2);

    await click("Remove account");
    expect(text()).toContain("all models connected through this account");
    state.command.mockResolvedValueOnce(flowResult({ status: "disconnected" }));
    state.refresh.mockImplementationOnce(() => {
      state.data = { methods, connections: [] };
    });
    await act(async () => {
      buttons("Remove account").at(-1)!.props.onClick();
    });
    expect(state.command).toHaveBeenLastCalledWith({
      environmentId,
      input: { instanceId, ...identity(routes[0]!), action: "delete" },
    });
    expect(state.command).toHaveBeenCalledTimes(3);
    expect(text()).not.toContain("King");
    expect(text()).not.toContain("Default for OpenAI");
    expect(text()).not.toContain("GPT-6 Astra");
    expect(text()).not.toContain("Claude Haiku 4.5");
    expect(text()).toContain("Account removed. Saved conversations are kept.");
  });

  it("does not merge equally named accounts without shared native credential identity", () => {
    state.data = {
      methods,
      connections: ["openai", "anthropic", "gemini"].map((provider) =>
        connection({
          provider,
          backendKind: "copilot",
          state: "connected",
          accountLabel: "Same name",
          accountId: "same-login-id",
          ...(provider === "openai"
            ? {}
            : {
                credentialAccount: {
                  realm: provider === "anthropic" ? "global" : "project",
                  account: "same-id",
                },
              }),
        }),
      ),
    };
    render();
    expect(buttons("Remove account")).toHaveLength(3);
    expect(
      renderer!.root.findAllByType("h3").filter((node) => nodeText(node) === "GitHub Copilot"),
    ).toHaveLength(3);
  });

  it("shows only connected account models and preserves unverified support wording", () => {
    const model = {
      id: "fixture-model",
      displayName: "Private fixture model",
      tier: "standard",
      recommended: true,
    };
    state.data = {
      methods,
      connections: [
        connection({
          state: "needs_auth",
          models: [{ ...model, displayName: "Missing credential model" }],
        }),
        connection({
          bindingId: "other",
          profileId: "other",
          state: "connected",
          models: [model],
          modelsVerified: false,
        }),
      ],
    };
    render();
    expect(text()).toContain("Private fixture model");
    expect(text()).not.toContain("Missing credential model");
    expect(text()).not.toContain("Available to your account");
  });

  it("does not offer edits for host-managed credentials or read-only devices", async () => {
    state.data = { methods, connections: [connection({ editable: false, state: "connected" })] };
    render({ readOnly: true });
    expect(button("Add account").props.disabled).toBe(true);
    expect(buttons("Sign in again")).toHaveLength(0);
    expect(buttons("Remove account")).toHaveLength(0);
    expect(buttons("Use this account")).toHaveLength(0);
    expect(text()).toContain("Managed on this device");
    expect(state.command).not.toHaveBeenCalled();
  });

  it("does not start sign-in after configuration finishes on an unmounted account view", async () => {
    const pending = deferred<ReturnType<typeof flowResult>>();
    state.command.mockReturnValueOnce(pending.promise);
    render();
    await choose("ChatGPT");
    await submit();
    act(() => renderer!.unmount());
    renderer = undefined;
    await act(async () => {
      pending.resolve(flowResult({ status: "disconnected", connection: connection() }));
    });
    expect(state.command).toHaveBeenCalledTimes(1);
  });

  it("does not chain sign-in after edit permission is revoked", async () => {
    const pending = deferred<ReturnType<typeof flowResult>>();
    state.command.mockReturnValueOnce(pending.promise);
    render();
    await choose("ChatGPT");
    await submit();
    update({ readOnly: true });
    await act(async () => {
      pending.resolve(flowResult({ status: "disconnected", connection: connection() }));
    });
    expect(state.command).toHaveBeenCalledTimes(1);
  });

  it("rejects retained submit handlers after the view unmounts", async () => {
    render();
    await choose("ChatGPT");
    const handler = renderer!.root.findByType("form").props.onSubmit;
    act(() => renderer!.unmount());
    renderer = undefined;
    await act(async () => {
      handler({ preventDefault() {} });
    });
    expect(state.command).not.toHaveBeenCalled();
  });

  it("fences conversation auth by checkout identity and ignores stale completion after navigation", async () => {
    const pending = deferred<ReturnType<typeof flowResult>>();
    state.data = {
      methods,
      connections: [connection()],
      workspace: { projectId, threadId: targetA.threadId, cwd: targetA.expectedCwd },
    };
    state.command.mockReturnValueOnce(pending.promise);
    act(() => {
      renderer = create(
        <MeerkatProviderControls {...props} projectId={projectId} threadTarget={targetA} />,
      );
    });
    await click("Sign in");
    expect(state.command.mock.calls[0]?.[0]).toEqual({
      environmentId,
      input: {
        instanceId,
        projectId,
        threadTarget: targetA,
        ...identity(connection()),
        action: "start",
      },
    });
    act(() =>
      renderer!.update(
        <MeerkatProviderControls {...props} projectId={projectId} threadTarget={targetB} />,
      ),
    );
    expect(text()).toContain("no longer matches");
    expect(buttons("Sign in")).toHaveLength(0);
    await act(async () => {
      pending.resolve(flowResult({ status: "waiting", authorizeUrl: "https://stale.example" }));
    });
    expect(text()).not.toContain("stale.example");
    expect(state.refresh).not.toHaveBeenCalled();
  });

  for (const scoped of [false, true])
    it(`prepopulates and fences key replacement fields with project scope=${scoped}`, async () => {
      const azure: MeerkatAuthMethod = {
        ...methods[2]!,
        id: "azure",
        backendKind: "azure_openai",
        displayName: "Azure OpenAI",
        fields: [
          { key: "endpoint", label: "Endpoint", required: true, secret: false },
          { key: "model", label: "Deployment", required: true, secret: false },
        ],
      };
      const account = connection({
        state: "connected",
        authMethod: "api_key",
        backendKind: "azure_openai",
        supportsInteractiveLogin: false,
        supportsSecretUpdate: true,
        fields: { endpoint: "https://fixture.azure.example", model: "deployment" },
      });
      state.data = { methods: [azure], connections: [account] };
      state.command.mockResolvedValueOnce(flowResult({ connection: account }));
      render(scoped ? { projectId } : {});
      await click("Update API key");
      const inputs = renderer!.root.findAllByType("input");
      const endpoint = inputs.find((node) => node.props.value === "https://fixture.azure.example");
      const model = inputs.find((node) => node.props.value === "deployment");
      expect(endpoint?.props.disabled).toBe(scoped);
      expect(model?.props.disabled).toBe(scoped);
      expect(inputs.find((node) => node.props.type === "password")?.props.disabled).toBe(false);
      fill("Paste your API key", "replacement-fixture");
      await submit();
      expect(state.command).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: {
          instanceId,
          ...(scoped ? { projectId } : {}),
          ...identity(account),
          action: "configure",
          methodId: "azure",
          fields: { endpoint: "https://fixture.azure.example", model: "deployment" },
          secret: "replacement-fixture",
        },
      });
    });
});

import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type MeerkatAuthConnection,
  type MeerkatAuthOverview,
  type MeerkatAuthScope,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { act, StrictMode, useState, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type AuthRequest = { environmentId: EnvironmentId; input: MeerkatAuthScope };
type AuthSnapshot = {
  data: typeof MeerkatAuthOverview.Type | null;
  error: string | null;
  isPending: boolean;
};
const commands = vi.hoisted(() => ({ refresh: vi.fn(), auth: vi.fn(), read: vi.fn() }));
const providers = vi.hoisted(() => new Map<EnvironmentId, ReadonlyArray<ServerProvider>>());
const environmentA = EnvironmentId.make("computer-a");
const environmentB = EnvironmentId.make("computer-b");
const instanceId = ProviderInstanceId.make("meerkat");
const otherInstanceId = ProviderInstanceId.make("meerkat-work");
const success = AsyncResult.success({ providers: [] });
const failure = AsyncResult.failure(Cause.fail({ detail: "synthetic-provider-secret" }));
const liveInstances = new Set<string>();
const instanceKey = ({ environmentId, input }: AuthRequest) =>
  JSON.stringify([environmentId, input.instanceId]);

vi.mock("../../state/meerkatControls", () => ({
  meerkatControlsEnvironment: {
    authStatus: (request: AuthRequest) => request,
    authAction: "auth",
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    refreshProviders: "refresh",
    providersValueAtom: (id: EnvironmentId) => id,
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (id: EnvironmentId) => providers.get(id) ?? null,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "refresh" | "auth") => commands[command],
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: function useEnvironmentQuery(request: AuthRequest) {
    const [snapshot, setSnapshot] = useState<AuthSnapshot>(() => commands.read(request));
    return { ...snapshot, refresh: () => setSnapshot(commands.read(request)) };
  },
}));
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/menu", () => ({
  Menu: "div",
  MenuTrigger: "button",
  MenuPopup: "div",
  MenuItem: "button",
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogPopup: "div",
  DialogHeader: "div",
  DialogTitle: "h2",
  DialogDescription: "p",
  DialogPanel: "div",
  DialogFooter: "div",
}));

import { ProviderAccountsPanel } from "./ProviderAccountsPanel";
import { ProviderAccountContext } from "./ProviderAccountContext";
import type { ProviderAccountTarget } from "./providerAccountTarget";

let renderer: ReactTestRenderer | undefined;
function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join("");
}
function retryButton() {
  return renderer!.root
    .findAllByType("button")
    .find((node) => /^Try(?: again|ing again)/.test(text(node)))!;
}
function alerts() {
  return renderer!.root.findAllByProps({ role: "alert" }).map(text);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
async function render(
  environmentId = environmentA,
  targetInstanceId = instanceId,
  target: ProviderAccountTarget | null = null,
) {
  await act(async () => {
    const element = (
      <StrictMode>
        <ProviderAccountContext value={target}>
          <ProviderAccountsPanel environmentId={environmentId} instanceId={targetInstanceId} />
        </ProviderAccountContext>
      </StrictMode>
    );
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  liveInstances.clear();
  providers.clear();
  for (const id of [environmentA, environmentB]) {
    providers.set(
      id,
      [instanceId, otherInstanceId].map((nativeId) => ({
        instanceId: nativeId,
        driver: ProviderDriverKind.make("meerkat"),
        enabled: true,
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        checkedAt: "2026-10-10T00:00:00.000Z",
        models: [],
        slashCommands: [],
        skills: [],
      })),
    );
  }
  commands.auth.mockReset();
  commands.refresh.mockReset().mockImplementation(async (request: AuthRequest) => {
    liveInstances.add(instanceKey(request));
    return success;
  });
  commands.read.mockReset().mockImplementation((request: AuthRequest): AuthSnapshot => {
    if (!liveInstances.has(instanceKey(request))) {
      return {
        data: null,
        error: "Provider driver 'meerkat' failed to create instance: models.v1.catalog timed out",
        isPending: false,
      };
    }
    return {
      data: {
        connections: [
          {
            provider: "openai",
            displayName: "GitHub Copilot",
            accountLabel: "Work account",
            realmId: "global",
            bindingId: "work",
            profileId: "work",
            source: "profile",
            state: "connected",
            supportsInteractiveLogin: true,
          },
        ],
      },
      error: null,
      isPending: false,
    };
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("repairs a stale Antigravity settings URL before making any account request", async () => {
  const staleInstanceId = ProviderInstanceId.make(
    new URLSearchParams("instanceId=antigravity").get("instanceId")!,
  );
  const native = providers.get(environmentA)![0]!;
  providers.set(environmentA, [
    {
      ...native,
      instanceId: staleInstanceId,
      driver: ProviderDriverKind.make("antigravity"),
      enabled: false,
      availability: "unavailable",
    },
    native,
  ]);
  await render(environmentA, staleInstanceId);
  expect(commands.read).toHaveBeenCalled();
  expect(
    commands.read.mock.calls.every(([request]) => request.input.instanceId === instanceId),
  ).toBe(true);
});

it("repairs a stale global URL to the configured custom native instance", async () => {
  providers.set(environmentA, [providers.get(environmentA)![1]!]);
  await render(environmentA, ProviderInstanceId.make("antigravity"));
  expect(commands.read).toHaveBeenCalledWith({
    environmentId: environmentA,
    input: { instanceId: otherInstanceId },
  });
  expect(
    commands.read.mock.calls.every(([request]) => request.input.instanceId === otherInstanceId),
  ).toBe(true);
});

it("does not query another instance for a stale exact conversation account link", async () => {
  const staleInstanceId = ProviderInstanceId.make("antigravity");
  await render(environmentA, staleInstanceId, {
    environmentId: environmentA,
    instanceId: staleInstanceId,
    projectId: ProjectId.make("project-a"),
    threadTarget: { threadId: ThreadId.make("thread-a"), expectedCwd: "/tmp/project-a" },
  });
  expect(commands.read).not.toHaveBeenCalled();
  expect(alerts()[0]).toContain("open Providers from the Meerkat conversation");
});

it("preserves the exact custom native instance and conversation account scope", async () => {
  const target: ProviderAccountTarget = {
    environmentId: environmentA,
    instanceId: otherInstanceId,
    projectId: ProjectId.make("project-a"),
    threadTarget: { threadId: ThreadId.make("thread-a"), expectedCwd: "/tmp/project-a" },
  };
  await render(environmentA, otherInstanceId, target);
  expect(commands.read).toHaveBeenCalledWith({
    environmentId: environmentA,
    input: {
      instanceId: otherInstanceId,
      projectId: target.projectId,
      threadTarget: target.threadTarget,
    },
  });
});

it("does not redirect an explicit project account to a different native instance", async () => {
  await act(async () => {
    renderer = create(
      <ProviderAccountsPanel
        environmentId={environmentA}
        instanceId={ProviderInstanceId.make("antigravity")}
        projectId={ProjectId.make("project-a")}
      />,
    );
  });
  expect(commands.read).not.toHaveBeenCalled();
  expect(alerts()[0]).toContain("open Providers from the Meerkat conversation");
});

it("preserves the configured native instance for a project-only account request", async () => {
  const projectId = ProjectId.make("project-a");
  await act(async () => {
    renderer = create(
      <ProviderAccountsPanel
        environmentId={environmentA}
        instanceId={otherInstanceId}
        projectId={projectId}
      />,
    );
  });
  expect(commands.read).toHaveBeenCalledWith({
    environmentId: environmentA,
    input: { instanceId: otherInstanceId, projectId },
  });
});

it("shows an actionable unavailable state instead of querying an ambiguous native account", async () => {
  const custom = providers.get(environmentA)![1]!;
  providers.set(environmentA, [
    custom,
    { ...custom, instanceId: ProviderInstanceId.make("another-native") },
  ]);
  await render(environmentA, ProviderInstanceId.make("antigravity"));
  expect(commands.read).not.toHaveBeenCalled();
  expect(alerts()[0]).toContain("Reconnect this device");
});

it("waits for device configuration without guessing a native instance ID", async () => {
  providers.clear();
  await render();
  expect(commands.read).not.toHaveBeenCalled();
  expect(text(renderer!.root)).toContain("Loading model accounts");
});

it("releases onboarding's pending state when its native instance disappears during account setup", async () => {
  commands.read.mockReturnValue({
    data: {
      connections: [],
      methods: [
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
      ],
    },
    error: null,
    isPending: false,
  });
  const pending = vi.fn();
  const error = vi.fn();
  const configure = deferred<unknown>();
  commands.auth.mockReturnValue(configure.promise);
  const element = () => (
    <ProviderAccountsPanel
      environmentId={environmentA}
      instanceId={instanceId}
      onPendingChange={pending}
      onErrorChange={error}
    />
  );
  await act(async () => {
    renderer = create(element());
  });
  const click = async (label: string) =>
    act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((node) => text(node).startsWith(label))!
        .props.onClick();
    });
  await click("Add account");
  await click("OpenAI API");
  await act(async () => {
    renderer!.root.findByType("input").props.onChange({ target: { value: "synthetic-test-key" } });
  });
  await act(async () => {
    renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} });
  });
  expect(pending).toHaveBeenLastCalledWith(true);
  expect(commands.auth).toHaveBeenCalledTimes(1);
  providers.set(environmentA, []);
  await act(async () => {
    renderer!.update(element());
  });
  expect(pending).toHaveBeenLastCalledWith(false);
  expect(error).toHaveBeenLastCalledWith(true);
  expect(alerts()[0]).toContain("Reconnect this device");
  await act(async () => configure.resolve(AsyncResult.success({ status: "connected" })));
  expect(pending).toHaveBeenLastCalledWith(false);
  expect(error).toHaveBeenLastCalledWith(true);
});

it("recovers a failed startup before rereading accounts and ignores duplicate retry clicks", async () => {
  const recovery = deferred<typeof success>();
  commands.refresh.mockImplementationOnce(async (request: AuthRequest) => {
    const result = await recovery.promise;
    liveInstances.add(instanceKey(request));
    return result;
  });
  await render();
  expect(alerts()).toHaveLength(1);
  expect(text(renderer!.root)).not.toContain("Work account");
  const readsBeforeRetry = commands.read.mock.calls.length;

  await act(async () => {
    const click = retryButton().props.onClick;
    click();
    click();
  });
  expect(commands.refresh).toHaveBeenCalledExactlyOnceWith({
    environmentId: environmentA,
    input: { instanceId, refreshModels: true },
  });
  expect(commands.read).toHaveBeenCalledTimes(readsBeforeRetry);
  expect(retryButton().props.disabled).toBe(true);

  await act(async () => recovery.resolve(success));
  expect(commands.read).toHaveBeenCalledTimes(readsBeforeRetry + 1);
  expect(alerts()).toEqual([]);
  expect(text(renderer!.root)).toContain("Work account");
  expect(commands.auth).not.toHaveBeenCalled();
});

it("keeps failed recovery retryable without leaking diagnostics or rereading a missing instance", async () => {
  commands.refresh.mockResolvedValueOnce(failure);
  await render();
  const cached = providers.get(environmentA);
  const readsBeforeRetry = commands.read.mock.calls.length;
  await act(async () => retryButton().props.onClick());
  expect(alerts()).toEqual([
    "Could not reconnect provider accounts. Check this device's connection and try again.Try again",
  ]);
  expect(text(renderer!.root)).not.toContain("synthetic-provider-secret");
  expect(commands.read).toHaveBeenCalledTimes(readsBeforeRetry);
  expect(providers.get(environmentA)).toBe(cached);
  expect(commands.auth).not.toHaveBeenCalled();
  expect(retryButton().props.disabled).toBe(false);

  await act(async () => retryButton().props.onClick());
  expect(alerts()).toEqual([]);
  expect(text(renderer!.root)).toContain("Work account");
});

it("keeps a thrown recovery error safe and permits retry", async () => {
  commands.refresh.mockRejectedValueOnce(new Error("synthetic-provider-secret"));
  await render();
  const readsBeforeRetry = commands.read.mock.calls.length;
  await act(async () => retryButton().props.onClick());
  expect(alerts()).toEqual([
    "Could not reconnect provider accounts. Check this device's connection and try again.Try again",
  ]);
  expect(text(renderer!.root)).not.toContain("synthetic-provider-secret");
  expect(commands.read).toHaveBeenCalledTimes(readsBeforeRetry);
  expect(retryButton().props.disabled).toBe(false);
  await act(async () => retryButton().props.onClick());
  expect(alerts()).toEqual([]);
  expect(text(renderer!.root)).toContain("Work account");
});

it("does not announce interrupted recovery as another account failure and permits retry", async () => {
  commands.refresh.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
  await render();
  const initialAlerts = alerts();
  const readsBeforeRetry = commands.read.mock.calls.length;
  await act(async () => retryButton().props.onClick());
  expect(alerts()).toEqual(initialAlerts);
  expect(commands.read).toHaveBeenCalledTimes(readsBeforeRetry);
  expect(retryButton().props.disabled).toBe(false);
  await act(async () => retryButton().props.onClick());
  expect(commands.refresh).toHaveBeenCalledTimes(2);
  expect(alerts()).toEqual([]);
  expect(text(renderer!.root)).toContain("Work account");
});

it("clears a recovery error when changing devices without replaying it on return", async () => {
  commands.refresh.mockResolvedValueOnce(failure);
  await render();
  await act(async () => retryButton().props.onClick());
  expect(alerts()[0]).toContain("Could not reconnect provider accounts");
  await render(environmentB);
  expect(alerts()[0]).toContain("Could not read provider accounts");
  expect(alerts()[0]).not.toContain("Could not reconnect provider accounts");
  await render(environmentA);
  expect(alerts()[0]).toContain("Could not read provider accounts");
  expect(alerts()[0]).not.toContain("Could not reconnect provider accounts");
  expect(commands.refresh).toHaveBeenCalledTimes(1);
});

it("ignores an unmounted recovery's late failure after the same account panel reopens", async () => {
  const first = deferred<typeof failure>();
  commands.refresh.mockReturnValueOnce(first.promise);
  await render();
  await act(async () => retryButton().props.onClick());
  await act(async () => renderer!.unmount());
  renderer = undefined;
  await render();
  await act(async () => retryButton().props.onClick());
  const readsBeforeCompletion = commands.read.mock.calls.length;
  await act(async () => first.resolve(failure));
  expect(commands.read).toHaveBeenCalledTimes(readsBeforeCompletion);
  expect(alerts()).toEqual([]);
  expect(text(renderer!.root)).toContain("Work account");
  expect(commands.refresh).toHaveBeenCalledTimes(2);
});

it.each([
  { state: "unknown" as const, authMethod: "managed_chatgpt_oauth" },
  { state: "connected" as const, authMethod: "github_copilot_oauth" },
])(
  "checks a $state saved account and shows its models without repeating sign-in",
  async ({ state, authMethod }) => {
    const savedAccount = {
      provider: "openai",
      displayName: "ChatGPT",
      accountLabel: "Saved account",
      realmId: "global",
      bindingId: "personal",
      profileId: "personal",
      source: "managed_store",
      state,
      authMethod,
      credentialObservation: "not_observed" as const,
      supportsInteractiveLogin: true,
      editable: true,
    };
    const snapshot = (connection: MeerkatAuthConnection) => ({
      data: { connections: [connection] },
      error: null,
      isPending: false,
    });
    commands.read.mockReturnValue(snapshot(savedAccount));
    const check = deferred<unknown>();
    commands.auth.mockReturnValue(check.promise);
    await render();
    expect(text(renderer!.root)).toContain("Check account");
    expect(commands.auth).not.toHaveBeenCalled();
    await act(async () =>
      renderer!.root.findByProps({ "aria-label": "Refresh accounts and models" }).props.onClick(),
    );
    expect(commands.auth).not.toHaveBeenCalled();
    const checkButton = () =>
      renderer!.root.findAllByType("button").find((node) => text(node) === "Check account")!;
    await act(async () => {
      const click = checkButton().props.onClick;
      click();
      click();
    });
    expect(commands.auth).toHaveBeenCalledExactlyOnceWith({
      environmentId: environmentA,
      input: {
        instanceId,
        provider: "openai",
        realmId: "global",
        bindingId: "personal",
        profileId: "personal",
        action: "check",
      },
    });
    expect(checkButton().props.disabled).toBe(true);
    const connected = {
      ...savedAccount,
      state: "connected" as const,
      isDefault: true,
      modelsVerified: true,
      models: [
        { id: "example-model", displayName: "Example model", tier: "standard", recommended: true },
      ],
    };
    commands.read.mockReturnValue(snapshot(connected));
    await act(async () =>
      check.resolve(
        AsyncResult.success({
          flowId: null,
          authorizeUrl: null,
          status: "connected",
          message: null,
          connection: connected,
        }),
      ),
    );
    expect(text(renderer!.root)).toContain("Example model");
    expect(text(renderer!.root)).not.toContain("Check account");
    expect(commands.auth).toHaveBeenCalledTimes(1);
  },
);

it("keeps an incomplete saved-account check retryable without showing native diagnostics", async () => {
  commands.read.mockReturnValue({
    data: {
      connections: [
        {
          provider: "openai",
          displayName: "ChatGPT",
          realmId: "global",
          bindingId: "personal",
          profileId: "personal",
          source: "managed_store",
          state: "unknown",
          credentialObservation: "pending",
          supportsInteractiveLogin: true,
          editable: true,
        },
      ],
    },
    error: null,
    isPending: false,
  });
  commands.auth.mockResolvedValue(failure);
  await render();
  const checkButton = () =>
    renderer!.root.findAllByType("button").find((node) => text(node) === "Check account")!;
  await act(async () => checkButton().props.onClick());
  expect(alerts()[0]).toContain("Complete any system prompt, then check the account again.");
  expect(text(renderer!.root)).not.toContain("synthetic-provider-secret");
  expect(checkButton().props.disabled).toBe(false);
  expect(commands.auth).toHaveBeenCalledTimes(1);
});

it.each(
  [
    { environmentId: environmentB, targetInstanceId: instanceId },
    { environmentId: environmentA, targetInstanceId: otherInstanceId },
  ].flatMap((target) =>
    [success, failure].map((oldResult) => ({ ...target, oldResult, resultTag: oldResult._tag })),
  ),
)(
  "does not apply late $resultTag recovery after switching to $environmentId/$targetInstanceId",
  async (target) => {
    const first = deferred<typeof success | typeof failure>();
    const second = deferred<typeof success>();
    commands.refresh.mockImplementation(async (request: AuthRequest) => {
      const waiting =
        request.environmentId === environmentA && request.input.instanceId === instanceId
          ? first
          : second;
      const result = await waiting.promise;
      if (result._tag === "Success") liveInstances.add(instanceKey(request));
      return result;
    });
    await render();
    await act(async () => retryButton().props.onClick());
    await render(target.environmentId, target.targetInstanceId);
    expect(retryButton().props.disabled).toBe(false);
    await act(async () => retryButton().props.onClick());
    const readsBeforeCompletion = commands.read.mock.calls.length;
    const currentAlerts = alerts();

    await act(async () => first.resolve(target.oldResult));
    expect(commands.read).toHaveBeenCalledTimes(readsBeforeCompletion);
    expect(retryButton().props.disabled).toBe(true);
    expect(alerts()).toEqual(currentAlerts);
    expect(text(renderer!.root)).not.toContain("Work account");

    await act(async () => second.resolve(success));
    expect(commands.read).toHaveBeenLastCalledWith({
      environmentId: target.environmentId,
      input: { instanceId: target.targetInstanceId },
    });
    expect(alerts()).toEqual([]);
    expect(text(renderer!.root)).toContain("Work account");
  },
);

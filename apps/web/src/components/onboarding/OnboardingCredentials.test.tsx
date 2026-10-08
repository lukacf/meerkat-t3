import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceEnvironmentVariable,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({ update: vi.fn(), refresh: vi.fn() }));
const environmentId = EnvironmentId.make("local");
const instanceId = ProviderInstanceId.make("native");
const variables: ReadonlyArray<ProviderInstanceEnvironmentVariable> = [
  { name: "ANTHROPIC_API_KEY", value: "", sensitive: true, valueRedacted: true },
  { name: "OPENAI_API_KEY", value: "test-key", sensitive: true },
];
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("meerkat"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-04T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId,
        label: "This Mac",
        connection: { phase: "connected" },
        serverConfig: {},
        entry: { target: { _tag: "PrimaryConnectionTarget" } },
      },
    ],
  }),
}));
vi.mock("../../environments/primary", () => ({ usePrimarySessionState: vi.fn() }));
vi.mock("../../state/session", () => ({ useEnvironmentSessionState: vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({
    providerInstances: {
      [instanceId]: { driver: "meerkat", environment: [] },
      other: { driver: "codex", environment: [] },
    },
  }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { updateProviderSettings: "update", refreshProviders: "refresh" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "update" | "refresh") => commands[command],
}));
vi.mock("../settings/ProviderSettingsPanel.logic", () => ({
  classifyProviderEnvironmentAccess: () => ({ kind: "editable" }),
  resolvePrimaryOperateAccess: vi.fn(),
  resolveRemoteOperateAccess: vi.fn(),
}));
vi.mock("../settings/ProviderInstanceCard", () => ({
  ProviderEnvironmentSection: ({
    onChange,
  }: {
    onChange: (value: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
  }) => <button onClick={() => onChange(variables)}>Save credentials</button>,
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

import { OnboardingCredentials } from "./OnboardingCredentials";

let renderer: ReactTestRenderer | undefined;
const pending = vi.fn();
const error = vi.fn();
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((node) => node.children.includes(label))!;
const alerts = () => renderer!.root.findAllByProps({ role: "alert" });
const statusText = () =>
  renderer!.root
    .findAllByProps({ role: "status" })
    .flatMap((node) => node.children)
    .join(" ");
async function render() {
  await act(async () => {
    renderer = create(
      <OnboardingCredentials
        environmentId={environmentId}
        instanceId={instanceId}
        onPendingChange={pending}
        onErrorChange={error}
      />,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  commands.update.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  commands.refresh
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { providers: [provider] } });
  pending.mockReset();
  error.mockReset();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("keeps a returned provider failure visible and retries the check without saving secrets again", async () => {
  commands.refresh.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      providers: [
        { ...provider, status: "error", message: "The runtime could not load this account." },
      ],
    },
  });
  await render();
  await act(async () => button("Save credentials").props.onClick());
  expect(alerts()[0]?.children).toEqual(["The runtime could not load this account."]);
  expect(statusText()).not.toContain("Runtime setup is ready");
  expect(error).toHaveBeenLastCalledWith(true);
  expect(pending).toHaveBeenLastCalledWith(false);
  expect(commands.update.mock.calls[0]?.[0]).toEqual({
    environmentId,
    input: { kind: "edit", instanceId, driver: "meerkat", changes: { environment: variables } },
  });

  await act(async () => button("Retry check").props.onClick());
  expect(commands.update).toHaveBeenCalledTimes(1);
  expect(commands.refresh).toHaveBeenCalledTimes(2);
  expect(alerts()).toHaveLength(0);
  expect(statusText()).toContain("Credentials saved");
  expect(statusText()).toContain("first task will confirm model access");
  expect(error).toHaveBeenLastCalledWith(false);
});

it("does not accept another provider's ready snapshot for the edited instance", async () => {
  commands.refresh.mockResolvedValue({
    _tag: "Success",
    value: { providers: [{ ...provider, instanceId: ProviderInstanceId.make("other") }] },
  });
  await render();
  await act(async () => button("Save credentials").props.onClick());
  expect(alerts()[0]?.children.join(" ")).toContain("this provider has not reported its status");
  expect(button("Retry check")).toBeDefined();
  expect(error).toHaveBeenLastCalledWith(true);
});

it("retains failed credential edits for retry and never checks an unsaved key", async () => {
  commands.update.mockRejectedValueOnce(new Error("Computer disconnected"));
  await render();
  await act(async () => button("Save credentials").props.onClick());
  expect(alerts()[0]?.children).toEqual(["Computer disconnected"]);
  expect(commands.refresh).not.toHaveBeenCalled();
  expect(error).toHaveBeenLastCalledWith(true);

  await act(async () => button("Retry save").props.onClick());
  expect(commands.update).toHaveBeenCalledTimes(2);
  expect(commands.update.mock.calls[1]?.[0]).toEqual(commands.update.mock.calls[0]?.[0]);
  expect(commands.refresh).toHaveBeenCalledTimes(1);
  expect(alerts()).toHaveLength(0);
  expect(error).toHaveBeenLastCalledWith(false);
});

it("waits for the scoped credential intent acknowledgement before reporting saved or checking the runtime", async () => {
  let acknowledge!: (value: { readonly _tag: "Success"; readonly value: object }) => void;
  commands.update.mockReturnValueOnce(
    new Promise((resolve) => {
      acknowledge = resolve;
    }),
  );
  await render();
  await act(async () => button("Save credentials").props.onClick());
  expect(pending).toHaveBeenLastCalledWith(true);
  expect(statusText()).toContain("Saving credential changes");
  expect(statusText()).not.toContain("saved");
  expect(commands.refresh).not.toHaveBeenCalled();
  await act(async () => button("Save credentials").props.onClick());
  expect(commands.update).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { kind: "edit", instanceId, driver: "meerkat", changes: { environment: variables } },
  });
  await act(async () => acknowledge({ _tag: "Success", value: {} }));
  expect(commands.refresh).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { instanceId },
  });
  expect(statusText()).toContain("Credentials saved");
  expect(pending).toHaveBeenLastCalledWith(false);
  expect(error).toHaveBeenLastCalledWith(false);
});

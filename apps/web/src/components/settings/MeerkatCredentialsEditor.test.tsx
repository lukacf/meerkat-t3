import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSettingsConflictError,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({ update: vi.fn(), refresh: vi.fn() }));
const environmentId = EnvironmentId.make("local");
const remoteId = EnvironmentId.make("remote");
const instanceId = ProviderInstanceId.make("native");
const otherInstanceId = ProviderInstanceId.make("second-native");
const stored: ProviderInstanceEnvironmentVariable = {
  name: "ANTHROPIC_API_KEY",
  value: "",
  sensitive: true,
  valueRedacted: true,
};
const storedOpenAi: ProviderInstanceEnvironmentVariable = {
  ...stored,
  name: "OPENAI_API_KEY",
};
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
let settings: Record<string, { providerInstances: Record<string, ProviderInstanceConfig> }>;

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (id: EnvironmentId) => settings[id],
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { updateProviderSettings: "update", refreshProviders: "refresh" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "update" | "refresh") => commands[command],
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ children, control }: { children: ReactNode; control: ReactNode }) => (
    <section>
      {control}
      {children}
    </section>
  ),
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
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
// Keep the real DraftInput/useCommitOnBlur behavior that caused unchanged edits
// to stop publishing after a failed save.
vi.mock("../ui/input", () => ({
  Input: ({
    font: _font,
    size: _size,
    ...props
  }: Omit<ComponentProps<"input">, "size"> & { font?: string; size?: string }) => (
    <input {...props} />
  ),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));

import { MeerkatCredentialsEditor } from "./MeerkatCredentialsEditor";

let renderer: ReactTestRenderer | undefined;
const activity = vi.fn();
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((node) => node.children.includes(label));
const field = (label: string) =>
  renderer!.root.findAllByType("input").find((node) => node.props["aria-label"] === label)!;
const remove = (name: string) =>
  renderer!.root.findByProps({ "aria-label": `Remove environment variable ${name}` });
const alerts = () => renderer!.root.findAllByProps({ role: "alert" });
const statusText = () =>
  renderer!.root
    .findAllByProps({ role: "status" })
    .flatMap((node) => node.children)
    .join(" ");
const successfulSave = { _tag: "Success", value: {} } as const;
const successfulCheck = { _tag: "Success", value: { providers: [provider] } } as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
async function render(id = environmentId, providerId = instanceId, readOnly = false) {
  await act(async () => {
    const element = (
      <MeerkatCredentialsEditor
        environmentId={id}
        environmentLabel={id === environmentId ? "This Mac" : "Remote computer"}
        instanceId={providerId}
        readOnly={readOnly}
        onActivityChange={activity}
      />
    );
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}
async function edit(value: string) {
  await act(async () => field("OpenAI API key").props.onFocus());
  await act(async () => field("OpenAI API key").props.onChange({ target: { value } }));
  await act(async () => field("OpenAI API key").props.onBlur());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  commands.update.mockReset().mockResolvedValue(successfulSave);
  commands.refresh.mockReset().mockResolvedValue(successfulCheck);
  activity.mockReset();
  settings = Object.fromEntries(
    [environmentId, remoteId].map((id) => [
      id,
      {
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("meerkat"),
            environment: [stored, storedOpenAi],
          },
          [otherInstanceId]: {
            driver: ProviderDriverKind.make("meerkat"),
            environment: [storedOpenAi],
          },
          donor: { driver: ProviderDriverKind.make("codex"), config: { retained: true } },
        },
      },
    ]),
  );
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("retains a failed edit and retries the same unchanged value on the exact environment and instance", async () => {
  commands.update.mockRejectedValueOnce(new Error("Could not save synthetic-key: disconnected"));
  await render(remoteId);
  expect(field("Anthropic API key").props.value).toBe("");
  expect(field("Anthropic API key").props.placeholder).toContain("Stored secret");
  await edit("synthetic-key");
  expect(alerts()[0]?.children).toEqual(["Could not save [redacted]: disconnected"]);
  expect(field("OpenAI API key").props.value).toBe("synthetic-key");
  expect(field("OpenAI API key").props.type).toBe("password");
  expect(commands.refresh).not.toHaveBeenCalled();

  await act(async () => field("OpenAI API key").props.onFocus());
  await act(async () => field("OpenAI API key").props.onBlur());
  expect(commands.update).toHaveBeenCalledTimes(1);
  await act(async () => button("Retry save")!.props.onClick());
  expect(commands.update).toHaveBeenCalledTimes(2);
  expect(commands.update.mock.calls[1]?.[0]).toEqual(commands.update.mock.calls[0]?.[0]);
  expect(commands.update.mock.calls[1]?.[0]).toEqual({
    environmentId: remoteId,
    input: {
      kind: "edit",
      instanceId,
      driver: "meerkat",
      changes: {
        environment: [stored, { ...storedOpenAi, value: "synthetic-key", valueRedacted: false }],
      },
    },
  });
  expect(commands.refresh).toHaveBeenCalledWith({ environmentId: remoteId, input: { instanceId } });
  expect(alerts()).toHaveLength(0);
  expect(statusText()).toContain("first request will confirm model access");
});

it("replaces a failed key edit with its removal and retries only that removal, then only its check", async () => {
  commands.update
    .mockRejectedValueOnce(new Error("Disconnected"))
    .mockRejectedValueOnce(new Error("Still disconnected"));
  commands.refresh.mockResolvedValueOnce({
    _tag: "Success",
    value: { providers: [{ ...provider, status: "warning", auth: { status: "unauthenticated" } }] },
  });
  await render();
  await edit("synthetic-key");
  await act(async () => remove("OPENAI_API_KEY").props.onClick());
  expect(field("OpenAI API key")).toBeUndefined();
  expect(commands.refresh).not.toHaveBeenCalled();
  await act(async () => button("Retry save")!.props.onClick());
  expect(commands.update.mock.calls[2]?.[0]).toEqual(commands.update.mock.calls[1]?.[0]);
  expect(commands.update.mock.calls[2]?.[0].input.changes.environment).toEqual([stored]);
  expect(statusText()).toContain("Credential changes saved");
  expect(statusText()).not.toContain("Runtime setup is ready");
  expect(button("Retry check")).toBeDefined();
  await act(async () => button("Retry check")!.props.onClick());
  expect(commands.update).toHaveBeenCalledTimes(3);
  expect(commands.refresh).toHaveBeenCalledTimes(2);
  expect(field("OpenAI API key")).toBeUndefined();
  expect(alerts()).toHaveLength(0);
});

it("excludes duplicate blur and removal callbacks while a credential save is pending", async () => {
  const save = deferred<typeof successfulSave>();
  commands.update.mockReturnValueOnce(save.promise);
  await render();
  const staleRemove = remove("OPENAI_API_KEY").props.onClick;
  await act(async () => field("OpenAI API key").props.onFocus());
  await act(async () =>
    field("OpenAI API key").props.onChange({ target: { value: "synthetic-key" } }),
  );
  const staleBlur = field("OpenAI API key").props.onBlur;
  await act(async () => staleBlur());
  expect(statusText()).toContain("Saving credential changes");
  await act(async () => {
    staleBlur();
    staleRemove();
  });
  expect(commands.update).toHaveBeenCalledTimes(1);
  expect(field("OpenAI API key").props.value).toBe("synthetic-key");
  expect(commands.refresh).not.toHaveBeenCalled();
  await act(async () => save.resolve(successfulSave));
  expect(commands.refresh).toHaveBeenCalledTimes(1);
});

it("retains the credential attempt after a server conflict without checking or resending a stale provider map", async () => {
  commands.update.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(
      new ProviderSettingsConflictError({ instanceId, reason: "instance_missing" }),
    ),
  });
  await render();
  await edit("synthetic-key");
  expect(alerts()[0]?.children.join(" ")).toContain("no longer exists");
  expect(field("OpenAI API key").props.value).toBe("synthetic-key");
  expect(statusText()).not.toContain("saved");
  expect(commands.refresh).not.toHaveBeenCalled();

  const instance = settings[environmentId]!.providerInstances[instanceId]!;
  settings[environmentId] = {
    providerInstances: {
      [instanceId]: { ...instance, displayName: "Restored by another client" },
    },
  };
  await render();
  await act(async () => button("Retry save")!.props.onClick());
  expect(commands.update.mock.calls[1]?.[0]).toEqual(commands.update.mock.calls[0]?.[0]);
  expect(commands.update.mock.calls[1]?.[0]).toEqual({
    environmentId,
    input: {
      kind: "edit",
      instanceId,
      driver: "meerkat",
      changes: {
        environment: [stored, { ...storedOpenAi, value: "synthetic-key", valueRedacted: false }],
      },
    },
  });
  expect(commands.refresh).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { instanceId },
  });
  expect(alerts()).toHaveLength(0);
});

it("retains the result while parent instance writes are frozen and allows retry after release", async () => {
  const save = deferred<typeof successfulSave>();
  commands.update.mockReturnValueOnce(save.promise);
  await render();
  await edit("synthetic-key");
  expect(activity).toHaveBeenLastCalledWith(true);
  await render(environmentId, instanceId, true);
  await act(async () => save.reject(new Error("Disconnected")));
  expect(activity).toHaveBeenLastCalledWith(false);
  expect(alerts()[0]?.children).toEqual(["Disconnected"]);
  expect(field("OpenAI API key").props.value).toBe("synthetic-key");
  await render(environmentId, instanceId);
  await act(async () => button("Retry save")!.props.onClick());
  expect(commands.update).toHaveBeenCalledTimes(2);
  expect(commands.update.mock.calls[1]?.[0]).toEqual(commands.update.mock.calls[0]?.[0]);
  expect(alerts()).toHaveLength(0);
});

it("keeps request activity pending after unmount until the original save settles", async () => {
  const save = deferred<typeof successfulSave>();
  commands.update.mockReturnValueOnce(save.promise);
  await render();
  await edit("synthetic-key");
  await act(async () => renderer?.unmount());
  renderer = undefined;
  expect(activity.mock.calls).toEqual([[true]]);
  await act(async () => save.resolve(successfulSave));
  expect(activity.mock.calls).toEqual([[true], [false]]);
  expect(commands.refresh).not.toHaveBeenCalled();
});

it.each([
  { label: "environment", nextEnvironment: remoteId, nextInstance: instanceId },
  { label: "instance", nextEnvironment: environmentId, nextInstance: otherInstanceId },
])(
  "does not apply a late save result after switching $label",
  async ({ nextEnvironment, nextInstance }) => {
    const save = deferred<typeof successfulSave>();
    commands.update.mockReturnValueOnce(save.promise);
    await render();
    await edit("first-synthetic-key");
    await render(nextEnvironment, nextInstance);
    expect(field("OpenAI API key").props.value).toBe("");
    expect(button("Retry save")).toBeUndefined();
    commands.refresh.mockResolvedValueOnce({
      _tag: "Success",
      value: { providers: [{ ...provider, instanceId: nextInstance }] },
    });
    await edit("second-synthetic-key");
    expect(commands.update.mock.calls[1]?.[0].environmentId).toBe(nextEnvironment);
    expect(commands.update.mock.calls[1]?.[0].input.changes.environment).toContainEqual({
      ...storedOpenAi,
      value: "second-synthetic-key",
      valueRedacted: false,
    });
    await act(async () => save.resolve(successfulSave));
    expect(commands.refresh).toHaveBeenCalledTimes(1);
    expect(commands.refresh).toHaveBeenCalledWith({
      environmentId: nextEnvironment,
      input: { instanceId: nextInstance },
    });
    expect(field("OpenAI API key").props.value).toBe("second-synthetic-key");
    expect(alerts()).toHaveLength(0);
    expect(statusText()).toContain("Runtime setup is ready");
  },
);

it("does not expose an old check error or retry values after changing scope", async () => {
  const check = deferred<typeof successfulCheck>();
  commands.refresh.mockReturnValueOnce(check.promise);
  await render();
  await edit("first-synthetic-key");
  expect(statusText()).toContain("Checking the runtime");
  await render(remoteId);
  await act(async () => check.reject(new Error("Old provider check failed")));
  expect(alerts()).toHaveLength(0);
  expect(button("Retry check")).toBeUndefined();
  expect(field("OpenAI API key").props.value).toBe("");
  expect(statusText()).not.toContain("saved");
});

import { EnvironmentId, ProviderDriverKind, type ProviderInstanceConfig } from "@t3tools/contracts";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({ update: vi.fn(), toast: vi.fn() }));
const atoms = vi.hoisted(() => ({
  updateProviderSettings: Symbol("updateProviderSettings"),
  updateProvider: Symbol("updateProvider"),
}));
const localId = EnvironmentId.make("local-device");
const remoteId = EnvironmentId.make("remote-device");
let settings: Record<string, { providerInstances: Record<string, ProviderInstanceConfig> }>;

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (id: EnvironmentId) => settings[id],
}));
vi.mock("../../state/server", () => ({ serverEnvironment: atoms }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) => {
    if (atom === atoms.updateProviderSettings) return commands.update;
    throw new Error("Unexpected command in Add provider dialog");
  },
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: commands.toast } }));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
}));
vi.mock("../ui/wizard", () => ({
  WizardPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  WizardHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  WizardPanel: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  WizardFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  WizardSteps: ({
    steps,
    onStepChange,
  }: {
    steps: string[];
    onStepChange: (step: number) => void;
  }) => (
    <nav>
      {steps.map((step, index) => (
        <button key={step} onClick={() => onStepChange(index)}>
          {step}
        </button>
      ))}
    </nav>
  ),
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
vi.mock("../ui/input", () => ({ Input: (props: ComponentProps<"input">) => <input {...props} /> }));
vi.mock("../ui/radio-group", () => ({
  RadioGroup: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode;
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
}));
vi.mock("@base-ui/react/radio", () => ({
  Radio: {
    Root: ({ value, disabled }: { value: string; disabled?: boolean }) => (
      <option value={value} disabled={disabled}>
        {value}
      </option>
    ),
    Indicator: () => null,
  },
}));
vi.mock("./ProviderAccentColorPicker", () => ({ ProviderAccentColorPicker: () => null }));
// The driver form is a presentation boundary. These tests exercise the real
// dialog's draft, command, unmount and retry lifecycle, not each driver's fields.
vi.mock("./ProviderSettingsForm", () => ({
  deriveProviderSettingsFields: () => [{}],
  ProviderSettingsForm: ({
    value,
    onChange,
  }: {
    value: Record<string, string>;
    onChange: (value: Record<string, string>) => void;
  }) => (
    <input
      aria-label="Fixture binary path"
      value={value.binaryPath ?? ""}
      onChange={(event) => onChange({ binaryPath: event.target.value })}
    />
  ),
}));

import { Dialog } from "../ui/dialog";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";

let renderer: ReactTestRenderer | undefined;
const onOpenChange = vi.fn();
const successfulSave = { _tag: "Success", value: {} } as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((node) => node.children.includes(label))!;
const field = (placeholder: string) => renderer!.root.findByProps({ placeholder });
const configField = () => renderer!.root.findByProps({ "aria-label": "Fixture binary path" });
const alerts = () => renderer!.root.findAllByProps({ role: "alert" });
async function render(environmentId = localId) {
  await act(async () => {
    const element = (
      <AddProviderInstanceDialog
        open
        environmentId={environmentId}
        environmentLabel={environmentId}
        onOpenChange={onOpenChange}
      />
    );
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}
async function fill() {
  await act(async () =>
    renderer!.root.findByType("select").props.onChange({ target: { value: "meerkat" } }),
  );
  await act(async () => button("Next").props.onClick());
  await act(async () => field("e.g. Work").props.onChange({ target: { value: "Work API" } }));
  await act(async () =>
    field("meerkat_work").props.onChange({ target: { value: "meerkat_exact" } }),
  );
  await act(async () =>
    renderer!.root.findByProps({ "aria-label": "Use #16a34a accent" }).props.onClick(),
  );
  await act(async () => button("Next").props.onClick());
  await act(async () =>
    configField().props.onChange({ target: { value: "/fixture/native-gateway" } }),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  commands.update.mockReset().mockResolvedValue(successfulSave);
  commands.toast.mockReset();
  onOpenChange.mockReset();
  settings = Object.fromEntries(
    [localId, remoteId].map((id) => [
      id,
      {
        providerInstances: {
          retained: { driver: ProviderDriverKind.make("meerkat"), enabled: false },
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

it("retains all entries after a failed save and confirms only the successful retry on the selected environment", async () => {
  const first = deferred<unknown>();
  const retry = deferred<unknown>();
  commands.update.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
  await render(remoteId);
  await fill();
  await act(async () => button("Add instance").props.onClick());
  expect(commands.toast).not.toHaveBeenCalled();
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(commands.update.mock.calls[0]?.[0]).toEqual({
    environmentId: remoteId,
    input: {
      kind: "add",
      instanceId: "meerkat_exact",
      instance: {
        driver: "meerkat",
        enabled: true,
        displayName: "Work API",
        accentColor: "#16a34a",
        config: { binaryPath: "/fixture/native-gateway" },
      },
    },
  });
  await act(async () => first.resolve({ _tag: "Failure", cause: "synthetic-private-value" }));
  expect(alerts()).toHaveLength(1);
  expect(JSON.stringify(alerts()[0]!.children)).not.toContain("synthetic-private-value");
  expect(field("e.g. Work").props.value).toBe("Work API");
  expect(field("meerkat_work").props.value).toBe("meerkat_exact");
  expect(configField().props.value).toBe("/fixture/native-gateway");
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(commands.toast).not.toHaveBeenCalled();
  await act(async () => button("Retry adding instance").props.onClick());
  expect(commands.update.mock.calls[1]?.[0]).toEqual(commands.update.mock.calls[0]?.[0]);
  expect(onOpenChange).not.toHaveBeenCalled();
  await act(async () => retry.resolve(successfulSave));
  expect(alerts()).toHaveLength(0);
  expect(commands.toast).toHaveBeenCalledTimes(1);
  expect(commands.toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "success", title: "Provider instance added" }),
  );
  expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
});

it("blocks duplicate submissions, dismissal and backward navigation while the command is pending", async () => {
  const request = deferred<unknown>();
  commands.update.mockReturnValueOnce(request.promise);
  await render();
  await fill();
  const submit = button("Add instance").props.onClick;
  const back = button("Back").props.onClick;
  const cancel = vi.fn();
  await act(async () => {
    submit();
    submit();
    back();
  });
  await act(async () => renderer!.root.findByType(Dialog).props.onOpenChange(false, { cancel }));
  await act(async () => button("Driver").props.onClick());
  expect(commands.update).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(button("Adding instance...")).toBeDefined();
  await act(async () => request.resolve({ _tag: "Failure" }));
  await act(async () => renderer!.root.findByType(Dialog).props.onOpenChange(false, { cancel }));
  expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
});

it("does not let an old environment's save close or report success in the new environment", async () => {
  const original = deferred<unknown>();
  commands.update.mockReturnValueOnce(original.promise);
  await render(localId);
  await fill();
  await act(async () => button("Add instance").props.onClick());
  await render(remoteId);
  expect(field("e.g. Work").props.value).toBe("");
  await act(async () => original.resolve(successfulSave));
  expect(commands.toast).not.toHaveBeenCalled();
  expect(onOpenChange).not.toHaveBeenCalled();
  await fill();
  await act(async () => button("Add instance").props.onClick());
  expect(commands.update.mock.calls.map(([input]) => input.environmentId)).toEqual([
    localId,
    remoteId,
  ]);
  expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
});

it("keeps entries after a rejected command and retries only the same add intent", async () => {
  commands.update.mockRejectedValueOnce(new Error("synthetic-private-value"));
  await render();
  await fill();
  await act(async () => button("Add instance").props.onClick());
  expect(alerts()).toHaveLength(1);
  expect(JSON.stringify(alerts()[0]!.children)).not.toContain("synthetic-private-value");
  settings[localId]!.providerInstances.later = {
    driver: ProviderDriverKind.make("codex"),
    enabled: false,
  };
  await render();
  await act(async () => button("Retry adding instance").props.onClick());
  expect(commands.update.mock.calls[1]?.[0]).toEqual(commands.update.mock.calls[0]?.[0]);
  expect(commands.update.mock.calls[1]?.[0].input).toEqual({
    kind: "add",
    instanceId: "meerkat_exact",
    instance: {
      driver: "meerkat",
      enabled: true,
      displayName: "Work API",
      accentColor: "#16a34a",
      config: { binaryPath: "/fixture/native-gateway" },
    },
  });
  expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
});

it("ignores a completion after the dialog's parent unmounts", async () => {
  const request = deferred<unknown>();
  commands.update.mockReturnValueOnce(request.promise);
  await render();
  await fill();
  await act(async () => button("Add instance").props.onClick());
  await act(async () => renderer!.unmount());
  renderer = undefined;
  await act(async () => request.resolve(successfulSave));
  expect(commands.toast).not.toHaveBeenCalled();
  expect(onOpenChange).not.toHaveBeenCalled();
});

it("allows an untouched dialog to be cancelled without issuing a settings command", async () => {
  await render();
  await act(async () => button("Cancel").props.onClick());
  expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  expect(commands.update).not.toHaveBeenCalled();
});

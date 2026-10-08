import type { ProviderInstanceEnvironmentVariable } from "@t3tools/contracts";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    title,
    description,
    control,
    children,
  }: {
    title: ReactNode;
    description: ReactNode;
    control: ReactNode;
    children: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      <p>{description}</p>
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
// Exercise the real blur-to-save behavior, including an untouched redacted input.
vi.mock("../ui/input", () => ({
  Input: ({
    font: _font,
    size: _size,
    ...props
  }: Omit<ComponentProps<"input">, "size"> & {
    font?: string;
    size?: string;
  }) => <input {...props} />,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));

import { ProviderEnvironmentSection } from "./ProviderInstanceCard";

let renderer: ReactTestRenderer | undefined;
const save = vi.fn();
const stored: ProviderInstanceEnvironmentVariable = {
  name: "ANTHROPIC_API_KEY",
  value: "",
  sensitive: true,
  valueRedacted: true,
};
async function render(
  environment: readonly ProviderInstanceEnvironmentVariable[] = [],
  nativeCredentials = true,
) {
  await act(async () => {
    renderer = create(
      <ProviderEnvironmentSection
        environment={environment}
        onChange={save}
        nativeCredentials={nativeCredentials}
      />,
    );
  });
}
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((node) => node.children.includes(label))!;
const field = (label: string) =>
  renderer!.root.findAllByType("input").find((node) => node.props["aria-label"] === label)!;
const toggle = (name: string) =>
  renderer!.root
    .findAllByType("button")
    .find((node) => node.props["aria-label"] === `Mark environment variable ${name} as sensitive`);
const remove = (name: string) =>
  renderer!.root
    .findAllByType("button")
    .find((node) => node.props["aria-label"] === `Remove environment variable ${name}`)!;
async function edit(label: string, value: string) {
  await act(async () => field(label).props.onFocus());
  await act(async () => field(label).props.onChange({ target: { value } }));
  await act(async () => field(label).props.onBlur());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  save.mockReset();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("adds a masked native key through the existing environment writer without replacing other secrets", async () => {
  await render([stored, { name: "EXTRA_CONFIG", value: "retained", sensitive: false }]);
  expect(button("Anthropic").props.disabled).toBe(true);
  await act(async () => button("OpenAI").props.onClick());
  expect(save).not.toHaveBeenCalled();
  expect(field("OpenAI API key").props.type).toBe("password");
  expect(field("Anthropic API key").props.value).toBe("");
  expect(field("Anthropic API key").props.placeholder).toContain("Stored secret");
  await edit("OpenAI API key", "test-key");
  expect(save).toHaveBeenLastCalledWith([
    stored,
    { name: "EXTRA_CONFIG", value: "retained", sensitive: false },
    { name: "OPENAI_API_KEY", value: "test-key", sensitive: true, valueRedacted: false },
  ]);
});

it.each([
  ["ANTHROPIC_API_KEY", "Anthropic API key"],
  ["OPENAI_API_KEY", "OpenAI API key"],
  ["GEMINI_API_KEY", "Gemini API key"],
  ["RKAT_AZURE_OPENAI_API_KEY", "Preferred Azure API key"],
  ["AZURE_OPENAI_API_KEY", "Azure API key (fallback)"],
])("keeps stored %s protected until explicit replacement or removal", async (name, label) => {
  const original = { ...stored, name };
  const other = { name: "EXTRA_CONFIG", value: "retained", sensitive: false };
  await render([original, other]);
  expect(toggle(name)).toBeUndefined();
  expect(field(label).props.type).toBe("password");
  await act(async () => field(label).props.onFocus());
  await act(async () => field(label).props.onBlur());
  expect(save).not.toHaveBeenCalled();

  await edit("Environment variable value 2", "updated");
  const updatedOther = { ...other, value: "updated", valueRedacted: false };
  expect(save).toHaveBeenLastCalledWith([original, updatedOther]);
  await edit(label, "replacement-key");
  expect(save).toHaveBeenLastCalledWith([
    { ...original, value: "replacement-key", valueRedacted: false },
    updatedOther,
  ]);
  expect(toggle(name)).toBeUndefined();
  await act(async () => remove(name).props.onClick());
  expect(save).toHaveBeenLastCalledWith([updatedOther]);
});

it("protects a legacy plaintext API key without erasing it or changing Azure endpoint storage", async () => {
  const key = { name: "OPENAI_API_KEY", value: "legacy-key", sensitive: false };
  const endpoint = {
    name: "RKAT_AZURE_OPENAI_ENDPOINT",
    value: "https://old.example.test",
    sensitive: false,
  };
  await render([key, endpoint]);
  expect(save).not.toHaveBeenCalled();
  expect(field("OpenAI API key").props.type).toBe("password");
  expect(toggle(key.name)).toBeUndefined();
  await edit("Preferred Azure endpoint", "https://new.example.test");
  expect(save).toHaveBeenCalledExactlyOnceWith([
    { ...key, sensitive: true },
    { ...endpoint, value: "https://new.example.test", valueRedacted: false },
  ]);
});

it.each([true, false])(
  "preserves an advanced redacted secret through blocked name and storage changes (native: %s)",
  async (nativeCredentials) => {
    const secret = { ...stored, name: "CUSTOM_TOKEN" };
    const other = { name: "EXTRA_CONFIG", value: "retained", sensitive: false };
    await render([secret, other], nativeCredentials);
    expect(field("Environment variable name 1").props.disabled).toBe(true);
    expect(toggle(secret.name)?.props.disabled).toBe(true);
    // A captured callback must be safe even if it bypasses the disabled control.
    await edit("Environment variable name 1", "RENAMED_TOKEN");
    await act(async () => toggle(secret.name)!.props.onClick());
    expect(save).not.toHaveBeenCalled();
    expect(field("Environment variable name 1").props.value).toBe(secret.name);
    await edit("Environment variable value 2", "updated");
    const updatedOther = { ...other, value: "updated", valueRedacted: false };
    expect(save).toHaveBeenLastCalledWith([secret, updatedOther]);

    await edit("Environment variable value 1", "replacement-token");
    expect(save).toHaveBeenLastCalledWith([
      { ...secret, value: "replacement-token", valueRedacted: false },
      updatedOther,
    ]);
    await edit("Environment variable name 1", "RENAMED_TOKEN");
    await act(async () => toggle("RENAMED_TOKEN")!.props.onClick());
    expect(save).toHaveBeenLastCalledWith([
      { name: "RENAMED_TOKEN", value: "replacement-token", sensitive: false, valueRedacted: false },
      updatedOther,
    ]);
    await act(async () => remove("RENAMED_TOKEN").props.onClick());
    expect(save).toHaveBeenLastCalledWith([updatedOther]);
  },
);

it("keeps ordinary plaintext variables editable, including renaming and storage choice", async () => {
  const variable = { name: "CUSTOM_ENDPOINT", value: "https://old.example.test", sensitive: false };
  await render([variable], false);
  await edit("Environment variable name 1", "OTHER_ENDPOINT");
  expect(save).toHaveBeenLastCalledWith([{ ...variable, name: "OTHER_ENDPOINT" }]);
  await edit("Environment variable value 1", "https://new.example.test");
  await act(async () => toggle("OTHER_ENDPOINT")!.props.onClick());
  expect(save).toHaveBeenLastCalledWith([
    {
      name: "OTHER_ENDPOINT",
      value: "https://new.example.test",
      sensitive: true,
      valueRedacted: false,
    },
  ]);
  await act(async () => toggle("OTHER_ENDPOINT")!.props.onClick());
  expect(save).toHaveBeenLastCalledWith([
    {
      name: "OTHER_ENDPOINT",
      value: "https://new.example.test",
      sensitive: false,
      valueRedacted: false,
    },
  ]);
  await act(async () => remove("OTHER_ENDPOINT").props.onClick());
  expect(save).toHaveBeenLastCalledWith([]);
});

it("offers explicit Azure preference while preserving an already configured preferred endpoint", async () => {
  const endpoint = {
    name: "RKAT_AZURE_OPENAI_ENDPOINT",
    value: "https://example.test",
    sensitive: false,
  };
  await render([endpoint]);
  await act(async () => button("Prefer Azure OpenAI").props.onClick());
  expect(field("Preferred Azure endpoint").props.value).toBe(endpoint.value);
  expect(field("Preferred Azure API key").props.type).toBe("password");
  await edit("Preferred Azure API key", "azure-test-key");
  expect(save).toHaveBeenLastCalledWith([
    endpoint,
    {
      name: "RKAT_AZURE_OPENAI_API_KEY",
      value: "azure-test-key",
      sensitive: true,
      valueRedacted: false,
    },
  ]);
  expect(button("Prefer Azure OpenAI").props.disabled).toBe(true);
});

it("publishes partial Azure preferences with their retained fallbacks and leaves reversal explicit", async () => {
  const publicKey = { ...stored, name: "OPENAI_API_KEY" };
  const publicOverride = { ...stored, name: "RKAT_OPENAI_API_KEY" };
  const azureKey = { ...stored, name: "AZURE_OPENAI_API_KEY" };
  const azureEndpoint = {
    name: "AZURE_OPENAI_ENDPOINT",
    value: "https://old.example.test",
    sensitive: false,
  };
  const original = [publicKey, publicOverride, azureEndpoint, azureKey];
  await render(original);
  expect(
    renderer!.root
      .findAllByType("p")
      .some((node) =>
        node.children.some(
          (child) => typeof child === "string" && child.includes("Fields save separately"),
        ),
      ),
  ).toBe(true);
  await act(async () => button("Prefer Azure OpenAI").props.onClick());
  expect(save).not.toHaveBeenCalled();
  expect(field("Azure endpoint (fallback)").props.value).toBe(azureEndpoint.value);
  expect(field("Preferred Azure endpoint").props.value).toBe("");
  expect(field("Preferred Azure API key").props.value).toBe("");
  await edit("Preferred Azure endpoint", "https://preferred.example.test");
  // This immediately enables native Azure preference with the retained fallback key.
  expect(save).toHaveBeenCalledExactlyOnceWith([
    ...original,
    {
      name: "RKAT_AZURE_OPENAI_ENDPOINT",
      value: "https://preferred.example.test",
      sensitive: false,
      valueRedacted: false,
    },
    { name: "RKAT_AZURE_OPENAI_API_KEY", value: "", sensitive: true },
  ]);
  await edit("Preferred Azure API key", "preferred-azure-test-key");
  expect(save).toHaveBeenLastCalledWith([
    ...original,
    {
      name: "RKAT_AZURE_OPENAI_ENDPOINT",
      value: "https://preferred.example.test",
      sensitive: false,
      valueRedacted: false,
    },
    {
      name: "RKAT_AZURE_OPENAI_API_KEY",
      value: "preferred-azure-test-key",
      sensitive: true,
      valueRedacted: false,
    },
  ]);
  await act(async () => remove("RKAT_AZURE_OPENAI_ENDPOINT").props.onClick());
  // Removing only the endpoint retains preference through the key and old endpoint.
  expect(save).toHaveBeenLastCalledWith([
    ...original,
    {
      name: "RKAT_AZURE_OPENAI_API_KEY",
      value: "preferred-azure-test-key",
      sensitive: true,
      valueRedacted: false,
    },
  ]);
  await act(async () => remove("RKAT_AZURE_OPENAI_API_KEY").props.onClick());
  expect(save).toHaveBeenLastCalledWith(original);
});

it("keeps arbitrary provider variables editable through the existing advanced path", async () => {
  await render([stored]);
  await act(async () => button("Advanced variable").props.onClick());
  await edit("Environment variable name 2", "CUSTOM_ENDPOINT");
  await edit("Environment variable value 2", "https://custom.test");
  expect(save).toHaveBeenLastCalledWith([
    stored,
    {
      name: "CUSTOM_ENDPOINT",
      value: "https://custom.test",
      sensitive: true,
      valueRedacted: false,
    },
  ]);
});

it("retains the donor's generic environment editor", async () => {
  await render([], false);
  expect(button("Add variable")).toBeDefined();
  expect(button("OpenAI")).toBeUndefined();
  await act(async () => button("Add variable").props.onClick());
  expect(field("Environment variable name 1")).toBeDefined();
});

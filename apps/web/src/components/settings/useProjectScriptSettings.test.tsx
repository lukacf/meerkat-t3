import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { NewProjectScriptInput } from "../projectScriptEditor";

const state = vi.hoisted(() => ({
  update: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
  toast: vi.fn(),
  projects: [] as Array<{
    environmentId: EnvironmentId;
    id: ProjectId;
    scripts: readonly ProjectScript[];
  }>,
}));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    updateSettings: "update",
    upsertKeybinding: "upsert",
    removeKeybinding: "remove",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (key: "update" | "upsert" | "remove") => state[key],
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
import { useProjectScriptSettings } from "./useProjectScriptSettings";

const environmentId = EnvironmentId.make("remote");
const projectId = ProjectId.make("project");
const otherProjectId = ProjectId.make("other");
const script: ProjectScript = {
  id: "inspect",
  name: "Inspect",
  command: "pwd",
  icon: "play",
  runOnWorktreeCreate: false,
};
const input: NewProjectScriptInput = {
  name: "Inspect",
  command: "pwd",
  icon: "play",
  runOnWorktreeCreate: false,
  waitForSetup: false,
  previewUrl: null,
  autoOpenPreview: false,
  keybinding: "mod+alt+9",
};
const bindings = compileResolvedKeybindingsConfig([
  { key: "mod+alt+8", command: "script.inspect.run" },
]);
type Targets = Parameters<typeof useProjectScriptSettings>[0];
let renderer: ReactTestRenderer | undefined;
let actions: ReturnType<typeof useProjectScriptSettings>;

function Target({ targets }: { targets: Targets }) {
  const value = useProjectScriptSettings(targets);
  useLayoutEffect(() => {
    actions = value;
  }, [value]);
  return null;
}

async function mount(
  settings: ServerSettings = DEFAULT_SERVER_SETTINGS,
  keybindings: ResolvedKeybindingsConfig = [],
) {
  await act(async () => {
    renderer = create(
      <Target
        targets={[
          { environmentId, project: { id: projectId, scripts: [] }, settings, keybindings },
        ]}
      />,
    );
  });
}

function withScript(extra: Partial<ServerSettings> = {}): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    ...extra,
    projectSettingsOverrides: {
      [projectId]: { defaultProjectScripts: [script] },
      ...extra.projectSettingsOverrides,
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.projects = [];
  state.toast.mockReset();
  [state.update, state.upsert, state.remove].forEach((command) => {
    command.mockReset();
    command.mockResolvedValue(AsyncResult.success(undefined));
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("persists a new shortcut on web in the action's environment after the action save", async () => {
  await mount();
  await act(async () => {
    const result = await actions.submit(null, input);
    expect(result._tag).toBe("Success");
  });
  expect(state.update).toHaveBeenCalledWith({
    environmentId,
    input: {
      patch: {
        projectSettingsOverrides: { [projectId]: { defaultProjectScripts: [script] } },
      },
    },
  });
  expect(state.upsert).toHaveBeenCalledWith({
    environmentId,
    input: { key: "mod+alt+9", command: "script.inspect.run" },
  });
  expect(state.update.mock.invocationCallOrder[0]).toBeLessThan(
    state.upsert.mock.invocationCallOrder[0]!,
  );
  expect(state.remove).not.toHaveBeenCalled();
});

it("replaces an existing shortcut on web", async () => {
  await mount(withScript(), bindings);
  await act(async () => {
    await actions.submit("inspect", input);
  });
  expect(state.upsert).toHaveBeenCalledWith({
    environmentId,
    input: {
      key: "mod+alt+9",
      command: "script.inspect.run",
      replace: { key: "mod+alt+8", command: "script.inspect.run" },
    },
  });
  expect(state.remove).not.toHaveBeenCalled();
});

it("removes an existing shortcut on web when explicitly cleared", async () => {
  await mount(withScript(), bindings);
  await act(async () => {
    await actions.submit("inspect", { ...input, keybinding: null });
  });
  expect(state.remove).toHaveBeenCalledWith({
    environmentId,
    input: { key: "mod+alt+8", command: "script.inspect.run" },
  });
  expect(state.upsert).not.toHaveBeenCalled();
});

it.each(["update", "upsert", "remove"] as const)(
  "propagates %s failures instead of reporting success",
  async (command) => {
    state[command].mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error(`${command} failed`))),
    );
    await mount(withScript(), bindings);
    await act(async () => {
      const result = await actions.submit("inspect", {
        ...input,
        keybinding: command === "remove" ? null : input.keybinding,
      });
      expect(result._tag).toBe("Failure");
    });
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Failed to save project actions",
        description: `${command} failed`,
      }),
    );
    expect(actions.saving).toBe(false);
    if (command === "update") expect(state.upsert).not.toHaveBeenCalled();
  },
);

it.each(["defaults", "project override", "legacy project"] as const)(
  "retains a deleted action's shortcut used by %s in the same environment",
  async (owner) => {
    if (owner === "legacy project") {
      state.projects = [{ environmentId, id: otherProjectId, scripts: [script] }];
    }
    await mount(
      withScript({
        ...(owner === "defaults" ? { defaultProjectScripts: [script] } : {}),
        ...(owner === "project override"
          ? {
              projectSettingsOverrides: {
                [otherProjectId]: { defaultProjectScripts: [script] },
              },
            }
          : {}),
        ...(owner === "legacy project" ? { projectSettingsFolded: false } : {}),
      }),
      bindings,
    );
    await act(async () => {
      const result = await actions.persist(() => [], "inspect");
      expect(result._tag).toBe("Success");
    });
    expect(state.remove).not.toHaveBeenCalled();
  },
);

it("removes the shortcut when only another environment retains the action", async () => {
  state.projects = [
    { environmentId: EnvironmentId.make("elsewhere"), id: otherProjectId, scripts: [script] },
  ];
  await mount(withScript({ projectSettingsFolded: false }), bindings);
  await act(async () => {
    await actions.persist(() => [], "inspect");
  });
  expect(state.remove).toHaveBeenCalledWith({
    environmentId,
    input: { key: "mod+alt+8", command: "script.inspect.run" },
  });
});

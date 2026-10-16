import {
  EnvironmentId,
  ProjectId,
  type ProjectCloneStartInput,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({ create: vi.fn(), clone: vi.fn(), legacyClone: vi.fn() }));
const state = vi.hoisted(() => ({
  projects: [] as EnvironmentProject[],
  newProjectId: vi.fn<() => ProjectId>(),
  browse: vi.fn(),
}));
const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const projectId = ProjectId.make("created-project");
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [local, remote].map((environmentId) => ({
      environmentId,
      label: environmentId,
      connection: { phase: "connected" },
      serverConfig: {
        cwd: "/home/me",
        environment: { capabilities: { projectCloneTracking: true } },
      },
    })),
  }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => state.projects,
  readProject: (ref: ScopedProjectRef) =>
    state.projects.find(
      (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
    ) ?? null,
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { create: "create" } }));
vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: {
    startProjectClone: "clone",
    cloneRepository: "legacyClone",
    discovery: () => ({}),
  },
}));
vi.mock("../../state/filesystem", () => ({ filesystemEnvironment: { browse: "browse" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: keyof typeof commands) => commands[command],
}));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.browse }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      versionControlSystems: [{ kind: "git", status: "available" }],
      sourceControlProviders: [],
    },
    isPending: false,
  }),
}));
vi.mock("../../lib/utils", () => ({ newProjectId: state.newProjectId }));
vi.mock("../ui/button", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
}));
vi.mock("../ui/input", () => ({ Input: (props: ComponentProps<"input">) => <input {...props} /> }));
vi.mock("./OnboardingProjectReadiness", () => ({
  OnboardingProjectReadiness: ({
    onBack,
    onContinue,
  }: ComponentProps<typeof import("./OnboardingProjectReadiness").OnboardingProjectReadiness>) => (
    <div>
      <p>Review project</p>
      <button onClick={onBack}>Back to project</button>
      <button onClick={onContinue}>Continue to project agents</button>
    </div>
  ),
}));

import { OnboardingProjectStep } from "./OnboardingProjectStep";
import { createOnboardingProjectDraftStore } from "../../onboarding/projectDraftStore";

const clonedProject = (id: ProjectId, environmentId = local): EnvironmentProject => ({
  id,
  environmentId,
  title: "repo",
  workspaceRoot: "/home/me/repo",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-05T00:00:00.000Z",
  updatedAt: "2026-10-05T00:00:00.000Z",
});
const cloneSuccess = (input: ProjectCloneStartInput) => ({
  _tag: "Success" as const,
  value: {
    projectId: input.projectId,
    cwd: input.destinationPath,
    remoteUrl: input.remoteUrl ?? "",
    repository: null,
  },
});

let renderer: ReactTestRenderer | undefined;
let saved: Map<string, string>;
const review = vi.fn();
const openProject = vi.fn();
const pending = vi.fn();
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((node) => node.children.includes(label))!;
const inputs = () => renderer!.root.findAllByType("input");
async function render({
  environmentIds = [local, remote],
  initialProjectRef = null,
}: Partial<
  Pick<ComponentProps<typeof OnboardingProjectStep>, "environmentIds" | "initialProjectRef">
> = {}) {
  await act(async () => {
    renderer = create(
      <OnboardingProjectStep
        environmentIds={environmentIds}
        initialProjectRef={initialProjectRef}
        onProject={openProject}
        onReviewProject={review}
        onImport={vi.fn()}
        onPendingChange={pending}
      />,
    );
  });
}
async function reload() {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  await render();
}
async function click(label: string) {
  expect(button(label)).toBeDefined();
  await act(async () => button(label).props.onClick());
}
async function changeInput(index: number, value: string) {
  await act(async () => inputs()[index]!.props.onChange({ target: { value } }));
}
async function changeEnvironment(value: EnvironmentId) {
  await act(async () => renderer!.root.findByType("select").props.onChange({ target: { value } }));
}
async function submit() {
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
}
beforeEach(() => {
  state.projects = [];
  state.newProjectId.mockReset().mockReturnValue(projectId);
  state.browse.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { parentPath: "/home/me", entries: [] },
  });
  saved = new Map();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
    removeItem: (key: string) => void saved.delete(key),
  });
  for (const command of Object.values(commands))
    command.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  commands.clone.mockImplementation(async ({ input }: { input: ProjectCloneStartInput }) =>
    cloneSuccess(input),
  );
  review.mockReset().mockResolvedValue(true);
  openProject.mockReset().mockResolvedValue(true);
  pending.mockReset();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("ignores a saved project on a deselected computer and uses the selected computer's draft", async () => {
  const staleProjectId = ProjectId.make("previous-computer-project");
  state.projects = [clonedProject(staleProjectId, local)];
  const drafts = createOnboardingProjectDraftStore();
  const localDraft = {
    mode: "clone" as const,
    path: "/local/unfinished",
    remoteUrl: "https://example.invalid/old.git",
    cloneAttempt: {
      projectId: ProjectId.make("unfinished-clone"),
      title: "unfinished",
      createdAt: "2026-10-05T00:00:00.000Z",
      destinationPath: "/local/unfinished",
      remoteUrl: "https://example.invalid/old.git",
    },
  };
  drafts.write(local, localDraft);
  drafts.write(remote, { mode: "create", path: "/remote/new-project", remoteUrl: "" });
  drafts.selectEnvironment(local);
  await render({
    environmentIds: [remote],
    initialProjectRef: { environmentId: local, projectId: staleProjectId },
  });

  expect(inputs()[0]!.props.value).toBe("/remote/new-project");
  expect(renderer!.root.findAllByType("select")).toHaveLength(0);
  await click("Browse");
  expect(state.browse).toHaveBeenCalledWith(expect.objectContaining({ environmentId: remote }));
  await submit();
  expect(commands.create).toHaveBeenCalledExactlyOnceWith({
    environmentId: remote,
    input: expect.objectContaining({
      projectId,
      workspaceRoot: "/remote/new-project",
      createWorkspaceRootIfMissing: true,
    }),
  });
  expect(review).toHaveBeenCalledExactlyOnceWith({ environmentId: remote, projectId });
  expect(createOnboardingProjectDraftStore().read(local).draft).toEqual(localDraft);
  expect(state.projects).toEqual([clonedProject(staleProjectId, local)]);
  expect(commands.clone).not.toHaveBeenCalled();
  expect(openProject).not.toHaveBeenCalled();
});

it("resumes the reviewed project when its computer is still selected without changing drafts", async () => {
  state.projects = [clonedProject(projectId, local)];
  const drafts = createOnboardingProjectDraftStore();
  drafts.write(local, { mode: "open", path: "/local/unfinished", remoteUrl: "" });
  drafts.write(remote, { mode: "create", path: "/remote/unfinished", remoteUrl: "" });
  drafts.selectEnvironment(remote);
  const before = [...saved];
  await render({ initialProjectRef: { environmentId: local, projectId } });
  await click("Continue to project agents");

  expect(openProject).toHaveBeenCalledExactlyOnceWith({ environmentId: local, projectId });
  expect([...saved]).toEqual(before);
  expect(commands.create).not.toHaveBeenCalled();
  expect(commands.clone).not.toHaveBeenCalled();
  expect(review).not.toHaveBeenCalled();
});

it("restores a clone draft after reload and starts it only on explicit submission", async () => {
  await render();
  await click("Clone repository");
  await changeInput(0, "https://github.com/owner/repo.git");
  await changeInput(1, "/home/me/repo");
  await reload();
  expect(inputs().map((input) => input.props.value)).toEqual([
    "https://github.com/owner/repo.git",
    "/home/me/repo",
  ]);
  expect(commands.clone).not.toHaveBeenCalled();
  expect(commands.legacyClone).not.toHaveBeenCalled();
  expect(commands.create).not.toHaveBeenCalled();
  expect(review).not.toHaveBeenCalled();

  await submit();
  expect(commands.clone).toHaveBeenCalledExactlyOnceWith({
    environmentId: local,
    input: {
      projectId,
      title: "repo",
      createdAt: expect.any(String),
      remoteUrl: "https://github.com/owner/repo.git",
      destinationPath: "/home/me/repo",
    },
  });
  expect(review).toHaveBeenCalledExactlyOnceWith({ environmentId: local, projectId });
  await reload();
  expect(inputs().map((input) => input.props.value)).toEqual([""]);
  expect(commands.clone).toHaveBeenCalledTimes(1);
});

it("keeps folder and mode drafts separate when switching computers and discards only the selected draft", async () => {
  await render();
  await click("Create project");
  await changeInput(0, "/local/new-project");
  await changeEnvironment(remote);
  expect(inputs()[0]!.props.value).toBe("");
  await changeInput(0, "/remote/existing-project");
  await reload();
  expect(renderer!.root.findByType("select").props.value).toBe(remote);
  expect(inputs()[0]!.props.value).toBe("/remote/existing-project");
  await click("Discard draft");
  await reload();
  expect(inputs()[0]!.props.value).toBe("");
  await changeEnvironment(local);
  expect(inputs()[0]!.props.value).toBe("/local/new-project");
  expect(button("Create project").props["aria-pressed"]).toBe(true);
  expect(commands.create).not.toHaveBeenCalled();
});

it("keeps credentials in the open form but restores only the safe destination and mode", async () => {
  await render();
  await click("Clone repository");
  await changeInput(0, "https://user:secret@github.com/owner/repo.git");
  await changeInput(1, "/private/repo");
  expect(inputs()[0]!.props.value).toContain("secret");
  expect([...saved.values()].join(" ")).not.toContain("secret");
  await reload();
  expect(inputs().map((input) => input.props.value)).toEqual(["", "/private/repo"]);
  expect(button("Clone repository").props["aria-pressed"]).toBe(true);
  expect(commands.clone).not.toHaveBeenCalled();
});

it("retries an admitted clone's setup handoff after reload and switching computers without cloning again", async () => {
  review.mockResolvedValueOnce(false);
  await render();
  await click("Clone repository");
  await changeInput(0, "https://user:secret@github.com/owner/repo.git");
  await changeInput(1, "/home/me/repo");
  await submit();
  expect(commands.clone).toHaveBeenCalledTimes(1);
  expect(button("Continue setup")).toBeDefined();
  expect([...saved.values()].join(" ")).not.toContain("secret");

  await reload();
  await changeEnvironment(remote);
  await changeEnvironment(local);
  expect(inputs().map((input) => input.props.value)).toEqual(["", "/home/me/repo"]);
  expect(inputs()[0]!.props.required).toBe(false);
  expect(button("Continue setup").props.disabled).toBe(false);
  expect(commands.clone).toHaveBeenCalledTimes(1);
  expect(review).toHaveBeenCalledTimes(1);
  await click("Clone repository");
  await changeInput(1, "/home/me/repo");
  expect(button("Continue setup")).toBeDefined();
  await submit();
  expect(commands.clone).toHaveBeenCalledTimes(1);
  expect(commands.create).not.toHaveBeenCalled();
  expect(review.mock.calls).toEqual([
    [{ environmentId: local, projectId }],
    [{ environmentId: local, projectId }],
  ]);
  await reload();
  expect(inputs().map((input) => input.props.value)).toEqual([""]);
});

it("keeps admitted identity visible when draft cleanup fails and never revives a clone request", async () => {
  await render();
  await click("Clone repository");
  await changeInput(0, "https://github.com/owner/repo.git");
  await changeInput(1, "/home/me/repo");
  const removal = vi
    .spyOn(globalThis.localStorage, "removeItem")
    .mockImplementation(() => undefined);
  await submit();
  expect(JSON.stringify(renderer!.toJSON())).toContain("could not be discarded");
  expect(button("Retry discarding draft")).toBeDefined();
  await click("Back to project");
  await changeEnvironment(remote);
  await changeEnvironment(local);
  expect(JSON.stringify(renderer!.toJSON())).toContain("could not be discarded");
  expect(button("Continue setup")).toBeDefined();
  await reload();
  expect(button("Continue setup")).toBeDefined();
  expect(commands.clone).toHaveBeenCalledTimes(1);
  removal.mockRestore();
  await submit();
  expect(commands.clone).toHaveBeenCalledTimes(1);
  expect(review.mock.calls).toEqual([
    [{ environmentId: local, projectId }],
    [{ environmentId: local, projectId }],
  ]);
  expect(button("Retry discarding draft")).toBeUndefined();
});

it("clears an admitted handoff when the destination is explicitly changed", async () => {
  review.mockResolvedValueOnce(false);
  await render();
  await click("Clone repository");
  await changeInput(0, "https://github.com/owner/repo.git");
  await changeInput(1, "/home/me/repo");
  await submit();
  await changeInput(1, "/home/me/another-copy");
  await reload();
  expect(button("Continue setup")).toBeUndefined();
  expect(commands.clone).toHaveBeenCalledTimes(1);
  await submit();
  expect(commands.clone).toHaveBeenCalledTimes(2);
  expect(commands.clone.mock.calls[1]![0].input.destinationPath).toBe("/home/me/another-copy");
});

it("discards an admitted handoff without repeating or undoing the accepted clone", async () => {
  review.mockResolvedValueOnce(false);
  await render();
  await click("Clone repository");
  await changeInput(0, "https://github.com/owner/repo.git");
  await changeInput(1, "/home/me/repo");
  await submit();
  await click("Discard draft");
  await reload();
  expect(button("Continue setup")).toBeUndefined();
  expect(inputs().map((input) => input.props.value)).toEqual([""]);
  expect(commands.clone).toHaveBeenCalledTimes(1);
  expect(commands.create).not.toHaveBeenCalled();
  expect(review).toHaveBeenCalledTimes(1);
});

it("retains live edits and reports when this device cannot save or discard them", async () => {
  await render();
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new Error("Storage blocked");
    },
    removeItem: () => {
      throw new Error("Storage blocked");
    },
  });
  await changeInput(0, "/unsaved/repo");
  expect(inputs()[0]!.props.value).toBe("/unsaved/repo");
  expect(JSON.stringify(renderer!.toJSON())).toContain("only in this view");
  await changeEnvironment(remote);
  await changeEnvironment(local);
  expect(inputs()[0]!.props.value).toBe("/unsaved/repo");
  expect(JSON.stringify(renderer!.toJSON())).toContain("only in this view");
  await click("Discard draft");
  expect(inputs()[0]!.props.value).toBe("/unsaved/repo");
  expect(JSON.stringify(renderer!.toJSON())).toContain("could not be discarded");
  expect(commands.create).not.toHaveBeenCalled();
});

it("retries a failed initial read without overwriting or resubmitting the saved clone", async () => {
  const attemptId = ProjectId.make("saved-clone");
  const attempt = {
    projectId: attemptId,
    title: "repo",
    createdAt: "2026-10-05T00:00:00.000Z",
    destinationPath: "/home/me/repo",
    remoteUrl: "https://github.com/owner/repo.git",
  };
  createOnboardingProjectDraftStore().write(local, {
    mode: "clone",
    path: attempt.destinationPath,
    remoteUrl: attempt.remoteUrl,
    cloneAttempt: attempt,
  });
  const before = [...saved];
  state.projects = [clonedProject(attemptId), clonedProject(projectId)];
  let failRead = true;
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => {
      if (key.endsWith(JSON.stringify(local)) && failRead)
        throw new Error("Storage temporarily unavailable");
      return saved.get(key) ?? null;
    },
    setItem: (key: string, value: string) => void saved.set(key, value),
    removeItem: (key: string) => void saved.delete(key),
  });
  await render();
  expect(button("Retry reading draft")).toBeDefined();
  expect(button("Clone repository").props.disabled).toBe(true);
  expect(inputs()[0]!.props.disabled).toBe(true);

  // Even stale/programmatic handlers must not replace unknown durable input.
  failRead = false;
  await click("Clone repository");
  await changeInput(0, "/replacement");
  await click("Browse");
  await click("repo");
  await submit();
  expect([...saved]).toEqual(before);
  expect(state.browse).not.toHaveBeenCalled();
  expect(state.newProjectId).not.toHaveBeenCalled();
  expect(commands.clone).not.toHaveBeenCalled();
  expect(commands.create).not.toHaveBeenCalled();
  expect(review).not.toHaveBeenCalled();

  await click("Retry reading draft");
  expect(inputs().map((input) => input.props.value)).toEqual([
    attempt.remoteUrl,
    attempt.destinationPath,
  ]);
  expect([...saved]).toEqual(before);
  await submit();
  expect(review).toHaveBeenCalledExactlyOnceWith({ environmentId: local, projectId: attemptId });
  expect(commands.clone).not.toHaveBeenCalled();
  expect(commands.create).not.toHaveBeenCalled();
});

it("keeps unread recovery blocked after failed retry or discard, including a saved project selection", async () => {
  const key = `t3code:onboarding-project-draft:v1:${JSON.stringify(local)}`;
  saved.set(key, "unreadable draft");
  state.projects = [clonedProject(projectId)];
  let allowDiscard = false;
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
    removeItem: (key: string) => {
      if (allowDiscard) saved.delete(key);
    },
  });
  await render({ initialProjectRef: { environmentId: local, projectId } });
  expect(button("Continue to project agents")).toBeUndefined();
  await click("Retry reading draft");
  expect(button("Retry reading draft")).toBeDefined();
  await click("Discard draft");
  await changeInput(0, "/replacement");
  await submit();
  expect(saved.get(key)).toBe("unreadable draft");
  expect(commands.create).not.toHaveBeenCalled();
  expect(review).not.toHaveBeenCalled();
  expect(openProject).not.toHaveBeenCalled();

  allowDiscard = true;
  await click("Discard draft");
  expect(saved.has(key)).toBe(false);
  expect(button("Retry reading draft")).toBeUndefined();
  await click("Continue to project agents");
  expect(openProject).toHaveBeenCalledExactlyOnceWith({ environmentId: local, projectId });
});

it("keeps read recovery scoped to its computer while another computer's draft stays editable", async () => {
  const key = `t3code:onboarding-project-draft:v1:${JSON.stringify(local)}`;
  saved.set(key, "unreadable draft");
  await render();
  await changeEnvironment(remote);
  expect(button("Retry reading draft")).toBeUndefined();
  await changeInput(0, "/remote/new-project");
  await changeEnvironment(local);
  expect(button("Retry reading draft")).toBeDefined();
  expect(saved.get(key)).toBe("unreadable draft");
  expect(createOnboardingProjectDraftStore().read(remote).draft.path).toBe("/remote/new-project");
  expect(commands.create).not.toHaveBeenCalled();
  expect(commands.clone).not.toHaveBeenCalled();
});

it("recovers the exact cloned project after a lost reply and reload without starting another clone", async () => {
  let completeClone!: (value: ReturnType<typeof cloneSuccess>) => void;
  commands.clone.mockImplementationOnce(({ input }: { input: ProjectCloneStartInput }) => {
    const durable = createOnboardingProjectDraftStore().read(local).draft;
    expect(durable.cloneAttempt).toEqual(input);
    expect(durable.admittedProjectId).toBeUndefined();
    return new Promise<ReturnType<typeof cloneSuccess>>((resolve) => {
      completeClone = resolve;
    });
  });
  await render();
  await click("Clone repository");
  await changeInput(0, "https://github.com/owner/repo.git");
  await changeInput(1, "/home/me/repo");
  expect(button("Clone and open")).toBeDefined();
  await submit();
  const original = commands.clone.mock.calls[0]![0].input as ProjectCloneStartInput;
  expect(review).not.toHaveBeenCalled();

  state.projects = [clonedProject(original.projectId)];
  await reload();
  expect(commands.clone).toHaveBeenCalledTimes(1);
  expect(button("Continue setup")).toBeUndefined();
  expect(button("Recover clone")).toBeDefined();
  await submit();
  expect(review).toHaveBeenCalledExactlyOnceWith({
    environmentId: local,
    projectId: original.projectId,
  });
  expect(commands.clone).toHaveBeenCalledTimes(1);
  expect(state.newProjectId).toHaveBeenCalledTimes(1);
  await act(async () => completeClone(cloneSuccess(original)));
  expect(review).toHaveBeenCalledTimes(1);
  expect(createOnboardingProjectDraftStore().read(local).draft.cloneAttempt).toBeUndefined();
});

it("keeps the original attempt recoverable when admission confirmation cannot be persisted", async () => {
  review.mockResolvedValueOnce(false);
  await render();
  await click("Clone repository");
  await changeInput(0, "https://github.com/owner/repo.git");
  await changeInput(1, "/home/me/repo");
  const writing = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation((key, value) => {
    if (value.includes('"admittedProjectId"')) throw new Error("Disk unavailable");
    saved.set(key, value);
  });
  await submit();
  expect(commands.clone).toHaveBeenCalledTimes(1);
  expect(button("Continue setup")).toBeDefined();
  expect(createOnboardingProjectDraftStore().read(local).draft.admittedProjectId).toBeUndefined();
  expect(createOnboardingProjectDraftStore().read(local).draft.cloneAttempt?.projectId).toBe(
    projectId,
  );
  writing.mockRestore();
  state.projects = [clonedProject(projectId)];
  await reload();
  expect(button("Recover clone")).toBeDefined();
  await submit();
  expect(commands.clone).toHaveBeenCalledTimes(1);
  expect(review.mock.calls).toEqual([
    [{ environmentId: local, projectId }],
    [{ environmentId: local, projectId }],
  ]);
});

it("does not allocate a second clone attempt for overlapping submissions", async () => {
  let completeClone!: (value: ReturnType<typeof cloneSuccess>) => void;
  commands.clone.mockImplementationOnce(
    () =>
      new Promise<ReturnType<typeof cloneSuccess>>((resolve) => {
        completeClone = resolve;
      }),
  );
  await render();
  await click("Clone repository");
  await changeInput(0, "https://github.com/owner/repo.git");
  await changeInput(1, "/home/me/repo");
  await act(async () => {
    const onSubmit = renderer!.root.findByType("form").props.onSubmit;
    onSubmit({ preventDefault() {} });
    onSubmit({ preventDefault() {} });
  });
  expect(commands.clone).toHaveBeenCalledTimes(1);
  expect(state.newProjectId).toHaveBeenCalledTimes(1);
  const original = commands.clone.mock.calls[0]![0].input as ProjectCloneStartInput;
  await act(async () => completeClone(cloneSuccess(original)));
  expect(review).toHaveBeenCalledTimes(1);
});

it("retries the immutable clone input after reload instead of retargeting it from form edits", async () => {
  state.newProjectId
    .mockReturnValueOnce(projectId)
    .mockReturnValueOnce(ProjectId.make("another-project"));
  commands.clone.mockRejectedValueOnce(new Error("Reply was lost"));
  await render();
  await click("Clone repository");
  await changeInput(0, "https://github.com/owner/repo.git");
  await changeInput(1, "/home/me/repo");
  await submit();
  const original = commands.clone.mock.calls[0]![0];
  await reload();
  await changeInput(0, "https://github.com/other/changed.git");
  await changeInput(1, "/home/me/changed");
  await click("Create project");
  expect(inputs().map((input) => input.props.value)).toEqual([
    "https://github.com/owner/repo.git",
    "/home/me/repo",
  ]);
  await changeEnvironment(remote);
  await changeInput(0, "/remote/other");
  await changeEnvironment(local);
  await submit();
  expect(commands.clone.mock.calls.map(([input]) => input)).toEqual([original, original]);
  expect(state.newProjectId).toHaveBeenCalledTimes(1);
  expect(review).toHaveBeenCalledExactlyOnceWith({ environmentId: local, projectId });
});

it.each(["throws", "does not retain the write"])(
  "does not dispatch when attempt persistence %s",
  async (failure) => {
    await render();
    await click("Clone repository");
    await changeInput(0, "https://github.com/owner/repo.git");
    await changeInput(1, "/home/me/repo");
    const writing = vi
      .spyOn(globalThis.localStorage, "setItem")
      .mockImplementation((key, value) => {
        if (value.includes('"cloneAttempt"')) {
          if (failure === "throws") throw new Error("Disk unavailable");
          return;
        }
        saved.set(key, value);
      });
    await submit();
    expect(commands.clone).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer!.toJSON())).toContain("only in this view");
    expect(button("Continue setup")).toBeUndefined();
    writing.mockRestore();
    await submit();
    expect(commands.clone).toHaveBeenCalledTimes(1);
    expect(state.newProjectId).toHaveBeenCalledTimes(1);
  },
);

it("recovers a clone with an unsaved private URL only by its exact project identity after reload", async () => {
  commands.clone.mockRejectedValueOnce(new Error("Reply was lost"));
  await render();
  await click("Clone repository");
  await changeInput(0, "https://user:secret@github.com/owner/repo.git");
  await changeInput(1, "/home/me/repo");
  await submit();
  expect([...saved.values()].join(" ")).not.toContain("secret");
  await reload();
  await submit();
  expect(commands.clone).toHaveBeenCalledTimes(1);
  expect(review).not.toHaveBeenCalled();
  expect(JSON.stringify(renderer!.toJSON())).toContain("private URL was not saved");
  state.projects = [clonedProject(projectId)];
  await reload();
  await submit();
  expect(commands.clone).toHaveBeenCalledTimes(1);
  expect(review).toHaveBeenCalledExactlyOnceWith({ environmentId: local, projectId });
});

it("does not adopt another project at the same path and allows a new intent only after explicit discard", async () => {
  const nextId = ProjectId.make("next-project");
  state.newProjectId.mockReturnValueOnce(projectId).mockReturnValueOnce(nextId);
  commands.clone
    .mockRejectedValueOnce(new Error("Reply was lost"))
    .mockRejectedValueOnce(new Error("Still unavailable"));
  await render();
  await click("Clone repository");
  await changeInput(0, "https://github.com/owner/repo.git");
  await changeInput(1, "/home/me/repo");
  await submit();
  state.projects = [
    clonedProject(ProjectId.make("unrelated-project")),
    clonedProject(projectId, remote),
  ];
  await reload();
  await submit();
  expect(review).not.toHaveBeenCalled();
  expect(commands.clone.mock.calls[1]![0].input.projectId).toBe(projectId);
  await click("Discard draft");
  await click("Clone repository");
  await changeInput(0, "https://github.com/owner/another.git");
  await changeInput(1, "/home/me/another");
  await submit();
  expect(commands.clone.mock.calls[2]![0].input).toMatchObject({
    projectId: nextId,
    destinationPath: "/home/me/another",
  });
  expect(review).toHaveBeenCalledExactlyOnceWith({ environmentId: local, projectId: nextId });
});

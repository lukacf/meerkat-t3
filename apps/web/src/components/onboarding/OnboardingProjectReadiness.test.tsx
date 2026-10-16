import { RegistryContext } from "@effect/atom-react";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  ProjectId,
  type GitIdentityResult,
  type ProjectCloneSnapshot,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act, type ComponentProps, type PropsWithChildren } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  identity: vi.fn(),
  config: vi.fn(),
  clones: vi.fn(),
  commands: { update: vi.fn(), init: vi.fn(), retry: vi.fn() },
}));
vi.mock("../../state/git", () => ({
  gitEnvironment: { identity: mocks.identity, updateIdentity: "update" },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: mocks.config },
}));
vi.mock("../../state/vcs", () => ({ vcsEnvironment: { init: "init" } }));
vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: { projectClones: mocks.clones, retryProjectClone: "retry" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: keyof typeof mocks.commands) => mocks.commands[command],
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: PropsWithChildren) => <a>{children}</a>,
}));
vi.mock("../ui/button", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & {
    variant?: string;
    size?: string;
  }) => <button {...props} />,
}));
vi.mock("../ui/input", () => ({ Input: (props: ComponentProps<"input">) => <input {...props} /> }));

import { OnboardingProjectReadiness } from "./OnboardingProjectReadiness";

const project: ScopedProjectRef = {
  environmentId: EnvironmentId.make("clone-readiness"),
  projectId: ProjectId.make("cloned-project"),
};
const cwd = "/owned/cloned-project";
const target = { environmentId: project.environmentId, input: { cwd } };
const author = { name: "Fixture", email: "fixture@example.invalid" };
const missingRepository: GitIdentityResult = {
  repositoryRoot: null,
  ready: false,
  effective: author,
  local: { name: null, email: null },
  global: author,
};
const repository: GitIdentityResult = { ...missingRepository, repositoryRoot: cwd, ready: true };
function clone(phase: ProjectCloneSnapshot["phase"]): ProjectCloneSnapshot {
  return {
    projectId: project.projectId,
    remoteUrl: "https://example.invalid/repo.git",
    destinationPath: cwd,
    repository: null,
    phase,
    stage: "checkout",
    percent: null,
    detail: null,
    error: phase === "failed" ? "The first clone failed." : null,
    startedAt: "2026-10-05T00:00:00.000Z",
    endedAt: phase === "running" ? null : "2026-10-05T00:00:01.000Z",
    sequence: 1,
  };
}
function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<A>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function readRequest() {
  return { ...deferred<GitIdentityResult>(), started: deferred<void>() };
}

let renderer: ReactTestRenderer | undefined;
let registry: AtomRegistry.AtomRegistry;
let clonesAtom: Atom.Writable<AsyncResult.AsyncResult<readonly ProjectCloneSnapshot[], Error>>;
let configAtom: Atom.Writable<{ environment: { capabilities: { projectCloneTracking: boolean } } }>;
class TestIdentityError extends Data.TaggedError("TestIdentityError")<{
  message: string;
}> {}
let identityAtom: Atom.Atom<AsyncResult.AsyncResult<GitIdentityResult, TestIdentityError>>;
let requests: ReturnType<typeof readRequest>[];
let readCount: number;
const onContinue = vi.fn();
const onBack = vi.fn();
const onPendingChange = vi.fn();
const text = () => JSON.stringify(renderer!.toJSON());
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((node) => node.children.includes(label));
const continueButton = () =>
  renderer!.root
    .findAllByType("button")
    .find((node) =>
      node.children.some((child) => typeof child === "string" && child.startsWith("Continue")),
    )!;
function view(ref = project, path = cwd) {
  return (
    <RegistryContext.Provider value={registry}>
      <OnboardingProjectReadiness
        project={ref}
        cwd={path}
        onContinue={onContinue}
        onBack={onBack}
        onPendingChange={onPendingChange}
      />
    </RegistryContext.Provider>
  );
}
async function render() {
  await act(async () => {
    renderer = create(view());
  });
}
async function publishClones(value: readonly ProjectCloneSnapshot[]) {
  await act(async () => {
    registry.set(clonesAtom, AsyncResult.success(value));
  });
}
async function settleRead(index: number, value: GitIdentityResult) {
  await act(async () => {
    requests[index]!.resolve(value);
    await executeAtomQuery(registry, identityAtom, { reportFailure: false });
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  clonesAtom = Atom.make<AsyncResult.AsyncResult<readonly ProjectCloneSnapshot[], Error>>(
    AsyncResult.initial(true),
  );
  configAtom = Atom.make<{
    environment: { capabilities: { projectCloneTracking: boolean } };
  }>({ environment: { capabilities: { projectCloneTracking: true } } });
  requests = Array.from({ length: 6 }, readRequest);
  readCount = 0;
  identityAtom = Atom.make(
    Effect.tryPromise({
      try: () => {
        const request = requests[readCount++]!;
        request.started.resolve();
        return request.promise;
      },
      catch: (error) =>
        new TestIdentityError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),
  ).pipe(Atom.swr({ staleTime: 30_000, revalidateOnMount: true }), Atom.setIdleTTL(5 * 60_000));
  mocks.identity.mockReset().mockReturnValue(identityAtom);
  mocks.config.mockReset().mockReturnValue(configAtom);
  mocks.clones.mockReset().mockReturnValue(clonesAtom);
  for (const command of Object.values(mocks.commands))
    command.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  onContinue.mockReset().mockResolvedValue(true);
  onBack.mockReset();
  onPendingChange.mockReset();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  registry.dispose();
  vi.unstubAllGlobals();
});

it("waits for the clone subscription before reading an ordinary folder, without routine refreshes", async () => {
  await render();
  expect(readCount).toBe(0);
  expect(text()).toContain("Checking clone status");
  expect(button("Initialize Git in this folder")).toBeUndefined();
  expect(continueButton().props.disabled).toBe(true);
  await publishClones([]);
  await requests[0]!.started.promise;
  await settleRead(0, missingRepository);
  expect(button("Initialize Git in this folder")).toBeDefined();
  await act(async () => renderer!.update(view({ ...project })));
  await publishClones([]);
  expect(readCount).toBe(1);
});

it.each(["done", "removed"] as const)(
  "rechecks cached identity after a retry becomes %s",
  async (completion) => {
    const cached = executeAtomQuery(registry, identityAtom, { reportFailure: false });
    await requests[0]!.started.promise;
    requests[0]!.resolve(missingRepository);
    await cached;
    registry.set(clonesAtom, AsyncResult.success([clone("failed")]));
    await render();
    expect(button("Retry clone")).toBeDefined();
    expect(button("Initialize Git in this folder")).toBeUndefined();
    await act(async () => {
      button("Retry clone")!.props.onClick();
    });
    await publishClones([clone("running")]);
    await publishClones(completion === "done" ? [clone("done")] : []);
    await requests[1]!.started.promise;
    expect(text()).toContain("Checking Git and commit author");
    expect(text()).not.toContain("This folder is not a Git repository");
    expect(button("Initialize Git in this folder")).toBeUndefined();
    expect(continueButton().props.disabled).toBe(true);
    expect(mocks.commands.init).not.toHaveBeenCalled();
    await settleRead(1, repository);
    expect(text()).toContain("Git repository found");
    expect(text()).toContain("Commit author ready");
    expect(button("Continue to project agents")!.props.disabled).toBe(false);
    await act(async () => renderer!.update(view({ ...project })));
    await publishClones([]);
    expect(readCount).toBe(2);
    expect(mocks.identity).toHaveBeenLastCalledWith(target);
  },
);

it("replaces a pre-clone read still in flight when the completed clone first appears", async () => {
  const oldRead = executeAtomQuery(registry, identityAtom, { reportFailure: false });
  await requests[0]!.started.promise;
  registry.set(clonesAtom, AsyncResult.success([clone("done")]));
  await render();
  await requests[1]!.started.promise;
  await act(async () => {
    requests[0]!.resolve(missingRepository);
  });
  expect(button("Initialize Git in this folder")).toBeUndefined();
  expect(continueButton().props.disabled).toBe(true);
  await settleRead(1, repository);
  await oldRead;
  expect(text()).toContain("Git repository found");
  expect(button("Continue to project agents")!.props.disabled).toBe(false);
  expect(readCount).toBe(2);
});

it("hides cached setup actions after a failed refresh and permits an explicit check retry", async () => {
  const cached = executeAtomQuery(registry, identityAtom, { reportFailure: false });
  await requests[0]!.started.promise;
  requests[0]!.resolve(missingRepository);
  await cached;
  registry.set(clonesAtom, AsyncResult.success([clone("running")]));
  await render();
  await publishClones([]);
  await requests[1]!.started.promise;
  await act(async () => {
    requests[1]!.reject(new Error("Identity read failed"));
    await executeAtomQuery(registry, identityAtom, { reportFailure: false });
  });
  expect(renderer!.root.findByProps({ role: "alert" }).children.join("")).toBe(
    "Git setup could not be checked: Identity read failed",
  );
  expect(button("Initialize Git in this folder")).toBeUndefined();
  expect(button("Check again")).toBeDefined();
  await act(async () => {
    button("Check again")!.props.onClick();
  });
  await requests[2]!.started.promise;
  expect(continueButton().props.disabled).toBe(true);
  await settleRead(2, repository);
  expect(text()).toContain("Git repository found");
  expect(button("Continue to project agents")!.props.disabled).toBe(false);
});

it("keeps Git setup available on servers without clone tracking", async () => {
  registry.set(configAtom, { environment: { capabilities: { projectCloneTracking: false } } });
  await render();
  await requests[0]!.started.promise;
  await settleRead(0, repository);
  expect(mocks.clones).not.toHaveBeenCalled();
  expect(button("Continue to project agents")!.props.disabled).toBe(false);
  await act(async () => renderer!.update(view()));
  expect(readCount).toBe(1);
});

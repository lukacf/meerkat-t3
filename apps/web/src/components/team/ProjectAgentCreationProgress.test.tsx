import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../../hooks/useProviderWorkspaceReadiness", () => ({
  useProviderWorkspaceReadiness: ({ providers }: { providers: ServerProvider[] }) => ({
    providers,
    pendingInstanceIds: new Set(),
  }),
}));
vi.mock("../../state/meerkatTeam", () => ({
  meerkatTeamEnvironment: { projectAgentCreate: "create" },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.create }));
vi.mock("../../state/query", () => ({
  formatEnvironmentQueryError: (cause: Error) => cause.message,
}));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => new Map() } }));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("./agentModelReadiness", () => ({ getAgentModelSendBlock: () => null }));
vi.mock("./useRestoreReview", () => ({
  readRestoreReviewWorkBlock: () => null,
  useRestoreReviewWorkBlock: () => null,
}));
vi.mock("./ProjectAgentModelFields", () => ({ ProjectAgentModelFields: () => null }));
vi.mock("./ProjectAgentPermissions", () => ({ ProjectAgentPermissions: () => null }));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));

import { ProjectAgentSetup } from "./ProjectAgentSetup";

const scope = {
  environmentId: EnvironmentId.make("creation-progress-environment"),
  projectId: ProjectId.make("creation-progress-project"),
  cwd: "/creation-progress-project",
};
const instanceId = ProviderInstanceId.make("native-progress");
const receipt = { agentId: "created-reviewer", projectId: scope.projectId, instanceId };
type CreateResult = { _tag: "Success"; value: typeof receipt } | { _tag: "Failure"; cause: Error };
const providers: ServerProvider[] = [
  {
    instanceId,
    driver: ProviderDriverKind.make("meerkat"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-05T00:00:00.000Z",
    models: [
      {
        slug: "openai:review-model",
        name: "Review model",
        isDefault: true,
        isCustom: false,
        capabilities: null,
        credentialState: "connected",
      },
    ],
    skills: [],
    slashCommands: [],
  },
];
let renderer: ReactTestRenderer | undefined;

function makeStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
    clear: () => entries.clear(),
  };
}
function deferred() {
  let resolve!: (value: CreateResult) => void;
  const promise = new Promise<CreateResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const text = () => JSON.stringify(renderer?.toJSON());
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((node) => node.children.includes(label))!;
const setup = (onCreated = vi.fn()) => (
  <ProjectAgentSetup {...scope} providers={providers} onCreated={onCreated} onCancel={() => {}} />
);
const submit = () =>
  act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => {} }));
async function fillAndSubmit() {
  await act(async () =>
    renderer!.root.findByType("input").props.onChange({ target: { value: "Reviewer" } }),
  );
  await act(async () =>
    renderer!.root.findByType("textarea").props.onChange({
      target: { value: "Review the implementation" },
    }),
  );
  await submit();
}
function expectRequestInProgress() {
  expect(text()).toContain("Request in progress");
  expect(text()).toContain("Waiting for the server to confirm this request");
  expect(text()).not.toContain("Confirmation pending");
  expect(text()).not.toContain("response may have been lost");
  expect(text()).not.toContain("Retry same request");
  expect(text()).not.toContain("Edit as a new request");
  expect(button("Waiting for response...").props.disabled).toBe(true);
  expect(renderer!.root.findByType("input").props.disabled).toBe(true);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", makeStorage());
  state.create.mockReset();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("shows ordinary progress until the first creation response arrives", async () => {
  const pending = deferred();
  state.create.mockReturnValueOnce(pending.promise);
  const onCreated = vi.fn();
  await act(async () => {
    renderer = create(setup(onCreated));
  });
  await fillAndSubmit();
  expectRequestInProgress();
  await submit();
  expect(state.create).toHaveBeenCalledTimes(1);
  expect(onCreated).not.toHaveBeenCalled();

  await act(async () => pending.resolve({ _tag: "Success", value: receipt }));
  expect(onCreated).toHaveBeenCalledExactlyOnceWith(receipt);
  expect(text()).not.toContain("Request in progress");
  expect(text()).not.toContain("Confirmation pending");
  expect(button("Open created agent").props.disabled).toBe(false);
});

it("offers recovery after failure and hides stale warnings while retrying the same request", async () => {
  const first = deferred();
  state.create.mockReturnValueOnce(first.promise);
  const onCreated = vi.fn();
  await act(async () => {
    renderer = create(setup(onCreated));
  });
  await fillAndSubmit();
  expectRequestInProgress();
  const original = state.create.mock.calls[0]![0];
  const failure = "Connection closed while waiting for the creation response";
  await act(async () => first.resolve({ _tag: "Failure", cause: new Error(failure) }));
  expect(text()).toContain("Confirmation pending");
  expect(text()).toContain("response may have been lost");
  expect(text()).toContain(failure);
  expect(button("Retry same request").props.disabled).toBe(false);

  const retry = deferred();
  state.create.mockReturnValueOnce(retry.promise);
  await act(async () => button("Retry same request").props.onClick());
  expectRequestInProgress();
  expect(text()).not.toContain(failure);
  expect(state.create).toHaveBeenNthCalledWith(2, original);
  await act(async () => retry.resolve({ _tag: "Success", value: receipt }));
  expect(onCreated).toHaveBeenCalledExactlyOnceWith(receipt);
  expect(button("Open created agent").props.disabled).toBe(false);
});

it("keeps an unconfirmed request recoverable after remount without resubmitting it", async () => {
  const pending = deferred();
  state.create.mockReturnValueOnce(pending.promise);
  await act(async () => {
    renderer = create(setup());
  });
  await fillAndSubmit();
  expectRequestInProgress();
  await act(async () => renderer!.unmount());
  await act(async () => {
    renderer = create(setup());
  });
  expect(state.create).toHaveBeenCalledTimes(1);
  expect(text()).not.toContain("Request in progress");
  expect(text()).toContain("Confirmation pending");
  expect(text()).toContain("response may have been lost");
  expect(button("Retry same request").props.disabled).toBe(false);
  await act(async () =>
    pending.resolve({ _tag: "Failure", cause: new Error("Original connection closed") }),
  );
});

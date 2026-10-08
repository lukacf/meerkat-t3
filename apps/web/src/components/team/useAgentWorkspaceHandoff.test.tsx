import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerConfig,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  createAgentWorkspaceHandoffStore,
  handoffKey,
  useAgentWorkspaceHandoffStore,
} from "./agentWorkspaceHandoffStore";
import {
  agentWorkspaceHandoffAttemptKey,
  createAgentWorkspaceHandoffAttemptStore,
} from "./agentWorkspaceHandoffAttemptStore";

const state = vi.hoisted(() => ({
  create: vi.fn(),
  retry: vi.fn(),
  navigate: vi.fn(),
  flush: vi.fn(),
  shell: null as object | null,
  config: null as Pick<ServerConfig, "providers" | "settings"> | null,
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { create: "create" } }));
vi.mock("../../connection/catalog", () => ({ environmentCatalog: { retryNow: "retry" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "retry" ? state.retry : state.create),
}));
vi.mock("../../state/query", () => ({ formatEnvironmentQueryError: () => "Create failed" }));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => state.shell,
  readThreadShell: () => state.shell,
}));
vi.mock("../../composerDraftStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../composerDraftStore")>()),
  flushComposerDraftPersistence: state.flush,
}));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: "configs" }));
vi.mock("../../rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => new Map([["remote", state.config]]) },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
import { useAgentWorkspaceHandoff } from "./useAgentWorkspaceHandoff";

const input = {
  purpose: "delivery" as const,
  origin: {
    kind: "project-agent" as const,
    environmentId: EnvironmentId.make("remote"),
    projectId: ProjectId.make("project"),
    agentId: "reviewer",
    label: "Reviewer",
  },
  target: {
    projectId: ProjectId.make("project"),
    instanceId: ProviderInstanceId.make("native"),
    agentRef: "live-reviewer",
  },
  cwd: "/repo",
  branch: "feature/review",
  worktreePath: null,
  modelSelection: { instanceId: ProviderInstanceId.make("native"), model: "model" },
  summary: "The retry fix is ready for review.",
};
type HandoffInput = Parameters<ReturnType<typeof useAgentWorkspaceHandoff>["start"]>[0];
function Harness({ value = input }: { value?: HandoffInput }) {
  const handoff = useAgentWorkspaceHandoff(value);
  return (
    <>
      <button
        aria-label="Start handoff"
        disabled={handoff.pending}
        onClick={() => handoff.start(value)}
      >
        {handoff.error ?? "Continue"}
      </button>
      {handoff.recovery ? (
        <button
          aria-label="Recover saved task"
          disabled={handoff.recovery.pending}
          onClick={() => handoff.recovery?.retry()}
        >
          {handoff.recovery.label}
        </button>
      ) : null}
    </>
  );
}
let renderer: ReactTestRenderer | undefined;
const start = () => renderer!.root.findByProps({ "aria-label": "Start handoff" });
const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
};
let storage = memoryStorage();
const initialDrafts = useComposerDraftStore.getState();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  state.shell = null;
  state.config = {
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [input.modelSelection.instanceId]: {
          driver: ProviderDriverKind.make("meerkat"),
          config: {},
        },
      },
    },
    providers: [
      {
        instanceId: input.modelSelection.instanceId,
        driver: ProviderDriverKind.make("meerkat"),
        installed: true,
        enabled: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-04T00:00:00.000Z",
        skills: [],
        slashCommands: [],
        models: [
          {
            slug: input.modelSelection.model,
            name: "Model",
            isCustom: false,
            capabilities: null,
            credentialState: "connected",
          },
        ],
      },
    ],
  };
  state.create.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  state.retry.mockReset().mockResolvedValue({ _tag: "Success" });
  state.navigate.mockReset().mockResolvedValue(undefined);
  state.flush.mockReset().mockReturnValue(true);
  useAgentWorkspaceHandoffStore.setState({ records: {} });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  useComposerDraftStore.setState(initialDrafts, true);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("persists a same-checkout delivery thread before navigation so PR actions immediately have an owner", async () => {
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => start().props.onClick());
  expect(state.create).toHaveBeenCalledOnce();
  const created = state.create.mock.calls[0]![0];
  expect(created).toMatchObject({
    environmentId: "remote",
    input: {
      projectId: "project",
      branch: "feature/review",
      worktreePath: null,
      modelSelection: { instanceId: "native", model: "model" },
    },
  });
  expect(state.navigate).not.toHaveBeenCalled();
  const threadId = created.input.threadId as ThreadId;
  const prompt = useComposerDraftStore
    .getState()
    .getComposerDraft(scopeThreadRef(input.origin.environmentId, threadId))?.prompt;
  expect(prompt).toContain("/repo");
  expect(prompt).toContain("feature/review");
  expect(prompt).toContain("/remote/agents/reviewer?project=project");
  expect(prompt).toContain(input.summary);
  expect(
    useAgentWorkspaceHandoffStore.getState().records[
      handoffKey(input.origin.environmentId, threadId)
    ]?.purpose,
  ).toBe("delivery");
  state.shell = { id: threadId, projectId: input.origin.projectId, latestTurn: null };
  await act(async () => renderer!.update(<Harness />));
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: "remote", threadId },
  });
});

it("retries the same idempotent create without making another task after a failed receipt", async () => {
  state.create.mockResolvedValueOnce({ _tag: "Failure", cause: "lost response" });
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => start().props.onClick());
  expect(start().children.join("")).toContain("Create failed");
  expect(state.navigate).not.toHaveBeenCalled();
  expect(Object.keys(useAgentWorkspaceHandoffStore.getState().records)).toHaveLength(0);
  await act(async () => start().props.onClick());
  expect(state.create.mock.calls[1]![0]).toEqual(state.create.mock.calls[0]![0]);
});

it("saves the exact task identity and context before dispatch and reuses them after remount with changed inputs", async () => {
  const key = agentWorkspaceHandoffAttemptKey(input);
  state.create.mockImplementationOnce(async (request) => {
    const saved = createAgentWorkspaceHandoffAttemptStore(key, storage).getState().attempt;
    expect(saved?.record.hostThreadId).toBe(request.input.threadId);
    expect(saved?.command).toEqual({ type: "thread.create", ...request.input });
    expect(saved?.prompt).toContain(input.summary);
    expect(saved?.accepted).toBe(false);
    return { _tag: "Failure", cause: "lost reply" };
  });
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => start().props.onClick());
  const original = state.create.mock.calls[0]![0];
  act(() => renderer!.unmount());
  // Neither a new catalog/model nor a different checkout/context can allocate another ID.
  state.config = null;
  const changed: HandoffInput = {
    ...input,
    origin: { ...input.origin, label: "Renamed specialist" },
    cwd: "/different-checkout",
    branch: "different-branch",
    worktreePath: "/different-checkout",
    modelSelection: { instanceId: ProviderInstanceId.make("other-account"), model: "other-model" },
    summary: "New context that must not replace the saved request.",
  };
  await act(async () => {
    renderer = create(<Harness value={changed} />);
  });
  expect(state.create).toHaveBeenCalledOnce();
  expect(renderer!.root.findByProps({ "aria-label": "Recover saved task" }).children).toContain(
    "Retry opening task",
  );
  await act(async () => start().props.onClick());
  expect(state.create).toHaveBeenCalledTimes(2);
  expect(state.create.mock.calls[1]![0]).toEqual(original);
  const draft = useComposerDraftStore
    .getState()
    .getComposerDraft(scopeThreadRef(input.origin.environmentId, original.input.threadId));
  expect(draft?.prompt).toContain(input.summary);
  expect(draft?.prompt).not.toContain(changed.summary);
  expect(draft?.prompt).not.toContain(changed.cwd);
});

it("opens the exact projected task after a lost reply without recreating it or overwriting an existing draft", async () => {
  state.create.mockResolvedValueOnce({ _tag: "Failure", cause: "lost reply" });
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => start().props.onClick());
  const threadId = state.create.mock.calls[0]![0].input.threadId;
  act(() => renderer!.unmount());
  state.shell = { id: threadId, projectId: input.origin.projectId, latestTurn: null };
  const ref = scopeThreadRef(input.origin.environmentId, threadId);
  useComposerDraftStore.getState().setPrompt(ref, "My existing delivery instructions");
  state.config = null;
  await act(async () => {
    renderer = create(<Harness />);
  });
  expect(state.navigate).not.toHaveBeenCalled();
  await act(async () =>
    renderer!.root.findByProps({ "aria-label": "Recover saved task" }).props.onClick(),
  );
  expect(state.create).toHaveBeenCalledOnce();
  expect(useComposerDraftStore.getState().getComposerDraft(ref)?.prompt).toBe(
    "My existing delivery instructions",
  );
  const restored =
    createAgentWorkspaceHandoffStore(storage).getState().records[
      handoffKey(input.origin.environmentId, threadId)
    ];
  expect(restored?.context).toContain(input.summary);
  expect(
    createAgentWorkspaceHandoffAttemptStore(
      agentWorkspaceHandoffAttemptKey(input),
      storage,
    ).getState().attempt,
  ).toBeNull();
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: input.origin.environmentId, threadId },
  });
});

it("does not dispatch when the recovery identity cannot be persisted", async () => {
  storage.setItem.mockImplementation(() => {
    throw new Error("storage full");
  });
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => start().props.onClick());
  expect(state.create).not.toHaveBeenCalled();
  expect(start().children.join("")).toContain("Could not save the workspace request locally");
  expect(state.navigate).not.toHaveBeenCalled();
});

it("keeps an accepted task recoverable if context persistence fails, without another create on remount", async () => {
  state.flush.mockReturnValueOnce(false);
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => start().props.onClick());
  const threadId = state.create.mock.calls[0]![0].input.threadId;
  const key = agentWorkspaceHandoffAttemptKey(input);
  expect(createAgentWorkspaceHandoffAttemptStore(key, storage).getState().attempt).toMatchObject({
    accepted: true,
    contextSaved: false,
  });
  expect(state.navigate).not.toHaveBeenCalled();
  act(() => renderer!.unmount());
  useComposerDraftStore.setState(initialDrafts, true);
  state.config = null;
  state.shell = { id: threadId, projectId: input.origin.projectId, latestTurn: null };
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () =>
    renderer!.root.findByProps({ "aria-label": "Recover saved task" }).props.onClick(),
  );
  expect(state.create).toHaveBeenCalledOnce();
  expect(
    useComposerDraftStore
      .getState()
      .getComposerDraft(scopeThreadRef(input.origin.environmentId, threadId))?.prompt,
  ).toContain(input.summary);
  expect(createAgentWorkspaceHandoffAttemptStore(key, storage).getState().attempt).toBeNull();
  expect(state.navigate).toHaveBeenCalled();
});

it("retains recovery after failed navigation and permits a later intentional handoff only after the original opens", async () => {
  state.navigate.mockRejectedValueOnce(new Error("navigation failed"));
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => start().props.onClick());
  const original = state.create.mock.calls[0]![0].input;
  state.shell = { id: original.threadId, projectId: input.origin.projectId, latestTurn: null };
  await act(async () => renderer!.update(<Harness />));
  const key = agentWorkspaceHandoffAttemptKey(input);
  expect(
    createAgentWorkspaceHandoffAttemptStore(key, storage).getState().attempt?.record.hostThreadId,
  ).toBe(original.threadId);
  act(() => renderer!.unmount());
  // Another already-open view has not loaded the durable context into its local store.
  useAgentWorkspaceHandoffStore.setState({ records: {} });
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () =>
    renderer!.root.findByProps({ "aria-label": "Recover saved task" }).props.onClick(),
  );
  expect(state.create).toHaveBeenCalledOnce();
  expect(createAgentWorkspaceHandoffAttemptStore(key, storage).getState().attempt).toBeNull();
  expect(
    useAgentWorkspaceHandoffStore.getState().records[
      handoffKey(input.origin.environmentId, original.threadId)
    ]?.context,
  ).toContain(input.summary);
  act(() => renderer!.unmount());
  state.shell = null;
  const next = { ...input, summary: "A later deliberate task", branch: "next-work" };
  await act(async () => {
    renderer = create(<Harness value={next} />);
  });
  await act(async () => start().props.onClick());
  const created = state.create.mock.calls[1]![0].input;
  expect(created.threadId).not.toBe(original.threadId);
  expect(created.commandId).not.toBe(original.commandId);
  expect(created.branch).toBe("next-work");
});

it("keeps the original request when its separate handoff context cannot be saved", async () => {
  const write = storage.setItem.getMockImplementation()!;
  storage.setItem.mockImplementation((key, value) => {
    if (key === "t3code:native-workspace-handoffs:v1") throw new Error("storage full");
    write(key, value);
  });
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => start().props.onClick());
  expect(state.create).toHaveBeenCalledOnce();
  expect(state.navigate).not.toHaveBeenCalled();
  expect(
    createAgentWorkspaceHandoffAttemptStore(
      agentWorkspaceHandoffAttemptKey(input),
      storage,
    ).getState().attempt,
  ).toMatchObject({ accepted: true, contextSaved: false });
  expect(start().children.join("")).toContain("handoff context could not be saved");
});

it("requires an explicit retry after completion cleanup fails instead of repeatedly navigating", async () => {
  const write = storage.setItem.getMockImplementation()!;
  const key = agentWorkspaceHandoffAttemptKey(input);
  storage.setItem.mockImplementation((storageKey, value) => {
    if (storageKey === key && value.includes('"status":"completed"'))
      throw new Error("storage full");
    write(storageKey, value);
  });
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => start().props.onClick());
  const threadId = state.create.mock.calls[0]![0].input.threadId;
  state.shell = { id: threadId, projectId: input.origin.projectId, latestTurn: null };
  await act(async () => renderer!.update(<Harness />));
  expect(state.navigate).toHaveBeenCalledOnce();
  expect(
    createAgentWorkspaceHandoffAttemptStore(key, storage).getState().attempt?.record.hostThreadId,
  ).toBe(threadId);
  expect(start().children.join("")).toContain("recovery record could not be cleared");
  storage.setItem.mockImplementation(write);
  await act(async () =>
    renderer!.root.findByProps({ "aria-label": "Recover saved task" }).props.onClick(),
  );
  expect(state.navigate).toHaveBeenCalledTimes(2);
  expect(state.create).toHaveBeenCalledOnce();
  expect(createAgentWorkspaceHandoffAttemptStore(key, storage).getState().attempt).toBeNull();
});

it("does not let an in-flight request for another origin block this one or navigate the wrong agent", async () => {
  let resolveFirst!: (value: { _tag: "Success"; value: object }) => void;
  const firstResponse = new Promise<{ _tag: "Success"; value: object }>((resolve) => {
    resolveFirst = resolve;
  });
  state.create.mockReturnValueOnce(firstResponse);
  await act(async () => {
    renderer = create(<Harness />);
  });
  let firstRun!: Promise<void>;
  await act(async () => {
    firstRun = start().props.onClick();
  });
  const other = { ...input, origin: { ...input.origin, agentId: "builder", label: "Builder" } };
  await act(async () => renderer!.update(<Harness value={other} />));
  expect(start().props.disabled).toBe(false);
  await act(async () => start().props.onClick());
  expect(state.create).toHaveBeenCalledTimes(2);
  await act(async () => {
    resolveFirst({ _tag: "Success", value: {} });
    await firstRun;
  });
  expect(state.navigate).not.toHaveBeenCalled();
  expect(
    createAgentWorkspaceHandoffAttemptStore(
      agentWorkspaceHandoffAttemptKey(input),
      storage,
    ).getState().attempt?.accepted,
  ).toBe(true);
  expect(
    createAgentWorkspaceHandoffAttemptStore(
      agentWorkspaceHandoffAttemptKey(other),
      storage,
    ).getState().attempt?.accepted,
  ).toBe(true);
});

it("reopens a previously used task without putting the initial context back into its composer", async () => {
  state.create.mockResolvedValueOnce({ _tag: "Failure", cause: "lost reply" });
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => start().props.onClick());
  const threadId = state.create.mock.calls[0]![0].input.threadId;
  act(() => renderer!.unmount());
  state.shell = {
    id: threadId,
    projectId: input.origin.projectId,
    latestTurn: { state: "completed" },
  };
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () =>
    renderer!.root.findByProps({ "aria-label": "Recover saved task" }).props.onClick(),
  );
  expect(state.create).toHaveBeenCalledOnce();
  expect(
    useComposerDraftStore
      .getState()
      .getComposerDraft(scopeThreadRef(input.origin.environmentId, threadId))?.prompt ?? "",
  ).toBe("");
  expect(
    createAgentWorkspaceHandoffStore(storage).getState().records[
      handoffKey(input.origin.environmentId, threadId)
    ]?.context,
  ).toContain(input.summary);
});

it("checks the latest exact workspace before creating a browser or delivery task", async () => {
  const native = state.config!.providers[0]!;
  state.config = {
    ...state.config!,
    providers: [
      {
        ...native,
        supportsWorkspaceReadiness: true,
        auth: { status: "unauthenticated" },
        models: [],
        workspaceSnapshots: [
          {
            cwd: input.cwd,
            checkedAt: native.checkedAt,
            skills: [],
            slashCommands: [],
            readiness: {
              status: "ready",
              auth: { status: "authenticated" },
              models: native.models,
            },
          },
        ],
      },
    ],
  };
  await act(async () => {
    renderer = create(<Harness />);
  });
  // Account invalidation can arrive after rendering, before an old click callback runs.
  const readyConfig = state.config;
  state.config = {
    ...readyConfig,
    providers: readyConfig.providers.map((provider) => ({ ...provider, workspaceSnapshots: [] })),
  };
  await act(async () => start().props.onClick());
  expect(state.create).not.toHaveBeenCalled();
  expect(start().children.join("")).toContain("Checking models for this workspace");
  state.config = readyConfig;
  await act(async () => start().props.onClick());
  expect(state.create).toHaveBeenCalledOnce();
  expect(state.create.mock.calls[0]![0].input.modelSelection).toEqual(input.modelSelection);
});

it("recovers a delayed projection through the connection without creating another task", async () => {
  vi.useFakeTimers();
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => start().props.onClick());
  const savedId = state.create.mock.calls[0]![0].input.threadId;
  expect(renderer!.root.findAllByProps({ "aria-label": "Recover saved task" })).toHaveLength(0);
  await act(async () => {
    vi.advanceTimersByTime(10_000);
  });
  const recover = () => renderer!.root.findByProps({ "aria-label": "Recover saved task" });
  await act(async () => recover().props.onClick());
  expect(state.retry).toHaveBeenCalledWith(input.origin.environmentId);
  expect(state.create).toHaveBeenCalledOnce();
  expect(state.navigate).not.toHaveBeenCalled();
  state.shell = { id: savedId, projectId: input.origin.projectId, latestTurn: null };
  await act(async () => renderer!.update(<Harness />));
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: input.origin.environmentId, threadId: savedId },
  });
  expect(state.create).toHaveBeenCalledOnce();
});

it("restores source links by environment and host thread and rejects malformed stored records", () => {
  let persisted = "[]";
  const storage = {
    getItem: () => persisted,
    setItem: (_key: string, value: string) => {
      persisted = value;
    },
  };
  const first = createAgentWorkspaceHandoffStore(storage);
  const hostThreadId = "host" as ThreadId;
  first.getState().save({ ...input, hostThreadId });
  const restored = createAgentWorkspaceHandoffStore(storage);
  expect(
    restored.getState().records[handoffKey(input.origin.environmentId, hostThreadId)],
  ).toMatchObject({ purpose: "delivery", cwd: "/repo", origin: { agentId: "reviewer" } });
  expect(
    restored.getState().records[handoffKey(EnvironmentId.make("other"), hostThreadId)],
  ).toBeUndefined();
  persisted = '[{"purpose":"browser","hostThreadId":"host"}]';
  expect(createAgentWorkspaceHandoffStore(storage).getState().records).toEqual({});
});

it("preserves another view's saved handoff context when a stale view saves or dismisses", () => {
  const first = createAgentWorkspaceHandoffStore(storage);
  const second = createAgentWorkspaceHandoffStore(storage);
  const a = { ...input, hostThreadId: ThreadId.make("task-a") };
  const b = { ...input, hostThreadId: ThreadId.make("task-b") };
  expect(first.getState().saveContext(a, "Original context A")).toBe(true);
  expect(second.getState().saveContext(b, "Original context B")).toBe(true);
  first.getState().remove(input.origin.environmentId, a.hostThreadId);
  let restored = createAgentWorkspaceHandoffStore(storage).getState().records;
  expect(restored[handoffKey(input.origin.environmentId, a.hostThreadId)]).toBeUndefined();
  expect(restored[handoffKey(input.origin.environmentId, b.hostThreadId)]?.context).toBe(
    "Original context B",
  );
  // This view still has A locally. Saving B must not resurrect A or erase B's context.
  second.getState().save(b);
  for (let i = 0; i < 51; i++)
    first.getState().save({ ...input, hostThreadId: ThreadId.make(`link-${i}`) });
  restored = createAgentWorkspaceHandoffStore(storage).getState().records;
  expect(restored[handoffKey(input.origin.environmentId, a.hostThreadId)]).toBeUndefined();
  expect(restored[handoffKey(input.origin.environmentId, b.hostThreadId)]?.context).toBe(
    "Original context B",
  );
});

it("does not attest context durability after an unacknowledged storage write", () => {
  const lost = createAgentWorkspaceHandoffStore({ getItem: () => "[]", setItem: () => {} });
  expect(
    lost
      .getState()
      .saveContext(
        { ...input, hostThreadId: ThreadId.make("unsaved-context") },
        "Original context",
      ),
  ).toBe(false);
  expect(lost.getState().records).toEqual({});
});

it("preserves an unreadable legacy row without blocking another exact handoff", () => {
  const legacy = {
    purpose: "browser",
    hostThreadId: "old-host",
    origin: { kind: "project-agent-attention", agentId: "old-agent" },
    context: "Old context",
  };
  storage.setItem("t3code:native-workspace-handoffs:v1", JSON.stringify([legacy]));
  const store = createAgentWorkspaceHandoffStore(storage);
  const record = { ...input, hostThreadId: ThreadId.make("new-context") };
  expect(store.getState().saveContext(record, "New context")).toBe(true);
  expect(JSON.parse(storage.getItem("t3code:native-workspace-handoffs:v1")!)).toContainEqual(
    legacy,
  );
  expect(
    createAgentWorkspaceHandoffStore(storage).getState().records[
      handoffKey(input.origin.environmentId, record.hostThreadId)
    ]?.context,
  ).toBe("New context");
});

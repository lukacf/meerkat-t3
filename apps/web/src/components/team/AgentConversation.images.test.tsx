import { act, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type MeerkatImageRef,
  type MeerkatTeamAgent,
  type MeerkatTeamProvider,
} from "@t3tools/contracts";

const state = vi.hoisted(() => {
  const entries = new Map<string, string>();
  const flags = { failImages: false };
  const storage = {
    getItem(key: string) {
      if (flags.failImages && key.startsWith("t3code:meerkat-image-drafts:"))
        throw new Error("unavailable");
      return entries.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      entries.set(key, value);
    },
    removeItem(key: string) {
      entries.delete(key);
    },
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("sessionStorage", { ...storage, getItem: () => null });
  return {
    entries,
    flags,
    storage,
    send: vi.fn(),
    reconcile: vi.fn(),
    enqueue: vi.fn(),
    upload: vi.fn(),
  };
});
vi.mock("@tanstack/react-router", () => ({ Link: "a", useNavigate: () => vi.fn() }));
vi.mock("@legendapp/list/react", () => ({ LegendList: () => null }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({ sendShortcut: "enter" }),
}));
vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../../state/meerkatAttention", () => ({ useMeerkatAttention: () => ({ error: null }) }));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => new Map() } }));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: "config" }));
vi.mock("../settings/useSettingsProjectGroups", () => ({ useSettingsProjectGroups: () => [] }));
vi.mock("../composerContextPresentation", () => ({ composerContextRecordsFromDraft: () => [] }));
vi.mock("./agentModelReadiness", () => ({
  getAgentModelSendBlock: () => null,
  getAgentDeliveryRetryBlock: () => null,
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/meerkatMedia", () => ({
  createMeerkatMediaAtoms: () => ({ imageRead: () => "image", imageUpload: "upload" }),
}));
vi.mock("../../state/meerkatTeam", () => ({
  meerkatTeamEnvironment: {
    agentActivity: () => "history",
    agentQueue: () => "queue",
    agentSend: "send",
    agentDeliveryReconcile: "reconcile",
    agentQueueEnqueue: "enqueue",
  },
  useVisibleTeamRefresh() {},
}));
vi.mock("../../state/query", () => {
  const history = { data: undefined, error: null, isPending: false, refresh() {} };
  const queue = { ...history, data: { items: [], revision: 0 } };
  return {
    useEnvironmentQuery: (query: string) => (query === "queue" ? queue : history),
    formatEnvironmentQueryError: () => "Request failed",
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "send"
      ? state.send
      : command === "reconcile"
        ? state.reconcile
        : command === "enqueue"
          ? state.enqueue
          : state.upload,
}));
vi.mock("./useNativeHistoryViewport", () => ({ useNativeHistoryViewport: () => ({}) }));
vi.mock("./nativeHistoryDisclosures", () => ({
  useNativeHistoryDisclosures: () => ({ expanded: new Set() }),
}));
vi.mock("./NativeAgentTranscript", () => ({
  NativeAgentTranscript: () => null,
  NativeTranscriptPart: () => null,
}));
vi.mock("./NativePeerContent", () => ({ NativePeerContent: () => null }));
vi.mock("../ChatMarkdown", () => ({ default: () => null }));
vi.mock("./NativeToolActivityGroup", () => ({ NativeToolActivityGroup: () => null }));
vi.mock("./MeerkatWorkspaceCheckpoints", () => ({ MeerkatWorkspaceCheckpoints: () => null }));
vi.mock("./MeerkatToolApprovals", () => ({ MeerkatToolApprovals: () => null }));
vi.mock("./NativeAttentionReadMarker", () => ({ NativeAttentionReadMarker: () => null }));
vi.mock("./AgentBrowserControls", () => ({ AgentBrowserControls: () => null }));
vi.mock("./MeerkatResumeAgentButton", () => ({ MeerkatResumeAgentButton: () => null }));
vi.mock("./EarlierAgentDrafts", () => ({ EarlierAgentDrafts: () => null }));
vi.mock("./AgentInteractionRequests", () => ({ AgentInteractionRequests: () => null }));
vi.mock("./AgentModelControls", () => ({ AgentModelControls: () => null }));
vi.mock("./AgentUnsentQueue", () => ({ AgentUnsentQueue: () => null }));
vi.mock("./LegacyAgentUnsentQueue", () => ({ LegacyAgentUnsentQueue: () => null }));
vi.mock("./AgentComposerEditor", () => ({
  AgentComposerEditor: ({ value }: { value: string }) => <textarea value={value} readOnly />,
}));
vi.mock("../chat/ExpandedImageDialog", () => ({ ExpandedImageDialog: () => null }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => children,
  MenuItem: "button",
  MenuPopup: "div",
  MenuSeparator: "hr",
  MenuTrigger: () => null,
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: () => null,
  PopoverTrigger: () => null,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactElement }) => render,
  TooltipPopup: () => null,
}));

import { AgentConversation } from "./AgentConversation";
import { AgentComposerEditor } from "./AgentComposerEditor";
import {
  agentConversationDraftKey,
  useAgentConversationDraftStore,
} from "./agentConversationDraftStore";
import { useAgentUnsentQueueStore } from "./agentUnsentQueueStore";
import { agentWorkspaceDraftId } from "./agentWorkspaceContext";
import { nativeImageDraftStorageKey } from "./nativeImageDraftStore";
import { useComposerDraftStore, flushComposerDraftPersistence } from "../../composerDraftStore";

const scope = {
  environmentId: EnvironmentId.make("image-env"),
  projectId: ProjectId.make("image-project"),
  instanceId: ProviderInstanceId.make("native"),
};
const image: MeerkatImageRef = {
  type: "image",
  source: "blob",
  media_type: "image/png",
  blob_id: `sha256:${"a".repeat(64)}`,
};
const agent: MeerkatTeamAgent = {
  agentRef: "worker",
  durableId: "saved-worker",
  mobId: "mob",
  mobLabel: "Team",
  mobKind: "thread",
  scopeLabel: "Project",
  availability: "live",
  record: {
    identity: "worker",
    display_name: "Reviewer",
    runtime_key: "runtime",
    runtime_member_id: "worker",
    session_id: "session",
    visibility: "addressable",
    addressable: true,
    health: "healthy",
    labels: {},
  },
};
const provider: MeerkatTeamProvider = {
  instanceId: scope.instanceId,
  label: "Native",
  status: "ready",
  errors: [],
  totalScopeCount: 1,
  unloadedScopeCount: 0,
  loadedMobCount: 1,
  agents: [agent],
};
const initialComposer = useComposerDraftStore.getState();
const initialRequests = useAgentConversationDraftStore.getState();
const initialQueue = useAgentUnsentQueueStore.getState();
let renderer: ReactTestRenderer | undefined;
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((node) => node.children.includes(label))!;
function target(projectAgent: boolean) {
  const draftTarget = {
    ...scope,
    identity: projectAgent
      ? { kind: "project-agent" as const, projectAgentId: "specialist" }
      : { kind: "native-agent" as const, durableId: agent.durableId, agentRef: agent.agentRef },
  };
  const key = agentConversationDraftKey(draftTarget);
  return {
    key,
    composerId: agentWorkspaceDraftId(draftTarget),
    imageKey: nativeImageDraftStorageKey({ ...scope, agentRef: agent.agentRef }, key),
  };
}
function mount(projectAgent = false) {
  act(() => {
    renderer = create(
      <AgentConversation
        {...scope}
        agent={agent}
        provider={provider}
        primaryProjectAgentId={projectAgent ? "specialist" : undefined}
        rosterStale={false}
        refreshTeam={() => {}}
        cwd="/fixture"
      />,
    );
  });
}
function seed(projectAgent = false) {
  const ids = target(projectAgent);
  state.storage.setItem(ids.imageKey, JSON.stringify([image]));
  useComposerDraftStore.getState().setPrompt(ids.composerId, "Review this image");
  flushComposerDraftPersistence();
  return ids;
}
async function submit() {
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  state.flags.failImages = false;
  state.entries.clear();
  useComposerDraftStore.setState(initialComposer, true);
  useAgentConversationDraftStore.setState(initialRequests, true);
  useAgentUnsentQueueStore.setState(initialQueue, true);
  state.send.mockReset().mockResolvedValue({ _tag: "Success", value: { status: "uncertain" } });
  state.reconcile
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { status: "uncertain" } });
  state.enqueue.mockReset().mockResolvedValue({ _tag: "Failure" });
  state.upload.mockReset();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  flushComposerDraftPersistence();
});
afterAll(() => vi.unstubAllGlobals());

describe("fresh native image admission", () => {
  it.each([
    [false, "send"],
    [false, "steer"],
    [false, "queue"],
    [true, "send"],
    [true, "steer"],
    [true, "queue"],
  ] as const)(
    "preserves unread images for project specialist=%s action=%s until recovery",
    async (projectAgent, action) => {
      const ids = seed(projectAgent);
      if (action === "steer") useAgentConversationDraftStore.getState().setMode(ids.key, "steer");
      state.flags.failImages = true;
      mount(projectAgent);
      state.flags.failImages = false;
      expect(renderer!.root.findByProps({ type: "submit" }).props.disabled).toBe(true);
      expect(button("Queue for idle").props.disabled).toBe(true);
      // Exercise handlers too, including the keyboard path which bypasses the disabled button.
      await submit();
      await act(async () => button("Queue for idle").props.onClick());
      await act(async () => {
        const editor = renderer!.root.findByType(AgentComposerEditor);
        const onKey = editor.props.onCommandKeyDown;
        onKey("Enter", {
          isComposing: false,
          keyCode: 13,
          shiftKey: false,
          metaKey: false,
          ctrlKey: false,
          preventDefault() {},
        });
      });
      expect(state.send).not.toHaveBeenCalled();
      expect(state.enqueue).not.toHaveBeenCalled();
      expect(useAgentConversationDraftStore.getState().byTarget[ids.key]?.attempts ?? []).toEqual(
        [],
      );
      expect(state.storage.getItem(ids.imageKey)).toBe(JSON.stringify([image]));
      act(() => button("Retry loading images").props.onClick());
      if (action === "queue") await act(async () => button("Queue for idle").props.onClick());
      else await submit();
      const command = action === "queue" ? state.enqueue : state.send;
      expect(command).toHaveBeenCalledTimes(1);
      const input = command.mock.calls[0]![0].input;
      expect(action === "queue" ? input.payload.images : input.images).toEqual([image]);
      if (action !== "queue")
        expect(input.handlingMode).toBe(action === "steer" ? "steer" : "queue");
    },
  );

  it("checks storage again when a previously ready draft is submitted", async () => {
    seed();
    mount();
    state.flags.failImages = true;
    await submit();
    expect(state.send).not.toHaveBeenCalled();
    state.flags.failImages = false;
    act(() => button("Retry loading images").props.onClick());
    await submit();
    expect(state.send.mock.calls[0]![0].input.images).toEqual([image]);
  });

  it("can reconcile and explicitly retry an immutable request while fresh images remain unread", async () => {
    const ids = seed();
    const requests = useAgentConversationDraftStore.getState();
    requests.beginSend(ids.key, () => "original-request", {
      text: "Earlier image",
      mode: "queue",
      images: [image],
      agentRef: agent.agentRef,
    });
    requests.finishSend(ids.key, "original-request");
    state.reconcile.mockResolvedValueOnce({ _tag: "Success", value: undefined });
    state.flags.failImages = true;
    mount();
    await act(async () => button("Check delivery").props.onClick());
    expect(state.send).not.toHaveBeenCalled();
    expect(state.reconcile.mock.calls[0]![0].input).toMatchObject({
      requestId: "original-request",
      images: [image],
      text: "Earlier image",
    });
    expect(button("Retry loading images")).toBeDefined();
    await act(async () => button("Retry same message").props.onClick());
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0]![0].input).toMatchObject({
      requestId: "original-request",
      images: [image],
      text: "Earlier image",
    });
    expect(useAgentConversationDraftStore.getState().byTarget[ids.key]?.attempts).toHaveLength(1);
  });

  it("imports the durable queue payload independently of unread current images", async () => {
    const ids = seed();
    useAgentUnsentQueueStore.getState().add(ids.key, {
      id: "saved-row",
      text: "Earlier queued image",
      images: [image],
      sendWhenIdle: true,
    });
    state.flags.failImages = true;
    await act(async () => mount());
    expect(state.enqueue).toHaveBeenCalledTimes(1);
    expect(state.enqueue.mock.calls[0]![0].input).toMatchObject({
      requestId: "import-saved-row",
      payload: { images: [image], text: "Earlier queued image" },
    });
    expect(state.send).not.toHaveBeenCalled();
    expect(button("Retry loading images")).toBeDefined();
  });
});

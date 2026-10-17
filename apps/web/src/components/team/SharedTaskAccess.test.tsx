import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type SharedCheckout,
  type SharedCheckoutPatch,
  type SharedLocalConnection,
  type SharedLocalDelegation,
  type SharedWorkspaceSnapshot,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentPresentation } from "../../state/environments";

const state = vi.hoisted(() => ({
  local: null as EnvironmentPresentation | null,
  tasks: [] as unknown[],
  connections: [] as SharedLocalConnection[],
  grants: [] as SharedLocalDelegation[],
  queryError: null as string | null,
  dirty: false,
  restoreBlock: null as string | null,
  prepared: vi.fn(),
  putContext: vi.fn(),
  createConnection: vi.fn(),
  enable: vi.fn(),
  observeRevision: vi.fn(),
  observeSession: vi.fn(),
  previewPatch: vi.fn(),
  putSnapshot: vi.fn(),
  revoke: vi.fn(),
  disconnect: vi.fn(),
  cancelSetup: vi.fn(),
  refresh: vi.fn(),
  minute: "2026-10-17T12:00",
}));
vi.mock("../../hooks/useNowMinute", () => ({ useNowMinute: () => state.minute }));
vi.mock("./useRestoreReview", () => ({
  useRestoreReviewWorkBlock: () => state.restoreBlock,
  readRestoreReviewWorkBlock: () => state.restoreBlock,
}));
vi.mock("../../state/environments", () => ({ useEnvironment: () => state.local }));
vi.mock("../../state/entities", () => ({ useThreadShellsForProjectRefs: () => state.tasks }));
vi.mock("../../state/session", () => ({
  environmentSession: { observePreparedConnection: "prepared" },
}));
vi.mock("../../state/sharedWorkspace", () => ({
  sharedWorkspaceEnvironment: {
    localConnections: (input: unknown) => ({ kind: "connections", input }),
    localDelegations: (input: unknown) => ({ kind: "grants", input }),
    delegationSession: (input: unknown) => ({ kind: "session", input }),
    observeCheckoutRevision: "observeRevision",
    observeDelegationSession: "observeSession",
    previewCheckoutPatch: "previewPatch",
    putSnapshot: "putSnapshot",
    putWorkContext: "putContext",
    createLocalConnection: "createConnection",
    enableLocalDelegation: "enable",
    revokeLocalDelegation: "revoke",
    disconnectLocalConnection: "disconnect",
    cancelLocalConnectionSetup: "cancelSetup",
  },
}));
vi.mock("../../state/query", () => ({
  formatEnvironmentQueryError: (cause: string) => cause,
  useEnvironmentQuery: (query: { kind: string } | null) => ({
    data:
      query?.kind === "connections"
        ? state.connections
        : query?.kind === "grants"
          ? state.grants
          : query?.kind === "session"
            ? { canContribute: true }
            : null,
    error: state.queryError,
    isPending: false,
    refresh: state.refresh,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: keyof typeof state) =>
    command === "prepared"
      ? async (input: unknown) => ({ _tag: "Success", value: await state.prepared(input) })
      : state[command],
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "span",
  TooltipTrigger: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipPopup: "span",
}));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/checkbox", () => ({ Checkbox: "input" }));
vi.mock("../ui/label", () => ({ Label: "label" }));
vi.mock("../ui/select", () => ({
  Select: "select",
  SelectTrigger: "div",
  SelectValue: "span",
  SelectPopup: "div",
  SelectItem: "option",
}));
vi.mock("../ui/collapsible", () => ({
  Collapsible: "section",
  CollapsibleTrigger: "button",
  CollapsiblePanel: "div",
}));
import { SharedTaskAccess } from "./SharedTaskAccess";

const now = "2026-10-17T12:00:00.000Z";
const patch: SharedCheckoutPatch = {
  projectId: ProjectId.make("catalog"),
  threadId: ThreadId.make("task"),
  branch: "feature/catalog",
  commit: "a".repeat(40),
  observedAt: now,
  status: "ready",
  scope: "tracked_changes",
  patch: "diff --git a/src/catalog.ts b/src/catalog.ts\n+updated\n",
  sha256: "b".repeat(64),
  bytes: 58,
  files: [{ path: "src/catalog.ts", change: "modified" }],
  filesTruncated: false,
  excluded: [],
  excludedTruncated: false,
  maxBytes: 1_048_576,
  maxFiles: 256,
};
const host = {
  environmentId: EnvironmentId.make("host"),
  label: "Workspace host",
  connection: { phase: "connected" },
  entry: {
    target: { _tag: "BearerConnectionTarget", connectionId: "paired-host", sharedWorkspace: true },
  },
} as unknown as EnvironmentPresentation;
const local = {
  environmentId: EnvironmentId.make("local"),
  label: "My laptop",
  displayUrl: "http://localhost:3000",
  connection: { phase: "connected" },
  entry: { target: { _tag: "PrimaryConnectionTarget" } },
} as unknown as EnvironmentPresentation;
const checkout: SharedCheckout = {
  checkoutId: "checkout",
  participantId: "alice",
  sharedProjectId: "shared-catalog",
  localEnvironmentId: EnvironmentId.make("local"),
  localProjectId: ProjectId.make("catalog"),
  repository: "github.com/example/catalog",
  createdAt: now,
};
const snapshot: SharedWorkspaceSnapshot = {
  workspace: {
    workspaceId: "workspace",
    name: "Product",
    limits: { maxSpecialists: 100, maxSnapshotBytes: 1000 },
    createdAt: now,
  },
  participant: { participantId: "alice", kind: "person", displayName: "Alice", createdAt: now },
  projects: [],
  specialists: [],
  checkouts: [checkout],
};
const account: SharedLocalConnection = {
  connectionId: "local-account",
  requestId: "connect-request",
  label: "Product",
  origin: "https://shared.example",
  environmentId: host.environmentId,
  workspaceId: "workspace",
  participantId: "alice",
  createdAt: now,
  revokedAt: null,
};
let rendered: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  state.local = local;
  state.tasks = [
    { id: ThreadId.make("task"), title: "Catalog transactions", session: {}, archivedAt: null },
  ];
  state.connections = [];
  state.grants = [];
  state.queryError = null;
  state.dirty = false;
  state.restoreBlock = null;
  state.minute = "2026-10-17T12:00";
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(now));
  state.prepared.mockReset().mockReturnValue({
    environmentId: host.environmentId,
    httpBaseUrl: "https://shared.example",
    target: host.entry.target,
    httpAuthorization: { _tag: "Bearer", token: "private-paired-token" },
  });
  state.observeSession.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      environmentId: host.environmentId,
      workspaceId: "workspace",
      participantId: "alice",
      canContribute: true,
      expiresAt: "2099-10-17T12:00:00.000Z",
    },
  });
  state.observeRevision.mockReset().mockImplementation(async () => ({
    _tag: "Success",
    value: {
      projectId: checkout.localProjectId,
      branch: "feature/catalog",
      commit: "a".repeat(40),
      dirty: state.dirty,
      observedAt: now,
    },
  }));
  state.previewPatch.mockReset().mockResolvedValue({ _tag: "Success", value: patch });
  state.putSnapshot.mockReset().mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: {
      snapshotId: "snapshot-reviewed",
      sharedProjectId: checkout.sharedProjectId,
      checkoutId: input.checkoutId,
      revision: input.revision,
      sha256: patch.sha256,
      bytes: patch.bytes,
      createdAt: now,
    },
  }));
  state.putContext.mockReset().mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: {
      ...input,
      contextVersion: "version-one",
      participantId: "alice",
      sharedProjectId: "shared-catalog",
      updatedAt: now,
    },
  }));
  state.createConnection.mockReset().mockImplementation(async ({ input }) => {
    const created = { ...account, requestId: input.requestId };
    state.connections = [created];
    return { _tag: "Success", value: created };
  });
  state.enable.mockReset().mockImplementation(async ({ input }) => {
    const context = state.putContext.mock.calls.find(
      ([call]) => call.input.contextId === input.contextId,
    )![0].input;
    const row: SharedLocalDelegation = {
      localId: "local-grant",
      connectionId: input.connectionId,
      threadId: input.threadId,
      revokedAt: null,
      grant: {
        delegationId: "grant",
        ownerParticipantId: "alice",
        participant: {
          participantId: "task-actor",
          kind: "local_agent",
          displayName: input.label,
          createdAt: now,
        },
        binding: {
          environmentId: local.environmentId,
          projectId: checkout.localProjectId,
          threadId: input.threadId,
          instanceId: ProviderInstanceId.make("meerkat"),
          mobId: "mob",
          sessionId: "session",
        },
        context: {
          ...context,
          contextVersion: "version-one",
          participantId: "alice",
          sharedProjectId: "shared-catalog",
          updatedAt: now,
        },
        actions: input.actions,
        expiresAt: input.expiresAt,
        createdAt: now,
        revokedAt: null,
      },
    };
    state.grants = [...state.grants.filter((previous) => previous.localId !== row.localId), row];
    return { _tag: "Success", value: row };
  });
  state.revoke.mockReset();
  state.disconnect.mockReset();
  state.cancelSetup.mockReset().mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: { canceled: true, requestId: input.requestId, cleanup: null },
  }));
  state.refresh.mockReset();
});
afterEach(async () => {
  await act(async () => rendered?.unmount());
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const tree = () => JSON.stringify(rendered!.toJSON());
async function render(connected = true, initialThreadId?: ThreadId) {
  await act(async () => {
    rendered = create(
      <SharedTaskAccess
        host={host}
        checkout={checkout}
        snapshot={snapshot}
        connected={connected}
        canContribute
        initialThreadId={initialThreadId}
      />,
    );
  });
  await act(async () => rendered!.root.findByType("section").props.onOpenChange(true));
}
async function selectAndConsent() {
  const selector = rendered!.root.findAllByType("select")[0];
  if (selector) await act(async () => selector.props.onValueChange("task"));
  const consent = rendered!.root
    .findAllByType("input")
    .find((input) => String(input.props.id).endsWith("-consent"))!;
  await act(async () => consent.props.onCheckedChange(true));
}
async function submit() {
  await act(async () => rendered!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
const submitButton = () =>
  rendered!.root.findAllByType("button").find((button) => button.props.type === "submit")!;

describe("task collaboration opt-in", () => {
  it("shows the originating task title without a redundant task selector", async () => {
    await render(true, ThreadId.make("task"));
    expect(rendered!.root.findAllByType("select")).toHaveLength(0);
    expect(
      rendered!.root
        .findAllByType("p")
        .some((item) => item.children.includes("Catalog transactions")),
    ).toBe(true);
    expect(state.prepared).not.toHaveBeenCalled();
  });
  it("shows the selected task title in the project-level selector before opening its menu", async () => {
    await render();
    await selectAndConsent();
    const value = rendered!.root
      .findAllByType("span")
      .find((item) => item.props.placeholder === "Choose a started task")!;
    expect(value.children).toEqual(["Catalog transactions"]);
  });
  it("does not read or forward the paired token before explicit consent", async () => {
    await render();
    expect(tree()).toContain("Store the paired account credential on");
    expect(tree()).toContain("My laptop");
    expect(submitButton().props.disabled).toBe(true);
    await submit();
    expect(state.prepared).not.toHaveBeenCalled();
    expect(state.createConnection).not.toHaveBeenCalled();
  });
  it("observes the selected task's actual worktree and sends credentials only to its local backend", async () => {
    await render();
    await selectAndConsent();
    await submit();
    await settle();
    expect(state.observeRevision).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { projectId: "catalog", threadId: "task" },
    });
    expect(state.createConnection.mock.calls[0]![0]).toMatchObject({
      environmentId: "local",
      input: {
        credential: "private-paired-token",
        consent: true,
        expected: { environmentId: "host", workspaceId: "workspace", participantId: "alice" },
      },
    });
    expect(state.putContext.mock.calls[0]![0]).toMatchObject({
      environmentId: "host",
      input: {
        source: { kind: "thread", threadId: "task" },
        revision: { branch: "feature/catalog", commit: "a".repeat(40) },
      },
    });
    expect(state.enable.mock.calls[0]![0]).toMatchObject({
      environmentId: "local",
      input: { contextVersion: "version-one", threadId: "task" },
    });
    expect(state.enable.mock.calls[0]![0].input.actions).not.toContain("activity.publish");
    expect(state.enable.mock.calls[0]![0].input.actions).not.toContain("knowledge.record");
    expect(state.enable.mock.calls[0]![0].input.actions).not.toContain("knowledge.supersede");
    expect(tree()).not.toContain("private-paired-token");
    expect(tree()).toContain("Access enabled");
  });
  it.each(["unprepared", "other-environment", "not-shared", "dpop"])(
    "does not forward a %s connection after explicit consent",
    async (kind) => {
      state.prepared.mockResolvedValue(
        kind === "unprepared"
          ? null
          : {
              environmentId: kind === "other-environment" ? "another-host" : host.environmentId,
              httpBaseUrl: "https://shared.example",
              target: { ...host.entry.target, sharedWorkspace: kind !== "not-shared" },
              httpAuthorization:
                kind === "dpop"
                  ? { _tag: "Dpop", accessToken: "private-proof-bound-token" }
                  : { _tag: "Bearer", token: "private-paired-token" },
            },
      );
      await render();
      expect(state.prepared).not.toHaveBeenCalled();
      await selectAndConsent();
      await submit();
      expect(tree()).toContain("Reconnect this shared account");
      expect(state.putContext).not.toHaveBeenCalled();
      expect(state.createConnection).not.toHaveBeenCalled();
      expect(state.enable).not.toHaveBeenCalled();
    },
  );
  it("rechecks the current paired account immediately before forwarding its credential", async () => {
    state.prepared
      .mockResolvedValueOnce({
        environmentId: host.environmentId,
        httpBaseUrl: "https://shared.example",
        target: host.entry.target,
        httpAuthorization: { _tag: "Bearer", token: "private-paired-token" },
      })
      .mockResolvedValue({
        environmentId: host.environmentId,
        httpBaseUrl: "https://shared.example",
        target: { ...host.entry.target, connectionId: "replacement-account" },
        httpAuthorization: { _tag: "Bearer", token: "replacement-private-token" },
      });
    await render();
    await selectAndConsent();
    await submit();
    expect(state.prepared).toHaveBeenCalledTimes(2);
    expect(tree()).toContain("paired shared account changed");
    expect(tree()).not.toContain("replacement-private-token");
    expect(state.createConnection).not.toHaveBeenCalled();
    expect(state.enable).not.toHaveBeenCalled();
  });
  it("blocks dirty task revisions without uploading context or credentials", async () => {
    state.dirty = true;
    await render();
    await selectAndConsent();
    await submit();
    await settle();
    expect(tree()).toContain("Preview and share a snapshot");
    expect(state.putContext).not.toHaveBeenCalled();
    expect(state.createConnection).not.toHaveBeenCalled();
  });
  it("shares a reviewed task snapshot only on explicit action and retains it through a lost grant response", async () => {
    state.dirty = true;
    state.enable.mockResolvedValueOnce({ _tag: "Failure", cause: "response lost" });
    await render(true, ThreadId.make("task"));
    expect(state.previewPatch).not.toHaveBeenCalled();
    const click = async (label: string) =>
      act(async () => {
        await rendered!.root
          .findAllByType("button")
          .find((item) => item.children.includes(label))!
          .props.onClick();
      });
    await click("Preview snapshot");
    expect(state.previewPatch).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { projectId: "catalog", threadId: "task" },
    });
    expect(tree()).toContain("src/catalog.ts");
    expect(tree()).toContain("58");
    expect(state.putSnapshot).not.toHaveBeenCalled();
    expect(state.putContext).not.toHaveBeenCalled();
    expect(state.prepared).not.toHaveBeenCalled();
    await click("Share snapshot");
    expect(state.putSnapshot).toHaveBeenCalledExactlyOnceWith({
      environmentId: "host",
      input: {
        checkoutId: "checkout",
        revision: { branch: patch.branch, commit: patch.commit, applicability: "branch" },
        patch: patch.patch,
      },
    });
    expect(state.prepared).not.toHaveBeenCalled();
    await selectAndConsent();
    await submit();
    expect(state.putContext.mock.calls[0]![0].input.revision.snapshotId).toBe("snapshot-reviewed");
    const first = state.enable.mock.calls[0]![0];
    state.previewPatch.mockResolvedValue({
      _tag: "Success",
      value: { ...patch, sha256: "c".repeat(64), patch: "different" },
    });
    await submit();
    expect(state.enable.mock.calls[1]![0]).toEqual(first);
    expect(state.previewPatch).toHaveBeenCalledTimes(3);
    expect(state.putSnapshot).toHaveBeenCalledTimes(1);
    expect(state.putContext).toHaveBeenCalledTimes(1);
  });
  it("requires a new preview when tracked changes change before explicit sharing", async () => {
    await render(true, ThreadId.make("task"));
    const click = async (label: string) =>
      act(async () => {
        await rendered!.root
          .findAllByType("button")
          .find((item) => item.children.includes(label))!
          .props.onClick();
      });
    await click("Preview snapshot");
    state.previewPatch.mockResolvedValue({
      _tag: "Success",
      value: { ...patch, sha256: "c".repeat(64), patch: "different" },
    });
    await click("Share snapshot");
    expect(tree()).toContain("checkout changed since this preview");
    expect(state.putSnapshot).not.toHaveBeenCalled();
    expect(state.putContext).not.toHaveBeenCalled();
  });
  it("blocks new grant binding if the uploaded snapshot no longer matches the task worktree", async () => {
    state.dirty = true;
    await render(true, ThreadId.make("task"));
    const click = async (label: string) =>
      act(async () => {
        await rendered!.root
          .findAllByType("button")
          .find((item) => item.children.includes(label))!
          .props.onClick();
      });
    await click("Preview snapshot");
    await click("Share snapshot");
    state.previewPatch.mockResolvedValue({
      _tag: "Success",
      value: { ...patch, sha256: "c".repeat(64), patch: "different" },
    });
    await selectAndConsent();
    await submit();
    expect(tree()).toContain("checkout changed since this preview");
    expect(state.putContext).not.toHaveBeenCalled();
    expect(state.enable).not.toHaveBeenCalled();
  });
  it("requires clearing an earlier snapshot preview after the task changes have been committed", async () => {
    state.dirty = true;
    await render(true, ThreadId.make("task"));
    const click = async (label: string) =>
      act(async () => {
        await rendered!.root
          .findAllByType("button")
          .find((item) => item.children.includes(label))!
          .props.onClick();
      });
    await click("Preview snapshot");
    await click("Share snapshot");
    state.dirty = false;
    await selectAndConsent();
    await submit();
    expect(tree()).toContain("checkout is now clean");
    expect(state.putContext).not.toHaveBeenCalled();
    state.previewPatch.mockResolvedValue({
      _tag: "Success",
      value: { ...patch, status: "clean", patch: null, sha256: null, bytes: 0, files: [] },
    });
    await click("View shared snapshot");
    await click("Refresh preview");
    await submit();
    expect(state.putContext.mock.calls[0]![0].input.revision).not.toHaveProperty("snapshotId");
  });
  it("keeps a lost response retry immutable and hides credential-bearing error details", async () => {
    state.createConnection.mockResolvedValueOnce({
      _tag: "Failure",
      cause: "private-paired-token",
    });
    await render();
    await selectAndConsent();
    await submit();
    await settle();
    expect(tree()).toContain("Retry saved request");
    expect(tree()).not.toContain("private-paired-token");
    expect(rendered!.root.findByType("select").props.disabled).toBe(true);
    const first = state.createConnection.mock.calls[0]![0].input;
    await submit();
    await settle();
    expect(state.createConnection.mock.calls[1]![0].input.requestId).toBe(first.requestId);
    expect(state.putContext).toHaveBeenCalledTimes(1);
  });
  it("does not silently use a different paired account on retry", async () => {
    state.createConnection.mockResolvedValueOnce({ _tag: "Failure", cause: "lost" });
    await render();
    await selectAndConsent();
    await submit();
    await settle();
    state.prepared.mockReturnValue({
      environmentId: host.environmentId,
      httpBaseUrl: "https://shared.example",
      target: { ...host.entry.target, connectionId: "other-pair" },
      httpAuthorization: { _tag: "Bearer", token: "another-token" },
    });
    await submit();
    await settle();
    expect(tree()).toContain("paired shared account changed");
    expect(state.createConnection).toHaveBeenCalledTimes(1);
  });
  it("renews an expired pre-admission failure without deleting the stored account or grant history", async () => {
    state.enable.mockImplementationOnce(async ({ input }) => {
      state.grants = [
        {
          localId: "old-pending",
          connectionId: input.connectionId,
          threadId: input.threadId,
          grant: null,
          revokedAt: null,
        },
      ];
      return { _tag: "Failure", cause: "Shared host unavailable before registration" };
    });
    await render();
    await selectAndConsent();
    await submit();
    await settle();
    const original = state.enable.mock.calls[0]![0].input;
    expect(tree()).not.toContain("Start a new request");
    expect(rendered!.root.findByType("select").props.disabled).toBe(true);
    state.minute = "2026-10-17T14:00";
    vi.mocked(Date.now).mockReturnValue(Date.parse(`${state.minute}:00.000Z`));
    await act(async () =>
      rendered!.update(
        <SharedTaskAccess
          host={host}
          checkout={checkout}
          snapshot={snapshot}
          connected
          canContribute
        />,
      ),
    );
    const restart = rendered!.root
      .findAllByType("button")
      .find((item) => item.children.includes("Start a new request"))!;
    await act(async () => restart.props.onClick());
    expect(rendered!.root.findByType("select").props.disabled).toBe(false);
    expect(submitButton().props.disabled).toBe(true);
    expect(tree()).toContain("does not confirm remote revocation");
    expect(state.disconnect).not.toHaveBeenCalled();
    expect(state.revoke).not.toHaveBeenCalled();
    await selectAndConsent();
    expect(submitButton().props.disabled).toBe(false);
    await submit();
    await settle();
    const renewed = state.enable.mock.calls[1]![0].input;
    expect(renewed.connectionId).toBe(original.connectionId);
    expect(renewed.requestId).not.toBe(original.requestId);
    expect(renewed.contextId).not.toBe(original.contextId);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(original.expiresAt));
    expect(state.createConnection).toHaveBeenCalledTimes(1);
    expect(state.grants.find((row) => row.localId === "old-pending")).toMatchObject({
      grant: null,
      revokedAt: null,
    });
    expect(tree()).toContain("Access enabled");
  });
  it("keeps editable task scope while the access section is collapsed", async () => {
    await render();
    await selectAndConsent();
    await act(async () =>
      rendered!.root.findByType("textarea").props.onChange({
        target: { value: "Review only the catalog schema migration" },
      }),
    );
    const publication = rendered!.root
      .findAllByType("input")
      .find((input) => String(input.props.id).endsWith("-action-3"))!;
    await act(async () => publication.props.onCheckedChange(true));
    await act(async () => rendered!.root.findByType("section").props.onOpenChange(false));
    await act(async () => rendered!.root.findByType("section").props.onOpenChange(true));
    expect(rendered!.root.findByType("select").props.value).toBe("task");
    expect(rendered!.root.findByType("textarea").props.value).toBe(
      "Review only the catalog schema migration",
    );
    expect(
      rendered!.root
        .findAllByType("input")
        .find((input) => String(input.props.id).endsWith("-action-3"))!.props.checked,
    ).toBe(true);
    expect(state.prepared).not.toHaveBeenCalled();
    expect(state.enable).not.toHaveBeenCalled();
  });
  it("shows only the current task's grants and excludes grants from another project or environment", async () => {
    await render(true, ThreadId.make("task"));
    await selectAndConsent();
    await submit();
    await settle();
    const own = state.grants[0]!;
    const grant = own.grant!;
    const another = rendered!.root
      .findAllByType("button")
      .find((item) => item.children.includes("Set up new access"))!;
    await act(async () => another.props.onClick());
    expect(rendered!.root.findAllByType("select")).toHaveLength(0);
    expect(
      rendered!.root
        .findAllByType("p")
        .some((item) => item.children.includes("Catalog transactions")),
    ).toBe(true);
    expect(rendered!.root.findByType("textarea").props.value).toBe("Catalog transactions");
    state.grants.push(
      {
        ...own,
        localId: "other-task",
        threadId: ThreadId.make("other-task"),
        grant: { ...grant, binding: { ...grant.binding, threadId: ThreadId.make("other-task") } },
      },
      {
        ...own,
        localId: "other-project",
        grant: {
          ...grant,
          binding: { ...grant.binding, projectId: ProjectId.make("other-project") },
        },
      },
      {
        ...own,
        localId: "other-environment",
        grant: {
          ...grant,
          binding: { ...grant.binding, environmentId: EnvironmentId.make("other-environment") },
        },
      },
      { ...own, localId: "unknown-pending", threadId: ThreadId.make("unknown-task"), grant: null },
    );
    await act(async () =>
      rendered!.update(
        <SharedTaskAccess
          host={host}
          checkout={checkout}
          snapshot={snapshot}
          connected
          canContribute
          initialThreadId={ThreadId.make("task")}
        />,
      ),
    );
    const buttons = rendered!.root
      .findAllByType("button")
      .filter((item) => item.children.includes("Revoke access"));
    expect(buttons).toHaveLength(1);
    state.revoke.mockResolvedValue({ _tag: "Failure", cause: "Not applied" });
    await act(async () => buttons[0]!.props.onClick());
    expect(state.revoke).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { localId: own.localId },
    });
    expect(tree()).toContain("including those in other projects");
  });
  it("keeps offline and unsupported local backends visibly blocked", async () => {
    state.queryError = "This server does not support local task access.";
    await render(false);
    await selectAndConsent();
    await submit();
    await settle();
    expect(tree()).toContain("Reconnect the shared host");
    expect(tree()).toContain("does not support local task access");
    expect(state.prepared).not.toHaveBeenCalled();
    expect(submitButton().props.disabled).toBe(true);
  });
  it("reports uncertain revocation as blocked locally, not revoked remotely", async () => {
    await render();
    await selectAndConsent();
    await submit();
    await settle();
    state.revoke.mockImplementation(async () => {
      state.grants = state.grants.map((row) => ({ ...row, revokedAt: now }));
      return { _tag: "Failure", cause: "Host unreachable" };
    });
    const button = rendered!.root
      .findAllByType("button")
      .find((candidate) => candidate.children.includes("Revoke access"))!;
    await act(async () => button.props.onClick());
    await settle();
    expect(tree()).toContain("Blocked locally; remote confirmation pending");
    expect(tree()).toContain("Confirm revocation");
  });
  it("removes the local credential even when remote revocation is unconfirmed", async () => {
    await render();
    await selectAndConsent();
    await submit();
    await settle();
    state.disconnect.mockImplementation(async () => {
      const removed = { ...account, revokedAt: now, remoteRevocation: "unconfirmed" as const };
      state.connections = [removed];
      state.grants = state.grants.map((row) => ({ ...row, revokedAt: now }));
      return { _tag: "Success", value: { connection: removed, remoteRevocation: "unconfirmed" } };
    });
    const button = rendered!.root
      .findAllByType("button")
      .find((candidate) => candidate.children.includes("Remove stored account"))!;
    await act(async () => button.props.onClick());
    await settle();
    expect(tree()).toContain("Stored credential removed");
    expect(tree()).toContain("Remote revocation could not be confirmed");
    expect(tree()).not.toContain("Remote grants are revoked");
    expect(tree()).not.toContain("Retry saved request");
  });
  it("recovers exact creation and removal requests from retained metadata after both responses were lost", async () => {
    state.createConnection.mockImplementationOnce(async ({ input }) => {
      state.connections = [{ ...account, requestId: input.requestId }];
      return { _tag: "Failure", cause: "create reply lost" };
    });
    await render();
    await selectAndConsent();
    await submit();
    await settle();
    expect(tree()).toContain("Retry saved request");
    state.disconnect.mockImplementationOnce(async () => {
      state.connections = [
        { ...state.connections[0]!, revokedAt: now, remoteRevocation: "unconfirmed" },
      ];
      return { _tag: "Failure", cause: "removal reply lost" };
    });
    const button = rendered!.root
      .findAllByType("button")
      .find((candidate) => candidate.children.includes("Remove stored account"))!;
    await act(async () => button.props.onClick());
    await settle();
    await act(async () =>
      rendered!.update(
        <SharedTaskAccess
          host={host}
          checkout={checkout}
          snapshot={snapshot}
          connected
          canContribute
        />,
      ),
    );
    expect(tree()).toContain("Stored credential removed");
    expect(tree()).not.toContain("Retry saved request");
    await act(async () => rendered!.unmount());
    rendered = undefined;
    await render();
    expect(tree()).toContain("Remote revocation could not be confirmed");
    expect(tree()).not.toContain("Retry saved request");
  });
  it("rechecks restore admission immediately before forwarding account authority", async () => {
    await render();
    await selectAndConsent();
    state.restoreBlock = "Review the restored profile before starting work.";
    await submit();
    await settle();
    expect(tree()).toContain("Review the restored profile");
    expect(state.observeSession).not.toHaveBeenCalled();
    expect(state.prepared).not.toHaveBeenCalled();
    expect(state.createConnection).not.toHaveBeenCalled();
  });

  it("cancels an unlisted setup through its local backend while the shared host is offline", async () => {
    state.createConnection.mockResolvedValueOnce({ _tag: "Failure", cause: "verification failed" });
    await render();
    await selectAndConsent();
    await submit();
    await settle();
    const requestId = state.createConnection.mock.calls[0]![0].input.requestId;
    expect(state.connections).toEqual([]);
    state.prepared.mockClear();
    state.observeSession.mockClear();
    await act(async () =>
      rendered!.update(
        <SharedTaskAccess
          host={host}
          checkout={checkout}
          snapshot={snapshot}
          connected={false}
          canContribute
        />,
      ),
    );
    const cancel = rendered!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Cancel saved setup"))!;
    expect(cancel.props.disabled).toBe(false);
    await act(async () => cancel.props.onClick());
    await settle();
    expect(state.cancelSetup).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { requestId },
    });
    expect(state.prepared).not.toHaveBeenCalled();
    expect(state.observeSession).not.toHaveBeenCalled();
    expect(tree()).toContain("Setup canceled and its stored credential removed.");
    expect(tree()).not.toContain("Retry saved request");
  });

  it("keeps cancellation retryable after a failed deletion or lost response and a reload", async () => {
    state.createConnection.mockResolvedValueOnce({ _tag: "Failure", cause: "verification failed" });
    state.cancelSetup.mockResolvedValueOnce({ _tag: "Failure", cause: "private-paired-token" });
    await render();
    await selectAndConsent();
    await submit();
    await settle();
    const requestId = state.createConnection.mock.calls[0]![0].input.requestId;
    const cancel = rendered!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Cancel saved setup"))!;
    await act(async () => cancel.props.onClick());
    await settle();
    expect(tree()).toContain("could not be confirmed");
    expect(tree()).not.toContain("private-paired-token");
    expect(tree()).not.toContain("Retry saved request");
    await act(async () => rendered!.unmount());
    rendered = undefined;
    state.prepared.mockClear();
    await render(false);
    expect(tree()).toContain("Setup cancellation is pending");
    const retry = rendered!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Retry setup cancellation"))!;
    await act(async () => retry.props.onClick());
    await settle();
    expect(state.cancelSetup.mock.calls.map(([input]) => input)).toEqual([
      { environmentId: "local", input: { requestId } },
      { environmentId: "local", input: { requestId } },
    ]);
    expect(state.prepared).not.toHaveBeenCalled();
    expect(tree()).not.toContain("Retry setup cancellation");
  });

  it("reports full cleanup honestly when the original creation reply was lost", async () => {
    state.createConnection.mockImplementationOnce(async ({ input }) => {
      state.connections = [{ ...account, requestId: input.requestId }];
      return { _tag: "Failure", cause: "create reply lost" };
    });
    state.cancelSetup.mockImplementation(async ({ input }) => {
      const connection = {
        ...account,
        requestId: input.requestId,
        revokedAt: now,
        remoteRevocation: "unconfirmed" as const,
      };
      state.connections = [connection];
      return {
        _tag: "Success",
        value: {
          canceled: true,
          requestId: input.requestId,
          cleanup: { connection, remoteRevocation: "unconfirmed" },
        },
      };
    });
    await render();
    await selectAndConsent();
    await submit();
    await settle();
    const cancel = rendered!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Cancel saved setup"))!;
    await act(async () => cancel.props.onClick());
    await settle();
    expect(tree()).toContain("Remote revocation could not be confirmed");
    expect(tree()).toContain("Stored credential removed");
    expect(tree()).not.toContain("Remote grants are revoked");
    expect(tree()).not.toContain("Retry saved request");
  });
});
